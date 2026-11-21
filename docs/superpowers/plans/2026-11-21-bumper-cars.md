# 庭院碰碰車 實作計畫

> **執行方式：** 由需求方（人）依任務順序實作；Claude 不寫產品程式，只在每一段（PR）完成後依「稽核方式」檢查。步驟用 `- [ ]` 勾選追蹤。

**目標：** 庭院內可領車、開車、撞車、撞飛行人的碰碰車玩法，伺服器以 rapier3d 權威模擬、前端以 Rapier WASM 預測自己的車。

**架構：** 每個房間 actor 擁有一個 30 Hz 固定步長的 `VehicleWorld`；協定升為 v5，新增上行 `claim`／`ride`／`drive` 與下行 `cars`（二進位 `0x04`）、`car`、`carGone`、`knock`。前端比照 `BellStriker`，做成 GameCore 擁有的 `Vehicles` 子系統，Rapier 以 `import()` 延遲載入。

**技術：** Rust 1.95 + tokio + rapier3d（f32）；TypeScript + Three.js + `@dimforge/rapier3d-compat` 0.21.0；vitest；cargo test。

**設計文件：** `docs/superpowers/specs/2026-11-20-bumper-cars-design.md`（以下稱「設計」；實作時兩份都要讀）。

## 全域限制

- 說明、註解、提交訊息用繁體中文；識別字用英文（AGENTS.md）。
- 新依賴以精確版本寫入，並記錄在 `docs/TECH_STACK.md` 的版本表。
- 改協定時前端、mock、後端在同一個 PR；固定資料改名為 `server/tests/protocol-v5.json`、`protocol-v5-vectors.py`。
- 車種、動作只能加在尾端。
- Rapier 的 WASM 不可進首次載入的 chunk；資料節省或 3g 以下不下載。
- 車最多 2 個 draw call；淡出用抖動式透明；不出現任何神明形象。
- 車、檔口與所有新道具是 Q 版造型，與小沙彌公仔相呼應：圓潤的橢球與旋轉體、短胖誇張的比例、配色取自現有衣裝色表與庭院色調；檔口沿用庭院既有的木、瓦、石材質（設計 §7）。
- 伺服器 `try_send` 原則不變：房間不等待任何連線。
- 後端每個 PR 通過 `cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test`；前端通過 `npm run typecheck`、`npm test`、`npm run build`。
- 提交只 stage 明確路徑，不用 `git commit -a`。
- 朝向慣例沿用現有：`heading = atan2(dx, dz)`，前方向量是 `(sin h, cos h)`，+x 方向是 π/2。

## 審查重點

設計沒有明寫、但玩家最容易遇到的情況。每一條都已在括號內的任務加上測試：

1. **開車的人手機鎖屏或切到背景**：車應在 1 秒內變成滑行、玩家下車，不留下「幽靈駕駛」。（任務 6、12）
2. **兩個人同一瞬間搶同一台車**：只有一人成功，另一人收到 `car_unavailable`，不會兩人都坐上去。（任務 6）
3. **騎乘中斷線重連或重新整理**：回來後是步行狀態、場上的車不重複、不殘留自己的騎乘狀態。（任務 6、12）
4. **正在走向香爐、正在淡入殿門、或已被撞飛時又被撞**：不會卡在永久鎖定；淡入淡出期間的 `knock` 仍套用落點但不播動畫。（任務 7、14）
5. **下車時左、右、後三面都被擋住**：玩家落在車的位置，不會被放進障礙物裡。（任務 6）

## 檔案結構

| 檔案 | 責任 | 任務 |
|---|---|---|
| `shared/vehicles.json` | 車種、物理參數、時間常數、檔口與停車位：唯一來源 | 2 |
| `server/src/vehicles/mod.rs` | 模組入口與公開型別 | 2 |
| `server/src/vehicles/params.rs` | 讀 `shared/vehicles.json` | 2 |
| `server/src/vehicles/drive.rs` | 駕駛邏輯純函式 | 3 |
| `server/src/vehicles/world.rs` | `VehicleWorld`：包住 rapier3d | 4 |
| `server/src/vehicles/knock.rs` | 撞飛判定與落點純函式 | 7 |
| `server/src/room/vehicles.rs` | `impl Room`：領車、上下車、輸入、淡出、廣播 | 6、7 |
| `server/tests/drive-script.json` | 共用駕駛腳本與 Rust 產生的預期結果 | 4 |
| `web/src/game/world/vehicles.ts` | 車種表、檔口、落點、庫存推算（無 Three、無 Rapier） | 9 |
| `web/src/game/vehicles/drive.ts` | 駕駛邏輯純函式（無 import，Node 可直接載入） | 10 |
| `web/src/game/vehicles/simCore.ts` | 建立 Rapier world、套用駕駛、步進（mock 與前端共用） | 10 |
| `web/src/game/vehicles/Vehicles.ts` | 子系統：車的清單、騎乘狀態、顯示位置 | 12 |
| `web/src/game/vehicles/VehicleSim.ts` | 延遲載入、累加器、輸入歷史、重播校正 | 15 |
| `web/src/game/render/CarFleet.ts` | 車的 InstancedMesh | 11 |
| `web/scripts/build-cars.mjs` | 產生 `public/models/cars.glb` | 11 |
| `web/src/ui/RidePanel.vue` | 上下車按鈕與領車面板 | 13 |

---

# 第 1 段：協定 v5 與伺服器模擬（PR 1，分支 `feat/bumper-cars-server`）

完成後：伺服器可領車、開車、撞飛，以測試與負載工具驗證；前端與 mock 已升 v5 但還看不到車。

### 任務 1：確認 Rapier 版本配對並加入後端依賴

> **已完成（PR #36，分支 `feat/rapier-engine`）。** 配對結果：npm `@dimforge/rapier3d-compat` 0.21.0 ↔ crate `rapier3d` =0.36.0。冒煙測試實際名稱是 `vehicles::tests::rapier_steps_a_free_body_one_metre_in_one_second`，前端另有同情境的 `web/src/game/vehicles/rapier.test.ts`。任務 10 步驟 1 的 npm 安裝也已在同一個 PR 完成。第 1 段的分支請從合併了 #36 的 `main` 開出。以下步驟留作紀錄。

**檔案：** 修改 `server/Cargo.toml`、`server/Cargo.lock`、`docs/TECH_STACK.md`；建立 `server/src/vehicles/mod.rs`（先只有一個測試）。

- [ ] **步驟 1：查出配對版本。** 到 rapier.js 儲存庫（dimforge/rapier.js）標籤 `v0.21.0`，看它的 Cargo 設定鎖定哪一版 `rapier3d`。這一版就是後端要用的版本（不是 crates.io 最新的 0.36.1，除非剛好相同）。
- [ ] **步驟 2：寫冒煙測試** `vehicles::tests::rapier_steps_a_falling_free_body`：建立無重力的 world，放一個初速 `(1,0,0)` 的動態剛體，步進 30 次（`dt = 1/30`），斷言 `x` 在 `0.95..=1.05`。
- [ ] **步驟 3：** 執行 `cargo test rapier_steps`，預期編譯失敗（沒有依賴）。
- [ ] **步驟 4：** 在 `Cargo.toml` 以 `rapier3d = "=<步驟 1 的版本>"` 加入，比照現有依賴附一行中文註解；在 `lib.rs`（或 crate 根）宣告 `pub mod vehicles;`。
- [ ] **步驟 5：** `cargo test rapier_steps` 通過；`cargo clippy --locked --all-targets -- -D warnings` 通過。
- [ ] **步驟 6：** 在 `docs/TECH_STACK.md` 版本表把物理一列改為已引入（後端），寫上兩邊的版本與查證方式。
- [ ] **步驟 7：提交** `後端：加入 rapier3d`（stage 上述四個路徑）。

### 任務 2：共用參數與障礙物原始尺寸

**檔案：** 建立 `shared/vehicles.json`、`server/src/vehicles/params.rs`；修改 `server/src/world.rs`、`server/src/vehicles/mod.rs`。

**介面（產出）：**

```rust
pub struct CarParams { pub half_width: f32, pub half_height: f32, pub half_length: f32, pub mass: f32,
    pub linear_damping: f32, pub angular_damping: f32, pub restitution: f32, pub friction: f32,
    pub max_speed: f32, pub reverse_max_speed: f32, pub drive_force: f32, pub turn_rate: f32,
    pub steer_gain: f32, pub steer_blend: f32, pub lateral_grip: f32,
    pub reverse_angle: f32, pub reverse_below_speed: f32 }
pub struct Params { pub kinds: Vec<Kind>, pub car: CarParams, pub physics: Physics, pub ride: Ride,
    pub fade: Fade, pub knock: Knock, pub booth: Booth }
pub fn params() -> &'static Params;                       // OnceLock + include_str!("../../../shared/vehicles.json")
// world.rs
pub struct Zone { /* 既有欄位 */ pub solids: &'static [Rect] }   // 未加角色半徑的原始矩形
```

