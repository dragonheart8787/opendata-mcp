import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

import { recentEarthquakesInputShape, runRecentEarthquakes, formatRecentEarthquakesText } from "./tools/recent-earthquakes.js";
import { weatherForecastInputShape, runWeatherForecast, formatWeatherForecastText } from "./tools/weather-forecast.js";
import { CwaApiError } from "./services/cwa-client.js";

export interface Env {
  /** CWA Open Data Platform API key. Set via `wrangler secret put CWA_API_KEY`, never committed. */
  CWA_API_KEY?: string;
}

function errorText(error: unknown): string {
  if (error instanceof CwaApiError) {
    return error.message;
  }
  return `發生未預期的錯誤：${error instanceof Error ? error.message : String(error)}`;
}

function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "taiwan-opendata-mcp-server", version: "1.0.0" },
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
    async ({ city }) => {
      try {
        const result = await runWeatherForecast(city, env.CWA_API_KEY);
        return {
          content: [{ type: "text", text: formatWeatherForecastText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    "tw_recent_earthquakes",
    {
      title: "台灣近期顯著有感地震報告",
      description:
        "查詢中央氣象署（CWA）「顯著有感地震報告」（資料集 E-A0015-001），" +
        "回傳最近發生的顯著有感地震列表，包含地震編號、發生時間、規模、深度、震央位置、" +
        "各地最大震度與地震報告說明文字。\n\n" +
        "參數：\n" +
        "- limit：要回傳的地震報告筆數，1 到 10 之間，預設 3 筆，依時間新到舊排序。\n\n" +
        "適用情境：使用者詢問台灣最近有沒有地震、最近一次地震規模多大、哪裡震度最大。\n" +
        "不適用：歷史特定日期地震查詢、非顯著有感的小區域微震資料。",
      inputSchema: recentEarthquakesInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ limit }) => {
      try {
        const result = await runRecentEarthquakes(limit, env.CWA_API_KEY);
        return {
          content: [{ type: "text", text: formatRecentEarthquakesText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error) }], isError: true };
      }
    }
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
