import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatMetroStatusText, handleMetroStatusTool, runMetroStatus } from "../../src/tools/metro.js";
import type { TdxMetroAlertRawResponse } from "../../src/registry/tdx.js";

const fixture: TdxMetroAlertRawResponse = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/metro-alert.json", import.meta.url)), "utf-8")
);

const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

function tokenThenDataFetch(response: unknown): typeof fetch {
  return (async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof fetch;
}

function fetchWithFailure(): typeof fetch {
  return (async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response("metro-alert endpoint down", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("runMetroStatus", () => {
  it("maps the real fixture onto the compact status shape, including TDX's self-reported update interval", async () => {
    const result = await runMetroStatus(
      { system: "台北" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(fixture)
    );

    expect(result.query.system).toBe("台北");
    expect(result.systemId).toBe("TRTC");
    expect(result.updateTime).toBe(fixture.UpdateTime);
    expect(result.updateIntervalSeconds).toBe(60);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].Title).toBe("正常營運");
  });

  it("resolves the systemId for each supported system", async () => {
    const kaohsiung = await runMetroStatus(
      { system: "高雄" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch({ ...fixture, AuthorityCode: "KRTC" })
    );
    expect(kaohsiung.systemId).toBe("KRTC");
  });

  it("propagates the missing-credentials error", async () => {
    await expect(
      runMetroStatus({ system: "台北" }, { TDX_CLIENT_ID: undefined, TDX_CLIENT_SECRET: undefined })
    ).rejects.toThrow(/tdx\.transportdata\.tw/);
  });

  it("propagates a real upstream failure", async () => {
    await expect(
      runMetroStatus({ system: "台北" }, { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" }, fetchWithFailure())
    ).rejects.toThrow();
  });

  it("handleMetroStatusTool returns a successful MCP result on the happy path", async () => {
    const result = await handleMetroStatusTool(
      { system: "台北" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      tokenThenDataFetch(fixture)
    );
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { ok?: boolean }).ok).toBe(true);
    expect(result.content[0]?.text).toContain("正常營運");
    expect(result.content[0]?.text).toContain("60 秒");
  });

  it("handleMetroStatusTool returns an error MCP result on upstream failure", async () => {
    const result = await handleMetroStatusTool(
      { system: "台北" },
      { TDX_CLIENT_ID: "id", TDX_CLIENT_SECRET: "secret" },
      fetchWithFailure()
    );
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { ok?: boolean }).ok).toBe(false);
  });
});

describe("formatMetroStatusText", () => {
  it("relays Title/Description verbatim, the raw status code, update time, and the self-reported interval", () => {
    const text = formatMetroStatusText({
      query: { system: "台北" },
      systemId: "TRTC",
      updateTime: "2026-07-22T22:13:34+08:00",
      updateIntervalSeconds: 60,
      alerts: [
        {
          AlertID: "0",
          Title: "正常營運",
          Description: "正常營運",
          Status: 1,
          PublishTime: "2026-07-22T22:13:35+08:00",
          UpdateTime: "2026-07-22T22:13:35+08:00"
        }
      ]
    });

    expect(text).toContain("正常營運");
    expect(text).toContain("2026-07-22T22:13:34+08:00");
    expect(text).toContain("60 秒");
    expect(text).toContain("狀態代碼 1");
  });

  it("shows both Title and Description when they differ", () => {
    const text = formatMetroStatusText({
      query: { system: "台北" },
      systemId: "TRTC",
      updateTime: "2026-07-22T22:13:34+08:00",
      updateIntervalSeconds: 60,
      alerts: [
        {
          AlertID: "1",
          Title: "板南線部分區間列車延誤",
          Description: "板南線因設備問題，列車延誤約5分鐘",
          Status: 2,
          PublishTime: "2026-07-22T22:13:35+08:00",
          UpdateTime: "2026-07-22T22:13:35+08:00"
        }
      ]
    });
    expect(text).toContain("板南線部分區間列車延誤");
    expect(text).toContain("設備問題");
  });

  it("reports no reported status in plain language, not as certainty of normal or abnormal operation", () => {
    const text = formatMetroStatusText({
      query: { system: "台北" },
      systemId: "TRTC",
      updateTime: null,
      updateIntervalSeconds: null,
      alerts: []
    });
    expect(text).toContain("查無");
    expect(text).toContain("不代表系統確定正常或異常");
  });
});
