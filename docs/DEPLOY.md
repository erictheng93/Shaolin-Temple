# 部署指南（T9：Dokploy + 單一 VPS）

狀態：**設定檔與文件已備妥，尚未實際部署**。主機、Dokploy 位址與網域都還沒有，文中 `game.example.com`、`203.0.113.10` 皆為佔位符。目標主機 1 vCPU／2 GiB。

## 架構

```
瀏覽器 ──https/wss──▶ Traefik（Dokploy 內建，終結 TLS，Let's Encrypt）
                        ├─ game.example.com/      ──▶ web    容器（nginx，8080，靜態檔）
                        └─ game.example.com/ws    ──▶ server 容器（Rust，8080）
```

- **同一個網域、以路徑分流**：前端與 WebSocket 同源，`ALLOWED_ORIGINS` 只有一個值，只需一筆 DNS 記錄。若想分成 `ws.example.com`，另加一個網域指向 `server`，並把 GitHub 儲存庫變數 `VITE_WS_URL`（需重新建置映像）與 `ALLOWED_ORIGINS` 對應改掉即可。
- **TLS 由 Traefik 終結**，容器內全是明文 HTTP／ws。前端網址是 `https`，所以 WebSocket 必須是 `wss`（瀏覽器會擋混合內容）。
- **`/metrics` 不對外**：Dokploy 只把 `/` 與 `/ws` 兩個路徑導給容器；`/metrics`、`/healthz` 在公網得到 404（見驗證清單）。需要抓指標時從主機進容器網路，或設 `METRICS_TOKEN` 後再自行決定如何公開。
- 映像由 CI 建置：[.github/workflows/images.yml](../.github/workflows/images.yml) 在 push 到 `main` 時（先通過與 server／web 工作流程相同的檢查）建置並推送 `ghcr.io/erictheng93/temple-server` 與 `temple-web`，標籤為 commit 完整 SHA 與 `main`。正式主機只拉取映像，不編譯。
- 檔案：[deploy/docker-compose.yml](../deploy/docker-compose.yml)、[deploy/.env.example](../deploy/.env.example)、[web/Dockerfile](../web/Dockerfile)、[web/deploy/nginx.conf](../web/deploy/nginx.conf)、[server/Dockerfile](../server/Dockerfile)。

### 伺服器映像的健康檢查

伺服器映像是 distroless（沒有 shell 與 curl），所以 `temple-server --healthcheck` 內建一個子命令：對本機 `PORT` 的 `/healthz` 發請求，回 200 才結束碼 0。compose 的 healthcheck 用它。

## 使用者需要提供的資訊

1. 主機：公網 IP、SSH 登入方式（金鑰），作業系統（建議 Ubuntu 22.04/24.04）。
2. Dokploy：已安裝則給網址；未安裝則由我們在主機上安裝（需要主機的 80、443、3000 埠對外開放）。
3. 網域：要用的主機名（例如 `game.example.com`）與能編輯 DNS 的權限。
4. DNS：`game.example.com` 的 A 記錄指向主機 IP（有 IPv6 再加 AAAA）。
5. 是否使用 Cloudflare 代理（橘色雲朵），見下節。
6. Git 來源：Dokploy 要能讀 repo（公開 repo 直接填網址；私有則加 deploy key）。
7. GitHub 儲存庫變數 `VITE_WS_URL`（例如 `wss://game.example.com/ws`），以及 GHCR 套件的存取方式（見步驟 7）。

### Cloudflare 代理與 WebSocket

