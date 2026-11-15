import * as THREE from 'three'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { QualityPreset } from '../core/settings'
import { BELL_PAVILION, CENSER, HALL, LANTERNS, TREES } from '../world/layout'
import { BAKED_FINGERPRINT } from './courtyardBake.generated'
import { collectBakeSetup, lightmapUrl, patchBakedSun, prepareLightmapUvs, type CourtyardBakeSetup } from './courtyardBake'
import { mergeStatic } from './mergeStatic'
import type { ResourceTracker } from './ResourceTracker'

/** 晨霧色：霧與清除色共用，遠山融入其中；需與程序化天空的地平線顏色接近。 */
export const SKY_COLOR = '#dfe2e4'
export const TEMPLE_NAME = '少林寺'

/**
 * 貼圖來自 Poly Haven（CC0），原檔在 assets/textures/<id>_<diff|nor|rough>_<512|1k>.jpg，
 * 以 `npm run build:textures` 編碼成 public/textures/ 的同名 .ktx2。
 * tile 是貼圖一次重複涵蓋的實際公尺數；fallback 是貼圖載入前的底色。
 */
const TEX = {
  paving: { id: 'floor_pavement', tile: 4, fallback: '#8f8a80' },
  stone: { id: 'japanese_stone_wall', tile: 2.6, fallback: '#77736c' },
  plaster: { id: 'red_plaster_weathered', tile: 2, fallback: '#9a4534' },
  roof: { id: 'grey_roof_tiles_02', tile: 1.5, fallback: '#4a4d55' },
  grass: { id: 'leafy_grass', tile: 2, fallback: '#66803f' },
  bark: { id: 'chinese_cedar_bark', tile: 2.27, fallback: '#5a4434' },
} as const

const PALETTE = {
  lacquer: '#8f2a1c',
  woodDark: '#3a271c',
  gold: '#d9b25a',
  bronze: '#8a744a',
  leafA: '#5f8a45',
  leafB: '#86ad5a',
  leafGold: '#c9a13f',
  mountainA: '#4f5f78',
  mountainB: '#63708a',
  lantern: '#ffcf80',
}

/** 材質與其貼圖的實際尺寸（沒有貼圖時 tile 無意義）。 */
export interface Surface {
  material: THREE.MeshStandardMaterial
  tile: number
}

type V3 = [number, number, number]

/** 方塊，UV 以公尺為單位除以 tile：不同大小的方塊共用材質時紋理密度一致。 */
function texBox(w: number, h: number, d: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  const uv = g.attributes.uv!
  // BoxGeometry 的面順序：+x、-x、+y、-y、+z、-z，每面 4 個頂點
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]] as const
  for (let k = 0; k < 24; k++) {
    const [u, v] = dims[k >> 2]!
    uv.setXY(k, (uv.getX(k) * u) / tile, (uv.getY(k) * v) / tile)
  }
  return g
}

/**
 * 曲面屋頂：簷口為 w×d 的矩形（y=0），向上收到 rw×rd 的矩形（y=h；rd=0 為正脊，rw=rd=0 為攢尖）。
 * 坡面下緩上陡，四角依 lift 起翹成飛簷。UV 以公尺為單位，v 沿坡面向上。
 */
function hipRoof(w: number, d: number, h: number, rw: number, rd: number, lift: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const N = 16
  const M = 8
  const face = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) => {
    const base = pos.length / 3
    // 每個坡面一個 group：四個坡面的貼圖 UV 互相重疊，烘焙貼圖的 uv1 需要分開排（單一材質繪製時 group 不影響 draw call）
    g.addGroup(idx.length, M * N * 6, 0)
    const eave = Math.hypot(bx - ax, bz - az)
    const top = Math.hypot(dx - cx, dz - cz)
    const slope = Math.hypot((ax + bx - cx - dx) / 2, (az + bz - cz - dz) / 2, h)
    for (let j = 0; j <= M; j++) {
      const t = j / M
      for (let i = 0; i <= N; i++) {
        const s = i / N
        const ex = ax + (bx - ax) * s
        const ez = az + (bz - az) * s
        const corner = Math.abs(s * 2 - 1)
        pos.push(
          ex + (cx + (dx - cx) * s - ex) * t,
          h * Math.pow(t, 1.6) + lift * Math.pow(1 - t, 3) * Math.pow(corner, 4),
          ez + (cz + (dz - cz) * s - ez) * t,
        )
        uv.push(((s - 0.5) * (eave + (top - eave) * t)) / tile, (t * slope) / tile)
      }
    }
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const a = base + j * (N + 1) + i
        idx.push(a, a + 1, a + N + 1, a + 1, a + N + 2, a + N + 1)
      }
    }
  }
  const hw = w / 2
  const hd = d / 2
  const tw = rw / 2
  const td = rd / 2
  face(-hw, hd, hw, hd, -tw, td, tw, td)
  face(hw, hd, hw, -hd, tw, td, tw, -td)
  face(hw, -hd, -hw, -hd, tw, -td, -tw, -td)
  face(-hw, -hd, -hw, hd, -tw, -td, -tw, td)
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** 樹冠：球面加上低頻起伏，避免看起來像幾何球。 */
function canopyGeometry(): THREE.BufferGeometry {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, 3))
  const p = g.attributes.position!
  const uv = g.attributes.uv!
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const k = 1 + 0.2 * Math.sin(x * 3.1 + 1) * Math.sin(y * 2.7) * Math.sin(z * 3.3 + 2) + 0.09 * Math.sin(x * 7 + y * 5) * Math.sin(z * 6.3)
    p.setXYZ(i, x * k, y * k, z * k)
    uv.setXY(i, uv.getX(i) * 4, uv.getY(i) * 2)
  }
  g.computeVertexNormals()
  return g
}

function softCircleTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, inner)
  grad.addColorStop(1, outer)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function plaqueTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 172
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#2b2620'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.strokeStyle = '#c9a24f'
  ctx.lineWidth = 8
  ctx.strokeRect(14, 14, c.width - 28, c.height - 28)
  ctx.fillStyle = '#d9b45e'
  ctx.font = '600 112px "Noto Serif TC", "Songti TC", "PMingLiU", serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // 平均分配字距，讓殿名撐滿匾額
  const chars = [...text]
  const step = (c.width - 160) / chars.length
  chars.forEach((ch, i) => ctx.fillText(ch, 80 + step * (i + 0.5), c.height / 2 + 6))
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** 庭院用到的表面材質；`buildCourtyard()` 只依這張表建構幾何，不管材質如何建立（執行時是寫實材質，烘焙匯出時是素色材質）。 */
export type SurfaceKey =
  | 'grass' | 'paving' | 'path' | 'stone' | 'plaster' | 'roof' | 'bark' | 'canopy'
  | 'lacquer' | 'woodDark' | 'gold' | 'bronze' | 'cloth' | 'mountain' | 'lantern' | 'plaque'
export type CourtyardSurfaces = Record<SurfaceKey, Surface>

type TexDef = { id: string; tile: number; fallback: string }
export type SurfaceSpec =
  | { tex: TexDef; tint?: string; params?: THREE.MeshStandardMaterialParameters }
  | { color: string; params?: THREE.MeshStandardMaterialParameters }

/** 匾額另外處理（貼圖是執行時畫的字），不在這張表。 */
export const SURFACE_SPECS: Record<Exclude<SurfaceKey, 'plaque'>, SurfaceSpec> = {
  grass: { tex: TEX.grass, tint: '#a8d27a' },
  paving: { tex: TEX.paving },
  path: { tex: TEX.stone, tint: '#d8d2c6' },
  stone: { tex: TEX.stone },
  plaster: { tex: TEX.plaster, tint: '#e2a08c' },
  roof: { tex: TEX.roof, tint: '#c8ccd6', params: { side: THREE.DoubleSide } },
  bark: { tex: TEX.bark },
  canopy: { tex: TEX.grass, tint: '#ffffff', params: { roughness: 1 } },
  lacquer: { color: PALETTE.lacquer, params: { roughness: 0.38 } },
  woodDark: { color: PALETTE.woodDark, params: { roughness: 0.6 } },
  gold: { color: PALETTE.gold, params: { metalness: 1, roughness: 0.3 } },
  bronze: { color: PALETTE.bronze, params: { metalness: 0.9, roughness: 0.48 } },
  cloth: { color: '#ffffff', params: { roughness: 1 } },
  mountain: { color: '#ffffff', params: { roughness: 1, flatShading: true } },
  lantern: { color: '#fff3d8', params: { emissive: PALETTE.lantern, emissiveIntensity: 0.9 } },
}

/** 鋪在地面上、以平面投影使用地面烘焙貼圖的材質。 */
const GROUND_SURFACES: readonly SurfaceKey[] = ['grass', 'paving', 'path']

