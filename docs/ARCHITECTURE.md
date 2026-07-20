# Taiwan Open Data MCP — 完整架構規劃書

> 本文件是 `opendata-mcp` 從「三個工具的小專案」擴展為「台灣開放資料統一 MCP 閘道」的權威規劃。
> 所有 Claude Code session 開工前都應先讀本文件與 `AGENTS.md`。文件內容與程式碼不一致時，以本文件的架構原則為準，細節以程式碼為準。

---

## 0. 專案定位

**一句話**：讓任何 Claude 使用者（或其他 MCP client）用自然語言查詢台灣的官方開放資料——天氣、地震、空品、交通、水情——不需要知道任何 API 細節。

**設計原則（不可妥協）**
1. **忠實轉載**：只回傳官方資料的整理版，絕不生成、修改、推測任何預報或警報內容（氣象法紅線）
2. **來源顯名**：每個回應都附資料來源機關與資料集編號（政府資料開放授權條款要求）
3. **金鑰隔離**：所有金鑰只存在 Cloudflare Secrets，repo 中永不出現
4. **Fail-soft 基礎設施**：快取、監控等輔助設施故障時直接 fallback 打上游，不阻斷查詢
5. **Fail-loud 資料**：上游回應格式對不上預期時明確報錯，不吞錯、不回傳可能錯誤的資料
6. **Context 節約**：工具數量與回應長度都有預算上限，寧可精不可多

**非目標（明確不做）**
- 不做歷史大數據倉儲或資料分析平台（只做即時/近期查詢閘道）
- 不做自己的預測、解讀、建議（「明天適合出門嗎」這類判斷留給 client 端的 LLM 自己組合）
- 不追求資料集接入數量；衡量標準是「使用者真實問題的覆蓋率」

---

## 1. 資料來源盤點

| 來源 | 平台 | 認證方式 | Secret 名稱 | 狀態 |
|---|---|---|---|---|
| 中央氣象署 CWA | opendata.cwa.gov.tw | query/header `Authorization` | `CWA_API_KEY` | ✅ 已接 |
| 環境部 MOENV | data.moenv.gov.tw | query `api_key` | `MOENV_API_KEY` | ✅ 已接 |
| 交通部 TDX | tdx.transportdata.tw | OAuth2 client credentials | `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` | 🔜 Phase 3 |
| 水利署 WRA | data.gov.tw 轉介 / 防災資訊服務網 | 多數免金鑰 | — | 🔜 Phase 4 |
| 其他（農業部價格、衛福部藥局等） | data.gov.tw | 各異 | — | Backlog |

**每個來源的已知地雷**
- CWA：縣市名稱必須用「臺」；部分資料集（鄉鎮預報 F-D0047-*）是每縣市一個代碼，需要對照表
- MOENV：缺值標記混亂（`""` / `"-"` / `"ND"`），已在 adapter 統一正規化為 `null`；欄位名稱歷史上改過大小寫，fixtures 過期風險高
- TDX：OAuth token 有效期約 1 天，必須在 Worker 內做 token 快取（KV），且免費方案有流量限制，快取是必要不是加分
- 資料集代碼未經實測前一律標記「待確認」，session 內必須先打官方 swagger/文件驗證，不可憑記憶寫死

---

## 2. 分層架構

```
┌─────────────────────────────────────────────┐
│  Tool 層（MCP 對外介面）                      │
│  精選工具 ≤15 個 + 通用工具 2 個              │
├─────────────────────────────────────────────┤
│  Registry 層（資料集註冊表）                  │
│  每個資料集一筆 entry：參數 schema、轉換函式、 │
│  快取 TTL、關鍵字、來源標示                    │
├─────────────────────────────────────────────┤
│  Adapter 層（每個資料來源一個模組）            │
│  認證注入、URL 組裝、錯誤正規化、缺值正規化      │
├─────────────────────────────────────────────┤
│  Infra 層                                    │
│  HTTP client（timeout/retry）、KV 快取、        │
│  回應信封、日誌                               │
└─────────────────────────────────────────────┘
```

