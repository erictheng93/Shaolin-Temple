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
- 音效與環境音：執行時由 `AudioManager` 合成，沒有音檔。

## Basis 轉碼器

`web/public/basis/`（`basis_transcoder.js`、`basis_transcoder.wasm`）是 three.js 隨附的 Basis Universal 轉碼器副本，與 `node_modules/three/examples/jsm/libs/basis/` 逐位元相同（見 `basis.test.ts`）。three.js 本身是 MIT 授權（版權為 three.js authors）。three 隨附的 README 說明這兩個檔案來自 [Basis Universal](https://github.com/BinomialLLC/basis_universal)，但沒有另外註明轉碼器的授權。Basis Universal 上游倉庫的授權是 Apache-2.0（2026-11-15 由 GitHub 的授權欄位查得）。

## 殿內神像（已選定，尚未接入）

2026-11-15 由專案負責人選定以下三個 Sketchfab 上的掃描模型。原檔需登入 Sketchfab 下載，放在 `web/.statues-src/<buddha|guanyin|mazu>/`（這個資料夾不進 git）。之後會在 Blender 減面到 3～5 萬面、烘焙貼圖後，才提交處理過的 glb。

接入後遊戲內要顯示署名；改作（減面、重新烘焙）要註明有修改。

| 位置 | 模型 | 作者／來源 | 授權 | 署名 | 原始面數 | 網址 |
| --- | --- | --- | --- | --- | --- | --- |
| 釋迦牟尼佛 | 1973.85 Seated Buddha（日本平安時代，鍍金木雕，含背光與蓮座） | Cleveland Museum of Art（館方帳號 clevelandart） | CC0 1.0 | 不需要 | 407,185 | <https://sketchfab.com/3d-models/197385-seated-buddha-d86bda08fa92458397596d2a42b30f46> |
| 觀世音菩薩 | 中国白瓷菩萨像 Chinese bodhisattva statue | efyilin（<https://sketchfab.com/efyilin>） | CC BY 4.0 | 需要，署名 efyilin | 370,026 | <https://sketchfab.com/3d-models/chinese-bodhisattva-statue-3aa3accdebb0454a9eee5fd4fced0d19> |
| 媽祖（取代原本的關聖帝君，位置在主佛右手邊、虎邊） | 9.拜殿神像 媽祖（1994 年木雕上漆，黑面） | cadyunlin2021（<https://sketchfab.com/cadyunlin2021>） | CC BY 4.0 | 需要，署名 cadyunlin2021 | 214,318 | <https://sketchfab.com/3d-models/9-2d5c1af855934957928e4e09bdde72e6> |

備註：

- 授權是 2026-11-15 由 Sketchfab 公開 API 的 license 欄位查得。
- 後兩個是個人帳號自行標示的授權，上線前應再目視確認模型頁並留存截圖。
- 媽祖神龕的匾額題詞定為「海國慈航」（原為「義薄雲天」）。
- 三尊皆為宗教聖像，造型是否合宜，建議請熟悉的人確認。
- Cleveland 那件另有拆件版本（.a 佛像本體 150,622 面、.b 背光、.c 蓮座），都是 CC0。
