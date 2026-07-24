#!/usr/bin/env node
/**
 * TEMPORARY diagnostic script — paired with the `x-debug-timing` header
 * support added to src/index.ts (PR #89). Sends real `tools/call` requests
 * for tw_highway_traffic straight to the deployed production /mcp endpoint
 * (must run from an environment with real network access — the Claude Code
 * sandbox this investigation runs in is blocked from reaching
 * *.workers.dev by its egress proxy, same reason scripts/smoke-test.mjs
 * runs from GitHub Actions instead of locally) and prints each call's
 * `_debugTiming` breakdown, to find out whether a genuinely-reproducible
 * 5x timeout traces to the MCP protocol layer (schema validation, connect,
 * response serialization) or the tool's own business logic.
 *
 * Deliberately dependency-free plain Node, run via workflow_dispatch from
 * .github/workflows/debug-highway-timing.yml — not part of the regular CI
 * or post-deploy pipeline. Delete both files once the investigation
 * concludes.
 */
const URL_ARG = process.env.SMOKE_TEST_URL || "https://opendata-mcp.dragonheartliu1440.workers.dev/mcp";
const CALLS = Number(process.env.DEBUG_TIMING_CALLS || "5");

let nextId = 1;

async function callHighway(road) {
  const started = Date.now();
  try {
    const response = await fetch(URL_ARG, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-debug-timing": "1"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: "tw_highway_traffic", arguments: road ? { road } : {} }
      })
    });
    const text = await response.text();
    const clientElapsedMs = Date.now() - started;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, clientElapsedMs, httpStatus: response.status, error: `non-JSON body: ${text.slice(0, 300)}` };
    }
    return {
      ok: true,
      clientElapsedMs,
      httpStatus: response.status,
      isError: body?.result?.isError ?? null,
      debugTiming: body?._debugTiming ?? null
    };
  } catch (error) {
    return { ok: false, clientElapsedMs: Date.now() - started, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

async function run() {
  console.log(`Sending ${CALLS} real tools/call requests to ${URL_ARG} for tw_highway_traffic\n`);
  const results = [];
  for (let i = 1; i <= CALLS; i++) {
    const result = await callHighway();
    results.push(result);
    console.log(`--- call ${i} ---`);
    console.log(JSON.stringify(result, null, 2));
  }

  const summaryLines = ["# tw_highway_traffic MCP-layer timing", "", `URL: ${URL_ARG}`, `Calls: ${CALLS}`, ""];
  results.forEach((r, i) => {
    summaryLines.push(`## Call ${i + 1}`);
    summaryLines.push("```json");
    summaryLines.push(JSON.stringify(r, null, 2));
    summaryLines.push("```");
    summaryLines.push("");
  });
  const summary = summaryLines.join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }

  const timeouts = results.filter(r => !r.ok || r.isError === true).length;
  console.log(`\n${timeouts}/${CALLS} calls failed or timed out.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