- Cloudflare 官方文件：代理的 WebSocket 不需額外設定（Network 頁面有 WebSockets 開關，確認為 On）；閒置超過一段時間會被關閉（時間未在該頁公布）。我們的前端每 20 秒送一次心跳 `ping`，伺服器回 `pong`，連線不會閒置，且斷線有自動重連。
- Dokploy 的 Cloudflare 說明頁只談 SSL/TLS 模式：用代理時請選 **Full (strict)**，Dokploy 的網域開 HTTPS＋letsencrypt；用 Flexible 則要關掉 Dokploy 的 HTTPS，且不建議。
- Let's Encrypt 驗證在橘雲開啟時可能失敗；做法是先以灰雲（僅 DNS）申請成功再改橘雲，或改用 Cloudflare Origin CA 憑證。**此處未實測。**
- 建議先用灰雲（僅 DNS）完成所有驗證，確認一切正常後再決定是否開代理。壓測請在灰雲下做（代理會改變頻寬與連線行為，也可能視為攻擊流量）。

## 部署步驟

1. **DNS**：建立 `game.example.com` A 記錄，等生效（`nslookup game.example.com`，macOS 與 Windows 都能用）。
2. **安裝 Dokploy**（主機上一次性）：依 Dokploy 官方安裝文件的一行指令安裝，登入 `http://203.0.113.10:3000` 建立管理員帳號。之後可在 Settings 設定 Dokploy 自己的網域與憑證信箱（Let's Encrypt 通知用）。
3. **建立專案與 Compose 服務**：Projects → Create Project → Create Service → **Compose**，Compose Type 選 **Docker Compose**（不要選 Stack/Swarm）。
4. **Provider**：Git，填 repo 網址與分支（上線用 `main`）；**Compose Path** 填 `./deploy/docker-compose.yml`。
5. **Environment 分頁**：貼上 `deploy/.env.example` 的內容並改成實際值：
   ```
   ALLOWED_ORIGINS=https://game.example.com
   IMAGE_TAG=<要部署的 commit 完整 SHA>
   ```
   缺一時 compose 會直接報錯，不會以錯誤設定啟動。`VITE_WS_URL` 不在這裡：它在 CI 建置時編進前端映像，要先到 GitHub 儲存庫 Settings → Secrets and variables → Actions → **Variables** 新增 `VITE_WS_URL=wss://game.example.com/ws`（未設定時 images 工作流程只推送伺服器映像，不建置前端映像）。
6. **Domains 分頁**新增兩筆（HTTPS 開、Certificate 選 letsencrypt）：

   | Host | Service Name | Container Port | Path | Strip Path |
   | --- | --- | --- | --- | --- |
   | `game.example.com` | `web` | 8080 | `/` | 關 |
   | `game.example.com` | `server` | 8080 | `/ws` | 關（伺服器自己的路由就是 `/ws`） |
   | `game.example.com` | `server` | 8080 | `/auth` | 關（登入端點 `/auth/*`，見「登入（Google／LINE）」；不啟用登入也建議加，前端會查 `/auth/providers`） |

   Dokploy 在部署時為 compose 服務產生 Traefik 標籤與網路，不必手寫標籤。**部署前按 Preview Compose**，確認 `server` 的路由規則含 `PathPrefix(`/ws`)`，並且沒有把 `/metrics` 導出去。
7. **Deploy**：
   - 先確認 push 到 `main` 後 GitHub Actions 的 **images** 工作流程成功（檢查通過才會推送映像）。`IMAGE_TAG` 填該次 commit 的完整 SHA。
   - GHCR 套件預設為私有：到 GitHub 的 Packages 把 `temple-server`、`temple-web` 改為 **Public**（repo 是公開的，映像不含密鑰），或在 Dokploy 設定 Registry 憑證（GitHub PAT，`read:packages`）。
   - Deploy 時主機只拉取該 SHA 的映像並重建容器，不編譯，也不佔用編譯所需的 CPU／記憶體。
   - **回滾**：把 `IMAGE_TAG` 改成較舊的好 SHA 後重新 Deploy（舊映像仍在 GHCR）。
8. 跑「上線後驗證」。

## 上線後驗證清單

在**另一台機器**執行（macOS 與 Windows 皆有 `curl`；Windows 用 `curl.exe`）。

