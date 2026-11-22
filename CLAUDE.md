# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

專案規範以 [AGENTS.md](AGENTS.md) 為準（繁體中文撰寫說明與報告、識別字用英文、資源釋放、訊息上限等），本檔不重複。版本與技術決策的唯一來源是 [docs/TECH_STACK.md](docs/TECH_STACK.md)；後端任務與驗收標準在 [docs/BACKEND_TASKS.md](docs/BACKEND_TASKS.md)（T4 起由 Claude 實作並依驗收標準驗證）。

## 狀態

- `web/`：Vite 8 + Vue 3.5 + TypeScript + 直接操作 Three.js 的前端，已可運作。
- `server/`：Rust + Axum 後端，進度見 docs/BACKEND_TASKS.md。前端開發時仍可用 `web/scripts/mock-server.mjs` 測試多人功能，它實作與正式伺服器相同的協定。
- 移動：觸控裝置（`(any-pointer: coarse)`）用 `ui/Joystick.vue` 浮動式虛擬搖桿（畫面左下約 45%×45% 為觸控區，橫向時以 `min-height` 保證容納閒置提示圈，類比輸出、死區 0.12，直接呼叫 `GameCore.setMoveStick()`，非零時優先於鍵盤；換算在 `game/input/stick.ts`；場景切換開始時以 `suspended`（`UiState.fading`）放開搖桿，與鍵盤一樣要重新按下才會再走）；桌機用 WASD／方向鍵，或滑鼠點擊地面以尋路走過去（顯示目標標記；點到主殿建築時走向殿門）。點擊移動只接受滑鼠與觸控筆（`InputController` 依 `pointerType` 忽略手指點擊），觸控裝置只用搖桿。進出主殿是走進出入口範圍觸發。`stepMover` 的方向輸入長度 ≤ 1 時速度按比例（半推半速），> 1 時正規化（鍵盤對角仍是全速）。
- 玩法：參拜（`gameplay/modules/worship.ts`）——合十、跪拜（殿內走到空蒲團叩拜三次）、誦經（殿內走到空蒲團跪坐敲木魚 24 秒，可提前起身，`modules/chant.ts`）、上香（走到最近的香爐前三拜後插香）、敲鐘（庭院走到鐘亭前拉撞木撞鐘，`modules/bell.ts`）；庭院碰碰車（`game/vehicles/`，後端 `server/src/vehicles/`）——庭院西南側車檔（booth）借車（`claim`，冷卻 20 秒）、空車靠近手勢上車（`ride`）、虛擬搖桿／鍵盤駕駛（`drive`，前後油門＋轉向）、車車剛體碰撞與彈性回彈（restitution 0.6）、大於 2.5 m/s 撞擊步行玩家具備撞飛與 3 秒無敵保護（`knock`）、閒置 60 秒下車、空車 15 秒淡出回收。計分、持久化等尚未定義。

## 指令（皆在 `web/` 執行）

```bash
npm ci
npm run dev                          # http://localhost:5173
npm run typecheck                    # vue-tsc -b
npm test                             # vitest run（src/**/*.test.ts）
npx vitest run src/game/net/net.test.ts        # 單一測試檔
npx vitest run -t "部分測試名稱"                # 依名稱篩選
npm run build                        # 型別檢查 + 建置到 web/dist
npm run mock -- 20                   # mock 伺服器 ws://localhost:8080/ws，20 個機器人
npm run build:textures               # assets/textures/*.jpg → public/textures/*.ktx2（需 KTX-Software 的 ktx）
npm run build:avatar                 # 以程式產生 public/models/monk.glb 與 monk-lod.glb（不依賴外部模型檔）
npm run build:cars                   # 以程式產生 public/models/cars.glb（4 款車身與輪子幾何，CAR_MODEL_VERSION）
npm run bake:lightmaps               # 庭院靜態光照烘焙：匯出幾何 → Blender（Cycles）→ public/lightmaps/*.ktx2（需 Blender 與 ktx）
npm run build:statues                # 殿內神像：.statues-src/ 的原檔 → Blender 減面＋烘焙 → public/statues/（需 Blender 與 ktx）
npm run capture:doorway              # 殿門兩側的景：無頭 Chrome 擷取殿內看出去的庭院、庭院看進去的殿內 → assets/backdrops/，再跑 build-textures.mjs backdrops（需 Chrome 與 ktx；可加 outside／inside 只拍一張）
```

