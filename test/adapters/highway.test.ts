import { describe, expect, it } from "vitest";
import { buildHighwayUrl, highwayAdapter } from "../../src/adapters/highway.js";
import { ToolError } from "../../src/infra/errors.js";
import type { DatasetEntry } from "../../src/registry/index.js";
import { rejectingFetch, textFetch } from "../helpers.js";

function makeEntry(overrides: Partial<DatasetEntry<Record<string, never>, unknown, unknown>> = {}): DatasetEntry<
  Record<string, never>,
  unknown,
  unknown
> {
  return {
    id: "highway:test",
    source: "highway",
    path: "history/motc20/LiveEvents.xml",
    title: "test",
    keywords: [],
    paramsSchema: {},
    buildQueryParams: () => ({}),
    transform: raw => raw,
    cacheTtlSeconds: 0,
    updateFrequency: "test",
    docUrl: "",
    ...overrides
  };
}

const SAMPLE_XML = `<LiveEventList>
<UpdateTime>2026-07-23T15:31:11+08:00</UpdateTime>
<UpdateInterval>60</UpdateInterval>
<AuthorityCode>NFB</AuthorityCode>
<LiveEvents>
  <LiveEvent>
    <EventID>E1</EventID>
    <EventTitle>施工事件</EventTitle>
  </LiveEvent>
</LiveEvents>
</LiveEventList>`;

describe("buildHighwayUrl", () => {
  it("builds the full URL from the base + entry.path, with no query string", () => {
    const url = buildHighwayUrl(makeEntry());
    expect(url.toString()).toBe("https://tisvcloud.freeway.gov.tw/history/motc20/LiveEvents.xml");
  });
});

describe("highwayAdapter", () => {
  it("has the expected id and official displayName", () => {
    expect(highwayAdapter.id).toBe("highway");
    expect(highwayAdapter.displayName).toBe("交通部高速公路局『交通資料庫』");
  });

  it("needs no auth — fetches and parses XML with no credentials in env", async () => {
    const raw = await highwayAdapter.fetchDataset(makeEntry(), {}, {}, textFetch(SAMPLE_XML));
    expect(raw).toEqual({
      LiveEventList: {
        UpdateTime: "2026-07-23T15:31:11+08:00",
        UpdateInterval: "60",
        AuthorityCode: "NFB",
        LiveEvents: { LiveEvent: [{ EventID: "E1", EventTitle: "施工事件" }] }
      }
    });
  });

  it("forces LiveEvent to an array even with exactly one event (not a bare object)", async () => {
    const raw = (await highwayAdapter.fetchDataset(makeEntry(), {}, {}, textFetch(SAMPLE_XML))) as {
      LiveEventList: { LiveEvents: { LiveEvent: unknown } };
    };
    expect(Array.isArray(raw.LiveEventList.LiveEvents.LiveEvent)).toBe(true);
  });

  it("keeps numeric-looking tag values as literal text, not auto-parsed numbers", async () => {
    const xmlWithCode = SAMPLE_XML.replace("<EventTitle>施工事件</EventTitle>", "<EventTitle>施工事件</EventTitle><EventType>2</EventType>");
    const raw = (await highwayAdapter.fetchDataset(makeEntry(), {}, {}, textFetch(xmlWithCode))) as {
      LiveEventList: { LiveEvents: { LiveEvent: Array<{ EventType?: unknown }> } };
    };
    expect(raw.LiveEventList.LiveEvents.LiveEvent[0].EventType).toBe("2");
    expect(typeof raw.LiveEventList.LiveEvents.LiveEvent[0].EventType).toBe("string");
  });

  it("throws UPSTREAM_TIMEOUT on a real AbortError", async () => {
    const timeoutError = new Error("timeout");
    timeoutError.name = "AbortError";
    try {
      await highwayAdapter.fetchDataset(makeEntry(), {}, {}, rejectingFetch(timeoutError));
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("UPSTREAM_TIMEOUT");
    }
  });

  it("throws UPSTREAM_ERROR on a network failure", async () => {
    try {
      await highwayAdapter.fetchDataset(makeEntry(), {}, {}, rejectingFetch(new Error("network down")));
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("UPSTREAM_ERROR");
      expect((error as ToolError).message).toMatch(/network down/);
    }
  });

  it("throws UPSTREAM_ERROR on a non-2xx response", async () => {
    try {
      await highwayAdapter.fetchDataset(makeEntry(), {}, {}, textFetch("not found", { status: 404 }));
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("UPSTREAM_ERROR");
      expect((error as ToolError).message).toMatch(/404/);
    }
  });

  it("throws SCHEMA_MISMATCH when the response has no <LiveEventList> root — fast-xml-parser never throws on its own (it's lenient by design: unclosed tags, garbage text, even an empty string all 'parse' without error), so this is the real fail-loud check, not a try/catch around .parse()", async () => {
    try {
      await highwayAdapter.fetchDataset(makeEntry(), {}, {}, textFetch("<html><body>maintenance</body></html>"));
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("SCHEMA_MISMATCH");
      expect((error as ToolError).message).toMatch(/LiveEventList/);
    }
  });

  it("throws SCHEMA_MISMATCH on genuinely unparseable/empty content too, for the same reason (missing root, not a parse exception)", async () => {
    try {
      await highwayAdapter.fetchDataset(makeEntry(), {}, {}, textFetch(""));
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("SCHEMA_MISMATCH");
    }
  });
});