- [ ] 首頁：`curl -sI https://game.example.com/` → `200`、`content-type: text/html`、`cache-control: no-cache`。
- [ ] 帶雜湊檔案：`curl -sI https://game.example.com/assets/<index-xxxx.js>` → `cache-control: ... immutable`、有 `content-encoding: gzip`（要帶 `-H 'Accept-Encoding: gzip'`）。
- [ ] `/healthz` 與 `/metrics` 不外洩：`curl -s -o /dev/null -w "%{http_code}\n" https://game.example.com/metrics` → 不是 200（應為 404，被前端的 SPA 回退吃掉則是回傳 index.html 的 200，請確認內容不是指標文字：`curl -s https://game.example.com/metrics | head -3` 不應出現 `temple_`）。
- [ ] 容器健康：Dokploy 的服務頁面或主機上 `docker ps` 顯示 `server`、`web` 皆 `healthy`。
- [ ] wss 連線：瀏覽器開 `https://game.example.com`，開發者工具 Network → WS 看到 `/ws` 狀態 101；畫面有人數（無 mixed content 錯誤）。
- [ ] 拒絕錯誤來源：`curl -si -H "Origin: https://evil.example" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://game.example.com/ws | head -1` → 非 101（403）。
- [ ] 兩台裝置互相看得到：手機（行動網路）與電腦各開首頁進場，彼此看到對方角色並同步移動、進殿。
- [ ] 斷線重連：在其中一台開飛航模式 10 秒再關閉（<30 秒，`RESUME_GRACE_SECONDS`），回來後仍是同一個角色（`resumeToken` 恢復）；超過 30 秒則以新角色重新加入，兩種都不應需要重新整理。
- [ ] 重新部署：在 Dokploy 重新 Deploy，開著的分頁應自動重連（5 秒內優雅關閉）。
- [ ] 日誌：`docker logs <server 容器>` 為 JSON 行；`docker inspect --format '{{.HostConfig.LogConfig}}'` 顯示 `max-size 10m`、`max-file 3`。

## 設定重點說明

### WebSocket 經 Traefik

- Traefik 的 HTTP 路由原生處理 `Upgrade: websocket`，不需要額外的 middleware 或標籤。
- Traefik 入口點的 `respondingTimeouts` 預設：`readTimeout` 60s、`writeTimeout` 0s（無限）、`idleTimeout` 180s（Traefik 官方文件，Entrypoints 頁面）。文件**沒有**說明升級後的 WebSocket 是否受這些逾時約束，網路上有 2.11.1 之後因 CVE-2024-28869 的修補引入 `lingeringTimeout` 的討論；我們沒有查證到權威說法，**也沒有實測**。
- 因此靠設計避開：前端 `NetworkClient` 每 **20 秒**送一次心跳（`heartbeatMs: 20_000`）、遊戲中還有 10 Hz 的位置流量；伺服器 **90 秒**沒收到任何輸入就以 1001 關閉（`DEFAULT_IDLE_TIMEOUT`）。也就是連線在代理上永遠不會閒置超過約 20 秒，遠低於任何常見的 60／100／180 秒閒置逾時。驗證方式：開著頁面且不操作 10 分鐘仍保持連線（`/ws` 沒有重連紀錄）。若發現固定間隔斷線，先檢查 Traefik 的 transport 逾時，再看 Cloudflare。
- 閒置分頁切到背景時前端會停止送位置，但心跳仍在。

### `ALLOWED_ORIGINS`

填瀏覽器 `Origin` 標頭的值：scheme＋主機（非預設埠要帶），**不含路徑與結尾斜線**，例如 `https://game.example.com`。伺服器會把大小寫與預設埠正規化，多個值以逗號分隔。填錯會讓所有 WebSocket 升級被拒（403）。`www` 與非 `www` 是不同來源，兩者都要用就都列入。

### 快取策略（`web/deploy/nginx.conf`）

