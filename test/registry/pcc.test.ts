import { describe, expect, it } from "vitest";
import { PCC_COPYRIGHT_NOTICE, TENDER_SEARCH_MAX_RESULTS_RETURNED } from "../../src/constants.js";
import { formatAnnouncedDate, matchesTenderFilters, tenderSearchEntry, type PccSearchResponse } from "../../src/registry/pcc.js";

function record(overrides: Record<string, unknown> = {}) {
  return {
    date: "20230829",
    filename: "BDM-1-70370443",
    brief: {
      type: "決標公告",
      title: "開放政府國家行動方案委外服務案",
      category: "資訊服務",
      companies: { ids: ["12345678"], names: ["開放文化基金會"] }
    },
    job_number: "ndc109050",
    unit_id: "A.41",
    unit_name: "國家發展委員會",
    url: "/index/entry/20230829/BDM-1-70370443",
    ...overrides
  };
}

function response(records: unknown[], extra: Partial<PccSearchResponse> = {}): PccSearchResponse {
  return { total_records: records.length, records, ...extra };
}

describe("formatAnnouncedDate", () => {
  it("normalizes upstream's YYYYMMDD to YYYY-MM-DD", () => {
    expect(formatAnnouncedDate("20230829")).toBe("2023-08-29");
  });

  it("leaves an unexpected format untouched rather than guessing at it", () => {
    expect(formatAnnouncedDate("2023-08-29")).toBe("2023-08-29");
    expect(formatAnnouncedDate("not-a-date")).toBe("not-a-date");
  });

  it("returns null for missing/empty values", () => {
    expect(formatAnnouncedDate(undefined)).toBeNull();
    expect(formatAnnouncedDate("")).toBeNull();
    expect(formatAnnouncedDate(20230829)).toBeNull();
  });
});

describe("matchesTenderFilters", () => {
  it("requires every whitespace-separated title token to appear, mirroring upstream's AND semantics", () => {
    expect(matchesTenderFilters(record(), { title: "開放政府 行動方案" })).toBe(true);
    expect(matchesTenderFilters(record(), { title: "開放政府 不存在的詞" })).toBe(false);
  });

  it("matches the agency name as a substring when unitName is given", () => {
    expect(matchesTenderFilters(record(), { title: "開放政府", unitName: "國家發展" })).toBe(true);
    expect(matchesTenderFilters(record(), { title: "開放政府", unitName: "臺北市政府" })).toBe(false);
  });

  it("ignores a blank unitName rather than filtering everything out", () => {
    expect(matchesTenderFilters(record(), { title: "開放政府", unitName: "   " })).toBe(true);
  });

  it("does not throw on a record missing brief/unit_name entirely", () => {
    expect(matchesTenderFilters({}, { title: "開放政府" })).toBe(false);
  });
});

describe("tenderSearchEntry.buildQueryParams", () => {
  it("maps our `title` param onto the upstream's `query` param", () => {
    expect(tenderSearchEntry.buildQueryParams({ title: "開放政府" })).toEqual({ query: "開放政府", page: undefined });
  });

  it("passes page through as a string when given", () => {
    expect(tenderSearchEntry.buildQueryParams({ title: "x", page: 3 })).toEqual({ query: "x", page: "3" });
  });

  it("never sends unitName upstream — this API has no agency-name search", () => {
    const params = tenderSearchEntry.buildQueryParams({ title: "x", unitName: "國家發展委員會" });
    expect(Object.values(params)).not.toContain("國家發展委員會");
  });
});

