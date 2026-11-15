import * as THREE from 'three'
import { assignAtlasUvs, assignPlanarUv, ATLAS_PADDING, Fingerprint, type AtlasResult } from './lightmapUv'
import { BAKED_FINGERPRINT } from './courtyardBake.generated'
import type { ResourceTracker } from './ResourceTracker'

/**
 * 庭院靜態光照烘焙（陰影與環境光遮蔽）。
 *
 * 流程（`npm run bake:lightmaps`）：Node 以 `buildCourtyard()` 建出與執行時相同的幾何與 uv1 →
 * `exportCourtyardBake()` 匯出給 Blender（`scripts/bake-lightmaps.py`，Cycles 烘焙）→
 * 輸出 `assets/lightmaps/*.png` → `build:textures` 編碼成 `public/lightmaps/*.ktx2`，
 * 並把幾何指紋寫進 `courtyardBake.generated.ts`。
 *
 * 貼圖內容（線性、非 HDR）：RGB = 環境光遮蔽（AO，三個通道相同），A = 太陽可見度（靜態物件互相投下的影子）。
 * ETC1S 的 RGB 與 A 是兩個獨立壓縮的 slice，影子的硬邊不會干擾 AO。
 * AO 走 three 內建的 aoMap（只影響環境光與反射）；太陽可見度由 `patchBakedSun` 乘在平行光的直接光上。
 */

/** 太陽（主光）位置：SceneRenderer 的戶外主光與烘焙共用，改了要重新烘焙（指紋會不符）。 */
export const OUTDOOR_SUN_POSITION: readonly [number, number, number] = [16, 7, 12]

export const BAKE_SETTINGS = {
  /** 圖集的排版基準邊長（texel）；標準畫質用縮半的 512 版本。 */
  atlasSize: 1024,
  /**
   * 地面烘焙貼圖以世界座標 xz 平面投影的範圍，範圍外取邊緣值。圍牆外要留到圍牆影子（約 4 公尺）之外，
   * 否則邊緣的影子會被延伸到整片牆外地面。
   */
  groundBounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
  /** Blender 裡代表地面的烘焙平面高度：高於鋪石與步道的頂面，地面類物件共用這一層的結果。 */
  groundPlaneY: 0.06,
  /** 太陽的視直徑（度），決定影子邊緣的柔和程度。 */
  sunAngleDeg: 1,
  /** AO 的遮蔽距離（公尺）。 */
  aoDistance: 2.5,
  aoSamples: 128,
  shadowSamples: 32,
} as const

export type LightmapKind = 'atlas' | 'ground'

/**
 * 烘焙貼圖的網址。public/ 下的檔案 Vite 不加雜湊，所以以烘焙時的幾何指紋當版本參數：
 * 重新烘焙後網址改變，瀏覽器與 CDN 不會拿舊貼圖配新幾何。
 */
export function lightmapUrl(kind: LightmapKind, textureSize: 512 | 1024): string {
  return `${import.meta.env.BASE_URL}lightmaps/courtyard_${kind}_${textureSize === 1024 ? '1k' : '512'}.ktx2?v=${BAKED_FINGERPRINT}`
}

export interface CourtyardBakeSetup {
  /** 接收烘焙貼圖的 Mesh（依序），都有 uv1。 */
  receivers: Array<{ mesh: THREE.Mesh; kind: LightmapKind }>
  /** 只擋光、不接收烘焙的動態物件（以目前的靜止姿態烘焙）。 */
  occluders: THREE.InstancedMesh[]
  atlasMaterials: Set<THREE.Material>
  groundMaterials: Set<THREE.Material>
  /** 烘焙前投射即時陰影的物件；烘焙貼圖套上後關閉。 */
  casters: THREE.Object3D[]
  atlas: AtlasResult
  /**
   * 幾何指紋（延遲計算，每次呼叫都重算）。烘焙腳本與測試使用；執行時只在開發模式檢查，
   * 正式版不呼叫（幾何與烘焙一致由 courtyardBake.test.ts 在 CI 保證）。
   */
  fingerprint(): string
}

