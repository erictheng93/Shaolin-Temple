# 素材來源與授權清單

這個 repo 是公開的，所有第三方素材的來源、授權與署名集中記錄在這裡。

## 新增素材時的規則

- 只使用 CC0、CC BY 或專案自有的素材。
- 不使用 NC（非商用）、ND（禁止改作）、SA（相同方式分享）或授權不明的素材。
- 新增時在這份清單登記來源、授權、署名與取得日期。
- 需要署名的素材，接入後要在遊戲內顯示署名；改作（減面、重新烘焙等）要註明有修改。
- 第三方原檔若體積大，不提交原檔，只提交處理後的成品。

## 場景貼圖

來源是 [Poly Haven](https://polyhaven.com/)，授權 CC0，不需署名。原檔在 `web/assets/textures/`（`_1k` 與 `_512` 兩種解析度，各有 `diff`、`nor`、`rough`），編碼後的 KTX2 在 `web/public/textures/`。

| Poly Haven id | 用途（`TempleScene.ts` 的 `TEX`） |
| --- | --- |
| `floor_pavement` | 鋪石地面（paving） |
| `japanese_stone_wall` | 圍牆與步道石材（stone、path） |
| `red_plaster_weathered` | 紅色灰泥牆（plaster） |
| `grey_roof_tiles_02` | 屋頂瓦片（roof） |
| `leafy_grass` | 草地與樹冠（grass、canopy） |
| `chinese_cedar_bark` | 樹幹（bark） |

## 程式產生的素材

以下都是專案自己產生，沒有第三方授權：

- 小沙彌模型 `web/public/models/monk.glb` 與 `monk-lod.glb`：由 `web/scripts/build-avatar.mjs` 產生（`npm run build:avatar`）。
- 庭院烘焙貼圖 `web/assets/lightmaps/` 與 `web/public/lightmaps/`：由 `npm run bake:lightmaps` 以庭院的程序化幾何烘焙。
- 殿門外景 `web/assets/backdrops/hall_doorway.png` 與 `web/public/backdrops/hall_doorway.ktx2`：由 `npm run capture:doorway` 從遊戲自己的庭院場景擷取（場景中的第三方貼圖是上方 Poly Haven 的 CC0 貼圖），再以 `build-textures.mjs backdrops` 編碼。
- 殿內景（從庭院看進殿門）`web/assets/backdrops/hall_interior.png` 與 `web/public/backdrops/hall_interior.ktx2`：由 `npm run capture:doorway` 從遊戲自己的殿內場景擷取，畫面中有三尊神像（來源、授權與署名見下方「殿內神像」；觀音與媽祖是 CC BY 4.0，署名已列在設定面板的「素材來源」，這張截圖屬於同一件作品在遊戲中的呈現），再以 `build-textures.mjs backdrops` 編碼。
- 殿門格扇的格心與地上日光的貼圖：執行時以 canvas 繪製（`render/hallDoorway.ts`），沒有檔案。庭院主殿正面的格扇門與格扇窗用同一個畫法。
- 音效與環境音：執行時由 `AudioManager` 合成，沒有音檔。

## Basis 轉碼器

`web/public/basis/`（`basis_transcoder.js`、`basis_transcoder.wasm`）是 three.js 隨附的 Basis Universal 轉碼器副本，與 `node_modules/three/examples/jsm/libs/basis/` 逐位元相同（見 `basis.test.ts`）。three.js 本身是 MIT 授權（版權為 three.js authors）。three 隨附的 README 說明這兩個檔案來自 [Basis Universal](https://github.com/BinomialLLC/basis_universal)，但沒有另外註明轉碼器的授權。Basis Universal 上游倉庫的授權是 Apache-2.0（2026-11-15 由 GitHub 的授權欄位查得）。

## 殿內神像（已接入）

2026-11-15 由專案負責人選定以下三個 Sketchfab 上的模型，同日接入遊戲。原檔需登入 Sketchfab 下載，放在 `web/.statues-src/<buddha|guanyin|mazu>/`（每個資料夾一個 .glb；這個資料夾不進 git），以 `npm run build:statues` 處理（流程見下）。遊戲內在設定面板的「素材來源」顯示需要署名的兩件（模型名稱、作者、CC BY 4.0、「已減面並重新烘焙貼圖」與模型頁連結），CC0 的佛像列為致謝。

| 位置（程式中的鍵） | 模型 | 作者／來源 | 授權 | 署名 | 原始面數 | 網址 |
| --- | --- | --- | --- | --- | --- | --- |
| 釋迦牟尼佛（`buddha`，中央） | 1973.85 Seated Buddha（日本平安時代，木雕，含背光與蓮座） | Cleveland Museum of Art（館方帳號 clevelandart） | CC0 1.0 | 不需要 | 407,185 | <https://sketchfab.com/3d-models/197385-seated-buddha-d86bda08fa92458397596d2a42b30f46> |
| 觀世音菩薩（`guanyin`，主佛左手邊、龍邊、+x） | 中国白瓷菩萨像 Chinese bodhisattva statue | efyilin（<https://sketchfab.com/efyilin>） | CC BY 4.0 | 需要，署名 efyilin | 370,026 | <https://sketchfab.com/3d-models/chinese-bodhisattva-statue-3aa3accdebb0454a9eee5fd4fced0d19> |
| 媽祖（`mazu`，取代原本的關聖帝君，主佛右手邊、虎邊、-x） | 9.拜殿神像 媽祖（1994 年木雕上漆，黑面） | cadyunlin2021（<https://sketchfab.com/cadyunlin2021>） | CC BY 4.0 | 需要，署名 cadyunlin2021 | 214,318 | <https://sketchfab.com/3d-models/9-2d5c1af855934957928e4e09bdde72e6> |

### 處理方式（改作內容）

`web/scripts/process-statues.mjs` 依序對每尊執行 `blender -b --factory-startup -P scripts/process-statues.py`（Blender 5.3、Cycles，有 NVIDIA 顯示卡時用 OptiX），再以 `build-textures.mjs statues` 編碼 KTX2。不產生 .blend 檔；同樣的原檔重跑會得到相同的幾何。

- 只做不改變造型的處理：轉正朝向（觀音原檔正面朝 +x，轉 -90°）、原點移到底面中心、高度正規化為 1、合併重複頂點（媽祖原檔每個三角形各自獨立）、刪除小於整體 0.05% 面數的獨立碎片（只有媽祖有 3 片、共 28 面的掃描殘留）、減面（Blender Decimate collapse）、重新展 UV（Smart UV Project；臉與手另外展開、貼圖密度為其他部分的 2 倍）、從原始高模烘焙底色（原貼圖的底色接到 Emission，以 EMIT 烘焙，不含打光與金屬度）與切線空間法線（含原檔本身的法線貼圖）。
- 三件都沒有博物館展示台或支架：佛像的八角台座、蓮座與背光，媽祖的椅子與紅色底座都是神像本身，全部保留。沒有補洞（底面朝下貼著神龕台面，看不到）。
- 造型、臉色、持物與手印完全沿用原檔：佛像是右手上舉的施無畏印（與先前程序化造型的禪定印不同）；媽祖戴冕旒（珠簾），臉大半被珠簾遮住，黑面上的五官是淺浮雕；觀音坐在太湖石上，右側有淨瓶。

### 成品

每尊兩個層級：`std` 給標準畫質（手機預設），`hi` 給高畫質。幾何是只含位置、法線、切線與 UV 的 Draco glb（不含材質與貼圖），貼圖是 KTX2（ETC1S，含 mipmap；底色 sRGB、法線線性）。烘焙的 PNG 原檔在 `web/assets/statues/`（約 40 MB，重新編碼 KTX2 不需要 Blender），發布用的在 `web/public/statues/`。

| 檔案 | 三角形 | 貼圖 | glb | 底色 KTX2 | 法線 KTX2 | 小計 |
| --- | --- | --- | --- | --- | --- | --- |
| `buddha_std` | 14,999 | 1024 | 219 KB | 265 KB | 292 KB | 776 KB |
| `guanyin_std` | 15,000 | 1024 | 142 KB | 168 KB | 226 KB | 535 KB |
| `mazu_std` | 14,999 | 1024 | 175 KB | 303 KB | 296 KB | 773 KB |
| `buddha_hi` | 40,000 | 2048 | 441 KB | 894 KB | 896 KB | 2.23 MB |
| `guanyin_hi` | 40,000 | 2048 | 295 KB | 455 KB | 574 KB | 1.32 MB |
| `mazu_hi` | 40,000 | 2048 | 389 KB | 963 KB | 918 KB | 2.27 MB |

標準畫質三尊合計 2.08 MB，加上 Draco 解碼器（`web/public/draco/`，gzip 後約 75 KB）約 2.16 MB；高畫質三尊合計 5.82 MB。Draco glb 與 KTX2 本身已壓縮，gzip 幾乎沒有效果。

Draco 解碼器是 three 隨附的副本（`node_modules/three/examples/jsm/libs/draco/gltf/`，`draco.test.ts` 檢查逐位元相同），上游 [google/draco](https://github.com/google/draco) 為 Apache-2.0。

### 備註

- 授權是 2026-11-15 由 Sketchfab 公開 API 的 license 欄位查得；三個原檔的 glTF `asset.extras` 也記載相同的作者與授權。
- 後兩個是個人帳號自行標示的授權，上線前應再目視確認模型頁並留存截圖。
- 觀音原檔的節點與材質名稱是 `tripo_node_…`／`tripo_material_…`，看起來是以 Tripo（AI 產生 3D 模型的服務）產生或處理過的，不一定是實物掃描。上線前建議向作者確認來源與授權是否能以 CC BY 4.0 釋出。
- 媽祖神龕的匾額題詞為「海國慈航」（原為「義薄雲天」）。
- 三尊皆為宗教聖像，造型是否合宜，建議請熟悉的人確認。
- Cleveland 那件另有拆件版本（.a 佛像本體 150,622 面、.b 背光、.c 蓮座），都是 CC0；目前用的是合併版。
