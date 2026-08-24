/**
 * `/robots.txt`, `/llms.txt` and `/sitemap.xml`, served by the Worker
 * (`index.ts`'s fetch handler). None of these existed before — every path
 * other than `/`, `/support.js`, `/health` and `/mcp` returned a bare 404.
 *
 * All three are built from the REQUEST's own origin rather than a baked-in
 * hostname. This project's README actively encourages self-hosting, so a
 * hard-coded `opendata-mcp.dragonheartliu1440.workers.dev` in a `Sitemap:`
 * line or an llms.txt link would send every self-hosted deployment's
 * crawlers to someone else's site. `new URL(request.url).origin` is correct
 * for the public demo and for every fork, with no configuration.
 */

/**
 * AI crawler user-agent tokens, each verified against the operator's OWN
 * documentation on 2026-08-24 (this sandbox's egress proxy blocks these
 * hosts, so the pages were fetched from GitHub Actions — the same
 * debug-probe discipline AGENTS.md §6 established). Not written from
 * memory: these names change, and a stale token silently means "no rule",
 * not "an error".
 *
 * Two categories, which matter differently to this project:
 *
 *   - Search/answer crawlers (`OAI-SearchBot`, `Claude-SearchBot`,
 *     `PerplexityBot`) decide whether this service can be cited when
 *     someone asks an assistant "is there an MCP server for Taiwan open
 *     data?". This is the whole point of the exercise, so they are allowed.
 *   - Training crawlers (`GPTBot`, `ClaudeBot`, `Google-Extended`) decide
 *     whether the content feeds future models. Also allowed: this repo is
 *     public, MIT-licensed, and being known to models is the same goal by a
 *     slower route.
 *
 * User-triggered fetchers (`ChatGPT-User`, `Claude-User`,
 * `Perplexity-User`) are listed for completeness. Note that both Perplexity
 * and Anthropic document these as acting on a specific user's request;
 * Perplexity's docs state outright that `Perplexity-User` "generally
 * ignores robots.txt rules". Allowing them is therefore a statement of
 * intent more than an enforced control — which is fine, because the intent
 * here is genuinely "yes, please read this".
 *
 * Sources (all primary):
 *   OpenAI      https://platform.openai.com/docs/bots
 *   Anthropic   https://support.anthropic.com/en/articles/8896518
 *   Perplexity  https://docs.perplexity.ai/guides/bots
 *   Google      https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
 */
export const AI_CRAWLER_USER_AGENTS = [
  // OpenAI
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  // Anthropic
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  // Perplexity
  "PerplexityBot",
  "Perplexity-User",
  // Google's Gemini training/grounding control token. Note this is a
  // robots.txt-only token: Google's docs state Google-Extended "doesn't have
  // a separate HTTP request user agent string", the crawl itself uses normal
  // Googlebot strings, so this line is purely a preference signal.
  "Google-Extended"
] as const;

// Deliberately NOT listed: Applebot-Extended, meta-externalagent, Bingbot's
// AI tokens and the various smaller crawlers. Their names are plausible from
// memory, and that is exactly the reason they are absent — only tokens read
// off the operator's own documentation in this session made the list. A
// misspelled token is not a harmless typo: robots.txt matches literally, so
// it silently becomes no rule at all while looking like a rule. The
// `User-agent: *` group above already grants them the same access, so
// nothing is actually blocked by leaving them out; adding them later is a
// one-line change once someone has checked the current spelling.

