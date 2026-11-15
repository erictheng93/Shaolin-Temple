import * as THREE from 'three'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import type { ResourceTracker } from './ResourceTracker'

/**
 * 殿內三尊神像。正式造型是寫實模型（loadStatueModel()，素材來源見 docs/ASSETS.md），
 * 模型下載完成前（或載入失敗時）顯示這裡的程序化造型：佛與觀音是風格化的低多邊形造型，
 * 媽祖沒有程序化造型，以紅布覆蓋的神座佔位（buildVeiledPlaceholder），不會被誤認為其他神明。
 *
 * 每尊為一個 Group：原點在台座底面中心、面向 +z（面向參拜者）、單位公尺。
 * 方向：神像面向 +z，神像自身的左手在 +x、右手在 -x。
 */

export type StatueId = 'buddha' | 'guanyin' | 'mazu'

/** 寫實模型的層級：std 給標準畫質（手機），hi 給高畫質。 */
export type StatueTier = 'std' | 'hi'

/**
 * 每尊寫實模型的總高（公尺，含台座與背光；媽祖含椅子與底座），模型依此等比縮放。
 * 程序化的替代造型沿用原本的比例，不受此值影響。
 */
export const STATUE_HEIGHT: Record<StatueId, number> = { buddha: 3.8, guanyin: 2.7, mazu: 2.8 }

type V3 = [number, number, number]

interface Kit {
  tracker: ResourceTracker
  mat: Record<string, THREE.Material>
  geo: {
    sphere: THREE.BufferGeometry
    hiSphere: THREE.BufferGeometry
    box: THREE.BufferGeometry
    cyl: THREE.BufferGeometry
    petal: THREE.BufferGeometry
    /** 細弧線（眉、眼、唇）：半圓管，y 取負值時開口朝上。 */
    brow: THREE.BufferGeometry
  }
}

/** 建立神像共用的材質與基本幾何（由呼叫端的 tracker 擁有）。 */
export function createStatueKit(tracker: ResourceTracker): Kit {
  const phong = (color: string, shininess = 40, specular = '#3a3020', extra: THREE.MeshPhongMaterialParameters = {}) =>
    tracker.trackMaterial(new THREE.MeshPhongMaterial({ color, shininess, specular, flatShading: false, ...extra }))
  const lambert = (color: string) => tracker.trackMaterial(new THREE.MeshLambertMaterial({ color }))
  return {
    tracker,
    mat: {
      // 金箔質感：高光柔和、範圍較大，避免塑膠般的亮斑
      gold: phong('#c9a043', 28, '#7a6434'),
      goldDeep: phong('#a07a2c', 22, '#5e4c26'),
      // 五官線條：比金身暗，近看才看得出輪廓
      feature: phong('#6e5020', 10, '#2a2010'),
      featureSkin: phong('#6b4636', 10, '#2a1a10'),
      hair: phong('#27324a', 20, '#334'),
      lotus: phong('#d6a64e', 60, '#ffe7b0'),
      white: phong('#f1ede4', 25, '#444'),
      skin: phong('#efd6bc', 20, '#332a20'),
      porcelain: phong('#e9f1f2', 80, '#ffffff'),
      willow: lambert('#6f9a52'),
      // 佔位用：覆蓋神像的紅布與深色漆木神座
      veil: phong('#9e2219', 8, '#2a1010'),
      lacquer: phong('#3a1a12', 40, '#443322'),
    },
    geo: {
      sphere: tracker.track(new THREE.SphereGeometry(1, 16, 12)),
      hiSphere: tracker.track(new THREE.SphereGeometry(1, 24, 18)),
      box: tracker.track(new THREE.BoxGeometry(1, 1, 1)),
      cyl: tracker.track(new THREE.CylinderGeometry(1, 1, 1, 16)),
      petal: tracker.track(petalGeometry()),
      brow: tracker.track(new THREE.TorusGeometry(1, 0.28, 5, 14, Math.PI)),
    },
  }
}