- 環境變數見 `web/.env.example`：`VITE_WS_URL`（未設定＝離線模式）。本機寫在 `web/.env.local`。
- CI（`.github/workflows/web.yml`）：`npm ci` → `typecheck` → `test` → `vite build`，Node 22。
- 無 lint／格式化工具設定。
- 後端（在 `server/` 執行）每個 PR 須通過 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`。

## 架構

### GameCore 是唯一擁有者

`web/src/game/GameCore.ts` 建立並擁有所有子系統（`SceneRenderer`、`TempleScene`、`AnimationSystem`、`Players`、`InputController`、`NetworkClient`、`AudioManager`、`ActionRegistry`、`Vehicles`、`CarFleet`），負責建立與釋放順序、渲染排程、網路訊息分派，以及推送給 Vue 的 `UiState`。新增子系統時，在 GameCore 建立並在其 dispose 中釋放。

- **Vue ↔ 核心邊界**：Vue（`src/App.vue`、`src/ui/`）只透過 `onUi(UiState)` 接收低頻摘要（內容改變才推送，最多每 250 ms 一次），透過 GameCore 的方法下指令。高頻狀態（玩家位置、Three.js 物件）不放進 Vue 響應式系統。
- **GPU 資源**：geometry／material／texture 透過 `render/ResourceTracker` 的 `track()`／`trackMaterial()` 登記，由 tracker 統一釋放。
- **渲染排程**：前景時一律以畫質的幀率上限繪製（省電與標準 30、高畫質 60 FPS；`auto` 依 `detectQuality()` 的裝置規則選，觸控裝置自動畫質時 `AdaptiveQuality` 固定在等級 1 以下、不升到等級 0），庭院有持續的環境動畫，所以不會停止迴圈；15 秒（觸控裝置為 8 秒）沒有操作也沒有移動時降到 20 FPS、60 秒降到 10 FPS，一有操作立即恢復；電量過低（`getBattery`，僅 Chromium：未充電且 ≤ 20%）時操作中也只到 20 FPS（皆由 `core/frameCap.ts` 的 `frameCap()` 決定）。另外由 `core/AdaptiveQuality.ts` 依實際幀間隔動態調整（網頁讀不到溫度）：變慢約 2 秒就降一級（降低繪製解析度、縮小完整模型與投影的範圍），順暢約 30 秒才升回（穩定超過 2 分鐘才變慢視為過熱，隔 10 分鐘才升回）；等級表是 `ADAPTIVE_LEVELS`。背景分頁停止迴圈、暫停 AudioContext、停止送位置。自動畫質遇資料節省或 3g 以下網路時，貼圖與神像降為 512／std（`effectivePreset()`）。改動任何會讓畫面變化的狀態，記得呼叫 `wake()`。
- **聊天**：文字聊天（`{ t: 'chat' }`，不需 reqId／ack，伺服器清理、限速並廣播給同房所有人含發話者）。`protocol.ts` 有與伺服器同規則的 `sanitizeChat()` 與 `ChatLimiter`（突發 3 則、每 2 秒補 1 則）；`NetworkClient.sendChat()` 清理並限速後送出（回傳 `sent`／`empty`／`rate`／`offline`，斷線直接丟棄）。`GameCore.sendChat()` 連線時以伺服器回音為準（不先顯示），離線模式本機直接回音；`onChat()` 把 `ChatEntry` 放進 `UiState.chat`（最近 30 則，name 在收到當下解析）並以 `Players.say()` 在頭上顯示 6 秒的泡泡（`AvatarFactory` 的 canvas 精靈，只限名牌顯示中的人與本機玩家，文字不經 HTML）。UI 是 `ui/ChatPanel.vue`（說話按鈕在右側動作列上方，Enter 開啟、Esc 關閉；紀錄在左上，關閉時最近 5 則 12 秒淡出）。
- **角色繪製**：角色是 Q 版小沙彌公仔（`public/models/monk.glb`，沒有骨架）。身體（袍與鞋）與膚色部分（頭與手）與臉各分近、遠兩批，加上影子，以 InstancedMesh 批次繪製（固定 7 個 draw call；有人手上拿香時另加 1 個，有人誦經時木魚與槌另加 1 個）：離本機玩家 `nearRadius` 內用完整模型並投影，之外用 `monk-lod.glb` 且不投影；動畫是公仔式的：整尊繞腳底傾斜；蹲坐時壓扁、走路時彈跳只作用在身體（袍與鞋），頭、耳朵、手與臉用不縮放的剛體矩陣只隨肩膀（`SHOULDER_HEIGHT`）升降，不會變形（`AvatarFactory.sync()`）；`nod` 是整尊小幅前傾點頭，`rig.head` 的旋轉仍不會顯示。整尊由 `scripts/build-avatar.mjs` 以光滑的橢球與旋轉體產生（頭、耳朵、鐘形的袍、寬袖、合十的手、鞋尖），造型要改就改腳本裡的數字再重新產生。臉是貼合頭部曲面的一層（近、遠都畫，各取自該 tier 自己的膚色幾何，不投影），五官畫在執行時產生的圖集上，每格一種表情（`FACE_CALM` 豆豆眼、`FACE_SMILE` 瞇瞇笑眼、`FACE_DIZZY` 旋渦眼）；動畫片段以 `rig.face` 指定表情，`AnimationSystem.apply()` 每幀重設為平常的臉；手上拿的東西同理以 `rig.prop`（`PROP_INCENSE` 香、`PROP_CHANT` 木魚與槌）指定，由 `AvatarFactory` 畫在合十的手上；`rig.propAngle` 是槌抬起的角度（每幀重設為 0）。木魚與槌合成一個幾何（`render/chantProps.ts`），一個 InstancedMesh 每人兩個實例，以實例屬性決定畫哪一部分。容量 `AVATAR_CAPACITY`（160）須大於最高畫質的可見人數；名牌（`render/Nameplate.ts`，每人獨有的貼圖與材質，改名時換貼圖並立即釋放舊的）只顯示最近 12 人與本機玩家自己（進場與改名時以 `Avatar.setName()` 設上）。外觀完全由衣裝編號決定（`world/outfits.ts`，8 套，只能加在尾端）：模型裡同時有鐘形的袍與武僧短褂（及臀上衣、腰帶、長褲、綁腿、束袖口）兩種輪廓、念珠與斗笠，依衣裝在頂點著色器把用不到的部位縮到一點，不增加 draw call。body 的 `_OUTFIT`（x 披帶距離、y 部位 `BODY_PART`）與 skin 的 `_PART`（皮膚 0、斗笠 1；斗笠併在膚色網格，跟著頭的剛體矩陣走，臉只從皮膚取）都在著色器裡依實例屬性 `outfitId`（body 與 skin 共用）查色表；陰影用同樣修補過的深度材質（`customDepthMaterial`），收合掉的部位不投影。戴斗笠的衣裝名牌與泡泡升高 `HAT_LABEL_LIFT`。改造型後重跑 `npm run build:avatar` 並把 `AVATAR_MODEL_VERSION` 加一（網址帶版本，否則舊快取的模型配新程式會停在替代用的圓柱），模型屬性由 `avatarModel.test.ts` 檢查。`GameCore.setOutfit()` 套用並存進設定，第一次造訪隨機挑一套；連線時 `NetworkClient` 把衣裝帶在每次 hello、更換時送 `outfit`（自帶限速與補送）；本機立即換，不等伺服器；收到 id 為自己的 `outfit` 回音一律忽略（較舊的回音晚到不可把外觀改回去），遠端玩家的 `outfit` 與 welcome／join 快照經 `Players.setRemoteOutfit()`／`upsert()` 套用，welcome 不覆蓋本機衣裝。
- **碰碰車系統**：車輛子系統 `Vehicles`（`game/vehicles/Vehicles.ts`）由 GameCore 建立與釋放，負責檔口（booth）接近偵測、動態延遲載入 Rapier WASM、管理本機預測模擬器 `VehicleSim`、接收伺服器 `cars` 二進位幀進行重播校正與遠端車輛插值。車隊網格 `render/CarFleet.ts` 以 InstancedMesh 批次繪製（4 款車身、輪子與俯仰擺動，0 台車時 0 draw call，有車時 1～2 個 draw call）。碰撞反彈由 `sfx.ts` 播放音訊並切換暈眩表情 `FACE_DIZZY`。改車輛模型重跑 `npm run build:cars` 並將 `CAR_MODEL_VERSION` 加一。
- **庭院視覺**：`render/TempleScene.ts` 以程序化幾何＋ Poly Haven CC0 貼圖的 `MeshStandardMaterial` 建構（貼圖為 KTX2，在 `web/public/textures/`，原檔在 `web/assets/textures/`；UV 以公尺為單位）；`SceneRenderer` 負責程序化天空、天空環境貼圖、戶外色調映射與主光陰影。陰影、貼圖解析度與細節貼圖依 `core/settings.ts` 的畫質預設在載入時決定。細節與量測見 docs/TECH_STACK.md「庭院視覺」。
- **靜態光照烘焙**：庭院靜態物件的影子與 AO 是 Blender 烘焙的貼圖（RGB = AO 走 `aoMap`，A = 太陽可見度由 `patchBakedSun` 乘在平行光上），不進即時陰影貼圖；標準畫質沒有陰影貼圖，高畫質的陰影貼圖只給近處角色。uv1 由 `render/lightmapUv.ts` 在執行時產生（與烘焙匯出同一份程式）；幾何指紋不符時 `courtyardBake.test.ts` 失敗，開發模式另會退回即時陰影並警告（正式版不計算指紋、直接載入，貼圖網址帶 `?v=<指紋>`）：**改了庭院幾何（含車輛檔口）、太陽方向（`OUTDOOR_SUN_POSITION`）或 `BAKE_SETTINGS` 要重跑 `npm run bake:lightmaps`**。會動的物件（樹冠、晾衣）用 InstancedMesh 且不可與接收烘焙的物件共用材質；新增的靜態物件用一般 Mesh。角色走進烘焙影子不會變暗（已知限制）。細節見 docs/TECH_STACK.md「靜態光照烘焙」。
- **場地與場景**：`world/zones.ts` 定義庭院與殿內兩個場景（可走範圍、障礙物、出生點、出入口、鏡頭範圍），庭院的細節在 `world/layout.ts`。場景建構、碰撞、尋路（`world/pathfind.ts`）都讀這份資料，改場地要一致；`zones.test.ts` 檢查落點不會卡進障礙物或來回瞬移。殿內場景在 `render/HallScene.ts`，第一次進殿才建立；靜態物件以 `render/mergeStatic.ts` 依材質合併。殿門（`render/hallDoorway.ts`）：推開貼牆的格扇門與門框用殿內既有材質；門外的庭院景色是 `render/doorwayView.ts` 的相機投影（離線擷取的全景圖貼在門外的代理幾何上；貼圖兩層：地面與半球取拿掉香爐與石燈籠的底圖，它們的直立片取只有物件本身不透明的那層，否則鏡頭一動會看到兩個香爐），**改了庭院的樣子、太陽方向或 `DOORWAY_VIEW` 要重跑 `npm run capture:doorway` 並把 `DOORWAY_VIEW_VERSION` 加一**。庭院的主殿正面（`TempleScene` 的 `buildHallFront`）共用同一套門框、門扇與格心造型，等比縮小（`HALL_FACADE.scale`）、門扇推開 90°，兩側是同一張格心貼圖的格扇窗；門洞後面是殿內景（同樣的相機投影：殿身裡的代理房間、離線擷取的殿內畫面，不參與烘焙），**改了殿內的樣子或神像要重拍並把 `INTERIOR_VIEW_VERSION` 加一**。蒲團陣列（`HALL_CUSHIONS`，24 個）與香爐（`CENSERS`：殿內三個由 `HALL_STATUES` 導出、加庭院大香爐，各有上香站位）定義在 `zones.ts`，挑選空位的邏輯在 `world/worship.ts`。
- **神像**：三尊是第三方的寫實模型（來源、授權與署名見 docs/ASSETS.md，需署名的兩件列在設定面板的「素材來源」），由 `scripts/process-statues.py` 在 Blender 減面並重新烘焙底色與法線，成品在 `web/public/statues/`：每尊兩個層級（`std` 約 1.5 萬三角形＋1024 貼圖給標準畫質，`hi` 約 4 萬＋2048 給高畫質，依畫質預設的 `statueTier`），幾何是不含材質的 Draco glb（解碼器是 three 附的副本，在 `web/public/draco/`，`draco.test.ts` 檢查），貼圖是 KTX2。第一次進殿建立 `HallScene` 時才下載；到齊前與失敗時插槽顯示 `render/statues.ts` 的程序化造型（佛、觀音；媽祖沒有程序化造型，以紅布覆蓋的神座佔位）。高度在 `STATUE_HEIGHT`，殿內亮度以 `STATUE_LOOK` 的底色倍率調整。**重新處理模型後要改 `STATUE_ASSET_VERSION`**（網址帶版本）。神像是宗教聖像：處理時不可改變造型（臉色、持物、手印）。方位依傳統以神明為主體：觀音在主佛左手邊（+x，龍邊），媽祖在右手邊（-x，虎邊）；程式中的鍵是 `buddha`、`guanyin`、`mazu`，殿內香爐 id 由此導出（`hall:<鍵>`）。

### 多語系

- 介面語言：繁體中文（`zh-Hant`，來源）、`en`、`ja`、`vi`，不用 i18n 套件（理由見 docs/TECH_STACK.md「介面多語系」）。字典在 `web/src/i18n/`：`zh-Hant.ts` 的 key 是唯一來源（`MessageKey`），其他語言型別為 `Record<MessageKey, string>`，缺 key 時 typecheck 失敗；`t(key, { name })` 代換 `{name}`；語言是 `Settings.locale`，`App.vue` 的 settings watch 呼叫 `setLocale()`（同時改 `<html lang>` 與分頁標題）再 `core.applySettings()`。
- 新增字串：在 `zh-Hant.ts` 加 key，補齊 en／ja／vi（`i18n.test.ts` 檢查佔位符一致、沒有空字串、en／vi 沒有漢字假名）。複數用不需要變化的句型（如 "In the temple: 3"）。
- 新增語言：加一份字典、登記在 `i18n/index.ts` 的 `LOCALES`（自稱、CC deed 代碼）與 `DICTS`、`detectLocale()` 補規則、必要時在 `style.css` 以 `:lang()` 加字型堆疊。
- **遊戲核心的字串在顯示當下解析**：動作定義的 `label`、`setStat()` 的標籤、`ZoneDef.name`、衣裝（`world/outfits.ts` 的 `OUTFITS`）的 `label` 存字典 key，由 `GameCore.pushUi()` 或 UI 元件以 `t()` 解析；`unavailableReason()`／`approach()` 回傳的原因在呼叫當下以 `t()` 取得，不要在定義時先算好字串。伺服器 `error` 依 `code` 對照翻譯（`SERVER_ERRORS`），不顯示伺服器的英文 `message`。toast 以發出當下的語言為準。
- 刻意不翻譯：玩家名稱與聊天內容、場景匾額書法（寺名、殿內匾額）、動作按鈕的單字 `glyph`（「香」「經」，當印章式圖示）、`console.*` 與 `throw new Error` 的開發者訊息、程式註解、素材來源的原作品標題、`index.html` 的靜態預設（繁中，執行時由 `setLocale` 改寫標題與 lang）。

### 網路協定

- `src/game/net/protocol.ts` 是前後端協定的定義來源（版本 5）。下行的 `moves`／`sync`／`action`／`cars` 是 WebSocket 二進位幀（`net/binaryFrame.ts`，位元組配置見 docs/BACKEND_TASKS.md T8 與版本 5），其餘訊息與所有上行（含帶 `reqId` 的 `action` 與 `ack`、車輛控制 `claim`／`ride`／`drive`）都是 JSON。編碼集中在 `encode()`／`decode()`；`decode()` 依收到字串或 `ArrayBuffer` 分流並負責驗證，新增伺服器訊息時同步擴充型別與驗證。改協定時前端、mock 伺服器與後端在同一個 PR 修改，共用固定資料 `server/tests/protocol-v5.json`（有效／無效的 JSON 訊息與二進位測試向量，向量由 `server/tests/protocol-v5-vectors.py` 獨立產生）兩邊的測試都要讀。版本不符時伺服器回 `unsupported_version`。
- 車輛協定（v5）：車輛物理與檔口位置以 `shared/vehicles.json` 為唯一來源。上行 JSON 包含：`claim`（借車，近檔口 2.5m 內；不帶車種，伺服器在還有餘額的車種裡依 `weight` 抽）、`ride`（上下車）、`drive`（駕駛輸入，dir 與 mag，帶 seq 供客戶端預測校正）；下行 JSON 包含：`car`（車輛生成快照）、`carGone`（車輛回收）、`knock`（被撞飛事件）；下行高頻二進位幀 `cars`（幀代碼 0x04，表頭 3 bytes 帶 ack，每台車 12 bytes：旗標 byte 含車號、occupied、bumped，量化座標 x/z、朝向 heading、線速度 vx/vz 與角速度 w，不含 kind 與 driver），15 Hz 僅向庭院在線玩家廣播。
- `action` 幀（7 bytes）以房內短編號 `n` 指稱執行者、以一個 byte 的動作編號指稱動作、只帶 `startedAt` 的低 32 位元。`NetworkClient` 的 `FrameContext`（由 `welcome`／`join`／`leave` 維護 `n → id`，由 `welcome`／`pong` 估計伺服器時間）在 `decode()` 時還原成 `{ t: 'action', playerId, id, startedAt }`（絕對 Unix 毫秒，與 v2 相同），GameCore 與玩法看不出差別；對照不到的 `n` 或未知動作編號整則忽略。
- 文字聊天 `chat`（協定 v3 時加入的向下相容擴充，v4 沿用）：上行 `{t:'chat', text}`（原始字串上限 512 bytes）；伺服器清理（移除控制與雙向覆寫字元、空白壓成一格、trim、最多 80 個字元，空則丟棄），限速突發 3、每秒 0.5；下行 JSON `{t:'chat', id, text, at}` 廣播給同房所有在線玩家（不分場景，含本人）。
- 玩家衣裝 `outfit`（同為向下相容擴充，不升版）：衣裝是整數 `0..OUTFIT_COUNT-1`（`OUTFIT_COUNT = 8`，`protocol.ts` 與 Rust 各一份，由固定資料 `outfitCount` 鎖住；新增衣裝只能加在尾端，三邊與 mock 一起改），外觀由客戶端決定、伺服器只驗證範圍、保存、轉送。`hello` 可帶 `outfit`（缺少或無效當作 0，不拒絕）；`PlayerSnapshot.outfit`（前端型別可省略，缺少視為合法；下行只要是 0～255 的整數就接受（`isOutfitWire`），不認得的編號顯示時經 `normalizeOutfit` 落回預設衣裝，舊分頁才不會因新衣裝收不到 `welcome`；不是整數或為負則整則忽略）讓 `welcome`／`join` 帶衣裝；執行中以上行 `{t:'outfit', outfit}` 更換（不需 ack；無效丟棄、限速同聊天、與目前相同不廣播），下行 JSON `{t:'outfit', id, outfit}` 廣播給同房所有在線玩家（含本人；前端驗證同樣寬鬆）。上行（`hello`、`outfit`）伺服器維持嚴格的範圍驗證。`resumeToken` 恢復時保留衣裝，`hello` 帶不同的有效值則以它為準並補廣播。`NetworkClient.setOutfit(n)` 記住衣裝（每次 `hello` 都帶）、已連線時送出；被限速擋下時只保留最新值、額度恢復後補送（不排隊），斷線時不送；送出後約 3 秒內沒收到自己 id、相同值的回音就重送（每個值最多 2 次，較舊值的回音不算確認；確認後又收到不同值的自己回音（A→B→A 時先到第一個 A）則重新等待）。
- 語意分兩類：`move`／`stop` 可取代（`OutboundQueue` 合併未送出的舊位置）；`action` 需確認（帶 `reqId`，伺服器去重並回 `ack`，重送不重複執行）。
- 名字與身份（v4）：進場後改名送 `rename`（可取代，`OutboundQueue` 只留最新一筆；進入背景清佇列時保留尚未送出的 rename）；伺服器清理（去控制字元、trim、1～16 字、空白變「訪客」，約每 2 秒 1 次）後以 `name` 廣播給同房所有人（含本人、不分場景），本人以它為準寫回設定。斷線恢復時伺服器採用 `hello.name`，所以 `NetworkClient.setName()` 也更新之後的 `hello`。`hello.session` 是登入權杖（選填），`welcome.auth` 是 `guest`／`google`／`line`；帶了 session 卻收到 `guest` 是權杖失效：清掉本機權杖、提示後以訪客身份繼續。
- 玩家有所在場景（`zone`）；切換時送 `zone` 訊息，只顯示同場景的遠端玩家。伺服器只把 `moves`／`sync`／`action` 送給同場景的玩家；車輛二進位幀 `cars` 僅廣播給庭院（courtyard）場景的在線玩家。
- 伺服器每個 tick 送批次位置 `moves`（解碼後為 `MoveTuple[]`，只含有變動的玩家，上限 `MAX_MOVES_PER_MESSAGE`；二進位每筆 6 bytes：座標量化到公分、heading 一格 2π/256）。tuple 以房內短編號 `n`（`PlayerSnapshot.n`，0～127）指稱玩家，`Players` 維護 `n → 玩家` 的對照。`sync` 格式相同但語意是整批校正：直接套用不插值（切換場景後、或 `moves` 曾被丟棄後由伺服器送出）。單則訊息上限 `MAX_MESSAGE_BYTES`（16 KB）。
- 遠端玩家的移動（`world/interp.ts`、`Players`）：收到新位置時從目前顯示的位置等速走過去，花的時間等於位置更新的間隔；差距超過 5 公尺直接套用。移動中超過 1 秒沒有更新視為停止。
- 重新整理也走斷線恢復：`resumeToken` 存在 `sessionStorage`（`temple.resumeToken`），新頁面的 `hello` 帶上它就接回原本的玩家（同 id、位置、場景），不會在保留期內留下分身。恢復時 `hello` 的名字與保存的不同就改名（扣改名額度，用完則保留舊名），伺服器在 `welcome` 之後對全房廣播 `name`，不重送 `join`。
- `NetworkClient` 負責重連（`backoff.ts`）、心跳、送出節流與 `resumeToken` 恢復，`binaryType` 設為 `arraybuffer`；渲染頻率與網路送出頻率各自獨立。上行座標取到 0.01；切到背景時若在移動會先補送 `stop`；退避計數在收到 `welcome` 才歸零；收到 `welcome` 之前不送佇列（位置、場景、改名）、`zone` 與背景補送的 `stop`，welcome 清佇列、以快照為準；close code 1013／1008 至少等 5 秒再重連；`unsupported_version` 不再重連並提示重新整理。
- 後端（`server/`）：每個房間一個 actor task 擁有狀態（`src/room.rs`），連線以 channel 溝通，房間只用 `try_send`。場景邊界與出入口常數在 `src/world.rs`，數值抄自前端的 `world/layout.ts`／`zones.ts`，改場地時兩邊要一起改。障礙物也抄了一份在 `src/world.rs`。
- 位置由本機先走、伺服器驗證：伺服器以「移動額度」（防瞬移）與障礙物直線檢查（防穿牆）驗證，拒絕時送只含本人短編號的 `sync`，`GameCore.correctLocal()` 把自己拉回該位置。

### 入寺、登入與名字

- 入寺畫面（`ui/EntryScreen.vue`）掛載時抓 `GET <基底>/auth/providers`（基底由 `VITE_WS_URL` 推導，`core/auth.ts` 的 `httpBaseFromWs()`；逾時 3 秒，失敗或離線＝沒有登入選項、不顯示錯誤）。有提供者時是「以訪客身份入寺」＋「或登入後入寺」的 Google／LINE 按鈕（品牌按鈕是 inline SVG，不載入任何 SDK）；沒有時只有「入寺」。
- 登入＝整頁導向 `<基底>/auth/<provider>/start?origin=`；伺服器導回 `#session=…&provider=…` 或 `#auth_error=cancelled|failed`，`App.vue` 啟動時以 `consumeAuthRedirect()` 立刻以 `replaceState` 清掉 fragment；只有這個分頁導向前以 `markLoginPending()` 寫了 sessionStorage 旗標（只能用一次）才存進 localStorage，否則（別人傳來的 `#session=` 連結，login CSRF）不保存、不覆蓋、不提示；sessionStorage 不可用時不導向登入。導回後不自動進場（音訊需要使用者手勢）。權杖只放在 `hello.session`，不可出現在 console 或提示。登入只用來識別玩家，**不使用 Google／LINE 的個人資料名稱**。登出＝清本機權杖（進場後再 `location.reload()`）。
- 名字：第一次來預填 `core/names.ts` 的 `randomTempleName()`（寺院風格的兩字法號，少量三到四字雅號；字表與排除清單、不可用少林現行字輩當首字的規則在檔頭，`names.test.ts` 窮舉檢查）；清空時也用隨機法號。進場後在設定面板改名（`GameCore.rename()`，離線模式直接生效）。
- mock 伺服器在同一個埠提供開發用假登入（`/auth/providers`、`/auth/<provider>/start` 直接導回 `#session=mock.<provider>`），沒有任何安全性。

