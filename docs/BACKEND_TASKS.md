# 後端任務清單

記錄日期：2026-11-06。分工自 2026-11-12 起改為 Claude 實作並自行依「驗收標準」驗證（T1～T3 由使用者實作、Claude 稽核）。

每個任務依「驗收標準」逐項驗證，並保留「交付證據」中列出的輸出。

## 共通約定

- 位置：`server/`（單一 crate，`Cargo.lock` 提交）。工具鏈以 `rust-toolchain.toml` 固定為 1.95.0（本機已安裝版本）。
- 框架：Axum 0.8（決策理由見 [TECH_STACK.md](TECH_STACK.md#後端axum)）。起始依賴：`axum 0.8.9`（啟用 `ws`）、`tokio 1.54`、`tower-http 0.7`、`tracing 0.1`、`tracing-subscriber 0.3`、`serde 1`、`serde_json 1`。新增其他依賴需在 PR 說明理由。
- 協定以前端 [`web/src/game/net/protocol.ts`](../web/src/game/net/protocol.ts) 為準；伺服器行為參考 [`web/scripts/mock-server.mjs`](../web/scripts/mock-server.mjs)。要改協定時先提出，前端與後端同一個 PR 修改。
- 時間：`serverTime`、`startedAt` 一律為 Unix epoch 毫秒；`pong.ts` 原樣回傳客戶端送來的值。
- 單一房間上限 **50 人**，以設定值 `ROOM_CAPACITY` 提供，預設 50，可設定範圍 1～50（`MAX_ROOM_CAPACITY`）。`welcome` 以單則訊息帶整房快照，必須放得進 16 KB（`MAX_MESSAGE_BYTES`），要放寬須先改成分段快照並同步調整前端 `decode()` 與寫入緩衝上限。
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
| T4 | P0 | T3 | 位置與動作：驗證、速率限制、去重確認（已完成 2026-11-12） |
| T5 | P0 | T3 | 廣播 tick、批次位置、每連線佇列上限與慢速接收者（已完成 2026-11-12） |
| T6 | P0 | T3 | 斷線恢復（resumeToken）（已完成 2026-11-12） |
| T7 | P0 | T5 | 指標、負載測試工具、流量報告（已完成 2026-11-12） |
| T8 | P1 | T7 | 二進位編碼與座標量化（已完成 2026-11-15；action 二進位幀 2026-11-16） |
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
- 連線後 5 秒內必須收到 `hello`，否則關閉；`hello.v` 不等於 1 時回 `error`（code `unsupported_version`）後關閉。（T8 起協定版本為 2，見 T8。）
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

## 協定增修（2026-11-12，T4～T6 一併實作）

協定仍是版本 1 的草案，直接修改，不升版號。共用固定資料 `server/tests/protocol-v1.json` 已改為下列格式，前端（`protocol-fixtures.test.ts`）與後端（`tests/protocol.rs`）都以它為準。

1. **房內短編號 `n`**：`PlayerSnapshot` 新增必填欄位 `n`（整數 0～65535；T8 起縮為 0～127，見 T8）。玩家加入房間時由伺服器指派，同一房間內所有「目前在名單上」的玩家（含斷線保留期間的玩家）彼此不重複；玩家離開後編號可回收給之後加入的人。斷線恢復（T6）沿用原編號。
2. **`moves` 改用短編號**：`MoveTuple` 為 `[n, x, z, heading, moving]`，第一個元素由字串 id 改為 `n`。`leave`、`zone`、`action`、`join` 仍用字串 id。客戶端以 `welcome`／`join` 建立 `n → 玩家` 的對照，`leave` 時移除；收到對照不到的 `n` 直接忽略。
3. **新訊息 `sync`**：`{ t: "sync", m: MoveTuple[] }`，格式與 `moves` 相同，語意是「整批位置校正」：客戶端對其中的玩家直接套用位置、面向與移動狀態，不做插值。筆數上限同 `MAX_MOVES_PER_MESSAGE`。伺服器在兩種情況送出，內容都是「收件人目前所在場景的所有其他玩家」：
   - 收件人切換場景成功後：先對同房所有人廣播 `zone`，再對切換者送一則 `sync`。
   - 收件人的 `moves` 曾因發送佇列已滿被丟棄：之後第一個放得進佇列的 tick 改送 `sync`（取代該 tick 的 `moves`），成功後才恢復送增量的 `moves`。`sync` 與 `moves` 一樣可丟棄，丟棄時下個 tick 再試。
4. **依場景過濾**（原本就在 T5 範圍）：`moves`、`sync`、`action` 只送給同場景的玩家；`zone`、`join`、`leave` 送給同房所有人。
5. **伺服器端停止看門狗**：玩家最後一則位置訊息是 `move`（移動中）且超過 1 秒沒有新的位置訊息時，伺服器視為停止，在下一個 tick 廣播該玩家 `moving: 0`。斷線進入保留期（T6）時同樣立即視為停止並廣播一次。
6. **前端行為（不改訊息格式）**：上行 `move`／`stop` 的 `x`、`z`、`heading` 四捨五入到 0.01；切到背景時若正在移動，先送一則 `stop`；重連的退避計數在收到 `welcome` 才歸零；收到 `error` code `unsupported_version` 後不再重連；close code 1013 或 1008 的下一次重連至少等 5 秒。

### T4～T6 完成紀錄（2026-11-12）

`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`（53 個測試）通過。另以兩個 WebSocket 客戶端對 release 版伺服器做端對端檢查（短編號、`moves`、動作去重、場景切換與 `sync`、場景過濾、斷線恢復、token 單次使用），並以前端連上真後端確認連線、人數、動作確認與其他玩家顯示正常。

已知限制與實作決定：

- 位置驗證（2026-11-13 改版）：
  - **移動額度**：每位玩家有一份額度（公尺），以 4.8 m/s（移動速度 3.2 × 1.5）累積、依移動距離扣除，上限 9.6 公尺（2 秒份，等於正常速度走 3 秒）；加入、切換場景、恢復連線後從 1 公尺起算。距離超出額度即拒絕。額度不會因為等待而超過上限，所以不能存起來瞬移。
  - **障礙物**：從伺服器上的位置到新位置的直線若穿過障礙物（`src/world.rs` 各場景的 `obstacles`，數值抄自前端並含角色半徑，檢查時內縮 0.1 公尺）即拒絕。
  - **拒絕時校正本人**：伺服器維持原位置，並送一則只含本人短編號的 `sync` 給本人（最多每 300 ms 一則）；前端收到後回到該位置並取消進行中的移動。
  - **速率限制丟棄時保留最新位置**：連線層保留最新一則被丟棄的 `move`／`stop`，約 70 ms 後有額度時補送，卡頓後停下的玩家不會停在舊位置。
  - 實測（本機迴路、兩個連線、訊息扣住後一次送出來模擬卡頓，不是真實行動網路）：正常走、頂著邊界走、卡 0.3～4 秒後繼續走或立刻停下，其他人看到的位置都在 0.3 秒內對齊，本人被校正 0 次。
  - 代價：卡頓期間走超過 9.6 公尺（約 3 秒以上都在走），或卡頓期間繞過障礙物的正常玩家，恢復時會被拉回卡頓前的位置。上限 `BUDGET_CAP` 是實作時選的值，尚未以真實網路資料調整。
  - 未涵蓋：伺服器不模擬逐步移動，只檢查「直線是否穿過障礙物」；以小步繞行的路徑一律接受。
- 速率限制是 token bucket：`move`／`stop` 突發量 3、`action` 突發量 3（誦經剛開始就按別的動作會連送 chant、chant_end、新動作三則）、全部訊息突發量 30；超出的訊息直接丟棄，被丟棄的 `action` 不會收到 `ack`（前端以逾時處理）。
- `reqId` 去重快取放在玩家身上而不是連線上，斷線恢復後重送仍會去重。
- T5 驗收 2 的「記憶體不持續成長」只驗證了佇列有上限且慢速連線會被關閉，沒有量 RSS。T6 驗收 4（手動測試瀏覽器離線再上線）尚未執行。

---

## T4 位置、動作與輸入驗證（P0）

**目標**：伺服器持有權威位置，拒絕不合理的輸入；需確認的動作具冪等性。

範圍：
- 位置：`move`／`stop` 的座標必須在場地邊界內（`WORLD_BOUNDS`：x −19～19、z −19～18），且與上次接受的位置相比，移動距離不超過 `3.2 m/s × 經過時間 × 1.5 + 0.5 m`。不合格時夾回合法位置並在下一個 tick 廣播校正後的位置。`heading` 正規化到 −π～π。
- 速率限制（每連線 token bucket）：`move`／`stop` 每秒最多 15 則，`action` 每秒最多 2 則，全部訊息每秒最多 30 則。超出的訊息丟棄並計數；連續 5 秒超出則關閉（1008）。
- 動作：`id` 必須在伺服器的允許清單內（以常數提供；2026-11-15 起為參拜玩法的 `bow`、`prostrate`、`incense`、`bell`，原示範用的 `bowl` 移除）。回 `ack { reqId, ok, reason? }`。同一連線最近 64 個 `reqId` 的結果需快取，重送時回同一個 ack、不重複廣播。成功時對同房其他人廣播 `action { playerId, id, startedAt }`。
- `data` 欄位暫時只接受空物件或省略，其他一律 `ok: false, reason: "unsupported_data"`。
- 場景切換 `zone`：`zone` 必須是已知場景，且玩家最後被接受的位置在目前場景某個出入口範圍內（容許 0.5 公尺誤差），目標場景必須等於該出入口的 `to`。通過後位置改為伺服器端的出入口落點（不採用客戶端送來的座標），對同房所有人廣播 `zone { id, zone, x, z, heading }`。不通過時回 `error`（code `invalid_zone`）並維持原場景。各場景的位置驗證改用該場景的邊界。

驗收標準：
1. 測試：越界座標被夾回；一次跳 10 公尺被拒；每秒 30 則 move 只有約 15 則生效。
2. 測試：同一 `reqId` 送兩次，只廣播一次、兩次都收到相同的 ack。
4. 測試：站在殿門出入口送 `zone: "hall"` 成功且位置變成殿內落點；站在庭院中央送則收到 `invalid_zone`。
3. 測試：未知動作回 `ok: false`。
5. 容量：快照裡的 `zone` 與 `action.id` 只能來自已知場景與動作允許清單，不得存入客戶端送來的任意字串。50 人滿房的 `welcome` 只有在這個前提下才放得進 16 KB（任意 32 bytes 字串時約 17 KB）。`room.rs` 的 `full_room_welcome_fits_message_limit` 須改為取場景清單與動作允許清單中最長的名稱來組快照，不再寫死 `"courtyard"`、`"bowl"`。

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

### T7 完成紀錄（2026-11-12）

`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test` 通過。報告：[LOAD_TEST_2026-11-12.md](LOAD_TEST_2026-11-12.md)（6 個情境、各 60 秒、原始 JSON 輸出）。

- `GET /metrics`（`src/metrics.rs`）：全部 atomic 計數；`METRICS_TOKEN` 設定時須帶 Bearer 權杖，未設定為開放。
- 負載工具為同 crate 的 `src/bin/loadtest.rs`（`cargo build --release` 一併產生 `target/release/loadtest`），不新增依賴（`futures-util` 由 dev-dependency 改為一般依賴，原本就在 `Cargo.lock`）。
- 結論：JSON 協定下每連線接收 1.5 KB/s（10% 移動）～5.8 KB/s（50% 移動），超出 150～460 bytes/s 預算 3.3～38.8 倍，95% 以上是 `moves`；詳見報告。
- 未做到：量測在同一台 Windows 開發機的本機迴路，非 1 vCPU 目標主機、非外部機器，也沒有弱網路與長時間（只有 60 秒）測試；這些留給 T9。CPU 數字重跑差異大，僅供量級參考。

---

## T8 二進位編碼與量化（P1）

依 T7 結果決定是否需要。預期方向：`moves` 改為二進位幀（房內玩家以 u16 索引取代字串 ID、座標以 i16 公分、heading 以 u8），目標每筆 7 bytes 以內。需同步修改前端 `protocol.ts` 的 `decode()`，由 Claude 負責前端部分。

### 協定版本 2：moves／sync 二進位幀（2026-11-15）

只有伺服器送出的 `moves` 與 `sync` 改為 WebSocket 二進位幀；`welcome`、`join`、`leave`、`action`、`ack`、`zone`、`pong`、`error` 與所有上行訊息維持 JSON 文字。解碼後的形狀與 v1 相同（`{ t: 'moves' | 'sync', m: MoveTuple[] }`），前端的插值、`sync` 直接套用與短編號對照不變。實作：伺服器 `server/src/protocol.rs`（`encode_batch`／`decode_batch`，連線層由 `ServerMessage::to_frame()` 選文字或二進位）；前端 `web/src/game/net/moveFrame.ts`（mock 伺服器直接載入同一個檔案）。

幀 = 1 byte 幀型 + N 筆 × 6 bytes，N = (長度 − 1) ÷ 6，0 ≤ N ≤ 200（`MAX_MOVES_PER_MESSAGE`，最大幀 1,201 bytes）。多位元組整數為 little-endian。

| 位移 | 長度 | 型別 | 內容 |
| --- | --- | --- | --- |
| 0 | 1 | u8 | 幀型：`0x01` = `moves`、`0x02` = `sync`；其他值拒絕 |
| 每筆 +0 | 1 | u8 | bit 7：moving（1 = 移動中）；bit 0～6：房內短編號 n（0～127） |
| 每筆 +1 | 2 | i16 | x，公分：`round(x × 100)`，.5 遠離零；限 ±10,000（±100 公尺，`MAX_COORD_CM`） |
| 每筆 +3 | 2 | i16 | z，公分，同上 |
| 每筆 +5 | 1 | u8 | heading：`q = round(heading × 128 ÷ π) mod 256`；解碼 `(q ≤ 128 ? q : q − 256) × π ÷ 128`，範圍 (−π, π] |

範圍與精度：

- **座標**：兩個場景的邊界是庭院 x −19～19、z −19～18，殿內 x −7.4～7.4、z −5.2～8.6（`server/src/world.rs`），伺服器先夾進場景邊界再編碼，量化後最大 ±1,900 公分，i16 可放 ±32,767。解碼端把 ±100 公尺外的值視為壞資料（留 5 倍餘裕給之後的場景），編碼端也夾在這個範圍內。精度 0.01 公尺，與上行與 v1 的 `round2` 相同；伺服器 tuple 本來就先取到 0.01，所以座標是無損的。
- **heading**：一格 2π/256 ≈ 0.0245 弧度（1.41°），最大誤差 0.7°。v1 是 0.01 弧度；角色朝向差 0.7° 在畫面上看不出來，本人校正（`correctLocal`）只用座標、不用 heading。
- **短編號**：由 u16 縮成 7 位元。伺服器配發最小的未使用編號且房間上限 50（`MAX_ROOM_CAPACITY`，有編譯期檢查 ≤ 128），實際只會用到 0～49。mock 伺服器只有一個房間，機器人上限因此是 127。
- **筆數**：從長度推算，不另存；長度不是 1 + 6N、超過 200 筆、座標超出範圍都整則拒絕（與 JSON「任一筆錯就整則丟棄」相同）。

解碼的拒絕條件在前端（`moveFrame.ts` 的 `decodeBatch`）與 Rust（`decode_batch`，負載工具與測試使用）一致，並由共用固定資料 `server/tests/protocol-v2.json`（v3 起為 `protocol-v3.json`）的 `binary.invalid` 驗證。`binary.valid` 的每筆有 `input`（伺服器編碼前的 tuple）、`hex`（幀）與 `decoded`（解碼結果）：Rust 測試（`tests/protocol.rs`）檢查 `encode(input) == hex`、`decode(hex) ≈ decoded`；前端測試（`protocol-fixtures.test.ts`）檢查 `decode(hex)` 與 `decoded` 完全相同、mock 用的編碼器輸出等於 `hex`。測試向量由獨立的第三份實作 `server/tests/protocol-v2-vectors.py`（Python，輸出 `binary` 這一段）產生，不是由任一邊的程式輸出回填；要增修向量時改這個腳本再貼回固定資料。

**版本策略：升版到 2，不做握手協商。** 理由：

- 前端與伺服器一起部署，舊前端只會出現在部署當下仍開著的分頁；`unsupported_version` → 不再重連 → 提示「遊戲已更新，請重新整理頁面」的流程已經存在並有測試，重新整理就拿到新前端。
- 協商（hello 帶支援的編碼）要讓伺服器與 mock 永久維護 JSON 與二進位兩套 `moves` 路徑，測試加倍，換到的只是「部署時開著的分頁可以不重新整理」。
- 兩個方向都不會靜默壞掉：舊前端（v1）連新伺服器，在 `hello` 就收到 `unsupported_version` 並以 1008 關閉（`tests/websocket.rs` 的 `unsupported_version_then_close` 驗證 v1 與 v3），不會收到它解不開的二進位幀；新前端（v2）連舊伺服器，同樣收到 `unsupported_version`、停止重連並提示。後者的提示文字說「遊戲已更新」不完全貼切（其實是伺服器較舊），但只在部署順序錯誤時發生，且不是靜默故障。mock 伺服器也檢查 `hello.v`。
- 上行仍是文字：伺服器收到二進位訊息照舊以 1003 關閉。

### T8 完成紀錄（2026-11-15）

`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`（62 個測試）通過；前端 `npm run typecheck`、`npm test`（103 個測試）、`npm run build` 通過。報告：[LOAD_TEST_2026-11-15_T8.md](LOAD_TEST_2026-11-15_T8.md)（6 個情境各 60 秒，改動前以 T8 前的 commit 在同一台機器重跑，附原始 JSON 輸出）。

- 結果：`moves` 降為約 1/4（50% 情境每連線 5,438 → 1,354 bytes/s），每連線總接收量 10% 情境 1,521～1,542 → 558～567 bytes/s（−63%）、50% 情境 5,760～5,812 → 1,625～1,651 bytes/s（−72%）。**仍未達 150～460 bytes/s 預算**：10% 情境超出上限約 100 bytes/s（主因是仍為 JSON 的 `action` 廣播，約 275 bytes/s），50% 情境的 `moves` 本身就是上限的 2.9 倍。另估算線路上每則訊息還有約 64～76 bytes 的 WebSocket／TLS／TCP／IP 固定成本，每秒約 13 則就已超過 460（未量測）。後續建議見報告「其他手段」，優先順序：`action` 改用短編號或併入 tick 幀 → 降低更新頻率或只送附近玩家（會改變體感，需實機評估）。
- 上行 `move`／`stop` 不改二進位：每位移動中的玩家約 515 bytes/s，是伺服器入站流量，不計入出站預算（數字與理由見報告）。
- 負載工具：逐則解碼二進位幀（`invalid_frames`）、依訊息種類統計（`recv_by_kind`）、另算含 WebSocket 框架的 bytes（`recv_ws_bytes_per_conn_s`）；hello 帶 `PROTOCOL_VERSION`。`/metrics` 的 `temple_bytes_out_total` 改為酬載 bytes（JSON 或二進位）。
- 多人驗證：正式後端（release，本機）＋ dev server，兩個各自獨立行程的無頭 Chrome（CDP，經 `window.__game` 驅動玩家 A、讀取玩家 B 看到的 A），16 項全部通過：連線與短編號對照；A 走動中 B 看到移動中；A 停下後 B 在 1 秒內看到停止（實測 1～87 ms），`moving: 0` 只收到一次；停下後 B 的 A 位置與 A 本機相差 0（座標無損），面向差 0.004～0.010 弧度；A 進殿後 B 收到 `zone`；A 在殿內走到 (3, 3) 後 B 進殿，B 收到含 A 的 `sync` 且位置等於 A 本機、直接套用（顯示位置 = 目標位置）；A 看到 B 進殿；A 在本機瞬移 10.36 公尺後走一步，伺服器拒絕並送只含 A 的 `sync`，A 回到伺服器上的位置，B 從沒看到 A 在瞬移後的位置；兩頁沒有例外。同一腳本對 mock 伺服器（不驗證位置，所以略過校正項）13 項全部通過。另以腳本確認 mock 對 `hello.v: 1` 回 `unsupported_version` 並以 1008 關閉。

未做到：

- 沒有在真實手機或弱網路下驗證，也沒有量測線路上（TLS／TCP）的實際 bytes；這些留給 T9。
- CPU 比較不可靠：今天兩組數字都明顯高於 T7、方向不一致，判斷不出二進位編碼對 CPU 的影響（見報告）。沒有做 profile。
- 新前端連舊伺服器時的提示文字是「遊戲已更新，請重新整理頁面」，嚴格說是伺服器較舊；提示文字在 `GameCore.ts`，不在本任務範圍，沒有改。
- 無頭 Chrome 沒有使用者手勢，`enter()` 的音訊解鎖不會完成，驗證腳本直接呼叫連線部分；畫面上的角色朝向與走路動畫沒有以截圖人工確認，只比對了資料。
- mock 伺服器直接載入 `src/game/net/moveFrame.ts`（v3 起改名為 `binaryFrame.ts`），需要 Node 22.18 以上（內建型別移除）；本機為 22.23。

### 協定版本 3：action 二進位幀（2026-11-16）

T8 報告指出 10% 移動情境剩下的超出量主要來自仍為 JSON 的 `action` 廣播（每則約 103 bytes：34 bytes 的字串 `playerId`、動作 id 字串、13 位數的毫秒時間戳）。v3 只把**伺服器下行的 `action`** 改為固定 7 bytes 的二進位幀；上行的 `action`（帶 `reqId`）與 `ack` 維持 JSON（理由見下）。解碼後交給上層的形狀與 v2 完全相同（`{ t: 'action', playerId, id, startedAt }`，`startedAt` 為伺服器的 Unix 毫秒），GameCore、玩法模組與 `actionPerformed` 事件都沒有改。實作：伺服器 `server/src/protocol.rs`（`encode_action`／`decode_action`／`unwrap_started_at`，`ServerMessage::Action { n, id, started_at }` 由 `to_frame()` 編成二進位）；前端 `web/src/game/net/binaryFrame.ts`（`encodeAction`／`decodeAction`／`unwrapStartedAt`，原 `moveFrame.ts` 改名，mock 伺服器直接載入）與 `protocol.ts` 的 `FrameContext`。

| 位移 | 長度 | 型別 | 內容 |
| --- | --- | --- | --- |
| 0 | 1 | u8 | 幀型 `0x03`（`0x01`／`0x02` 仍是 `moves`／`sync`，格式不變；其他值拒絕） |
| 1 | 1 | u8 | 執行者的房內短編號 n（0～127；bit 7 保留，非 0 即拒絕） |
| 2 | 1 | u8 | 動作編號：`world::ACTIONS` 的索引（0 `bow`、1 `prostrate`、2 `chant`、3 `chant_end`、4 `incense`、5 `bell`） |
| 3 | 4 | u32 LE | `startedAt mod 2^32`（`startedAt` 為非負整數毫秒；伺服器的值本來就是 `as_millis()`） |

長度必須剛好 7 bytes，否則整則拒絕。

- **短編號 → playerId**：`NetworkClient` 持有一個 `FrameContext`，對每則解出的訊息呼叫 `observe()`：`welcome` 重建 `n → id`（含自己）、`join` 加入（同一玩家換編號時先移除舊的）、`leave` 移除。伺服器保證同一條連線上 `join` 一定比該玩家的 `action` 早到，`leave` 之後不再有他的 `action`。**對照不到的 n**（理論上只會是協定錯誤）與**未知的動作編號**都讓 `decode()` 回傳 `null`、整則忽略，不會以錯誤的玩家或動作播放；兩者都有測試（`NetworkClient.test.ts`、`protocol-fixtures.test.ts`、固定資料 `binary.action.invalid`）。
- **startedAt 的回繞**：只送低 32 位元（每 2^32 ms ≈ 49.7 天回繞一次）。客戶端以「估計的伺服器現在時間」為參考值 R（`performance.now()` + 最近一次 `welcome`／`pong` 的 `serverTime − performance.now()`），取 mod 2^32 相同且離 R 最近的值：`startedAt = floor(R) + d`，`d = (low − floor(R)) mod 2^32` 換到 [−2^31, 2^31)。只要真正的 `startedAt − R` 在 [−2^31, 2^31) ms（約 ±24.8 天）內就還原無誤，跨過回繞點也一樣（有測試向量）。實際差距只有轉送延遲加上時鐘估計誤差（毫秒到秒）；手機分頁凍結數小時後才一次收到也仍正確，所以敲鐘的撞擊時刻（`startedAt + BELL_HIT_MS`）、誦經的節拍格、晚到的「起身」都與 v2 語意相同。範圍外（差距超過 24.8 天）會解成相差 2^32 ms 的值，實務上不會發生（連線不可能維持那麼久不收 `welcome`）。為什麼不用更短的相對時間：u16 只有 ±32.8 秒，分頁凍結超過半分鐘就會把舊動作解成未來的時間（鎖住角色）；u24 有 ±2.3 小時、省 1 byte，風險與省下的量（約 2.6 bytes/s）都很小，選擇了沒有實務風險的 u32。
- **動作編號對照表**是協定的一部分，只存在兩份：伺服器 `world::ACTIONS`（同時是允許清單，負載工具直接引用，不再有自己的副本）與前端 `ACTION_CODES`（mock 伺服器直接當允許清單，不再有自己的副本）。兩邊的測試都比對固定資料的 `binary.action.codes`，任一邊改了順序或內容測試就失敗。新動作只能加在尾端（舊客戶端收到不認得的編號會整則忽略，與 v2 時不認得動作 id 的效果相同）；改順序或刪除要升協定版本。
- **固定資料**改名為 `server/tests/protocol-v3.json`（依 v1 → v2 的慣例），JSON 範例移除了 `action`（v3 只以二進位送出，JSON 的 `action` 視為無效）；`binary.action` 有 `codes`、`valid`（`input` → `hex` → `decoded`，每個動作一筆，含 n = 127、低 32 位元 = 0 與 2^32 − 1）、`invalid`（長度不符、n ≥ 128、未知動作編號）與 `unwrap`（一般延遲、時鐘估計偏快、小數參考值、跨回繞兩個方向、凍結 10 分鐘、延遲 20 天、範圍邊界與範圍外）。向量由獨立的 `server/tests/protocol-v3-vectors.py`（原 v2 腳本加上 action 的實作）產生，不是由任一邊的輸出回填。原本 v2 向量中的「未知幀型 0x03」改為 0x04（0x03 現在是 action）。
- **上行 `action` 與 `ack` 不改**：上行是入站流量，不計入出站預算（同 T8 對 `move`／`stop` 的理由）；`ack` 只回給執行者本人，負載測試中每連線約 2 bytes/s（0.05 則/s），改二進位省不到 2 bytes/s，卻要讓 `reqId` 的去重快取與重送路徑多一套格式。
- **版本**：升為 3，策略同 v2（不做握手協商）。v1／v2 的前端連到 v3 伺服器在 `hello` 就收到 `unsupported_version` 並以 1008 關閉（`tests/websocket.rs` 驗證 v1、v2、v4），不會收到它解不開的 action 幀；mock 伺服器同樣檢查 `hello.v`。

### 協定版本 3 完成紀錄（2026-11-16）

`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`（66 個測試）通過；前端 `npm run typecheck`、`npm test`（143 個測試）、`npm run build` 通過。報告：[LOAD_TEST_2026-11-16_ACTION.md](LOAD_TEST_2026-11-16_ACTION.md)（50／500 連線 × 10%／50% 各 60 秒，改動前以 `b2359ca` 今天在同一台機器重跑，附原始 JSON 輸出）。

- 結果：每則 `action` 由約 104 bytes 降為 7 bytes；每連線總接收量 10% 情境 547～563 → **303～304 bytes/s**（−45%）、50% 情境 1,634～1,647 → **1,384～1,385 bytes/s**（−16%）。**10% 情境的酬載進入 150～460 預算；50% 情境沒有**，剩下的是 `moves` 本身（1,354 bytes/s）。每秒訊息數沒有變（約 13 則），T8 估算的線路固定成本（約 830～990 bytes/s，未量測）也沒有變，以 IP 層計費時兩個情境都還超出預算。下一步見報告：把 `action` 併進 tick 幀以減少則數、降低 tick 或興趣範圍（會改變體感）、T9 實測線路 bytes。
- 多人驗證（無頭 Chrome + CDP，兩個獨立的 Chrome 程序當玩家 A、B，經 `window.__game` 驅動 A、讀 B 收到的訊息與畫面狀態）：mock 伺服器（0 機器人）16 項全部通過；正式後端（release，本機）17 項，第一輪 15／17（A 剛載入時送出的合十晚約 400 ms 才到伺服器，`startedAt` 是伺服器收到的時刻，所以與 A 本機開始時刻差 400 ms，片段也已在檢查前播完；B 還原出的值仍與伺服器的值一致），重跑一輪 17／17。檢查內容：B 名單中 A 的短編號；合十、敲鐘、誦經、起身四個動作 B 都收到、`playerId` 與 `id` 正確；B 還原的 `startedAt`（整數 Unix 毫秒）與 A 本機開始時刻（換成牆鐘）相差 0.3～11 ms；B 的 `actionPerformed.startedAt + serverOffset` 與訊息的 `startedAt` 完全相等（GameCore 的換算語意不變）；B 上 A 的動作片段是 `bow`／`chant`；B 的撞木時間軸起點等於事件的 `startedAt`（撞擊時刻 = `startedAt + BELL_HIT_MS`）；誦經 3 秒後 B 上的 A 仍鎖定約 20～21 秒；A 提前起身後 B 收到 `chant_end` 並解除鎖定。進殿在正式後端是實際走進殿門出入口。

未做到：

- 沒有以截圖或耳朵確認畫面與聲音（無頭 Chrome 沒有使用者手勢，音訊沒有解鎖）；撞擊時刻與誦經節拍只比對了資料（撞木與玩法收到的 `startedAt`），沒有量測實際出聲的時刻。
- 沒有真實手機、弱網路與跨機器時鐘的驗證；回繞處理只以測試向量驗證（實際要 49.7 天才會遇到一次回繞）。
- CPU 比較仍不可靠（每情境一輪、方向不一致），沒有做 profile。

### 協定增修：文字聊天 `chat`（2026-11-16，向下相容，不升版號）

- **上行** `{ "t": "chat", "text": string }`：原始字串上限 `MAX_CHAT_RAW_BYTES`（512 UTF-8 bytes），超過或缺欄位／型別不符都是無效訊息（走無效訊息計數）。
- **清理**（`protocol::clean_chat`）：移除控制字元（C0、C1）與 U+200B～U+200F、U+202A～U+202E、U+2066～U+2069、U+FEFF；連續空白（含換行、tab）壓成單一空格；trim；最多 `CHAT_MAX_CHARS`（80）個 Unicode 字元（char，不是 byte）。清理後為空就丟棄，不回錯誤。
- **限速**：`rate_limit.rs` 的 chat bucket 突發 3、每秒補充 0.5；同時算入全部訊息的總 bucket。超出者丟棄，沿用「超出計數／連續超出關閉連線」。
- **下行** `{ "t": "chat", "id", "text", "at" }`（JSON；`at` 為伺服器 Unix 毫秒）：由房間 actor 廣播給同房所有在線玩家，不分場景，含發話者本人；斷線保留中的玩家不送。連線層到房間的指令以 `try_send` 送出（佇列滿時丟棄）。
- 固定資料 `protocol-v3.json` 的 `client`／`server` 各加一筆；缺 `text`、`text` 非字串的案例在 `tests/protocol.rs`。

### 協定增修：玩家衣裝 `outfit`（2026-11-16，向下相容，不升版號）

衣裝是整數編號 `0..OUTFIT_COUNT-1`（`OUTFIT_COUNT = 6`，`protocol::OUTFIT_COUNT`；前端 `protocol.ts` 同名，固定資料 `protocol-v3.json` 的 `outfitCount` 鎖住兩邊）。外觀由客戶端決定，伺服器只驗證範圍、保存、轉送。

- **`hello`** 新增可選欄位 `outfit`：缺少或無效（非整數、超出範圍、型別不符）一律當作 0，不拒絕連線（`protocol::parse_outfit`）。
- **`PlayerSnapshot`** 新增 `outfit`（伺服器一律送出），`welcome.players` 與 `join` 因此帶衣裝。前端把缺少視為合法（舊伺服器相容），有值但不是範圍內整數則整則忽略。
- **上行** `{ "t": "outfit", "outfit": n }`（不需 reqId／ack）：無效值丟棄（不計入無效訊息）；`rate_limit.rs` 的 outfit bucket 與 chat 同規則（突發 3、每秒補 0.5，計數各自獨立，同時算入總 bucket）；與目前相同不廣播；否則保存並廣播下行 `{ "t": "outfit", "id", "outfit" }`（JSON）給同房所有在線玩家，不分場景、含本人。連線層到房間的指令以 `send().await` 送出（是狀態，不可丟棄）。
- **恢復連線**：衣裝留在玩家狀態裡，斷線保留期間與 `resumeToken` 恢復都保留。恢復時 `hello` 帶了有效且不同的 `outfit` 以它為準（`welcome` 已含新值），並在 `welcome` 送出後對其他人廣播一則 `outfit`；相同或沒帶則不廣播。
- **客戶端**：`NetworkClient.setOutfit(n)` 記住衣裝（每次 `hello` 都帶，含重連），已連線時送出；客戶端限速（補充間隔多留 10%）擋下時只保留最新的一個值、額度恢復後補送，不排隊；斷線時不送。
- 固定資料 `protocol-v3.json` 加入 `outfitCount`、帶衣裝的 `hello`／`welcome`／`join`、上行與下行 `outfit`（手寫，`protocol-v3-vectors.py` 只產生 `binary` 一段，不會覆蓋）；測試在 `tests/protocol.rs`、`tests/gameplay.rs`、`src/room/tests.rs`、`src/rate_limit.rs` 與前端 `net/outfit.test.ts`。負載工具的機器人 `hello` 帶隨機衣裝。

## T9 部署與正式環境壓測（P1）

Dokploy 上部署伺服器映像與前端靜態檔；前端建置設定 `VITE_WS_URL`；WebSocket 經反向代理的逾時與升級設定；日誌輪替；以外部機器對正式環境重跑 T7 情境；確認 1 vCPU／2 GiB 在 Dokploy、代理與（未來）PostgreSQL 同時運作時的餘裕。

### T9 狀態（2026-11-16）

- **已準備**（細節與步驟見 [DEPLOY.md](DEPLOY.md)）：`web/Dockerfile`＋`web/deploy/nginx.conf`（SPA 回退、MIME、快取、gzip）、`deploy/docker-compose.yml`＋`deploy/.env.example`（Dokploy Domains 分頁設網域，不手寫 Traefik 標籤；healthcheck、記憶體上限、日誌輪替、`stop_grace_period: 5s`）、伺服器 `--healthcheck` 子命令（distroless 沒有 curl）、CI 的 web 映像建置檢查。兩個映像已在本機 Docker 建置並實測回應標頭與健康檢查。
- **尚未做**：主機、網域與 Dokploy 皆未提供，沒有實際部署；Traefik 路由／TLS／wss、`/metrics` 不外洩、正式環境壓測與 1 vCPU／2 GiB 餘裕判斷都未執行。`loadtest` 不支援 `wss://`（壓測改走暫時的 HTTP 測試網域，TLS 成本未計）。

## T10 持久化（P2）

等玩法定案：決定要保存的資料（例如帳號、累計次數）後再設計資料表、連線池大小與寫入批次策略。在此之前不建立 PostgreSQL 依賴。
