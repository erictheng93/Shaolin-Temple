# 技術選型與執行限制

記錄日期：2026-11-05，更新 2026-11-06。狀態：前端已建立於 `web/`；後端框架選定 Axum，依 [BACKEND_TASKS.md](BACKEND_TASKS.md) 實作中；玩法尚未定義。

## 產品與工程優先順序

開發手機與 PC 瀏覽器可直接進入的多人靜心遊戲，以《山寺》（Sansatemple）類型為參考。優先考量執行時資源消耗、運行效率與穩定性，並將手機發熱、耗電、聲音體驗與首次可操作時間列為主要品質指標。

3,000～5,000 人同時在線是產品容量目標；目前未確認是全站總在線或單一房間彼此可見，相關同步設計先採可分房／分區的工作假設。容量目標尚未經過實測。

## 已確認技術棧

| 層級 | 選擇 | 狀態 |
| --- | --- | --- |
| 前端建置 | Vite 8.3.6 | 已固定 |
| UI | Vue 3.5.44、TypeScript 5.9.3、Composition API | 已固定 |
| 元件語法 | `<script setup lang="ts">` | 已確認 |
| 3D | Vanilla Three.js 0.187.0 | 直接操作 Three.js，無 TresJS 或 R3F 整合層 |
| 後端 | Rust 1.95.0、Axum 0.8 | 已選定，見下方「後端：Axum」 |
| 資料庫 | PostgreSQL | 版本於後端實作時選定 |
| 部署 | Dokploy、Linux VPS | 保留使用者選定方式 |
| 物件儲存 | Cloudflare R2 | 模型、貼圖與音訊等素材 |
| Phase 2 | Tauri Mobile | 尚未開始實作 |

前端依賴全部以精確版本寫入 `web/package.json`，並提交 `web/package-lock.json`：

| 套件 | 版本 | 備註 |
| --- | --- | --- |
| Node.js | ^20.19.0 或 >=22.12.0 | Vite 8 的要求；CI 使用 22，本機驗證使用 22.23.2 |
| vite | 8.3.6 | |
| @vitejs/plugin-vue | 6.0.10 | |
| vue | 3.5.44 | |
| three / @types/three | 0.187.0 | |
| typescript | 5.9.3 | 不採用 7.0：vue-tsc 依賴 TypeScript 的 JS API，7.0 原生版本尚未提供穩定的 JS API |
| vue-tsc | 3.3.14 | |
| vitest | 5.1.0 | 純邏輯單元測試 |
| ws | 8.22.1 | 僅供開發用 mock 伺服器 |

Rust、PostgreSQL 與 Tauri 的版本於對應實作時選定並記錄。

## Vue 版本與安裝規範

本專案採用 **Vue 3.5.44**。這是本次確認的穩定版本基準；後續即使上游發布新版本，也不會自動改變本專案的選擇。

建立前端 `package.json` 後，在前端套件目錄執行：

```bash
npm install --save-exact vue@3.5.44
```

預期 `package.json` 的相依套件包含：

```json
{
  "dependencies": {
    "vue": "3.5.44"
  }
}
```

以上是片段，需合併到骨架產生的完整檔案。版本使用精確字串，不加 `^` 或 `~`。若骨架直接宣告 `@vue/compiler-sfc`，將它與 Vue 固定為相同版本。

提交 `package.json` 與 `package-lock.json`；CI 與可重現安裝使用：

```bash
npm ci
```

安裝完成後可用下列指令檢查實際版本：

```bash
npm ls vue
```

Vue 單檔元件使用：

```vue
<script setup lang="ts">
import { ref } from 'vue'

const soundEnabled = ref(false)
</script>

<template>
  <button type="button" @click="soundEnabled = !soundEnabled">
    {{ soundEnabled ? '關閉聲音' : '開啟聲音' }}
  </button>
</template>
```

此範例只展示元件語法與 UI 狀態，實際音訊由 AudioManager 處理。

