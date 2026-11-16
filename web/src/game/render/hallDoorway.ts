import * as THREE from 'three'
import { buildDoorwayBackdrop } from './doorwayView'
import type { ResourceTracker } from './ResourceTracker'

/**
 * 殿門（從殿內看）：門檻、抱框、中檻（門楣）、橫披窗、上檻，兩扇向內推開、貼靠在門洞兩側牆面的格扇門，
 * 門洞外是庭院的日光景色（doorwayView.ts），地上有一片從門口灑進來的日光。
 *
 * - 門扇貼著殿門牆的內面（z 8.77～8.845），殿內可走範圍到 z=8.6，不擋路，也不改出入口。
 * - 木作用殿內既有的材質（朱漆、深紅漆、金），由 HallScene 的 mergeStatic 併進既有的 draw call；
 *   新增的只有格心（畫在 canvas 上的菱花格與窗紙，一張貼圖）、門外景與地上的日光。
 * - 格心用不透明貼圖而不是鏤空：門扇貼著牆，後面本來就是牆；不透明才有 mipmap、遠看不閃爍，也沒有排序問題。
 *   橫披窗的直櫺是實體細條，透出門外的景。
 * - 門框（doorFrameSlabs）、門扇（doorLeafParts）與格心貼圖（latticeTexture）也給庭院側的主殿正面使用
 *   （TempleScene 的 buildHallFront，等比縮小、門扇改為推開 90°），兩側樣式一致。
 */

/** 門洞（殿內座標）：寬 3、高 3.6，牆厚 0.3。 */
export const HALL_DOOR = { halfWidth: 1.5, height: 3.6, wallInnerZ: 8.85, wallOuterZ: 9.15 }
/** 上檻頂：門洞上方的牆從這裡開始。 */
export const HALL_DOOR_TOP = 4.66

const JAMB_W = 0.22
const FRAME_FRONT = 8.78
const FRAME_BACK = 9.3

/** 門扇的高度分段（由下而上）：下抹頭、裙板、抹頭、縧環板、抹頭、格心、抹頭、縧環板、上抹頭。 */
const LEAF = {
  width: 1.5,
  stile: 0.09,
  bottom: 0.2,
  rails: [[0.2, 0.28], [1.08, 1.16], [1.36, 1.44], [3.26, 3.34], [3.5, 3.58]] as const,
  apron: [0.28, 1.08] as const,
  bandLow: [1.16, 1.36] as const,
  lattice: [1.44, 3.26] as const,
  bandHigh: [3.34, 3.5] as const,
  top: 3.58,
  /** 門扇貼牆：背面 z、面板正面 z、框正面 z。 */
  back: 8.845,
  panel: 8.8,
  front: 8.77,
}

/** 門扇格心的寬與高（殿內座標）：格心貼圖就是依這個比例畫的，庭院側的格扇窗用同樣比例才不會拉伸。 */
export const LEAF_LATTICE_SIZE: readonly [number, number] = [LEAF.width - LEAF.stile * 2, LEAF.lattice[1] - LEAF.lattice[0]]

type Range = readonly [number, number]
export type DoorMaterialKey = 'lacquer' | 'lacquerDark' | 'gold'
/** 依範圍放一個方塊；範圍一律以殿內座標表示（庭院側自己換算，見 TempleScene 的殿門）。 */
export type DoorSlab = (mat: DoorMaterialKey, x: Range, y: Range, z: Range) => void

export interface DoorFrameOptions {
  /** 橫披窗每格的直櫺數。 */
  transomBars: number
  /** 直櫺寬（殿內座標）。庭院側縮小後太細會閃爍，用較少、較粗的櫺條。 */
  barWidth: number
}

/**
 * 門框：抱框、門檻、中檻（門楣，下緣一道金線）、上檻，與兩根間柱分成三格的直櫺橫披窗。
 * 殿內與庭院兩側共用：範圍以殿內座標交給 slab，庭院側以等比縮放換算到主殿正面。
 */
