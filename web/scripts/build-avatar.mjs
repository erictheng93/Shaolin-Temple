// 產生 Q 版小沙彌公仔模型：全部由光滑的基本形狀組成（橢球、旋轉體），沒有稜角。
// 輸出兩個節點：body（袍、袖子、鞋，帶頂點色）與 skin（頭、耳朵、合十的手）。
// 用法：node scripts/build-avatar.mjs [輸出.glb] [細緻度：1 完整模型、0 遠處用的低面數模型]
// 之後若改用 Blender 流程（展 UV、烘焙法線），輸出同樣的 body／skin 兩個節點即可直接取代。
// 臉不在模型上，由 AvatarFactory 的臉圖集貼在頭的正面（+z）。單位公尺，腳底在 y=0。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [out = 'public/models/monk.glb', detail = '1'] = process.argv.slice(2)
const FINE = detail === '1'
/** 圓周分段數：完整模型要看不出輪廓的折線，遠處模型從簡。 */
const seg = (n) => (FINE ? n : Math.max(8, Math.round(n / 3)))

// 頂點色乘上袍色（instanceColor）：袍 1、袖口略深、鞋接近黑。
const ROBE = [1, 1, 1]
const TRIM = [0.74, 0.74, 0.74]
const SHOE = [0.2, 0.18, 0.16]

const HEAD = { c: [0, 0.86, -0.005], r: [0.25, 0.24, 0.24] }
/** 袍的輪廓（由上到下的 [半徑, 高度]）：肩膀藏在頭的下緣裡，往下擺成鐘形，下襬收進去一點。 */
const ROBE_PROFILE = [
  [0, 0.69],
  [0.07, 0.68],
  [0.115, 0.63],
  [0.14, 0.55],
  [0.165, 0.42],
  [0.195, 0.24],
  [0.215, 0.12],
  [0.21, 0.075],
  [0.17, 0.06],
  [0, 0.08],
]
/** 袍的前後厚度相對左右寬度的比例。 */
const ROBE_DEPTH = 0.9

const mesh = () => ({ p: [], n: [], col: [], indices: [] })
const norm = (v) => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** 把 rings × (segs+1) 的格點接成三角形；格點由上到下、繞 y 軸排列。 */
function grid(m, base, rings, segs) {
  for (let a = 0; a < rings; a++) {
    for (let b = 0; b < segs; b++) {
      const v = base + a * (segs + 1) + b
      m.indices.push(v, v + segs + 1, v + 1, v + 1, v + segs + 1, v + segs + 2)
    }
  }
}

/** 橢球。axis 有值時，橢球的 y 軸（r[1]）對準這個方向。 */
function ellipsoid(m, c, r, color, segs, axis = [0, 1, 0]) {
  const y = norm(axis)
  const x = norm(cross(Math.abs(y[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0], y))
  const z = cross(x, y)
  const world = (v) => [0, 1, 2].map((k) => x[k] * v[0] + y[k] * v[1] + z[k] * v[2])
  const rings = Math.max(6, Math.round(segs * 0.66))
  const base = m.p.length / 3
  for (let a = 0; a <= rings; a++) {
    const phi = (a / rings) * Math.PI
    for (let b = 0; b <= segs; b++) {
      const theta = (b / segs) * Math.PI * 2
      const d = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)]
      const at = world([d[0] * r[0], d[1] * r[1], d[2] * r[2]])
      m.p.push(c[0] + at[0], c[1] + at[1], c[2] + at[2])
      // 橢球的法線：方向除以半徑後正規化
      m.n.push(...norm(world([d[0] / r[0], d[1] / r[1], d[2] / r[2]])))
      m.col.push(...color)
    }
  }
  grid(m, base, rings, segs)
}