describe("tenderSearchEntry.transform", () => {
  it("maps a record onto the result shape, normalizing the date and absolutizing the detail URL", () => {
    const result = tenderSearchEntry.transform(response([record()]), { title: "開放政府" });
    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0]).toEqual({
      tenderName: "開放政府國家行動方案委外服務案",
      unitName: "國家發展委員會",
      unitId: "A.41",
      announcementType: "決標公告",
      category: "資訊服務",
      announcedDate: "2023-08-29",
      jobNumber: "ndc109050",
      companies: ["開放文化基金會"],
      detailUrl: "https://pcc.g0v.ronny.tw/index/entry/20230829/BDM-1-70370443"
    });
  });

  it("carries the source-credibility notice in the DATA, not just the tool description", () => {
    const result = tenderSearchEntry.transform(response([record()]), { title: "開放政府" });
    expect(result.sourceNotice).toContain("g0v");
    expect(result.sourceNotice).toContain("非官方");
    expect(result.sourceNotice).toContain("web.pcc.gov.tw");
  });

  it("carries the verbatim copyright statement, not a paraphrase", () => {
    const result = tenderSearchEntry.transform(response([record()]), { title: "開放政府" });
    expect(result.copyrightNotice).toEqual(PCC_COPYRIGHT_NOTICE);
    expect(result.copyrightNotice.join("")).toContain("個人或家庭非營利之目的");
  });

  // AGENTS.md §6: upstream filtering is never trusted to have happened.
  it("re-filters client-side when upstream ignores the query and returns unrelated records", () => {
    const raw = response([
      record(),
      record({ brief: { type: "招標公告", title: "完全不相干的道路工程", companies: null }, unit_name: "交通部" })
    ]);
    const result = tenderSearchEntry.transform(raw, { title: "開放政府" });
    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0].tenderName).toContain("開放政府");
  });

  it("applies the unitName filter client-side, since upstream never received it", () => {
    const raw = response([
      record(),
      record({ unit_name: "臺北市政府", job_number: "tpe-1" })
    ]);
    const result = tenderSearchEntry.transform(raw, { title: "開放政府", unitName: "臺北市" });
    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0].unitName).toBe("臺北市政府");
  });

  it("truncates to the response budget and flags that it did", () => {
    const many = Array.from({ length: TENDER_SEARCH_MAX_RESULTS_RETURNED + 5 }, (_, i) => record({ job_number: `job-${i}` }));
    const result = tenderSearchEntry.transform(response(many), { title: "開放政府" });
    expect(result.tenders).toHaveLength(TENDER_SEARCH_MAX_RESULTS_RETURNED);
    expect(result.returnedCount).toBe(TENDER_SEARCH_MAX_RESULTS_RETURNED);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncation when everything fit", () => {
    const result = tenderSearchEntry.transform(response([record()]), { title: "開放政府" });
    expect(result.truncated).toBe(false);
  });

  it("returns an empty result set (not an error) when upstream has no matches", () => {
    const result = tenderSearchEntry.transform(response([]), { title: "開放政府" });
    expect(result.tenders).toEqual([]);
    expect(result.returnedCount).toBe(0);
    // The notice must still be present on an empty result — that's exactly
    // when a caller is most likely to wrongly conclude "no such tender exists".
    expect(result.sourceNotice).toContain("非官方");
  });

  it("survives a response with no records array at all", () => {
    const result = tenderSearchEntry.transform({} as PccSearchResponse, { title: "x" });
    expect(result.tenders).toEqual([]);
    expect(result.totalRecords).toBeNull();
  });

  it("degrades per-field rather than throwing when a record is missing optional fields", () => {
    const raw = response([{ brief: { title: "開放政府測試案" } }]);
    const result = tenderSearchEntry.transform(raw, { title: "開放政府" });
    expect(result.tenders[0]).toMatchObject({
      tenderName: "開放政府測試案",
      unitName: null,
      announcementType: null,
      category: null,
      announcedDate: null,
      companies: [],
      detailUrl: null
    });
  });

  it("echoes the query back, including the page default", () => {
    const result = tenderSearchEntry.transform(response([]), { title: "開放政府" });
    expect(result.query).toEqual({ title: "開放政府", unitName: null, page: 1 });
  });
});

describe("tenderSearchEntry metadata", () => {
  it("is registered under the pcc source with a non-official-source note", () => {
    expect(tenderSearchEntry.source).toBe("pcc");
    expect(tenderSearchEntry.notes).toContain("非官方");
  });

  it("has no sampleParams, so refresh-fixtures.ts skips it instead of recording an expected failure", () => {
    // This host is unreachable from GitHub Actions (same as `highway`).
    expect(tenderSearchEntry.sampleParams).toBeUndefined();
  });
});