### 2.1 目錄結構（目標狀態）

```
src/
  index.ts              # Worker 進入點、MCP server 組裝、路由
  tools/                # Tool 層：每個精選工具一個檔案
    weather.ts
    earthquake.ts
    air-quality.ts
    generic.ts          # tw_search_datasets + tw_query_dataset
  registry/
    index.ts            # Registry 型別定義與查詢函式
    cwa.ts               # CWA 資料集 entries
    moenv.ts             # MOENV 資料集 entries
    tdx.ts               # TDX 資料集 entries
  adapters/
    types.ts             # SourceAdapter 介面
    cwa.ts
    moenv.ts
    tdx.ts               # 含 OAuth token 快取邏輯
  infra/
    http.ts              # fetch 包裝：timeout 5s、單次 retry、UA 標頭
    cache.ts              # KV 快取（best-effort、錯誤不快取）
    envelope.ts            # 統一回應信封
    errors.ts               # ToolError 型別與 error code 常數
fixtures/               # 各資料集真實回應樣本（去敏後）
  cwa/F-C0032-001.json
  moenv/aqx_p_432.json
  ...
scripts/
  gen-tools-doc.ts      # 從 registry 自動生成 README 工具表
test/
docs/
  ARCHITECTURE.md       # 本文件
  adr/                  # 重大決策記錄（ADR-001 起編號）
AGENTS.md               # 給 Claude Code 的工作規範
```

### 2.2 核心介面（TypeScript 草案）

```ts
// adapters/types.ts
export interface SourceAdapter {
  id: "cwa" | "moenv" | "tdx" | "wra";
  displayName: string;            // 「中央氣象署」等，用於來源標示
  fetchDataset(
    entry: DatasetEntry,
    params: Record<string, unknown>,
    env: Env,
  ): Promise<unknown>;            // 已完成認證、逾時、缺值正規化的原始 JSON
}

// registry/index.ts
export interface DatasetEntry {
  id: string;                     // "cwa:F-C0032-001"
  source: SourceAdapter["id"];
  path: string;                   // API 路徑或資料集代碼
  title: string;                  // 「今明 36 小時天氣預報」
  keywords: string[];             // 供 tw_search_datasets 檢索
  paramsSchema: z.ZodTypeAny;     // 允許的查詢參數（allowlist）
  transform(raw: unknown): unknown; // 精簡化：過濾欄位、限制筆數
  cacheTtlSeconds: number;
  updateFrequency: string;        // 「每小時」等，寫進回應供 LLM 判斷新鮮度
  docUrl: string;
  notes?: string;                 // 例如「僅涵蓋顯著有感等級以上地震」
}
```

**精選工具的實作因此變得非常薄**：驗證輸入 → `registry.get(id)` → `cachedFetch(entry, params)` → `transform` → 包信封回傳。新增一個資料集的成本 = registry 加一筆 + 一個 transform 函式 + 一份 fixture + 一組測試。

### 2.3 統一回應信封

```jsonc
// 成功
{
  "ok": true,
  "source": "中央氣象署",
  "dataset": "F-C0032-001",
  "issuedAt": "2026-07-20T05:00:00+08:00",   // 官方發布時間（有才附）
  "fetchedAt": "2026-07-20T06:12:33+08:00",
  "cached": true,
  "updateFrequency": "每 6 小時",
  "data": { /* transform 後的精簡結構 */ }
}
// 失敗
{
  "ok": false,
  "error": {
    "code": "UPSTREAM_TIMEOUT",   // 常數列舉：INVALID_PARAMS / AUTH_MISSING / UPSTREAM_ERROR / UPSTREAM_TIMEOUT / SCHEMA_MISMATCH / NOT_FOUND
    "message": "中央氣象署 API 逾時（5 秒）",
    "hint": "可稍後重試；若持續發生，官方平台可能維護中"
  }
}
```