## 前端邊界

Vue 管理選單、音量設定、房間資訊、個人計數與連線提示。獨立的 TypeScript 遊戲核心管理以下工作：

| 模組責任 | 工作 |
| --- | --- |
| SceneRenderer | Three.js 場景、鏡頭、畫質與渲染排程 |
| AnimationSystem | 角色動作、插值與動畫更新 |
| NetworkClient | WebSocket、訊息編解碼、重連與狀態恢復 |
| AudioManager | 長音軌、短音效、音量與暫停恢復 |

以上模組已實作於 `web/src/game/`，由 `GameCore` 擁有並負責建立與釋放順序。高頻玩家狀態直接供遊戲核心使用，UI 只透過 `UiState` 接收低頻摘要（內容改變時才推送，最多每 250 ms 一次）。

直接使用 Three.js 的目的是控制高頻更新與依賴邊界；它不保證在相同場景下比所有封裝更快。效果須由相同素材、畫質、裝置與互動負載的量測判斷。

## 前端實作現況

| 路徑 | 職責 |
| --- | --- |
| `src/game/GameCore.ts` | 擁有所有子系統；渲染排程、生命週期、網路訊息分派、UI 橋接 |
| `src/game/render/` | `SceneRenderer`（renderer、鏡頭、畫質、context loss）、`TempleScene`（程序化場景）、`AvatarFactory`、`ResourceTracker`（GPU 資源擁有權） |
| `src/game/anim/` | 程序化角色動畫與動作片段表 |
| `src/game/audio/` | `AudioManager`：環境音樂檔串流、短音效（鐘、木魚、頌缽、鳥叫）即時合成、靜音／背景時暫停運算 |
| `tools/ambient/` | 離線產生環境音樂檔（佛樂＋風聲）的樂譜與輸出腳本 |
| `src/game/net/` | `protocol`（協定草案與驗證）、`NetworkClient`（重連、心跳、節流、確認重送）、`OutboundQueue`、`backoff` |
| `src/game/world/` | 場地配置（場景與碰撞共用）、移動與碰撞、玩家管理與插值 |
| `src/game/input/` | 點擊移動、拖曳旋轉、雙指／滾輪縮放、鍵盤 |
| `src/game/gameplay/` | **玩法擴充點**：`ActionRegistry`、`GameplayModule` 介面、`modules/`（目前只有可刪除的示範模組） |
| `src/ui/` | Vue 介面：進場、狀態列、動作列、設定、效能資訊、提示 |
| `scripts/mock-server.mjs` | 開發用 mock 伺服器，實作同一協定並提供機器人 |

### 渲染排程

- 有移動、動畫或鏡頭移動時以畫質上限幀率繪製（省電／標準 30 FPS，高畫質 60 FPS），高更新率螢幕會略過多餘的 rAF。
- 靜止時，標準與高畫質以 8／15 FPS 繪製燈火與香煙；省電模式完全停止迴圈，等輸入或網路事件喚醒。
- 切到背景時停止迴圈、暫停 AudioContext、停止送出位置；回前景時重設時間基準並直接把鏡頭移到定位。
- 繪製像素同時受 devicePixelRatio 上限與總像素上限限制。

### 已量測（桌面 Chromium、Playwright，非手機實測）

| 情境 | 結果 |
| --- | --- |
| 單人、高畫質、移動中 | 60 FPS，每幀 CPU 約 0.3 ms，35～39 draw call，約 2.5k 三角形 |
| 單人、高畫質、靜止 | 約 13 FPS（目標 15） |
| 單人、省電、靜止 | 3 秒內 0 次繪製 |
| 背景分頁 | 0 次繪製 |
| mock 伺服器 151 人、高畫質（顯示 121 人，角色批次繪製） | 60 FPS，每幀 CPU 約 0.7 ms，52 draw call，約 18k 三角形 |
| mock 伺服器關閉再啟動 | 自動重連約 2 秒，玩家清單以新快照取代 |