/** 為 root 底下的靜態 Mesh 寫入 uv1：地面類材質用平面投影，其餘排進圖集。須在 mergeStatic 之前呼叫。 */
export function prepareLightmapUvs(root: THREE.Object3D, groundMaterials: ReadonlySet<THREE.Material>, tracker: ResourceTracker): AtlasResult {
  root.updateMatrixWorld(true)
  const atlas: THREE.Mesh[] = []
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return
    if (groundMaterials.has(o.material as THREE.Material)) assignPlanarUv(o, BAKE_SETTINGS.groundBounds)
    else atlas.push(o)
  })
  return assignAtlasUvs(atlas, BAKE_SETTINGS.atlasSize, (g) => tracker.track(g))
}

/**
 * 整理烘焙資料並計算指紋。不一致（接收者沒有 uv1、動態物件用到接收烘焙的材質）時丟出錯誤：
 * 否則 shader 會讀到不存在的 uv1，靜默地取錯位置。
 */
export function collectBakeSetup(
  root: THREE.Object3D,
  groundMaterials: ReadonlySet<THREE.Material>,
  atlas: AtlasResult,
  occluders: THREE.InstancedMesh[],
  noShadow: readonly THREE.Object3D[],
): CourtyardBakeSetup {
  root.updateMatrixWorld(true)
  const receivers: CourtyardBakeSetup['receivers'] = []
  const atlasMaterials = new Set<THREE.Material>()
  const usedGround = new Set<THREE.Material>()
  const casters: THREE.Object3D[] = []
  const instancedMaterials: THREE.Material[] = []
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    if (!noShadow.includes(o)) casters.push(o)
    const material = o.material as THREE.Material
    if (o instanceof THREE.InstancedMesh) {
      instancedMaterials.push(material)
      return
    }
    if (!o.geometry.attributes.uv1) throw new Error(`烘焙：${o.name || material.type} 沒有 uv1`)
    const kind: LightmapKind = groundMaterials.has(material) ? 'ground' : 'atlas'
    ;(kind === 'ground' ? usedGround : atlasMaterials).add(material)
    receivers.push({ mesh: o, kind })
  })
  for (const mat of instancedMaterials) {
    if (atlasMaterials.has(mat) || usedGround.has(mat)) throw new Error('烘焙：動態物件不可與接收烘焙的物件共用材質')
  }
  return {
    receivers,
    occluders,
    atlasMaterials,
    groundMaterials: usedGround,
    casters,
    atlas,
    fingerprint: () => fingerprintOf(receivers, occluders),
  }
}

function fingerprintOf(receivers: CourtyardBakeSetup['receivers'], occluders: readonly THREE.InstancedMesh[]): string {
  const f = new Fingerprint()
  const s = BAKE_SETTINGS
  for (const v of [s.atlasSize, s.groundPlaneY, s.sunAngleDeg, s.aoDistance, s.aoSamples, s.shadowSamples, ...Object.values(s.groundBounds), ...OUTDOOR_SUN_POSITION]) {
    f.num(v, 1e-4)
  }
  const p = new THREE.Vector3()
  for (const { mesh, kind } of receivers) {
    f.int(kind === 'atlas' ? 1 : 2)
    const pos = mesh.geometry.attributes.position!
    const uv1 = mesh.geometry.attributes.uv1!
    f.int(pos.count)
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      f.num(p.x, 1e-3)
      f.num(p.y, 1e-3)
      f.num(p.z, 1e-3)
      f.num(uv1.getX(i), 1e-5)
      f.num(uv1.getY(i), 1e-5)
    }
  }
  const m = new THREE.Matrix4()
  for (const o of occluders) {
    const pos = o.geometry.attributes.position!
    f.int(o.count)
    f.int(pos.count)
    for (let k = 0; k < o.count; k++) {
      o.getMatrixAt(k, m)
      m.premultiply(o.matrixWorld)
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(m)
        f.num(p.x, 1e-3)
        f.num(p.y, 1e-3)
        f.num(p.z, 1e-3)
      }
    }
  }
  return f.digest()
}

/** lights_fragment_begin 中平行光取得光照資訊的那一行；升級 three 後若找不到，測試會失敗。 */
export const SUN_HOOK = 'getDirectionalLightInfo( directionalLight, directLight );'

