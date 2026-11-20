// 產生碰碰車模型：四種 Q 版車型（經典碰碰車、木魚車、跑車、風火輪）。
// 四種車合併成單一幾何，每個頂點帶有 _KIND 屬性（0..3），以配合著色器依實例 kindId 進行頂點收合。
// 用法：node scripts/build-cars.mjs [輸出.glb]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [out = 'public/models/cars.glb'] = process.argv.slice(2)

const m = {
  p: [],
  n: [],
  col: [],
  kind: [],
  indices: [],
}

let currentKind = 0

const norm = (v) => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

function grid(base, rings, segs) {
  for (let a = 0; a < rings; a++) {
    for (let b = 0; b < segs; b++) {
      const v = base + a * (segs + 1) + b
      m.indices.push(v, v + segs + 1, v + 1, v + 1, v + segs + 1, v + segs + 2)
    }
  }
}

/** 橢球 */
function ellipsoid(c, r, color, segs = 16, axis = [0, 1, 0], ringCount = Math.max(6, Math.round(segs * 0.66))) {
  const y = norm(axis)
  const x = norm(cross(Math.abs(y[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0], y))
  const z = cross(x, y)
  const world = (v) => [0, 1, 2].map((k) => x[k] * v[0] + y[k] * v[1] + z[k] * v[2])
  const rings = ringCount
  const base = m.p.length / 3
  for (let a = 0; a <= rings; a++) {
    const phi = (a / rings) * Math.PI
    for (let b = 0; b <= segs; b++) {
      const theta = (b / segs) * Math.PI * 2
      const d = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)]
      const at = world([d[0] * r[0], d[1] * r[1], d[2] * r[2]])
      m.p.push(c[0] + at[0], c[1] + at[1], c[2] + at[2])
      m.n.push(...norm(world([d[0] / r[0], d[1] / r[1], d[2] / r[2]])))
      m.col.push(...color)
      m.kind.push(currentKind)
    }
  }
  grid(base, rings, segs)
}

/** 圓柱體（鉛直方向） */
function cylinder(c, rBottom, rTop, h, color, segs = 14) {
  const base = m.p.length / 3
  const halfH = h / 2
  for (let a = 0; a <= 1; a++) {
    const y = a === 0 ? c[1] - halfH : c[1] + halfH
    const r = a === 0 ? rBottom : rTop
    for (let b = 0; b <= segs; b++) {
      const theta = (b / segs) * Math.PI * 2
      const sx = Math.sin(theta)
      const sz = Math.cos(theta)
      m.p.push(c[0] + sx * r, y, c[2] + sz * r)
      m.n.push(sx, 0, sz)
      m.col.push(...color)
      m.kind.push(currentKind)
    }
  }
  grid(base, 1, segs)

  // 頂面
  const topCenter = m.p.length / 3
  m.p.push(c[0], c[1] + halfH, c[2])
  m.n.push(0, 1, 0)
  m.col.push(...color)
  m.kind.push(currentKind)
  const topBase = m.p.length / 3
  for (let b = 0; b <= segs; b++) {
    const theta = (b / segs) * Math.PI * 2
    m.p.push(c[0] + Math.sin(theta) * rTop, c[1] + halfH, c[2] + Math.cos(theta) * rTop)
    m.n.push(0, 1, 0)
    m.col.push(...color)
    m.kind.push(currentKind)
  }
  for (let b = 0; b < segs; b++) {
    m.indices.push(topCenter, topBase + b, topBase + b + 1)
  }

  // 底面
  const botCenter = m.p.length / 3
  m.p.push(c[0], c[1] - halfH, c[2])
  m.n.push(0, -1, 0)
  m.col.push(...color)
  m.kind.push(currentKind)
  const botBase = m.p.length / 3
  for (let b = 0; b <= segs; b++) {
    const theta = (b / segs) * Math.PI * 2
    m.p.push(c[0] + Math.sin(theta) * rBottom, c[1] - halfH, c[2] + Math.cos(theta) * rBottom)
    m.n.push(0, -1, 0)
    m.col.push(...color)
    m.kind.push(currentKind)
  }
  for (let b = 0; b < segs; b++) {
    m.indices.push(botCenter, botBase + b + 1, botBase + b)
  }
}

/** 水平圓環體（用於防撞圈，環面平行 XZ） */
function torus(c, rMajorX, rMajorZ, rMinor, color, segsMajor = 16, segsMinor = 8) {
  const base = m.p.length / 3
  for (let a = 0; a <= segsMajor; a++) {
    const u = (a / segsMajor) * Math.PI * 2
    const cx = Math.sin(u) * rMajorX
    const cz = Math.cos(u) * rMajorZ
    const dirX = Math.sin(u)
    const dirZ = Math.cos(u)
    for (let b = 0; b <= segsMinor; b++) {
      const v = (b / segsMinor) * Math.PI * 2
      const nx = dirX * Math.cos(v)
      const ny = Math.sin(v)
      const nz = dirZ * Math.cos(v)
      m.p.push(c[0] + cx + nx * rMinor, c[1] + ny * rMinor, c[2] + cz + nz * rMinor)
      m.n.push(nx, ny, nz)
      m.col.push(...color)
      m.kind.push(currentKind)
    }
  }
  for (let a = 0; a < segsMajor; a++) {
    for (let b = 0; b < segsMinor; b++) {
      const v = base + a * (segsMinor + 1) + b
      m.indices.push(v, v + segsMinor + 1, v + 1, v + 1, v + segsMinor + 1, v + segsMinor + 2)
    }
  }
}