export function doorFrameSlabs(slab: DoorSlab, opts: DoorFrameOptions = { transomBars: 9, barWidth: 0.025 }): void {
  const { halfWidth: hw, height } = HALL_DOOR
  const outer = hw + JAMB_W
  const frameZ = [FRAME_FRONT, FRAME_BACK] as const
  // 抱框的內面退進門洞 1 公分，不與牆的端面共面（避免 z-fighting）
  for (const s of [-1, 1]) slab('lacquer', [s * (hw - 0.01), s * outer], [0, HALL_DOOR_TOP], frameZ)
  slab('lacquerDark', [-outer, outer], [0, 0.22], [8.8, 9.35]) // 門檻
  slab('lacquer', [-outer, outer], [height, height + 0.26], frameZ) // 中檻（門楣）
  slab('gold', [-hw, hw], [height + 0.02, height + 0.045], [FRAME_FRONT - 0.006, FRAME_FRONT]) // 門楣下緣的金線（殿內側）
  slab('gold', [-hw, hw], [height + 0.02, height + 0.045], [FRAME_BACK, FRAME_BACK + 0.006]) // 門楣下緣的金線（庭院側）
  slab('lacquer', [-outer, outer], [HALL_DOOR_TOP - 0.16, HALL_DOOR_TOP], frameZ) // 上檻

  // 橫披窗：兩根間柱分成三格，直櫺透出門外（或殿內）的景
  const tY = [height + 0.26, HALL_DOOR_TOP - 0.16] as const
  const tZ = [8.97, 9.03] as const
  for (const x of [-0.5, 0.5]) slab('lacquer', [x - 0.04, x + 0.04], tY, [8.9, 9.1])
  const panes = [[-hw, -0.54], [-0.46, 0.46], [0.54, hw]] as const
  const half = opts.barWidth / 2
  for (const [x0, x1] of panes) {
    slab('lacquer', [x0, x1], [tY[0], tY[0] + 0.035], tZ)
    slab('lacquer', [x0, x1], [tY[1] - 0.035, tY[1]], tZ)
    slab('lacquer', [x0, x1], [(tY[0] + tY[1]) / 2 - half, (tY[0] + tY[1]) / 2 + half], tZ)
    const bars = opts.transomBars
    for (let i = 1; i <= bars; i++) {
      const x = x0 + ((x1 - x0) * i) / (bars + 1)
      slab('lacquer', [x - half, x + half], tY, tZ)
    }
  }
}

/**
 * 門扇的擺放：把門扇局部座標的範圍換成殿內座標的 x、z 範圍。局部座標 u 是從鉸鏈側量起的寬度方向（0～LEAF.width），
 * t 是離裝飾面（關門時朝外的那一面）的深度（0～LEAF_DEPTH）。
 */
export interface LeafPose {
  x(u: Range, t: Range): Range
  z(u: Range, t: Range): Range
}

export interface LeafParts {
  slab: DoorSlab
  /** 格心平面（裝飾面朝外）：u、y 是範圍，t 是離裝飾面的深度。 */
  lattice(pose: LeafPose, u: Range, y: Range, t: number): void
  /** 鋪首（可省略）：u、y 是中心。 */
  pull?(pose: LeafPose, u: number, y: number, t: number): void
}

/** 門扇厚度（框正面到背面）。 */
export const LEAF_DEPTH = LEAF.back - LEAF.front
const sorted = (a: number, b: number): Range => (a <= b ? [a, b] : [b, a])

/** 殿內：推開 180°，貼在門洞兩側牆的內面，裝飾面朝殿內（-z）。 */
export function hallLeafPose(s: 1 | -1): LeafPose {
  const x0 = HALL_DOOR.halfWidth + JAMB_W + 0.005
  return {
    x: (u) => sorted(s * (x0 + u[0]), s * (x0 + u[1])),
    z: (_u, t) => [LEAF.front + t[0], LEAF.front + t[1]],
  }
}

/**
 * 庭院側：向殿內推開 90°，鉸鏈在抱框內側，門扇立在門洞兩側往殿內延伸，裝飾面朝門洞中央。
 * 從門外看主要是門洞與門框，門扇只在門洞內側兩邊斜斜露出一點（殿內那一側是推到 180° 貼牆，兩邊刻意不同：
 * 殿內若立成 90° 會伸進可走範圍；庭院若貼牆，門扇整個藏在抱框後面看不到）。
 */
