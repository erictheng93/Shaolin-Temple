# 玩家之間的硬碰撞 實作計畫

> **執行方式：** 後端（任務 1–3）由需求方實作、Claude 稽核；前端與 mock（任務 4–6）由 Claude 實作。步驟用 `- [ ]` 勾選追蹤。

**目標：** 步行的玩家互相不重疊、可以推動，且沒有人能完全擋住別人。

**架構：** 人與人的碰撞是一組純函式（圓形分離），前後端各一份、以共用固定資料鎖住結果。伺服器在既有的位置驗證之後套用，並以近期位置紀錄補償延遲；前端先行套用同樣的規則。

**技術：** Rust（`server/`）、TypeScript（`web/`）。不用 Rapier、不改協定。

**設計：** `docs/superpowers/specs/2026-11-21-player-collision-design.md`

## 全域限制

- 協定版本不變（5），不新增訊息或欄位。
- 伺服器 `try_send` 原則不變；房間不等待任何連線。
- 後端每個 PR 通過 `cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test`（Linux 與 Windows）；前端通過 `npm run typecheck`、`npm test`、`npm run build`。
- 說明、註解、提交訊息用繁體中文；識別字用英文。提交只 stage 明確路徑。
- 分支 `feat/player-collision`，從完成碰碰車任務 18 之後的 `feat/bumper-cars-server` 開出（兩者都改 `room.rs`）。

## 審查重點

1. **兩人站在同一點**（距離為 0）：不可除以零；結果要確定（以短編號小的往 −x、大的往 +x 分開）。
2. **被推的人背後是牆**：他不可被推進障礙物或邊界外；推的人被擋住。
3. **定點動作中的人**完全不動，即使被多人同時擠。
4. **延遲**：A 依 200 毫秒前的畫面走到 B 剛離開的位置，不應被糾正。
5. **糾正風暴**：兩人互相頂著不放時，雙方收到的 `sync` 受既有的 `CORRECTION_GAP` 節流，不會每個訊息都糾正。

## 共用的數值與算法

```text
BODY_RADIUS      = 0.3     // 人與人的碰撞半徑（公尺）
MIN_DIST         = 0.6     // 2 × BODY_RADIUS
TOLERANCE        = 0.15    // 重疊量不超過這個值時不處理（只用在驗證玩家送來的位置）
SEPARATE_PER_TICK= 0.1     // 每個 tick 每人最多被分開的距離
VIEW_DELAY_TICKS = 2       // 驗證時取對方幾個 tick 之前的位置
HISTORY_TICKS    = 4
PORTAL_REACH     = 0.6     // 庭院這一側的殿門觸發範圍往門前多延伸的距離（原訂 1.0，見任務 3 的說明）
```

**`resolve_move`：處理一個人的移動（前後端逐行相同）**

```text
輸入：mover = (x, z)        // 想去的位置（已通過邊界、額度與障礙物檢查）
      prev  = (x0, z0)      // 移動前的位置
      others = [{ n, x, z, rooted }]   // 同場景其他參與碰撞的人，依 n 由小到大
      tolerance             // 伺服器驗證時是 TOLERANCE，前端與分離時是 0
      valid(x, z) -> bool   // 在邊界內且不在加邊障礙物內
輸出：mover 的新位置，以及被推動者的新位置清單 [{ n, x, z }]

重複 2 輪：
  對 others 依序：
    dx = mover.x - o.x ; dz = mover.z - o.z ; d = sqrt(dx*dx + dz*dz)
    pen = MIN_DIST - d
    若 pen <= tolerance：跳過
    若 d < 1e-9：(ux, uz) = 以 (prev - o) 的方向；仍為零向量則 (1, 0)
    否則 (ux, uz) = (dx/d, dz/d)
    share = o.rooted ? 0 : 0.5          // 對方分擔的比例
    若 share > 0：
      (bx, bz) = (o.x - ux*pen*share, o.z - uz*pen*share)
      若 valid(bx, bz)：o 的位置改成 (bx, bz)，記入被推動清單
      否則 share = 0
    mover += (ux, uz) * pen * (1 - share)
若 !valid(mover)：mover = prev
```

**`separate`：每個 tick 的全體分離**

