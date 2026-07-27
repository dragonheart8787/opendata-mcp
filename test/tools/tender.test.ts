import { describe, expect, it } from "vitest";
import { formatTenderSearchText, handleTenderSearchTool, runTenderSearch } from "../../src/tools/tender.js";
import { jsonFetch, rejectingFetch } from "../helpers.js";

const upstream = {
  total_records: 1,
  records: [
    {
      date: "20230829",
      brief: {
        type: "決標公告",
        title: "開放政府國家行動方案委外服務案",
        category: "資訊服務",
        companies: { names: ["開放文化基金會"] }
      },
      job_number: "ndc109050",
      unit_id: "A.41",
      unit_name: "國家發展委員會",
      url: "/index/entry/20230829/BDM-1-70370443"
    }
  ]
};

describe("runTenderSearch", () => {
  it("fetches and transforms into the tender result shape", async () => {
    const result = await runTenderSearch({ title: "開放政府" }, {}, jsonFetch(upstream));
    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0].tenderName).toBe("開放政府國家行動方案委外服務案");
  });
});

describe("formatTenderSearchText", () => {
  it("leads with the source-credibility disclosure", async () => {
    const result = await runTenderSearch({ title: "開放政府" }, {}, jsonFetch(upstream));
    const text = formatTenderSearchText(result);
    const firstLine = text.split("\n")[0];
    expect(firstLine).toContain("g0v");
    expect(firstLine).toContain("非官方");
  });

  it("names the authoritative official source in the text a user actually reads", async () => {
    const result = await runTenderSearch({ title: "開放政府" }, {}, jsonFetch(upstream));
    expect(formatTenderSearchText(result)).toContain("web.pcc.gov.tw");
  });

  it("quotes the copyright statement verbatim in the output", async () => {
    const result = await runTenderSearch({ title: "開放政府" }, {}, jsonFetch(upstream));
    const text = formatTenderSearchText(result);
    expect(text).toContain("個人或家庭非營利之目的");
    expect(text).toContain("著作權法第44條至第65條");
    // Must NOT claim the 政府資料開放授權條款 that the official sources use.
    expect(text).toContain("非政府資料開放授權條款");
  });

  it("states plainly that budget and bid deadline are absent from this endpoint, rather than silently omitting them", async () => {
    const result = await runTenderSearch({ title: "開放政府" }, {}, jsonFetch(upstream));
    const text = formatTenderSearchText(result);
    expect(text).toContain("預算金額");
    expect(text).toContain("截止投標日期");
  });

  it("on an empty result, says 'not found here' rather than implying the tender doesn't exist", async () => {
    const result = await runTenderSearch({ title: "不存在的標案" }, {}, jsonFetch({ total_records: 0, records: [] }));
    const text = formatTenderSearchText(result);
    expect(text).toContain("不代表政府電子採購網上不存在");
    // The provenance warning must survive the empty path too.
    expect(text).toContain("非官方");
  });

  it("tells the caller how to narrow down when results were truncated", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ ...upstream.records[0], job_number: `job-${i}` }));
    const result = await runTenderSearch({ title: "開放政府" }, {}, jsonFetch({ total_records: 15, records: many }));
    expect(formatTenderSearchText(result)).toContain("縮小標案名稱關鍵字範圍");
  });
});

describe("handleTenderSearchTool", () => {
  it("puts the source notice inside structuredContent.data, not only in the formatted text", async () => {
    const result = await handleTenderSearchTool({ title: "開放政府" }, {}, jsonFetch(upstream));
    const envelope = result.structuredContent as { ok: boolean; data: { sourceNotice: string } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.sourceNotice).toContain("非官方鏡像");
    expect(envelope.data.sourceNotice).toContain("web.pcc.gov.tw");
  });

  it("marks the envelope's provenance as community-mirror so the caveat is machine-readable", async () => {
    const result = await handleTenderSearchTool({ title: "開放政府" }, {}, jsonFetch(upstream));
    const envelope = result.structuredContent as { provenance?: string; source: string };
    expect(envelope.provenance).toBe("community-mirror");
    expect(envelope.source).toContain("g0v");
  });

  it("carries the verbatim copyright statement in structuredContent too", async () => {
    const result = await handleTenderSearchTool({ title: "開放政府" }, {}, jsonFetch(upstream));
    const envelope = result.structuredContent as { data: { copyrightNotice: string[] } };
    expect(envelope.data.copyrightNotice.join("")).toContain("個人或家庭非營利之目的");
  });

  it("returns an actionable failure envelope pointing at the official site when the mirror is down", async () => {
    const result = await handleTenderSearchTool({ title: "x" }, {}, rejectingFetch(new Error("connection refused")));
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as { ok: boolean; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("UPSTREAM_ERROR");
    expect(envelope.error.message).toContain("web.pcc.gov.tw");
  });
});
