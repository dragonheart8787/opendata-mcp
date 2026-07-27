import { describe, expect, it } from "vitest";
import { buildPccUrl, pccAdapter } from "../../src/adapters/pcc.js";
import { ToolError } from "../../src/infra/errors.js";
import type { DatasetEntry } from "../../src/registry/index.js";
import { jsonFetch, rejectingFetch, textFetch } from "../helpers.js";

function makeEntry(overrides: Partial<DatasetEntry<{ title: string }, unknown, unknown>> = {}): DatasetEntry<
  { title: string },
  unknown,
  unknown
> {
  return {
    id: "pcc:test",
    source: "pcc",
    path: "searchbytitle",
    title: "test",
    keywords: [],
    paramsSchema: {},
    buildQueryParams: params => ({ query: params.title }),
    transform: raw => raw,
    cacheTtlSeconds: 0,
    updateFrequency: "test",
    docUrl: "",
    ...overrides
  };
}

describe("pccAdapter", () => {
  it("is registered as a community mirror, and its displayName names both the mirror and the original publisher", () => {
    expect(pccAdapter.id).toBe("pcc");
    // The displayName lands in the response envelope's `source`. Naming only
    // 政府電子採購網 there would imply the government served the response.
    expect(pccAdapter.displayName).toContain("g0v");
    expect(pccAdapter.displayName).toContain("政府電子採購網");
  });

  it("builds the upstream URL from the entry's path and query params", () => {
    const url = buildPccUrl(makeEntry(), { title: "開放政府" });
    expect(url.origin + url.pathname).toBe("https://pcc.g0v.ronny.tw/api/searchbytitle");
    expect(url.searchParams.get("query")).toBe("開放政府");
  });

  it("omits query params whose value is undefined rather than sending the literal string 'undefined'", () => {
    const entry = makeEntry({ buildQueryParams: () => ({ query: "x", page: undefined }) });
    const url = buildPccUrl(entry, { title: "x" });
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("sends no API key — this source has no auth at all, so there is no AUTH_MISSING path", async () => {
    let requestedUrl = "";
    const capturingFetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ records: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await pccAdapter.fetchDataset(makeEntry(), { title: "x" }, {}, capturingFetch);

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("api_key")).toBeNull();
    expect(url.searchParams.get("Authorization")).toBeNull();
  });

  it("returns the parsed JSON object on success", async () => {
    const fetchImpl = jsonFetch({ total_records: 2, records: [{ job_number: "a" }] });
    const raw = await pccAdapter.fetchDataset(makeEntry(), { title: "x" }, {}, fetchImpl);
    expect(raw).toEqual({ total_records: 2, records: [{ job_number: "a" }] });
  });

  it("throws UPSTREAM_ERROR naming the mirror (not the government) on a network failure", async () => {
    const fetchImpl = rejectingFetch(new Error("boom"));
    try {
      await pccAdapter.fetchDataset(makeEntry(), { title: "x" }, {}, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("UPSTREAM_ERROR");
      expect((error as ToolError).message).toContain("pcc.g0v.ronny.tw");
      // Every failure path still points the caller at the authoritative source.
      expect((error as ToolError).message).toContain("web.pcc.gov.tw");
    }
  });

  it("throws UPSTREAM_ERROR on a non-2xx response", async () => {
    const fetchImpl = jsonFetch({ message: "nope" }, { status: 503 });
    try {
      await pccAdapter.fetchDataset(makeEntry(), { title: "x" }, {}, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("UPSTREAM_ERROR");
      expect((error as ToolError).message).toContain("503");
    }
  });

  it("throws UPSTREAM_ERROR when the body isn't valid JSON", async () => {
    const fetchImpl = textFetch("<html>maintenance</html>");
    try {
      await pccAdapter.fetchDataset(makeEntry(), { title: "x" }, {}, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("UPSTREAM_ERROR");
      expect((error as ToolError).message).toMatch(/無法解析/);
    }
  });

  it("throws SCHEMA_MISMATCH when the payload parses but isn't an object (fail-loud)", async () => {
    const fetchImpl = jsonFetch("just a string");
    try {
      await pccAdapter.fetchDataset(makeEntry(), { title: "x" }, {}, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("SCHEMA_MISMATCH");
    }
  });

  it("throws SCHEMA_MISMATCH on a null payload", async () => {
    const fetchImpl = jsonFetch(null);
    try {
      await pccAdapter.fetchDataset(makeEntry(), { title: "x" }, {}, fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("SCHEMA_MISMATCH");
    }
  });

  it("accepts an array payload — the adapter deliberately doesn't hard-code one endpoint's envelope shape", async () => {
    // /api/unit returns a bare id->name map, /api/searchbytitle returns
    // {records}, and their pagination fields are named differently. The
    // adapter validates only "is an object"; shape is the transform's job.
    const fetchImpl = jsonFetch([{ a: 1 }]);
    const raw = await pccAdapter.fetchDataset(makeEntry(), { title: "x" }, {}, fetchImpl);
    expect(raw).toEqual([{ a: 1 }]);
  });
});
