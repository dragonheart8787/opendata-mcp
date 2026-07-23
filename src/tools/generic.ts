import { z } from "zod";
import { cwaAdapter } from "../adapters/cwa.js";
import { highwayAdapter } from "../adapters/highway.js";
import { moenvAdapter } from "../adapters/moenv.js";
import { tdxAdapter } from "../adapters/tdx.js";
import type { SourceAdapter } from "../adapters/types.js";
import { withCacheTracked } from "../infra/cache.js";
import { buildFailureEnvelope, buildSuccessEnvelope } from "../infra/envelope.js";
import { ToolError, toToolError } from "../infra/errors.js";
import { listDatasetEntries, type DatasetEntry } from "../registry/index.js";
import type { Env } from "../index.js";
import type { McpToolResult } from "./types.js";

/**
 * §3.2 of docs/ARCHITECTURE.md: the long-tail/generic layer. Two tools:
 * `tw_search_datasets` searches this server's registry (not the whole
 * government open-data platform), `tw_query_dataset` executes a query
 * against a specific already-registered dataset. Both are thin wrappers —
 * the actual fetch+transform logic is the same registry entries + adapters
 * the three curated tools already use, so a dataset added to the registry
 * is immediately reachable through both the curated tool (if one exists)
 * and this generic layer, with identical behavior.
 */

const ADAPTERS: Record<DatasetEntry<never, unknown, unknown>["source"], SourceAdapter> = {
  cwa: cwaAdapter,
  moenv: moenvAdapter,
  tdx: tdxAdapter,
  highway: highwayAdapter
};

// --- tw_search_datasets ---

export const searchDatasetsInputShape = {
  query: z
    .string()
    .min(1)
    .describe("搜尋關鍵字，比對已註冊資料集的標題與關鍵字標籤（例如「地震」「空氣品質」「溫度」）。"),
  source: z
    .enum(["cwa", "moenv", "tdx", "highway"])
    .optional()
    .describe(
      "只搜尋特定機關的資料集：cwa（中央氣象署）、moenv（環境部）、tdx（交通部運輸資料流通服務）或 " +
        "highway（交通部高速公路局『交通資料庫』）。不填則搜尋所有機關。"
    )
};

export interface DatasetSearchParamInfo {
  name: string;
  description?: string;
  required: boolean;
}

export interface DatasetSearchResultItem {
  datasetId: string;
  title: string;
  params: DatasetSearchParamInfo[];
  source: string;
}

export interface SearchDatasetsResult {
  [key: string]: unknown;
  query: string;
  results: DatasetSearchResultItem[];
}

function matchesQuery(entry: DatasetEntry<never, unknown, unknown>, query: string): boolean {
  const q = query.toLowerCase();
  return entry.title.toLowerCase().includes(q) || entry.keywords.some(keyword => keyword.toLowerCase().includes(q));
}

function describeParams(entry: DatasetEntry<never, unknown, unknown>): DatasetSearchParamInfo[] {
  return Object.entries(entry.paramsSchema).map(([name, schema]) => ({
    name,
    description: schema.description,
    required: !schema.isOptional()
  }));
}

/** Pure search logic (no I/O), directly unit-testable against the real registry. */
export function runSearchDatasets(query: string, source?: DatasetEntry<never, unknown, unknown>["source"]): SearchDatasetsResult {
  const results = listDatasetEntries()
    .filter(entry => (source ? entry.source === source : true))
    .filter(entry => matchesQuery(entry, query))
    .map(entry => ({
      datasetId: entry.id,
      title: entry.title,
      params: describeParams(entry),
      source: ADAPTERS[entry.source].displayName
    }));
  return { query, results };
}

