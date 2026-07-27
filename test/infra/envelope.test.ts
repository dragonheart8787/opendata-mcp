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
  const base = { source: "中央氣象署", dataset: "F-C0032-001", cached: false, updateFrequency: "每日數次", data: {} };

  it("omits `provenance` when not supplied at all — the shape every existing caller produces", () => {
    expect("provenance" in buildSuccessEnvelope(base)).toBe(false);
  });

  it("omits `provenance` for an explicitly official source, so official responses stay byte-identical", () => {
    expect("provenance" in buildSuccessEnvelope({ ...base, provenance: "official" })).toBe(false);
  });

  it("emits `provenance` for a non-official source, so callers can detect mirrored data programmatically", () => {
    expect(buildSuccessEnvelope({ ...base, provenance: "community-mirror" }).provenance).toBe("community-mirror");
  });

  it("keeps the official envelope's exact key set unchanged", () => {
    expect(Object.keys(buildSuccessEnvelope(base))).toEqual([
      "ok",
      "source",
      "dataset",
      "fetchedAt",
      "cached",
      "updateFrequency",
      "data"
    ]);
  });

  it("every provenance value the registry can produce is a valid envelope provenance", () => {
    // infra/ must not import registry/ (AGENTS.md §1), so EnvelopeProvenance
    // is a duplicated literal union. This asserts the duplication hasn't
    // drifted — a registry value the envelope can't express would be a
    // compile error here, and an unknown value a runtime failure.
    const valid: EnvelopeProvenance[] = ["official", "community-mirror"];
    for (const value of Object.values(SOURCE_PROVENANCE)) {
      expect(valid).toContain(value);
    }
  });

  it("every source registered today is official", () => {
    expect(Object.values(SOURCE_PROVENANCE).every(p => p === "official")).toBe(true);
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