### 玩法擴充點

玩法以 `GameplayModule`（`gameplay/types.ts`）加入，不修改渲染、網路或 UI：在 `install(api)` 中以 `api.actions.register()` 註冊動作（動作列、冷卻、動畫、音效、伺服器確認自動接上），`api.animations.registerClip()` 加姿勢、`api.audio.defineSfx()` 以合成函式加音效（`loadSfx()` 載入音檔）、`api.setStat()` 更新 HUD；`install` 回傳的函式須清除全部註冊。模組登記於 `gameplay/modules/index.ts`。`GameplayApi` 刻意保持很小，需要時再擴充。

- 動作定義的 `unavailableReason(zone)`：目前場景不能用時回傳原因，按鈕變暗、按下時以提示說明（只依場景，UI 是低頻摘要）。
- `approach(ctx)`：需要先走到定點的動作回傳站位與面向（或找不到時的原因字串）；GameCore 以尋路走過去，抵達才開始（冷卻、動畫、送出都從抵達算起），玩家自己移動（方向鍵、搖桿或點擊地面）或切換場景即取消。
- `actionPerformed` 事件帶 `zone` 與 `startedAt`；遠端玩家的最後一筆位置比動作晚一個 tick 到，需要準確位置時用 `api.playerPosition(id)`。上香插香就是在插香那一刻依執行者位置推出香爐，不經伺服器、不需協定欄位。
- 遠端玩家做鎖定移動的動作期間（`RemotePlayer.lockedUntil`）不播走路、不取消動作片段，晚到的最後一筆位置只滑過去。收到不鎖定的新動作時解除鎖定；過期才到的動作仍會取代原本的片段（`hidden` 的動作此時仍通知玩法）。
- 可提前結束的鎖定動作：動作定義的 `endAction`（例如誦經的 `chant_end`）。鎖定期間推方向鍵、搖桿、點擊地面或按任何動作時，`GameCore.interruptLocal()` 解除鎖定並執行 `endAction`（一般動作 id，經伺服器轉送，其他玩家也停止）；按同一個動作只起身。`hidden: true` 的動作不顯示在動作列。
- 動畫片段的第三個參數是目前時間（`ClipFn(rig, p, now)`），`api.clockOffset()`（伺服器時間 − performance.now）讓片段與聲音對齊共同的節拍；`audio.play(name, { at })` 在 AudioContext 時間軸上預排聲音。
- 敲鐘：站位、撞木時間軸與聲音規則在 `world/bell.ts`；撞木是動態物件 `render/BellStriker.ts`（GameCore 擁有，1 個 draw call，只在庭院），不在 TempleScene 的 root、不與烘焙材質共用。鐘聲與鐘擺在撞到的那一刻（`startedAt + BELL_HIT_MS`）由各客戶端推算。
- 動作允許清單有兩份，同時是 `action` 幀的動作編號對照表（索引即編號）：`server/src/world.rs` 的 `ACTIONS`（負載工具直接用它）與 `web/src/game/net/binaryFrame.ts` 的 `ACTION_CODES`（mock 伺服器直接用它）。兩邊測試都比對固定資料的 `binary.action.codes`，不一致就失敗。新增動作只能加在尾端（同時改兩份與產生腳本）；改順序或刪除要升協定版本。
- 香爐裡的香與煙是動態物件 `render/IncenseSystem.ts`（GameCore 擁有，2 個 draw call，沒香時 0），不併入靜態幾何、不與庭院烘焙材質共用。