/** 鉛直車輪圓環（環面平行 YZ，軸向為 X） */
function wheelRing(c, rMajor, rMinor, color, segsMajor = 16, segsMinor = 8) {
  const base = m.p.length / 3
  for (let a = 0; a <= segsMajor; a++) {
    const u = (a / segsMajor) * Math.PI * 2
    const cy = Math.sin(u) * rMajor
    const cz = Math.cos(u) * rMajor
    const dirY = Math.sin(u)
    const dirZ = Math.cos(u)
    for (let b = 0; b <= segsMinor; b++) {
      const v = (b / segsMinor) * Math.PI * 2
      const nx = Math.cos(v)
      const ny = dirY * Math.sin(v)
      const nz = dirZ * Math.sin(v)
      m.p.push(c[0] + nx * rMinor, c[1] + cy + ny * rMinor, c[2] + cz + nz * rMinor)
      m.n.push(nx, ny, nz)
      m.col.push(...color)
      m.kind.push(currentKind)
    }
  }
  for (let a = 0; a < segsMajor; a++) {
    for (let b = 0; b < segsMinor; b++) {
      const v = base + a * (segsMinor + 1) + b
      m.indices.push(v, v + segsMinor + 1, v + 1, v + 1, v + segsMinor + 1, v + segsMinor + 2)
    }
  }
}

/** 六面體盒形 */
function box(c, size, color) {
  const [w, h, d] = size
  const [hw, hh, hd] = [w / 2, h / 2, d / 2]
  const faces = [
    { n: [0, 1, 0], pts: [[-hw, hh, -hd], [hw, hh, -hd], [hw, hh, hd], [-hw, hh, hd]] },
    { n: [0, -1, 0], pts: [[-hw, -hh, hd], [hw, -hh, hd], [hw, -hh, -hd], [-hw, -hh, -hd]] },
    { n: [0, 0, 1], pts: [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]] },
    { n: [0, 0, -1], pts: [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]] },
    { n: [1, 0, 0], pts: [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]] },
    { n: [-1, 0, 0], pts: [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]] },
  ]
  for (const f of faces) {
    const base = m.p.length / 3
    for (const p of f.pts) {
      m.p.push(c[0] + p[0], c[1] + p[1], c[2] + p[2])
      m.n.push(...f.n)
      m.col.push(...color)
      m.kind.push(currentKind)
    }
    m.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
}

// ========================================================
// 車型 0：經典碰碰車 (Classic Bumper Car)
// ========================================================
currentKind = 0
{
  // 底部厚橡膠防撞圈
  torus([0, 0.12, 0], 0.42, 0.58, 0.08, [0.18, 0.18, 0.2], 16, 8)
  // 車身圓潤外殼（經典朱紅漆）
  ellipsoid([0, 0.24, 0], [0.42, 0.18, 0.58], [0.82, 0.22, 0.16], 16)
  // 車頭裝飾鼻蓋
  ellipsoid([0, 0.28, 0.38], [0.28, 0.12, 0.22], [0.92, 0.78, 0.22], 12)
  // 車艙椅座
  box([0, 0.32, -0.15], [0.44, 0.22, 0.32], [0.22, 0.22, 0.26])
  box([0, 0.44, -0.32], [0.42, 0.25, 0.12], [0.24, 0.24, 0.28])
  // 方向盤機柱與盤面
  cylinder([0, 0.35, 0.15], 0.03, 0.03, 0.22, [0.15, 0.15, 0.15], 8)
  torus([0, 0.45, 0.15], 0.11, 0.11, 0.02, [0.12, 0.12, 0.12], 12, 6)
  // 車尾天線桿與金球
  cylinder([0, 0.55, -0.52], 0.015, 0.015, 0.48, [0.72, 0.72, 0.72], 6)
  ellipsoid([0, 0.79, -0.52], [0.04, 0.04, 0.04], [0.95, 0.82, 0.2], 8)
}

