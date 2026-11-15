// 編碼 KTX2（ETC1S/BasisLZ，含 mipmap）：
//   assets/textures/*.jpg  → public/textures/*.ktx2（場景材質）
//   assets/lightmaps/*.png → public/lightmaps/*.ktx2（庭院烘焙貼圖，RGBA 線性：RGB = AO、A = 太陽可見度）
//   assets/statues/*.png   → public/statues/*.ktx2（殿內神像的底色 sRGB 與法線，由 process-statues 產生）
// 用法：node scripts/build-textures.mjs [textures|lightmaps|statues]（不給參數全部都做）。
// 需要 Khronos KTX-Software 的 ktx 執行檔：放在 PATH，或以環境變數 KTX 指定路徑。
// ponytail: 全部用 ETC1S，下載量與 JPG 相近；法線若看得出色塊再改 UASTC（下載量約 4 倍）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ktx = process.env.KTX ?? 'ktx'
const only = process.argv[2]


const jobs = [
  {
    name: 'textures',
    ext: '.jpg',
    args: (file) => {
      const srgb = file.includes('_diff_')
      const args = ['create', '--format', srgb ? 'R8G8B8_SRGB' : 'R8G8B8_UNORM']
      if (!srgb) args.push('--assign-tf', 'linear')
      // 法線對壓縮誤差較敏感，給較高品質。
      args.push('--encode', 'basis-lz', '--clevel', '4', '--qlevel', file.includes('_nor_') ? '255' : '192', '--generate-mipmap')
      return args
    },
  },
  {
    name: 'lightmaps',
    ext: '.png',
    // RGB 與 A 在 ETC1S 中是兩個獨立的 slice，影子的硬邊不會干擾 AO；資料是遮罩，用線性。
    args: () => ['create', '--format', 'R8G8B8A8_UNORM', '--assign-tf', 'linear', '--encode', 'basis-lz', '--clevel', '4', '--qlevel', '255', '--generate-mipmap'],
  },
  {
    name: 'statues',
    ext: '.png',
    args: (file) => {
      if (file.endsWith('_diff.png')) {
        return ['create', '--format', 'R8G8B8_SRGB', '--assign-tf', 'srgb', '--assign-primaries', 'bt709', '--encode', 'basis-lz', '--clevel', '4', '--qlevel', '255', '--generate-mipmap']
      }
      // 法線也用 ETC1S：比較過 UASTC（RDO＋zstd），貼臉放大時觀音臉頰的細紋略少，遊戲距離下看不出差別，
      // 但標準畫質三張就要 3.1 MB（ETC1S 0.8 MB），超出手機的下載預算。
      return ['create', '--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', '--encode', 'basis-lz', '--clevel', '4', '--qlevel', '255', '--generate-mipmap']
    },
  },
]

for (const job of jobs) {
  if (only && only !== job.name) continue
  const src = fileURLToPath(new URL(`../assets/${job.name}/`, import.meta.url))
  const out = fileURLToPath(new URL(`../public/${job.name}/`, import.meta.url))
  if (!existsSync(src)) continue
  mkdirSync(out, { recursive: true })
  for (const name of readdirSync(src).filter((f) => f.endsWith(job.ext))) {
    execFileSync(ktx, [...job.args(name), join(src, name), join(out, name.slice(0, -job.ext.length) + '.ktx2')], { stdio: 'inherit' })
    console.log(name)
  }
}