export function buildRobotsTxt(origin: string): string {
  const lines = [
    "# opendata-mcp — 台灣開放資料 MCP 閘道",
    "# https://github.com/dragonheart8787/opendata-mcp",
    "#",
    "# This is a public, MIT-licensed open-data gateway. Everything served",
    "# here is meant to be found, read and cited — by search engines and by",
    "# AI assistants alike. The only disallowed paths are the ones that are",
    "# not documents at all.",
    "",
    "User-agent: *",
    "Allow: /",
    // POST-only JSON-RPC. A crawler GETting it just receives a 405 error
    // envelope, which is noise in logs and useless as an indexed "page";
    // /health is a plain liveness string with no content value.
    "Disallow: /mcp",
    "Disallow: /health",
    ""
  ];

  lines.push("# AI crawlers — explicitly welcomed. See src/seo.ts for the");
  lines.push("# per-operator documentation each of these names came from.");
  for (const agent of AI_CRAWLER_USER_AGENTS) {
    lines.push("");
    lines.push(`User-agent: ${agent}`);
    lines.push("Allow: /");
    lines.push("Disallow: /mcp");
    lines.push("Disallow: /health");
  }

  lines.push("");
  lines.push(`Sitemap: ${origin}/sitemap.xml`);
  lines.push("");
  return lines.join("\n");
}

/**
 * `/llms.txt`, following the llms.txt proposal (llmstxt.org, v2 as modified
 * 2026-08-10, read directly from the spec page rather than from memory).
 *
 * The format the spec actually requires is small: an H1 with the site name
 * (the only required element), a blockquote with a short summary, optional
 * free-form detail, then `##` sections containing markdown link lists of the
 * form `- [Name](url): description`. The `## Optional` section has a defined
 * meaning — links an agent may skip when it needs a shorter context — so it
 * is used here for exactly that and not as a dumping ground.
 *
 * What this file deliberately does NOT do: restate the whole tool table.
 * The spec's model is that llms.txt stays small enough to sit in context and
 * the detail lives behind links. An MCP client that wants the authoritative,
 * always-current tool list should call `tools/list` — which is why that call
 * is spelled out here as a copy-pasteable command.
 */