/** 蓮瓣：底部窄、尖端上翹的扁橢圓。 */
function petalGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 10, 8)
  g.scale(0.5, 0.18, 1)
  const pos = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    // 外緣（+z）往上翹、往外變尖
    pos.setY(i, pos.getY(i) + Math.max(0, z) ** 2 * 0.35)
    pos.setX(i, pos.getX(i) * (1 - Math.max(0, z) * 0.45))
  }
  g.computeVertexNormals()
  return g
}

function part(parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, pos: V3, scale: V3, rot: V3 = [0, 0, 0]): THREE.Mesh {
  const mesh = new THREE.Mesh(g, m)
  mesh.position.set(...pos)
  mesh.scale.set(...scale)
  mesh.rotation.set(...rot)
  parent.add(mesh)
  return mesh
}

function lathe(kit: Kit, points: Array<[number, number]>, segments = 20): THREE.BufferGeometry {
  return kit.tracker.track(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments))
}

/** 蓮花座：鼓形底座加兩圈蓮瓣。 */
function lotusThrone(kit: Kit, parent: THREE.Object3D, radius: number, y = 0): number {
  const { geo, mat } = kit
  part(parent, geo.cyl, mat.goldDeep!, [0, y + 0.12 * radius, 0], [radius * 1.05, 0.24 * radius, radius * 1.05])
  part(parent, geo.cyl, mat.gold!, [0, y + 0.3 * radius, 0], [radius * 0.82, 0.14 * radius, radius * 0.82])
  const rings: Array<{ n: number; r: number; y: number; tilt: number; s: number; offset: number }> = [
    { n: 16, r: radius * 0.86, y: y + 0.36 * radius, tilt: 0.55, s: radius * 0.34, offset: 0 },
    { n: 16, r: radius * 0.7, y: y + 0.5 * radius, tilt: 0.9, s: radius * 0.3, offset: Math.PI / 16 },
  ]
  const tmp = new THREE.Object3D()
  for (const ring of rings) {
    const inst = new THREE.InstancedMesh(geo.petal, mat.lotus!, ring.n)
    for (let i = 0; i < ring.n; i++) {
      const a = (i / ring.n) * Math.PI * 2 + ring.offset
      tmp.position.set(Math.sin(a) * ring.r, ring.y, Math.cos(a) * ring.r)
      tmp.rotation.set(0, 0, 0)
      tmp.rotateY(a)
      tmp.rotateX(-ring.tilt)
      tmp.scale.setScalar(ring.s)
      tmp.updateMatrix()
      inst.setMatrixAt(i, tmp.matrix)
    }
    inst.computeBoundingSphere()
    parent.add(inst)
  }
  return y + 0.58 * radius
}

/** 背光：身光（尖拱形）加頭光（圓環）。 */
function mandorla(kit: Kit, parent: THREE.Object3D, opts: { bodyW: number; bodyH: number; bodyY: number; headY: number; headR: number; z: number }) {
  const shape = new THREE.Shape()
  const w = opts.bodyW / 2
  const h = opts.bodyH
  shape.moveTo(-w, 0)
  shape.lineTo(-w, h * 0.55)
  shape.quadraticCurveTo(-w, h * 0.92, 0, h)
  shape.quadraticCurveTo(w, h * 0.92, w, h * 0.55)
  shape.lineTo(w, 0)
  shape.lineTo(-w, 0)
  const body = kit.tracker.track(new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false, curveSegments: 16 }))
  part(parent, body, kit.mat.goldDeep!, [0, opts.bodyY, opts.z], [1, 1, 1])
  // 內層較亮的一圈
  part(parent, body, kit.mat.gold!, [0, opts.bodyY + h * 0.06, opts.z + 0.04], [0.86, 0.9, 0.5])
  const ring = kit.tracker.track(new THREE.TorusGeometry(opts.headR, opts.headR * 0.08, 8, 40))
  part(parent, ring, kit.mat.gold!, [0, opts.headY, opts.z + 0.1], [1, 1, 1])
  const disc = kit.tracker.track(new THREE.CircleGeometry(opts.headR * 0.92, 40))
  part(parent, disc, kit.mat.goldDeep!, [0, opts.headY, opts.z + 0.09], [1, 1, 1])
}

