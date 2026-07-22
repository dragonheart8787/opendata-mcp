#!/usr/bin/env tsx
/**
 * Fetches real responses for every registered dataset that declares
 * `sampleParams` (see registry/index.ts), diffs their structure (not
 * values — see shape-diff.ts) against the checked-in fixtures in
 * test/fixtures/, and rewrites any fixture whose shape changed. Intended to
 * run from .github/workflows/fixtures-refresh.yml on a schedule, using repo
 * secrets CWA_API_KEY / MOENV_API_KEY (GitHub Actions has unrestricted
 * egress, unlike the Claude Code sandbox this pipeline exists to route
 * around — see docs/adr and docs/sessions/SESSION-B.md for why).
 *
 * The dataset list is read dynamically from `listDatasetEntries()` — this
 * used to be a hand-maintained list of exactly the 3 original datasets,
 * which meant every new registry entry needed a matching manual edit here
 * or it silently got no drift coverage (a gap called out explicitly in the
 * PR that added 3 more registry-only entries). Now any dataset that sets
 * `sampleParams` is automatically included; one that doesn't is skipped
 * with a visible log line rather than crashing or being silently omitted.
 *
 * Reuses the adapters' own `buildCwaUrl` / `buildMoenvUrl` helpers so the
 * request sent here is byte-identical (auth injection, query params) to
 * what production sends — this script is deliberately NOT a reimplementation
 * of the adapters' fetch logic.
 *
 * Writes GitHub Actions outputs (`changed`, `changed-datasets`,
 * `summary-file`) when run under `GITHUB_OUTPUT`, consumed by the workflow
 * to decide whether to open a PR/issue.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCwaUrl } from "../../src/adapters/cwa.js";
import { buildMoenvUrl } from "../../src/adapters/moenv.js";
import { getAccessToken, buildTdxUrl } from "../../src/adapters/tdx.js";
import { httpGet } from "../../src/infra/http.js";
import { listDatasetEntries } from "../../src/registry/index.js";
import { diffShapesFromValues, formatShapeDiff } from "./shape-diff.js";

// Side-effect imports: populate the registry singleton with every source's
// entries before listDatasetEntries() is called below. New sources need
// their registry module imported here too, same as src/index.ts does.
import "../../src/registry/cwa.js";
import "../../src/registry/moenv.js";
import "../../src/registry/tdx.js";

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../test/fixtures");

/**
 * Delay between each dataset check. Added after a real dispatch hit a
 * genuine TDX HTTP 429 ("API rate limit exceeded") on the 6th TDX entry
 * checked in one run — this script fires every check back-to-back with no
 * pacing at all, and every TDX check does its own token fetch AND data
 * fetch (see `getAccessToken` below), so 6 TDX entries means ~12 rapid
 * requests to tdx.transportdata.tw before this delay existed. This
 * disproves an earlier comment on this file's TDX branch that assumed
 * "nowhere near TDX's per-IP rate limit" — that assumption held only while
 * there were few enough TDX entries to not notice. 750ms keeps the whole
 * run's added latency modest (well under 20 real API keys' worth) while
 * giving TDX's short-window limiter room to breathe; CWA/MOENV haven't
 * shown any rate-limit symptoms, so this applies uniformly rather than
 * special-casing one source.
 */
const INTER_CHECK_DELAY_MS = 750;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CWA_API_KEY = process.env.CWA_API_KEY;
const MOENV_API_KEY = process.env.MOENV_API_KEY;
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID;
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET;

/** Defensive: strip any literal occurrence of the API key out of a captured response before it's ever written to disk. */
function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