**`shared/vehicles.json` 的值（起始值，手感調校時只改這個檔）：**

```json
{
  "kinds": [
    { "id": "classic", "rarity": "common", "count": 4 },
    { "id": "woodfish", "rarity": "common", "count": 3 },
    { "id": "racer", "rarity": "rare", "count": 2 },
    { "id": "firewheel", "rarity": "mythic", "count": 1 }
  ],
  "car": { "halfWidth": 0.55, "halfHeight": 0.3, "halfLength": 0.9, "mass": 120,
    "linearDamping": 0.6, "angularDamping": 4, "restitution": 0.6, "friction": 0.2,
    "maxSpeed": 8, "reverseMaxSpeed": 3, "driveForce": 1400, "turnRate": 3.2,
    "steerGain": 4, "steerBlend": 0.25, "lateralGrip": 0.15,
    "reverseAngle": 2.618, "reverseBelowSpeed": 1.5 },
  "physics": { "hz": 30, "maxCatchUpSteps": 3, "broadcastEverySteps": 2, "inputTimeoutMs": 500 },
  "ride": { "mountRadius": 1.5, "boothRadius": 2.5, "claimCooldownMs": 20000, "idleDismountMs": 60000,
    "dismountOffset": 1.1 },
  "fade": { "idleMs": 45000, "fadeMs": 15000 },
  "knock": { "minSpeed": 2.5, "hitRadius": 0.6, "distancePerSpeed": 0.6, "minDistance": 2, "maxDistance": 5,
    "flightMs": 900, "recoverMs": 900, "immuneMs": 3000 },
  "booth": { "rect": { "minX": -15.5, "maxX": -12.5, "minZ": 8, "maxZ": 10.5 },
    "counter": { "x": -12.0, "z": 9.25 },
    "bays": [ { "x": -10.5, "z": 7.0, "heading": 1.5708 }, { "x": -10.5, "z": 9.25, "heading": 1.5708 },
              { "x": -10.5, "z": 11.5, "heading": 1.5708 } ] }
}
```

- [ ] **步驟 1：寫測試**
  - `params::tests::kinds_total_ten_and_counts_differ`：`count` 總和為 10、四個值互不相同、`id` 依序為 `classic, woodfish, racer, firewheel`。
  - `params::tests::bays_are_inside_courtyard_and_clear_of_solids`：三個停車位以車身半對角線（`hypot(0.55, 0.9)`）為半徑，不與庭院任何 `solids` 或檔口 `rect` 重疊，且在邊界內。
  - `world::tests::padded_obstacles_equal_solids_grown_by_player_radius`：庭院與殿內的 `obstacles[i] == solids[i].grow(0.35)`。
- [ ] **步驟 2：** `cargo test params:: padded_obstacles` 失敗。
- [ ] **步驟 3：實作。** `world.rs` 把 `solid()`／`square()`／`tree()` 改成產生原始矩形的 `const` 陣列，再由它導出加邊後的 `obstacles`。既有測試的數值不可變。
- [ ] **步驟 4：** `cargo test` 全數通過（既有的移動與穿牆測試證明加邊後的數值沒變）。
- [ ] **步驟 5：提交** `後端：車輛共用參數與障礙物原始尺寸`。

### 任務 3：駕駛邏輯（Rust）

**檔案：** 建立 `server/src/vehicles/drive.rs`。

**介面（產出）：**

```rust
pub struct DriveInput { pub dir: f32, pub mag: f32 }                 // dir 弧度（世界方向），mag 0..=1
pub struct CarMotion { pub heading: f32, pub vx: f32, pub vz: f32, pub w: f32 }
pub struct DriveOutput { pub force: f32, pub w: f32, pub lateral_keep: f32 }  // force 沿前方（牛頓，負值倒車）
pub fn drive(m: &CarMotion, input: &DriveInput, p: &CarParams) -> DriveOutput;
pub fn wrap_angle(a: f32) -> f32;                                    // (-π, π]
```

**演算法（前後端必須逐行相同，任務 10 的 TypeScript 版照抄）：**

```text
speed = vx*sin(heading) + vz*cos(heading)          // 沿前方的有號速度
lateral_keep = 1 - lateral_grip
if mag <= 0:  return { force: 0, w: m.w, lateral_keep }
diff = wrap_angle(dir - heading)
reversing = |diff| > reverse_angle && speed < reverse_below_speed
if reversing:
    err   = wrap_angle(dir - (heading + π))        // 讓車尾朝向 dir
    force = speed > -reverse_max_speed ? -drive_force*mag : 0
else:
    err   = diff
    force = speed < max_speed ? drive_force*mag*max(0.2, cos(diff)) : 0
steer_scale = 0.3 + 0.7*min(1, |speed|/2)
target_w    = clamp(err*steer_gain, -turn_rate, turn_rate) * steer_scale
w           = m.w + (target_w - m.w)*steer_blend
return { force, w, lateral_keep }
```

- [ ] **步驟 1：寫測試**（`p = params().car`）
  - `released_stick_applies_no_force_and_keeps_spin`：`mag = 0`、`w = 1.0` → `force == 0.0`、`w == 1.0`。
  - `full_stick_ahead_pushes_forward`：`heading = 0, dir = 0, mag = 1`、靜止 → `force == 1400.0`、`w.abs() < 1e-6`。
  - `no_force_at_max_speed`：`vz = 8.0` → `force == 0.0`。
  - `steers_toward_target_on_the_short_side`：`heading = 3.0, dir = -3.0` → `w > 0.0`（跨過 ±π 走短邊）。
  - `stick_behind_at_low_speed_reverses`：`heading = 0, dir = π`、靜止 → `force == -1400.0`、`w.abs() < 1e-6`。
  - `stick_behind_at_high_speed_keeps_turning_forward`：`vz = 5.0, dir = π` → `force >= 0.0`、`w != 0.0`。
  - `wrap_angle_maps_to_half_open_range`：`wrap_angle(π) == π`、`wrap_angle(-π) == π`、`wrap_angle(3π/2) ≈ -π/2`。
- [ ] **步驟 2：** `cargo test vehicles::drive` 失敗。
- [ ] **步驟 3：實作** 上面的演算法。
- [ ] **步驟 4：** `cargo test vehicles::drive` 通過。
- [ ] **步驟 5：提交** `後端：碰碰車駕駛邏輯`。

### 任務 4：VehicleWorld

**檔案：** 建立 `server/src/vehicles/world.rs`、`server/tests/drive-script.json`；修改 `server/src/vehicles/mod.rs`。

**介面（消費）：** 任務 2 的 `params()`、`Zone.solids`；任務 3 的 `drive()`。

**介面（產出）：**

```rust
pub struct CarState { pub c: u8, pub occupied: bool, pub bumped: bool,
    pub x: f32, pub z: f32, pub heading: f32, pub vx: f32, pub vz: f32, pub w: f32 }
pub struct StepReport { pub bumped: Vec<u8> }           // 本步受到明顯碰撞衝量的車
impl VehicleWorld {
    pub fn new(zone: &'static Zone) -> Self;             // 靜態：zone.solids、檔口 rect、四面邊界牆
    pub fn spawn(&mut self, x: f32, z: f32, heading: f32) -> Option<u8>;   // 配最小的空編號 0..=15
    pub fn remove(&mut self, c: u8);
    pub fn set_occupied(&mut self, c: u8, occupied: bool);     // 同時切換「是否與步行者碰撞」的群組
    pub fn set_input(&mut self, c: u8, input: DriveInput);
    pub fn set_walker(&mut self, n: u8, pos: Option<(f32, f32)>);   // None＝移除（離開庭院、騎乘、撞飛、無敵）
    pub fn step(&mut self) -> StepReport;                 // 固定 dt = 1/30
    pub fn car(&self, c: u8) -> Option<CarState>;
    pub fn cars(&self) -> impl Iterator<Item = CarState> + '_;
    pub fn any_awake(&self) -> bool;                      // 有任何車未休眠
    pub fn distance_to_car(&self, c: u8, x: f32, z: f32) -> Option<f32>;   // 點到車身長方體（平面）的距離
    pub fn bay_is_free(&self, x: f32, z: f32) -> bool;    // 半對角線範圍內沒有其他車
}
```