### 已知限制與後續

- 角色的袍、頭、影子以 InstancedMesh 批次繪製，不論人數都是 3 個 draw call；名牌為個別 sprite，只顯示最近 12 人。批次容量 160（`AVATAR_CAPACITY`），需大於最高畫質的可見人數。
- 可見人數上限（省電 30／標準 60／高畫質 120）仍需依手機實測調整；人數多時主要成本轉為三角形數與透明的影子重疊。
- 移動碰撞只把角色推出障礙物，不做尋路。
- 音效為合成音色，正式錄音可透過 `AudioManager.loadSfx()` 與 `VITE_AMBIENT_URL` 替換。
- 環境音樂（佛樂＋風聲）不在手機上即時合成，見下方「環境音樂」。
- 協定為 JSON 草案，欄位以 Rust 後端定案為準。
- 尚未做手機實機的發熱、耗電與 20～30 分鐘幀時間測試。

### 殿內場景（少林寺）

- 兩個場景（zone）：`courtyard`（庭院）與 `hall`（殿內），定義在 `src/game/world/zones.ts`：各自的可走範圍、障礙物、出生點、出入口、鏡頭距離與室內鏡頭邊界。場景建模、碰撞與（未來的）伺服器驗證都以此為準。
- 進出：庭院走到殿門階梯前（或點擊主殿建築，會自動走向殿門）即淡出黑幕進殿；殿內走回門口回庭院。出入口落點刻意放在對面出入口範圍外，避免來回瞬移（有測試）。殿內場景第一次進殿時才建立（桌面約 28 ms）。
- 點擊移動以 A*（0.5 公尺格子、8 方向、不切角）繞過障礙物，再以視線檢查拉直成少數轉折點（`world/pathfind.ts`）。修正了原本庭院中軸線上的香爐擋住殿門、手機玩家點殿門會卡住的問題。
- 神像方位依傳統以神明為主體：中央釋迦牟尼佛；主佛左手邊（龍邊，參拜者看去的右邊、+x）觀世音菩薩；右手邊（虎邊，參拜者看去的左邊、-x）關聖帝君。
- 陳設：紅柱、藻井、彩繪樑、兩側光明燈牆、宮燈、三座神龕與匾額（佛光普照、慈航普渡、義薄雲天）、供桌（香爐、紅燭、花、果）、拜墊、香煙與燭火。殿內燈光為暗而暖的環境，主光由殿門方向照向神龕。靠近神龕時鏡頭注視點上抬，像抬頭仰望；室內鏡頭只在水平方向拉近避免穿牆、高度保持。
- 神像為程序化風格化造型（`render/statues.ts`）：佛像結跏趺坐、禪定印、螺髮肉髻、白毫、長耳垂、背光；觀音白衣頭紗、寶冠、左手淨瓶右手楊柳枝、頭光；關聖帝君為站姿，右手於腰間斜握青龍偃月刀（刀刃斜指前下方、刀桿斜向左肩後方），紅臉長髯、臥蠶眉丹鳳眼、綠色幞頭與紅纓、深色鱗甲配金飾、紅腰帶、綠披風（依使用者 2026-11-06 提供的參考圖；臉色保留寺廟神像傳統的紅臉）。
- 效能：靜態物件依材質合併（`render/mergeStatic.ts`），殿內 draw call 由 190 降到約 70（關聖帝君改為站姿後三角形約 5.3 萬）；神像各自合併，不跨插槽。桌面 Chromium：高畫質面向神龕約 70 draw、4.6 萬三角形、每幀 CPU 1.2～1.9 ms；省電畫質直式手機尺寸 32 FPS、CPU 1.0 ms。尚未在手機實機量測。

#### 寫實模型替換