export interface Courtyard {
  root: THREE.Group
  ground: THREE.Mesh
  bellPivot: THREE.Group
  canopyMesh: THREE.InstancedMesh
  canopyItems: ReadonlyArray<{ pos: V3; scale: V3; rotY: number }>
  leaves: THREE.InstancedMesh
  robeMesh: THREE.InstancedMesh
  robeItems: ReadonlyArray<{ pos: V3 }>
  /** 烘焙：接收烘焙貼圖的物件與材質、只擋光的動態物件（以靜止姿態烘焙），與幾何指紋。 */
  bake: CourtyardBakeSetup
}

/**
 * 以材質表建構庭院幾何（不載入貼圖、不使用 DOM，烘焙匯出腳本在 Node 也呼叫這個函式）。
 * 靜態物件依材質合併並寫入烘焙貼圖用的 uv1。
 */
export function buildCourtyard(m: CourtyardSurfaces, tracker: ResourceTracker): Courtyard {
  const root = new THREE.Group()
  root.name = 'temple'
  const geo = <T extends THREE.BufferGeometry>(g: T) => tracker.track(g)
  const std = (params: THREE.MeshStandardMaterialParameters) => tracker.trackMaterial(new THREE.MeshStandardMaterial(params))

  const pyramid = geo(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0))
  const cylinder = geo(new THREE.CylinderGeometry(0.5, 0.5, 1, 20))

  const place = (mesh: THREE.Object3D, pos: V3) => {
    mesh.position.set(...pos)
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    root.add(mesh)
    return mesh
  }
  /** 方塊（實際尺寸，UV 依材質的 tile）。 */
  const box = (s: Surface, pos: V3, size: V3) => place(new THREE.Mesh(geo(texBox(...size, s.tile)), s.material), pos)
  /** 共用幾何，以縮放決定大小。 */
  const add = (g: THREE.BufferGeometry, s: Surface, pos: V3, scale: V3) => {
    const mesh = new THREE.Mesh(g, s.material)
    mesh.scale.set(...scale)
    return place(mesh, pos)
  }
  /** 多個靜態的共用幾何：各自一個 Mesh，之後依材質合併（每個都需要自己的烘焙貼圖區域，不能用 InstancedMesh）。 */
  const many = (g: THREE.BufferGeometry, s: Surface, items: ReadonlyArray<{ pos: V3; scale: V3 }>) => {
    for (const it of items) add(g, s, it.pos, it.scale)
  }
  const roof = (pos: V3, w: number, d: number, h: number, rw: number, rd: number, lift: number) =>
    place(new THREE.Mesh(geo(hipRoof(w, d, h, rw, rd, lift, m.roof.tile)), m.roof.material), pos)

  const tmp = new THREE.Object3D()
  /** 會動的物件（樹冠、晾衣）與遠山：InstancedMesh，不接收烘焙貼圖。 */
  const instanced = (
    g: THREE.BufferGeometry,
    material: THREE.Material,
    items: ReadonlyArray<{ pos: V3; scale: V3; rotY?: number; color?: string }>,
  ) => {
    const mesh = new THREE.InstancedMesh(g, material, items.length)
    items.forEach((it, i) => {
      tmp.position.set(...it.pos)
      tmp.scale.set(...it.scale)
      tmp.rotation.set(0, it.rotY ?? 0, 0)
      tmp.updateMatrix()
      mesh.setMatrixAt(i, tmp.matrix)
      if (it.color) mesh.setColorAt(i, new THREE.Color(it.color))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.matrixAutoUpdate = false
    root.add(mesh)
    return mesh
  }

  // 地面
  const groundGeo = geo(new THREE.PlaneGeometry(140, 140))
  groundGeo.rotateX(-Math.PI / 2)
  const groundUv = groundGeo.attributes.uv!
  for (let i = 0; i < groundUv.count; i++) groundUv.setXY(i, (groundUv.getX(i) * 140) / m.grass.tile, (groundUv.getY(i) * 140) / m.grass.tile)
  const ground = new THREE.Mesh(groundGeo, m.grass.material)
  ground.name = 'ground'
  root.add(ground)
  box(m.paving, [0, 0.02, -3.5], [30, 0.04, 31])
  box(m.path, [0, 0.03, 16.6], [3.2, 0.04, 10.2])
  box(m.path, [0, 0.035, -4], [3.2, 0.04, 4.6])

  // 主殿：台基、階梯、殿身、門窗、柱、樑、重簷屋頂
  const hallCx = (HALL.minX + HALL.maxX) / 2
  const hallCz = -13 // 台基 z 範圍 -18..-8
  const base = 0.8
  box(m.stone, [hallCx, base / 2, hallCz], [15, base, 10])
  ;[0.6, 0.4, 0.2].forEach((h, i) => box(m.stone, [0, h / 2, -7.7 + i * 0.6], [6, h, 0.6]))
  box(m.plaster, [hallCx, base + 1.5, hallCz], [11.4, 3, 7.4])
  box(m.woodDark, [0, base + 1.2, hallCz + 3.72], [3.2, 2.4, 0.06])
  for (const x of [-2.7, 2.7]) box(m.woodDark, [x, base + 1.75, hallCz + 3.72], [1.8, 1.3, 0.06])
  // 匾額：深色木框加上寫有殿名的貼圖
  // 前排柱子在 x=±1.4（半徑 0.21），匾額寬度需小於 2.38 才不被遮住。
  box(m.woodDark, [0, base + 2.72, hallCz + 3.74], [2.36, 0.5, 0.06])
  place(new THREE.Mesh(geo(new THREE.PlaneGeometry(2.24, 0.38)), m.plaque.material), [0, base + 2.72, hallCz + 3.78])

  const pillarH = 3.2
  const pillars: Array<{ pos: V3; scale: V3 }> = []
  for (const x of [-6.6, -4, -1.4, 1.4, 4, 6.6]) {
    pillars.push({ pos: [x, base + pillarH / 2, -8.6], scale: [0.42, pillarH, 0.42] })
    pillars.push({ pos: [x, base + pillarH / 2, -17.4], scale: [0.42, pillarH, 0.42] })
  }
  for (const z of [-11.5, -14.5]) {
    pillars.push({ pos: [-6.6, base + pillarH / 2, z], scale: [0.42, pillarH, 0.42] })
    pillars.push({ pos: [6.6, base + pillarH / 2, z], scale: [0.42, pillarH, 0.42] })
  }
  // 鐘亭柱
  const bx = (BELL_PAVILION.minX + BELL_PAVILION.maxX) / 2
  const bz = (BELL_PAVILION.minZ + BELL_PAVILION.maxZ) / 2
  const pavBase = 0.35
  const pavH = 2.6
  for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]] as const) {
    pillars.push({ pos: [bx + dx, pavBase + pavH / 2, bz + dz], scale: [0.3, pavH, 0.3] })
  }
  many(cylinder, m.lacquer, pillars)

  const beamY = base + pillarH
  box(m.woodDark, [hallCx, beamY + 0.2, hallCz], [14, 0.4, 9.6])
  roof([hallCx, beamY + 0.4, hallCz], 17.5, 12.4, 2, 7.7, 3.8, 0.9)
  box(m.plaster, [hallCx, beamY + 2.6, hallCz], [7.5, 0.9, 3.6])
  roof([hallCx, beamY + 3.05, hallCz], 9.8, 6, 1.7, 5.2, 0, 0.6)
  box(m.roof, [hallCx, beamY + 4.8, hallCz], [5.4, 0.22, 0.3])
  const finialGeo = geo(new THREE.OctahedronGeometry(0.28, 1))
  finialGeo.userData.lightmap = 'uniform' // 屋脊上的小飾物，整個用同一個烘焙值
  add(finialGeo, m.gold, [hallCx - 2.7, beamY + 5.05, hallCz], [1, 1.6, 1])
  add(finialGeo, m.gold, [hallCx + 2.7, beamY + 5.05, hallCz], [1, 1.6, 1])

  // 鐘亭
  box(m.stone, [bx, pavBase / 2, bz], [4.3, pavBase, 4.3])
  box(m.woodDark, [bx, pavBase + pavH + 0.12, bz], [3.8, 0.24, 3.8])
  roof([bx, pavBase + pavH + 0.24, bz], 5.4, 5.4, 1.7, 0, 0, 0.5)
  add(finialGeo, m.gold, [bx, pavBase + pavH + 2.0, bz], [0.8, 1.2, 0.8])
  const bellPivot = new THREE.Group()
  bellPivot.position.set(bx, pavBase + pavH, bz)
  root.add(bellPivot)
  const bellProfile = [
    [0, -1.25], [0.62, -1.25], [0.58, -1.05], [0.48, -0.6], [0.44, -0.2], [0.4, -0.05], [0, 0],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  // 鐘擺動時烘焙值跟著鐘走（以靜止姿態烘焙，擺幅小）
  const bell = new THREE.Mesh(geo(new THREE.LatheGeometry(bellProfile, 32)), m.bronze.material)
  bell.position.y = -0.15
  bellPivot.add(bell)

  // 香爐與香
  box(m.stone, [CENSER.x, 0.15, CENSER.z], [1.7, 0.3, 1.7])
  const censerProfile = [
    [0, 0], [0.35, 0], [0.3, 0.25], [0.7, 0.45], [0.78, 0.85], [0.72, 0.9], [0.6, 0.62], [0, 0.6],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  place(new THREE.Mesh(geo(new THREE.LatheGeometry(censerProfile, 32)), m.bronze.material), [CENSER.x, 0.3, CENSER.z])
  many(
    cylinder,
    m.lacquer,
    [-0.12, 0, 0.12].map((dx, i) => ({ pos: [CENSER.x + dx, 1.45, CENSER.z + (i - 1) * 0.04] as V3, scale: [0.03, 0.9, 0.03] as V3 })),
  )

  // 石燈籠
  for (const l of LANTERNS) {
    box(m.stone, [l.x, 0.15, l.z], [0.7, 0.3, 0.7])
    box(m.stone, [l.x, 0.7, l.z], [0.25, 0.8, 0.25])
    box(m.lantern, [l.x, 1.3, l.z], [0.45, 0.4, 0.45])
    add(pyramid, m.stone, [l.x, 1.5, l.z], [0.9, 0.45, 0.9])
  }

  // 圍牆：石基、紅牆、瓦頂；正面留山門缺口。離可走範圍約 3 公尺，鏡頭在牆外時不會擋住角色。
  const WALL = { x: 22.5, back: -22, front: 21.5, gate: 2.6 }
  const wall = (cx: number, cz: number, lenX: number, lenZ: number) => {
    box(m.stone, [cx, 0.15, cz], [lenX + 0.12, 0.3, lenZ + 0.12])
    box(m.plaster, [cx, 0.9, cz], [lenX, 1.2, lenZ])
    box(m.roof, [cx, 1.6, cz], [lenX + 0.4, 0.2, lenZ + 0.4])
  }
  const wallDepth = WALL.front - WALL.back
  const wallMidZ = (WALL.front + WALL.back) / 2
  wall(-WALL.x, wallMidZ, 0.5, wallDepth)
  wall(WALL.x, wallMidZ, 0.5, wallDepth)
  wall(0, WALL.back, WALL.x * 2, 0.5)
  for (const side of [-1, 1]) {
    const len = WALL.x - WALL.gate
    wall(side * (WALL.gate + len / 2), WALL.front, len, 0.5)
    box(m.stone, [side * WALL.gate, 1.2, WALL.front], [0.8, 2.4, 0.8])
    add(pyramid, m.roof, [side * WALL.gate, 2.4, WALL.front], [1.3, 0.5, 1.3])
  }

  // 樹：樹幹靜態；樹冠隨風輕晃，以靜止姿態把影子烘進地面
  many(
    cylinder,
    m.bark,
    TREES.map((t) => ({ pos: [t.x, 1.1 * t.scale, t.z] as V3, scale: [0.35 * t.scale, 2.2 * t.scale, 0.35 * t.scale] as V3 })),
  )
  const canopyItems = TREES.flatMap((t, i) => [
    { pos: [t.x, 3 * t.scale, t.z] as V3, scale: [1.9 * t.scale, 1.6 * t.scale, 1.9 * t.scale] as V3, rotY: i, color: PALETTE.leafA },
    { pos: [t.x + 0.3, 4.1 * t.scale, t.z - 0.2] as V3, scale: [1.3 * t.scale, 1.2 * t.scale, 1.3 * t.scale] as V3, rotY: i * 2, color: PALETTE.leafB },
  ])
  const canopyMesh = instanced(geo(canopyGeometry()), m.canopy.material, canopyItems)

  // 落葉：一個 InstancedMesh，位置是時間的純函式（不保存狀態）。不參與烘焙。
  const LEAF_COUNT = 28
  const leaves = new THREE.InstancedMesh(
    geo(new THREE.PlaneGeometry(0.2, 0.11)),
    std({ color: '#ffffff', roughness: 0.9, side: THREE.DoubleSide }),
    LEAF_COUNT,
  )
  for (let i = 0; i < LEAF_COUNT; i++) leaves.setColorAt(i, new THREE.Color(i % 3 ? PALETTE.leafGold : '#7da355'))
  leaves.frustumCulled = false // 葉子散布整個庭院，不值得每幀重算包圍球
  root.add(leaves)

  // 晾在竹竿上的僧袍（在可走範圍外，不需要碰撞）
  const LINE = { x: -20.6, z0: -1, z1: 3.4 }
  many(
    cylinder,
    m.bark,
    [LINE.z0, LINE.z1].map((z) => ({ pos: [LINE.x, 1, z] as V3, scale: [0.09, 2, 0.09] as V3 })),
  )
  box(m.woodDark, [LINE.x, 1.85, (LINE.z0 + LINE.z1) / 2], [0.05, 0.05, LINE.z1 - LINE.z0 + 0.4])
  const robeGeo = geo(new THREE.BoxGeometry(0.04, 1.15, 1))
  robeGeo.translate(0, -0.575, 0) // 以上緣為軸擺動
  const robeItems = [
    { z: -0.2, color: '#d9892b' },
    { z: 1.2, color: '#8a8d92' },
    { z: 2.6, color: '#c96a2a' },
  ].map((r) => ({ pos: [LINE.x, 1.83, r.z] as V3, scale: [1, 1, 1] as V3, color: r.color }))
  const robeMesh = instanced(robeGeo, m.cloth.material, robeItems)

  // 遠山（融入霧中）：不投影、不受影、不參與烘焙
  const mountainMesh = instanced(
    geo(new THREE.ConeGeometry(1, 1, 7, 1)),
    m.mountain.material,
    [
      { x: -55, z: -70, r: 30, h: 28 },
      { x: -10, z: -85, r: 40, h: 38 },
      { x: 40, z: -72, r: 32, h: 30 },
      { x: 75, z: -40, r: 26, h: 22 },
      { x: -80, z: -30, r: 28, h: 24 },
    ].map((mt, i) => ({
      pos: [mt.x, mt.h / 2, mt.z] as V3,
      scale: [mt.r, mt.h, mt.r] as V3,
      rotY: i,
      color: i % 2 ? PALETTE.mountainA : PALETTE.mountainB,
    })),
  )

  // 烘焙貼圖的 uv1，接著靜態方塊依材質合併，減少 draw call。
  const groundMaterials = new Set<THREE.Material>(GROUND_SURFACES.map((k) => m[k].material))
  const atlas = prepareLightmapUvs(root, groundMaterials, tracker)
  mergeStatic(root, tracker, (o) => o === ground || o === bellPivot)
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.receiveShadow = true
  })
  mountainMesh.receiveShadow = false
  const bake = collectBakeSetup(root, groundMaterials, atlas, [canopyMesh, robeMesh], [ground, mountainMesh, leaves])

  return { root, ground, bellPivot, canopyMesh, canopyItems, leaves, robeMesh, robeItems, bake }
}