**每步的順序：** 對每台有輸入的車呼叫 `drive()` → 沿前方施加衝量 `force * dt` → 把側向速度乘上 `lateral_keep` → 設定 Y 軸角速度為 `w` → `pipeline.step()`。車是動態剛體，鎖定 Y 位移與 X／Z 旋轉，重力為零。「明顯碰撞」定義為接觸力事件的總力量超過 `mass * 3`（可調）。

- [ ] **步驟 1：寫測試**
  - `car_accelerates_toward_stick_direction`：在 `(0, 8)` 朝向 0 生車，輸入 `dir = 0, mag = 1`，步進 60 次 → `z > 8 + 3.0` 且 `|x| < 0.05`。
  - `car_never_enters_a_solid_or_leaves_bounds`：從 `(0, 2)` 朝主殿全速開 300 步 → 每一步車中心都不在任何 `solids` 內、都在邊界內。
  - `hitting_a_wall_reports_a_bump`：同上情境，至少有一步的 `StepReport.bumped` 含這台車。
  - `idle_world_falls_asleep`：生一台車不給輸入，步進 120 次 → `any_awake() == false`。
  - `walker_pushes_an_empty_car_but_not_an_occupied_one`：車在 `(0, 8)`；步行者由 `(0, 6)` 以每步 0.1 公尺走到 `(0, 8)`。空車時車的 `z` 增加超過 0.5；`set_occupied(c, true)` 時車位移小於 0.01。
  - `spawn_returns_none_when_sixteen_exist`。
  - `drive_script_matches_fixture`：讀 `server/tests/drive-script.json` 的 `script`（每步一筆 `{dir, mag}`，90 步：直行 30 步、右轉 30 步、對著東側邊界牆全速 30 步；起點 `(0, 8)`、朝向 0），模擬後每 10 步的 `{x, z, heading}` 與檔案的 `expected` 相差小於 `1e-3`（2026-11-21 稽核後由 `1e-4` 放寬：固定資料在 Linux 產生，Windows 上撞牆後的第 90 步差 1.5e-4，是平台間浮點數差異）。設環境變數 `UPDATE_FIXTURES=1` 時改為把結果寫回檔案。
- [ ] **步驟 2：** `cargo test vehicles::world` 失敗。
- [ ] **步驟 3：實作。** 碰撞群組：車之間、車與靜態一律碰撞；步行者（運動學、半徑 0.35 的球）只與未被佔用的車碰撞。
- [ ] **步驟 4：** 先以 `UPDATE_FIXTURES=1 cargo test drive_script` 產生 `expected`，再不帶環境變數執行 `cargo test vehicles::world`，全數通過。
- [ ] **步驟 5：提交** `後端：VehicleWorld 與共用駕駛腳本`（含 `server/tests/drive-script.json`）。

### 任務 5：協定 v5（後端、前端、mock、固定資料）

**檔案：** 修改 `server/src/protocol.rs`、`server/src/connection.rs`、`server/src/rate_limit.rs`、`server/src/metrics.rs`、`server/tests/protocol.rs`、`server/tests/websocket.rs`、`web/src/game/net/protocol.ts`、`web/src/game/net/binaryFrame.ts`、`web/src/game/net/protocol-fixtures.test.ts`、`web/scripts/mock-server.mjs`、`web/src/i18n/*.ts`；改名 `server/tests/protocol-v4.json` → `protocol-v5.json`、`protocol-v4-vectors.py` → `protocol-v5-vectors.py`（所有引用一併改）。

**介面（產出）— 兩邊型別同名同義：**

```ts
// 上行（JSON）
{ t: 'claim'; kind: number }                 // 0..KIND_COUNT-1
{ t: 'ride'; car: number | null }            // 0..15 或 null
{ t: 'drive'; seq: number; dir: number; mag: number }   // 皆為 0..65535 / 0..255 / 0..255 的整數
// 下行（JSON）
interface CarSnapshot { c: number; kind: number; driver: string | null; x: number; z: number; heading: number; fadeAt: number | null }
{ t: 'car' } & CarSnapshot
{ t: 'carGone'; c: number }
{ t: 'knock'; id: string; x: number; z: number; toX: number; toZ: number; at: number }
welcome 新增 cars: CarSnapshot[]（缺少視為 []）
error.code 新增 'car_unavailable' | 'booth_crowded' | 'claim_cooldown' | 'dismount_first'
// 下行（二進位）
interface CarState { c: number; occupied: boolean; bumped: boolean; x: number; z: number; heading: number; vx: number; vz: number; w: number }
{ t: 'cars'; ack: number; cars: CarState[] }
export const FRAME_CARS = 0x04, CAR_ENTRY_BYTES = 12, MAX_CARS = 16, KIND_COUNT = 4
export function encodeCars(ack: number, cars: CarState[]): Uint8Array | null
export function decodeCars(bytes: Uint8Array): { ack: number; cars: CarState[] } | null
```

**`cars` 幀配置（小端序）：** `[0] 0x04`、`[1..3] ack u16`，之後每台 12 bytes：

| 位移 | 型別 | 內容 |
|---|---|---|
| +0 | u8 | bit 0–3 `c`；bit 4 `occupied`；bit 5 `bumped`；bit 6–7 保留，須為 0 |
| +1 | i16 | x 公分（±10000，同 `moves`） |
| +3 | i16 | z 公分 |
| +5 | i16 | 朝向：`roundAway(h × 32768/π)` 取低 16 位；解碼 `q × π/32768`，範圍 [−π, π) |
| +7 | i16 | vx 公分／秒（夾在 ±3000） |
| +9 | i16 | vz 公分／秒 |
| +11 | i8 | 角速度，單位 1/16 rad/s（夾在 ±127） |

解碼拒絕：長度不是 `3 + 12N`、N > 16、保留位元非 0、座標超出範圍、同一幀內 `c` 重複。

- [ ] **步驟 1：** `git mv` 兩個固定資料檔並改所有引用；`PROTOCOL_VERSION` 改 5（Rust、TS、mock 三處）；固定資料內 `hello.v` 改 5。
- [ ] **步驟 2：在 `protocol-v5-vectors.py` 加 `cars` 向量** 並重新產生 `binary` 區塊，新增鍵 `binary.cars = { valid, invalid }`：
  - valid：空幀（`ack = 0`）；一台車 `c=3, occupied, x=1.25, z=-3, heading=π/2, vx=8, vz=-2.5, w=1.5, ack=65535`；朝向 `π`（須編成 `-32768`）；16 台；速度與角速度夾限。
  - invalid：長度 4、17 台、保留位元為 1、x 超出範圍、`c` 重複。
  - 原本列為無效標籤的 `0x04` 向量改成 `0x05`。
- [ ] **步驟 3：在固定資料的 `server`／`client`／`invalid` 手寫新訊息範例**：每種新訊息至少一筆有效；無效含 `claim.kind = 4`、`ride.car = 16`、`drive.mag = 256`、`drive.seq = -1`、`car.kind` 非整數、`knock` 缺 `at`；另加 `"kindCount": 4`。
- [ ] **步驟 4：寫測試**（兩邊都讀固定資料）
  - Rust `shared_car_vectors_encode_and_decode`、前端 `cars 幀向量編碼與解碼一致`：valid 的 `encode(input) == hex` 且 `decode(hex) == decoded`；invalid 全部解碼失敗。
  - 兩邊 `KIND_COUNT`／`params().kinds.len()` 等於固定資料 `kindCount`。
  - Rust `tests/websocket.rs` 的 `unsupported_version_then_close` 改為涵蓋 v4 與 v6。
  - 前端 `welcome 沒有 cars 時視為空陣列`。
- [ ] **步驟 5：** 兩邊測試失敗後實作：Rust `ClientMessage`／`ServerMessage` 新變體與 `to_frame`、`metrics.rs` 的 `KINDS`／`kind_index`、`rate_limit.rs` 新增 `drive` 20 則／秒（突發 5），`claim`／`ride` 併入 `action` 的額度；`connection.rs` 把三個新上行轉成 `RoomCommand`（房間端此時先回 `error car_unavailable`，任務 6 才真的處理）。前端 `decode()` 的二進位分流改成依標籤 `switch`；`SERVER_ERRORS` 與四個語言字典補四個新代碼。
- [ ] **步驟 6：mock** 改版本為 5、`welcome` 帶 `cars: []`、`claim`／`ride` 回 `error car_unavailable`、`drive` 忽略（完整模擬在任務 10）。
- [ ] **步驟 7：** `cargo test`、`python -I server/tests/protocol-v5-vectors.py` 輸出與固定資料的 `binary` 相同、`npm run typecheck && npm test` 全數通過。
- [ ] **步驟 8：提交** `協定 v5：車輛訊息與 cars 幀`。