- 每尊神像是一個插槽（`HallScene.statueSlots`），`loadStatueModel(slot, id, url)` 以動態載入的 GLTFLoader 換成 glTF 模型，依 `STATUE_HEIGHT` 等比縮放並把底部對齊台面。已驗證：把程序化佛像匯出成 .glb（819 KB）再載入替換，高度 3.3 公尺、底部對齊，載入約 49 ms。
- 寫實模型規格：原點在底座底面中心、面向 +z、Y 軸朝上；每尊建議 3～5 萬面；貼圖用 KTX2 壓縮並烘焙光照（需另加 KTX2Loader 與轉碼器）；放在 R2 並設定 CORS（同環境音樂的部署檢查）。
- 寫實模型需委託雕刻或購買授權；三尊皆為宗教聖像，造型、手印與持物應請熟悉的人確認。

### 環境音樂

- 佛樂與風聲由 `npm run render:ambient` 離線產生：`tools/ambient/score.ts` 為樂譜（A 宮五聲音階、空五度持續和聲、簫聲旋律、3.5 秒合成殘響、褐噪音風聲），以 `node-web-audio-api` 的 OfflineAudioContext 算出 188 秒，將尾段 8 秒以等功率交叉淡化疊回開頭，輸出 180 秒、44.1 kHz 立體聲、112 kbps 的 MP3（約 2.4 MB）。種子固定時結果可重現。
- 遊戲以 HTMLMediaElement 串流循環播放（`VITE_AMBIENT_URL`），再接進 Web Audio 統一控制音量。手機執行時只解碼 MP3，不再即時運算和聲與殘響。
- 循環接縫：內容無縫（接縫前後 2 秒 RMS 0.126／0.120，接縫樣本差 0.0001，小於一般相鄰樣本差 0.005）。MP3 編碼器在頭尾各留約 260／122 個靜音樣本，每次循環約有 9 ms 空隙。
- 鳥叫（每 4～14 秒）與遠處頌缽仍為即時播放的短 AudioBuffer。
- 靜音或總音量為 0：淡出後暫停 AudioContext，音樂檔暫停；「環境與音樂」為 0：音樂檔、鳥叫與頌缽停止，音效仍可播放；背景：同靜音。已在 Chromium 驗證 AudioContext 狀態為 `suspended`、media 為 `paused`。
- 音樂檔放在 R2：與頁面不同網域時，R2 必須回應 `Access-Control-Allow-Origin`（允許遊戲網域），否則 `crossOrigin` 媒體接進 Web Audio 會輸出靜音。檔名含版本（例如 `temple-ambient-v1.mp3`）並設定長期快取，更新時換檔名。
- 未設定 `VITE_AMBIENT_URL` 時只有鳥叫、頌缽與動作音效。

#### 部署檢查（每次上傳或更換音樂檔都要做）

少了任何一項，玩家只會聽到鳥叫與偶爾的頌缽，伺服器與建置都不會報錯。

1. 建置時設定 `VITE_AMBIENT_URL` 為 R2 自訂網域上的檔案網址。未設定時，`vite build` 會印出「未設定 VITE_AMBIENT_URL」警告；CI 輸出出現這行代表這次建置沒有佛樂。
2. R2 bucket 的 CORS 允許遊戲網域（`AllowedOrigins` 填遊戲網站來源、`AllowedMethods` 含 `GET`、`HEAD`）。前端以 `crossOrigin="anonymous"` 載入，CORS 不通過時瀏覽器拒絕載入，遊戲會顯示「背景音樂無法載入」提示。
3. 上傳後執行 `npm run check:ambient -- <音樂檔網址> <遊戲網站來源>`，必須全部通過：HTTP 200、音訊 Content-Type、CORS 允許遊戲來源、Range 回 206（iOS Safari 需要）；長期快取為建議項目。
4. 用手機（至少一台 iPhone Safari）實際進場聽一次。

已驗證（2026-11-06，本機）：檢查腳本對未開 CORS 且不支援 Range 的伺服器回報 2 項失敗、結束碼 1；對設定正確的伺服器全部通過、結束碼 0。前端對未開 CORS 的網址顯示載入失敗提示。