/**
 * 慈悲寧靜的面相：彎眉、低垂半閉的雙眼、鼻樑、微笑的嘴唇，可選白毫。
 * 五官依頭部橢球（中心 (0, headY, cz)、半徑 r）計算表面位置貼合臉部；比例以佛像頭部（半寬 0.27）為基準縮放。
 */
function serenFace(
  g: THREE.Object3D,
  kit: Kit,
  headY: number,
  r: { x: number; y: number; z: number },
  cz: number,
  opts: { line: THREE.Material; nose: THREE.Material; urna: boolean },
) {
  const k = r.x / 0.27
  const faceZ = (x: number, y: number) => cz + r.z * Math.sqrt(Math.max(0, 1 - (x / r.x) ** 2 - (y / r.y) ** 2))
  const turn = (x: number) => Math.asin(Math.min(1, x / r.x)) // 依曲面轉向，線條貼合臉頰
  const at = (x: number, y: number, inset: number): V3 => [x * k, headY + y * k, faceZ(x * k, y * k) - inset * k]
  if (opts.urna) part(g, kit.geo.sphere, opts.line, at(0, 0.07, 0), [0.016 * k, 0.016 * k, 0.008 * k])
  for (const side of [-1, 1]) {
    part(g, kit.geo.brow, opts.line, at(side * 0.092, 0.035, 0.004), [0.06 * k, 0.022 * k, 0.02 * k], [0, turn(side * 0.092 * k), 0])
    part(g, kit.geo.brow, opts.line, at(side * 0.088, -0.012, 0.003), [0.048 * k, -0.012 * k, 0.016 * k], [0, turn(side * 0.088 * k), 0])
  }
  part(g, kit.geo.sphere, opts.nose, at(0, -0.055, 0.012), [0.028 * k, 0.06 * k, 0.03 * k])
  part(g, kit.geo.brow, opts.line, at(0, -0.14, 0.004), [0.042 * k, -0.01 * k, 0.016 * k])
}

/**
 * 釋迦牟尼佛：結跏趺坐於蓮花座，雙手禪定印，螺髮、肉髻、長耳垂，金身，背後有身光與頭光。
 */
export function buildBuddha(kit: Kit): THREE.Group {
  const g = new THREE.Group()
  g.name = 'statue:buddha'
  const { geo, mat } = kit
  const seat = lotusThrone(kit, g, 1.15)

  // 盤坐的雙腿（衣襬覆蓋）
  part(g, geo.hiSphere, mat.gold!, [0, seat + 0.2, 0.12], [0.98, 0.3, 0.66])
  // 腳掌（右足在上）
  part(g, geo.sphere, mat.gold!, [-0.32, seat + 0.42, 0.42], [0.2, 0.08, 0.12], [0, 0.4, 0])
  // 身軀：袈裟
  const torso = lathe(kit, [[0, 0], [0.56, 0], [0.6, 0.25], [0.52, 0.62], [0.6, 0.9], [0.52, 1.06], [0.24, 1.14], [0, 1.15]])
  part(g, torso, mat.gold!, [0, seat + 0.25, 0], [1, 1, 0.72])
  // 袈裟斜披左肩的衣紋
  part(g, geo.box, mat.goldDeep!, [0.12, seat + 0.95, 0.38], [0.12, 0.95, 0.06], [0, 0, -0.55])
  // 上臂與前臂
  for (const side of [-1, 1]) {
    part(g, geo.sphere, mat.gold!, [side * 0.58, seat + 0.95, 0.05], [0.17, 0.42, 0.18], [0, 0, side * 0.18])
    part(g, geo.sphere, mat.gold!, [side * 0.34, seat + 0.58, 0.32], [0.14, 0.13, 0.36], [0, side * -0.5, 0])
  }
  // 禪定印：雙手疊放於腹前
  part(g, geo.sphere, mat.gold!, [0, seat + 0.55, 0.42], [0.26, 0.08, 0.16])
  // 頸
  part(g, geo.cyl, mat.gold!, [0, seat + 1.43, 0], [0.13, 0.16, 0.13])
  // 頭與面
  const headY = seat + 1.72
  part(g, geo.hiSphere, mat.gold!, [0, headY, 0.02], [0.27, 0.31, 0.27])
  // 螺髮與肉髻
  const hairCap = kit.tracker.track(new THREE.SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI * 0.42))
  part(g, hairCap, mat.hair!, [0, headY + 0.02, -0.01], [0.285, 0.32, 0.285], [-0.18, 0, 0])
  const curls = kit.tracker.track(new THREE.IcosahedronGeometry(1, 1))
  part(g, curls, mat.hair!, [0, headY + 0.33, -0.03], [0.14, 0.13, 0.14])
  // 長耳垂
  for (const side of [-1, 1]) part(g, geo.sphere, mat.gold!, [side * 0.27, headY - 0.06, 0], [0.04, 0.17, 0.08])
  serenFace(g, kit, headY, { x: 0.27, y: 0.31, z: 0.27 }, 0.02, { line: mat.feature!, nose: mat.gold!, urna: true })

  mandorla(kit, g, { bodyW: 2.1, bodyH: 2.75, bodyY: seat - 0.25, headY, headR: 0.5, z: -0.55 })
  return g
}

