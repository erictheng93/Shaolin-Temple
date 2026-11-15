# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

專案規範以 [AGENTS.md](AGENTS.md) 為準（繁體中文撰寫說明與報告、識別字用英文、資源釋放、訊息上限等），本檔不重複。版本與技術決策的唯一來源是 [docs/TECH_STACK.md](docs/TECH_STACK.md)；後端任務與驗收標準在 [docs/BACKEND_TASKS.md](docs/BACKEND_TASKS.md)（T4 起由 Claude 實作並依驗收標準驗證）。

## 狀態

- `web/`：Vite 8 + Vue 3.5 + TypeScript + 直接操作 Three.js 的前端，已可運作。
- `server/`：Rust + Axum 後端，進度見 docs/BACKEND_TASKS.md。前端開發時仍可用 `web/scripts/mock-server.mjs` 測試多人功能，它實作與正式伺服器相同的協定。
- 玩法尚未定義；`gameplay/modules/demo.ts` 只是驗證接線的示範，可整個刪除。

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
```

- 環境變數見 `web/.env.example`：`VITE_WS_URL`（未設定＝離線模式）。本機寫在 `web/.env.local`。
- CI（`.github/workflows/web.yml`）：`npm ci` → `typecheck` → `test` → `vite build`，Node 22。
- 無 lint／格式化工具設定。
- 後端（在 `server/` 執行）每個 PR 須通過 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`。

## 架構

### GameCore 是唯一擁有者

`web/src/game/GameCore.ts` 建立並擁有所有子系統（`SceneRenderer`、`TempleScene`、`AnimationSystem`、`Players`、`InputController`、`NetworkClient`、`AudioManager`、`ActionRegistry`），負責建立與釋放順序、渲染排程、網路訊息分派，以及推送給 Vue 的 `UiState`。新增子系統時，在 GameCore 建立並在其 dispose 中釋放。

- **Vue ↔ 核心邊界**：Vue（`src/App.vue`、`src/ui/`）只透過 `onUi(UiState)` 接收低頻摘要（內容改變才推送，最多每 250 ms 一次），透過 GameCore 的方法下指令。高頻狀態（玩家位置、Three.js 物件）不放進 Vue 響應式系統。
- **GPU 資源**：geometry／material／texture 透過 `render/ResourceTracker` 的 `track()`／`trackMaterial()` 登記，由 tracker 統一釋放。
- **渲染排程**：前景時一律以畫質的幀率上限繪製（標準 30、高畫質 60 FPS），庭院有持續的環境動畫，所以不會停止迴圈；15 秒沒有操作也沒有移動時降到 20 FPS，一有操作立即恢復。另外由 `core/AdaptiveQuality.ts` 依實際幀間隔動態調整（網頁讀不到溫度）：變慢約 2 秒就降一級（降低繪製解析度、縮小完整模型與投影的範圍），順暢約 30 秒才升回；等級表是 `ADAPTIVE_LEVELS`。背景分頁停止迴圈、暫停 AudioContext、停止送位置。改動任何會讓畫面變化的狀態，記得呼叫 `wake()`。
- **角色繪製**：角色是 Q 版小沙彌公仔（`public/models/monk.glb`，沒有骨架）。身體（袍與鞋）與膚色部分（頭與手）與臉各分近、遠兩批，加上影子，以 InstancedMesh 批次繪製（固定 7 個 draw call）：離本機玩家 `nearRadius` 內用完整模型並投影，之外用 `monk-lod.glb` 且不投影；動畫是公仔式的：整尊繞腳底傾斜；蹲坐時壓扁、走路時彈跳只作用在身體（袍與鞋），頭、耳朵、手與臉用不縮放的剛體矩陣只隨肩膀（`SHOULDER_HEIGHT`）升降，不會變形（`AvatarFactory.sync()`）；`nod` 是整尊小幅前傾點頭，`rig.head` 的旋轉仍不會顯示。整尊由 `scripts/build-avatar.mjs` 以光滑的橢球與旋轉體產生（頭、耳朵、鐘形的袍、寬袖、合十的手、鞋尖），造型要改就改腳本裡的數字再重新產生。臉是貼合頭部曲面的一層（近、遠都畫，各取自該 tier 自己的膚色幾何，不投影），五官畫在執行時產生的圖集上，每格一種表情（`FACE_CALM` 豆豆眼、`FACE_SMILE` 瞇瞇笑眼）；動畫片段以 `rig.face` 指定表情，`AnimationSystem.apply()` 每幀重設為平常的臉。容量 `AVATAR_CAPACITY`（160）須大於最高畫質的可見人數；名牌只顯示最近 12 人。
- **庭院視覺**：`render/TempleScene.ts` 以程序化幾何＋ Poly Haven CC0 貼圖的 `MeshStandardMaterial` 建構（貼圖為 KTX2，在 `web/public/textures/`，原檔在 `web/assets/textures/`；UV 以公尺為單位）；`SceneRenderer` 負責程序化天空、天空環境貼圖、戶外色調映射與主光陰影。陰影、貼圖解析度與細節貼圖依 `core/settings.ts` 的畫質預設在載入時決定。細節與量測見 docs/TECH_STACK.md「庭院視覺」。
- **場地與場景**：`world/zones.ts` 定義庭院與殿內兩個場景（可走範圍、障礙物、出生點、出入口、鏡頭範圍），庭院的細節在 `world/layout.ts`。場景建構、碰撞、尋路（`world/pathfind.ts`）都讀這份資料，改場地要一致；`zones.test.ts` 檢查落點不會卡進障礙物或來回瞬移。殿內場景在 `render/HallScene.ts`，第一次進殿才建立；靜態物件以 `render/mergeStatic.ts` 依材質合併。
- **神像**：`render/statues.ts` 為程序化造型，每尊一個插槽，可用 `loadStatueModel()` 換成寫實 glTF。方位依傳統以神明為主體：觀音在主佛左手邊（+x，龍邊），關聖帝君在右手邊（-x，虎邊）。