### 任務 6：房間整合（領車、上下車、輸入、淡出、廣播）

**檔案：** 建立 `server/src/room/vehicles.rs`（`impl Room`）；修改 `server/src/room.rs`、`server/src/room/tests.rs`（或新增 `server/src/room/vehicle_tests.rs`）。

**介面（消費）：** 任務 4 的 `VehicleWorld`；任務 5 的訊息型別。

**介面（產出）：**

```rust
// Player 新增
riding: Option<u8>, claim_at: Option<Instant>, last_drive_seq: u16, last_active_drive: Instant,
knocked_until: Option<Instant>, immune_until: Option<Instant>          // 後兩個任務 7 使用
// Room 新增
vehicles: VehicleWorld, cars: BTreeMap<u8, Car>, physics_steps: u64
struct Car { kind: u8, driver: Option<String>, empty_since: Option<Instant>, last_input_at: Instant }
impl Room {
    fn claim(&mut self, who: &Who, kind: u8, now: Instant);
    fn ride(&mut self, who: &Who, car: Option<u8>, now: Instant);
    fn drive(&mut self, who: &Who, seq: u16, dir: u8, mag: u8, now: Instant);
    fn dismount(&mut self, id: &str, now: Instant);       // detach、背景、逾時共用
    fn physics_step(&mut self, now: Instant);
    fn car_snapshot(&self, c: u8) -> CarSnapshot;
}
```

**規則（數值皆取自 `params()`）：**

- `run_room` 的 `select!` 加一個 `interval(1/30 s)`，`MissedTickBehavior::Burst` 並自行限制每次醒來最多補 3 步；`cars` 為空時不呼叫 `step()`；有車時，只有「無人騎乘、`!vehicles.any_awake()`、而且沒有任何庭院步行者（即會被 `set_walker` 放進世界的玩家）距任何一台車 `distance_to_car ≤ 1.0` 公尺」三者同時成立才不步進。（2026-11-21 稽核後修正：原本沒有步行者這一條，休眠的空車因此推不動。）
- `claim`：須在庭院、未騎乘、未撞飛、距 `booth.counter` ≤ `boothRadius`；冷卻內回 `claim_cooldown`；該車種已達 `count` 回 `car_unavailable`；依序找第一個 `bay_is_free` 的停車位，都沒有回 `booth_crowded`；成功則生車、玩家上車、廣播 `car`。
- `ride(Some(c))`：須在庭院、未騎乘、未撞飛、車存在且無人、`distance_to_car ≤ mountRadius`，否則回 `car_unavailable`。成功廣播 `car`（`driver` 設為玩家、`fadeAt` 為 null）。
- `ride(None)`／`dismount`：落點依序試車的左、右、後方 `dismountOffset` 公尺，取第一個在邊界內且不在加邊障礙物內的；都不行就用車的位置。玩家座標設為落點，對本人送一筆 `sync`；車 `set_occupied(false)`、清除輸入、`empty_since = now`，廣播 `car`（`fadeAt = 伺服器毫秒 + idleMs`）。
- `drive`：只接受騎乘者；`seq` 以 u16 環繞比較，較舊的丟棄；`mag > 0` 時更新 `last_active_drive`。線上值換算成 `DriveInput`：`dir = wrap_angle(dir_u8 × 2π/256)`、`mag = mag_u8 / 255`。
- 每個物理步：超過 `inputTimeoutMs` 沒有 `drive` 的車輸入歸零；`now - last_active_drive > idleDismountMs` 的騎士自動下車；騎士的 `x, z, heading` 設為車的狀態；庭院步行者以 `set_walker` 同步位置（騎乘、殿內、斷線保留期、撞飛或無敵中為 `None`）；空車 `now - empty_since ≥ idleMs + fadeMs` 時移除並廣播 `carGone`。
- 每 `broadcastEverySteps` 步：對每位庭院在線玩家 `try_send` 一則 `cars`（只含未休眠的車；`ack` 是該玩家的 `last_drive_seq`，非騎士為 0）。佇列滿時比照 `moves` 設 `needs_sync`。`needs_sync` 或剛進入庭院的玩家下一則改送含全部車輛的 `cars`。
- 騎士不放進 `moves`／`sync` 的 tuple；騎乘中收到的 `move`／`stop` 忽略。
- `switch_zone`：騎乘中回 `error dismount_first`，不切換。
- `detach`：若在騎乘先 `dismount`。`resume` 與 `welcome` 帶 `cars`。

- [ ] **步驟 1：寫測試**（`start_paused` 風格，沿用既有的測試輔助）
  - `claim_spawns_a_car_in_the_first_free_bay_and_mounts_the_player`
  - `claim_is_refused_away_from_the_booth_in_the_hall_and_during_cooldown`（三種情況分別斷言錯誤碼）
  - `kind_stock_is_limited_to_its_count`：第 2 位玩家領 `firewheel` 得到 `car_unavailable`。
  - `claim_is_refused_when_all_bays_are_blocked`：`booth_crowded`。
  - `two_players_mounting_the_same_car_only_one_wins`：同一個 tick 內兩個 `ride`，恰好一則 `car` 廣播、另一人收到 `car_unavailable`。
  - `drive_moves_the_car_and_cars_frame_acks_the_latest_seq`：送 `seq = 7` 後推進 200 ms，騎士收到的 `cars` 中 `ack == 7` 且車位置改變。
  - `stale_drive_seq_is_ignored_across_u16_wraparound`：先 `65535` 再 `0` 視為較新；再送 `65534` 被丟棄。
  - `input_times_out_after_500ms_without_drive`：推進 600 ms 後車開始減速（速度小於逾時前）。
  - `rider_is_absent_from_moves_and_their_move_messages_are_ignored`
  - `zone_change_while_riding_is_refused_with_dismount_first`
  - `dismount_places_the_player_beside_the_car_and_schedules_fade`：落點距車 `1.1 ± 0.01`、不在障礙物內、`car.fadeAt == now_ms + 45000`。
  - `dismount_falls_back_to_the_car_position_when_all_sides_are_blocked`
  - `disconnecting_rider_is_dismounted_immediately`：`detach` 後同一 tick 廣播 `driver: null` 的 `car`。
  - `idle_rider_is_dismounted_after_60s_even_while_sending_zero_drive`
  - `empty_car_is_removed_after_60s_and_stock_returns`：推進 60 s 後收到 `carGone`，再領同一車種成功。
  - `remounting_during_fade_cancels_it`：第 50 秒上車，廣播的 `fadeAt == null`，第 61 秒車仍在。
  - `physics_does_not_step_when_no_car_is_awake`：`physics_steps` 在車休眠後不再增加（步行者都離車超過 1 公尺）。
  - `walker_can_push_a_sleeping_empty_car`：車休眠且無人騎乘後，步行者朝車走過去 → `physics_steps` 重新增加、車的位置移動超過 0.3 公尺；步行者走開、車再次休眠後又停止步進。
  - `entering_the_courtyard_receives_every_car_including_sleeping_ones`
  - `cars_frames_only_reach_courtyard_players_but_car_events_reach_the_hall`
  - `welcome_and_resume_carry_cars_and_resumed_player_is_on_foot`
- [ ] **步驟 2：** `cargo test room::` 新測試失敗。
- [ ] **步驟 3：實作** 上述規則。
- [ ] **步驟 4：** `cargo test` 全數通過。
- [ ] **步驟 5：提交** `後端：房間的領車、騎乘與車輛廣播`。

### 任務 7：撞飛

**檔案：** 建立 `server/src/vehicles/knock.rs`；修改 `server/src/room/vehicles.rs`、`server/src/room.rs`。

**介面（產出）：**

```rust
pub fn knock_distance(speed: f32, k: &Knock) -> f32;      // clamp(speed*distancePerSpeed, minDistance, maxDistance)
/// 從 (x, z) 沿 (dx, dz)（單位向量）飛 distance；以 0.25 公尺為一步前進，停在最後一個
/// 在邊界內且不在加邊障礙物內的點。起點本身一定合法。
pub fn knock_landing(zone: &Zone, x: f64, z: f64, dx: f64, dz: f64, distance: f64) -> (f64, f64);
```