/**
 * 觀世音菩薩：立於蓮花座，白衣與披巾，寶冠，左手持淨瓶、右手持楊柳枝，頭後有頭光。
 */
export function buildGuanyin(kit: Kit): THREE.Group {
  const g = new THREE.Group()
  g.name = 'statue:guanyin'
  const { geo, mat } = kit
  const base = lotusThrone(kit, g, 0.62)

  // 長袍：下襬寬、腰身收、肩部圓
  const robe = lathe(kit, [[0, 0], [0.5, 0], [0.44, 0.15], [0.33, 0.8], [0.27, 1.15], [0.3, 1.45], [0.33, 1.68], [0.22, 1.78], [0.09, 1.82], [0, 1.83]], 24)
  part(g, robe, mat.white!, [0, base, 0], [1, 1, 0.78])
  // 腰帶與瓔珞
  part(g, geo.cyl, mat.gold!, [0, base + 1.12, 0], [0.285, 0.05, 0.225])
  part(g, kit.tracker.track(new THREE.TorusGeometry(0.2, 0.018, 6, 24, Math.PI)), mat.gold!, [0, base + 1.58, 0.2], [1, 1.1, 1], [0, 0, Math.PI])
  // 披巾（頭後垂至肩）
  const veil = lathe(kit, [[0, 0.62], [0.2, 0.55], [0.28, 0.3], [0.34, 0], [0.36, -0.1]], 20)
  const headY = base + 2.04
  part(g, veil, mat.white!, [0, headY - 0.36, -0.04], [1, 1, 0.85])
  // 頸、頭
  part(g, geo.cyl, mat.skin!, [0, base + 1.86, 0], [0.07, 0.1, 0.07])
  part(g, geo.hiSphere, mat.skin!, [0, headY, 0.02], [0.17, 0.205, 0.175])
  // 髮髻與寶冠（冠上化佛以金色小圓表示）
  part(g, geo.sphere, mat.hair!, [0, headY + 0.17, -0.03], [0.12, 0.12, 0.12])
  part(g, geo.cyl, mat.gold!, [0, headY + 0.2, 0], [0.18, 0.07, 0.18])
  part(g, geo.sphere, mat.gold!, [0, headY + 0.29, 0.15], [0.05, 0.065, 0.025])
  serenFace(g, kit, headY, { x: 0.17, y: 0.205, z: 0.175 }, 0.02, { line: mat.featureSkin!, nose: mat.skin!, urna: true })

  // 左手（+x）於胸前持淨瓶
  part(g, geo.sphere, mat.white!, [0.3, base + 1.4, 0.05], [0.09, 0.3, 0.1], [0, 0, 0.15])
  part(g, geo.sphere, mat.white!, [0.22, base + 1.22, 0.2], [0.07, 0.07, 0.22], [0.2, 0.4, 0])
  part(g, geo.sphere, mat.skin!, [0.15, base + 1.24, 0.38], [0.05, 0.06, 0.05])
  const vase = lathe(kit, [[0, 0], [0.04, 0], [0.065, 0.06], [0.07, 0.12], [0.035, 0.2], [0.018, 0.27], [0.03, 0.3], [0, 0.3]], 14)
  part(g, vase, mat.porcelain!, [0.15, base + 1.18, 0.4], [1, 1, 1])
  // 右手（-x）舉楊柳枝
  part(g, geo.sphere, mat.white!, [-0.3, base + 1.4, 0.05], [0.09, 0.3, 0.1], [0, 0, -0.15])
  part(g, geo.sphere, mat.white!, [-0.27, base + 1.42, 0.22], [0.07, 0.22, 0.07], [0.6, 0, 0])
  part(g, geo.sphere, mat.skin!, [-0.27, base + 1.58, 0.33], [0.05, 0.06, 0.05])
  part(g, geo.cyl, mat.willow!, [-0.27, base + 1.78, 0.36], [0.007, 0.42, 0.007], [0.15, 0, 0.1])
  const leaves = new THREE.InstancedMesh(geo.sphere, mat.willow!, 10)
  const tmp = new THREE.Object3D()
  for (let i = 0; i < 10; i++) {
    const t = i / 9
    tmp.position.set(-0.27 + Math.sin(i * 1.7) * 0.05, base + 1.95 - t * 0.28, 0.38 + Math.cos(i * 1.7) * 0.05)
    tmp.rotation.set(0.3, i, 0.2)
    tmp.scale.set(0.012, 0.05, 0.006)
    tmp.updateMatrix()
    leaves.setMatrixAt(i, tmp.matrix)
  }
  leaves.computeBoundingSphere()
  g.add(leaves)

  // 頭光
  const ring = kit.tracker.track(new THREE.TorusGeometry(0.34, 0.025, 8, 40))
  part(g, ring, mat.gold!, [0, headY + 0.04, -0.28], [1, 1, 1])
  const disc = kit.tracker.track(new THREE.CircleGeometry(0.32, 40))
  part(g, disc, mat.goldDeep!, [0, headY + 0.04, -0.29], [1, 1, 1])
  return g
}

