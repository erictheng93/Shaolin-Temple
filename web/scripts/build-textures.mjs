// 把 assets/textures/*.jpg 編碼成 public/textures/*.ktx2（ETC1S/BasisLZ，含 mipmap）。
// 需要 Khronos KTX-Software 的 ktx 執行檔：放在 PATH，或以環境變數 KTX 指定路徑。
// ponytail: 全部用 ETC1S，下載量與 JPG 相近；法線若看得出色塊再改 UASTC（下載量約 4 倍）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ktx = process.env.KTX ?? 'ktx'
const src = fileURLToPath(new URL('../assets/textures/', import.meta.url))
const out = fileURLToPath(new URL('../public/textures/', import.meta.url))
mkdirSync(out, { recursive: true })

for (const name of readdirSync(src).filter((f) => f.endsWith('.jpg'))) {
  const srgb = name.includes('_diff_')
  const args = ['create', '--format', srgb ? 'R8G8B8_SRGB' : 'R8G8B8_UNORM']
  if (!srgb) args.push('--assign-tf', 'linear')
  // 法線對壓縮誤差較敏感，給較高品質。
  args.push('--encode', 'basis-lz', '--clevel', '4', '--qlevel', name.includes('_nor_') ? '255' : '192', '--generate-mipmap')
  args.push(join(src, name))
  args.push(join(out, name.replace(/\.jpg$/, '.ktx2')))
  execFileSync(ktx, args, { stdio: 'inherit' })
  console.log(name)
}
