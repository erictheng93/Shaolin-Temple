// 產生 Q 版小沙彌公仔模型：全部由光滑的基本形狀組成（橢球、旋轉體），沒有稜角。
// 輸出兩個節點：body（袍、袖子、鞋、念珠，帶頂點色與衣裝屬性 _OUTFIT）與 skin（頭、耳朵、合十的手）。
// 用法：node scripts/build-avatar.mjs [輸出.glb] [細緻度：1 完整模型、0 遠處用的低面數模型]
// 之後若改用 Blender 流程（展 UV、烘焙法線），輸出同樣的 body／skin 兩個節點即可直接取代。
// 臉不在模型上，由 AvatarFactory 的臉圖集貼在頭的正面（+z）。單位公尺，腳底在 y=0。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [out = 'public/models/monk.glb', detail = '1'] = process.argv.slice(2)
const FINE = detail === '1'
/** 圓周分段數：完整模型取 fine，遠處模型取 lod。 */
const seg = (fine, lod) => (FINE ? fine : lod)
/** 橢球的緯度環數：只有完整模型指定，遠處模型維持預設。 */
const rg = (n) => (FINE ? n : undefined)

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

/**
 * 衣裝屬性 _OUTFIT（VEC2，只在 body）：AvatarFactory 依衣裝編號在著色器裡上色。
 * x：到袈裟披帶中線的有號距離（公尺）。披帶中線是一個含 z 軸的平面，從左肩（角色自身的左，+x）斜到右腰（-x），
 *    所以前後都是左肩高、右腰低，右肩不在帶上（偏袒右肩）。距離在平面上是線性的，三角形內插後完全準確，
 *    片段著色器以 smoothstep 做門檻，低面數的遠處模型邊緣一樣俐落。鞋子與念珠填 NO_SASH，永遠不在帶上。
 * y：念珠為 1、其餘 0；不戴念珠的衣裝在頂點著色器把念珠縮到一點。
 */
const SASH_FROM = [0.13, 0.66]
const SASH_TO = [-0.19, 0.3]
const SASH_N = (() => {
  const [dx, dy] = [SASH_TO[0] - SASH_FROM[0], SASH_TO[1] - SASH_FROM[1]]
  const l = Math.hypot(dx, dy)
  return [-dy / l, dx / l]
})()
const sashDistance = (x, y) => SASH_N[0] * (x - SASH_FROM[0]) + SASH_N[1] * (y - SASH_FROM[1])
const NO_SASH = 9
/** 正在建構的部分屬於哪一類（'robe' 依位置算披帶距離、'shoe' 不在帶上、'bead' 念珠）。 */
let part = 'robe'
const outfitOf = (x, y) => (part === 'bead' ? [NO_SASH, 1] : part === 'shoe' ? [NO_SASH, 0] : [sashDistance(x, y), 0])

const mesh = () => ({ p: [], n: [], col: [], out: [], indices: [] })
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
function ellipsoid(m, c, r, color, segs, axis = [0, 1, 0], ringCount = Math.max(6, Math.round(segs * 0.66))) {
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
      m.out.push(...outfitOf(c[0] + at[0], c[1] + at[1]))
      // 橢球的法線：方向除以半徑後正規化
      m.n.push(...norm(world([d[0] / r[0], d[1] / r[1], d[2] / r[2]])))
      m.col.push(...color)
    }
  }
  grid(m, base, rings, segs)
}

/** 旋轉體：輪廓先以 Catmull-Rom 內插成平滑曲線，再繞 y 軸一圈。 */
function lathe(m, profile, color, segs, depth) {
  const steps = FINE ? 3 : 2
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
      m.out.push(...outfitOf(sx * r, y))
      m.n.push(...norm([sx * nr, ny, (sz * nr) / depth]))
      m.col.push(...color)
    }
  })
  grid(m, base, curve.length - 1, segs)
}

const body = mesh()
lathe(body, ROBE_PROFILE, ROBE, seg(24, 11), ROBE_DEPTH)
for (const side of [-1, 1]) {
  // 袖子：從肩膀垂到胸前合十處的寬袖
  ellipsoid(body, [side * 0.09, 0.55, 0.08], [0.062, 0.13, 0.066], ROBE, seg(16, 8), [-side * 0.11, -0.1, 0.17], rg(10))
  // 袖口
  ellipsoid(body, [side * 0.04, 0.505, 0.158], [0.05, 0.022, 0.052], TRIM, seg(12, 8), [-side * 0.11, -0.1, 0.17], rg(6))
  // 鞋：從下襬前緣露出鞋尖
  part = 'shoe'
  ellipsoid(body, [side * 0.075, 0.036, 0.135], [0.058, 0.036, 0.09], SHOE, seg(12, 8), undefined, rg(6))
  part = 'robe'
}

// 念珠（只在完整模型；遠處看不出來，省下面數）：一圈斜掛在肩上的珠子，前低後高，從下巴下方露出、落在合十的手後面。
// 後半圈被頭擋住的珠子不產生。頂點色為 1，顏色完全由衣裝決定。
if (FINE) {
  part = 'bead'
  const BEADS = 24
  const inHead = ([x, y, z]) => (x / HEAD.r[0]) ** 2 + ((y - HEAD.c[1]) / HEAD.r[1]) ** 2 + ((z - HEAD.c[2]) / HEAD.r[2]) ** 2 < 0.92
  for (let i = 0; i < BEADS; i++) {
    const t = (i / BEADS) * Math.PI * 2
    const c = [0.137 * Math.sin(t), 0.635 - 0.045 * Math.cos(t), 0.012 + 0.125 * Math.cos(t)]
    if (inHead(c)) continue
    ellipsoid(body, c, [0.017, 0.017, 0.017], ROBE, 6, undefined, 4)
  }
  // 前方垂下的母珠，較大一顆
  ellipsoid(body, [0, 0.567, 0.142], [0.022, 0.022, 0.022], ROBE, 8, undefined, 5)
  part = 'robe'
}

const skin = mesh()
ellipsoid(skin, HEAD.c, HEAD.r, ROBE, seg(32, 13), undefined, rg(21))
for (const side of [-1, 1]) {
  ellipsoid(skin, [side * 0.245, 0.82, -0.02], [0.035, 0.062, 0.046], ROBE, seg(10, 8), undefined, rg(7))
  // 合十的手：兩片手掌貼在一起，指尖朝上略往前
  ellipsoid(skin, [side * 0.014, 0.535, 0.19], [0.02, 0.06, 0.034], ROBE, seg(10, 8), [0, 1, -0.25], rg(7))
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
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type]
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
  if (name === 'body') {
    attributes.COLOR_0 = accessor(new Float32Array(m.col), 'VEC3', 34962)
    // 自訂屬性依 glTF 規定以底線開頭；three 的 GLTFLoader 載入後名稱轉小寫（_outfit）
    attributes._OUTFIT = accessor(new Float32Array(m.out), 'VEC2', 34962)
  }
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
