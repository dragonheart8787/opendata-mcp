import { describe, expect, it } from "vitest";
import { buildFailureEnvelope, buildSuccessEnvelope, type EnvelopeProvenance } from "../../src/infra/envelope.js";
import { ToolError } from "../../src/infra/errors.js";
import { SOURCE_PROVENANCE } from "../../src/registry/index.js";

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

describe("envelope provenance", () => {
  it("omits `provenance` entirely for official sources, keeping their response shape unchanged", () => {
    const envelope = buildSuccessEnvelope({
      source: "中央氣象署",
      provenance: "official",
      dataset: "F-C0032-001",
      cached: false,
      updateFrequency: "每日數次",
      data: {}
    });
    expect("provenance" in envelope).toBe(false);
  });

  it("omits `provenance` when not supplied at all (every pre-existing caller)", () => {
    const envelope = buildSuccessEnvelope({
      source: "中央氣象署",
      dataset: "F-C0032-001",
      cached: false,
      updateFrequency: "每日數次",
      data: {}
    });
    expect("provenance" in envelope).toBe(false);
  });

  it("emits `provenance` for a non-official source, so callers can detect mirrored data programmatically", () => {
    const envelope = buildSuccessEnvelope({
      source: "g0v 標案資料鏡像（資料源自政府電子採購網）",
      provenance: "community-mirror",
      dataset: "pcc:searchbytitle",
      cached: false,
      updateFrequency: "非即時",
      data: {}
    });
    expect(envelope.provenance).toBe("community-mirror");
  });

  it("stays in sync with the registry's SourceProvenance union", () => {
    // infra/ must not import registry/ (AGENTS.md §1), so EnvelopeProvenance
    // is a duplicated literal union. This asserts the duplication hasn't
    // drifted: every provenance value the registry can produce must be a
    // valid envelope provenance.
    const registryValues: EnvelopeProvenance[] = Object.values(SOURCE_PROVENANCE);
    expect(new Set(registryValues)).toEqual(new Set(["official", "community-mirror"]));
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
