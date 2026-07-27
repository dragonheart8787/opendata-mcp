import { pccAdapter } from "../adapters/pcc.js";
import { PCC_OFFICIAL_SITE_URL } from "../constants.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { toToolError } from "../infra/errors.js";
import type { Env } from "../index.js";
import {
  tenderSearchEntry,
  tenderSearchInputShape,
  type TenderSearchParams,
  type TenderSearchResult,
  type TenderSummary
} from "../registry/pcc.js";
import type { McpToolResult } from "./types.js";

export { tenderSearchInputShape };

/** Fetch + transform, no join needed — single-entry tool, same pattern as tw_highway_traffic. */
export async function runTenderSearch(params: TenderSearchParams, env: Env, fetchImpl?: typeof fetch) {
  const raw = await pccAdapter.fetchDataset(tenderSearchEntry, params, env, fetchImpl);
  return tenderSearchEntry.transform(raw, params);
}

function formatTenderLine(tender: TenderSummary): string {
  const name = tender.tenderName ?? "（無標案名稱）";
  const header = `- ${name}`;
  const meta = [
    tender.unitName ? `機關：${tender.unitName}` : null,
    tender.announcementType ? `公告類型：${tender.announcementType}` : null,
    tender.announcedDate ? `公告日期：${tender.announcedDate}` : null,
    tender.category ? `標的分類：${tender.category}` : null,
    tender.companies.length > 0 ? `相關廠商：${tender.companies.join("、")}` : null,
    tender.detailUrl ? `詳細：${tender.detailUrl}` : null
  ].filter((v): v is string => v !== null);
  return [header, ...meta.map(m => `  ${m}`)].join("\n");
}

/**
 * The source-credibility disclosure leads the output and is repeated in
 * `structuredContent.data.sourceNotice`.
 *
 * This placement is the point, not decoration. A disclosure that lives only
 * in the tool's `description` is one the calling LLM reads once, before it
 * ever sees a result, and routinely drops when it paraphrases the answer to
 * the user — which is exactly what happened with tw_rail's 2-minute-delay
 * caveat (see AGENTS.md §6). Anything a user must not be misled about has
 * to travel inside the payload.
 */
export function formatTenderSearchText(result: TenderSearchResult): string {
  const lines: string[] = [];

  lines.push(`⚠️ ${result.sourceNotice}`);
  lines.push("");

  const scope = result.query.unitName
    ? `# 政府採購標案搜尋（標案名稱：${result.query.title}；機關：${result.query.unitName}）`
    : `# 政府採購標案搜尋（標案名稱：${result.query.title}）`;
  lines.push(scope);
  lines.push("");

  if (result.tenders.length === 0) {
    lines.push(
      "目前查無符合的標案公告。這可能代表此鏡像收錄的資料中沒有符合的標案名稱，" +
        "也可能是該標案尚未被此鏡像擷取到——不代表政府電子採購網上不存在這筆標案。" +
        `建議直接至政府電子採購網（${PCC_OFFICIAL_SITE_URL}）確認。`
    );
  } else {
    if (result.totalRecords !== null) {
      lines.push(`此鏡像回報共 ${result.totalRecords} 筆符合，以下顯示 ${result.returnedCount} 筆：`);
    } else {
      lines.push(`以下顯示 ${result.returnedCount} 筆：`);
    }
    lines.push("");
    for (const tender of result.tenders) {
      lines.push(formatTenderLine(tender));
    }
    if (result.truncated) {
      lines.push("");
      lines.push("（本頁結果過多，僅顯示前面部分。請縮小標案名稱關鍵字範圍，或加上機關名稱篩選。）");
    }
  }

  lines.push("");
  lines.push("本工具不提供預算金額與截止投標日期——此查詢端點的回應本身不含這兩個欄位，請至上方各標案的詳細連結或政府電子採購網查閱。");
  lines.push("");
  lines.push("資料使用授權（引用自政府電子採購網著作權聲明，非政府資料開放授權條款）：");
  for (const clause of result.copyrightNotice) {
    lines.push(`  ${clause}`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** Composes cache + envelope on top of `runTenderSearch`, for the MCP tool registration in index.ts. */
export async function handleTenderSearchTool(
  params: TenderSearchParams,
  env: Env,
  fetchImpl?: typeof fetch
): Promise<McpToolResult> {
  try {
    const cacheKey = `tender-search:${params.title}:${params.unitName ?? ""}:${params.page ?? 1}`;
    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, tenderSearchEntry.cacheTtlSeconds, () =>
      runTenderSearch(params, env, fetchImpl)
    );
    const envelope = buildSuccessEnvelope({
      source: pccAdapter.displayName,
      // The one non-official source in this server — see registry/index.ts's
      // SOURCE_PROVENANCE. This makes the caveat machine-readable, on top of
      // the human-readable one inside `data.sourceNotice`.
      provenance: "community-mirror",
      dataset: tenderSearchEntry.id,
      cached,
      updateFrequency: tenderSearchEntry.updateFrequency,
      data
    });
    return { content: [{ type: "text", text: formatTenderSearchText(data) }], structuredContent: envelope };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
