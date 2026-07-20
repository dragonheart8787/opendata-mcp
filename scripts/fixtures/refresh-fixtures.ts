#!/usr/bin/env tsx
/**
 * Fetches real responses for every registered dataset, diffs their
 * structure (not values — see shape-diff.ts) against the checked-in
 * fixtures in test/fixtures/, and rewrites any fixture whose shape
 * changed. Intended to run from .github/workflows/fixtures-refresh.yml
 * on a schedule, using repo secrets CWA_API_KEY / MOENV_API_KEY (GitHub
 * Actions has unrestricted egress, unlike the Claude Code sandbox this
 * pipeline exists to route around — see docs/adr and
 * docs/sessions/SESSION-B.md for why).
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
import { httpGet } from "../../src/infra/http.js";
import { recentEarthquakesEntry, weatherForecastEntry } from "../../src/registry/cwa.js";
import { airQualityEntry } from "../../src/registry/moenv.js";
import { diffShapesFromValues, formatShapeDiff } from "./shape-diff.js";

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../test/fixtures");

const CWA_API_KEY = process.env.CWA_API_KEY;
const MOENV_API_KEY = process.env.MOENV_API_KEY;

/** Defensive: strip any literal occurrence of the API key out of a captured response before it's ever written to disk. */
function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

async function fetchRawJson(url: URL, secret: string | undefined): Promise<unknown> {
  const response = await httpGet(url.toString(), { headers: { accept: "application/json" } });
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

function buildChecks(): DatasetCheck[] {
  if (!CWA_API_KEY || !MOENV_API_KEY) {
    throw new Error("CWA_API_KEY and MOENV_API_KEY must both be set in the environment.");
  }

  return [
    {
      name: "weather-forecast (cwa:F-C0032-001)",
      fixturePath: path.join(FIXTURES_DIR, "weather-forecast.json"),
      fetch: () => fetchRawJson(buildCwaUrl(weatherForecastEntry, { city: "臺北市" }, CWA_API_KEY!), CWA_API_KEY)
    },
    {
      name: "earthquakes (cwa:E-A0015-001)",
      fixturePath: path.join(FIXTURES_DIR, "earthquakes.json"),
      fetch: () => fetchRawJson(buildCwaUrl(recentEarthquakesEntry, { limit: 3 }, CWA_API_KEY!), CWA_API_KEY)
    },
    {
      name: "air-quality (moenv:aqx_p_432)",
      fixturePath: path.join(FIXTURES_DIR, "air-quality.json"),
      fetch: () => fetchRawJson(buildMoenvUrl(airQualityEntry, { county: "臺北市" }, MOENV_API_KEY!), MOENV_API_KEY)
    }
  ];
}

async function main(): Promise<void> {
  const checks = buildChecks();
  const changedDatasets: string[] = [];
  const summarySections: string[] = [];
  let hadFetchFailure = false;

  for (const check of checks) {
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
