// 殿內神像：寫實模型原檔 → 減面的遊戲模型（Draco glb）＋重新烘焙的貼圖（PNG → KTX2）。
//   npm run build:statues                 三尊全部（依序處理，佛像原檔 345 MB，一次只開一尊）
//   npm run build:statues -- mazu guanyin 只處理指定的幾尊
// 需要 Blender 5.3（PATH 或環境變數 BLENDER）與 ktx（PATH 或環境變數 KTX）。
// 原檔（不提交，需登入 Sketchfab 下載，來源見 docs/ASSETS.md）放在 web/.statues-src/<buddha|guanyin|mazu>/，每個資料夾一個 .glb。
// 輸出：web/assets/statues/<id>_<std|hi>_<diff|nor>.png（烘焙原檔）→ web/public/statues/ 的同名 .ktx2，
//       web/public/statues/<id>_<std|hi>.glb（只有幾何）。不產生 .blend 檔。
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const IDS = ['buddha', 'guanyin', 'mazu']
const ids = process.argv.slice(2).length ? process.argv.slice(2) : IDS
const web = fileURLToPath(new URL('..', import.meta.url))
const blender = process.env.BLENDER ?? 'blender'

for (const id of ids) {
  if (!IDS.includes(id)) throw new Error(`未知的神像：${id}（可用：${IDS.join(', ')}）`)
  const dir = join(web, '.statues-src', id)
  const glb = readdirSync(dir).find((f) => f.endsWith('.glb'))
  if (!glb) throw new Error(`找不到原檔：${dir}/*.glb`)
  execFileSync(
    blender,
    ['-b', '--factory-startup', '-P', join(web, 'scripts', 'process-statues.py'), '--', id, join(dir, glb), join(web, 'assets', 'statues'), join(web, 'public', 'statues')],
    { stdio: 'inherit' },
  )
}
execFileSync(process.execPath, [join(web, 'scripts', 'build-textures.mjs'), 'statues'], { stdio: 'inherit' })