async function fetchRawJson(url: URL, secret: string | undefined, extraHeaders?: Record<string, string>): Promise<unknown> {
  const response = await httpGet(url.toString(), { headers: { accept: "application/json", ...extraHeaders } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} fetching ${redact(url.toString(), secret)}: ${redact(text, secret).slice(0, 500)}`
    );
  }
  return JSON.parse(redact(text, secret));
}

interface DatasetCheck {
  name: string;
  fixturePath: string;
  fetch: () => Promise<unknown>;
}

/** Derives a stable, filesystem-safe fixture filename for an entry that didn't set `fixtureFileName` explicitly. */
function fallbackFixtureFileName(datasetId: string): string {
  return `${datasetId.replace(/[^a-zA-Z0-9_-]+/g, "-")}.json`;
}

function buildChecks(): DatasetCheck[] {
  if (!CWA_API_KEY || !MOENV_API_KEY) {
    throw new Error("CWA_API_KEY and MOENV_API_KEY must both be set in the environment.");
  }

  const checks: DatasetCheck[] = [];

  // Deliberately no upfront "TDX_CLIENT_ID/TDX_CLIENT_SECRET must be set"
  // throw here, unlike the CWA/MOENV check above: those two are assumed
  // permanently configured (this script has always required them). TDX is
  // brand new — its secrets may not exist in this repo yet — and a missing
  // TDX credential must not abort the whole run and lose CWA/MOENV
  // verification along with it. If TDX_CLIENT_ID/TDX_CLIENT_SECRET are
  // unset, getAccessToken() below throws its normal AUTH_MISSING ToolError,
  // which the per-check try/catch in main() already handles the same way
  // it handles any other per-dataset fetch failure (e.g. O-B0076-001's real
  // 404) — logged and surfaced in the summary, not a hard abort.
  for (const entry of listDatasetEntries()) {
    if (entry.sampleParams === undefined) {
      console.log(`Skipping ${entry.id} (${entry.title}) — no sampleParams declared, can't safely build a request.`);
      continue;
    }

    const fixtureFileName = entry.fixtureFileName ?? fallbackFixtureFileName(entry.id);
    const sampleParams = entry.sampleParams;

    checks.push({
      name: `${entry.title} (${entry.id})`,
      fixturePath: path.join(FIXTURES_DIR, fixtureFileName),
      fetch: async () => {
        if (entry.source === "cwa") {
          return fetchRawJson(buildCwaUrl(entry, sampleParams, CWA_API_KEY!), CWA_API_KEY);
        }
        if (entry.source === "moenv") {
          return fetchRawJson(buildMoenvUrl(entry, sampleParams, MOENV_API_KEY!), MOENV_API_KEY);
        }
        if (entry.source === "tdx") {
          // No KV in this standalone script, so no token caching — each run
          // fetches its own token. A real dispatch showed this (plus the
          // lack of any inter-check delay — see INTER_CHECK_DELAY_MS above)
          // CAN hit TDX's rate limit once there are enough TDX entries in a
          // single run; the delay between checks is what keeps this safe
          // now, not an assumption that TDX's limit is generous.
          const accessToken = await getAccessToken({ TDX_CLIENT_ID, TDX_CLIENT_SECRET, CACHE: undefined }, fetch);
          return fetchRawJson(buildTdxUrl(entry, sampleParams), undefined, { authorization: `Bearer ${accessToken}` });
        }
        throw new Error(`No fixtures-refresh fetch strategy for source "${entry.source}" (dataset ${entry.id}).`);
      }
    });
  }

  return checks;
}

async function main(): Promise<void> {
  const checks = buildChecks();
  const changedDatasets: string[] = [];
  const summarySections: string[] = [];
  let hadFetchFailure = false;

  for (const [index, check] of checks.entries()) {
    if (index > 0) {
      await sleep(INTER_CHECK_DELAY_MS);
    }

    console.log(`Fetching ${check.name}...`);

    let fresh: unknown;
    try {
      fresh = await check.fetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAILED: ${message}`);
      summarySections.push(`## ${check.name}\n\n⚠️ 無法取得最新回應：${message}`);
      hadFetchFailure = true;
      continue;
    }

    const existing = existsSync(check.fixturePath) ? JSON.parse(readFileSync(check.fixturePath, "utf-8")) : undefined;

    if (existing === undefined) {
      console.log("  no existing fixture — writing new one");
      writeFileSync(check.fixturePath, JSON.stringify(fresh, null, 2) + "\n");
      changedDatasets.push(check.name);
      summarySections.push(`## ${check.name}\n\n之前沒有 fixture，已建立新檔案。`);
      continue;
    }

    const diffs = diffShapesFromValues(existing, fresh);
    if (diffs.length > 0) {
      const diffText = formatShapeDiff(diffs);
      console.log(`  structural diff found:\n${diffText}`);
      writeFileSync(check.fixturePath, JSON.stringify(fresh, null, 2) + "\n");
      changedDatasets.push(check.name);
      summarySections.push(`## ${check.name}\n\n${diffText}`);
    } else {
      console.log("  no structural change");
    }
  }

  const changed = changedDatasets.length > 0;
  const summary = changed
    ? `以下資料集的回應結構與現有 fixture 不同，已自動更新 fixture 檔案：\n\n${summarySections.join("\n\n")}`
    : hadFetchFailure
      ? `部分資料集無法取得最新回應（詳見上方 log），但沒有偵測到結構性差異：\n\n${summarySections.join("\n\n")}`
      : "所有資料集的回應結構皆與現有 fixture 一致，無需更新。";

  console.log("\n" + summary);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `changed-datasets=${changedDatasets.join(", ")}\n`);
    const summaryPath = path.join(process.cwd(), "fixtures-diff-summary.md");
    writeFileSync(summaryPath, summary + "\n");
    appendFileSync(process.env.GITHUB_OUTPUT, `summary-file=${summaryPath}\n`);
  }

  if (hadFetchFailure && !changed) {
    // Nothing to update, but something was wrong enough to be worth a non-zero exit for visibility in the Actions run.
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
