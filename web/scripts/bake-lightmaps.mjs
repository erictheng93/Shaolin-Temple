// 庭院靜態光照烘焙：匯出幾何 → Blender（Cycles）烘焙 → 寫入指紋 → 編碼 KTX2。
//   npm run bake:lightmaps                 完整流程（需要 Blender：PATH 或環境變數 BLENDER；ktx：PATH 或環境變數 KTX）
//   node scripts/bake-lightmaps.mjs --export-only   只匯出到 .bake/（之後在已開啟的 Blender 執行 bake-lightmaps.py，見該檔開頭）
//   node scripts/bake-lightmaps.mjs --finish        匯出後不跑 Blender，直接以 assets/lightmaps 現有的 PNG 寫入指紋並編碼
// 幾何由 src/game/render/TempleScene.ts 的 buildPlainCourtyard() 產生（以 Vite 在 Node 執行 TypeScript），與執行時完全相同。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const exportDir = fileURLToPath(new URL('../.bake/', import.meta.url))
const outDir = fileURLToPath(new URL('../assets/lightmaps/', import.meta.url))
const mode = process.argv[2] ?? ''

const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
let fingerprint
try {
  const { buildPlainCourtyard } = await server.ssrLoadModule('/src/game/render/TempleScene.ts')
  const { exportCourtyardBake } = await server.ssrLoadModule('/src/game/render/courtyardBake.ts')
  const { ResourceTracker } = await server.ssrLoadModule('/src/game/render/ResourceTracker.ts')
  const tracker = new ResourceTracker()
  const court = buildPlainCourtyard(tracker)
  const { manifest, data } = exportCourtyardBake(court.bake)
  tracker.dispose()
  fingerprint = manifest.fingerprint
  mkdirSync(exportDir, { recursive: true })
  writeFileSync(exportDir + 'courtyard.json', JSON.stringify(manifest, null, 1))
  writeFileSync(exportDir + 'courtyard.bin', Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  console.log(`匯出 ${manifest.objects.length} 個物件、${(data.byteLength / 1024).toFixed(0)} KB，指紋 ${fingerprint}，圖集 texel ${(court.bake.atlas.texelSize * 100).toFixed(1)} cm`)
} finally {
  await server.close()
}
if (mode === '--export-only') process.exit(0)

if (mode !== '--finish') {
  const blender = process.env.BLENDER ?? 'blender'
  execFileSync(blender, ['-b', '--factory-startup', '-P', fileURLToPath(new URL('./bake-lightmaps.py', import.meta.url)), '--', exportDir, outDir], { stdio: 'inherit' })
}

writeFileSync(
  fileURLToPath(new URL('../src/game/render/courtyardBake.generated.ts', import.meta.url)),
  `// 由 npm run bake:lightmaps 產生，請勿手動修改。
// 烘焙當時的庭院幾何指紋；與執行時算出的不同時不載入烘焙貼圖（courtyardBake.test.ts 也會失敗）。
export const BAKED_FINGERPRINT = '${fingerprint}'
`,
)
execFileSync(process.execPath, [fileURLToPath(new URL('./build-textures.mjs', import.meta.url)), 'lightmaps'], { stdio: 'inherit' })