## 載入、渲染與音訊方向

- 首次只載入基本場景、自己的角色與必要互動；其他玩家及非必要素材分批加入。
- 將下載、模型解碼、物件建立、貼圖上傳與 shader 編譯分開量測。
- 手機先以穩定 30 FPS 為調校起點，限制繪製總像素，提供可調整畫質；實際門檻待裝置測試後決定。
- 使用烘焙光照、共用材質與幾何，限制動態陰影、後製與完整骨架動畫數量；遠景可採簡化模型或 sprite。
- 畫面靜止時停止或降低重繪；持續動畫仍需對應的繪製頻率。聲音播放與 3D 重繪分開管理。
- 背景時暫停繪製，依產品需求降低網路活動；恢復前景後校正動畫時間與房間狀態，處理 WebGL context loss。
- 長誦經與環境音優先評估 HTMLMediaElement；短音效使用 Web Audio buffer。使用者操作後啟用播放，提供獨立音量與淡入淡出。
- 共用素材採明確的資源擁有權；離開場景時釋放不再使用的 GPU、音訊及連線資源。

以上為初始工程方向，尚非經過驗證的效能保證。

## 後端：Axum

2026-11-06 選定 Axum 0.8（當時最新 0.8.9），不採用 Actix-web。理由：

- 直接建立在 tokio 與 hyper 上，房間 actor（tokio task + channel）與 WebSocket 使用同一個執行環境，沒有額外的 actor 系統要學。
- WebSocket 為官方功能（`ws` feature），可設定單則訊息上限。
- 中介層使用 tower 生態（逾時、CORS、追蹤），與 `tower-http` 共用。
- 本專案的負載以長連線廣播為主，兩者的 HTTP 吞吐差異不是瓶頸；選擇以維護成本與生態一致性為準。

已確認參數：單一房間上限 50 人（`ROOM_CAPACITY`），超過時開新房間。任務拆分、驗收標準與稽核流程見 [BACKEND_TASKS.md](BACKEND_TASKS.md)。

### 流量基準（前端量測）

協定新增批次位置 `moves`（每個 tick 一則，只含有變動的玩家，座標精度 0.01 公尺）。以 mock 伺服器 50 人滿房、約半數機器人持續走動並隨機做動作，量測單一客戶端 20 秒：

| 項目 | 結果 |
| --- | --- |
| 接收量 | 約 6.1 KB/s |
| 訊息數 | 約 12.3 則/s（`moves` 約 9 則/s、`action` 約 3 則/s） |

預算為每人每秒 150～460 bytes，此情境超出 13～40 倍。機器人移動頻率高於靜心遊戲的預期行為，屬偏悲觀的估計；後端仍須以「靜止不送、降低 tick、二進位量化」為設計前提，並在 T7 以實際負載量測。

## 多人同步方向

瀏覽器使用原生 WebSocket 封裝，渲染選型與連線協定保持獨立。Rust 伺服器確認座位、房間加入結果及操作合法性。

- 分房或分區訂閱，控制每位玩家接收的其他玩家數量。
- 移動時按需要更新位置；停止移動後停止持續重送相同座標。
- 禮佛等動作傳送動作類型與開始時間，由各客戶端播放動畫。
- 初次加入傳送快照，之後傳送差異；重連時取得可恢復的一致狀態。
- 設定訊息大小、操作頻率與每連線佇列上限；尚未送出的過期位置可合併。
- 需要確認的操作與可取代狀態分開處理，避免重試產生重複副作用。
- JSON 或二進位編碼、位置量化、更新頻率依實測決定；先控制廣播範圍，再優化封包。

PostgreSQL 儲存持久資料，避免每個位置或動畫更新都寫入資料庫。資料庫連線池大小依主機與查詢負載調校，不依在線玩家數逐一建立連線。

## VPS 與部署限制

