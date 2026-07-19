# opendata-mcp

一個開源的**台灣開放資料 Remote MCP Server**，讓 Claude（或任何支援 [MCP](https://modelcontextprotocol.io) 的用戶端）可以即時查詢台灣中央氣象署（CWA）的天氣預報與地震資訊。

- 使用官方 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)（TypeScript）
- Transport 採用 **stateless Streamable HTTP**（無 session 狀態，每個請求獨立處理，適合部署在 serverless 環境）
- 部署目標為 **Cloudflare Workers**（透過 Git 整合自動部署，push 到 `main` 即上線）
- 資料來源為 [中央氣象署開放資料平臺](https://opendata.cwa.gov.tw/)

## 提供的工具（Tools）

| 工具名稱 | 說明 | 資料集 |
| --- | --- | --- |
| `tw_weather_forecast` | 查詢指定縣市的 36 小時天氣預報（天氣狀況、降雨機率、氣溫、舒適度） | [F-C0032-001](https://opendata.cwa.gov.tw/dataset/forecast/F-C0032-001) |
| `tw_recent_earthquakes` | 查詢近期顯著有感地震報告（規模、深度、震央、各地最大震度） | [E-A0015-001](https://opendata.cwa.gov.tw/dataset/earthquake/E-A0015-001) |

兩個工具都：

- 用 [Zod](https://zod.dev/) 定義輸入參數並在執行前驗證
- 只回傳篩選過的精簡結構化資料（`structuredContent`），不會把 CWA 原始 JSON 整包丟給模型
- 金鑰無效、缺少金鑰、找不到資料等情況都會回傳**可行動的錯誤訊息**（附上申請金鑰的網址）

> **注意**：`tw_weather_forecast` 的 `city` 參數使用中央氣象署官方縣市名稱，用字是「**臺**」而非「台」（例如「臺北市」「臺中市」「臺東縣」），共 22 縣市。

## 專案結構

```
src/
├── index.ts                    # Cloudflare Workers fetch handler + MCP server 註冊
├── constants.ts                 # API 網址、22 縣市清單
├── types.ts                     # CWA API 原始回應型別
├── services/cwa-client.ts       # 共用的 CWA API 呼叫與錯誤處理
└── tools/
    ├── weather-forecast.ts      # tw_weather_forecast 的邏輯與資料篩選
    └── recent-earthquakes.ts    # tw_recent_earthquakes 的邏輯與資料篩選
test/
├── fixtures/                    # 依照 CWA 官方文件範例建立的假資料（無需真實金鑰即可測試）
└── *.test.ts
```

## 自行部署（Cloudflare Workers）

### 1. 申請 CWA API 金鑰

至 [氣象資料開放平臺會員中心](https://opendata.cwa.gov.tw/user/authkey) 註冊帳號並申請免費的授權碼（Authorization Key）。

### 2. Fork / Clone 這個 repo，連接 Cloudflare Workers 的 Git 整合

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Import an existing Git repository**
2. 選擇這個 repo，Build 設定使用預設值即可（`wrangler.toml` 已包含 `main = "src/index.ts"`）
3. 之後每次 push 到 `main` 分支都會自動觸發部署

### 3. 設定 API 金鑰（Workers Secret）

**絕對不要**把金鑰寫進 repo。改用 Cloudflare 的 secret 機制：

```bash
npx wrangler login
npx wrangler secret put CWA_API_KEY
# 依提示貼上你申請到的金鑰
```

或在 Cloudflare Dashboard 的 Worker 設定頁 → **Settings → Variables and Secrets** 新增 `CWA_API_KEY`（類型選 Secret）。

### 4. （可選）手動部署

若不想透過 Git 整合，也可以本機手動部署：

```bash
npm install
npx wrangler login
npx wrangler secret put CWA_API_KEY
npm run deploy
```

部署完成後，MCP endpoint 會是：

```
https://<你的-worker-名稱>.<你的-account>.workers.dev/mcp
```

## 本機開發

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入你的 CWA_API_KEY（.dev.vars 已被 .gitignore 排除）
npm run dev                      # 啟動本機 wrangler dev server
```

### 執行測試

單元測試使用依照 CWA 官方文件回應格式建立的 fixtures，**不需要真實 API 金鑰**即可執行：

```bash
npm test          # 執行一次
npm run test:watch
npm run typecheck  # TypeScript 型別檢查
```

## 在 Claude 中加入這個 Connector

部署完成後，把它加到 Claude 作為一個 remote MCP connector：

### Claude.ai（網頁版 / 桌面版）

1. 前往 **設定 → Connectors → Add custom connector**
2. 貼上你的 Worker URL，記得加上 `/mcp` 路徑：`https://<your-worker>.workers.dev/mcp`
3. 儲存後即可在對話中啟用「台灣開放資料」工具

### Claude Code

在專案根目錄的 MCP 設定中加入（或用 `claude mcp add` 指令）：

```json
{
  "mcpServers": {
    "taiwan-opendata": {
      "type": "http",
      "url": "https://<your-worker>.workers.dev/mcp"
    }
  }
}
```

加入後即可在對話中直接問「臺北市今明兩天天氣如何？」或「最近台灣有地震嗎？」。

## 技術細節

- **為什麼是 stateless？** 這個 server 對每個 HTTP 請求建立一個全新的 `McpServer` 與 `WebStandardStreamableHTTPServerTransport`（`sessionIdGenerator: undefined`），不保留任何跨請求的 session 狀態，符合 serverless / 多節點部署的最佳實務。
- **為什麼用 `WebStandardStreamableHTTPServerTransport`？** 這是 MCP TypeScript SDK 中基於 Web Standards（`Request`/`Response`）實作的 transport，可直接對應 Cloudflare Workers 的 `fetch(request, env)` handler，不需要 Express 或任何 Node.js-only 的相容層。
- **JSON Schema 驗證**：改用 `CfWorkerJsonSchemaValidator`（`@cfworker/json-schema`）取代預設的 AJV，因為 AJV 在驗證時會用 `new Function()` 產生程式碼，這在 Cloudflare Workers 的執行環境中可能受限；`@cfworker/json-schema` 是專為 edge runtime 設計、不需要動態程式碼產生的實作。

## 授權

[MIT](./LICENSE)