### 網路協定

- `src/game/net/protocol.ts` 是前後端協定的定義來源（JSON 草案，版本 1）。編碼集中在 `encode()`／`decode()`；`decode()` 負責驗證，新增伺服器訊息時同步擴充型別與驗證。改協定時前端、mock 伺服器與後端在同一個 PR 修改。
- 語意分兩類：`move`／`stop` 可取代（`OutboundQueue` 合併未送出的舊位置）；`action` 需確認（帶 `reqId`，伺服器去重並回 `ack`，重送不重複執行）。
- 玩家有所在場景（`zone`）；切換時送 `zone` 訊息，只顯示同場景的遠端玩家。伺服器只把 `moves`／`sync`／`action` 送給同場景的玩家。
- 伺服器每個 tick 送批次位置 `moves`（`MoveTuple[]`，只含有變動的玩家，上限 `MAX_MOVES_PER_MESSAGE`）。tuple 以房內短編號 `n`（`PlayerSnapshot.n`）指稱玩家，`Players` 維護 `n → 玩家` 的對照。`sync` 格式相同但語意是整批校正：直接套用不插值（切換場景後、或 `moves` 曾被丟棄後由伺服器送出）。單則訊息上限 `MAX_MESSAGE_BYTES`（16 KB）。
- 遠端玩家的移動（`world/interp.ts`、`Players`）：收到新位置時從目前顯示的位置等速走過去，花的時間等於位置更新的間隔；差距超過 5 公尺直接套用。移動中超過 1 秒沒有更新視為停止。
- `NetworkClient` 負責重連（`backoff.ts`）、心跳、送出節流與 `resumeToken` 恢復；渲染頻率與網路送出頻率各自獨立。上行座標取到 0.01；切到背景時若在移動會先補送 `stop`；退避計數在收到 `welcome` 才歸零；close code 1013／1008 至少等 5 秒再重連；`unsupported_version` 不再重連並提示重新整理。
- 後端（`server/`）：每個房間一個 actor task 擁有狀態（`src/room.rs`），連線以 channel 溝通，房間只用 `try_send`。場景邊界與出入口常數在 `src/world.rs`，數值抄自前端的 `world/layout.ts`／`zones.ts`，改場地時兩邊要一起改。障礙物也抄了一份在 `src/world.rs`。
- 位置由本機先走、伺服器驗證：伺服器以「移動額度」（防瞬移）與障礙物直線檢查（防穿牆）驗證，拒絕時送只含本人短編號的 `sync`，`GameCore.correctLocal()` 把自己拉回該位置。

### 玩法擴充點

玩法以 `GameplayModule`（`gameplay/types.ts`）加入，不修改渲染、網路或 UI：在 `install(api)` 中以 `api.actions.register()` 註冊動作（動作列、冷卻、動畫、音效、伺服器確認自動接上），`api.animations.registerClip()` 加姿勢、`api.audio.loadSfx()` 加音效、`api.setStat()` 更新 HUD；`install` 回傳的函式須清除全部註冊。模組登記於 `gameplay/modules/index.ts`。`GameplayApi` 刻意保持很小，需要時再擴充。

### 音訊

- 沒有背景音樂，聲音留白大於填滿：環境音（風聲、鳥叫、遠處頌缽、隨機 90～210 秒一聲的遠處鐘聲）全部由 `AudioManager` 在執行時合成，走環境音軌（「環境與音樂」音量）。風聲是可循環的雜訊 AudioBuffer 加 lowpass 與緩慢 LFO；遠鐘純本機播放，不經網路、不觸發鐘亭動畫、不喚醒渲染。沒有音檔或音訊相關環境變數。
- 短音效（鐘、木魚、頌缽、鳥叫）同樣由 `AudioManager` 即時合成為 AudioBuffer。
- 靜音或音量為 0 時淡出後暫停 AudioContext，風聲、鳥叫與遠鐘停止；背景時同靜音。

## 驗證注意

- 前端變更：`npm run typecheck`、`npm test`、`npm run build`；涉及畫面或互動時以 `npm run dev`（多人加 `npm run mock`）在瀏覽器實際確認。
- 效能數據可在遊戲設定開啟「顯示效能資訊」（FPS、CPU 時間、draw call）。目前量測都是桌面 Chromium，非手機實測；容量聲明須附負載條件（見 AGENTS.md）。
- 修改同步或連線生命週期時，用 mock 伺服器驗證斷線重連與多人情境。
