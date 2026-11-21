// 產生碰碰車模型：四種 Q 版車型（經典碰碰車、木魚車、跑車、風火輪）。
// 四種車合併成單一幾何，每個頂點帶有 _KIND 屬性（0..3），以配合著色器依實例 kindId 進行頂點收合。
// 用法：node scripts/build-cars.mjs [輸出.glb]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [out = 'public/models/cars.glb'] = process.argv.slice(2)

// 座標：+z 是車頭、+x 是右、+y 朝上，單位公尺。碰撞盒是 1.1 × 1.8（shared/vehicles.json），
// 造型須在 1.1 × 0.9 × 1.8 內（carModel.test.ts）。騎士站在車的正中央、往下沉 0.18（'ride' 片段），
// 所以正中央半徑 0.3 內、高於 0.5 的地方不可以有東西；椅背在 z < -0.4、方向盤在 z > 0.3。
// 造型要改就改這裡的數字，重跑 npm run build:cars 並把 CarFleet 的 CAR_MODEL_VERSION 加一。
const m = { p: [], n: [], col: [], kind: [], paint: [], indices: [] }
let currentKind = 0
/** 烤漆係數：0 用頂點色；大於 0 的部位改用每台車自己的烤漆色乘上這個係數（經典碰碰車的四種顏色）。 */
let currentPaint = 0
const painted = (k, fn) => {
  currentPaint = k
  fn()
  currentPaint = 0
}

const norm = (v) => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
/** sRGB 色碼 → 線性 RGB（glTF 的 COLOR_0 是線性的）。 */
const hex = (s) => [1, 3, 5].map((i) => {
  const c = parseInt(s.slice(i, i + 2), 16) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
/** 以 axis 為局部 y 軸的座標系；局部 x 是切線方向（水平、垂直於 axis 的水平投影）。 */
function frame(axis) {
  const y = norm(axis)
  const x = norm(cross(Math.abs(y[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0], y))
  const z = cross(x, y)
  return (v) => [0, 1, 2].map((k) => x[k] * v[0] + y[k] * v[1] + z[k] * v[2])
}
function vert(c, at, n, color) {
  m.p.push(c[0] + at[0], c[1] + at[1], c[2] + at[2])
  m.n.push(...norm(n))
  m.col.push(...color)
  m.kind.push(currentKind)
  m.paint.push(currentPaint)
}
function grid(base, rings, segs) {
  for (let a = 0; a < rings; a++) {
    for (let b = 0; b < segs; b++) {
      const v = base + a * (segs + 1) + b
      m.indices.push(v, v + segs + 1, v + 1, v + 1, v + segs + 1, v + segs + 2)
    }
  }
}

/** 橢球。r = [局部 x, 沿 axis, 局部 z] 三個半徑。 */
function ellipsoid(c, r, color, segs = 12, axis = [0, 1, 0]) {
  const world = frame(axis)
  const rings = Math.max(4, Math.round(segs * 0.66))
  const base = m.p.length / 3
  for (let a = 0; a <= rings; a++) {
    const phi = (a / rings) * Math.PI
    for (let b = 0; b <= segs; b++) {
      const theta = (b / segs) * Math.PI * 2
      const d = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)]
      vert(c, world([d[0] * r[0], d[1] * r[1], d[2] * r[2]]), world([d[0] / r[0], d[1] / r[1], d[2] / r[2]]), color)
    }
  }
  grid(base, rings, segs)
}

/** 圓管或圓錐：中心 c、沿 axis 長 h，兩端半徑 r0（底）、r1（頂，0 即圓錐）。caps 為 true 時封口。 */
function tube(c, r0, r1, h, color, segs = 8, axis = [0, 1, 0], caps = true) {
  const world = frame(axis)
  const slope = (r0 - r1) / h
  const base = m.p.length / 3
  for (let a = 0; a <= 1; a++) {
    const r = a === 0 ? r0 : r1
    for (let b = 0; b <= segs; b++) {
      const theta = (b / segs) * Math.PI * 2
      const [sx, sz] = [Math.sin(theta), Math.cos(theta)]
      vert(c, world([sx * r, (a - 0.5) * h, sz * r]), world([sx, slope, sz]), color)
    }
  }
  grid(base, 1, segs)
  if (!caps) return
  for (const [a, r] of [[1, r1], [0, r0]]) {
    if (r <= 0) continue
    const n = world([0, a ? 1 : -1, 0])
    const center = m.p.length / 3
    vert(c, world([0, (a - 0.5) * h, 0]), n, color)
    for (let b = 0; b <= segs; b++) {
      const theta = (b / segs) * Math.PI * 2
      vert(c, world([Math.sin(theta) * r, (a - 0.5) * h, Math.cos(theta) * r]), n, color)
    }
    for (let b = 0; b < segs; b++) m.indices.push(center, center + 1 + (a ? b : b + 1), center + 1 + (a ? b + 1 : b))
  }
}

/** 圓環：環面垂直於 axis，局部 x、z 方向的大半徑分別是 rx、rz，管半徑 rMinor。 */
function ring(c, rx, rz, rMinor, color, segsMajor = 16, segsMinor = 6, axis = [0, 1, 0]) {
  const world = frame(axis)
  const base = m.p.length / 3
  for (let a = 0; a <= segsMajor; a++) {
    const u = (a / segsMajor) * Math.PI * 2
    const [dx, dz] = [Math.sin(u), Math.cos(u)]
    for (let b = 0; b <= segsMinor; b++) {
      const v = (b / segsMinor) * Math.PI * 2
      const n = [dx * Math.cos(v), Math.sin(v), dz * Math.cos(v)]
      vert(c, world([dx * rx + n[0] * rMinor, n[1] * rMinor, dz * rz + n[2] * rMinor]), world(n), color)
    }
  }
  grid(base, segsMajor, segsMinor)
}

/** 軸對齊的盒子。 */
function box(c, size, color) {
  const [hw, hh, hd] = size.map((s) => s / 2)
  const faces = [
    [[0, 1, 0], [[-hw, hh, -hd], [hw, hh, -hd], [hw, hh, hd], [-hw, hh, hd]]],
    [[0, -1, 0], [[-hw, -hh, hd], [hw, -hh, hd], [hw, -hh, -hd], [-hw, -hh, -hd]]],
    [[0, 0, 1], [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]]],
    [[0, 0, -1], [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]]],
    [[1, 0, 0], [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]]],
    [[-1, 0, 0], [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]]],
  ]
  for (const [n, pts] of faces) {
    const base = m.p.length / 3
    for (const p of pts) vert(c, p, n, color)
    m.indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }
}

