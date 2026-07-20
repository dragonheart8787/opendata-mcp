import { describe, expect, it } from "vitest";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../../src/infra/envelope.js";
import { ToolError } from "../../src/infra/errors.js";

describe("buildSuccessEnvelope", () => {
  it("builds an ok:true envelope with a fresh fetchedAt timestamp", () => {
    const before = Date.now();
    const envelope = buildSuccessEnvelope({
      source: "中央氣象署",
      dataset: "F-C0032-001",
      cached: false,
      updateFrequency: "每日數次",
      data: { city: "臺北市" }
    });
    const after = Date.now();

    expect(envelope.ok).toBe(true);
    expect(envelope.source).toBe("中央氣象署");
    expect(envelope.dataset).toBe("F-C0032-001");
    expect(envelope.cached).toBe(false);
    expect(envelope.updateFrequency).toBe("每日數次");
    expect(envelope.data).toEqual({ city: "臺北市" });
    expect(envelope.issuedAt).toBeUndefined();

    const fetchedAtMs = new Date(envelope.fetchedAt).getTime();
    expect(fetchedAtMs).toBeGreaterThanOrEqual(before);
    expect(fetchedAtMs).toBeLessThanOrEqual(after);
  });

  it("omits issuedAt entirely (no key) when not provided", () => {
    const envelope = buildSuccessEnvelope({
      source: "環境部",
      dataset: "aqx_p_432",
      cached: true,
      updateFrequency: "每小時",
      data: {}
    });
    expect("issuedAt" in envelope).toBe(false);
  });

  it("includes issuedAt when provided", () => {
    const envelope = buildSuccessEnvelope({
      source: "中央氣象署",
      dataset: "E-A0015-001",
      issuedAt: "2026-07-19T14:32:10+08:00",
      cached: false,
      updateFrequency: "地震發生時即時發布",
      data: {}
    });
    expect(envelope.issuedAt).toBe("2026-07-19T14:32:10+08:00");
  });
});

describe("buildFailureEnvelope", () => {
  it("builds an ok:false envelope carrying the error's code/message/hint", () => {
    const error = new ToolError({ code: "AUTH_MISSING", message: "缺少金鑰", hint: "去申請一組" });
    const envelope = buildFailureEnvelope(error);

    expect(envelope).toEqual({
      ok: false,
      error: { code: "AUTH_MISSING", message: "缺少金鑰", hint: "去申請一組" }
    });
  });

  it("defaults hint to message for errors constructed without one", () => {
    const error = new ToolError({ code: "NOT_FOUND", message: "查無資料" });
    const envelope = buildFailureEnvelope(error);
    expect(envelope.error.hint).toBe("查無資料");
  });
});