**規則：** 每個物理步，對每台有人開且速率 ≥ `minSpeed` 的車、每位庭院在線且未騎乘、`now ≥ knocked_until`、`now ≥ immune_until` 的玩家：`distance_to_car ≤ hitRadius` 即撞飛。方向取車的速度方向。設 `knocked_until = now + flightMs + recoverMs`、`immune_until = knocked_until + immuneMs`、玩家座標設為落點、`action = None`、`moving = false`，廣播 `knock`（`at` 為伺服器毫秒）給全房。撞飛期間收到的 `move`／`stop`／`action`／`claim`／`ride` 忽略（`action` 回 `ack ok:false, reason:"knocked"`）；`knocked_until` 到期的那個物理步對本人送一筆 `sync`。斷線保留期中的玩家不會被撞。

- [ ] **步驟 1：寫測試**
  - `knock_distance_clamps`：速率 2.5 → 2.0；5 → 3.0；20 → 5.0。
  - `landing_stops_before_an_obstacle`：由 `(0, 0)` 朝 `-z`（大香爐在 `(0, -1.5)`）飛 5 公尺 → 落點不在任何加邊障礙物內且 `z > -1.5`。
  - `landing_stops_inside_bounds`：由 `(18, 0)` 朝 `+x` 飛 5 公尺 → `x ≤ 19`。
  - `a_fast_occupied_car_knocks_a_walker_and_broadcasts_knock`：`knock.toX/toZ` 等於伺服器記錄的玩家座標。
  - `slow_empty_or_unoccupied_cars_do_not_knock`（速率 2.0 的有人車、速率 5 的空車各一）。
  - `knocked_player_cannot_move_or_act_until_recovered_then_gets_a_sync`
  - `immune_player_is_not_knocked_again_for_3s_after_recovery`：第 4.7 秒仍免疫、第 4.9 秒可再被撞。
  - `knocking_clears_the_stored_action`：被撞後新加入者的 `welcome` 快照中該玩家沒有 `action`。
  - `riders_and_grace_players_are_never_knocked`
- [ ] **步驟 2–4：** 失敗 → 實作 → `cargo test` 通過。
- [ ] **步驟 5：提交** `後端：碰碰車撞飛`。

### 任務 8：指標、負載工具與文件

**檔案：** 修改 `server/src/metrics.rs`、`server/src/bin/loadtest.rs`、`server/tests/loadtest.rs`、`server/tests/metrics.rs`、`docs/BACKEND_TASKS.md`；建立 `docs/LOAD_TEST_<日期>_VEHICLES.md`。

- [ ] **步驟 1：寫測試** `metrics` 輸出含 `temple_physics_step_seconds_bucket`、`_sum`、`_count`、`temple_physics_step_seconds_max`；`loadtest` 冒煙測試加 `--drivers 2`，結果 JSON 的 `recv_by_kind.cars > 0` 且 `invalid_frames == 0`。
- [ ] **步驟 2：實作** `Metrics::physics_done(Duration)`（比照 `tick_done`）；`loadtest --drivers N`：前 N 個連線走到檔口、依車種輪流 `claim`、之後以 15 Hz 送隨機方向的 `drive`，結果加 `drivers`、`cars_interval_ms{p50,p99}`。
- [ ] **步驟 3：量測** 10 個房間、每房 50 人、`--drivers 100`（每房 10 台）、60 秒，另跑一次 `--drivers 0` 作對照。報告記錄物理步 p50／p99／最大值、tick 時間、程序 CPU、每連線每秒收到的位元組數（分 `cars` 與其他），註明機器與「不是 1 vCPU 目標機的容量聲明」。
- [ ] **步驟 4：** 在 `docs/BACKEND_TASKS.md` 新增任務條目：v5 訊息表、`cars` 位元組配置、車輛規則、驗收標準（即任務 6、7 的測試名稱）。
- [ ] **步驟 5：** `cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test`；`npm run typecheck && npm test && npm run build`。
- [ ] **步驟 6：提交** `後端：物理指標、負載工具的駕駛模式與量測報告`，開 PR 1。

**第 1 段稽核方式：** 我會跑三個 cargo 檢查與前端三個檢查；以 `python -I` 重新產生向量比對固定資料；逐條對照任務 6、7 的測試名稱是否存在且斷言與本計畫的數值一致；讀 `room/vehicles.rs` 確認沒有 `.await` 連線、所有下行都是 `try_send`；核對負載報告的物理步 p99 是否小於 1 ms 及流量數字。

---

# 第 2 段：前端顯示（不預測）與 mock（PR 2，分支 `feat/bumper-cars-client`）

完成後：所有玩法可玩，開車手感有 0.1～0.2 秒延遲。

### 任務 9：前端的車輛規則與檔口障礙物

**檔案：** 建立 `web/src/game/world/vehicles.ts`、`vehicles.test.ts`；修改 `web/src/game/world/layout.ts`、`server/src/world.rs`、`web/src/game/world/zones.test.ts`、`web/tsconfig*.json`（若需允許 import `../shared`）。

**介面（產出）：**

```ts
export const VEHICLES: VehicleParams            // import 自 shared/vehicles.json，型別化
export const CAR_KINDS: ReadonlyArray<{ id: string; rarity: 'common' | 'rare' | 'mythic'; count: number; label: MessageKey }>
export const BOOTH: Rect                         // layout.ts 匯出並加入 OBSTACLES
export function knockLanding(zone: ZoneDef, x: number, z: number, dx: number, dz: number, distance: number): { x: number; z: number }
export function stockLeft(cars: Iterable<{ kind: number }>): number[]          // 每個車種的剩餘數
export function nearestEmptyCar(cars: Iterable<CarView>, x: number, z: number): CarView | null   // 車身距離 ≤ mountRadius 的最近空車
export function nearBooth(x: number, z: number): boolean
export function distanceToCar(car: { x: number; z: number; heading: number }, x: number, z: number): number
export interface CarView { c: number; kind: number; driver: string | null; x: number; z: number; heading: number; fadeAt: number | null }
```

- [ ] **步驟 1：寫測試**
  - `檔口與停車位不卡進障礙物`：`BOOTH` 不與其他障礙物重疊；三個停車位、檔口櫃台前的站位都不在 `OBSTACLES` 內；出生點到殿門的 `findPath` 仍有路。
  - `knockLanding 與伺服器同規則`：與任務 7 相同的兩個情境得到相同結論。
  - `stockLeft`：場上有 2 台 `classic`、1 台 `firewheel` → `[2, 3, 2, 0]`。
  - `nearestEmptyCar 忽略有人的車與太遠的車`。
  - `distanceToCar 在車身內為 0`。
  - Rust `world::tests`：庭院 `solids` 含檔口矩形，與 `shared/vehicles.json` 的 `booth.rect` 相同。
- [ ] **步驟 2–4：** 失敗 → 實作（前後端的障礙物清單同一個提交加檔口）→ `npm test`、`cargo test` 通過。
- [ ] **步驟 5：提交** `碰碰車：前端規則與檔口障礙物`。

### 任務 10：前端駕駛邏輯、模擬核心與 mock 伺服器

**檔案：** 建立 `web/src/game/vehicles/drive.ts`、`simCore.ts`、`drive.test.ts`、`simCore.test.ts`；修改 `web/package.json`、`package-lock.json`、`web/scripts/mock-server.mjs`、`docs/TECH_STACK.md`。

**介面（產出）：**

```ts
// drive.ts（不可有任何 import）
export function wrapAngle(a: number): number
export function drive(m: CarMotion, input: DriveInput, p: CarParams): { force: number; w: number; lateralKeep: number }
// simCore.ts（只 import 型別與 drive.ts，帶副檔名，Node 可直接載入）
export interface SimCar { c: number; body: unknown; input: DriveInput; occupied: boolean }
export function createSimWorld(RAPIER: RapierModule, solids: Rect[], bounds: Rect, p: VehicleParams): SimWorld
export interface SimWorld {
  spawn(c: number, x: number, z: number, heading: number): void
  remove(c: number): void
  setOccupied(c: number, occupied: boolean): void
  setInput(c: number, input: DriveInput): void
  setState(c: number, s: CarMotion & { x: number; z: number }): void     // 任務 15 的校正用
  setKinematic(c: number, kinematic: boolean): void                      // 任務 15：別人的車
  step(): number[]                    // 回傳本步有明顯碰撞的車
  state(c: number): CarState | null
  free(): void
}
```