/** 旋轉體：輪廓先以 Catmull-Rom 內插成平滑曲線，再繞 y 軸一圈。 */
function lathe(m, profile, color, segs, depth) {
  const steps = FINE ? 4 : 2
  const at = (i) => profile[Math.min(profile.length - 1, Math.max(0, i))]
  const curve = []
  for (let i = 0; i < profile.length - 1; i++) {
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const point = [0, 1].map((k) => {
        const [p0, p1, p2, p3] = [at(i - 1)[k], at(i)[k], at(i + 1)[k], at(i + 2)[k]]
        return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t)
      })
      curve.push([Math.max(0, point[0]), point[1]])
    }
  }
  curve.push(profile.at(-1))
  const base = m.p.length / 3
  curve.forEach(([r, y], i) => {
    const [a, b] = [curve[Math.max(0, i - 1)], curve[Math.min(curve.length - 1, i + 1)]]
    // 輪廓由上往下走；往外的法線是切線順時針轉 90 度
    const [nr, ny] = [a[1] - b[1], b[0] - a[0]]
    for (let s = 0; s <= segs; s++) {
      const theta = (s / segs) * Math.PI * 2
      const [sx, sz] = [Math.sin(theta), Math.cos(theta)]
      m.p.push(sx * r, y, sz * r * depth)
      m.n.push(...norm([sx * nr, ny, (sz * nr) / depth]))
      m.col.push(...color)
    }
  })
  grid(m, base, curve.length - 1, segs)
}

const body = mesh()
lathe(body, ROBE_PROFILE, ROBE, seg(32), ROBE_DEPTH)
for (const side of [-1, 1]) {
  // 袖子：從肩膀垂到胸前合十處的寬袖
  ellipsoid(body, [side * 0.09, 0.55, 0.08], [0.062, 0.13, 0.066], ROBE, seg(24), [-side * 0.11, -0.1, 0.17])
  // 袖口
  ellipsoid(body, [side * 0.04, 0.505, 0.158], [0.05, 0.022, 0.052], TRIM, seg(20), [-side * 0.11, -0.1, 0.17])
  // 鞋：從下襬前緣露出鞋尖
  ellipsoid(body, [side * 0.075, 0.036, 0.135], [0.058, 0.036, 0.09], SHOE, seg(20))
}

const skin = mesh()
ellipsoid(skin, HEAD.c, HEAD.r, ROBE, seg(40))
for (const side of [-1, 1]) {
  ellipsoid(skin, [side * 0.245, 0.82, -0.02], [0.035, 0.062, 0.046], ROBE, seg(16))
  // 合十的手：兩片手掌貼在一起，指尖朝上略往前
  ellipsoid(skin, [side * 0.014, 0.535, 0.19], [0.02, 0.06, 0.034], ROBE, seg(16), [0, 1, -0.25])
}

// 寫 GLB
const chunks = []
const gltf = { asset: { version: '2.0', generator: 'shaolin-temple build-avatar' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [] }
let offset = 0
const accessor = (array, type, target, withBounds) => {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength)
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)])
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target })
  chunks.push(padded)
  offset += padded.length
  const width = type === 'SCALAR' ? 1 : 3
  const acc = { bufferView: gltf.bufferViews.length - 1, componentType: array instanceof Uint16Array ? 5123 : 5126, count: array.length / width, type }
  if (withBounds) {
    acc.min = [0, 1, 2].map((k) => Math.min(...array.filter((_, i) => i % 3 === k)))
    acc.max = [0, 1, 2].map((k) => Math.max(...array.filter((_, i) => i % 3 === k)))
  }
  gltf.accessors.push(acc)
  return gltf.accessors.length - 1
}
const report = []
for (const [name, m] of [['body', body], ['skin', skin]]) {
  if (m.p.length / 3 > 65535) throw new Error(`${name} 頂點數超過 16 位元索引上限`)
  const attributes = { POSITION: accessor(new Float32Array(m.p), 'VEC3', 34962, true), NORMAL: accessor(new Float32Array(m.n), 'VEC3', 34962) }
  if (name === 'body') attributes.COLOR_0 = accessor(new Float32Array(m.col), 'VEC3', 34962)
  gltf.meshes.push({ name, primitives: [{ attributes, indices: accessor(new Uint16Array(m.indices), 'SCALAR', 34963) }] })
  gltf.nodes.push({ name, mesh: gltf.meshes.length - 1 })
  report.push(`${name} ${m.indices.length / 3} 面／${m.p.length / 3} 頂點`)
}
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
const file = Buffer.concat([header, chunkHeader(jsonBuf.length, 0x4e4f534a), jsonBuf, chunkHeader(offset, 0x004e4942), ...chunks])
writeFileSync(out, file)
console.log(`${report.join('、')}，${(file.length / 1024).toFixed(0)} KB → ${out}`)
