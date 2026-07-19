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

  it("completes an MCP initialize handshake and lists both tools", async () => {
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
    expect(toolNames).toEqual(expect.arrayContaining(["tw_weather_forecast", "tw_recent_earthquakes"]));
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
});