**回應預算**：單次工具回應目標 ≤ 2,000 tokens。列表型資料預設 3~5 筆、上限 10~20 筆（依資料集在 registry 設定），超出提示使用者縮小查詢範圍。

---

## 3. 工具清單（目標狀態）

### 3.1 精選層（高頻需求，≤15 個）

| 工具 | 涵蓋資料集 | 關鍵參數 | TTL | 階段 |
|---|---|---|---|---|
| `tw_weather_forecast` | F-C0032-001；之後擴充鄉鎮 F-D0047-*（代碼待確認） | city, (township?) | 30 分 | ✅ / 擴充 P2 |
| `tw_weather_observation` | O-A0003-001（待確認） | station/city | 10 分 | P2 |
| `tw_weather_alerts` | W-C0033-001（待確認） | city? | 5 分 | P2 |
| `tw_typhoon` | 颱風消息與警報（代碼待確認） | — | 10 分 | P2（季節性高價值） |
| `tw_recent_earthquakes` | E-A0015-001 | limit | 5 分 | ✅ |
| `tw_air_quality` | aqx_p_432 | county/siteName | 10 分 | ✅ |
| `tw_air_quality_forecast` | 空品預報（每 30 分更新，代碼待確認） | area | 30 分 | P2 |
| `tw_bus_eta` | TDX 公車動態 | city, route | 30 秒~1 分 | P3 |
| `tw_metro_status` | TDX 捷運營運狀態 | system | 1 分 | P3 |
| `tw_rail` | TDX 台鐵/高鐵時刻與誤點 | origin, dest | 1~5 分 | P3 |
| `tw_youbike` | TDX/各市 YouBike 即時 | city, station | 1 分 | P3 |
| `tw_reservoir` | 水庫蓄水率（來源待確認） | reservoir? | 1 小時 | P4 |

原則：**同族資料合併**（例如天氣觀測不同測站是參數不是不同工具）；**寫入型工具永遠不會有**（全 server `readOnlyHint: true`）。

### 3.2 通用層（長尾覆蓋，固定 2 個）

- `tw_search_datasets(query, source?)`：對 registry 的 title + keywords 做檢索，回傳資料集 id、標題、參數說明。**只搜 registry 內容**，不是搜整個政府開放平台——確保搜得到的一定查得動
- `tw_query_dataset(datasetId, params)`：依 registry entry 的 `paramsSchema` 驗證後執行查詢。**安全邊界：datasetId 必須存在於 registry（allowlist），絕不接受任意 URL 或任意路徑**，杜絕 SSRF 與被當跳板打別人 API 的可能

長尾資料集（登記進 registry 但不做專屬工具）：紫外線指數、潮汐、宜蘭外海浮標、河川水質、農產品批發價……每筆成本極低，累積由通用層曝光。

### 3.3 工具描述規範（寫進 AGENTS.md 強制執行）

每個工具描述必須含五段：一句話用途（含資料來源機關與資料集編號）/ 參數說明（含格式陷阱，如「臺」）/ 適用情境 / 不適用情境 / 資料範圍限制（如「僅顯著有感地震」「非即時，每小時更新」）。annotations 一律 `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`。

---

## 4. 橫切關注

### 4.1 快取

- 介質：Cloudflare KV，key 格式 `{tool}:{參數序列化}`（參數需排序後序列化，避免同查詢不同 key）
- 語意：best-effort——KV 未綁定、讀寫失敗、內容損毀一律直接打上游；**錯誤回應永不快取**
- TTL 依資料集更新頻率設定（見 §3 表），TDX 即時類 30 秒~1 分
- **風險：KV 免費額度寫入 1,000 次/天**。公開 demo 若流量成長，空品（22 縣市 × 每 10 分）理論上限就可能超標。緩解順序：(a) 熱門查詢命中率高，實際寫入遠低於理論值，先觀察；(b) 超標時改用 Cloudflare Cache API（免費、無次數限制、但 per-PoP 不共享）作為第一層，KV 退居第二層；(c) 引導使用者自架
- TDX OAuth token 也存 KV（TTL 略短於官方效期），token 取得失敗時回 `AUTH_MISSING` 並附申請網址

