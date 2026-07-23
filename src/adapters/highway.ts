import { XMLParser } from "fast-xml-parser";

import { HIGHWAY_API_BASE_URL } from "../constants.js";
import { ToolError } from "../infra/errors.js";
import { httpGetWithBody, isTimeoutError } from "../infra/http.js";
import type { Env } from "../index.js";
import type { DatasetEntry } from "../registry/index.js";
import type { SourceAdapter } from "./types.js";

/**
 * `parseTagValue: false` keeps every leaf as the literal XML text (no
 * auto-detecting numbers/booleans) — same discipline as every other
 * adapter in this project of not silently reinterpreting an upstream
 * value. Registry transforms decide what (if anything) to further parse
 * (e.g. `UpdateInterval` -> number, `Positions`' WKT point -> lon/lat),
 * field by field, rather than trusting a parser's blanket guess across
 * every field uniformly.
 *
 * `isArray` forces `LiveEvent` and `Regulation` to always be arrays even
 * when the real response has exactly one — without this, fast-xml-parser
 * returns a bare object for a single occurrence and an array for two or
 * more, which would make `registry/highway.ts`'s transform's shape depend
 * on how many events happen to be active right now.
 */
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: name => name === "LiveEvent" || name === "Regulation"
});

/**
 * Builds the exact request URL the adapter sends upstream. Exported for
 * symmetry with `buildCwaUrl`/`buildMoenvUrl`/`buildTdxUrl`, though
 * `scripts/fixtures/refresh-fixtures.ts` can't actually reach this host
 * from GitHub Actions (see AGENTS.md §6) — kept for the same reason the
 * others are: a single place that assembles the real request URL, usable
 * by tests without duplicating that logic.
 */
export function buildHighwayUrl<TParams, TRaw>(entry: DatasetEntry<TParams, TRaw, unknown>): URL {
  return new URL(`${HIGHWAY_API_BASE_URL}/${entry.path}`);
}

/**
 * Parses raw XML text into the same shape `fetchDataset` returns, and
 * throws the same SCHEMA_MISMATCH check. Exported so
 * `scripts/fixtures/refresh-fixtures.ts` parses a real captured response
 * with byte-identical logic to production, instead of reimplementing (and
 * risking silently drifting from) the parser config/root-element check —
 * same reasoning as every other adapter's exported `buildXUrl` helper.
 */
export function parseHighwayXml(rawXml: string): unknown {
  const parsed = xmlParser.parse(rawXml) as Record<string, unknown>;
  if (!("LiveEventList" in parsed)) {
    throw new ToolError({
      code: "SCHEMA_MISMATCH",
      message: "交通部高速公路局「交通資料庫」回應中找不到預期的 <LiveEventList> 根元素，可能是資料集路徑錯誤或回應內容非預期的 XML 頁面。"
    });
  }
  return parsed;
}

async function fetchDataset<TParams, TRaw>(
  entry: DatasetEntry<TParams, TRaw, unknown>,
  _params: TParams,
  _env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<TRaw> {
  const url = buildHighwayUrl(entry);

  // `httpGetWithBody` (not plain `httpGet`) deliberately, so the 5s budget
  // covers downloading the full response body too, not just time-to-
  // headers — this endpoint fetches an unfiltered nationwide XML file on
  // every call regardless of the `road` param, so unlike every other
  // adapter in this project its body size (and therefore read time) isn't
  // bounded by a per-city/per-station scope. Real measurement found this
  // isn't currently slow (~0ms body read on top of a ~315ms fetch), but
  // "currently fast" isn't the same as "bounded" — this closes that gap
  // for whenever the live event count grows enough to matter.
  let response: Response;
  let rawXml: string;
  try {
    ({ response, body: rawXml } = await httpGetWithBody(
      url.toString(),
      r => (r.ok ? r.text() : Promise.resolve("")),
      { headers: { accept: "application/xml" } },
      fetchImpl
    ));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ToolError({
        code: "UPSTREAM_TIMEOUT",
        message: "交通部高速公路局「交通資料庫」連線逾時（含下載回應內容，共 5 秒）。請稍後再試；若持續發生，官方平台可能忙碌或維護中。"
      });
    }
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `無法連線到交通部高速公路局「交通資料庫」：${error instanceof Error ? error.message : String(error)}。請稍後再試。`
    });
  }

  if (!response.ok) {
    throw new ToolError({
      code: "UPSTREAM_ERROR",
      message: `交通部高速公路局「交通資料庫」回應錯誤（HTTP ${response.status}）。請稍後再試。`
    });
  }

  // fast-xml-parser is deliberately lenient — it never throws on malformed
  // XML (an unclosed tag, garbage input, even an empty string all parse
  // "successfully" into some object shape rather than raising an error), so
  // a try/catch around `.parse()` alone would never actually fire. The real
  // fail-loud check (does the parsed result even contain the root element
  // this feed is supposed to have?) lives in `parseHighwayXml`, shared with
  // scripts/fixtures/refresh-fixtures.ts.
  return parseHighwayXml(rawXml) as TRaw;
}

export const highwayAdapter: SourceAdapter = {
  id: "highway",
  displayName: "交通部高速公路局『交通資料庫』",
  fetchDataset
};