```text
// 2026-11-21 定稿（以前端已實作的 web/src/game/world/collide.ts 為準）：
// 所有配對都用「這個 tick 開始時」的位置計算，位移先加總、最後才套用，不邊算邊移。
bodies 依 n 由小到大排序；每人一個累計位移 delta = (0, 0)
對每一對 i < j（a = bodies[i]、b = bodies[j]）：
  若 a、b 都 rooted：跳過
  ex = a.x - b.x ; ez = a.z - b.z ; d = sqrt(ex*ex + ez*ez) ; pen = MIN_DIST - d
  若 pen <= 0：跳過
  (ux, uz) = d < 1e-9 ? (-1, 0) : (ex/d, ez/d)        // 由 b 指向 a；同一點時 n 小的往 −x
  sa = a.rooted ? 0 : (b.rooted ? 1 : 0.5) ; sb = 1 - sa
  delta[i] += (ux, uz) * pen * sa
  delta[j] -= (ux, uz) * pen * sb
對每個人（依排序）：
  len = |delta| ; 若 len < 1e-12：跳過
  若 len > SEPARATE_PER_TICK：delta *= SEPARATE_PER_TICK / len
  若 valid(x + delta.x, z + delta.z)：輸出 { n, 新位置 }
回傳輸出的清單（依 n 由小到大）
```

`resolve_move` 的補充（同樣以 `collide.ts` 為準）：`others` 先複製並依 `n` 排序；第二輪用的是第一輪推過之後的位置；被推動清單回傳每個人**最後**的位置、依 `n` 由小到大、每人只出現一次。

---

# 第 1 段：後端（需求方）

**先讀這些，照它們的寫法做：**

| 參考 | 用來學什麼 |
|---|---|
| `server/src/room.rs` 的 `fn position`（約 698 行） | 既有的位置驗證流程：邊界夾限 → 移動額度 → `zone.blocked` → 拒絕時以只含本人的 `sync` 糾正，並用 `corrected_at`／`CORRECTION_GAP` 節流。碰撞接在這之後 |
| `server/src/room.rs` 的 `fn tick`、`states()`、`send_batch` | tick 的結構、`dirty` 如何讓位置進 `moves` |
| `server/src/world.rs` 的 `Rect`、`Zone`（`bounds`、`obstacles`、`blocked`）、`PORTAL_TOLERANCE` 與 portal 定義 | `valid(x, z)` 的寫法；殿門觸發範圍在哪裡 |
| `server/src/vehicles/knock.rs` | 純函式模組加單元測試的樣子（`knock_landing` 的邊界與障礙物判斷可照抄） |
| `server/src/vehicles/world.rs` 的 `drive_script_matches_fixture` | 共用固定資料的讀寫方式與 `UPDATE_FIXTURES=1` 的慣例 |
| `server/src/room/tests.rs`、`room/vehicle_tests.rs` | 房間測試的輔助函式（`spawn_room`、`connect`、`drain`、`start_paused`） |
| `web/src/game/world/layout.ts`、`zones.ts` | 殿門與障礙物的數值來源（改殿門範圍時兩邊一起改） |

### 任務 1：碰撞純函式與共用固定資料

**檔案：** 建立 `server/src/collide.rs`、`server/tests/collide-script.json`；修改 `server/src/lib.rs`。

**介面（產出）：**

```rust
pub const BODY_RADIUS: f64 = 0.3;
pub const MIN_DIST: f64 = 0.6;
pub const TOLERANCE: f64 = 0.15;
pub const SEPARATE_PER_TICK: f64 = 0.1;
pub struct Body { pub n: u8, pub x: f64, pub z: f64, pub rooted: bool }
pub struct Moved { pub n: u8, pub x: f64, pub z: f64 }
/// 回傳 mover 的新位置與被推動的人。others 須依 n 由小到大。
pub fn resolve_move(mover: (f64, f64), prev: (f64, f64), others: &[Body], tolerance: f64,
    valid: impl Fn(f64, f64) -> bool) -> ((f64, f64), Vec<Moved>);
pub fn separate(bodies: &[Body], valid: impl Fn(f64, f64) -> bool) -> Vec<Moved>;
```

