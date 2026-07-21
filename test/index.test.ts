import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const env = { CWA_API_KEY: undefined };

function mcpRequest(body: unknown): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify(body)
  });
}

describe("worker fetch routing", () => {
  it("responds to the health check on /", async () => {
    const res = await worker.fetch(new Request("https://example.com/"), env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Taiwan OpenData MCP Server");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await worker.fetch(new Request("https://example.com/nope"), env as never);
    expect(res.status).toBe(404);
  });

  it("returns 405 for non-POST requests to /mcp", async () => {
    const res = await worker.fetch(new Request("https://example.com/mcp", { method: "GET" }), env as never);
    expect(res.status).toBe(405);
  });

  it("completes an MCP initialize handshake and lists all five tools", async () => {
    const initRes = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" }
        }
      }),
      env as never
    );
    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(initBody.result?.serverInfo?.name).toBe("taiwan-opendata-mcp-server");

    const listRes = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      env as never
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { result?: { tools?: Array<{ name: string }> } };
    const toolNames = listBody.result?.tools?.map(t => t.name) ?? [];
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "tw_weather_forecast",
        "tw_recent_earthquakes",
        "tw_air_quality",
        "tw_search_datasets",
        "tw_query_dataset"
      ])
    );
  });

  it("tw_search_datasets finds a registered dataset by keyword, with no upstream call needed", async () => {
    const res = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "tw_search_datasets", arguments: { query: "地震" } }
      }),
      env as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: {
        isError?: boolean;
        structuredContent?: { ok?: boolean; data?: { results?: Array<{ datasetId?: string }> } };
      };
    };
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.structuredContent?.ok).toBe(true);
    expect(body.result?.structuredContent?.data?.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ datasetId: "cwa:E-A0015-001" })])
    );
  });

  it("tw_query_dataset returns a NOT_FOUND failure envelope for an unregistered datasetId, hinting at tw_search_datasets", async () => {
    const res = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "tw_query_dataset", arguments: { datasetId: "cwa:NOT-A-REAL-ID" } }
      }),
      env as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; structuredContent?: { ok?: boolean; error?: { code?: string; message?: string } } };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent?.ok).toBe(false);
    expect(body.result?.structuredContent?.error?.code).toBe("NOT_FOUND");
    expect(body.result?.structuredContent?.error?.message).toContain("tw_search_datasets");
  });

  it("tw_query_dataset returns the same success envelope shape as the curated tool for the same dataset", async () => {
    const fixture = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/earthquakes.json", import.meta.url)), "utf-8")
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    try {
      const res = await worker.fetch(
        mcpRequest({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "tw_query_dataset", arguments: { datasetId: "cwa:E-A0015-001", params: { limit: 1 } } }
        }),
        { CWA_API_KEY: "test-key" } as never
      );
      const body = (await res.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: {
            ok?: boolean;
            source?: string;
            dataset?: string;
            cached?: boolean;
            updateFrequency?: string;
            data?: { earthquakes?: unknown[] };
          };
        };
      };
      expect(body.result?.isError).toBeUndefined();
      expect(body.result?.structuredContent?.ok).toBe(true);
      expect(body.result?.structuredContent?.source).toBe("中央氣象署");
      expect(body.result?.structuredContent?.dataset).toBe("E-A0015-001");
      expect(body.result?.structuredContent?.data?.earthquakes).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns an actionable tool error (not a transport error) when CWA_API_KEY is missing", async () => {
    const res = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "tw_weather_forecast", arguments: { city: "臺北市" } }
      }),
      env as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("opendata.cwa.gov.tw/user/authkey");
  });

  it("returns an actionable tool error when MOENV_API_KEY is missing", async () => {
    const res = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "tw_air_quality", arguments: { county: "新北市" } }
      }),
      env as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("data.moenv.gov.tw");
  });

  it("returns a failure envelope with code/message/hint in structuredContent on error", async () => {
    const res = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "tw_weather_forecast", arguments: { city: "臺北市" } }
      }),
      env as never
    );
    const body = (await res.json()) as {
      result?: { structuredContent?: { ok?: boolean; error?: { code?: string; message?: string; hint?: string } } };
    };
    expect(body.result?.structuredContent?.ok).toBe(false);
    expect(body.result?.structuredContent?.error?.code).toBe("AUTH_MISSING");
    expect(body.result?.structuredContent?.error?.message).toContain("opendata.cwa.gov.tw/user/authkey");
    expect(body.result?.structuredContent?.error?.hint).toBeTruthy();
  });

  it("returns a success envelope (ok/source/dataset/cached/updateFrequency/data) on a real call", async () => {
    const fixture = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/weather-forecast.json", import.meta.url)), "utf-8")
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    try {
      const res = await worker.fetch(
        mcpRequest({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "tw_weather_forecast", arguments: { city: "臺北市" } }
        }),
        { CWA_API_KEY: "test-key" } as never
      );
      const body = (await res.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: {
            ok?: boolean;
            source?: string;
            dataset?: string;
            cached?: boolean;
            updateFrequency?: string;
            data?: { city?: string };
          };
        };
      };
      expect(body.result?.isError).toBeUndefined();
      expect(body.result?.structuredContent?.ok).toBe(true);
      expect(body.result?.structuredContent?.source).toBe("中央氣象署");
      expect(body.result?.structuredContent?.dataset).toBe("F-C0032-001");
      expect(body.result?.structuredContent?.cached).toBe(false);
      expect(body.result?.structuredContent?.updateFrequency).toBe("每日數次");
      expect(body.result?.structuredContent?.data?.city).toBe("臺北市");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