| 路徑 | Cache-Control | 理由 |
| --- | --- | --- |
| `/assets/` | 1 年 immutable | Vite 檔名帶內容雜湊 |
| `/lightmaps/`、`/statues/` | 1 年 immutable | 程式載入時網址帶 `?v=<指紋>`／`?v=<STATUE_ASSET_VERSION>`，改檔必改網址（`CLAUDE.md` 已規定改模型要改版本） |
| `/textures/`、`/models/`、`/basis/`、`/draco/` | 1 天 | 網址**沒有**版本參數：替換檔案時使用者最多看到舊版 1 天；之後若常換再加版本參數 |
| 其他（`index.html`、`favicon.svg`、SPA 回退） | `no-cache` | 每次重新驗證（ETag），部署後立即拿到新的雜湊檔名 |

壓縮：只有 nginx 內建的 gzip（文字、wasm、glb）；`.ktx2` 已是 Basis 超壓縮，不壓。沒有 brotli（需要額外模組，收益有限；若開 Cloudflare 代理會由它提供）。

## POC：Cloudflare Pages ＋ 本機後端（Cloudflare Tunnel）

2026-11-16 起的試行做法，正式主機到位前使用。Dokploy 的流程（以上各節）保留不變。

```
瀏覽器 ──https──▶ Cloudflare Pages          temple.wishly.tw（靜態檔）
瀏覽器 ──wss────▶ Cloudflare ──Tunnel──▶ 開發機 localhost:8080（temple-server）
                                         temple-ws.wishly.tw，只開放 /ws 與 /auth/*
```

- 前後端是兩個主機名（Pages 與 Tunnel 不能共用同一個主機名的不同路徑）：`VITE_WS_URL=wss://temple-ws.wishly.tw/ws`、`ALLOWED_ORIGINS=https://temple.wishly.tw`。
- 快取標頭在 [web/public/_headers](../web/public/_headers)，規則與 `nginx.conf` 相同；改其中一份要同步另一份。SPA 回退是 Pages 的預設行為（沒有 `404.html` 時）。
- 限制：開發機睡眠或關機就斷線；延遲多一段家用線路；這個環境的量測不可當作容量聲明。

### 前端部署（Direct Upload，在 `web/` 執行）

```
VITE_WS_URL=wss://temple-ws.wishly.tw/ws npx vite build      # PowerShell：$env:VITE_WS_URL = '...'; npx vite build
npx wrangler pages deploy dist --project-name shaolin-temple --branch main
```

第一次要先 `npx wrangler login`（用擁有 `wishly.tw` 的 Cloudflare 帳號）與 `npx wrangler pages project create shaolin-temple --production-branch main --force`（wrangler 4.156 起不加 `--force` 會改走 Workers 而失敗），並在 Cloudflare 後台 Workers & Pages → shaolin-temple → Custom domains 加上 `temple.wishly.tw`。目前是手動部署，推 `main` 不會自動更新。

換過 wrangler 登入帳號後若出現 `Authentication error [code: 10000]`：刪除 `web/node_modules/.cache/wrangler/` 裡的 `wrangler-account.json` 與 `pages.json`（它們記著前一個帳號）。

2026-11-16 已實際部署並驗證：快取標頭、`.ktx2`／`.glb` 的 Content-Type、SPA 回退、wss 連線（101）、錯誤來源 403、`/metrics` 與 `/healthz` 經 Tunnel 為 404、瀏覽器進場顯示「已連線」。

### 後端與 Tunnel（開發機上）

1. 一次性設定（需要 `cloudflared`）：
   ```
   cloudflared tunnel login                                  # 瀏覽器授權，選 wishly.tw
   cloudflared tunnel create temple                          # 記下輸出的 Tunnel ID
   cloudflared tunnel route dns temple temple-ws.wishly.tw   # 建立 CNAME
   ```