- [ ] **步驟 1：** 安裝 `@dimforge/rapier3d-compat@0.21.0`（精確版本）。若任務 1 查到的配對版本要求不同的 npm 版本，以配對為準並在 TECH_STACK 註明。
- [ ] **步驟 2：寫測試**
  - `drive.test.ts`：任務 3 的七個測試逐一對應，數值相同。
  - `simCore.test.ts` `共用駕駛腳本與 Rust 的結果相差小於 5 公分`：讀 `server/tests/drive-script.json`，每 10 步的 `x`、`z` 與 `expected` 相差 < 0.05，朝向相差 < 0.02。
  - `simCore 與 Rust 相同的行為測試`：加速、不進障礙物、休眠後 `step()` 回傳空陣列。
  - `free() 之後再呼叫 step 會丟出錯誤`（確認資源已釋放、沒有靜默使用）。
- [ ] **步驟 3–4：** 失敗 → 實作 → 通過。5 公分過不了時依設計 §8 的規則處理（先查版本與參數；仍不行就改為實測值加餘量並註明）。
- [ ] **步驟 5：mock 伺服器** 以 `simCore.ts` 實作任務 6、7 的規則（可簡化：不做限速、不做 `needs_sync`）；機器人中每 4 個有 1 個會去領車亂開 20～40 秒再下車。以 `setInterval(1000/30)` 步進。
- [ ] **步驟 6：** `npm run mock -- 12` 啟動不報錯，終端顯示機器人領車的紀錄；`npm run build` 後檢查 `dist/assets`，含 rapier 的 chunk 不在 `index.html` 預載清單內（此時還沒有任何前端程式 import 它，應完全不存在）。
- [ ] **步驟 7：提交** `碰碰車：前端駕駛邏輯、模擬核心與 mock 伺服器`。

### 任務 11：車模型、CarFleet 與檔口

**檔案：** 建立 `web/scripts/build-cars.mjs`、`web/public/models/cars.glb`、`web/src/game/render/CarFleet.ts`、`carModel.test.ts`；修改 `web/package.json`（`build:cars`）、`web/src/game/render/TempleScene.ts`、`web/public/lightmaps/*`、`web/assets/backdrops/*`、相關版本常數。

**介面（產出）：**

```ts
export const CAR_MODEL_VERSION = 1
export class CarFleet {
  constructor(parent: THREE.Object3D, tracker: ResourceTracker)
  load(): Promise<void>                     // 失敗時留在替代用的方塊
  /** 每幀呼叫；cars 是要畫的車。opacity 0..1 用抖動式透明。 */
  sync(cars: Iterable<{ kind: number; x: number; z: number; heading: number; opacity: number }>, t: number): void
  set visible(v: boolean)
  dispose(): void
}
```

- [ ] **步驟 1：寫測試** `carModel.test.ts`：`cars.glb` 有四個車種的部位標記屬性（比照 `avatarModel.test.ts`）、總三角形數 ≤ 6000、每個車種的包圍盒落在 `1.1 × 0.9 × 1.8` 公尺內；`firewheel` 的網格名稱與材質不含人形部位。
- [ ] **步驟 2：** 寫 `build-cars.mjs` 並產生模型，造型手法比照 `build-avatar.mjs`（光滑的橢球與旋轉體，Q 版比例，改造型就改腳本裡的數字）：四種車併成一個幾何，頂點屬性 `_KIND` 標示所屬車種；著色器依實例屬性 `kindId` 把其他車種的頂點收合到一點（與衣裝相同的手法）。風火輪是一對帶自發光火焰紋的輪子加中間座位。
- [ ] **步驟 3：** `CarFleet`：一個 InstancedMesh（容量 16）加一個近處投影用的深度材質；抖動式透明在片段著色器以實例屬性 `opacity` 丟棄像素。
- [ ] **步驟 4：** 在 `TempleScene` 加檔口（一般 Mesh、併入靜態合併，位置取 `BOOTH`）；執行 `npm run bake:lightmaps`、`npm run capture:doorway`，`DOORWAY_VIEW_VERSION` 加一。
- [ ] **步驟 5：** `npm test`（含 `courtyardBake.test.ts`、`carModel.test.ts`）通過。
- [ ] **步驟 6：提交** `碰碰車：車模型、CarFleet 與檔口`（模型、烘焙貼圖、擷取圖逐一列出路徑）。

### 任務 12：Vehicles 子系統與 GameCore 接線（不預測）

**檔案：** 建立 `web/src/game/vehicles/Vehicles.ts`、`Vehicles.test.ts`；修改 `web/src/game/GameCore.ts`、`web/src/game/net/NetworkClient.ts`、`NetworkClient.test.ts`、`web/src/game/input/InputController.ts`、`web/src/game/world/Players.ts`、`web/src/i18n/*.ts`。

**介面（消費）：** 任務 5 的訊息、任務 9 的規則、任務 11 的 `CarFleet`。

**介面（產出）：**

```ts
// NetworkClient
sendClaim(kind: number): void
sendRide(car: number | null): void
sendDrive(dir: number, mag: number): number | null     // dir 弧度、mag 0..1，送出前量化成 0..255；回傳用掉的 seq（被節流時為 null）；自帶 15 Hz 節流與 500 ms 心跳
// Vehicles
export class Vehicles {
  constructor(deps: { fleet: CarFleet; net: Pick<NetworkClient, 'sendClaim' | 'sendRide' | 'sendDrive'>; selfId: () => string | null })
  onWelcome(cars: CarSnapshot[]): void
  onCar(m: CarSnapshot): void
  onCarGone(c: number): void
  onCars(ack: number, cars: CarState[], now: number): void
  setLocalZone(zone: ZoneId): void
  get riding(): number | null                          // 自己正在開的車編號
  riderCar(playerId: string): CarPose | null           // 讓 Players 把騎士擺在車上
  setStick(dirX: number, dirZ: number): void           // 世界方向，長度 0..1
  claim(kind: number): void
  toggleRide(localX: number, localZ: number): void     // 騎乘中＝下車；否則上最近的空車
  update(now: number, serverNow: number, dt: number): boolean    // 回傳是否仍有車在動
  ui(localX: number, localZ: number): RideUi
  dispose(): void
}
export interface RideUi { riding: boolean; nearCar: boolean; booth: { left: number[] } | null }
```

**GameCore 的改動：**

- 建立 `CarFleet` 與 `Vehicles`（建構時建立、`dispose()` 中釋放，順序在 `net.dispose` 之前）。
- `update()`：騎乘中跳過 `stepMover` 與路徑，把相機相對的輸入轉成世界方向交給 `vehicles.setStick()`，本機玩家座標取自己的車；騎乘視為有操作（更新 `lastInputAt`）；`vehicles.update()` 回傳 true 時併入 `sceneMotion`。
- 出入口檢查：騎乘中進入 portal 範圍不轉場，改以 `toast('ride.dismountFirst')`，4 秒內不重複。
- `onTap`：騎乘中忽略。`performAction`：騎乘中 toast `reason.dismountFirst`。
- `UiState.ride: RideUi`；`InputController` 新增 `onKey(code)` 回呼，GameCore 處理 `KeyE` → `toggleRide`。
- 背景分頁（`onVisibility`）與 `applyZone`：若在騎乘送 `sendRide(null)`。
- 收到 `error` 代碼為四個新代碼時走既有的 `SERVER_ERRORS` 提示。
- `Players`：`riderCar(id)` 有值的玩家（含本機）以車的位置與朝向擺放、不播走路。

**顯示規則（此任務不預測）：** 所有車（含自己的）在最近兩筆 `cars` 狀態之間插值，規則同 `world/interp.ts`；超過 5 公尺直接套用；休眠的車維持最後狀態。淡出：`opacity = clamp((fadeAt + fadeMs - serverNow) / fadeMs, 0, 1)`。

- [ ] **步驟 1：寫測試**
  - `Vehicles.test.ts`：`welcome 重建車的清單且清除騎乘狀態`（斷線重連情境：先騎乘、再 `onWelcome` → `riding === null`、車數等於快照）；`car 訊息的 driver 是自己時 riding 變成該編號`；`carGone 移除車並在 riding 相同時清除騎乘`；`cars 幀在兩筆之間插值`；`超過 5 公尺直接套用`；`淡出的不透明度`（`fadeAt` 前為 1、過一半為 0.5、結束為 0）；`ui() 在檔口旁回傳各車種剩餘數`；`toggleRide 在沒有空車時不送出`；`切到殿內後 update 不畫車`。
  - `NetworkClient.test.ts`：`sendDrive 輸入不變時每 500 ms 送一次、改變時最多 15 Hz`；`seq 在 65535 之後回到 0`；`進入背景時若在騎乘先送 ride null`（由 GameCore 呼叫，測 `setBackground` 不會清掉這則）。