export function facadeLeafPose(s: 1 | -1): LeafPose {
  const face = HALL_DOOR.halfWidth - 0.01 - LEAF_DEPTH
  return {
    x: (_u, t) => sorted(s * (face + t[0]), s * (face + t[1])),
    z: (u) => [FRAME_FRONT - u[1], FRAME_FRONT - u[0]],
  }
}

/** 一扇格扇門：邊梃、抹頭、裙板（起鼓板心與細金線）、縧環板、格心、鋪首。殿內與庭院兩側共用，擺放由 pose 決定。 */
export function doorLeafParts(parts: LeafParts, pose: LeafPose): void {
  const L = LEAF
  const { slab } = parts
  const frameT = [0, LEAF_DEPTH] as const
  const panelT = [L.panel - L.front, LEAF_DEPTH] as const
  const box = (mat: DoorMaterialKey, u: Range, y: Range, t: Range) => slab(mat, pose.x(u, t), y, pose.z(u, t))
  // 邊梃與抹頭
  box('lacquer', [0, L.stile], [L.bottom, L.top], frameT)
  box('lacquer', [L.width - L.stile, L.width], [L.bottom, L.top], frameT)
  for (const r of L.rails) box('lacquer', [L.stile, L.width - L.stile], r, frameT)
  // 裙板：凹進的深紅板心，中間一塊起鼓的朱漆，外圍一圈細金線
  const inner = [L.stile, L.width - L.stile] as const
  box('lacquerDark', inner, L.apron, panelT)
  for (const band of [L.bandLow, L.bandHigh]) box('lacquerDark', inner, band, panelT)
  const field = { u: [0.2, L.width - 0.2] as const, y: [L.apron[0] + 0.1, L.apron[1] - 0.1] as const }
  box('lacquer', field.u, field.y, [panelT[0] - 0.012, LEAF_DEPTH])
  const gt = [panelT[0] - 0.017, panelT[0] - 0.012] as const
  const g = 0.012
  box('gold', [field.u[0] - 0.04, field.u[1] + 0.04], [field.y[0] - 0.04 - g, field.y[0] - 0.04], gt)
  box('gold', [field.u[0] - 0.04, field.u[1] + 0.04], [field.y[1] + 0.04, field.y[1] + 0.04 + g], gt)
  box('gold', [field.u[0] - 0.04 - g, field.u[0] - 0.04], [field.y[0] - 0.04 - g, field.y[1] + 0.04 + g], gt)
  box('gold', [field.u[1] + 0.04, field.u[1] + 0.04 + g], [field.y[0] - 0.04 - g, field.y[1] + 0.04 + g], gt)
  // 格心
  parts.lattice(pose, inner, L.lattice, panelT[0] - 0.005)
  // 鋪首：門扇外緣（關門時在中間）的縧環板上
  parts.pull?.(pose, L.width - 0.2, (L.bandLow[0] + L.bandLow[1]) / 2, panelT[0])
}

export interface DoorwayMaterials {
  /** 朱漆（抱框、門框、櫺條）。 */
  lacquer: THREE.Material
  /** 深紅漆（門檻、裙板、縧環板）。 */
  lacquerDark: THREE.Material
  gold: THREE.Material
}

export interface HallDoorway {
  /** 門外景的材質：KTX2 貼圖到了再設定 map（之前以亮色代替）。 */
  backdrop: THREE.MeshBasicMaterial
}

/**
 * 格心貼圖：斜方格（菱花）櫺條、交點的四瓣花結，後面是窗紙。不透明（RGBA 256×352，含 mipmap 約 0.5 MB）。
 * 殿內的門扇與庭院側的格扇窗共用這個畫法（各自建立一張，擁有者各自釋放）。
 */