// 配色取自衣裝色表（world/outfits.ts）與庭院的紅牆、木、金：同一個世界的玩具。
const C = {
  rubber: hex('#2b2a2d'),
  red: hex('#b3352a'),
  redDark: hex('#7d241d'),
  cream: hex('#eadfc8'),
  gold: hex('#d9a441'),
  goldBright: hex('#f2c14e'),
  ink: hex('#1f1d1f'),
  wood: hex('#8a5330'),
  woodDark: hex('#4a2e1c'),
  racing: hex('#d40000'),
  racingDark: hex('#8f0a0a'),
  badge: hex('#ffd21f'),
  steel: hex('#9a9a9a'),
  flame: hex('#f0691c'),
  flameTip: hex('#ffc93c'),
  lotus: hex('#e58aa5'),
  lotusLight: hex('#f6c1cf'),
  jewel: hex('#c2281f'),
}

/** 方向盤：斜向騎士的轉向柱加一個圓環。 */
function steering(z, y, rimColor, rim = 0.11) {
  const axis = [0, 0.75, -0.66]
  tube([0, y - 0.09, z + 0.08], 0.022, 0.022, 0.2, C.ink, 6, axis, false)
  ring([0, y, z], rim, rim, 0.022, rimColor, 12, 5, axis)
}

// ========================================================
// 車型 0：經典碰碰車（普通）——朱紅圓澡盆、兩顆大眼睛車燈、車尾一根掛金球的桿子
// ========================================================
currentKind = 0
{
  ring([0, 0.14, 0], 0.44, 0.77, 0.095, C.rubber, 16, 5) // 厚橡膠防撞圈
  painted(1, () => ellipsoid([0, 0.26, 0], [0.43, 0.2, 0.76], C.red, 12)) // 車身（烤漆色）
  ring([0, 0.27, 0], 0.432, 0.762, 0.022, C.cream, 16, 3) // 腰線
  ellipsoid([0, 0.35, 0.48], [0.25, 0.09, 0.24], C.gold, 10) // 金色車鼻
  for (const s of [-1, 1]) {
    ellipsoid([s * 0.2, 0.31, 0.665], [0.085, 0.085, 0.06], C.cream, 8) // 車燈（眼白）
    ellipsoid([s * 0.2, 0.31, 0.715], [0.04, 0.045, 0.025], C.ink, 6) // 瞳孔
  }
  painted(0.6, () => ellipsoid([0, 0.5, -0.5], [0.3, 0.2, 0.1], C.redDark, 10)) // 椅背（烤漆色的暗色）
  ellipsoid([0, 0.66, -0.5], [0.2, 0.06, 0.09], C.cream, 8) // 頭枕
  steering(0.33, 0.52, C.ink)
  tube([0, 0.56, -0.7], 0.016, 0.016, 0.55, C.steel, 5, [0, 1, 0], false) // 車尾的桿子
  ellipsoid([0, 0.85, -0.7], [0.05, 0.05, 0.05], C.goldBright, 8) // 金球
}

