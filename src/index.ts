import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

import type { CacheStore } from "./infra/cache.js";
import { airQualityInputShape, handleAirQualityTool } from "./tools/air-quality.js";
import { handleRecentEarthquakesTool, recentEarthquakesInputShape } from "./tools/earthquake.js";
import { handleQueryDatasetTool, handleSearchDatasetsTool, queryDatasetInputShape, searchDatasetsInputShape } from "./tools/generic.js";
import { handleTyphoonTool, typhoonNewsInputShape } from "./tools/typhoon.js";
import { handleWeatherForecastTool, weatherForecastInputShape } from "./tools/weather.js";

export interface Env {
  /** CWA Open Data Platform API key. Set via `wrangler secret put CWA_API_KEY`, never committed. */
  CWA_API_KEY?: string;
  /** MOENV open data platform API key. Set via `wrangler secret put MOENV_API_KEY`, never committed. */
  MOENV_API_KEY?: string;
  /** TDX (交通部運輸資料流通服務) OAuth2 client id. Set via `wrangler secret put TDX_CLIENT_ID`, never committed. */
  TDX_CLIENT_ID?: string;
  /** TDX OAuth2 client secret, paired with TDX_CLIENT_ID. Set via `wrangler secret put TDX_CLIENT_SECRET`, never committed. */
  TDX_CLIENT_SECRET?: string;
  /**
   * Cloudflare KV namespace used as a short-TTL response cache (binding name
   * `CACHE` in wrangler.toml). Optional — tools work without it, every call
   * just hits the upstream API directly. Also used by `adapters/tdx.ts` to
   * cache the OAuth2 access token (key `tdx:access_token`) — same store,
   * different key namespace, no dedicated binding needed.
   */
  CACHE?: CacheStore;
}