2. 設定檔 `~/.cloudflared/temple.yml`（Windows 是 `%USERPROFILE%\.cloudflared\temple.yml`）。只放行 `/ws` 與 `/auth/*`（前端進場前會查 `/auth/providers`，沒放行時瀏覽器會報 CORS 錯誤），`/metrics` 與 `/healthz` 不對外：
   ```yaml
   tunnel: <Tunnel ID>
   credentials-file: <家目錄>/.cloudflared/<Tunnel ID>.json
   ingress:
     - hostname: temple-ws.wishly.tw
       path: ^/ws$
       service: http://localhost:8080
     - hostname: temple-ws.wishly.tw
       path: ^/auth/
       service: http://localhost:8080
     - service: http_status:404
   ```
3. 每次開服：Windows 一個指令 `powershell -File deploy\serve-poc.ps1`（伺服器在 8081 加 Tunnel，Ctrl+C 一起結束；`temple.yml` 兩條規則的 `service` 都要是 `http://localhost:8081`；改了 `temple.yml` 要重啟 `cloudflared` 才生效）。其他系統或想分開跑時用兩個終端機：
   ```
   cd server && ALLOWED_ORIGINS=https://temple.wishly.tw cargo run --release --bin temple-server
   cloudflared tunnel --config ~/.cloudflared/temple.yml run
   ```
   PowerShell 的環境變數寫法是 `$env:ALLOWED_ORIGINS = 'https://temple.wishly.tw'`。 8080 被占用（例如同時開著 `npm run mock`）時加 `PORT=8081`，並把 `temple.yml` 的 `service` 改成同一個埠。

驗證沿用「上線後驗證清單」，把網址換成上面兩個主機名；`curl https://temple-ws.wishly.tw/metrics` 應為 404。

2026-11-18 已驗證 `/auth/` 的放行：`https://temple-ws.wishly.tw/auth/providers` 回 200 並帶 `access-control-allow-origin`，`/metrics`、`/healthz` 仍為 404，正式網址的 console 沒有錯誤。要在這個 POC 啟用登入（下一節），還要把 `AUTH_PUBLIC_URL` 設為 `https://temple-ws.wishly.tw` 並設定各家的憑證；**這部分未實測**（目前沒有設定任何登入方式，`providers` 是空的）。

## 登入（Google／LINE）

選填。全部不設定時伺服器只有訪客，`/auth/providers` 回空清單（行為與協定版本 3 相同）。設計與安全細節見 [BACKEND_TASKS.md](BACKEND_TASKS.md)「協定版本 4：登入與改名」。

### 環境變數（server）

| 變數 | 內容 |
| --- | --- |
| `SESSION_SECRET` | 簽章 session 權杖與登入流程 cookie 的金鑰，**至少 32 bytes**（太短啟動失敗）。產生：`openssl rand -base64 48`。輪替＝所有人登出（沒有其他撤銷方式）。 |
| `AUTH_PUBLIC_URL` | 瀏覽器連到 server 的 scheme＋主機，不含路徑，例如 `https://game.example.com`。用來組 redirect URI；https 時流程 cookie 加 `Secure`。 |
| `GOOGLE_CLIENT_ID`／`GOOGLE_CLIENT_SECRET` | Google OAuth 用戶端，要成對設定。 |
| `LINE_CHANNEL_ID`／`LINE_CHANNEL_SECRET` | LINE Login channel，要成對設定。 |

某個提供者的 id 與 secret 只設一個、或設了提供者卻缺 `SESSION_SECRET`／`AUTH_PUBLIC_URL`，伺服器啟動失敗並印出缺少的變數。

**已啟用登入後不可移除或更換 `SESSION_SECRET`**，否則所有玩家的登入失效（前端收到 `guest` 會清掉本機權杖），需要重新登入。只在確定要讓所有人登出時才換。

### 反向代理

