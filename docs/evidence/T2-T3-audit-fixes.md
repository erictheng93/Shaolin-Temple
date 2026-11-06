# T2／T3 稽核後修正

2026-11-06，分支 `backend/t3`，接在 T3（260cb27）之後。稽核結論：T1、T3 通過；T2 驗收標準達成，以下為稽核提出的修正，由 Claude 實作。

## 稽核摘要

| 任務 | 結論 | 依據 |
| --- | --- | --- |
| T1 | 通過 | 本機重跑 fmt／clippy／test／release；Docker 映像雜湊與交付證據一致（可重現建置）；SIGINT／SIGTERM 均於 2 秒內結束且結束碼 0；`PORT=abc`、`ROOM_CAPACITY=0` 結束碼 1 |
| T2 | 驗收標準達成 | 12 項測試與前端共用 fixture 測試通過；以探針實測發現下列 2～4 |
| T3 | 通過 | 15 項測試通過；`server/src` 無 Mutex／RwLock／全域可變狀態；兩分頁截圖確認 |

## 修正內容

1. 場景協定：T3 已補 `zone` 型別、快照欄位與 fixture；新增回歸測試，連送 25 則 `zone` 不會被斷線。伺服器端處理場景切換仍屬 T4。
2. Origin 正規化：`normalize_origin()` 將設定轉為瀏覽器 Origin 格式。修正前實測：設定 `http://localhost:5173/` 時伺服器照常啟動但所有連線回 403。
3. 字串上限：`ClientMessage::within_limits()`。修正前實測：15,000 字元的 `reqId` 被接受。
4. 閒置逾時：握手後 90 秒無輸入以 1001 關閉。修正前：握手後的接收沒有逾時，半開連線會永久佔用名額。
5. `ROOM_CAPACITY` 可設定範圍 1～500，預設 50。

## 驗證

Windows，Rust 1.95.0：

- `cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings`：通過。
- `cargo test --locked`：21 passed（新增：`string_limits`、`origins_are_normalized_like_browser_headers`、`zone_messages_are_accepted_not_counted_invalid`、`over_limit_strings_count_as_invalid`、`idle_timeout_closes_silent_connection_but_not_active_one`、`trailing_slash_origin_setting_still_accepts_browser_origin`）。
- `cargo build --locked --release`：通過。
- web：`vue-tsc -b` 通過、`vitest run` 32 passed。
- 端對端：release 伺服器設定 `ALLOWED_ORIGINS=http://localhost:5173/`，日誌顯示正規化為 `http://localhost:5173`；前端（低畫質）進出殿兩趟，遊戲 WebSocket 送出 4 則 `zone`，連線全程未關閉、未重連，狀態維持已連線。

未驗證：閒置逾時在真實背景分頁（Chrome 節流）下的實際行為；以 400 ms 縮短逾時的整合測試涵蓋邏輯。