export function buildLlmsTxt(origin: string, datasetCount: number): string {
  return `# opendata-mcp

> 台灣官方開放資料的統一 Remote MCP Server（Model Context Protocol）。把中央氣象署、環境部、交通部運輸資料流通服務（TDX）與交通部高速公路局四個平台的開放資料，收斂成一組可以用自然語言呼叫的工具——查天氣、地震、颱風、空氣品質、公車動態、YouBike、台鐵誤點、捷運營運狀態與國道即時事件，不需要申請 API 金鑰，也不需要知道資料集代碼。

這是一個部署在 Cloudflare Workers 上的無狀態遠端 MCP 伺服器。任何支援 MCP 的 client（Claude、ChatGPT、Cursor 等）都可以直接接上公開 demo，也可以自行部署一份（免費，只需要 Cloudflare 帳號）。程式碼採 MIT 授權，資料則依各來源機關的授權條款釋出。

- MCP endpoint: ${origin}/mcp （HTTP POST，JSON-RPC 2.0；GET 會回 405）
- 傳輸方式: Streamable HTTP，無狀態，不需要認證
- 目前登記 ${datasetCount} 筆資料集，其中一部分有專屬的精選工具，其餘透過通用工具查詢

## 工具

- [tw_weather_forecast](${origin}/#tools): 指定縣市未來 36 小時天氣狀況、降雨機率、氣溫、舒適度指數（中央氣象署 F-C0032-001）
- [tw_recent_earthquakes](${origin}/#tools): 近期顯著有感地震報告，含規模、深度、震央與各地最大震度（中央氣象署 E-A0015-001）
- [tw_typhoon](${origin}/#tools): 目前活動中的颱風／熱帶氣旋消息與官方預測路徑（中央氣象署 W-C0034-005）
- [tw_air_quality](${origin}/#tools): 指定縣市或測站的即時 AQI、PM2.5、PM10、O3（環境部 aqx_p_432）
- [tw_bus_eta](${origin}/#tools): 指定縣市／路線／站牌的公車預估到站時間（交通部 TDX）
- [tw_youbike](${origin}/#tools): 指定縣市／站點的 YouBike 等公共自行車可借還數量（交通部 TDX）
- [tw_rail](${origin}/#tools): 指定台鐵車站的即時到離站看板與誤點分鐘數（交通部 TDX）
- [tw_metro_status](${origin}/#tools): 台北／高雄／桃園捷運目前營運狀態（交通部 TDX）
- [tw_highway_traffic](${origin}/#tools): 全國國道即時事故、施工、管制事件（交通部高速公路局）
- [tw_search_datasets](${origin}/#tools): 以關鍵字搜尋本伺服器已登記的所有資料集，取得可用的 datasetId 與參數說明
- [tw_query_dataset](${origin}/#tools): 依 datasetId 查詢任一已登記資料集，涵蓋沒有專屬工具的長尾資料

每個工具的完整參數、格式陷阱與適用情境，都寫在工具自己的 description 裡。**權威且永遠最新的清單請直接呼叫 tools/list**，不要依賴這份文件的摘要：

\`\`\`
curl -s ${origin}/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

## 如何接入

- [接進 Claude](https://github.com/dragonheart8787/opendata-mcp#快速開始): 在 Claude 的 Connectors 設定裡新增自訂連接器，網址填 ${origin}/mcp
- [接進其他 AI 平台](https://github.com/dragonheart8787/opendata-mcp#接進其他-ai-平台): ChatGPT、Cursor、Windsurf、Cline 的設定方式
- [自行部署](https://github.com/dragonheart8787/opendata-mcp#自行部署): 申請各平台金鑰、設定 Cloudflare Workers secrets、部署步驟

## 資料來源與授權

- [中央氣象署開放資料平臺](https://opendata.cwa.gov.tw/): 天氣預報、地震報告、颱風消息、潮汐、紫外線、氣象站觀測
- [環境部環境資料開放平臺](https://data.moenv.gov.tw/): 空氣品質指標、空品預報、紫外線即時監測
- [交通部運輸資料流通服務 TDX](https://tdx.transportdata.tw/): 公車動態、YouBike、台鐵到離站看板、捷運營運狀態
- [交通部高速公路局『交通資料庫』](https://tisvcloud.freeway.gov.tw/): 國道即時交通事件
- [政府資料開放授權條款第 1 版](https://data.gov.tw/license): 上述四個來源的資料授權條款
- [MIT License](https://github.com/dragonheart8787/opendata-mcp/blob/main/LICENSE): 本專案程式碼的授權條款（與資料授權分開）

本服務僅轉載與整理官方開放資料，不自行生成、推測或判斷任何預報或警報內容。防災、颱風、地震、空品惡化、道路封閉等警特報訊息，請以各主管機關官方管道公布的內容為準。

## Optional

- [README](https://github.com/dragonheart8787/opendata-mcp#readme): 完整的中文說明文件
- [English README](https://github.com/dragonheart8787/opendata-mcp/blob/main/README.en.md): 英文版說明
- [ARCHITECTURE.md](https://github.com/dragonheart8787/opendata-mcp/blob/main/docs/ARCHITECTURE.md): 分層架構規劃書（tools / registry / adapters / infra）
- [AGENTS.md](https://github.com/dragonheart8787/opendata-mcp/blob/main/AGENTS.md): 開發規範與各上游 API 的已知行為紀錄
- [隱私權政策](https://github.com/dragonheart8787/opendata-mcp#隱私權政策privacy-policy): 本服務蒐集與不蒐集哪些資料
`;
}

/**
 * A three-URL sitemap. Small on purpose: this is a single-page site plus two
 * machine-readable documents, and listing `/mcp` (POST-only) or `/health`
 * (a liveness string) would be advertising non-documents as pages.
 */
export function buildSitemapXml(origin: string, lastModified: string): string {
  const urls = [
    { loc: `${origin}/`, priority: "1.0", changefreq: "weekly" },
    { loc: `${origin}/llms.txt`, priority: "0.8", changefreq: "weekly" },
    { loc: `${origin}/robots.txt`, priority: "0.3", changefreq: "monthly" }
  ];
  const body = urls
    .map(
      u =>
        `  <url>\n` +
        `    <loc>${u.loc}</loc>\n` +
        `    <lastmod>${lastModified}</lastmod>\n` +
        `    <changefreq>${u.changefreq}</changefreq>\n` +
        `    <priority>${u.priority}</priority>\n` +
        `  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