/**
 * 讓 MeshStandardMaterial 的平行光直接光乘上烘焙貼圖 A 通道（太陽可見度）。
 * 沒有 aoMap（烘焙貼圖未載入或停用）時沒有 USE_AOMAP，等同未修改。
 * 只裝在庭院接收烘焙的材質上；庭院只有一盞平行光（太陽），殿內的材質不受影響。
 * 所有材質共用這同一個函式，program cache key（onBeforeCompile.toString()）一致。
 */
export function patchBakedSun(shader: THREE.WebGLProgramParametersWithUniforms): void {
  const chunk = THREE.ShaderChunk.lights_fragment_begin
  if (!chunk.includes(SUN_HOOK)) return
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_fragment_begin>',
    [
      '#ifdef USE_AOMAP',
      '\tfloat bakedSun = texture2D( aoMap, vAoMapUv ).a;',
      '#else',
      '\tfloat bakedSun = 1.0;',
      '#endif',
      chunk.replace(SUN_HOOK, `${SUN_HOOK}\n\t\tdirectLight.color *= bakedSun;`),
    ].join('\n'),
  )
}

/** 給 Blender 的資料：manifest（JSON）與一個 Float32 緩衝區。座標為 three 的世界座標（y 朝上）。 */
export interface BakeExport {
  manifest: {
    version: 1
    fingerprint: string
    sunDirection: [number, number, number]
    settings: typeof BAKE_SETTINGS
    /** chart 四周的 texel 數（以 atlasSize 計），Blender 以同樣的 margin 延伸。 */
    padding: number
    objects: Array<{ name: string; role: LightmapKind | 'occluder'; vertexCount: number; offset: number }>
  }
  data: Float32Array
}

/**
 * 匯出烘焙場景。每個物件是非索引三角形：positions（3n）、normals（3n），接收者再接 uv1（2n），offset 以 float 計。
 * 地面類接收者不逐一匯出，改用一塊高於鋪石的平面（groundPlaneY）代表：它們共用同一張平面投影的貼圖。
 */
export function exportCourtyardBake(setup: CourtyardBakeSetup): BakeExport {
  const chunks: number[][] = []
  let offset = 0
  const objects: BakeExport['manifest']['objects'] = []
  const push = (name: string, role: LightmapKind | 'occluder', g: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    const geom = g.index ? g.toNonIndexed() : g.clone()
    geom.applyMatrix4(matrix)
    if (!geom.attributes.normal) geom.computeVertexNormals()
    const pos = geom.attributes.position!
    let out = Array.from(pos.array as Float32Array).concat(Array.from(geom.attributes.normal!.array as Float32Array))
    if (role !== 'occluder') out = out.concat(Array.from(geom.attributes.uv1!.array as Float32Array))
    objects.push({ name, role, vertexCount: pos.count, offset })
    chunks.push(out)
    offset += out.length
    geom.dispose()
  }
  setup.receivers.forEach(({ mesh, kind }, i) => {
    if (kind === 'atlas') push(`atlas_${i}`, 'atlas', mesh.geometry, mesh.matrixWorld)
  })
  const b = BAKE_SETTINGS.groundBounds
  const plane = new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ).rotateX(-Math.PI / 2)
  plane.translate((b.minX + b.maxX) / 2, BAKE_SETTINGS.groundPlaneY, (b.minZ + b.maxZ) / 2)
  const planeMesh = new THREE.Mesh(plane)
  assignPlanarUv(planeMesh, b)
  push('ground', 'ground', plane, new THREE.Matrix4())
  plane.dispose()
  const m = new THREE.Matrix4()
  setup.occluders.forEach((o, i) => {
    for (let k = 0; k < o.count; k++) {
      o.getMatrixAt(k, m)
      m.premultiply(o.matrixWorld)
      push(`occluder_${i}_${k}`, 'occluder', o.geometry, m)
    }
  })
  const data = new Float32Array(offset)
  let at = 0
  for (const c of chunks) {
    data.set(c, at)
    at += c.length
  }
  const sun = new THREE.Vector3(...OUTDOOR_SUN_POSITION).normalize()
  return {
    manifest: { version: 1, fingerprint: setup.fingerprint(), sunDirection: [sun.x, sun.y, sun.z], settings: BAKE_SETTINGS, padding: ATLAS_PADDING, objects },
    data,
  }
}
