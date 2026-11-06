# 後端任務清單

記錄日期：2026-11-06。分工：使用者實作，Claude 稽核。

每個任務完成後提交到獨立分支或 PR，附上「交付證據」中列出的輸出，由 Claude 依「驗收標準」逐項稽核。前一個任務通過稽核後再開始下一個；同一優先級內的任務可並行。

## 共通約定

- 位置：`server/`（單一 crate，`Cargo.lock` 提交）。工具鏈以 `rust-toolchain.toml` 固定為 1.95.0（本機已安裝版本）。
- 框架：Axum 0.8（決策理由見 [TECH_STACK.md](TECH_STACK.md#後端axum)）。起始依賴：`axum 0.8.9`（啟用 `ws`）、`tokio 1.54`、`tower-http 0.7`、`tracing 0.1`、`tracing-subscriber 0.3`、`serde 1`、`serde_json 1`。新增其他依賴需在 PR 說明理由。
- 協定以前端 [`web/src/game/net/protocol.ts`](../web/src/game/net/protocol.ts) 為準；伺服器行為參考 [`web/scripts/mock-server.mjs`](../web/scripts/mock-server.mjs)。要改協定時先提出，前端與後端同一個 PR 修改。
- 時間：`serverTime`、`startedAt` 一律為 Unix epoch 毫秒；`pong.ts` 原樣回傳客戶端送來的值。
- 單一房間上限 **50 人**，以設定值 `ROOM_CAPACITY` 提供，預設 50，可設定範圍 1～500（`MAX_ROOM_CAPACITY`，日後依實測調整不必改程式）。
- 場景（zone）：每位玩家屬於一個場景（目前 `courtyard`、`hall`），定義與出入口範圍見 [`web/src/game/world/zones.ts`](../web/src/game/world/zones.ts)。同房間的玩家在不同場景時互相看不到。
- 每個 PR 必須通過：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`。
- 不使用 `unwrap()`／`expect()` 處理來自網路的資料；客戶端輸入一律視為不可信。
- 禁止所有玩家共用一把全域 `Mutex`（AGENTS.md）。

## 優先級總覽

| 任務 | 優先級 | 依賴 | 內容 |
| --- | --- | --- | --- |
| T1 | P0 | — | 專案骨架、健康檢查、正常關機、CI、Dockerfile |
| T2 | P0 | T1 | WebSocket 端點與協定 v1 編解碼、握手 |
| T3 | P0 | T2 | 房間 actor、分房、加入／離開、快照 |
| T4 | P0 | T3 | 位置與動作：驗證、速率限制、去重確認 |
| T5 | P0 | T3 | 廣播 tick、批次位置、每連線佇列上限與慢速接收者 |
| T6 | P0 | T3 | 斷線恢復（resumeToken） |
| T7 | P0 | T5 | 指標、負載測試工具、流量報告 |
| T8 | P1 | T7 | 二進位編碼與座標量化（依 T7 量測決定） |
| T9 | P1 | T7 | 部署到 Dokploy、正式環境壓測 |
| T10 | P2 | 玩法定案 | PostgreSQL、身分、持久化計數 |

---

## T1 專案骨架（P0）

**目標**：可建置、可測試、可容器化、可優雅關閉的最小伺服器。

範圍：
- `server/` crate；`rust-toolchain.toml`；`main.rs` 只做組裝，邏輯放模組。
- 設定由環境變數讀取並集中在 `Config`：`PORT`（預設 8080）、`ALLOWED_ORIGINS`（逗號分隔）、`ROOM_CAPACITY`（預設 50）、`RUST_LOG`。設定錯誤時啟動失敗並印出原因。
- `GET /healthz` 回 200 與純文字 `ok`。
- 收到 SIGTERM／Ctrl+C 時停止接受新連線，5 秒內結束。
- `tracing` 結構化日誌。
- `.github/workflows/server.yml`：路徑過濾 `server/**`，執行 fmt、clippy、test、`cargo build --release`。
- `server/Dockerfile`：多階段建置，執行階段使用精簡映像、非 root 使用者，只包含二進位檔。

驗收標準：
1. 三項檢查與 release 建置在 CI 通過。
2. `curl -i localhost:8080/healthz` 回 `200 ok`。
3. 執行中送出 Ctrl+C，程序在 5 秒內結束且結束碼為 0。
4. `docker build` 成功，`docker run` 後 healthz 可用；`docker image ls` 顯示映像大小。
5. `PORT=abc` 時啟動失敗並顯示可讀的錯誤。

交付證據：CI 連結或本機三項檢查輸出、上述 curl／docker 指令輸出、映像大小。

---

## T2 WebSocket 端點與協定 v1（P0）

**目標**：`GET /ws` 升級 WebSocket，完整收發 `protocol.ts` 定義的所有訊息類型。

範圍：
- 訊息型別用 `#[serde(tag = "t")]` 列舉，欄位名稱與前端完全一致（含 `moves` 的陣列格式 `[id, x, z, heading, 0|1]`）。
- 單則訊息上限 16 KiB（`MAX_MESSAGE_BYTES`），超過即關閉連線（close code 1009）。只接受文字訊息。
- 檢查 `Origin` 是否在 `ALLOWED_ORIGINS`（本機開發允許 `http://localhost:5173`）。設定值讀取時正規化成瀏覽器 Origin 格式（小寫、去結尾斜線、省略預設埠），避免 `https://example.com/` 這類寫法讓所有連線被拒。
- 字串欄位上限（UTF-8 bytes）：`reqId`／`resumeToken` 128、動作 `id`／`zone` 32、名稱原始字串 256；超過視為無效訊息。
- 握手後 90 秒（`DEFAULT_IDLE_TIMEOUT`）沒有收到任何資料即以 1001 關閉。前端每 20 秒送心跳；取 90 秒是因為 Chrome 會把背景分頁計時器節流到約每分鐘一次。
- 連線後 5 秒內必須收到 `hello`，否則關閉；`hello.v` 不等於 1 時回 `error`（code `unsupported_version`）後關閉。
- 名稱清理：去除前後空白與控制字元，長度 1～16 個字元（以 Unicode 字元計），空白時改為「訪客」。
- 無法解析的訊息：忽略並計數，不關閉連線；同一連線 10 秒內超過 20 則無效訊息才關閉（close code 1008）。

驗收標準：
1. 單元測試：每種訊息類型序列化結果與前端 `decode()` 接受的 JSON 一致（以前端測試中的範例字串為固定測試資料）。
2. 測試：17 KiB 訊息導致關閉；非白名單 Origin 被拒；5 秒未 hello 被關閉；`v: 2` 收到 `error`。
3. 名稱清理的測試涵蓋：全形空白、換行、表情符號、17 字元輸入。

交付證據：`cargo test` 輸出與新增測試清單。

---

## T3 房間 actor 與分房（P0）

**目標**：每個房間是一個獨立的 tokio task，擁有自己的玩家狀態；連線透過 channel 與房間溝通。

範圍：
- `Room` task 持有 `HashMap<PlayerId, Player>`，只在自己的 task 內修改，不加鎖。連線送 `RoomCommand`（Join／Leave／Move／Action…）給房間；房間經由每條連線的發送佇列回傳訊息。
- 房間登記表（lobby）負責分配：找第一個人數 < `ROOM_CAPACITY` 的房間，沒有就建立新房間。登記表可以是單一 actor 或分片結構，但不得在每則遊戲訊息的路徑上取得全域鎖。
- 房間清空 60 秒後關閉 task 並從登記表移除。
- 加入：回 `welcome`（含 `selfId`、`room`、`resumeToken`、`serverTime`、全房快照），並對其他人廣播 `join`。
- 離開或斷線：廣播 `leave`（T6 完成後改為寬限期結束才廣播）。
- 玩家 ID 由伺服器產生，不可由客戶端指定。
- 出生點：`x ∈ [-2, 2]`、`z = 11`、`heading = π`、`zone = "courtyard"`（與前端 `SPAWN` 一致）。快照的每位玩家都要帶 `zone`。

驗收標準：
1. 整合測試（以 `tokio-tungstenite` 或同等客戶端）：51 個連線加入後，前 50 人在房間 A、第 51 人在新房間 B；各自的 `welcome.players` 長度正確。
2. 一人離開時，同房其他人都收到 `leave`；不同房的人收不到。
3. 程式碼中沒有涵蓋所有玩家的 `Mutex`／`RwLock`。
4. 前端（`VITE_WS_URL` 指向本伺服器）可進入、看到其他分頁的玩家，在線人數正確。

交付證據：測試輸出、兩個瀏覽器分頁互相看見的截圖。

---

## T4 位置、動作與輸入驗證（P0）

**目標**：伺服器持有權威位置，拒絕不合理的輸入；需確認的動作具冪等性。

範圍：
- 位置：`move`／`stop` 的座標必須在場地邊界內（`WORLD_BOUNDS`：x −19～19、z −19～18），且與上次接受的位置相比，移動距離不超過 `3.2 m/s × 經過時間 × 1.5 + 0.5 m`。不合格時夾回合法位置並在下一個 tick 廣播校正後的位置。`heading` 正規化到 −π～π。
- 速率限制（每連線 token bucket）：`move`／`stop` 每秒最多 15 則，`action` 每秒最多 2 則，全部訊息每秒最多 30 則。超出的訊息丟棄並計數；連續 5 秒超出則關閉（1008）。
- 動作：`id` 必須在伺服器的允許清單內（目前為示範用的 `bow`、`bowl`、`bell`，以設定檔或常數提供）。回 `ack { reqId, ok, reason? }`。同一連線最近 64 個 `reqId` 的結果需快取，重送時回同一個 ack、不重複廣播。成功時對同房其他人廣播 `action { playerId, id, startedAt }`。
- `data` 欄位暫時只接受空物件或省略，其他一律 `ok: false, reason: "unsupported_data"`。
- 場景切換 `zone`：`zone` 必須是已知場景，且玩家最後被接受的位置在目前場景某個出入口範圍內（容許 0.5 公尺誤差），目標場景必須等於該出入口的 `to`。通過後位置改為伺服器端的出入口落點（不採用客戶端送來的座標），對同房所有人廣播 `zone { id, zone, x, z, heading }`。不通過時回 `error`（code `invalid_zone`）並維持原場景。各場景的位置驗證改用該場景的邊界。

驗收標準：
1. 測試：越界座標被夾回；一次跳 10 公尺被拒；每秒 30 則 move 只有約 15 則生效。
2. 測試：同一 `reqId` 送兩次，只廣播一次、兩次都收到相同的 ack。
4. 測試：站在殿門出入口送 `zone: "hall"` 成功且位置變成殿內落點；站在庭院中央送則收到 `invalid_zone`。
3. 測試：未知動作回 `ok: false`。

交付證據：測試輸出。

---

## T5 廣播 tick、批次位置與背壓（P0）

**目標**：控制每位玩家的接收量，慢速接收者不能拖累房間或耗盡記憶體。

範圍：
- 房間 tick 預設 10 Hz（設定值 `TICK_HZ`）。tick 內只送「本 tick 有變動」的玩家，合併成一則 `moves`；座標與 heading 四捨五入到 0.01。靜止的玩家完全不送。
- 依場景過濾：`moves` 與 `action` 只送給同場景的玩家（`zone`、`join`、`leave` 送給同房所有人，讓客戶端維持名單）。
- 停下時送一次 `moving: 0`，之後不再重送。
- 每條連線的發送佇列有上限（預設 64 則）。佇列滿時：
  - `moves` 可丟棄（下一個 tick 會有更新的位置）。
  - `welcome`／`join`／`leave`／`ack`／`action` 不可丟棄；若這些也放不進去，判定為慢速接收者並關閉連線（close code 1013）。
- 房間 task 不能因為任何單一連線的寫入而阻塞（只用 `try_send`）。

驗收標準：
1. 測試：50 人房、只有 1 人移動時，其他人每 tick 最多收到 1 則 `moves` 且只含 1 筆。
4. 測試：殿內玩家移動時，庭院玩家收不到該玩家的 `moves`。
2. 測試：一個客戶端完全不讀取，房間內其他人的 tick 間隔不受影響（量測 10 秒內 tick 數），該客戶端最終被關閉且伺服器記憶體不持續成長。
3. 停止移動後 1 秒內只收到一次 `moving: 0`。

交付證據：測試輸出；慢速接收者測試前後的 RSS。

---

## T6 斷線恢復（P0）

**目標**：短暫斷線（切網路、進電梯）後回到同一個房間、同一個身分與位置，其他人看不到離開再加入。

範圍：
- `resumeToken` 為隨機 128 位元以上的不可猜測值，不得等於或可推導出玩家 ID。
- 斷線後保留玩家 30 秒（`RESUME_GRACE_SECONDS`），期間不廣播 `leave`；位置停止更新。
- `hello.resumeToken` 有效且未過期時，恢復原 ID、房間與位置，回新的 `welcome`（新 token）；無效或過期時視為新玩家。
- 同一 token 只能使用一次；舊連線若仍存在，以新連線取代並關閉舊的。

驗收標準：
1. 測試：斷線 5 秒內重連，`selfId` 相同、房間相同、其他人沒有收到 `leave`／`join`。
2. 測試：斷線 31 秒後重連得到新 ID，其他人在第 30 秒收到 `leave`。
3. 測試：同一 token 第二次使用失敗。
4. 手動：前端開啟中重啟伺服器以外的情境（例如瀏覽器切離線再上線），角色不消失。

交付證據：測試輸出。

---

## T7 指標、負載測試與流量報告（P0）

**目標**：用數字回答「每位玩家每秒用多少流量」與「這台主機撐多少人」。

範圍：
- `GET /metrics`（Prometheus 文字格式，可由 `METRICS_TOKEN` 保護）：連線數、房間數、各房人數分布、每秒收送訊息數、出站 bytes、丟棄的 `moves` 數、因慢速接收被關閉的連線數、tick 處理時間。
- 負載工具 `server/loadtest`（獨立 binary）：參數為連線數、移動中比例、執行秒數；每個模擬玩家依前端行為送 `move`（10 Hz）與偶發 `action`；輸出每連線平均接收 bytes/s、訊息/s、p50／p99 tick 間隔。
- 負載工具在另一台機器或至少另一個程序執行，不與伺服器共用資源判斷。

驗收標準與報告內容（寫入 `docs/` 的量測紀錄）：
1. 情境：50／200／500 連線 × 移動比例 10%／50%，每個情境至少 60 秒。
2. 每個情境記錄：每連線接收 bytes/s、伺服器 CPU、RSS、出站總頻寬、丟棄數。
3. 與預算比較：每人每秒 150～460 bytes（見 TECH_STACK 流量算例）。
4. 前端參考值：mock 伺服器 50 人、約半數移動時，每位玩家約 6.1 KB/s、12 則/s（JSON）。

交付證據：報告文件與原始輸出。

---

## T8 二進位編碼與量化（P1）

依 T7 結果決定是否需要。預期方向：`moves` 改為二進位幀（房內玩家以 u16 索引取代字串 ID、座標以 i16 公分、heading 以 u8），目標每筆 7 bytes 以內。需同步修改前端 `protocol.ts` 的 `decode()`，由 Claude 負責前端部分。

## T9 部署與正式環境壓測（P1）

Dokploy 上部署伺服器映像與前端靜態檔；前端建置設定 `VITE_AMBIENT_URL`，並通過 [TECH_STACK.md](TECH_STACK.md#部署檢查每次上傳或更換音樂檔都要做) 的環境音樂部署檢查（`npm run check:ambient` 全部通過、建置輸出沒有缺少音樂網址的警告、手機實際聽過）；WebSocket 經反向代理的逾時與升級設定；日誌輪替；以外部機器對正式環境重跑 T7 情境；確認 1 vCPU／2 GiB 在 Dokploy、代理與（未來）PostgreSQL 同時運作時的餘裕。

## T10 持久化（P2）

等玩法定案：決定要保存的資料（例如帳號、累計次數）後再設計資料表、連線池大小與寫入批次策略。在此之前不建立 PostgreSQL 依賴。