// ========================================================
// 車型 1：木魚車 (Woodfish Car)
// ========================================================
currentKind = 1
{
  // 底部木質基座圈
  torus([0, 0.12, 0], 0.41, 0.56, 0.07, [0.28, 0.16, 0.1], 16, 8)
  // 木魚圓潤主體（溫潤紅木色）
  ellipsoid([0, 0.26, 0.02], [0.42, 0.22, 0.54], [0.62, 0.32, 0.16], 16)
  // 木魚側面開口雕花與金邊
  box([-0.36, 0.25, 0.05], [0.06, 0.08, 0.42], [0.92, 0.75, 0.22])
  box([0.36, 0.25, 0.05], [0.06, 0.08, 0.42], [0.92, 0.75, 0.22])
  // 車尾木魚魚尾飾件
  ellipsoid([0, 0.32, -0.48], [0.22, 0.14, 0.12], [0.82, 0.45, 0.2], 12)
  ellipsoid([0, 0.38, -0.52], [0.12, 0.18, 0.08], [0.92, 0.75, 0.22], 10)
  // 內座布質蒲團坐墊
  cylinder([0, 0.26, -0.12], 0.22, 0.22, 0.12, [0.85, 0.68, 0.25], 14)
  // 木質握把
  box([0, 0.42, 0.16], [0.32, 0.04, 0.04], [0.38, 0.22, 0.12])
  cylinder([0, 0.34, 0.16], 0.025, 0.025, 0.16, [0.38, 0.22, 0.12], 8)
}

// ========================================================
// 車型 2：跑車 (Racer Car)
// ========================================================
currentKind = 2
{
  // 低趴黑色防撞裙邊
  torus([0, 0.10, 0], 0.43, 0.60, 0.06, [0.15, 0.15, 0.18], 16, 8)
  // 楔形流線車體（青藍跑車漆）
  ellipsoid([0, 0.22, 0.02], [0.42, 0.16, 0.60], [0.14, 0.55, 0.82], 16)
  // 前下巴導流翼
  box([0, 0.12, 0.52], [0.52, 0.05, 0.14], [0.1, 0.1, 0.12])
  // 雙圓頭燈（高亮黃白）
  ellipsoid([-0.22, 0.22, 0.54], [0.06, 0.06, 0.04], [1.0, 0.98, 0.65], 8)
  ellipsoid([0.22, 0.22, 0.54], [0.06, 0.06, 0.04], [1.0, 0.98, 0.65], 8)
  // 駕駛座賽車椅
  box([0, 0.32, -0.12], [0.38, 0.22, 0.28], [0.18, 0.18, 0.22])
  box([0, 0.46, -0.28], [0.36, 0.26, 0.08], [0.22, 0.22, 0.26])
  // 賽車方向盤
  cylinder([0, 0.34, 0.15], 0.025, 0.025, 0.20, [0.15, 0.15, 0.18], 8)
  torus([0, 0.44, 0.15], 0.09, 0.09, 0.02, [0.85, 0.2, 0.2], 12, 6)
  // 車尾定風翼（雙支架 + 翼板，高亮黃色）
  cylinder([-0.24, 0.36, -0.52], 0.02, 0.02, 0.22, [0.15, 0.15, 0.18], 6)
  cylinder([0.24, 0.36, -0.52], 0.02, 0.02, 0.22, [0.15, 0.15, 0.18], 6)
  box([0, 0.48, -0.52], [0.68, 0.04, 0.18], [0.95, 0.82, 0.18])
}

// ========================================================
// 車型 3：風火輪 (Firewheel Car) - 絕不含任何人體部位
// ========================================================
currentKind = 3
{
  // 左右兩側巨型火焰神輪（輪軸中心在 y=0.34，半徑約 0.28）
  for (const side of [-1, 1]) {
    const wx = side * 0.40
    // 鉛直外圈火焰神輪
    wheelRing([wx, 0.34, 0], 0.28, 0.05, [1.0, 0.35, 0.06], 16, 8)
    // 內輪火焰輪輻（在 YZ 平面內延伸）
    box([wx, 0.34, 0], [0.04, 0.50, 0.04], [0.95, 0.48, 0.12])
    box([wx, 0.34, 0], [0.04, 0.04, 0.50], [0.95, 0.48, 0.12])
    // 輪頂與前後飛焰焰牙裝飾
    ellipsoid([wx, 0.56, -0.10], [0.03, 0.08, 0.05], [1.0, 0.65, 0.15], 8)
    ellipsoid([wx, 0.56, 0.10], [0.03, 0.08, 0.05], [1.0, 0.65, 0.15], 8)
  }
  // 中央橫向青銅神軸（連接左右輪）
  box([0, 0.34, 0], [0.80, 0.06, 0.06], [0.45, 0.35, 0.25])
  // 中央懸浮蓮花座基底
  ellipsoid([0, 0.20, 0], [0.24, 0.10, 0.32], [0.88, 0.38, 0.52], 14)
  // 蓮瓣座靠背與扶手
  box([0, 0.32, -0.22], [0.34, 0.18, 0.06], [0.92, 0.45, 0.58])
  box([-0.20, 0.30, 0], [0.04, 0.14, 0.28], [0.92, 0.45, 0.58])
  box([0.20, 0.30, 0], [0.04, 0.14, 0.28], [0.92, 0.45, 0.58])
  // 金色操縱祥雲符印
  ellipsoid([0, 0.38, 0.16], [0.10, 0.04, 0.08], [1.0, 0.85, 0.25], 10)
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
