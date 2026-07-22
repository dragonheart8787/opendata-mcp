# Session B — 品質基建（CI、fixtures 管線、部署後 smoke test）

> 這份文件是 Phase 1 "Session B" 的完整任務指示，設計成可以直接貼給一個全新的 Claude Code session 作為開場白使用。
> 對應 `docs/ARCHITECTURE.md` §5（測試與品質策略）與 §6（Phase 1）。

## 給執行 session 的開場白（可直接複製貼上）

```
先讀 docs/ARCHITECTURE.md、AGENTS.md、docs/adr/ADR-001-layered-architecture.md，
依其中的分層架構與測試規範作業。本 session 的任務是 docs/sessions/SESSION-B.md
的完整範圍：CI workflow、fixtures 抓取管線與 schema-drift 偵測、部署後自動
smoke test、gen-tools-doc 腳本。完成後開 PR。
```

---

## 背景與動機

Phase 1 Session A（已完成，見 PR #7）把三個工具重構為分層架構，但驗證這個重構「有沒有真的動到工具的外部行為」目前完全依賴人工：

1. 這個 repo 的沙盒環境對外網路存取受限（連 `opendata.cwa.gov.tw`、`data.moenv.gov.tw`、甚至部署後的 `*.workers.dev` 都可能被政策擋下），**Claude Code session 本身無法可靠地對正式環境做 end-to-end 驗證**
2. MOENV 的 bare-array 回應格式問題（見已合併的修正 PR）就是在沒有真實回應樣本、只能盲寫 fixture 的情況下發生的
3. 目前完全沒有自動化機制偵測「上游 API 改格式了」或「部署後工具實際上壞了」

GitHub Actions 的網路不受這個沙盒的政策限制，所以這三件事都應該搬到 Actions 上做，而不是依賴 Claude Code session 或使用者手動驗證。

## 範圍

### 1. CI workflow（每個 PR 都跑）

新增 `.github/workflows/ci.yml`，在每個 PR 與 push 到 `main` 時執行：

- `npm ci`
- `npm run typecheck`
- `npm test`（目前 95 個測試，之後只會增加）
- `npx wrangler deploy --dry-run`（確認建置與 KV binding 正常，**不要**用會觸發真實部署的指令）
- **README 工具表一致性檢查**：跑 `gen-tools-doc`（見下方 §4），比對輸出與目前 README.md 裡的工具表是否一致，若有差異就讓 CI fail 並印出 diff（防止有人加了 registry entry 卻忘記更新 README）

不需要新的 secrets——這些步驟都不需要真實 API 金鑰。

### 2. Fixtures 抓取管線（排程，週期執行）

新增 `.github/workflows/fixtures-refresh.yml`，用 `schedule`（建議每週一次，例如 `0 3 * * 1`）加 `workflow_dispatch`（方便手動觸發）：

1. 用 repo secrets `CWA_API_KEY`、`MOENV_API_KEY`（**這組要另外在 GitHub repo Settings → Secrets 新增**，跟 Cloudflare Workers 上設定的是同一組值但不同存放處——這是你要做的事，不是這個 session 能做的）對現有三個 registry entry 各打一次真實 API
2. **去敏**：抓回來的原始回應在寫入 fixture 前，先確認沒有把 `api_key`/`Authorization` 參數值原樣寫進檔案（這兩個資料集本身不會在 response body 裡回顯金鑰，但流程上還是要有這道檢查，避免未來新資料來源踩到）
3. 跟 `test/fixtures/` 現有檔案做結構化 diff（比對欄位名稱、巢狀結構，不比對數值本身——數值本來就會變）：
   - 無結構性差異 → 不動作，結束
   - 有結構性差異 → 自動開一個 PR（更新 fixture + 標記哪些欄位變了），並開一個 issue 標記 `schema-drift` label，issue 內容附上 diff 摘要
4. 這條管線也會`順便`把 fixture 從目前「部分真實資料 + 部分手造 placeholder」（見 `test/tools/air-quality.test.ts` 開頭註解）逐步替換成完全真實的樣本——第一次跑的時候可以順便把現有 fixture 補完整

