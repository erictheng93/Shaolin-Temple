# 負載測試報告（協定版本 3：action 二進位幀）2026-11-16

目的：量出把伺服器下行的 `action` 廣播由 JSON 改為 7 bytes 二進位幀（協定版本 3，格式見 [BACKEND_TASKS.md](BACKEND_TASKS.md#協定版本-3action-二進位幀2026-11-16)）前後的每連線接收量，並與 [TECH_STACK.md](TECH_STACK.md) 的流量預算比較。接續 [LOAD_TEST_2026-11-15_T8.md](LOAD_TEST_2026-11-15_T8.md)「其他手段」中建議優先做的「`action` 改用短編號」。**這是開發機本機迴路的量測，不是目標主機（1 vCPU／2 GiB）的容量聲明**（見「限制」）。

## 量測方法（與 T7／T8 相同）

| 項目 | 內容 |
| --- | --- |
| 機器 | 與 T7／T8 同一台：Intel Core i7-13700F（16 核心／24 執行緒）、15.9 GB RAM、Windows 11 IoT Enterprise LTSC 2024 |
| 改動前（v2） | 分支 `multiplayer/backend-p0` 的 `b2359ca`（以 `git archive` 取出 `server/`），今天以 `cargo build --release` 建置並重跑，**不沿用 T8 報告的數字**；`PORT=18191` |
| 改動後（v3） | 分支 `t8/action-compact` 的程式（與提交的內容相同），`cargo build --release`；`PORT=18192` |
| 共同設定 | `RUST_LOG=warn`，其餘預設（`ROOM_CAPACITY=50`、`TICK_HZ=10`）；rustc 1.95.0 |
| 每個情境 | 重新啟動一個伺服器程序；負載工具以 5 ms 間隔建立連線，等 2 秒暖機後量測 60 秒；兩組依序執行（先改動前 4 個情境、再改動後 4 個），不同時跑 |
| 指令 | `loadtest --url ws://127.0.0.1:<埠>/ws --connections N --moving-ratio R --seconds 60 --ramp-ms 5 --settle-ms 2000` |
| 負載工具 | 各組用自己版本的 `loadtest`（v2 的解 v2、v3 的解 v3）；行為相同：移動者 10 Hz 送 `move`、每人每 10～25 秒一個隨機動作（6 種之一）、20 秒一次 `ping`。v3 的負載工具逐則以 `decode_action`／`decode_batch` 驗證二進位幀 |
| CPU／RSS | PowerShell 每 250 ms 取伺服器程序的 `TotalProcessorTime` 與 `WorkingSet64`，只取「量測開始」～「量測結束」之間；100% = 一個核心 |

情境：50 連線（1 房）與 500 連線（10 房，每房 50 人）× 房內移動比例 10%／50%。T8 已顯示每連線接收量只取決於「房內移動中的人數」，與總連線數無關（200 連線的數字介於兩者之間），本次略過 200 連線。

## 結果：每連線接收量

bytes 為 WebSocket 酬載長度（JSON 文字或二進位幀），不含 WebSocket 框架與 TCP／IP；每連線數字為量測 60 秒的平均。兩組所有情境都是 N 條連線全部成功、沒有被伺服器關閉，`invalid_frames` = 0。

| 連線 | 移動比例 | 改動前 bytes/s | 改動後 bytes/s | 減少 | 其中 action：前 → 後（則/s） | 每連線 則/s（前／後） | 含 WS 框架（前 → 後） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 10% | 547 | **303** | −44.6% | 261.8 → 18.3（2.51／2.61） | 12.9／12.9 | 573 → 329 |
| 50 | 50% | 1,634 | **1,384** | −15.3% | 269.8 → 18.4（2.58／2.63） | 13.6／13.7 | 1,677 → 1,427 |
| 500 | 10% | 563 | **304** | −46.0% | 277.9 → 18.7（2.66／2.67） | 13.0／13.0 | 589 → 330 |
| 500 | 50% | 1,647 | **1,385** | −15.9% | 280.7 → 19.1（2.69／2.73） | 13.8／13.8 | 1,689 → 1,429 |

- 每則 `action` 由約 104 bytes（伺服器 `/metrics` 的 `temple_bytes_out_total{t="action"}` ÷ 則數：50 連線 785,519 ÷ 7,546 = 104.1、500 連線 8,563,118 ÷ 82,116 = 104.3）降為**剛好 7 bytes**（54,880 ÷ 7,840、571,438 ÷ 81,634），約 1/15。
- 動作的則數兩組相同（負載工具的動作是隨機的，2.5～2.7 則/s 的差異是取樣雜訊）；`moves` 兩組完全相同（10% 約 278.6、50% 約 1,353.7 bytes/s），因為格式沒變。
- 今天改動前的 10% 情境（547～563）與 T8 報告的改動後（558～567）在 2% 以內，基準一致。

### 改動後的組成（每連線 bytes/s，則/s）

| 情境 | moves | action（二進位） | sync | ack | pong | 合計 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 連線 10% | 278.5（10.0） | 18.3（2.61） | 1.6（0.23） | 2.0（0.05） | 2.9（0.05） | 303 |
| 50 連線 50% | 1,353.5（10.0） | 18.4（2.63） | 6.8（0.97） | 2.0（0.05） | 2.9（0.05） | 1,384 |
| 500 連線 10% | 278.7（10.0） | 18.7（2.67） | 1.5（0.22） | 2.1（0.05） | 2.9（0.05） | 304 |
| 500 連線 50% | 1,354.0（10.0） | 19.1（2.73） | 7.0（1.00） | 2.1（0.06） | 2.9（0.05） | 1,385 |

改動後 `moves` 占 92～98%；`action` 只剩 6%（10%）與 1.3%（50%）。`ack` 與 `pong` 合計約 5 bytes/s，改二進位最多省約 4 bytes/s，所以維持 JSON。

## 與流量預算比較

預算：每人每秒 150～460 bytes（TECH_STACK「流量預算範例」）。

| 情境（房內移動比例） | 改動前（今天重跑） | 改動後 | 相對上限 460（改動後） | 結論 |
| --- | --- | --- | --- | --- |
| 10%（每房 5 人移動） | 547～563 | **303～304**（含 WS 框架 329～330） | 0.66 倍 | **酬載進入預算**（落在 150～460 之間） |
| 50%（每房 25 人移動） | 1,634～1,647 | **1,384～1,385**（含 WS 框架約 1,428） | 3.0 倍 | **未達預算**，剩下的主因是 `moves` 本身（1,354 bytes/s，已是上限的 2.9 倍） |

**誠實的結論：**

1. **只看酬載（以及 WebSocket 框架），10% 情境已進入 150～460 bytes/s 的預算；50% 情境沒有達到**，超出上限約 925 bytes/s。50% 情境剩下的幾乎全是 `moves`（10 Hz × 約 22.5 位移動者 × 6 bytes），編碼已省不下去，要進預算必須減少「每秒送幾次 × 送幾個人」（降低 tick 或興趣範圍，見 T8 報告，都會改變體感，需實機評估）。
2. **線路上的固定成本沒有改變**：本次只縮小了每則 `action` 的大小，**每秒訊息數不變**（每連線約 12.9～13.8 則/s）。T8 報告估算每則下行訊息在線路上另有約 64～76 bytes（WebSocket 2 + TLS 1.3 記錄約 22 + TCP／IPv4 40～52，若每則各成一個封包），每秒約 13 則 ≈ 830～990 bytes/s（估算、未量測），**光這部分就超過 460**。所以若 VPS 以 IP 層計費，10% 情境實際上也還沒進入預算。要降這部分，得把 `action` 併進同一 tick 的幀（每秒少約 2.6 則、估計省約 170～200 bytes/s 的線路成本，代價是動作最多晚 100 ms 顯示），或降低 tick；實際值要在 T9 以正式環境的介面計數器量測。

## 伺服器資源

| 連線 | 移動比例 | 伺服器 CPU（%，一核=100）前／後 | RSS 平均／最大 (MB) 前 | RSS 平均／最大 (MB) 後 | 出站總頻寬（酬載）前 → 後 | moves 到達間隔 p50／p99／max（ms）前 → 後 | 丟棄 moves／sync、慢速關閉 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 10% | 5.0／1.3 | 8.7／8.7 | 10.6／10.7 | 27.3 → 15.2 KB/s | 94.7／111.4／113.2 → 94.8／111.2／112.1 | 皆 0 |
| 50 | 50% | 4.7／7.8 | 8.9／8.9 | 8.7／8.7 | 81.7 → 69.2 KB/s | 94.7／111.5／112.6 → 94.7／111.2／113.3 | 皆 0 |
| 500 | 10% | 27.4／19.6 | 20.0／20.4 | 20.4／20.5 | 281.5 → 151.9 KB/s | 95.1／112.1／115.2 → 95.1／111.7／114.1 | 皆 0 |
| 500 | 50% | 25.7／33.6 | 20.8／20.9 | 20.8／21.0 | 823.4 → 692.6 KB/s | 95.1／111.9／117.1 → 95.2／111.7／115.3 | 皆 0 |

- 出站總頻寬取負載工具的 `total_recv_bytes_s`（所有連線收到的酬載合計）。
- **CPU 的解讀**：與 T8 相同，兩組相差的方向不一致（10% 改動後較低、50% 改動後較高），每情境只跑一輪，背景負載的雜訊大於編碼的差異；**本次 CPU 數字不足以判斷影響**，只能說在同一量級。合理預期是略降（每位收件人少序列化約 100 bytes 的 JSON，改為複製 7 bytes），未以 profile 證實。RSS 兩組相同量級。
- `moves` 的到達間隔兩組相同（Windows 計時器 15.6 ms 顆粒度，同 T7／T8）。

## 限制

- **本機迴路**：同一台 Windows 開發機、127.0.0.1，沒有網路延遲、封包遺失或慢速接收者。
- **非目標主機**：目標是 1 vCPU／2 GiB 的 Linux VPS；本機是 24 執行緒的桌面 CPU，也沒有計入反向代理、Dokploy 與 PostgreSQL。
- **只計酬載**：不含 TLS 與 TCP／IP；線路固定成本只有估算（見上）。
- **CPU 雜訊大、每情境一輪、60 秒**（不足以證明長時間不洩漏）。
- **模擬玩家**：動作頻率（每人每 10～25 秒一個）是負載工具的假設，不是真人資料；`action` 縮小後它對總量的影響已很小（約 18 bytes/s），所以這個假設的誤差對結論影響也小。

## 重現

```powershell
cd server
cargo build --release
$env:PORT = "18192"; $env:RUST_LOG = "warn"
Start-Process target/release/temple-server.exe       # 另一個程序
target/release/loadtest.exe --url ws://127.0.0.1:18192/ws --connections 500 --moving-ratio 0.1 --seconds 60
curl http://127.0.0.1:18192/metrics
```

改動前的數字：以 `git archive b2359ca server` 取出 v2 的伺服器與負載工具，在另一個目錄同樣建置與執行（`PORT=18191`）。

## 原始輸出

各情境負載工具輸出的最後一行（機器可讀 JSON）。

### 改動前（v2，`b2359ca`，今天重跑）

`c50-m10`：

```json
{"closed_by_server":0,"connect_failed":0,"connected":50,"connections":50,"failure_reasons":{},"invalid_frames":0,"moves_interval_ms":{"max":113.21,"p50":94.68,"p99":111.39,"samples":29950},"moving_players":5,"moving_ratio":0.1,"recv_by_kind":{"ack":{"bytes_per_conn_s":1.89,"msgs_per_conn_s":0.05},"action":{"bytes_per_conn_s":261.76,"msgs_per_conn_s":2.51},"moves":{"bytes_per_conn_s":278.63,"msgs_per_conn_s":10.0},"pong":{"bytes_per_conn_s":2.88,"msgs_per_conn_s":0.05},"sync":{"bytes_per_conn_s":1.78,"msgs_per_conn_s":0.25}},"recv_bytes_per_conn_s":546.94,"recv_moves_bytes_per_conn_s":278.63,"recv_moves_msgs_per_conn_s":10.0,"recv_msgs_per_conn_s":12.87,"recv_ws_bytes_per_conn_s":572.68,"seconds":60.02,"sent_bytes_per_conn_s":55.56,"sent_msgs_per_conn_s":1.02,"total_recv_bytes_s":27347.19,"url":"ws://127.0.0.1:18191/ws"}
```

`c50-m50`：

```json
{"closed_by_server":0,"connect_failed":0,"connected":50,"connections":50,"failure_reasons":{},"invalid_frames":0,"moves_interval_ms":{"max":112.6,"p50":94.74,"p99":111.46,"samples":29950},"moving_players":25,"moving_ratio":0.5,"recv_by_kind":{"ack":{"bytes_per_conn_s":1.94,"msgs_per_conn_s":0.05},"action":{"bytes_per_conn_s":269.77,"msgs_per_conn_s":2.58},"moves":{"bytes_per_conn_s":1353.65,"msgs_per_conn_s":10.0},"pong":{"bytes_per_conn_s":2.88,"msgs_per_conn_s":0.05},"sync":{"bytes_per_conn_s":6.1,"msgs_per_conn_s":0.87}},"recv_bytes_per_conn_s":1634.34,"recv_moves_bytes_per_conn_s":1353.65,"recv_moves_msgs_per_conn_s":10.0,"recv_msgs_per_conn_s":13.55,"recv_ws_bytes_per_conn_s":1677.35,"seconds":60.01,"sent_bytes_per_conn_s":263.17,"sent_msgs_per_conn_s":4.67,"total_recv_bytes_s":81716.77,"url":"ws://127.0.0.1:18191/ws"}
```

`c500-m10`：

```json
{"closed_by_server":0,"connect_failed":0,"connected":500,"connections":500,"failure_reasons":{},"invalid_frames":0,"moves_interval_ms":{"max":115.21,"p50":95.12,"p99":112.09,"samples":299556},"moving_players":50,"moving_ratio":0.1,"recv_by_kind":{"ack":{"bytes_per_conn_s":2.05,"msgs_per_conn_s":0.05},"action":{"bytes_per_conn_s":277.86,"msgs_per_conn_s":2.66},"moves":{"bytes_per_conn_s":278.85,"msgs_per_conn_s":10.0},"pong":{"bytes_per_conn_s":2.9,"msgs_per_conn_s":0.05},"sync":{"bytes_per_conn_s":1.37,"msgs_per_conn_s":0.2}},"recv_bytes_per_conn_s":563.04,"recv_moves_bytes_per_conn_s":278.85,"recv_moves_msgs_per_conn_s":10.0,"recv_msgs_per_conn_s":12.96,"recv_ws_bytes_per_conn_s":588.97,"seconds":60.01,"sent_bytes_per_conn_s":55.95,"sent_msgs_per_conn_s":1.02,"total_recv_bytes_s":281519.96,"url":"ws://127.0.0.1:18191/ws"}
```

`c500-m50`：

```json
{"closed_by_server":0,"connect_failed":0,"connected":500,"connections":500,"failure_reasons":{},"invalid_frames":0,"moves_interval_ms":{"max":117.1,"p50":95.14,"p99":111.87,"samples":299500},"moving_players":250,"moving_ratio":0.5,"recv_by_kind":{"ack":{"bytes_per_conn_s":2.08,"msgs_per_conn_s":0.05},"action":{"bytes_per_conn_s":280.74,"msgs_per_conn_s":2.69},"moves":{"bytes_per_conn_s":1353.86,"msgs_per_conn_s":10.0},"pong":{"bytes_per_conn_s":2.9,"msgs_per_conn_s":0.05},"sync":{"bytes_per_conn_s":7.17,"msgs_per_conn_s":1.02}},"recv_bytes_per_conn_s":1646.74,"recv_moves_bytes_per_conn_s":1353.86,"recv_moves_msgs_per_conn_s":10.0,"recv_msgs_per_conn_s":13.82,"recv_ws_bytes_per_conn_s":1689.42,"seconds":60.0,"sent_bytes_per_conn_s":263.95,"sent_msgs_per_conn_s":4.68,"total_recv_bytes_s":823371.11,"url":"ws://127.0.0.1:18191/ws"}
```

### 改動後（v3）

`c50-m10`：

```json
{"closed_by_server":0,"connect_failed":0,"connected":50,"connections":50,"failure_reasons":{},"invalid_frames":0,"moves_interval_ms":{"max":112.14,"p50":94.8,"p99":111.2,"samples":29950},"moving_players":5,"moving_ratio":0.1,"recv_by_kind":{"ack":{"bytes_per_conn_s":1.96,"msgs_per_conn_s":0.05},"action":{"bytes_per_conn_s":18.29,"msgs_per_conn_s":2.61},"moves":{"bytes_per_conn_s":278.54,"msgs_per_conn_s":10.0},"pong":{"bytes_per_conn_s":2.89,"msgs_per_conn_s":0.05},"sync":{"bytes_per_conn_s":1.58,"msgs_per_conn_s":0.23}},"recv_bytes_per_conn_s":303.26,"recv_moves_bytes_per_conn_s":278.54,"recv_moves_msgs_per_conn_s":10.0,"recv_msgs_per_conn_s":12.94,"recv_ws_bytes_per_conn_s":329.14,"seconds":60.02,"sent_bytes_per_conn_s":55.72,"sent_msgs_per_conn_s":1.02,"total_recv_bytes_s":15162.86,"url":"ws://127.0.0.1:18192/ws"}
```

`c50-m50`：

```json
{"closed_by_server":0,"connect_failed":0,"connected":50,"connections":50,"failure_reasons":{},"invalid_frames":0,"moves_interval_ms":{"max":113.3,"p50":94.68,"p99":111.23,"samples":29950},"moving_players":25,"moving_ratio":0.5,"recv_by_kind":{"ack":{"bytes_per_conn_s":1.97,"msgs_per_conn_s":0.05},"action":{"bytes_per_conn_s":18.41,"msgs_per_conn_s":2.63},"moves":{"bytes_per_conn_s":1353.53,"msgs_per_conn_s":10.0},"pong":{"bytes_per_conn_s":2.89,"msgs_per_conn_s":0.05},"sync":{"bytes_per_conn_s":6.77,"msgs_per_conn_s":0.97}},"recv_bytes_per_conn_s":1383.57,"recv_moves_bytes_per_conn_s":1353.53,"recv_moves_msgs_per_conn_s":10.0,"recv_msgs_per_conn_s":13.7,"recv_ws_bytes_per_conn_s":1426.82,"seconds":60.01,"sent_bytes_per_conn_s":262.28,"sent_msgs_per_conn_s":4.67,"total_recv_bytes_s":69178.71,"url":"ws://127.0.0.1:18192/ws"}
```

`c500-m10`：

```json
{"closed_by_server":0,"connect_failed":0,"connected":500,"connections":500,"failure_reasons":{},"invalid_frames":0,"moves_interval_ms":{"max":114.14,"p50":95.07,"p99":111.72,"samples":299500},"moving_players":50,"moving_ratio":0.1,"recv_by_kind":{"ack":{"bytes_per_conn_s":2.06,"msgs_per_conn_s":0.05},"action":{"bytes_per_conn_s":18.69,"msgs_per_conn_s":2.67},"moves":{"bytes_per_conn_s":278.7,"msgs_per_conn_s":10.0},"pong":{"bytes_per_conn_s":2.9,"msgs_per_conn_s":0.05},"sync":{"bytes_per_conn_s":1.52,"msgs_per_conn_s":0.22}},"recv_bytes_per_conn_s":303.87,"recv_moves_bytes_per_conn_s":278.7,"recv_moves_msgs_per_conn_s":10.0,"recv_msgs_per_conn_s":12.99,"recv_ws_bytes_per_conn_s":329.86,"seconds":60.0,"sent_bytes_per_conn_s":55.91,"sent_msgs_per_conn_s":1.02,"total_recv_bytes_s":151936.78,"url":"ws://127.0.0.1:18192/ws"}
```

`c500-m50`：

```json
{"closed_by_server":0,"connect_failed":0,"connected":500,"connections":500,"failure_reasons":{},"invalid_frames":0,"moves_interval_ms":{"max":115.32,"p50":95.17,"p99":111.74,"samples":299500},"moving_players":250,"moving_ratio":0.5,"recv_by_kind":{"ack":{"bytes_per_conn_s":2.11,"msgs_per_conn_s":0.06},"action":{"bytes_per_conn_s":19.12,"msgs_per_conn_s":2.73},"moves":{"bytes_per_conn_s":1354.0,"msgs_per_conn_s":10.0},"pong":{"bytes_per_conn_s":2.9,"msgs_per_conn_s":0.05},"sync":{"bytes_per_conn_s":7.03,"msgs_per_conn_s":1.0}},"recv_bytes_per_conn_s":1385.15,"recv_moves_bytes_per_conn_s":1354.0,"recv_moves_msgs_per_conn_s":10.0,"recv_msgs_per_conn_s":13.84,"recv_ws_bytes_per_conn_s":1428.9,"seconds":60.0,"sent_bytes_per_conn_s":264.16,"sent_msgs_per_conn_s":4.68,"total_recv_bytes_s":692575.09,"url":"ws://127.0.0.1:18192/ws"}
```
