# 少林寺

以《山寺》（Sansatemple）類型為參考的多人網頁靜心遊戲，優先提供快速進入、低負擔互動與安靜共處的體驗。遊戲中的寺院名為「少林寺」，支援手機與 PC 瀏覽器。

這份文件是新同仁（以及他的 AI 程式助手）clone 之後第一份要讀的文件。

## 目前狀態

- `web/`：前端可運作。包含程序化寺院場景、角色移動、動作與冷卻、多人同步客戶端、設定與效能資訊；聲音全部在執行時合成（鐘聲、木魚、頌缽、風聲、鳥叫、遠處鐘聲），沒有背景音樂。
- `server/`：後端使用 Rust 與 Axum，進度與驗收標準見 [docs/BACKEND_TASKS.md](docs/BACKEND_TASKS.md)。
- 前端開發時也可以用 `web/scripts/mock-server.mjs` 測試多人功能。它實作與正式伺服器相同的協定，不需要安裝 Rust。
- 玩法：目前正在實作殿內的「跪拜」與「上香」（蒲團陣列、每尊神像前一個香爐），細節以 [docs/TECH_STACK.md](docs/TECH_STACK.md) 為準。

## 環境需求

編好的貼圖與烘焙結果都已提交在 repo 裡，所以一般開發只需要 Node.js。

| 工具 | 什麼情況才需要 | 版本 |
| --- | --- | --- |
| Node.js、npm | 一律需要（改程式、跑測試、看畫面） | `^20.19.0` 或 `>=22.12.0`，CI 用 22 |
| Rust（rustup） | 只有跑或修改後端時 | `server/rust-toolchain.toml` 固定為 1.95.0，rustup 會自動安裝，並帶 rustfmt 與 clippy |
| KTX-Software（`ktx`） | 只有新增或替換貼圖時（`npm run build:textures`） | 現有貼圖用 v4.4.2 編碼；v5.0.0-rc2 也驗證過可以執行現有腳本 |
| Blender | 只有重新烘焙庭院光照（`npm run bake:lightmaps`）或處理模型時 | 烘焙所用的版本是 Blender 5.3.0 |
| Docker | 只有要在本機建後端映像時（CI 會建） | 不限 |

### 安裝 KTX-Software

從 <https://github.com/KhronosGroup/KTX-Software/releases> 下載安裝檔。macOS 選 `.pkg`，Windows 選 `.exe`。裝好後確認：

```bash
ktx --version
```

如果 `ktx` 不在 PATH，用環境變數 `KTX` 指定執行檔路徑，例如：

```bash
# macOS / Linux
KTX=/usr/local/bin/ktx npm run build:textures
# Windows PowerShell
$env:KTX = "C:\Program Files\KTX-Software\bin\ktx.exe"; npm run build:textures
```

### 安裝 Blender

從 <https://www.blender.org/download/> 安裝。腳本會從 PATH 找 `blender`，或讀環境變數 `BLENDER`。

- macOS：Blender 預設不在 PATH，執行檔通常在 `/Applications/Blender.app/Contents/MacOS/Blender`。例如 `BLENDER=/Applications/Blender.app/Contents/MacOS/Blender npm run bake:lightmaps`。
- Windows：執行檔在安裝資料夾，例如 `C:\Program Files\Blender Foundation\Blender 5.3\blender.exe`，用 `$env:BLENDER` 指定。

烘焙結果依版本可能有細微差異。要重新烘焙時請盡量使用 5.3.0，並在 PR 說明所用版本。

## 前端

在 `web/` 執行：

```bash
npm ci
npm run dev          # 開發伺服器 http://localhost:5173
npm run typecheck    # vue-tsc 型別檢查
npm test             # vitest 單元測試
npm run build        # 型別檢查 + 正式建置到 web/dist
```

其他指令：

```bash
npm run build:textures    # assets/textures 與 assets/lightmaps 轉成 public 下的 KTX2（需要 ktx）
npm run bake:lightmaps    # 重新烘焙庭院光照（需要 Blender 與 ktx）
npm run build:avatar      # 以程式產生 public/models/monk.glb 與 monk-lod.glb
```

不設定環境變數時，前端以離線模式運作（沒有多人）。環境變數見 `web/.env.example`。在遊戲設定中開啟「顯示效能資訊」，可查看 FPS、CPU 時間與 draw call。

## 後端

在 `server/` 執行：