- [ ] **步驟 1：寫測試**（`valid` 用 `|_, _| true`，除非另外註明）
  - `head_on_overlap_is_split_evenly`：mover 由 `(-1, 0)` 走到 `(0.2, 0)`，B 在 `(0.5, 0)` → pen 0.3，mover 的 `x == 0.05`、B 的 `x == 0.65`。
  - `rooted_body_does_not_move_and_mover_takes_all`：同上但 B rooted → mover `x == -0.1`、被推動清單為空。
  - `pushed_body_blocked_by_a_wall_makes_the_mover_stop`：`valid = |x, _| x <= 0.6` → B 不動、mover `x == -0.1`。
  - `overlap_within_tolerance_is_left_alone`：tolerance 0.15、pen 0.1 → 位置不變、清單為空。
  - `coincident_bodies_separate_deterministically`：mover 與 B 都在 `(0, 0)`、prev 也在 `(0, 0)` → mover `x > 0`、B `x < 0`，不出現 NaN。
  - `mover_returns_to_prev_when_resolved_position_is_invalid`
  - `separate_moves_each_at_most_the_per_tick_limit`：兩人相距 0.2 → 各移 0.1（不是 0.2）。
  - `separate_leaves_two_rooted_bodies_alone`
  - `collide_script_matches_fixture`：讀 `server/tests/collide-script.json`。**這個檔已由前端產生（PR #45，分支 `feat/player-collision-web`），不要重新產生**——用 `git checkout origin/feat/player-collision-web -- server/tests/collide-script.json` 取到你的分支。格式：`moveCases`（每筆 `{ name, mover: [x, z], prev: [x, z], others: [{ n, x, z, rooted }], tolerance, maxX?, expected: { x, z, moved: [{ n, x, z }] } }`）與 `separateCases`（每筆 `{ name, bodies, maxX?, expected: [{ n, x, z }] }`）。`valid(x, z)` 在有 `maxX` 時是 `x <= maxX`，否則一律為真。每個數值與 `expected` 相差小於 `1e-9`，`moved` 的順序與 `n` 也要相同。
- [ ] **步驟 2–4：** 失敗 → 照「共用的數值與算法」實作（有疑問時以 `web/src/game/world/collide.ts` 為準，逐行對照）→ `cargo test collide::` 全過。若你認為固定資料有錯，告訴 Claude，不要自行改檔。
- [ ] **步驟 5：提交** `後端：玩家碰撞的純函式與共用固定資料`。

### 任務 2：位置驗證接上碰撞，加延遲補償

**檔案：** 修改 `server/src/room.rs`、`server/src/world.rs`、`server/src/room/tests.rs`。

**介面（產出）：**

```rust
// Player 新增
trail: [(f64, f64); 4], trail_len: u8      // 最近 4 個 tick 的位置，新的在前
// Room 新增
fn collides(p: &Player, now: Instant) -> bool;   // 在線、未騎乘、未被撞飛、非斷線保留期
fn rooted(p: &Player, now: Instant) -> bool;     // 定點動作（prostrate、chant、incense、bell）進行中
```

**規則：**

- `position()`：既有檢查都通過後，取同場景其他 `collides` 的玩家——位置用各自 `trail` 裡 `VIEW_DELAY_TICKS` 個 tick 前的那筆（紀錄不足時用最舊的一筆）——依 `n` 排序後呼叫 `resolve_move(..., TOLERANCE, valid)`。`valid` 是「在 `zone.bounds` 內且不在任何 `zone.obstacles` 內」。
- mover 的結果與送來的位置相差超過 `0.05`：存結果、`dirty = true`，並比照既有的拒絕分支對本人送 `sync`（同一個 `corrected_at`／`CORRECTION_GAP` 節流）。相差不超過則照常存送來的位置。
- 被推動的人：位置改成結果（注意這是他**目前**的位置被推，不是紀錄裡的舊位置——把推動的位移量加到目前位置上，再做一次 `valid` 檢查，不合法就不動）、`dirty = true`、`moving` 不變，對他本人送 `sync`（同樣節流）。
- `rooted`：伺服器若不知道動作的長度，在 `world.rs` 的動作表加上持續時間（毫秒），數值抄自前端 `web/src/game/gameplay/modules/` 各模組與 `world/bell.ts`，並在註解寫明來源。
- 每個 tick 結束時把目前位置推進每位玩家的 `trail`。

- [ ] **步驟 1：寫測試**（`start_paused`）
  - `walking_into_a_standing_player_pushes_them_and_slows_the_walker`：A 連續走向站著的 B，B 的伺服器位置往前移、兩人距離始終 ≥ `0.6 − 0.15`。
  - `pushed_player_receives_a_sync_and_appears_in_moves`
  - `player_in_a_station_action_cannot_be_pushed`：B 做 `prostrate` 期間位置完全不變；A 被擋住並收到 `sync`。
  - `bowing_player_can_be_pushed`
  - `player_is_not_pushed_through_an_obstacle`：B 背靠香爐，A 推過去 → B 不在任何 `obstacles` 內。
  - `moving_into_a_spot_the_other_player_left_200ms_ago_is_not_corrected`（審查重點 4）：B 走開兩個 tick 後 A 走到 B 原本的位置，A 沒有收到 `sync`。
  - `riders_knocked_and_grace_players_do_not_collide`
  - `two_players_pressing_against_each_other_get_at_most_one_sync_per_correction_gap`（審查重點 5）
  - 既有的移動、穿牆、額度測試數值不可變。