/**
 * 媽祖模型下載完成前（或載入失敗時）的佔位：深色漆木神座上，以紅布覆蓋的坐像輪廓。
 * 寺廟裡神像開光前或暫時請離時也以紅布覆蓋，不帶任何神明的特徵（臉、冠、持物），不會被誤認為其他神明。
 */
export function buildVeiledPlaceholder(kit: Kit): THREE.Group {
  const g = new THREE.Group()
  g.name = 'statue:veiled'
  const { geo, mat } = kit
  part(g, geo.box, mat.lacquer!, [0, 0.15, 0], [1.2, 0.3, 1.0])
  part(g, geo.box, mat.gold!, [0, 0.31, 0], [1.24, 0.03, 1.04])
  // 布從頭頂垂下，下襬略為外擴、蓋到座面
  const cloth = lathe(kit, [[0, 1.95], [0.1, 1.93], [0.2, 1.84], [0.28, 1.66], [0.32, 1.45], [0.42, 1.25], [0.5, 0.9], [0.54, 0.45], [0.58, 0.02], [0, 0.02]], 24)
  part(g, cloth, mat.veil!, [0, 0.3, 0], [1, 1, 0.82])
  return g
}

const BUILDERS: Record<StatueId, (kit: Kit) => THREE.Group> = {
  buddha: buildBuddha,
  guanyin: buildGuanyin,
  mazu: buildVeiledPlaceholder,
}

/** 寫實模型下載完成前（或載入失敗時）顯示的程序化造型。 */
export function buildStatue(kit: Kit, id: StatueId): THREE.Group {
  return BUILDERS[id](kit)
}

// ---------- 寫實模型 ----------

/**
 * 成品檔案的版本：重新處理模型（npm run build:statues）後要改這個值。public/ 下的檔案 Vite 不加雜湊，
 * 網址帶版本才不會讓瀏覽器或 CDN 拿舊貼圖配新幾何（每次處理的 UV 都不同）。
 */
const STATUE_ASSET_VERSION = '1'

/** 成品網址：幾何（Draco glb，不含材質）與底色、法線兩張 KTX2 貼圖，由 scripts/process-statues.mjs 產生。 */
export function statueUrls(id: StatueId, tier: StatueTier): { model: string; diff: string; nor: string } {
  const base = `${import.meta.env.BASE_URL}statues/${id}_${tier}`
  const v = `?v=${STATUE_ASSET_VERSION}`
  return { model: `${base}.glb${v}`, diff: `${base}_diff.ktx2${v}`, nor: `${base}_nor.ktx2${v}` }
}