// ========================================================
// 車型 1：木魚車（普通）——整台是一顆大木魚：正面一道魚嘴開縫、車尾是提把、旁邊插著木魚槌
// ========================================================
currentKind = 1
{
  ring([0, 0.12, 0], 0.42, 0.74, 0.075, C.woodDark, 16, 5) // 底座
  ellipsoid([0, 0.28, 0.02], [0.46, 0.22, 0.8], C.wood, 14) // 木魚本體
  ellipsoid([0, 0.27, 0.3], [0.4, 0.022, 0.545], C.ink, 12) // 魚嘴的開縫（只在前半露出）
  for (const s of [-1, 1]) {
    ellipsoid([s * 0.385, 0.27, 0.46], [0.05, 0.05, 0.05], C.ink, 6) // 開縫兩端的圓孔
    ellipsoid([s * 0.44, 0.3, -0.1], [0.02, 0.07, 0.18], C.gold, 6) // 側面的金色雲紋
  }
  ring([0, 0.47, -0.02], 0.3, 0.34, 0.03, C.gold, 14, 3) // 座艙的金邊
  ring([0, 0.5, -0.58], 0.17, 0.17, 0.05, C.woodDark, 12, 5, [0, 0, 1]) // 提把（當椅背）
  ellipsoid([0, 0.69, -0.58], [0.06, 0.05, 0.06], C.goldBright, 6) // 提把頂的金珠
  // 木魚槌：斜插在車尾右側
  const stick = [0.18, 1, -0.22]
  tube([0.3, 0.5, -0.62], 0.018, 0.018, 0.46, C.woodDark, 5, stick, false)
  ellipsoid([0.34, 0.72, -0.67], [0.065, 0.085, 0.065], C.cream, 8, stick)
  ring([0.325, 0.64, -0.652], 0.03, 0.03, 0.014, C.red, 8, 4, stick)
  // 木頭的 T 形握把
  tube([0, 0.44, 0.36], 0.022, 0.022, 0.2, C.woodDark, 6, [0, 0.75, -0.66], false)
  tube([0, 0.52, 0.3], 0.024, 0.024, 0.3, C.woodDark, 6, [1, 0, 0])
}

// ========================================================
// 車型 2：跑車（稀有）——低扁的正紅車身、車鼻一塊黃色徽章、四顆外露的大輪子、黑色尾翼（不放任何廠牌標誌）
// ========================================================
currentKind = 2
{
  ellipsoid([0, 0.2, 0], [0.36, 0.14, 0.84], C.racing, 14) // 車身
  ellipsoid([0, 0.1, -0.02], [0.33, 0.09, 0.5], C.ink, 8) // 底盤：蓋住騎士的袍腳
  ellipsoid([0, 0.318, 0.42], [0.07, 0.012, 0.09], C.badge, 8) // 車鼻的黃色徽章
  box([0, 0.08, 0.74], [0.5, 0.03, 0.16], C.ink) // 前下擾流
  for (const s of [-1, 1]) {
    ellipsoid([s * 0.17, 0.22, 0.7], [0.06, 0.05, 0.05], C.goldBright, 6) // 車燈
    for (const z of [0.5, -0.5]) {
      ring([s * 0.43, 0.165, z], 0.1, 0.1, 0.065, C.rubber, 10, 5, [1, 0, 0]) // 輪胎
      tube([s * 0.43, 0.165, z], 0.075, 0.075, 0.11, C.gold, 6, [1, 0, 0]) // 輪圈
    }
    tube([s * 0.26, 0.46, -0.76], 0.02, 0.02, 0.3, C.ink, 5, [0, 1, 0], false) // 尾翼支架
    box([s * 0.45, 0.6, -0.78], [0.03, 0.13, 0.2], C.racing) // 尾翼端板
    tube([s * 0.12, 0.16, -0.84], 0.035, 0.035, 0.08, C.steel, 6, [0, 0, 1]) // 排氣管
  }
  box([0, 0.62, -0.78], [0.87, 0.035, 0.2], C.ink) // 尾翼
  ring([0, 0.32, -0.02], 0.27, 0.3, 0.03, C.ink, 14, 3) // 座艙的黑邊
  ellipsoid([0, 0.4, -0.46], [0.2, 0.2, 0.2], C.racingDark, 10) // 頭枕後的整流罩
  steering(0.31, 0.43, C.ink, 0.09)
}

