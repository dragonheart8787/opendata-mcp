#!/usr/bin/env node
/**
 * Post-deploy smoke test: sends real MCP protocol requests to the deployed
 * server (initialize -> tools/list -> one real call per tool) and checks
 * the response envelope. Runs from
 * .github/workflows/post-deploy-smoke-test.yml, which has unrestricted
 * network access (unlike the Claude Code sandbox this pipeline exists to
 * route around — see docs/adr and docs/sessions/SESSION-B.md).
 *
 * Deliberately dependency-free plain Node so the workflow doesn't need a
 * build/typecheck step before running it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const URL_ARG = process.env.SMOKE_TEST_URL || "https://opendata-mcp.dragonheartliu1440.workers.dev/mcp";

/**
 * Derives the expected tool list directly from src/index.ts's real
 * `server.registerTool("toolName", ...)` calls, instead of a hand-copied
 * array in this file — a hardcoded EXPECTED_TOOLS list is exactly the kind
 * of second copy of the truth that silently goes stale the moment a new
 * tool is added elsewhere and nobody remembers to update this file too
 * (confirmed: it had drifted to 5 tools while the server actually
 * registers 10 — and would go stale again the next time a tool is added,
 * exactly the failure this fix removes). This workflow runs plain `node`
 * with no `npm ci`/build step (see post-deploy-smoke-test.yml), so this
 * can't import the TypeScript source as a module — reading it as text and
 * regex-matching the one call shape every tool registration actually uses
 * is the genuinely-dynamic option available without adding a dependency
 * or a build step to the workflow.
 */
function deriveExpectedToolsFromSource() {
  const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
  const source = readFileSync(indexPath, "utf-8");
  const names = [...source.matchAll(/server\.registerTool\(\s*["']([a-zA-Z0-9_]+)["']/g)].map(m => m[1]);
  if (names.length === 0) {
    throw new Error(`Found zero server.registerTool(...) calls in ${indexPath} — regex is broken or the file moved/changed shape.`);
  }
  return names;
}

const EXPECTED_TOOLS = deriveExpectedToolsFromSource();

const TOOL_CALLS = [
  {
    name: "tw_weather_forecast",
    arguments: { city: "臺北市" },
    checkData: data => Array.isArray(data?.periods) && data.periods.length > 0
  },
  {
    name: "tw_recent_earthquakes",
    arguments: { limit: 1 },
    // Legitimately can be an empty array (no recent 顯著有感 earthquake) -
    // see the tool's own description. Only the array shape is required.
    checkData: data => Array.isArray(data?.earthquakes)
  },
  {
    name: "tw_air_quality",
    arguments: { county: "臺北市" },
    checkData: data => Array.isArray(data?.stations) && data.stations.length > 0
  },
  {
    name: "tw_search_datasets",
    arguments: { query: "地震" },
    // Should always find cwa:E-A0015-001 by keyword; a stable, no-upstream-call sanity check.
    checkData: data => Array.isArray(data?.results) && data.results.some(r => r.datasetId === "cwa:E-A0015-001")
  },
  {
    name: "tw_query_dataset",
    arguments: { datasetId: "cwa:E-A0015-001", params: { limit: 1 } },
    // Same underlying dataset as tw_recent_earthquakes, reached through the generic layer instead.
    checkData: data => Array.isArray(data?.earthquakes)
  }
];

/** @type {{name: string, ok: boolean, detail: string}[]} */
const steps = [];
let nextId = 1;

async function callMcp(method, params) {
  const response = await fetch(URL_ARG, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`回應不是有效 JSON（HTTP ${response.status}）：${text.slice(0, 500)}`);
  }
  return { status: response.status, body };
}

function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function run() {
  console.log(`Smoke testing ${URL_ARG}\n`);

  // 1. initialize
  let initBody;
  try {
    const { status, body } = await callMcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" }
    });
    initBody = body;
    const name = body?.result?.serverInfo?.name;
    record("initialize", status === 200 && !!name, `HTTP ${status}, serverInfo.name=${name ?? "<missing>"}`);
  } catch (error) {
    record("initialize", false, error instanceof Error ? error.message : String(error));
  }

  // 2. tools/list
  try {
    const { status, body } = await callMcp("tools/list", {});
    const tools = body?.result?.tools ?? [];
    const names = tools.map(t => t.name).sort();
    const expected = [...EXPECTED_TOOLS].sort();
    const matches = names.length === expected.length && names.every((n, i) => n === expected[i]);
    record("tools/list", status === 200 && matches, `found [${names.join(", ")}], expected [${expected.join(", ")}]`);
  } catch (error) {
    record("tools/list", false, error instanceof Error ? error.message : String(error));
  }

  // 3. one real call per tool
  for (const call of TOOL_CALLS) {
    try {
      const { status, body } = await callMcp("tools/call", { name: call.name, arguments: call.arguments });
      const result = body?.result;
      const isError = result?.isError === true;
      const structured = result?.structuredContent;
      const envelopeOk = structured?.ok === true;
      const dataOk = envelopeOk && call.checkData(structured.data);

      if (status !== 200) {
        record(call.name, false, `HTTP ${status}`);
      } else if (isError) {
        const message = result?.content?.[0]?.text ?? "(no message)";
        record(call.name, false, `tool returned isError: true — ${message}`);
      } else if (!envelopeOk) {
        record(call.name, false, `structuredContent.ok was not true: ${JSON.stringify(structured)}`);
      } else if (!dataOk) {
        record(call.name, false, `structuredContent.data failed shape check: ${JSON.stringify(structured.data)}`);
      } else {
        record(call.name, true, `source=${structured.source}, dataset=${structured.dataset}, cached=${structured.cached}`);
      }
    } catch (error) {
      record(call.name, false, error instanceof Error ? error.message : String(error));
    }
  }

  const allOk = steps.every(s => s.ok);
  const timestamp = new Date().toISOString();

  const summaryLines = [
    `# Smoke test ${allOk ? "passed" : "FAILED"}`,
    "",
    `URL: ${URL_ARG}`,
    `Time: ${timestamp}`,
    "",
    ...steps.map(s => `- ${s.ok ? "✅" : "❌"} **${s.name}**: ${s.detail}`)
  ];
  const summary = summaryLines.join("\n");

  console.log("\n" + summary);

  writeFileSync("smoke-test-result.json", JSON.stringify({ ok: allOk, url: URL_ARG, timestamp, steps, initBody }, null, 2));
  writeFileSync("smoke-test-summary.md", summary + "\n");

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `ok=${allOk}\nsummary-file=smoke-test-summary.md\n`, { flag: "a" });
  }

  process.exitCode = allOk ? 0 : 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