- [ ] **步驟 2–4：** 失敗 → 實作 → `npm run typecheck && npm test` 通過。
- [ ] **步驟 5：實機確認**：`npm run mock -- 12` 加 `npm run dev`，可看到機器人開車、車會插值移動、切到殿內再出來車都在。
- [ ] **步驟 6：提交** `碰碰車：Vehicles 子系統與 GameCore 接線`。

### 任務 13：介面與多語系

**檔案：** 建立 `web/src/ui/RidePanel.vue`；修改 `web/src/App.vue`、`web/src/i18n/zh-Hant.ts`、`en.ts`、`ja.ts`、`vi.ts`、`web/src/game/world/vehicles.ts`（車種 `label`）。

**新字串（鍵與繁中原文；其餘三語照意思補齊）：**

| 鍵 | 繁中 |
|---|---|
| `ride.mount` | 上車 |
| `ride.dismount` | 下車 |
| `ride.dismountFirst` | 下車才能進殿 |
| `reason.dismountFirst` | 先下車 |
| `ride.boothTitle` | 領碰碰車 |
| `ride.left` | 剩 {n} 台 |
| `ride.soldOut` | 已領完 |
| `ride.kind.classic` / `woodfish` / `racer` / `firewheel` | 經典碰碰車／木魚車／跑車／風火輪 |
| `ride.rarity.common` / `rare` / `mythic` | 普通／稀有／神話 |
| `server.carUnavailable` | 這台車被開走了 |
| `server.boothCrowded` | 檔口前太擠，等一下再領 |
| `server.claimCooldown` | 剛領過車，稍後再領 |

- [ ] **步驟 1：** 加字典鍵（`i18n.test.ts` 會檢查四語齊全、佔位符一致）。
- [ ] **步驟 2：** `RidePanel.vue`：props `ride: RideUi`、`onToggle()`、`onClaim(kind)`。`ride.riding || ride.nearCar` 時在右側欄、說話按鈕上方顯示一顆上車／下車按鈕；`ride.booth` 有值且未騎乘時顯示四格領車面板（車種名、稀有度、剩餘數；剩 0 的格子停用）。不可蓋住搖桿區（左下 45% × 45%）與動作列。
- [ ] **步驟 3：** `App.vue` 掛上元件，呼叫 `core.toggleRide()`／`core.claimCar(kind)`。
- [ ] **步驟 4：** `npm run typecheck && npm test`；以瀏覽器 400 px 寬與橫向各確認一次按鈕不重疊。
- [ ] **步驟 5：提交** `碰碰車：上下車按鈕、領車面板與多語系`。

### 任務 14：撞飛、騎乘姿勢、推車與聲音

**檔案：** 修改 `web/src/game/render/AvatarFactory.ts`、`web/src/game/anim/AnimationSystem.ts`、`web/src/game/GameCore.ts`、`web/src/game/world/Players.ts`、`web/src/game/world/movement.ts`、`web/src/game/vehicles/Vehicles.ts`、`web/src/game/audio/AudioManager.ts`（或新檔 `vehicles/sfx.ts`）及對應測試。

**介面（產出）：**

```ts
// AvatarRig 新增；AnimationSystem.apply() 每幀重設為 0
lift: number                                   // 整尊離地高度（公尺），AvatarFactory.sync() 套用到身體、頭、臉、名牌
export const FACE_DIZZY = 2
// 片段名稱
'knocked'  // 0..flight：lift = 4*h*p*(1-p)（h = 1.6），pivot 繞 x 軸轉兩圈，臉 FACE_DIZZY；之後趴地再起身
'ride'     // 坐姿：身體壓低、手前伸
// GameCore
onKnock(m: { id; x; z; toX; toZ; at }): void
// MoveConfig 新增
slowZones?: () => Iterable<{ x: number; z: number; heading: number }>   // 空車；重疊時速度 × 0.4
```

**規則：** 收到 `knock`：目標是本機時清除 `path`／`pending`／`lockedAction`、`lockedUntil = at（換算本機時間）+ 1800`、播 `knocked`，位置在前 900 ms 由 `(x, z)` 線性移到 `(toX, toZ)`；不呼叫 `endAction`（伺服器已清掉動作）。目標是遠端時設 `lockedUntil` 並以同樣方式移動，取代原本的片段。轉場淡入淡出中（`fading`）只套用落點、不播片段。`at` 已過期超過 1800 ms 的只套用落點。聲音：`knock` 播撞飛聲；`cars` 幀的 `bumped` 旗標播碰撞聲；皆依與本機玩家的距離衰減（20 公尺外不播）、同時最多 3 聲。

- [ ] **步驟 1：寫測試**
  - `knocked 片段在一半時離地最高、結束時回到地面且 pivot 旋轉歸零`。
  - `apply() 每幀把 lift 重設為 0`。
  - `本機被撞飛：取消走向香爐的 pending、1.8 秒內不接受移動、結束時位於落點`。
  - `本機在淡入淡出中被撞：位置更新、不播片段、轉場照常完成後可以移動`（審查重點 4）。
  - `撞飛中的上香動作被中斷且不送 endAction`。
  - `遠端玩家被撞飛時取代原本的鎖定片段`。
  - `過期的 knock 只套用落點`。
  - `走進空車時速度降為 40%，離開後恢復；有人的車不影響`。
  - `碰撞聲超過 20 公尺不播、同時最多 3 聲`。
- [ ] **步驟 2–4：** 失敗 → 實作 → `npm run typecheck && npm test && npm run build` 通過。
- [ ] **步驟 5：實機確認**（mock 12 個機器人）：站在庭院被撞飛並起身、上香到一半被撞、開車撞機器人、推空車、殿門口的提示、下車後車在 60 秒內淡出。
- [ ] **步驟 6：提交** `碰碰車：撞飛、騎乘姿勢、推車與聲音`，開 PR 2。

**第 2 段稽核方式：** 我會跑前端三個檢查與 `cargo test`（任務 9 動到 `world.rs`）；重跑 `python -I` 向量比對；以 mock 加 dev 伺服器實際操作任務 14 步驟 5 的每一項並擷圖；開效能資訊記錄庭院有 10 台車時的 draw call（預期比沒有車多不超過 2，加檔口的靜態合併不增加）；檢查 `dist` 的首次載入 chunk 不含 rapier；核對四語字典與 `firewheel` 沒有人形；擷圖比對車、檔口與公仔放在一起時是否同一種 Q 版風格。

---

# 第 3 段：前端預測（PR 3，分支 `feat/bumper-cars-prediction`）

### 任務 15：VehicleSim

**檔案：** 建立 `web/src/game/vehicles/VehicleSim.ts`、`VehicleSim.test.ts`；修改 `web/src/game/vehicles/Vehicles.ts`、`web/src/game/GameCore.ts`、`docs/TECH_STACK.md`。

**介面（消費）：** 任務 10 的 `createSimWorld`、`SimWorld`。

**介面（產出）：**

```ts
export class VehicleSim {
  static shouldLoad(conn: { saveData?: boolean; effectiveType?: string } | undefined): boolean   // 資料節省或 2g/3g → false
  static load(): Promise<VehicleSim | null>            // import('@dimforge/rapier3d-compat')；失敗回傳 null
  setCars(cars: Iterable<CarState>, self: number | null): void      // 自己的車動態、其餘運動學
  pushInput(seq: number, input: DriveInput): void
  reconcile(ack: number, server: CarState, others: CarState[]): void
  advance(dt: number): void                             // 累加器，固定 1/30，每次最多 3 步
  selfPose(): { x: number; z: number; heading: number } | null       // 已含誤差平滑
  readonly correction: { last: number; samples: number[] }           // 每次校正的位置修正量（公尺），供量測
  dispose(): void                                       // world.free()
}
```

**規則：**

- `Vehicles` 在第一次 `nearBooth` 或 `toggleRide` 時，若 `shouldLoad()` 為真就呼叫 `load()`；尚未載入、載入失敗或 `shouldLoad()` 為假時，行為與第 2 段完全相同。
- 每個固定步：以該步的輸入模擬，並把 `{seq, input}` 記入歷史（上限 120 筆）。
- `reconcile`：丟掉 `seq ≤ ack`（u16 環繞比較）的歷史 → 把自己的車設成 `server` → 其他車設成各自的伺服器狀態並以速度外推 → 依序重播剩下的輸入 → 新舊位置的差記為誤差偏移，以 `exp(-dt*10)` 衰減。
- 誤差超過 3 公尺直接套用（不平滑）。
- 下車、`carGone`、`welcome`、切換場景：清空歷史與偏移。
- 背景分頁停止 `advance`；回來時清空歷史並以下一則 `cars` 為準。