`/auth` 路徑也要轉給 `server`（Domains 分頁多一筆 Path `/auth`，見部署步驟 6），否則 `/auth/google/start` 會被前端的 SPA 回退吃掉。登入結束時伺服器 302 回 `<前端 origin>/#session=…`，前端與 server 不同網域也可以（權杖在網址 fragment，不靠 cookie；`/auth/providers` 對 `ALLOWED_ORIGINS` 內的來源回 CORS 標頭）。

建議在反向代理（Traefik 的 RateLimit middleware 或 Cloudflare 的 Rate limiting rules）對 `/auth` 加每個 IP 的頻率限制（例如每分鐘 30 次）：伺服器本身只限制同時進行的換權杖請求（8 個，滿了最多排隊 2 秒）、每個登入流程只能換一次，不限制每個來源的次數（伺服器看到的位址是代理的）。**未實測。**

### redirect URI（在提供者的主控台登記）

redirect URI 固定是 `<AUTH_PUBLIC_URL>/auth/<provider>/callback`，必須與主控台登記的**完全一致**（scheme、主機、埠、路徑）：

- **Google Cloud Console** → APIs & Services → Credentials → Create credentials → OAuth client ID，類型 **Web application**；Authorized redirect URIs 填 `https://game.example.com/auth/google/callback`。Authorized JavaScript origins 不需要（瀏覽器不直接呼叫 Google API）。OAuth 同意畫面只需要 `openid` 範圍。
- **LINE Developers Console** → Provider → 建立 **LINE Login** channel（App types 勾 Web app）→ LINE Login 分頁 → Callback URL 填 `https://game.example.com/auth/line/callback`。Basic settings 分頁的 Channel ID／Channel secret 就是 `LINE_CHANNEL_ID`／`LINE_CHANNEL_SECRET`。不需要申請 email 權限。

本機開發（`AUTH_PUBLIC_URL=http://localhost:8080`）要另外登記 `http://localhost:8080/auth/google/callback`（Google 允許 localhost 的 http）；LINE 的 Callback URL 也可以多填一行本機網址。**以上主控台步驟依官方文件整理，尚未以真實帳號實測。**

### 上線後驗證（登入）

- [ ] `curl -s https://game.example.com/auth/providers` → `{"providers":["google","line"]}`（只列出設定完整的）。
- [ ] `curl -sI "https://game.example.com/auth/google/start?origin=https://evil.example"` → `400`（不在 `ALLOWED_ORIGINS` 的 origin 不導向）。
- [ ] 瀏覽器實際用 Google 與 LINE 各登入一次，回到遊戲後 `welcome.auth` 為 `google`／`line`；在提供者頁面按取消，回到遊戲顯示取消而不是錯誤頁。
- [ ] `docker logs` 中只有 `login succeeded`／`login failed` 與固定的原因，沒有權杖、授權碼或使用者 ID。

## 正式環境壓測

目的：在 1 vCPU／2 GiB 上重跑 T7／T8 情境，並判斷餘裕。

**限制：`loadtest` 沒有 TLS 支援**（`tokio-tungstenite` 未啟用 TLS 功能），不能直接連 `wss://`。做法：在 Dokploy 為 `server` 暫時加一筆測試網域（例如 `loadtest.example.com`，Path `/ws`，**HTTPS 關**），壓測完刪除。這樣流量仍經 Traefik，只少了 TLS（TLS 的 CPU 成本未包含在內，記為已知缺口）。`ALLOWED_ORIGINS` 不必改，用 `--origin` 假裝正式來源。

1. 在**另一台機器**（不是被測主機）建置工具：
   ```
   cd server
   cargo build --release
   ```
   產物 `target/release/loadtest`（Windows 為 `loadtest.exe`）。
2. 重跑情境（50／200／500 連線 × 移動比例 0.1／0.5，各 60 秒；與 T7／T8 報告相同參數）：
   ```
   loadtest --url ws://loadtest.example.com/ws --origin https://game.example.com --connections 50  --moving-ratio 0.1 --seconds 60 --ramp-ms 5 --settle-ms 2000
   ```
   依序把 `--connections` 換成 200、500，`--moving-ratio` 換成 0.5，共 6 次。`ROOM_CAPACITY` 預設 50：連線數超過時會分到多個房間，與 T7／T8 相同。