```bash
cargo run                                 # 預設監聽 8080，WebSocket 在 /ws
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`cargo run` 讀取下列環境變數，全部可省略：

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `PORT` | `8080` | 監聽埠，1～65535 |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | 允許的瀏覽器來源，逗號分隔，只能是 http(s) 來源，不含路徑 |
| `ROOM_CAPACITY` | `50` | 單一房間上限 |
| `TICK_HZ` | `10` | 房間廣播頻率，1～60 |
| `RESUME_GRACE_SECONDS` | `30` | 斷線後保留玩家的秒數，1～600 |
| `METRICS_TOKEN` | 未設定 | 設定後 `/metrics` 須帶 Bearer 權杖；未設定為開放 |
| `RUST_LOG` | `info` | 日誌等級 |

另有 `/healthz` 健康檢查端點。

## 測試多人功能

用 mock 伺服器（不需要 Rust）：

```bash
cd web
npm run mock -- 20        # ws://localhost:8080/ws，20 個機器人
```

或用正式後端：在 `server/` 執行 `cargo run`。兩者預設都在 8080，不要同時開。

然後建立 `web/.env.local`（這個檔不進 git，要自己建），內容一行：

```
VITE_WS_URL=ws://localhost:8080/ws
```

再執行 `npm run dev`。如果前端不是從 `http://localhost:5173` 開啟，後端的 `ALLOWED_ORIGINS` 要加上該來源。

## 分支與 CI

- `main` 是預設分支。工作在功能分支進行，以 PR 合併。
- 前端 CI（`.github/workflows/web.yml`）在推送到 `main` 與 PR 時執行：`npm ci`、`typecheck`、`test`、`vite build`，Node 22。
- 後端 CI（`.github/workflows/server.yml`）在 `server/**` 或協定檔（`web/src/game/net/protocol*`）變動時執行：`cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test --locked`、協定測試、release 建置與 Docker 建置。
- PR 合併前，會觸發的 CI 都要通過。

送 PR 前的本機檢查：

```bash
# 前端（在 web/）
npm run typecheck && npm test && npm run build
# 後端（在 server/，有改動時）
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## 換行符號與二進位檔

repo 內的文字檔一律是 LF。Windows 的 git 可能開了 `core.autocrlf`，請確認提交的檔案沒有被轉成 CRLF。`.gitattributes` 裡標 `-text` 的檔案（`web/public/basis/` 的轉碼器、`web/assets/lightmaps/` 與 `web/public/lightmaps/` 的烘焙貼圖）必須逐位元保存，不可被任何工具轉換換行或重新編碼。轉碼器有測試（`basis.test.ts`）檢查它與 `node_modules` 內的 three 副本逐位元相同。

## 加入玩法

玩法以模組形式加入，不需要修改渲染、網路或 UI：

1. 在 `web/src/game/gameplay/modules/` 新增模組，實作 `GameplayModule`（見 `gameplay/types.ts`）。
2. 在 `install(api)` 中用 `api.actions.register()` 註冊動作。動作列、冷卻、動畫、音效與伺服器確認會自動接上。
3. 需要新動作姿勢時用 `api.animations.registerClip()`；新音效用 `api.audio.loadSfx()`；HUD 數值用 `api.setStat()`。
4. 玩法模組登記在 `modules/index.ts`。`install` 回傳的函式須清除該模組的全部註冊。
5. 需要新的伺服器訊息時，擴充 `net/protocol.ts` 的型別與 `decode()` 驗證，並在同一個 PR 修改 mock 伺服器與後端。

## 文件入口

- [docs/TECH_STACK.md](docs/TECH_STACK.md)：技術選型、版本、前端架構、庭院視覺與烘焙流程、VPS 容量條件與 Phase 2。版本與技術決策以它為準。
- [docs/BACKEND_TASKS.md](docs/BACKEND_TASKS.md)：後端任務清單、進度與驗收標準。
- [docs/ASSETS.md](docs/ASSETS.md)：素材來源、授權與署名清單。新增素材前先讀。
- [AGENTS.md](AGENTS.md)：給所有開發者與 AI 程式助手的專案規範。
- [CLAUDE.md](CLAUDE.md)：給 Claude Code 的程式架構導覽與常用指令。

## 已確認方向

前端採用 Vite、Vue、TypeScript 與直接操作 Three.js；Vue 固定版本與安裝方式以[技術文件](docs/TECH_STACK.md#vue-版本與安裝規範)為準。後端採用 Rust 與 Axum；資料庫規劃使用 PostgreSQL；部署規劃使用 Dokploy 與 Linux VPS；素材規劃存放 Cloudflare R2。Phase 2 規劃使用 Tauri Mobile。

3,000～5,000 人同時在線為容量目標，尚未經過實測，也尚未確定是全站總在線或單一房間人數。