- [ ] **步驟 1：寫測試**（以任務 10 的 `simCore` 另建一個「假伺服器」世界，人為延遲 N 步後才把狀態送回）
  - `延遲 150 ms、直線行駛時預測位置與伺服器最終位置相差小於 5 公分`。
  - `校正後不重播已被確認的輸入`：`ack` 之後的歷史長度等於未確認的輸入數。
  - `seq 環繞（65530 → 5）時歷史正確裁切`。
  - `伺服器位置突然相差 4 公尺時直接套用`。
  - `誤差偏移在 300 ms 內衰減到 5% 以下`。
  - `下車後歷史與偏移清空`。
  - `shouldLoad 在 saveData 或 3g 時為 false`。
  - `load 失敗時 Vehicles 繼續使用插值顯示`（模擬 `import()` 丟出錯誤）。
  - `dispose 後 world 已釋放`。
- [ ] **步驟 2–4：** 失敗 → 實作 → `npm run typecheck && npm test && npm run build` 通過；檢查 `dist`：rapier 在獨立的延遲載入 chunk，不在 `index.html` 預載清單。
- [ ] **步驟 5：量測上線門檻。** 開啟效能資訊（加一行顯示 `correction` 的 p95），瀏覽器節流到 150 ms 延遲，單獨開車 60 秒不碰撞。**p95 < 0.30 公尺才算通過**；未通過時先調整平滑與外推，仍未通過就把預測關在一個預設關閉的設定後面，並在 TECH_STACK 註明。
- [ ] **步驟 6：提交** `碰碰車：前端預測與重播校正`，開 PR 3。

**第 3 段稽核方式：** 跑前端三個檢查；讀 `VehicleSim.ts` 確認每條 `dispose`／失敗路徑都會 `free()`；檢查建置產物的 chunk 切分；以 150 ms 節流實際開車並回報我量到的 p95；關閉網路再開確認重連後能繼續開。

---

# 第 4 段：收尾（PR 4）

### 任務 16：量測與文件

**檔案：** 修改 `docs/TECH_STACK.md`、`CLAUDE.md`、`docs/ASSETS.md`、`docs/BACKEND_TASKS.md`。

- [ ] **步驟 1：** 桌面 Chromium、1280 × 720、高畫質與標準畫質各量一次：庭院 0 台車與 10 台車（mock 機器人）的 draw call、三角形數、CPU 每幀時間，寫進 TECH_STACK 的量測表，註明非手機實測。
- [ ] **步驟 2：** TECH_STACK「物理引擎」一節改寫：已引入、兩邊版本、延遲載入、world 由 GameCore 的 `Vehicles` 子系統擁有（取代「由玩法模組擁有」）、預測門檻的量測結果、流量量測結果與是否超出預算。
- [ ] **步驟 3：** `CLAUDE.md`：狀態加碰碰車、協定版本改 5、新子系統與檔案、`build:cars` 指令、「改檔口或庭院幾何要重烘焙」、`CAR_MODEL_VERSION`、`shared/vehicles.json` 是唯一來源。
- [ ] **步驟 4：** `docs/ASSETS.md`：車模型為程式產生，無第三方素材。
- [ ] **步驟 5：** 兩邊全部檢查通過後提交 `文件：碰碰車的量測與說明`，開 PR 4。

**第 4 段稽核方式：** 逐項對照設計 §2 的目標與反目標、§8 的驗證清單，列出每一項的證據（測試名稱、量測數字或擷圖），沒有證據的照實列為未完成。

---

# 修訂（2026-11-21）：遊戲區與領車 NPC

設計 §5.2 已改：檔口擴成西南角的遊戲區，車只能向 NPC 領，不採停車場模式。**領車時機與稀有度分配尚未決定**（設計 §5.2 的方向 A–D），決定後再補任務 18；任務 17 只做已定的部分，不改協定、不改伺服器。

### 任務 17：遊戲區鋪面、領車 NPC 與出車效果（前端，併入第 2 段）

**檔案：** 修改 `shared/vehicles.json`、`server/src/vehicles/params.rs`、`web/src/game/world/vehicles.ts`、`web/src/game/render/TempleScene.ts`、`web/src/game/vehicles/Vehicles.ts`、`web/src/game/render/CarFleet.ts`、`web/src/i18n/*.ts`；重跑 `npm run bake:lightmaps`、`npm run capture:doorway` 並把 `DOORWAY_VIEW_VERSION` 加一。

**`shared/vehicles.json` 的 `booth` 新增兩個欄位（既有的 `rect`、`counter`、`bays` 不動）：**

```json
"zone": { "minX": -18.5, "maxX": -9.3, "minZ": 6.0, "maxZ": 13.2 },
"npc": { "x": -12.8, "z": 9.25, "heading": 1.5708 }
```

**介面（產出）：**

```ts
// world/vehicles.ts
export const GAME_ZONE: Rect            // = VEHICLES.booth.zone
export const BOOTH_NPC: { x: number; z: number; heading: number }
// Vehicles.ts：收到 driver 由 null/不存在變成有人、且車在停車位半徑內的 `car` 時
//   → CarFleet.popIn(c, now)（0.4 秒由 0.2 倍放大到 1 倍）並讓 NPC 播一次 `nod`
```

**規則：**

- 鋪面是一般 Mesh 的靜態物件（併入靜態合併與烘焙），用庭院既有的石或木材質換一種色調；矮木欄只放在西、北兩側、可走範圍之外，不加碰撞。兩棵樹（`(-17, 6)`、`(-14, 14)`）不動。
- NPC 用 `AvatarFactory` 建一尊本機公仔（不進 `Players` 的遠端清單、不經網路），固定衣裝、名牌文字取字典 key `vehicles.npcName`；只在庭院顯示；`GameCore.dispose` 時釋放。
- 出車效果純前端：伺服器的生車位置與時間不變；資料節省或低畫質時照樣播（只是縮放，沒有額外 draw call）。「一陣煙」沿用 `IncenseSystem` 的煙材質做不到就省略，不為它新增 draw call。

- [ ] **步驟 1：寫測試**
  - Rust `params::tests::zone_contains_booth_counter_bays_and_npc`：`zone` 包含 `rect`、`counter`、三個停車位中心與 `npc`；`npc` 在 `rect` 內。
  - 前端 `vehicles.test.ts` `遊戲區在庭院邊界內且不蓋到中軸`：`GAME_ZONE` 在 `WORLD_BOUNDS` 內、`maxX < -4`（不碰到石燈籠與中軸）。
  - 前端 `Vehicles.test.ts` `有人在停車位領到車時觸發出車效果一次，別處上車不觸發`。
  - 既有的 `courtyardBake.test.ts` 在重烘焙後通過。
- [ ] **步驟 2–4：** 失敗 → 實作 → 前端三個檢查與 `cargo test` 通過。
- [ ] **步驟 5：** 以 `npm run dev` 加 `npm run mock` 實際領一台車，擷圖確認鋪面、NPC、名牌與出車效果；開效能資訊確認 draw call 比任務 11 的量測不增加。
- [ ] **步驟 6：提交** `前端：遊戲區鋪面、領車 NPC 與出車效果`。

**稽核方式：** 跑前端三個檢查與 `cargo test`；看擷圖比對 NPC 與鋪面是否同一種 Q 版風格、NPC 不是神明形象；記錄 draw call。

### 任務 18：領車時機與稀有度（待決定後補）

---

## 設計涵蓋對照

| 設計章節 | 任務 |
|---|---|
| §5.1 車種與數量 | 2、9、11、13 |
| §5.2 檔口 | 2、6、9、11、13 |
| §5.3 上下車 | 6、12、13 |
| §5.4 淡出 | 6、11、12 |
| §5.5 推車 | 4、14 |
| §5.6 撞飛 | 7、14 |
| §5.7 不能進殿 | 6、12 |
| §5.8 操作 | 3、10、12 |
| §5.9 聲音 | 14 |
| §6.1 伺服器 | 1–8 |
| §6.2 協定 | 5 |
| §6.3 前端 | 9–15 |
| §6.4 mock | 5、10 |
| §6.5 共用參數 | 2、9 |
| §7 預算 | 8、11、16 |
| §8 驗證 | 各任務的測試；4 與 10 的共用腳本；15 的門檻 |
| §9 文件 | 1、8、10、16 |