**這個 session 需要你先完成的前置事項**（寫進 PR 說明提醒使用者，不要假設已完成）：
- 在 GitHub repo Settings → Secrets and variables → Actions 新增 `CWA_API_KEY`、`MOENV_API_KEY`

### 3. 部署後自動 smoke test（取代人工驗證）

新增 `.github/workflows/deploy-smoke-test.yml`，在 push 到 `main` 後觸發（Cloudflare 的 Git 整合本身也是 push-to-main 觸發部署，兩者會平行跑）：

**部署完成偵測**：Cloudflare 的部署通常在一分鐘內完成，但 Actions 沒有直接管道知道「這次部署完成了沒」。建議做法：
- 在 `src/index.ts` 的健康檢查路由（`GET /`）或 MCP `initialize` 回應的 `serverInfo.version` 帶上目前的 git commit SHA 或 `package.json` version
- Smoke test workflow 用短輪詢（例如每 5 秒打一次，最多 2 分鐘）打正式 URL，直到看到的 version/SHA 符合這次 push 的 commit，再往下跑實際測試；逾時就明確回報「部署可能還沒完成或失敗」，不要誤判成工具本身壞掉

**實際測試內容**（對 `https://opendata-mcp.dragonheartliu1440.workers.dev/mcp` 發送真實 MCP 請求）：
1. `initialize` — 確認 200、`serverInfo.name` 正確
2. `tools/list` — 確認三個工具都曝光，且 `inputSchema` 存在
3. 各呼叫一次三個工具的真實查詢（用不需要猜測的固定參數，例如 `tw_weather_forecast` city=臺北市、`tw_recent_earthquakes` limit=1、`tw_air_quality` county=臺北市），確認：
   - HTTP 200
   - `result.isError` 不是 true
   - `result.structuredContent.ok === true`
   - `result.structuredContent.data` 存在且形狀合理（例如 weather 的 `data.periods` 是非空陣列）

失敗處理：任何一步失敗，workflow 要 fail 並在 GitHub 上看得到具體是哪一步、回應內容是什麼（不要只印「failed」）。建議失敗時額外開一個 issue 或用 GitHub Actions 的通知機制讓你能收到通知，不用主動去查。

### 4. `gen-tools-doc` 腳本

新增 `scripts/gen-tools-doc.ts`：讀取 `src/registry/cwa.ts` 與 `src/registry/moenv.ts` 匯出的 entries（`listDatasetEntries()`，已經在 `src/registry/index.ts` 裡實作好了），輸出一份 Markdown 表格（工具/用途/資料集/參數），格式對齊 README.md 目前「已支援的工具」章節的表格。

用法：
- `npm run gen-tools-doc` — 印出目前應該長什麼樣的表格（供人工比對或手動貼回 README）
- CI 裡用它做 §1 提到的一致性檢查（可以用 `--check` flag，輸出跟目前 README 不一致就 exit 1）

## 這個 session 不做的事

- 不新增任何資料集或工具（那是 Phase 2 的範圍）
- 不做 rate limiting（架構文件 §4.3 提到，但那是獨立的濫用防護項目，不屬於「品質基建」）
- 不做評估集 10 題（架構文件 §5.6，標記 P4，之後再做）
- 不把 `test/fixtures/` 搬到頂層 `fixtures/`——除非搬移本身是這個 session 順手能做且不影響現有測試的小改動，否則不用勉強做到架構文件 §2.1 目錄結構的每個細節

## 完成定義

- CI workflow 在一個測試 PR 上跑過且全綠
- Fixtures 抓取管線至少手動觸發過一次（`workflow_dispatch`），確認金鑰注入、diff 邏輯、開 PR/issue 的行為符合預期（沒有真實 schema drift 也要能正確判斷「無需動作」而不是誤報）
- 部署後 smoke test 至少在一次真實部署後跑過且全綠，證明它真的驗證了正式環境而不只是本機
- `gen-tools-doc` 產出的內容與目前 README 手寫的工具表一致
- 開 PR，說明裡列出：新增了哪些 workflow 檔案、fixtures 管線第一次跑的結果（有沒有補完整既有 fixture）、smoke test 的部署完成偵測策略選了哪一種、以及使用者需要另外設定的 GitHub repo secrets 清單