export function latticeTexture(): THREE.CanvasTexture {
  const W = 512
  const H = 704
  const cell = 64
  const c = document.createElement('canvas')
  // 以 512×704 的座標繪製、實際存半解析度（256×352，約每公尺 190 texel）：門扇在畫面上不大，省一半以上的記憶體
  c.width = W / 2
  c.height = H / 2
  const ctx = c.getContext('2d')!
  ctx.scale(0.5, 0.5)
  // 窗紙：微暖的米白，靠框處略暗
  const paper = ctx.createLinearGradient(0, 0, 0, H)
  paper.addColorStop(0, '#e6d6b4')
  paper.addColorStop(0.5, '#efe2c6')
  paper.addColorStop(1, '#e3d2ae')
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, W, H)

  const diagonals = (dx: number, dy: number) => {
    ctx.beginPath()
    for (let k = -H; k <= W + H; k += cell) {
      ctx.moveTo(k + dx, dy)
      ctx.lineTo(k + H + dx, H + dy)
      ctx.moveTo(k + dx, H + dy)
      ctx.lineTo(k + H + dx, dy)
    }
    ctx.stroke()
  }
  const knots = (r: number, dx: number, dy: number, petals: boolean) => {
    ctx.beginPath()
    for (let y = 0; y <= H; y += cell / 2) {
      for (let x = (y / (cell / 2)) % 2 === 0 ? 0 : cell / 2; x <= W; x += cell) {
        if (petals) {
          for (const [px, py] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
            ctx.moveTo(x + dx + px * r * 0.95 + r * 0.62, y + dy + py * r * 0.95)
            ctx.arc(x + dx + px * r * 0.95, y + dy + py * r * 0.95, r * 0.62, 0, Math.PI * 2)
          }
        } else {
          ctx.moveTo(x + dx + r, y + dy)
          ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2)
        }
      }
    }
    ctx.fill()
  }
  ctx.lineCap = 'butt'
  // 櫺條投在窗紙上的影子（光從上方來）
  ctx.strokeStyle = 'rgba(70, 30, 18, 0.35)'
  ctx.lineWidth = 12
  diagonals(1.5, 3)
  ctx.fillStyle = 'rgba(70, 30, 18, 0.35)'
  knots(9, 1.5, 3, true)
  // 櫺條本體
  ctx.strokeStyle = '#8c271c'
  ctx.lineWidth = 9
  diagonals(0, 0)
  // 櫺條上緣的反光
  ctx.strokeStyle = 'rgba(255, 196, 160, 0.28)'
  ctx.lineWidth = 2
  diagonals(-1.5, -2.5)
  // 花結：四瓣，中心一點金
  ctx.fillStyle = '#8c271c'
  knots(8, 0, 0, true)
  ctx.fillStyle = '#a5382a'
  knots(5, -0.5, -0.8, false)
  ctx.fillStyle = '#c9a043'
  knots(2.4, 0, 0, false)
  // 仔邊（格心的內框），蓋住櫺條的端頭
  ctx.strokeStyle = '#7d2218'
  ctx.lineWidth = 16
  ctx.strokeRect(0, 0, W, H)
  ctx.strokeStyle = 'rgba(255, 196, 160, 0.22)'
  ctx.lineWidth = 2
  ctx.strokeRect(9, 9, W - 18, H - 18)

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * 地上的日光：門洞（扣掉門檻）沿殿內主光的方向投到地面的平行四邊形，邊緣隨距離變柔。
 * 回傳幾何（y 已抬到地毯上方）與強度貼圖（灰階）。
 */
