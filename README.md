# opendata-mcp

## 這是什麼？

`opendata-mcp` 是一個提供**台灣開放資料**的 Remote MCP Server。簡單說，它讓你可以直接在 Claude 對話裡問「臺北市明天天氣如何？」「最近台灣有地震嗎？」，不用自己打開中央氣象署網站查資料——Claude 會透過這個服務即時幫你查詢並整理成好讀的答案。

目前支援的資料集：

- 🌤️ **36 小時天氣預報**（中央氣象署 F-C0032-001）
- 🌏 **顯著有感地震報告**（中央氣象署 E-A0015-001）
- 💨 **即時空氣品質指標 AQI**（環境部 aqx_p_432，每小時更新）

你可以直接使用我們提供的公開服務，也可以自己架設一份（免費，只需要 Cloudflare 帳號）。

---

## 直接使用（不想自己架設？）

如果你只是想試用看看，不需要寫任何程式碼，照著下面步驟把它加到 Claude 就能用：

1. 打開 [claude.ai](https://claude.ai) → 左下角 **設定（Settings）** → **Customize** → **Connectors**
2. 點選 **Add custom connector**
3. 貼上以下網址：

   ```
   https://opendata-mcp.dragonheartliu1440.workers.dev/mcp
   ```

4. 儲存後，回到對話視窗，就可以直接問：

   - 「臺北市明天天氣如何？」
   - 「最近台灣有地震嗎？」
   - 「新北市現在空氣品質好嗎？」

> ⚠️ **提醒**：這是一個公開的展示（demo）服務，僅供測試使用。流量較大時可能會回應較慢或暫時不穩定。若要長期、穩定地使用，建議參考下面「自行部署」章節，架設一份屬於自己的服務。

---

## 自行部署（Cloudflare Workers）

自行架設完全免費，大約 10 分鐘就能完成，不需要自己的伺服器。

### 前置需求

- 一個 [Cloudflare](https://dash.cloudflare.com/sign-up) 帳號（免費即可）
- 一組**中央氣象署開放資料平臺**的會員帳號與 API 授權碼（免費申請）：
  👉 前往 [氣象資料開放平臺會員中心](https://opendata.cwa.gov.tw/user/authkey) 註冊並申請授權碼（Authorization Key）
- 一組**環境部環境資料開放平臺**的會員帳號與 API KEY（免費申請，空氣品質工具需要）：
  👉 前往 [環境資料開放平臺](https://data.moenv.gov.tw/) 註冊會員，再到會員專區取得 API KEY

### 部署步驟

1. 把這個 repo Fork 到你自己的 GitHub 帳號
2. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Import an existing Git repository**
3. 選擇你剛剛 Fork 的 repo，其餘設定保持預設即可，直接部署
4. 部署完成後，到這個 Worker 的設定頁：**Settings → Variables and Secrets** → 新增兩個 Secret
   - 名稱 `CWA_API_KEY`，值填入你在中央氣象署申請到的授權碼
   - 名稱 `MOENV_API_KEY`，值填入你在環境部平臺取得的 API KEY
   - **絕對不要**把這些金鑰寫在程式碼或 GitHub 上，一律用 Secret 的方式設定
5. **建立快取用的 KV namespace**（可加快回應速度、減少對官方 API 的呼叫次數）：
   - 在你的 repo 目錄執行 `npx wrangler kv namespace create CACHE`，指令會回傳一組 namespace id
   - 打開 `wrangler.toml`，把 `[[kv_namespaces]]` 區塊裡的 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 換成你剛拿到的 id，commit 並 push
   - 不想用快取的話，直接刪掉整個 `[[kv_namespaces]]` 區塊也可以，服務一樣能運作，只是每次查詢都會直接呼叫官方 API
6. 之後只要你 push 更新到 `main` 分支，Cloudflare 就會自動重新部署，不需要手動操作

### 把自己的服務接進 Claude

部署完成後，你會拿到一個類似這樣的網址：

```
https://<你的-worker-名稱>.<你的-account>.workers.dev/mcp
```

接著照著上面「直接使用」章節的步驟 1–4，把這個網址加進 Claude 的 Connectors 即可，之後就是使用你自己架設的服務。

---

## 已支援的工具

| 工具 | 用途 | 對應資料集 | 參數 |
| --- | --- | --- | --- |
| `tw_weather_forecast` | 查詢指定縣市未來 36 小時的天氣狀況、降雨機率、氣溫、舒適度 | [F-C0032-001](https://opendata.cwa.gov.tw/dataset/forecast/F-C0032-001) 三十六小時天氣預報 | `city`：台灣 22 縣市之一（需用「臺」而非「台」，例如「臺北市」） |
| `tw_recent_earthquakes` | 查詢近期顯著有感地震報告（規模、深度、震央、各地最大震度） | [E-A0015-001](https://opendata.cwa.gov.tw/dataset/earthquake/E-A0015-001) 顯著有感地震報告 | `limit`：要回傳幾筆地震報告，1–10 筆，預設 3 筆 |
| `tw_air_quality` | 查詢即時空氣品質：AQI、狀態等級、主要污染物、PM2.5、PM10、O3（每小時更新） | [aqx_p_432](https://data.moenv.gov.tw/dataset/detail/aqx_p_432) 空氣品質指標（AQI） | `county`（縣市）或 `siteName`（測站名稱，例如「板橋」）擇一必填 |

> 💡 `tw_recent_earthquakes` 只會回傳中央氣象署認定為「顯著有感」等級以上的地震。規模太小或有感範圍太小的地震不會出現在這個資料集裡，這不代表台灣完全沒有地震活動。
>
> 💡 `tw_air_quality` 只提供當前小時的即時觀測值，不涵蓋歷史資料，也不涵蓋空氣品質預報。

為減少對官方 API 的重複呼叫，查詢結果會依各資料集的更新頻率做短時間快取（天氣預報 30 分鐘、地震 5 分鐘、空氣品質 10 分鐘），因此資料最多可能有數分鐘的延遲。

---

## 資料來源與授權

本專案所提供的資料來源如下，皆依[政府資料開放授權條款第 1 版](https://data.gov.tw/license)釋出：

- 天氣預報、地震報告：[中央氣象署開放資料平臺](https://opendata.cwa.gov.tw/)
- 空氣品質指標（AQI）：[環境部環境資料開放平臺](https://data.moenv.gov.tw/)

**免責聲明**：本專案僅為官方開放資料的轉載與整理工具，**不保證資料的即時性與準確性**（查詢結果並有短時間快取）。防災、颱風、地震、空品惡化等相關警特報訊息，請務必以中央氣象署、環境部官方網站、官方 App 或其他官方管道公布之內容為準；本專案不提供任何形式的氣象預報或警特報發布服務，亦不承擔因使用本專案資料所產生之任何損失或責任。

---

## License

本專案採用 [MIT License](./LICENSE) 授權，歡迎自由使用、修改與散布。