// ========================================================
// 車型 3：風火輪（神話）——兩個冒火的金輪夾著一座蓮花座，方向盤是一只金圈。不含任何人形或神像。
// ========================================================
currentKind = 3
{
  const R = 0.31
  for (const s of [-1, 1]) {
    const cx = s * 0.45
    const hub = [cx, 0.4, 0]
    ring(hub, R, R, 0.045, C.gold, 16, 5, [1, 0, 0]) // 輪圈
    ring(hub, 0.19, 0.19, 0.025, C.goldBright, 10, 3, [1, 0, 0]) // 內圈
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI
      tube(hub, 0.016, 0.016, R * 2, C.goldBright, 4, [0, Math.sin(a), Math.cos(a)], false) // 輪輻
    }
    ellipsoid(hub, [0.07, 0.05, 0.07], C.jewel, 6, [1, 0, 0]) // 輪心的紅寶
    // 火舌：沿輪圈的上半與後半，朝外並往後甩（車往前跑）。貼地的那一段不放，免得穿進地面。
    for (let i = 0; i < 7; i++) {
      const a = -0.45 + (i / 6) * 3.5 // 由車頭略下方，經過頂端，到車尾下方
      const [ry, rz] = [Math.sin(a), Math.cos(a)]
      if (ry < -0.35) continue
      const dir = [0, ry + 1.3 * rz, rz - 1.3 * ry] // 徑向加上往後的切線（切線多一些，火舌才像被風往後吹）
      const at = (r, len) => [cx, 0.4 + ry * r + dir[1] * len * 0.35, rz * r + dir[2] * len * 0.35]
      tube(at(R + 0.02, 0.22), 0.065, 0, 0.22, C.flame, 6, dir, false)
      if (i % 2 === 0) tube([cx + s * 0.03, ...at(R + 0.02, 0.14).slice(1)], 0.04, 0, 0.14, C.flameTip, 5, dir, false)
    }
  }
  tube([0, 0.4, 0], 0.03, 0.03, 0.9, C.gold, 6, [1, 0, 0], false) // 連接兩輪的軸
  // 蓮花座：一個碗，外圈八瓣、內圈六瓣
  ellipsoid([0, 0.24, 0], [0.33, 0.16, 0.4], C.lotus, 10)
  tube([0, 0.09, 0], 0.27, 0.32, 0.12, C.jewel, 10, [0, 1, 0], false) // 蓮座的底：蓋住騎士的袍腳
  for (let i = 0; i < 8; i++) {
    const b = ((i + 0.5) / 8) * Math.PI * 2
    const [sx, sz] = [Math.sin(b), Math.cos(b)]
    ellipsoid([sx * 0.3, 0.36, sz * 0.37], [0.12, 0.17, 0.04], C.lotus, 6, [sx * 0.55, 1, sz * 0.55])
  }
  for (let i = 0; i < 6; i++) {
    const b = (i / 6) * Math.PI * 2
    const [sx, sz] = [Math.sin(b), Math.cos(b)]
    ellipsoid([sx * 0.25, 0.4, sz * 0.31], [0.1, 0.14, 0.035], C.lotusLight, 6, [sx * 0.3, 1, sz * 0.3])
  }
  ellipsoid([0, 0.3, 0.56], [0.13, 0.1, 0.15], C.goldBright, 8) // 車頭的金色祥雲
  ellipsoid([0, 0.34, 0.68], [0.05, 0.05, 0.05], C.jewel, 6)
  // 車尾拖著的三道火
  for (const [x, len] of [[0, 0.42], [-0.17, 0.3], [0.17, 0.3]]) {
    const dir = [0, 0.3, -1]
    tube([x, 0.3 + len * 0.14, -0.42 - len * 0.48], 0.1, 0, len, C.flame, 6, dir, false)
    tube([x, 0.31 + len * 0.1, -0.42 - len * 0.34], 0.055, 0, len * 0.7, C.flameTip, 5, dir, false)
  }
  ring([0, 0.5, 0.33], 0.11, 0.11, 0.024, C.goldBright, 12, 5, [0, 0.75, -0.66]) // 方向盤：一只金圈
}

