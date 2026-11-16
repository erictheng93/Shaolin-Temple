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
   缺一時 compose 會直接報錯，不會以錯誤設定啟動。`VITE_WS_URL` 不在這裡：它在 CI 建置時編進前端映像，要先到 GitHub 儲存庫 Settings → Secrets and variables → Actions → **Variables** 新增 `VITE_WS_URL=wss://game.example.com/ws`（未設定時 images 工作流程會失敗並說明）。
6. **Domains 分頁**新增兩筆（HTTPS 開、Certificate 選 letsencrypt）：

   | Host | Service Name | Container Port | Path | Strip Path |
   | --- | --- | --- | --- | --- |
   | `game.example.com` | `web` | 8080 | `/` | 關 |
   | `game.example.com` | `server` | 8080 | `/ws` | 關（伺服器自己的路由就是 `/ws`） |

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

映像以 commit SHA 為標籤保存在 GHCR。回滾做法：在 Dokploy 的 Environment 把 `IMAGE_TAG` 改成先前的好 SHA，重新 Deploy（只需拉取映像，約數十秒）。前端與伺服器共用同一個 `IMAGE_TAG`，協定版本（目前 3）不會不一致；不要讓兩者用不同 SHA，否則版本不符會看到 `unsupported_version` 的「重新整理」提示。注意前端映像的 `VITE_WS_URL` 是建置當時的變數值。Dokploy 另有 Rollbacks 功能，**未查證**是否適用於 compose 服務。

## 已知未決事項

- **映像曾在本機實際建置並驗證**（Docker Desktop）：`temple-server`（27.8 MB）與 `temple-web`（70.9 MB）；但**沒有在 Dokploy 與真實主機上部署**，Traefik 路由、Preview Compose 輸出、Let's Encrypt、wss 全部未實測。
- Dokploy 的 Domains 分頁對 compose 的 `Path` 欄位實際產生的規則、`IMAGE_TAG` 是否能插值到 compose 的 `image:`，只有官方文件的概述，需在第一次部署時核對 Preview Compose。若環境變數沒插值，退而求其次：在 Dokploy 設定 `.env` 檔。
- 建置已移到 CI（`images.yml`），主機不再編譯；images 工作流程與 GHCR 推送、主機拉取映像都**尚未實際跑過**。
- `loadtest` 不支援 `wss://`，TLS 的 CPU 成本不在壓測內；要量需替工具加 TLS 功能（新增依賴，未做）。
- Traefik 升級後 WebSocket 閒置逾時的行為未實測；以心跳間隔（20 秒）規避。
- 沒有監控與告警（Prometheus 抓取、磁碟與記憶體警示），也沒有備份需求（目前無持久化，T10 才有）。
- 容量：未壓測前不可宣稱 1 vCPU／2 GiB 可承載的人數（見 AGENTS.md 容量聲明規範）。