/** 以素色材質建構庭院（不載入貼圖），供烘焙匯出腳本與測試使用。 */
export function buildPlainCourtyard(tracker: ResourceTracker): Courtyard {
  const surfaces = Object.fromEntries(
    Object.entries(SURFACE_SPECS).map(([key, spec]) => [
      key,
      {
        material: tracker.trackMaterial(new THREE.MeshStandardMaterial({ color: 'tex' in spec ? spec.tex.fallback : spec.color, ...spec.params })),
        tile: 'tex' in spec ? spec.tex.tile : 1,
      },
    ]),
  ) as Record<keyof typeof SURFACE_SPECS, Surface>
  const plaque: Surface = { material: tracker.trackMaterial(new THREE.MeshStandardMaterial()), tile: 1 }
  return buildCourtyard({ ...surfaces, plaque }, tracker)
}

export interface TempleScene {
  root: THREE.Group
  /** 可點擊行走的地面，供射線檢測使用。 */
  walkSurface: THREE.Object3D
  /** 環境動畫（燈籠、香煙、樹冠、落葉、晾衣、鐘擺）。t 為秒。 */
  update(t: number, dt: number): void
  /** 觸發鐘的擺動。 */
  swingBell(): void
  /** 是否有需要持續重繪的短暫動態（例如鐘擺尚未停止）。 */
  hasTransientMotion(): boolean
}