// 繞向一律以頂點法線為準：三角形的幾何法線與頂點法線反向就對調，免得單面材質把面剔掉。
{
  let flipped = 0
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]]
    const P = (v) => [m.p[v * 3], m.p[v * 3 + 1], m.p[v * 3 + 2]]
    const [pa, pb, pc] = [P(a), P(b), P(c)]
    const g = cross(pb.map((v, k) => v - pa[k]), pc.map((v, k) => v - pa[k]))
    const n = [0, 1, 2].map((k) => m.n[a * 3 + k] + m.n[b * 3 + k] + m.n[c * 3 + k])
    if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] < 0) {
      m.indices[i + 1] = c
      m.indices[i + 2] = b
      flipped++
    }
  }
  console.log(`對調繞向的三角形：${flipped}`)
}

{
  // 每種車的三角形數與包圍盒，方便調整時對照預算
  const tri = [0, 0, 0, 0]
  for (let i = 0; i < m.indices.length; i += 3) tri[m.kind[m.indices[i]]]++
  for (let k = 0; k < 4; k++) {
    const b = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]]
    for (let i = 0; i < m.kind.length; i++) {
      if (m.kind[i] !== k) continue
      for (let a = 0; a < 3; a++) {
        b[a][0] = Math.min(b[a][0], m.p[i * 3 + a])
        b[a][1] = Math.max(b[a][1], m.p[i * 3 + a])
      }
    }
    console.log(`車種 ${k}: ${tri[k]} 三角形，x ${b[0].map((v) => v.toFixed(2))}，y ${b[1].map((v) => v.toFixed(2))}，z ${b[2].map((v) => v.toFixed(2))}`)
  }
}

// 寫 GLB
const chunks = []
const gltf = {
  asset: { version: '2.0', generator: 'shaolin-temple build-cars' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [],
  meshes: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
}
let offset = 0

const accessor = (array, type, target, withBounds) => {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength)
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)])
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target })
  chunks.push(padded)
  offset += padded.length
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type]
  const acc = {
    bufferView: gltf.bufferViews.length - 1,
    componentType: array instanceof Uint16Array ? 5123 : 5126,
    count: array.length / width,
    type,
  }
  if (withBounds) {
    acc.min = [0, 1, 2].map((k) => Math.min(...array.filter((_, i) => i % 3 === k)))
    acc.max = [0, 1, 2].map((k) => Math.max(...array.filter((_, i) => i % 3 === k)))
  }
  gltf.accessors.push(acc)
  return gltf.accessors.length - 1
}

if (m.p.length / 3 > 65535) throw new Error('頂點數超過 16 位元索引上限')

const attributes = {
  POSITION: accessor(new Float32Array(m.p), 'VEC3', 34962, true),
  NORMAL: accessor(new Float32Array(m.n), 'VEC3', 34962),
  COLOR_0: accessor(new Float32Array(m.col), 'VEC3', 34962),
  _PAINT: accessor(new Float32Array(m.paint), 'SCALAR', 34962),
  _KIND: accessor(new Float32Array(m.kind), 'SCALAR', 34962),
}

const name = 'cars'
gltf.meshes.push({
  name,
  primitives: [{ attributes, indices: accessor(new Uint16Array(m.indices), 'SCALAR', 34963) }],
})
gltf.nodes.push({ name, mesh: 0 })

gltf.buffers.push({ byteLength: offset })
let jsonBuf = Buffer.from(JSON.stringify(gltf))
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)])
const header = Buffer.alloc(12)
header.writeUInt32LE(0x46546c67, 0)
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + offset, 8)
const chunkHeader = (length, type) => {
  const b = Buffer.alloc(8)
  b.writeUInt32LE(length, 0)
  b.writeUInt32LE(type, 4)
  return b
}

mkdirSync(dirname(out), { recursive: true })
const file = Buffer.concat([
  header,
  chunkHeader(jsonBuf.length, 0x4e4f534a),
  jsonBuf,
  chunkHeader(offset, 0x004e4942),
  ...chunks,
])
writeFileSync(out, file)
console.log(`cars: ${m.indices.length / 3} 三角形／${m.p.length / 3} 頂點，${(file.length / 1024).toFixed(1)} KB → ${out}`)
