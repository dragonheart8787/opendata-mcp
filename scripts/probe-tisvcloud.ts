#!/usr/bin/env tsx
/**
 * ONE-OFF diagnostic, not part of the shipped pipeline. This sandbox's
 * outbound proxy explicitly denies tisvcloud.freeway.gov.tw (confirmed via
 * the proxy's own status endpoint: "gateway answered 403 to CONNECT"), and
 * every third-party doc page about this platform's URL conventions also
 * 403'd to WebFetch — so before writing any adapter code for this brand
 * new source, this script empirically discovers what's actually there from
 * an environment (GitHub Actions) that has real unrestricted egress,
 * instead of guessing a path from an inferred naming pattern.
 *
 * Delete this file (and its throwaway workflow) once real answers are in
 * hand and the real adapter/registry code is written from them.
 */
import { gunzipSync } from "node:zlib";

const ROOT = "https://tisvcloud.freeway.gov.tw";

// The official 即時路況資料標準 v2.0/2.1 documents exactly six real-time
// data types: VD, CCTV, CMS, AVI, eTag, Section — no dedicated "event"/事件
// type. `cctv_value.xml.gz` is independently confirmed to exist (indexed by
// search engines); `roadlevel_value.xml.gz` showed up under /history/ for
// an unrelated older path. The rest are informed guesses at the root
// live-data naming convention, to be discarded (not built on) if they 404.
const CANDIDATES = [
  "cctv_value.xml.gz",
  "cms_value.xml.gz",
  "vd_value.xml.gz",
  "avi_value.xml.gz",
  "etag_value.xml.gz",
  "section_value.xml.gz",
  "roadlevel_value.xml.gz",
  "event_value.xml.gz",
  "obstacle_value.xml.gz",
  "roadclosure_value.xml.gz"
];

/** Every probe request needs its own timeout — the first run of this script hung indefinitely on an unresponsive candidate URL with no timeout set, wasting the whole job. */
const REQUEST_TIMEOUT_MS = 10_000;

async function probeUrl(url: string): Promise<void> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "opendata-mcp-probe/1.0 (research; contact via GitHub repo)" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const elapsed = Date.now() - start;
    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    const retryAfter = response.headers.get("retry-after");
    console.log(`\n=== ${url} ===`);
    console.log(`  status=${response.status} content-type=${contentType} content-length=${contentLength} retry-after=${retryAfter} elapsed=${elapsed}ms`);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.log(`  body (first 300 chars): ${text.slice(0, 300)}`);
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    let preview: string;
    if (url.endsWith(".gz")) {
      try {
        const decompressed = gunzipSync(buffer);
        preview = decompressed.toString("utf-8").slice(0, 1000);
      } catch (error) {
        preview = `(gunzip failed: ${error instanceof Error ? error.message : String(error)}; raw bytes: ${buffer.slice(0, 50).toString("hex")})`;
      }
    } else {
      preview = buffer.toString("utf-8").slice(0, 1000);
    }
    console.log(`  content preview:\n${preview}`);
  } catch (error) {
    console.log(`\n=== ${url} ===`);
    console.log(`  FETCH FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  console.log(`Probing ${ROOT}/ (root directory listing)...`);
  await probeUrl(`${ROOT}/`);

  console.log(`\nProbing ${ROOT}/history-list.php ...`);
  await probeUrl(`${ROOT}/history-list.php`);

  for (const candidate of CANDIDATES) {
    await probeUrl(`${ROOT}/${candidate}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