function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "taiwan-opendata-mcp-server", version: "1.2.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
  );

  server.registerTool(
    "tw_weather_forecast",
    {
      title: "台灣 36 小時天氣預報",
      description:
        "查詢中央氣象署（CWA）「今明 36 小時天氣預報」（資料集 F-C0032-001），" +
        "回傳指定縣市未來三個時段（每時段 12 小時）的天氣狀況、降雨機率、最高/最低氣溫與舒適度指數。\n\n" +
        "參數：\n" +
        "- city：台灣 22 縣市之一，須用中央氣象署標準全形字（例如「臺北市」而非「台北市」）。\n\n" +
        "適用情境：使用者詢問台灣某縣市今明兩天的天氣、會不會下雨、氣溫如何。\n" +
        "不適用：鄉鎮層級預報、逐週天氣趨勢、非台灣地區天氣。",
      inputSchema: weatherForecastInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    ({ city }) => handleWeatherForecastTool({ city }, env)
  );

  server.registerTool(
    "tw_recent_earthquakes",
    {
      title: "台灣近期顯著有感地震報告",
      description:
        "查詢中央氣象署（CWA）「顯著有感地震報告」（資料集 E-A0015-001），" +
        "回傳最近發生的顯著有感地震列表，包含地震編號、發生時間、規模、深度、震央位置、" +
        "各地最大震度、地震報告說明文字，以及報告本身的發布時間與有效期間。\n\n" +
        "時間欄位說明（三者意義不同，勿混用）：\n" +
        "- originTime：地震「發生」的時間。\n" +
        "- issuedAt：中央氣象署「發布」這份地震報告的時間，可能比 originTime 晚幾分鐘；部分報告可能沒有此欄位。\n" +
        "- validUntil：這份報告的有效期間結束時間，超過此時間後可能已有後續更新或最終報告取代；部分報告可能沒有此欄位。\n\n" +
        "重要限制：僅涵蓋中央氣象署認定為「顯著有感」等級以上之地震，規模過小或有感範圍過小的地震可能未收錄於此資料集。" +
        "若回傳結果很少或找不到符合的地震，不代表台灣近期完全沒有地震活動，只代表沒有達到顯著有感門檻的地震。\n\n" +
        "參數：\n" +
        "- limit：要回傳的地震報告筆數，1 到 10 之間，預設 3 筆，依時間新到舊排序。\n\n" +
        "適用情境：使用者詢問台灣最近有沒有地震、最近一次地震規模多大、哪裡震度最大、這份地震報告是什麼時候發布的。\n" +
        "不適用：歷史特定日期地震查詢、非顯著有感的小區域微震資料（此工具本來就查不到這類資料）。",
      inputSchema: recentEarthquakesInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    ({ limit }) => handleRecentEarthquakesTool({ limit }, env)
  );

  server.registerTool(
    "tw_typhoon",
    {
      title: "台灣颱風消息（轉載中央氣象署）",
      description:
        "查詢中央氣象署（CWA）「颱風消息」（資料集 W-C0034-005），" +
        "轉載中央氣象署目前發布的西北太平洋與南海活動熱帶氣旋資訊，包含名稱、中央氣象署編號、" +
        "是否目前有生效中的活動熱帶氣旋、最近一次分析位置（發布/分析時間、經緯度、風速、陣風、氣壓），" +
        "以及中央氣象署自己發布的未來路徑預測點（若有）。回應中的 issuedAt 為各系統最近一次分析時間中" +
        "最新者，代表這份轉載內容的發布時間。本工具僅逐字轉載官方已發布內容，不做任何路徑推算、強度判斷" +
        "或登陸機率預測。\n\n" +
        "參數：無。\n\n" +
        "適用情境：使用者詢問「現在有沒有颱風」「颱風動態如何」「颱風路徑預測」「颱風叫什麼名字」。\n" +
        "不適用：本工具不做颱風路徑分析、強度預測或登陸機率判斷，僅轉載官方公告；若使用者需要" +
        "「哪些縣市目前有生效中的颱風警報」，請改用 tw_query_dataset 查詢 cwa:W-C0034-001（颱風警報，" +
        "含各縣市警戒範圍與正式警報文字）。\n\n" +
        "資料範圍限制：涵蓋整個西北太平洋與南海所有活動中的熱帶氣旋，包含尚未達颱風強度、" +
        "尚未命名的「熱帶性低氣壓」，不代表這些系統一定會侵襲台灣；查無資料代表該區域目前沒有" +
        "中央氣象署列管中的熱帶氣旋系統，不代表資料異常。",
      inputSchema: typhoonNewsInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    () => handleTyphoonTool(env)
  );

  server.registerTool(
    "tw_air_quality",
    {
      title: "台灣即時空氣品質（AQI）",
      description:
        "查詢環境部「空氣品質指標（AQI）」即時測站資料（資料集 aqx_p_432，每小時更新），" +
        "回傳指定縣市或測站的 AQI 數值、狀態等級（良好／普通／對敏感族群不健康／對所有族群不健康／非常不健康／危害）、" +
        "主要污染物、PM2.5、PM10、O3 濃度與資料發布時間。\n\n" +
        "參數（兩者擇一必填）：\n" +
        "- county：縣市名稱，回傳該縣市所有測站；須用「臺」而非「台」（例如「臺北市」）。\n" +
        "- siteName：單一測站名稱（例如「板橋」「西屯」「美濃」，不含「站」字）。\n\n" +
        "適用情境：使用者詢問某地現在空氣品質好不好、AQI 多少、PM2.5 濃度、今天適不適合戶外運動。\n" +
        "不適用：歷史空品資料查詢、未來空氣品質預報（此資料集僅有當前小時的即時觀測值，" +
        "不涵蓋歷史紀錄也不涵蓋預報值）。",
      inputSchema: airQualityInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    ({ county, siteName }) => handleAirQualityTool({ county, siteName }, env)
  );

  server.registerTool(
    "tw_search_datasets",
    {
      title: "搜尋本伺服器已登記的資料集",
      description:
        "在本伺服器已登記（registry）的資料集清單中做關鍵字搜尋，協助找出可用的 datasetId 與其查詢參數，" +
        "**只搜尋本伺服器已收錄的資料集，不是搜尋整個政府開放資料平台**。\n\n" +
        "參數：\n" +
        "- query：搜尋關鍵字，比對資料集標題與關鍵字標籤（例如「地震」「空氣品質」「溫度」）。\n" +
        "- source：選填，只搜尋特定機關（cwa＝中央氣象署，moenv＝環境部，tdx＝交通部運輸資料流通服務），不填則搜尋所有機關。\n\n" +
        "適用情境：不確定要用哪個精選工具查某項資料、或想知道除了 tw_weather_forecast／tw_recent_earthquakes／" +
        "tw_air_quality 之外還有哪些資料集可以透過 tw_query_dataset 查詢時。\n" +
        "不適用：查詢資料集的實際內容（找到 datasetId 後請改用 tw_query_dataset）。\n\n" +
        "資料範圍限制：只涵蓋本伺服器 registry 已登記的資料集，搜尋不到不代表該資料在政府開放資料平台上不存在，" +
        "只代表本伺服器尚未收錄；registry 內容會隨伺服器擴充而增加。",
      inputSchema: searchDatasetsInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    ({ query, source }) => handleSearchDatasetsTool({ query, source })
  );

  server.registerTool(
    "tw_query_dataset",
    {
      title: "依 datasetId 查詢已登記資料集",
      description:
        "依 tw_search_datasets 查到的 datasetId，執行該資料集的實際查詢並回傳結果——等同直接呼叫該資料集" +
        "對應的精選工具（若有的話），走一樣的快取與錯誤處理流程。\n\n" +
        "參數：\n" +
        "- datasetId：必填，須為已註冊的資料集 id（例如「cwa:E-A0015-001」），只接受本伺服器 registry 內" +
        "已知的 id，**不接受任意路徑或網址**——這是安全邊界，防止被當作跳板打任意上游 API。\n" +
        "- params：該資料集要求的查詢參數，依資料集而不同（例如地震資料集要 limit，空品資料集要 county 或 " +
        "siteName），可先用 tw_search_datasets 查詢每個資料集接受哪些參數。\n\n" +
        "適用情境：已經知道 datasetId、想用通用方式查詢任何已登記資料集時；或未來新增進 registry 但還沒有" +
        "專屬精選工具的長尾資料集。\n" +
        "不適用：不知道 datasetId 時（請先用 tw_search_datasets 查詢）。\n\n" +
        "資料範圍限制：只能查詢已登記進 registry 的資料集；datasetId 不存在時會回傳明確錯誤，並提示改用 " +
        "tw_search_datasets 查詢目前可用的資料集清單。",
      inputSchema: queryDatasetInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    ({ datasetId, params }) => handleQueryDatasetTool({ datasetId, params }, env)
  );

  return server;
}

const JSON_RPC_METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0" as const,
  error: { code: -32000, message: "Method not allowed. This is a stateless server; only POST /mcp is supported." },
  id: null
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Taiwan OpenData MCP Server is running. Send MCP requests to POST /mcp.\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify(JSON_RPC_METHOD_NOT_ALLOWED), {
        status: 405,
        headers: { "content-type": "application/json" }
      });
    }

    // Stateless mode: a fresh McpServer + transport per request, per the SDK's
    // own guidance ("Create a new transport per request" for stateless servers).
    const server = createServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    } finally {
      await transport.close();
      await server.close();
    }
  }
};