- [ ] **步驟 2–4：** 失敗 → 實作 → `cargo test` 全過。
- [ ] **步驟 5：提交** `後端：位置驗證加上玩家碰撞與延遲補償`。

### 任務 3：每 tick 的分離與殿門範圍

**檔案：** 修改 `server/src/room.rs`、`server/src/world.rs`、`server/src/room/tests.rs`、`docs/BACKEND_TASKS.md`。

**規則：**

- 每個 tick、在組 `moves` 之前，對每個場景呼叫 `separate`（位置用目前的，不用紀錄）；位置有變的人 `dirty = true`，並對本人送 `sync`（節流）。
- 殿門（2026-11-21 改訂）：只改庭院這一側，把 `world.rs` 庭院 portal 矩形的 `max_z` 由 `-5.0` 改成 `-4.4`（延伸 0.6 公尺），`PORTAL_TOLERANCE` 不動；殿內那一側不改。原訂 1.0 公尺行不通：出殿的落點在 `z = -3.6`，矩形延伸到 `-4.0` 再加上 0.5 的容許就會把落點包進去（剛出殿又被送回殿內，`spawns_are_inside_bounds_and_do_not_retrigger_portals` 會失敗）；殿內落點 `z = 7.4` 離殿門矩形 `8.15` 只有 0.75，同理不能延伸。這一項要前後端同時改：你改完推上去後，Claude 在同一個分支把 `web/src/game/world/zones.ts` 的 `COURTYARD_DOOR.maxZ` 改成 `-4.4`（前端單獨先改的話，提早觸發會被現在的伺服器拒絕）。實測（mock、兩個分頁）顯示即使不加寬，站在殿門前的人也會被推進殿、後面的人 1 秒內進得去，所以這一項是加分，不是必要。
- `docs/BACKEND_TASKS.md` 新增條目：規則、數值、驗收標準（上列測試名稱）。

- [ ] **步驟 1：寫測試**
  - `players_spawned_on_the_same_point_drift_apart`：兩人同時進場在出生點 → 10 個 tick 內距離 ≥ 0.6，且每個 tick 每人位移 ≤ 0.1。
  - `a_crowd_standing_in_front_of_the_hall_door_does_not_stop_entry`：4 人並排站在殿門前，第 5 人走到門前 1 公尺內送 `zone` → 成功切換。
  - `a_player_can_push_through_a_line_of_idle_players`：3 人橫排擋路，A 持續往前走 5 秒 → A 通過那條線。
  - `separation_never_moves_a_rooted_player`
- [ ] **步驟 2–4：** 失敗 → 實作 → 三個 cargo 檢查全過。
- [ ] **步驟 5：提交並推送**，通知 Claude 稽核。

**第 1 段稽核方式：** 我在 Windows 跑三個 cargo 檢查；逐條對照測試名稱與斷言的數值；讀 `collide.rs` 逐行比對「共用的數值與算法」；確認 `position()` 與 tick 裡沒有 `.await`、下行都是 `try_send`；確認 `collide-script.json` 是由測試產生（重跑 `UPDATE_FIXTURES=1` 後檔案不變）；以負載工具跑 500 連線確認 tick 時間沒有明顯變長並記錄數字。

---

# 第 2 段：前端與 mock（Claude）

### 任務 4：`collide.ts` 與共用固定資料

`web/src/game/world/collide.ts`（無 import，Node 可直接載入）照同一份算法實作 `resolveMove`、`separate`；`collide.test.ts` 讀 `server/tests/collide-script.json`，相差小於 `1e-9`。

### 任務 5：本機移動、平滑糾正、殿門範圍

- 本機玩家在 `stepMover` 之後對同場景、顯示中的遠端玩家呼叫 `resolveMove`（tolerance 0）；被推動的遠端玩家只在畫面上先移，以伺服器的 `moves` 為準。
- `GameCore.correctLocal()`：位移小於 1 公尺時以 150 毫秒滑過去。
- 點擊移動的尋路遇到人不重新規劃（人會被推開）；卡住超過 1.5 秒就取消目標。
- `zones.ts` 的殿門觸發範圍與後端一致。

### 任務 6：mock 伺服器與實測

mock 伺服器接上同一份 `collide.ts`（含延遲補償與每 tick 分離），機器人也參與碰撞。以 Playwright 開兩個分頁實測設計 §7 的三項並記錄數字；更新 `CLAUDE.md` 與 `docs/TECH_STACK.md`。

---

## 設計涵蓋對照

| 設計章節 | 任務 |
|---|---|
| §4 規則 | 1、2、3、4、5 |
| §5 同步 | 2、3、5 |
| §6 架構 | 1–6 |
| §7 驗證 | 各任務的測試；6 的實測 |