### 4.2 錯誤處理

- 上游逾時 5 秒、單次重試（僅冪等 GET）
- 所有錯誤走 §2.3 信封，`hint` 必須可行動
- `SCHEMA_MISMATCH`（上游格式與預期不符）要明確報錯而不是回傳半殘資料——這是 fail-loud 原則，並且是 schema drift 的偵測訊號

### 4.3 安全與濫用防護

- Secrets 只在 Cloudflare；程式碼與日誌中禁止輸出金鑰（code review checklist 項目）
- 公開 demo 加一條 Cloudflare 免費方案的 rate limiting 規則（per-IP）；README 明確引導正式使用請自架
- 通用層 allowlist 設計（§3.2）是唯一對外可變動查詢面，已封死任意目標

### 4.4 合規（既有結論的固化）

- 每個回應信封帶 `source` 顯名標示；README 維持授權條款、免責、防災以官方為準的聲明
- 工具描述與 transform 中禁止出現「本工具預測/建議」語意；颱風、特報類工具描述明確寫「轉載中央氣象署發布內容」
- LICENSE：程式碼 MIT；資料依政府資料開放授權條款第 1 版，README 分開標示兩者

---

## 5. 測試與品質策略

1. **單元測試**（現有 36 個的延伸）：每個 transform 對著 fixtures 測；每個 adapter 的認證注入、缺值正規化、錯誤正規化各自有測試
2. **Fixtures 管線（關鍵投資）**：GitHub Actions 排程（每週）用 repo secrets 的真金鑰抓各資料集真實回應 → 去敏（移除金鑰回顯欄位）→ 與現有 fixture 做結構 diff → 無變化則略過，有變化自動開 PR + issue 標記 `schema-drift`。這同時解決：(a) 雲端 sandbox 打不到部分網域只能盲寫的問題；(b) 上游改格式（MOENV 前科）造成的靜默腐壞
3. **契約測試**：每個 registry entry 的 `paramsSchema` 與 transform 對 fixture 跑一輪，保證「登記進 registry 的資料集一定可用」
4. **部署後 smoke test**：Actions 在 Cloudflare 部署完成後打正式 URL 的 `/mcp`（initialize + tools/list + 一次 `tw_recent_earthquakes` 呼叫），失敗即通知
5. **CI（每個 PR）**：typecheck + lint + 全部測試 + `wrangler deploy --dry-run` + README 工具表與 registry 一致性檢查（跑 `gen-tools-doc` 比對 diff）
6. **評估集（進階，P4）**：依 MCP 官方建議建 10 題真實查詢評估（如「臺北市現在下雨機率高嗎」），定期用 LLM 實測工具選用正確率——這是「description 寫得好不好」的客觀量測

**Gate 驗收紀律（沿用你既有方法論）**：每個 Phase 完成的定義 = CI 全綠 + smoke test 通過 + 真實 connector 手測通過 + 文件同步。未過 Gate 不開下一個 Phase 的新工作。

---

## 6. 交付路線圖

> 每個 session 開頭固定指令：「先讀 docs/ARCHITECTURE.md 與 AGENTS.md，依規範作業，完成後開 PR」。
> 標 ⚡ 的可以平行開（不同 session 同時跑，按檔案邊界切分，不會衝突）。

### Phase 1 — 平台化（先鋪路，1~2 sessions，序列執行）