3. 每次同時在主機上量測（SSH）：`docker stats --no-stream`（CPU%、記憶體）、`top`／`vmstat 5`（整機 CPU、steal、swap）；`curl http://<server 容器 IP>:8080/metrics` 於前後各取一次（容器 IP 用 `docker inspect`；或先設 `METRICS_TOKEN`）。
4. 記錄（寫入新的 `docs/LOAD_TEST_<日期>_T9.md`，附 loadtest 最後一行 JSON 原始輸出）：每連線接收 bytes/s、p50／p99 tick 間隔、`invalid_frames`、丟棄的 `moves` 數、因慢速接收被關閉數、server 的 CPU% 與 RSS、整機 CPU 與可用記憶體、出站頻寬。
5. **餘裕判斷**：Dokploy、Traefik 與兩個容器同時運作，且壓測期間仍成立：伺服器 CPU 平均 < 60%（1 vCPU = 100%）、p99 tick 間隔 < 150 ms（10 Hz 目標 100 ms）、整機 `MemAvailable` > 500 MiB 且無 swap 活動、無因慢速接收被關閉的連線。任何一項失敗就在報告中以該情境的人數標示為上限。
6. 另外量一次穩態（無壓測）下 Dokploy＋Traefik＋兩個容器的記憶體（`free -m`），作為「基底用量」。

## 回滾

映像以 commit SHA 為標籤保存在 GHCR。回滾做法：在 Dokploy 的 Environment 把 `IMAGE_TAG` 改成先前的好 SHA，重新 Deploy（只需拉取映像，約數十秒）。前端與伺服器共用同一個 `IMAGE_TAG`，協定版本（目前 6）不會不一致；不要讓兩者用不同 SHA，否則版本不符會看到 `unsupported_version` 的「重新整理」提示（新前端配舊伺服器時重新整理沒有用，要把伺服器更新到同一個 SHA）。特別是協定 v4 → v5 新增了碰碰車二進位幀（0x04）與車輛控制訊息，前後端不相容；v5 → v6 改了 `cars` 幀旗標的位元配置（撞擊種類），同樣不相容。部署與回滾時必須前後端容器一併更新。注意前端映像的 `VITE_WS_URL` 是建置當時的變數值。Dokploy 另有 Rollbacks 功能，**未查證**是否適用於 compose 服務。

## 已知未決事項

- **映像曾在本機實際建置並驗證**（Docker Desktop）：`temple-server`（27.8 MB）與 `temple-web`（70.9 MB）；但**沒有在 Dokploy 與真實主機上部署**，Traefik 路由、Preview Compose 輸出、Let's Encrypt、wss 全部未實測。
- Dokploy 的 Domains 分頁對 compose 的 `Path` 欄位實際產生的規則、`IMAGE_TAG` 是否能插值到 compose 的 `image:`，只有官方文件的概述，需在第一次部署時核對 Preview Compose。若環境變數沒插值，退而求其次：在 Dokploy 設定 `.env` 檔。
- 建置已移到 CI（`images.yml`），主機不再編譯；主機拉取映像**尚未實際跑過**。前端映像只在設定了儲存庫變數 `VITE_WS_URL` 時建置。
- `loadtest` 不支援 `wss://`，TLS 的 CPU 成本不在壓測內；要量需替工具加 TLS 功能（新增依賴，未做）。
- Traefik 升級後 WebSocket 閒置逾時的行為未實測；以心跳間隔（20 秒）規避。
- 沒有監控與告警（Prometheus 抓取、磁碟與記憶體警示），也沒有備份需求（目前無持久化，T10 才有）。
- 容量：未壓測前不可宣稱 1 vCPU／2 GiB 可承載的人數（見 AGENTS.md 容量聲明規範）。
