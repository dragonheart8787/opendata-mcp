import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

import type { CacheStore } from "./infra/cache.js";
import { airQualityInputShape, handleAirQualityTool } from "./tools/air-quality.js";
import { handleRecentEarthquakesTool, recentEarthquakesInputShape } from "./tools/earthquake.js";
import { handleWeatherForecastTool, weatherForecastInputShape } from "./tools/weather.js";

export interface Env {
  /** CWA Open Data Platform API key. Set via `wrangler secret put CWA_API_KEY`, never committed. */
  CWA_API_KEY?: string;
  /** MOENV open data platform API key. Set via `wrangler secret put MOENV_API_KEY`, never committed. */
  MOENV_API_KEY?: string;
  /**
   * Cloudflare KV namespace used as a short-TTL response cache (binding name
   * `CACHE` in wrangler.toml). Optional — tools work without it, every call
   * just hits the upstream API directly.
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