- **Session A|重構為分層架構**：抽出 adapters/registry/infra，現有三工具改走新路徑，行為不變（既有 36 測試全數保留通過作為重構安全網）；統一回應信封與錯誤碼；撰寫 `AGENTS.md`（目錄規範、描述五段式、測試要求、PR checklist）與 `docs/adr/ADR-001-layered-architecture.md`
- **Session B|品質基建**：CI workflow（PR 檢查全套）、fixtures 抓取管線與 schema-drift 偵測、部署後 smoke test、`gen-tools-doc` 腳本
- 你要做的事：在 repo Settings → Secrets 加入 `CWA_API_KEY`、`MOENV_API_KEY`（給 Actions 抓 fixtures 用，與 Cloudflare 的是同值不同存放處）

### Phase 2 — CWA/MOENV 擴充（⚡ 可平行，每 session 一組）

- Session C ⚡：天氣特報 + 天氣觀測（登 registry + 精選工具）
- Session D ⚡：鄉鎮預報（含縣市→代碼對照表）+ 颱風
- Session E ⚡：空品預報 + 長尾資料集第一批（紫外線、潮汐等，只登 registry）
- 每個 session 內建步驟：先打官方文件確認資料集代碼與回應結構，再實作

### Phase 3 — 通用層 + TDX（序列 → 平行）

- Session F：`tw_search_datasets` + `tw_query_dataset`（通用層先上，之後長尾登記立即有曝光）
- Session G：TDX adapter（OAuth token 快取）+ `tw_bus_eta`（打通認證是重點，工具先做一個）
- Session H ⚡：捷運 + 台鐵/高鐵；Session I ⚡：YouBike
- 你要做的事：TDX 平台註冊會員、建立應用程式取得 client id/secret、設進 Cloudflare 與 GitHub secrets

### Phase 4 — 收尾與發布

- Session J：水庫水情 + 長尾第二批；評估集 10 題與實測
- Session K：README 全面翻新（工具表自動生成）、英文版 README、Anthropic connector directory 投稿準備
- Backlog（隨時可塞平行 session）：農產品價格、藥局查詢、更多 CWA 海象資料

**時程感**：Phase 1 約 2~3 天（含你手機上的 merge 與設定）；Phase 2 平行跑 2 天；Phase 3 約 3~4 天（TDX 認證是最大不確定性）；Phase 4 隨意。全程約兩週內可到「可投稿 directory」的完成度，比第一版的一週長，因為範圍大了一個量級。

---

## 7. 風險與待決事項

| 風險 | 影響 | 緩解 |
|---|---|---|
| 工具定義總量逼近 connector 約 30k token 上限 | client 端截斷、選用品質下降 | 精選 ≤15 紀律；長尾一律走通用層；描述精練 |
| KV 免費寫入額度（1k/天） | 快取失效退化為全打上游 | §4.1 三段緩解；fail-soft 保證退化不斷線 |
| TDX 限流與 OAuth 複雜度 | P3 延誤 | token 快取；短 TTL 資料快取；Session G 只求打通一個工具 |
| 上游 schema drift（MOENV 有前科） | 靜默錯誤資料 | fixtures 週更 + SCHEMA_MISMATCH fail-loud |
| 公開 demo 被濫用 | 額度耗盡、金鑰被玩壞 | rate limiting 規則；README 導自架；必要時 demo 只保留無金鑰資料集 |
| 資料集代碼記憶錯誤 | 整個 session 白做 | 規範：session 內先實測官方文件再動工，「待確認」標記制度 |
| Cloudflare Workers 免費 10 萬 req/天 | demo 爆量斷線 | 對個人專案綽綽有餘；真的爆了是好消息，再談付費或分流 |

---

## 8. 給每個 Claude Code Session 的固定開場白（範本）

```
先讀 docs/ARCHITECTURE.md 與 AGENTS.md，依其中的分層架構、描述五段式規範、
回應信封格式與測試要求作業。本 session 的任務：

[貼上該 session 的具體範圍，見 §6]

完成定義：typecheck 與全部測試通過、wrangler deploy --dry-run 成功、
README 工具表已用 gen-tools-doc 重新生成、開 PR 並在描述中列出
(1) 動了哪些檔案 (2) 新增哪些 registry entries (3) 有哪些「待確認」項目與偏離規劃之處。
```
