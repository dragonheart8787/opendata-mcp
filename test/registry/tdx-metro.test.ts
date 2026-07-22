import { describe, expect, it } from "vitest";
import { metroAlertEntry } from "../../src/registry/tdx.js";
import { listDatasetEntries } from "../../src/registry/index.js";

// SKELETON-stage tests only — the transform is currently a pass-through
// (real field structure not yet confirmed against a live API response, see
// the module comment on registry/tdx.ts). Once a real fixtures-refresh.yml
// dispatch confirms the actual shape, this file should be rewritten the
// same way test/registry/tdx-rail.test.ts's entries were: fixture-driven
// tests asserting the real mapped fields.

describe("metroAlertEntry", () => {
  it("is registered", () => {
    expect(listDatasetEntries().some(e => e.id === "tdx:metro-alert")).toBe(true);
  });

  it("maps the Chinese system name to TDX's systemId as the only path segment", () => {
    expect(metroAlertEntry.buildPathSegments?.({ system: "台北" })).toEqual(["TRTC"]);
    expect(metroAlertEntry.buildPathSegments?.({ system: "高雄" })).toEqual(["KRTC"]);
    expect(metroAlertEntry.buildPathSegments?.({ system: "桃園" })).toEqual(["TYMC"]);
  });

  it("always requests $format=JSON", () => {
    expect(metroAlertEntry.buildQueryParams({ system: "台北" })).toEqual({ $format: "JSON" });
  });

  it("transform passes the raw array through, wrapped", () => {
    const raw = [{ LineID: "BR", Status: 1 }];
    expect(metroAlertEntry.transform(raw, { system: "台北" })).toEqual({ alerts: raw });
  });
});