/**
 * 建立庭院。貼圖解析度與細節貼圖依建立當下的畫質決定（之後切換畫質於下次載入生效）。
 * onChange 在貼圖載入完成時呼叫，讓依需求繪製的迴圈重繪。
 *
 * 靜態物件的陰影與環境光遮蔽來自事先烘焙的貼圖（`courtyardBake.ts`）；烘焙貼圖套上之後不再進即時陰影貼圖。
 * 烘焙貼圖載入前、載入失敗或與目前幾何不符時，靜態物件照舊投射即時陰影（只有開啟陰影貼圖的畫質看得到）。
 */
export function buildTempleScene(
  renderer: THREE.WebGLRenderer,
  tracker: ResourceTracker,
  preset: QualityPreset,
  onChange: () => void,
): TempleScene {
  const std = (params: THREE.MeshStandardMaterialParameters) => tracker.trackMaterial(new THREE.MeshStandardMaterial(params))
  const flat = (color: string, params: THREE.MeshStandardMaterialParameters = {}): Surface => ({
    material: std({ color, roughness: 0.85, ...params }),
    tile: 1,
  })

  // KTX2（BasisLZ）：手機轉成 ASTC／ETC2、桌面轉成 BC，GPU 記憶體約為未壓縮的 1/4～1/8，
  // 也省掉主執行緒解 JPEG 與產生 mipmap。轉碼 worker 在全部貼圖載入後釋放。
  const loader = tracker.track(new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).detectSupport(renderer))
  let pending = 0
  const settle = () => {
    if (--pending === 0) loader.dispose()
  }
  const res = preset.textureSize === 1024 ? '1k' : '512'
  const anisotropy = preset.textureSize === 1024 ? 8 : 2
  /** 同一張貼圖只載入與上傳一次，多個材質共用（建立材質都在任何貼圖載入完成之前）。 */
  const textures = new Map<string, Array<(t: THREE.Texture) => void>>()
  const loadShared = (url: string, setup: (t: THREE.Texture) => void, onFail: () => void = () => {}) => {
    let waiting = textures.get(url)
    if (!waiting) {
      const list: Array<(t: THREE.Texture) => void> = []
      textures.set(url, (waiting = list))
      pending++
      loader.load(
        url,
        (tex) => {
          settle()
          tracker.track(tex)
          setup(tex)
          list.forEach((f) => f(tex))
          onChange()
        },
        undefined,
        (err) => {
          settle()
          console.warn('貼圖載入失敗', url, err)
          onFail()
        },
      )
    }
    return waiting
  }
  /** 寫實材質。貼圖載入前先用 fallback 底色，載入後才套上，避免畫面先變黑；載入失敗就維持底色。 */
  const pbr = (def: TexDef, tint = '#ffffff', params: THREE.MeshStandardMaterialParameters = {}): Surface => {
    const material = std({ color: def.fallback, roughness: 0.9, ...params })
    const load = (kind: string, apply: (t: THREE.Texture) => void) => {
      const waiting = loadShared(`${import.meta.env.BASE_URL}textures/${def.id}_${kind}_${res}.ktx2`, (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        tex.anisotropy = anisotropy
        // 色彩空間由 KTX2 檔頭決定（底色為 sRGB，法線與粗糙度為線性）。
      })
      waiting.push((t) => {
        apply(t)
        material.needsUpdate = true
      })
    }
    load('diff', (t) => {
      material.map = t
      material.color.set(tint)
    })
    load('nor', (t) => (material.normalMap = t))
    if (preset.detailMaps >= 2) {
      load('rough', (t) => {
        material.roughnessMap = t
        material.roughness = 1
      })
    }
    return { material, tile: def.tile }
  }

  const specs = SURFACE_SPECS
  const m = Object.fromEntries(
    Object.entries(specs).map(([key, spec]) => [key, 'tex' in spec ? pbr(spec.tex, spec.tint, spec.params) : flat(spec.color, spec.params)]),
  ) as Record<keyof typeof specs, Surface>
  const plaque: Surface = { material: std({ map: tracker.track(plaqueTexture(TEMPLE_NAME)), roughness: 0.7 }), tile: 1 }
  const court = buildCourtyard({ ...m, plaque }, tracker)
  const { root, ground, bellPivot, canopyMesh, canopyItems, leaves, robeMesh, robeItems, bake } = court

  // 烘焙貼圖：兩張（圖集、地面）都套上之後，靜態物件才停止投射即時陰影。
  for (const o of bake.casters) o.castShadow = true
  for (const mat of [...bake.atlasMaterials, ...bake.groundMaterials]) mat.onBeforeCompile = patchBakedSun
  // 開發模式才比對指紋：不符時退回即時陰影並警告（提醒重新烘焙）。正式版不計算指紋、直接載入——
  // 一致性由 courtyardBake.test.ts 在 CI 保證，而不同 JS 引擎的浮點末位差異可能讓指紋不同，
  // 那時退回反而讓手機（標準畫質沒有陰影貼圖）整個庭院沒有影子。
  const stale = import.meta.env.DEV && bake.fingerprint() !== BAKED_FINGERPRINT
  if (stale) {
    console.warn('庭院烘焙貼圖與目前幾何不符，改用即時陰影。請執行 npm run bake:lightmaps', BAKED_FINGERPRINT)
  } else {
    let applied = 0
    const lightmap = (kind: 'atlas' | 'ground', materials: ReadonlySet<THREE.Material>) => {
      loadShared(lightmapUrl(kind, preset.textureSize), (tex) => {
        tex.channel = 1 // 取 uv1
      }).push((t) => {
        for (const mat of materials) {
          ;(mat as THREE.MeshStandardMaterial).aoMap = t
          mat.needsUpdate = true
        }
        if (++applied === 2) for (const o of bake.casters) o.castShadow = false
      })
    }
    lightmap('atlas', bake.atlasMaterials)
    lightmap('ground', bake.groundMaterials)
  }

  const smokeTex = tracker.track(softCircleTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)'))
  const smoke: Array<{ sprite: THREE.Sprite; material: THREE.SpriteMaterial; phase: number }> = []
  for (let i = 0; i < 5; i++) {
    const material = tracker.track(
      new THREE.SpriteMaterial({ map: smokeTex, color: '#eef0f2', transparent: true, depthWrite: false, opacity: 0 }),
    )
    const sprite = new THREE.Sprite(material)
    root.add(sprite)
    smoke.push({ sprite, material, phase: i / 5 })
  }

  const tmp = new THREE.Object3D()
  const LEAF_COUNT = leaves.count

  // 鐘擺：阻尼簡諧運動
  let bellAngle = 0
  let bellVel = 0

  return {
    root,
    walkSurface: ground,
    update(t, dt) {
      m.lantern.material.emissiveIntensity = 0.85 + Math.sin(t * 7.3) * 0.05 + Math.sin(t * 3.1) * 0.05
      for (const s of smoke) {
        const p = (t * 0.12 + s.phase) % 1
        s.sprite.position.set(CENSER.x + Math.sin(t * 0.6 + s.phase * 6) * 0.25 * p, 1.9 + p * 2.6, CENSER.z)
        const size = 0.35 + p * 1.1
        s.sprite.scale.set(size, size, 1)
        s.material.opacity = Math.sin(p * Math.PI) * 0.35
      }
      // 樹冠隨風輕晃
      canopyItems.forEach((it, i) => {
        const sway = Math.sin(t * 0.9 + i * 1.7) * 0.035
        tmp.position.set(it.pos[0] + sway * 2, it.pos[1], it.pos[2])
        tmp.scale.set(...it.scale)
        tmp.rotation.set(sway, it.rotY, sway * 0.6)
        tmp.updateMatrix()
        canopyMesh.setMatrixAt(i, tmp.matrix)
      })
      canopyMesh.instanceMatrix.needsUpdate = true
      for (let i = 0; i < LEAF_COUNT; i++) {
        const tree = TREES[i % TREES.length]!
        const p = (t * (0.04 + (i % 5) * 0.004) + i * 0.618) % 1
        tmp.position.set(
          tree.x - p * 2.4 + Math.sin(t * 1.3 + i) * 0.35 + Math.sin(i * 12.9) * 1.2,
          3.2 * tree.scale * (1 - p) + 0.08,
          tree.z - p * 1.8 + Math.cos(t * 1.1 + i * 2) * 0.35 + Math.cos(i * 7.3) * 1.2,
        )
        tmp.rotation.set(t * 1.7 + i, t * 0.9 + i * 2, Math.sin(t * 2.1 + i) * 0.8)
        tmp.scale.setScalar(Math.min(1, p * 12, (1 - p) * 12)) // 出現與落地時縮放淡入淡出
        tmp.updateMatrix()
        leaves.setMatrixAt(i, tmp.matrix)
      }
      leaves.instanceMatrix.needsUpdate = true
      robeItems.forEach((it, i) => {
        tmp.position.set(...it.pos)
        tmp.scale.set(1, 1, 1)
        tmp.rotation.set(0, 0, Math.sin(t * 1.1 + i * 1.9) * 0.07)
        tmp.updateMatrix()
        robeMesh.setMatrixAt(i, tmp.matrix)
      })
      robeMesh.instanceMatrix.needsUpdate = true
      if (bellAngle !== 0 || bellVel !== 0) {
        const k = 18
        const damping = 1.6
        bellVel += (-k * bellAngle - damping * bellVel) * dt
        bellAngle += bellVel * dt
        if (Math.abs(bellAngle) < 0.0005 && Math.abs(bellVel) < 0.002) bellAngle = bellVel = 0
        bellPivot.rotation.x = bellAngle
      }
    },
    swingBell() {
      bellVel += 1.2
    },
    hasTransientMotion() {
      return bellAngle !== 0 || bellVel !== 0
    },
  }
}