### 音訊

- 沒有背景音樂，聲音留白大於填滿：環境音（風聲、鳥叫、遠處頌缽、隨機 90～210 秒一聲的遠處鐘聲）全部由 `AudioManager` 在執行時合成，走環境音軌（「環境與音樂」音量）。風聲是可循環的雜訊 AudioBuffer 加 lowpass 與緩慢 LFO；遠鐘純本機播放，不經網路、不觸發鐘亭動畫、不喚醒渲染。沒有音檔或音訊相關環境變數。
- 短音效（鐘、木魚、頌缽、鳥叫）同樣由 `AudioManager` 即時合成為 AudioBuffer；玩法模組以 `defineSfx()` 加自己的合成音效（參拜模組的引磬 `synthesizeQing()`：合十在彎腰到底時敲一聲、跪拜每一拜開始前傾時敲一聲、開始起身時壓磬一聲（短促的「嘀」，同時收掉餘韻）；上香是 `synthesizeIncenseOffering()`：三拜留白，插香那一刻香腳入灰的沙聲接一聲大磬；敲點都燒進 buffer，動作開始時播一次）。誦經的木魚（`synthesizeMuyu()`：空心木頭的「篤」，敲下瞬間音高微微下滑）由 `modules/chant.ts` 以伺服器時間的節拍格預排，每拍只發一聲（多人同時誦經也只有一個節奏）；起腔與收腔各一聲大磬（`daqing`，即 `synthesizeIncenseOffering(ctx, 0)`）。法器分工：引磬管禮拜、大磬管起止與上香、木魚管節拍。
- 靜音或音量為 0 時淡出後暫停 AudioContext，風聲、鳥叫與遠鐘停止；背景時同靜音。

## 驗證注意

- 前端變更：`npm run typecheck`、`npm test`、`npm run build`；涉及畫面或互動時以 `npm run dev`（多人加 `npm run mock`）在瀏覽器實際確認。
- 效能數據可在遊戲設定開啟「顯示效能資訊」（FPS、CPU 時間、draw call、本機座標：場景 id 與場景內公尺座標）。目前量測都是桌面 Chromium，非手機實測；容量聲明須附負載條件（見 AGENTS.md）。
- 修改同步或連線生命週期時，用 mock 伺服器驗證斷線重連與多人情境。