function sunPatch(tracker: ResourceTracker, sunDir: THREE.Vector3): { geometry: THREE.BufferGeometry; map: THREE.CanvasTexture } {
  const { halfWidth, height } = HALL_DOOR
  const z0 = FRAME_FRONT
  const sill = 0.22
  // 門洞邊緣上一點 (x, y, z0) 沿 -sunDir 落到地面：位移 = -(y / sunDir.y) * (sunDir.x, sunDir.z)
  const along = new THREE.Vector2(-sunDir.x / sunDir.y, -sunDir.z / sunDir.y)
  const near = new THREE.Vector2(-halfWidth + along.x * sill, z0 + along.y * sill)
  const length = height - sill
  const margin = { side: 0.45, near: 0.1, far: 0.45 }
  const width = halfWidth * 2
  const totalW = width + margin.side * 2
  // 四個角：a 是跨門寬的方向，b 是沿光線的方向（以門洞高度為單位）
  const corner = (a: number, b: number) => {
    const ay = b * (length + margin.near + margin.far) - margin.near
    return [near.x - margin.side + a * totalW + along.x * ay, 0.03, near.y + along.y * ay] as const
  }
  const pos = [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)].flat()
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2))
  // 跨門寬是 +x、沿光線是 -z：(0,1,2) 從上方看是逆時針
  geometry.setIndex([0, 1, 2, 2, 1, 3])

  const TW = 64
  const TH = 256
  const c = document.createElement('canvas')
  c.width = TW
  c.height = TH
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(TW, TH)
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }
  for (let j = 0; j < TH; j++) {
    // 畫布第 0 列對應 uv.y = 1（遠端）
    const b = 1 - (j + 0.5) / TH
    const ay = b * (length + margin.near + margin.far) - margin.near
    const t = Math.min(1, Math.max(0, ay / length))
    // 半影寬度隨離門洞的距離增加（光源有大小）
    const pen = 0.06 + 0.32 * t
    for (let i = 0; i < TW; i++) {
      const x = ((i + 0.5) / TW) * totalW - margin.side - halfWidth
      const across = smooth(-pen, pen, halfWidth - Math.abs(x))
      const lengthwise = smooth(-0.04, 0.04, ay) * smooth(-pen, pen, length - ay)
      // 近門口略亮，往裡一點點衰減（空氣中的塵與視覺上的層次）
      const v = across * lengthwise * (1 - 0.25 * t)
      const k = (j * TW + i) * 4
      img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.round(255 * v)
      img.data[k + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const map = tracker.track(new THREE.CanvasTexture(c))
  return { geometry: tracker.track(geometry), map }
}

/** 光束在門口、正對鏡頭時加上的顏色（直接是畫面上的值，不經色彩空間轉換）。 */
const SHAFT_TINT = new THREE.Vector3(0.2, 0.16, 0.11)

/**
 * 光束：門洞的上緣與左右兩緣沿 -sunDir 掃到地面的三片薄幕。每片沿邊緣方向分 4 欄（兩端為 0 形成柔邊）、
 * 沿光線分 3 段（門口最亮，到地面淡出為 0）。
 */
function lightShaft(sunDir: THREE.Vector3): THREE.BufferGeometry {
  const { halfWidth: hw, height } = HALL_DOOR
  const z0 = FRAME_FRONT
  const sill = 0.22
  const toFloor = (p: THREE.Vector3) => p.clone().addScaledVector(sunDir, -p.y / sunDir.y)
  const pos: number[] = []
  const glow: number[] = []
  const index: number[] = []
  /** 一片薄幕：邊緣從 a 到 b（在門洞上），沿光線掃到地面。 */
  const sheet = (a: THREE.Vector3, b: THREE.Vector3) => {
    const across = [0, 0.15, 0.85, 1]
    const acrossK = [0, 1, 1, 0]
    const along = [0, 0.35, 1]
    const alongK = [1, 0.45, 0]
    const base = pos.length / 3
    for (let j = 0; j < along.length; j++) {
      for (let i = 0; i < across.length; i++) {
        const e = a.clone().lerp(b, across[i]!)
        const p = e.clone().lerp(toFloor(e), along[j]!)
        pos.push(p.x, p.y, p.z)
        glow.push(acrossK[i]! * alongK[j]!)
      }
    }
    const n = across.length
    for (let j = 0; j < along.length - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const q = base + j * n + i
        index.push(q, q + n, q + 1, q + 1, q + n, q + n + 1)
      }
    }
  }
  const tl = new THREE.Vector3(-hw, height, z0)
  const tr = new THREE.Vector3(hw, height, z0)
  sheet(tl, tr)
  sheet(new THREE.Vector3(-hw, sill, z0), tl)
  sheet(new THREE.Vector3(hw, sill, z0), tr)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('glow', new THREE.Float32BufferAttribute(glow, 1))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

/**
 * 建立殿門。box 是單位方塊（與 HallScene 共用），木作 Mesh 加到 root 由呼叫端合併。
 * @param sunDir 殿內主光的方向（指向光源），地上的日光沿它投影。
 */
export function buildHallDoorway(
  root: THREE.Group,
  tracker: ResourceTracker,
  mats: DoorwayMaterials,
  box: THREE.BoxGeometry,
  sunDir: THREE.Vector3,
): HallDoorway {
  const geo = <T extends THREE.BufferGeometry>(g: T) => tracker.track(g)
  /** 依範圍放一個方塊。 */
  const slab = (mat: THREE.Material, x: readonly [number, number], y: readonly [number, number], z: readonly [number, number]) => {
    const mesh = new THREE.Mesh(box, mat)
    mesh.position.set((x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2)
    mesh.scale.set(Math.abs(x[1] - x[0]), y[1] - y[0], z[1] - z[0])
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    root.add(mesh)
  }
  const place = (g: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(g, mat)
    mesh.position.set(x, y, z)
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    root.add(mesh)
    return mesh
  }
  // ---------- 門框（與庭院側共用 doorFrameSlabs）----------
  doorFrameSlabs((mat, x, y, z) => slab(mats[mat], x, y, z))

  // ---------- 門扇（推開 180°，貼在門洞兩側的牆上）----------
  const latticeMat = tracker.trackMaterial(new THREE.MeshLambertMaterial({ map: latticeTexture() }))
  const latticeGeo = geo(new THREE.PlaneGeometry(...LEAF_LATTICE_SIZE))
  latticeGeo.rotateY(Math.PI) // 面向殿內（-z）
  const ringGeo = geo(new THREE.TorusGeometry(0.05, 0.008, 6, 18))
  const plateGeo = geo(new THREE.CylinderGeometry(0.065, 0.065, 0.016, 18).rotateX(Math.PI / 2))
  const mid = (r: Range) => (r[0] + r[1]) / 2
  const leafParts: LeafParts = {
    slab: (mat, x, y, z) => slab(mats[mat], x, y, z),
    lattice: (pose, u, y, t) => {
      place(latticeGeo, latticeMat, mid(pose.x(u, [t, t])), mid(y), mid(pose.z(u, [t, t])))
    },
    // 一個圓座與門環
    pull: (pose, u, y, t) => {
      const x = mid(pose.x([u, u], [t, t]))
      const z = mid(pose.z([u, u], [t, t]))
      place(plateGeo, mats.gold, x, y, z - 0.008)
      place(ringGeo, mats.gold, x, y - 0.05, z - 0.02)
    },
  }
  for (const s of [-1, 1] as const) doorLeafParts(leafParts, hallLeafPose(s))

  // ---------- 門外景 ----------
  // alphaTest：香爐與石燈籠的直立片只有物件本身不透明（兩層貼圖，見 doorwayView.ts）；仍在不透明 pass，不需排序
  const backdrop = tracker.trackMaterial(new THREE.MeshBasicMaterial({ color: '#f4ecdb', fog: false, side: THREE.DoubleSide, alphaTest: 0.5 }))
  const outside = place(geo(buildDoorwayBackdrop()), backdrop, 0, 0, 0)
  outside.name = 'doorway-view'
  // 畫在其他不透明物件之後，只有門洞裡的像素會通過深度測試
  outside.renderOrder = 1

  // ---------- 地上的日光 ----------
  // 顏色 × 地面原本的顏色再加回去（DstColor, One）：亮處更亮、紅毯更紅，不會像加法那樣洗白
  const patch = sunPatch(tracker, sunDir)
  const patchMat = tracker.trackMaterial(
    new THREE.MeshBasicMaterial({
      map: patch.map,
      color: new THREE.Color(0.5, 0.36, 0.2),
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
    }),
  )
  place(patch.geometry, patchMat, 0, 0, 0).name = 'doorway-sun'

  // ---------- 空氣中的光束 ----------
  // 門洞上緣與兩側沿光線掃到地面的三片薄幕，由門口往裡淡出、兩側邊緣為 0，加法混色，畫出塵埃中的光。
  // 薄幕側看會擠成一條亮線，所以亮度再乘上「面向鏡頭的程度」的平方。
  const shaftMat = tracker.trackMaterial(
    new THREE.ShaderMaterial({
      uniforms: { tint: { value: SHAFT_TINT } },
      vertexShader: /* glsl */ `
        attribute float glow;
        varying float vGlow;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float facing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
          vGlow = glow * facing * facing;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 tint;
        varying float vGlow;
        void main() {
          gl_FragColor = vec4(tint * vGlow, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // 透明的雙面材質預設分兩次畫（背面再正面）；加法混色與順序無關，一次就好
      forceSinglePass: true,
      blending: THREE.AdditiveBlending,
    }),
  )
  place(geo(lightShaft(sunDir)), shaftMat, 0, 0, 0).name = 'doorway-shaft'

  return { backdrop }
}