export function formatSearchDatasetsText(result: SearchDatasetsResult): string {
  if (result.results.length === 0) {
    return `找不到符合「${result.query}」的已註冊資料集。可換個關鍵字再試，或這個資料集尚未收錄進本伺服器。`;
  }
  const lines = [`# 搜尋「${result.query}」的結果`, ""];
  for (const item of result.results) {
    lines.push(`## ${item.datasetId} — ${item.title}`);
    lines.push(`- 資料來源：${item.source}`);
    if (item.params.length === 0) {
      lines.push(`- 參數：無`);
    } else {
      lines.push(`- 參數：`);
      for (const param of item.params) {
        lines.push(`  - ${param.name}${param.required ? "（必填）" : "（選填）"}：${param.description ?? "（無說明）"}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function handleSearchDatasetsTool(params: {
  query: string;
  source?: DatasetEntry<never, unknown, unknown>["source"];
}): McpToolResult {
  try {
    const data = runSearchDatasets(params.query, params.source);
    return {
      content: [{ type: "text", text: formatSearchDatasetsText(data) }],
      // Deliberately not the full buildSuccessEnvelope shape (source/dataset/
      // cached/updateFrequency don't apply to a registry-only meta search —
      // there's no single upstream source and nothing is ever cached), but
      // `{ ok, data }` is kept so every tool's structuredContent.data holds
      // the payload, matching what post-deploy-smoke-test.yml and any other
      // generic consumer reasonably assumes across all tools.
      structuredContent: { ok: true, data }
    };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}

// --- tw_query_dataset ---

export const queryDatasetInputShape = {
  datasetId: z
    .string()
    .min(1)
    .describe(
      "已註冊資料集的 id（例如「cwa:E-A0015-001」），須先用 tw_search_datasets 查到正確的 id — " +
        "只接受本伺服器 registry 內已知的 id，不接受任意路徑或網址。"
    ),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("該資料集要求的查詢參數，依資料集而不同；可用 tw_search_datasets 查詢每個資料集接受哪些參數。")
};

/** Allowlist lookup: only ids actually registered in the registry are ever reachable — never an arbitrary path/URL. */
function findEntry(datasetId: string): DatasetEntry<never, unknown, unknown> {
  const entry = listDatasetEntries().find(candidate => candidate.id === datasetId);
  if (!entry) {
    const available = listDatasetEntries()
      .map(candidate => candidate.id)
      .join("、");
    throw new ToolError({
      code: "NOT_FOUND",
      message:
        `找不到資料集 id「${datasetId}」。可先呼叫 tw_search_datasets 查詢目前已註冊的資料集，` +
        `目前已知的 id 有：${available}。`
    });
  }
  return entry;
}

/** Runs both validation stages a curated tool would: per-field schema, then the entry's own cross-field rule (if any). */
function parseParams(entry: DatasetEntry<never, unknown, unknown>, rawParams: Record<string, unknown>): never {
  const schema = z.object(entry.paramsSchema);
  const result = schema.safeParse(rawParams);
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("；");
    throw new ToolError({
      code: "INVALID_PARAMS",
      message: `資料集「${entry.id}」的參數不正確：${issues}`
    });
  }
  entry.validateParams?.(result.data as never);
  return result.data as never;
}

/** Stable, order-independent JSON so the same logical query always maps to the same cache key. */
function serializeParams(params: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    sorted[key] = params[key];
  }
  return JSON.stringify(sorted);
}

/** Fetch + transform, no cache — directly unit-testable against a mocked `fetchImpl`, same pattern as the curated tools. */
export async function runQueryDataset(
  datasetId: string,
  rawParams: Record<string, unknown>,
  env: Env,
  fetchImpl?: typeof fetch
): Promise<{ entry: DatasetEntry<never, unknown, unknown>; data: unknown }> {
  const entry = findEntry(datasetId);
  const params = parseParams(entry, rawParams);
  const adapter = ADAPTERS[entry.source];
  const raw = await adapter.fetchDataset(entry, params, env, fetchImpl);
  const data = entry.transform(raw, params);
  return { entry, data };
}

/** Composes cache + envelope on top of `runQueryDataset`, same shape as the curated tools' `handleXTool` functions. */
export async function handleQueryDatasetTool(
  params: { datasetId: string; params?: Record<string, unknown> },
  env: Env,
  fetchImpl?: typeof fetch
): Promise<McpToolResult> {
  try {
    const entry = findEntry(params.datasetId);
    const adapter = ADAPTERS[entry.source];
    const cacheKey = `query:${entry.id}:${serializeParams(params.params ?? {})}`;

    const { value: data, cached } = await withCacheTracked(env.CACHE, cacheKey, entry.cacheTtlSeconds, async () => {
      const result = await runQueryDataset(params.datasetId, params.params ?? {}, env, fetchImpl);
      return result.data;
    });

    const envelope = buildSuccessEnvelope({
      source: adapter.displayName,
      dataset: entry.path,
      cached,
      updateFrequency: entry.updateFrequency,
      data
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: envelope
    };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      content: [{ type: "text", text: toolError.message }],
      structuredContent: buildFailureEnvelope(toolError),
      isError: true
    };
  }
}