| 項目 | 使用者提供規格 |
| --- | --- |
| 節點 | Linode Tokyo |
| CPU | 1 vCPU；Shared／Dedicated 類型未提供 |
| RAM | 2 GiB |
| 儲存 | 50 GB SSD |
| 每月流量額度 | 2 TB |
| 出站頻寬 | 最高 2 Gbps |
| 入站頻寬 | 未提供 |

保留 Dokploy 作為選定部署工具。這台主機同時執行作業系統、Dokploy、代理、遊戲服務與 PostgreSQL 時餘裕有限；文件不宣稱已能承載 3,000～5,000 名活躍玩家。正式承載量須以整套部署環境壓測判定。

建置放在 CI，主機接收成品。設定日誌輪替、舊映像清理、資料庫備份與服務資源監控。單台主機故障或維護會影響所有連線，部署與重連流程必須納入驗收；單機配置不提供高可用性。

R2 使用自訂網域與快取提供素材，設定必要的 CORS 與版本化快取策略；WebSocket 狀態仍由 VPS 傳出。入站埠速與出站額度是不同條件，2 Gbps 也不代表整月可以持續以該速率傳送。

### 流量預算範例

假設 2 TB 為十進位、每月 30 天，並把全部額度分配給遊戲出站資料：

| 在線情境 | 每玩家平均可用出站資料 |
| --- | --- |
| 3,000 人整月持續在線 | 約 257 bytes/s |
| 5,000 人整月持續在線 | 約 154 bytes/s |
| 每天 8 小時有 5,000 人，其餘時間零流量 | 約 463 bytes/s |

公式：`每玩家 bytes/s = 2,000,000,000,000 / 每月總玩家在線秒數`。上述數字尚未扣協定、心跳、重連與其他請求，實際需預留餘額。

另一個假設：`5,000 接收者 × 30 名被觀察玩家 × 5 次/s × 32 bytes = 24 MB/s = 192 Mbps`。若此負載持續，約 23 小時就會使用 2 TB，尚未計協定開銷。這是流量算例，不是系統壓測結果。

## Phase 2：Tauri Mobile

沿用前端遊戲核心，以 Tauri 封裝 Android／iOS 應用程式。Tauri 使用平台 WebView，Three.js 仍在 WebView 執行；封裝不保證降低 GPU 負載、發熱或耗電。

進入 Phase 2 前，需先驗證 WebView 的圖形相容性、背景／前景恢復、音訊中斷、素材快取與弱網路重連。核心素材可評估隨應用程式分發，活動素材仍由 R2 提供。

## 容量與品質驗證

壓測需區分總連線、活躍玩家、同時移動／操作比例與每人訂閱人數。負載產生器放在外部機器，正式部署上的 PostgreSQL、Dokploy 與代理一併納入測試。

至少記錄 CPU、RSS、可用記憶體、訊息佇列長度、出站流量、斷線率、伺服器處理時間與客戶端操作延遲；包含持續運行、弱網路、慢速接收者及大量重連情境。

手機實測包含首次可操作時間與連續遊玩至少 20～30 分鐘後的幀時間、耗電與發熱；以固定裝置、亮度、音量及網路條件比較。通過標準在第一次實測後依產品需求制定。尚未執行上述驗證。

## 參考資料

- [Vue 3.5.44 發布紀錄](https://github.com/vuejs/core/releases/tag/v3.5.44)
- [Vue 3.5.44 套件資料](https://registry.npmjs.org/vue/3.5.44)
- [Vue 進階響應式 API](https://vuejs.org/api/reactivity-advanced.html)
- [Three.js 按需渲染](https://threejs.org/manual/pages/rendering-on-demand.html)
- [Web Audio 實務](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
- [Dokploy 安裝要求](https://docs.dokploy.com/docs/core/installation)
- [Linode 網路流量說明](https://techdocs.akamai.com/cloud-computing/docs/network-transfer-usage-and-costs)
- [R2 自訂網域與快取](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Tauri WebView 版本](https://v2.tauri.app/reference/webview-versions/)
