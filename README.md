# opendata-mcp

台灣官方開放資料的統一 [MCP](https://modelcontextprotocol.io/)（Model Context Protocol）閘道——一句話問天氣、地震、空品、交通，Claude 直接幫你查。

**👉 [看視覺化介紹頁面](https://opendata-mcp.dragonheartliu1440.workers.dev/)**——比起先啃這份純文字 README，更快看懂這個專案在做什麼。

[English README](./README.en.md)

---

## 這是什麼？

台灣各機關（中央氣象署、環境部、交通部……）各自開放了不少資料，但每個平台的申請流程、認證方式、欄位命名慣例都不一樣，一般使用者不會想為了問一句「臺北市明天會不會下雨」去查 API 文件。

`opendata-mcp` 是一個部署在 Cloudflare Workers 上的 Remote MCP Server，把這些分散的官方 API 收斂成一組好用的工具。接上 Claude 之後，你可以直接問：

- 「臺北市明天天氣如何？」
- 「最近台灣有地震嗎？規模多大？」
- 「新北市現在空氣品質好嗎？」
- 「國道三號現在有沒有事故？」
- 「板橋車站台鐵現在有沒有誤點？」

不用自己申請 API 金鑰、不用記資料集代碼、不用處理「臺」跟「台」哪個才對——Claude 會呼叫這個服務即時查詢，並把官方回應整理成好讀的答案。

**目前規模**：9 個精選工具（涵蓋天氣、地震、颱風、空品、公車、YouBike、台鐵、捷運、國道事件）+ 2 個通用查詢工具，串接 4 個資料平台（中央氣象署、環境部、交通部運輸資料流通服務 TDX、交通部高速公路局），共登記 19 筆資料集——其中 8 筆屬於長尾資料集，沒有專屬工具，但一樣可以透過通用工具查到。詳細清單見下方「支援的工具總覽」。

你可以直接用我們提供的公開 demo 服務，也可以照著下面「自行部署」章節架設一份完全屬於自己的服務（免費，只需要 Cloudflare 帳號）。

---

## 快速開始

不需要寫任何程式碼，幾分鐘內就能把這個服務加進你自己的 Claude：

1. 打開 [claude.ai](https://claude.ai)
2. 左下角 **設定（Settings）** → **Connectors**
3. 點選 **Add custom connector**
4. 貼上以下網址：

   ```
   https://opendata-mcp.dragonheartliu1440.workers.dev/mcp
   ```

5. 儲存後回到對話視窗，直接問「臺北市明天天氣如何？」試試看

> ⚠️ **這是一個公開展示（demo）服務，僅供測試使用**，沒有登入機制、沒有專屬額度保證。流量較大時可能回應較慢或暫時不穩定，也可能因為共用的官方 API 額度被其他使用者用完而暫時查不到資料。若要長期、穩定地使用（尤其是要接 TDX 公車/YouBike/台鐵/捷運這幾個工具），強烈建議參考下面「自行部署」章節，架設一份屬於自己的服務——完全免費，用的是你自己申請的 API 金鑰與 Cloudflare 帳號額度。

---

## 接進其他 AI 平台

本服務基於標準 MCP 協議建置，不限於 Claude 使用，支援任何 MCP 相容的 AI 平台，包括 ChatGPT、Cursor、Windsurf、Cline 等。

### ChatGPT

**Settings → Apps & Connectors → Advanced settings → 開啟 Developer Mode** → 新增自訂連接器，填入伺服器網址（同上），驗證方式選擇「無」（本服務不需要任何驗證）。

⚠️ **已知差異**：ChatGPT 不會像 Claude 一樣主動判斷該不該呼叫外部工具，建議提問時明確提及要使用這個連接器，例如「請使用 OpenData MCP 查詢臺北市天氣」，而不是單純自然地問「臺北市天氣如何」——否則 ChatGPT 可能會用自己內建的知識或網路搜尋回答，不會主動想到查詢即時資料。

### Cursor / Windsurf / Cline

在 MCP servers 設定（通常是一個 JSON 設定檔）裡新增：

```json
{
  "opendata-mcp": {
    "url": "https://opendata-mcp.dragonheartliu1440.workers.dev/mcp"
  }
}
```

不需要額外的認證設定。

---

## 支援的工具總覽

### 精選工具（9 個，直接可用）

| 工具 | 用途 | 資料來源機關 | 更新頻率 |
| --- | --- | --- | --- |
| `tw_weather_forecast` | 指定縣市未來 36 小時天氣狀況、降雨機率、氣溫、舒適度指數 | 中央氣象署（F-C0032-001） | 每日數次 |
| `tw_recent_earthquakes` | 近期顯著有感地震報告：規模、深度、震央、各地最大震度 | 中央氣象署（E-A0015-001） | 地震發生時即時發布 |
| `tw_typhoon` | 目前活動中的颱風／熱帶氣旋消息與官方預測路徑 | 中央氣象署（W-C0034-005） | 有活動系統時每 6 小時更新 |
| `tw_air_quality` | 指定縣市或測站的即時 AQI、PM2.5、PM10、O3 | 環境部（aqx_p_432） | 每小時 |
| `tw_bus_eta` | 指定縣市／路線／站牌的公車動態預估到站時間 | 交通部運輸資料流通服務（TDX） | 動態即時（約 30 秒~1 分鐘） |
| `tw_youbike` | 指定縣市／站點的 YouBike 等公共自行車可借還數量 | 交通部運輸資料流通服務（TDX） | 批次更新（約 1-3 分鐘） |
| `tw_rail` | 指定台鐵車站即時到離站看板、誤點分鐘數 | 交通部運輸資料流通服務（TDX） | 動態即時（官方註明約 2 分鐘延遲） |
| `tw_metro_status` | 台北／高雄／桃園捷運目前營運狀態 | 交通部運輸資料流通服務（TDX） | 官方批次更新約 60 秒 |
| `tw_highway_traffic` | 全國國道（高速公路/快速道路）即時事故、施工、管制事件 | 交通部高速公路局 | 官方批次更新約 60 秒 |

> 💡 每個工具的完整參數說明、格式陷阱（例如「臺」不是「台」）、適用/不適用情境，Claude 呼叫工具前都看得到——工具本身的 description 就是最新的文件來源，這裡的表格只列摘要。

### 通用工具（2 個，涵蓋長尾資料集）

除了上面 9 個精選工具，本伺服器還登記了 **8 筆長尾資料集**（潮汐預報、氣象站觀測、天氣特報、紫外線指數每日最大值與即時值、颱風警報、空品預報、道路可變訊息標誌位置），這些資料集沒有專屬工具，但可以透過下面兩個通用工具查詢：

| 工具 | 用途 |
| --- | --- |
| `tw_search_datasets` | 用關鍵字（例如「潮汐」「紫外線」）搜尋本伺服器已登記的全部資料集，找出可用的 `datasetId` 與參數說明 |
| `tw_query_dataset` | 帶著 `tw_search_datasets` 查到的 `datasetId`，執行實際查詢——只接受已登記的 id，不接受任意網址，避免被當跳板打任意上游 API |

適用情境：想查的資料不在上面 9 個精選工具裡時，先用 `tw_search_datasets` 找找看，本伺服器可能已經登記了但還沒做成專屬工具。

---

## 自行部署

自行架設完全免費，大約 10-15 分鐘就能完成，不需要自己的伺服器。

### 前置需求：申請 API 金鑰

| 機關 | 用途 | 申請網址 | 是否必要 |
| --- | --- | --- | --- |
| 中央氣象署 | 天氣、地震、颱風 | [氣象資料開放平臺會員中心](https://opendata.cwa.gov.tw/user/authkey) → 註冊並申請授權碼（Authorization Key） | 必要（不然天氣/地震/颱風三個工具都無法使用） |
| 環境部 | 空氣品質 | [環境資料開放平臺](https://data.moenv.gov.tw/) → 註冊會員 → 會員專區取得 API KEY | 必要（不然空品工具無法使用） |
| 交通部 TDX | 公車、YouBike、台鐵、捷運 | [TDX 會員註冊](https://tdx.transportdata.tw/register) → 會員中心建立應用程式，取得 Client ID／Client Secret | 必要（不然公車/YouBike/台鐵/捷運四個工具都無法使用） |
| 交通部高速公路局 | 國道即時事件 | 不需要，完全公開下載 | **不需要金鑰** |

> 💡 都是免費申請。如果你只想先試用部分功能，可以只申請部分金鑰——沒設定金鑰的工具會回傳明確的錯誤訊息（附申請網址），不會讓整個服務掛掉，其他已設定金鑰的工具照常運作。

### 部署步驟

1. 把這個 repo Fork 到你自己的 GitHub 帳號
2. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Import an existing Git repository**，選擇你剛剛 Fork 的 repo，其餘設定保持預設即可，直接部署
3. 部署完成後，到這個 Worker 的設定頁：**Settings → Variables and Secrets**，新增以下 Secrets（用 Secret，不要用一般環境變數，避免金鑰外洩）：

   | Secret 名稱 | 值 |
   | --- | --- |
   | `CWA_API_KEY` | 中央氣象署申請到的授權碼 |
   | `MOENV_API_KEY` | 環境部平臺取得的 API KEY |
   | `TDX_CLIENT_ID` | TDX 應用程式的 Client ID |
   | `TDX_CLIENT_SECRET` | TDX 應用程式的 Client Secret |

4. **建立你自己的快取用 KV namespace**（強烈建議，可加快回應速度、大幅減少對官方 API 的重複呼叫）：
   - 在你的 repo 目錄執行 `npx wrangler kv namespace create CACHE`，指令會回傳一組 namespace id
   - 打開 `wrangler.toml`，把 `[[kv_namespaces]]` 區塊裡的 `id` 換成你剛拿到的 id（**不要沿用 repo 裡原本的 id**，那是本專案 demo 部署自己的 namespace），commit 並 push
   - 不想用快取的話，直接刪掉整個 `[[kv_namespaces]]` 區塊也可以，服務一樣能運作，只是每次查詢都會直接呼叫官方 API，也享受不到 TDX OAuth token 快取的好處
5. 之後只要你 push 更新到 `main` 分支，Cloudflare 就會自動重新部署，不需要手動操作

### 把自己的服務接進 Claude

部署完成後，你會拿到一個類似這樣的網址：

```
https://<你的-worker-名稱>.<你的-account>.workers.dev/mcp
```

照著上面「快速開始」的步驟 1–5，把這個網址加進 Claude 的 Connectors 即可，之後就是使用你自己架設、用你自己 API 額度的服務。

---

## 架構說明

程式碼分四層，每層職責單一，新增一個資料集的成本壓到最低（一筆 registry entry + 一個 transform 函式 + 一組測試）：

```
tools/     MCP 對外介面。精選工具很薄：驗證輸入 → registry 查詢 → 快取 → 包信封回傳
registry/  每個資料集一筆 entry：參數 schema、URL 組裝規則、轉換函式、快取 TTL、關鍵字
adapters/  每個資料來源一個模組：認證注入、逾時重試、上游回應信封拆解、缺值正規化
infra/     HTTP client（timeout/retry）、KV 快取、統一回應信封、錯誤碼定義
```

完整的分層規劃、設計原則（忠實轉載、來源顯名、fail-loud vs fail-soft）與介面定義，見 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)；實際程式碼遵守的規範與已驗證過的上游行為陷阱，見 [`AGENTS.md`](./AGENTS.md)。

---

## 品質保證

這個專案用三個 GitHub Actions workflow 做持續性的品質把關，設計成不依賴人工手動驗證，讓貢獻者可以放心送 PR：

| Workflow | 觸發時機 | 做什麼 |
| --- | --- | --- |
| [`ci.yml`](./.github/workflows/ci.yml) | 每個 PR | typecheck、跑全部單元測試（目前 333 個）、`wrangler deploy --dry-run` 確認建置成功。任一步驟失敗，PR 會顯示紅叉、不可合併。 |
| [`fixtures-refresh.yml`](./.github/workflows/fixtures-refresh.yml) | 每週一次（也可手動觸發） | 對每個已註冊資料集打一次真實 API，跟 `test/fixtures/` 裡的樣本做結構性比對（欄位、型別，不比對實際數值）。發現上游改格式，自動開一個標記 `schema-drift` 的 PR 更新 fixture 並開 issue 通知——在盲寫 fixture 猜錯格式的問題真正影響到使用者之前，先在自動化流程裡抓到。 |
| [`post-deploy-smoke-test.yml`](./.github/workflows/post-deploy-smoke-test.yml) | push 到 `main` 後（也可手動觸發） | 對正式部署的網址發送真實 MCP 請求：`initialize` → `tools/list`（確認所有工具都正確曝光）→ 依序真實呼叫其中幾個工具，確認回應信封格式正確。失敗會自動開一個標記 `smoke-test-failed` 的 issue。 |

三個 workflow 都能在 GitHub 網頁的 **Actions** 分頁手動觸發，不需要等排程或等下次部署。

---

## 資料來源與授權

本專案串接的資料，皆依[政府資料開放授權條款第 1 版](https://data.gov.tw/license)釋出：

- 天氣預報、地震報告、颱風消息：[中央氣象署開放資料平臺](https://opendata.cwa.gov.tw/)
- 空氣品質指標（AQI）：[環境部環境資料開放平臺](https://data.moenv.gov.tw/)
- 公車動態、YouBike、台鐵到離站看板、捷運營運狀態：[交通部運輸資料流通服務（TDX）](https://tdx.transportdata.tw/)
- 國道即時交通事件：[交通部高速公路局『交通資料庫』](https://tisvcloud.freeway.gov.tw/)

**免責聲明**：本專案僅為官方開放資料的轉載與整理工具，**不自行生成、推測或判斷任何預報、警報或路況內容**，也**不保證資料的即時性與準確性**（查詢結果依各資料集更新頻率有短時間快取，最多可能有數分鐘延遲）。防災、颱風、地震、空品惡化、道路封閉等相關警特報訊息，請務必以中央氣象署、環境部、交通部及所屬機關官方網站、官方 App 或其他官方管道公布之內容為準；本專案不提供任何形式的氣象預報、警特報發布或交通指揮服務，亦不承擔因使用本專案資料所產生之任何損失或責任。

---

## 貢獻指南

歡迎 PR！這個專案刻意設計成新增一個資料集的成本很低——一筆 registry entry + 一個 transform 函式 + 一份 fixture + 一組測試就能完成，不需要碰到既有工具的程式碼。

在動手之前，請先讀：

1. [`AGENTS.md`](./AGENTS.md)——分層架構的介面定義、工具描述五段式規範、測試要求、以及已經驗證過的上游行為陷阱（例如哪些機關的篩選參數不可信任、哪些資料集在雲端環境連不上）。這份文件是持續累積的工作規範，動工前先讀可以少走很多重複踩過的坑。
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)——完整架構規劃與設計原則。

送 PR 時請在描述裡列出：改動了哪些檔案（依分層歸類）、新增了哪些 registry entries、測試數量前後對比、以及任何與架構文件的偏離之處。有問題歡迎直接開 issue 討論。

---

## License

程式碼採用 [MIT License](./LICENSE) 授權，歡迎自由使用、修改與散布。

透過本專案取得的**資料本身**另依[政府資料開放授權條款第 1 版](https://data.gov.tw/license)釋出，授權範圍與程式碼分開，使用前請自行確認符合該授權條款的要求（主要是註明出處）。