/**
 * 殿內暗而暖、不用環境貼圖與色調映射；掃描貼圖帶著各自的博物館打光與材質明暗，以底色倍率（不改貼圖）
 * 讓三尊在殿內的亮度協調。Phong 比 Standard 便宜，與殿內其他材質一致。
 */
const STATUE_LOOK: Record<StatueId, { tint: number; specular: string; shininess: number }> = {
  // 深色漆木帶殘金：提亮，免得在暗殿裡死黑；高光偏暖，帶出殘金
  buddha: { tint: 1.25, specular: '#3a3020', shininess: 30 },
  // 白瓷：本身很亮，略降免得在米色牆前發白；高光較集中
  guanyin: { tint: 0.92, specular: '#3a3a3a', shininess: 60 },
  // 上漆木雕、黑面：略提亮，漆面有些光澤
  mazu: { tint: 1.05, specular: '#2a2620', shininess: 40 },
}

export interface StatueLoaders {
  gltf: import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader
  ktx2: KTX2Loader
  dispose(): void
}

/**
 * 建立載入寫實模型用的 loader。GLTFLoader 與 DRACOLoader 動態載入，未進殿時不增加主程式大小（KTX2Loader 庭院已在用）。
 * Draco 解碼器與 Basis 轉碼器是 three 附的副本（public/draco/、public/basis/），用完由 dispose() 釋放 worker。
 */
export async function createStatueLoaders(renderer: THREE.WebGLRenderer): Promise<StatueLoaders> {
  const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
  ])
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`)
  const ktx2 = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).detectSupport(renderer)
  const gltf = new GLTFLoader().setDRACOLoader(draco)
  return {
    gltf,
    ktx2,
    dispose() {
      draco.dispose()
      ktx2.dispose()
    },
  }
}

/**
 * 下載一尊寫實模型（幾何與兩張貼圖全部到齊才替換，不會先出現沒有貼圖的模型），換掉插槽裡的程序化造型。
 *
 * 模型規格：原點在底面中心、面向 +z、Y 軸朝上；依 STATUE_HEIGHT 等比縮放、底部對齊插槽原點。
 * 新的 geometry／material／texture 登記在 tracker；被換掉的程序化造型仍由原 tracker 釋放。
 * 失敗時丟出錯誤、插槽維持原樣。
 */
export async function loadStatueModel(
  slot: THREE.Group,
  id: StatueId,
  tier: StatueTier,
  loaders: StatueLoaders,
  tracker: ResourceTracker,
): Promise<THREE.Object3D> {
  const urls = statueUrls(id, tier)
  const [gltf, diff, nor] = await Promise.all([
    loaders.gltf.loadAsync(urls.model),
    loaders.ktx2.loadAsync(urls.diff),
    loaders.ktx2.loadAsync(urls.nor),
  ])
  // 色彩空間由 KTX2 檔頭決定（底色 sRGB、法線線性）；方向與 glTF 的 UV 一致（flipY = false）。
  const anisotropy = tier === 'hi' ? 4 : 1
  for (const t of [diff, nor]) t.anisotropy = anisotropy
  const look = STATUE_LOOK[id]
  const material = tracker.trackMaterial(
    new THREE.MeshPhongMaterial({ map: diff, normalMap: nor, specular: look.specular, shininess: look.shininess }),
  )
  material.color.setScalar(look.tint)
  const model = gltf.scene
  model.name = `statue:${id}:${tier}`
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      tracker.track(o.geometry)
      o.material = material
      o.matrixAutoUpdate = false
      o.updateMatrix()
    }
  })
  const box = new THREE.Box3().setFromObject(model)
  const height = box.max.y - box.min.y
  if (height > 0) model.scale.setScalar(STATUE_HEIGHT[id] / height)
  model.position.y = -box.min.y * model.scale.y
  model.updateMatrix()
  model.matrixAutoUpdate = false
  slot.clear()
  slot.add(model)
  return model
}

