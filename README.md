# 少林寺

以《山寺》（Sansatemple）類型為參考的多人網頁靜心遊戲，優先提供快速進入、低負擔互動與安靜共處的體驗。遊戲中的寺院名為「少林寺」；玩法細節尚未決定。

## 目前狀態

- `web/`：前端已建立。包含程序化寺院場景、角色移動、動作與冷卻、多人同步客戶端、設定與效能資訊；聲音包含合成的鐘聲、木魚、頌缽、風聲、鳥叫與五聲音階佛樂。
- 後端：Rust + Axum，依 [docs/BACKEND_TASKS.md](docs/BACKEND_TASKS.md) 的優先級實作。完成前可用開發用 mock 伺服器測試多人功能。
- 玩法：尚未定義。目前只有一個示範模組（合十、頌缽、敲鐘），用來驗證接線，可以整個刪除。

## 前端開發

需要 Node.js ^20.19.0 或 >=22.12.0。

```bash
cd web
npm ci
npm run dev          # 開發伺服器 http://localhost:5173
npm run typecheck    # vue-tsc 型別檢查
npm test             # vitest 單元測試
npm run build        # 型別檢查 + 正式建置到 web/dist
```

測試多人功能：

```bash
cd web
npm run mock -- 20          # mock 伺服器，20 個機器人，ws://localhost:8080/ws
echo VITE_WS_URL=ws://localhost:8080/ws > .env.local
npm run dev
```

環境音樂檔（佛樂＋風聲）不提交到 git，需要時產生：

```bash
cd web
npm run render:ambient            # 輸出 public/audio/temple-ambient.mp3（約 2.4 MB，約 20 秒）
echo VITE_AMBIENT_URL=/audio/temple-ambient.mp3 >> .env.local
```

正式環境把檔案上傳到 R2，`VITE_AMBIENT_URL` 設為 R2 自訂網域上的網址，並在 R2 設定允許遊戲網域的 CORS。上傳後執行：

```bash
npm run check:ambient -- https://<R2 自訂網域>/audio/temple-ambient-v1.mp3 https://<遊戲網站>
```

必須全部通過，並用手機實際聽一次。完整檢查清單見 [docs/TECH_STACK.md](docs/TECH_STACK.md#部署檢查每次上傳或更換音樂檔都要做)。

環境變數見 `web/.env.example`。在遊戲設定中開啟「顯示效能資訊」，可查看 FPS、CPU 時間與 draw call。

## 加入玩法

玩法以模組形式加入，不需要修改渲染、網路或 UI：

1. 在 `web/src/game/gameplay/modules/` 新增模組，實作 `GameplayModule`（見 `gameplay/types.ts`）。
2. 在 `install(api)` 中用 `api.actions.register()` 註冊動作。動作列、冷卻、動畫、音效與伺服器確認會自動接上。
3. 需要新動作姿勢時用 `api.animations.registerClip()`；新音效用 `api.audio.loadSfx()`；HUD 數值用 `api.setStat()`。
4. 在 `modules/index.ts` 登記模組，並移除 `demo.ts`。
5. 需要新的伺服器訊息時，擴充 `net/protocol.ts` 的型別與 `decode()` 驗證。

## 文件入口

- [技術選型與執行限制](docs/TECH_STACK.md)：已確認技術、Vue 版本、前端架構、VPS 容量條件與 Phase 2。
- [Codex 專案指引](AGENTS.md)：後續開發應遵循的規範。

## 已確認方向

前端採用 Vite、Vue、TypeScript 與 Vanilla Three.js；Vue 固定版本與安裝方式以[技術文件](docs/TECH_STACK.md#vue-版本與安裝規範)為準。

後端採用 Rust，框架在 Axum 與 Actix-web 中擇一；資料庫使用 PostgreSQL；部署使用 Dokploy 與 Linux VPS；素材存放 Cloudflare R2。Phase 2 規劃使用 Tauri Mobile。

3,000～5,000 人同時在線為容量目標，尚未經過實測，也尚未確定是全站總在線或單一房間人數。

## 下一個實作階段

1. 定義玩法，並以玩法模組加入前端。
2. 在手機實機量測發熱、耗電與持續遊玩的幀時間。
3. 依 `docs/BACKEND_TASKS.md` 實作 Rust 後端（Axum），每個任務由 Claude 稽核。
4. 部署到正式主機並壓測，決定實際承載量。
