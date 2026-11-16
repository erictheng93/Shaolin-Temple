// 產生 Q 版小沙彌公仔模型：全部由光滑的基本形狀組成（橢球、旋轉體），沒有稜角。
// 輸出兩個節點：body（袍、袖子、鞋、念珠與短褂的各部分，帶頂點色與衣裝屬性 _OUTFIT）與
// skin（頭、耳朵、合十的手與斗笠，帶頂點色與部位屬性 _PART）。
// 用法：node scripts/build-avatar.mjs [輸出.glb] [細緻度：1 完整模型、0 遠處用的低面數模型]
// 之後若改用 Blender 流程（展 UV、烘焙法線），輸出同樣的 body／skin 兩個節點與屬性即可直接取代。
// 臉不在模型上，由 AvatarFactory 的臉圖集貼在頭的正面（+z）。單位公尺，腳底在 y=0。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [out = 'public/models/monk.glb', detail = '1'] = process.argv.slice(2)
const FINE = detail === '1'
/** 圓周分段數：完整模型取 fine，遠處模型取 lod。 */
const seg = (fine, lod) => (FINE ? fine : lod)
/** 橢球的緯度環數：只有完整模型指定，遠處模型維持預設。 */
const rg = (n) => (FINE ? n : undefined)

// 頂點色乘上衣裝的顏色（instanceColor）：袍 1、袖口略深、鞋接近黑。
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
/** 袍的前後厚度相對左右寬度的比例（短褂、腰帶相同）。 */
const ROBE_DEPTH = 0.9

/**
 * 武僧短褂的上衣輪廓：肩膀與袍相同（頭、袖子、合十的手都不動），往下收成直筒，及臀（約 0.26 公尺）略往外擺。
 * 遠處模型用較少的點。
 */
const TUNIC_PROFILE = FINE
  ? [
      [0, 0.69],
      [0.07, 0.68],
      [0.115, 0.63],
      [0.14, 0.55],
      [0.152, 0.44],
      [0.162, 0.33],
      [0.175, 0.27],
      [0.172, 0.25],
      [0.13, 0.24],
      [0, 0.25],
    ]
  : [
      [0, 0.69],
      [0.115, 0.63],
      [0.15, 0.46],
      [0.17, 0.28],
      [0.14, 0.245],
      [0, 0.25],
    ]
/** 腰帶：繞在短褂外面的一圈（上衣在 y 0.42 附近半徑約 0.152）。 */
const BELT_PROFILE = FINE
  ? [
      [0.148, 0.448],
      [0.161, 0.441],
      [0.164, 0.42],
      [0.161, 0.4],
      [0.148, 0.393],
    ]
  : [
      [0.163, 0.442],
      [0.163, 0.398],
    ]
/** 兩條腿的中心（x 取 ±，z 略偏前，腳踝落在鞋的後半上方）。 */
const LEG = { x: 0.078, z: 0.035 }
/** 長褲：寬鬆的褲管，從短褂下面伸出，下端收進綁腿。 */
const TROUSER_PROFILE = FINE
  ? [
      [0.07, 0.3],
      [0.084, 0.25],
      [0.083, 0.205],
      [0.068, 0.17],
      [0.058, 0.155],
    ]
  : [
      [0.082, 0.3],
      [0.062, 0.16],
    ]
/** 綁腿：小腿上一圈圈的布條（完整模型每一環交替深淺），下端藏進鞋裡。 */
const LEGGING_PROFILE = FINE
  ? [
      [0.067, 0.188],
      [0.065, 0.165],
      [0.062, 0.14],
      [0.058, 0.115],
      [0.056, 0.09],
      [0.054, 0.068],
      [0.045, 0.055],
    ]
  : [
      [0.065, 0.18],
      [0.052, 0.06],
    ]

/**
 * 斗笠（在 skin，跟著頭的剛體姿勢）：竹編的寬沿圓錐，帽沿中心在頭頂下方、往後仰，正面的帽沿抬高，
 * 預設鏡頭（俯角約 0.4 弧度）看得到整個眼睛與嘴。local 座標：帽沿平面中心為原點、圓錐朝 +y。
 */
const HAT = { radius: 0.4, height: 0.2, y: 0.975, z: -0.01, tilt: 0.16 }

/**
 * 衣裝屬性 _OUTFIT（VEC2，只在 body）：AvatarFactory 依衣裝編號在著色器裡上色。
 * x：到袈裟披帶中線的有號距離（公尺）。披帶中線是一個含 z 軸的平面，從左肩（角色自身的左，+x）斜到右腰（-x），
 *    所以前後都是左肩高、右腰低，右肩不在帶上（偏袒右肩）。距離在平面上是線性的，三角形內插後完全準確，
 *    片段著色器以 smoothstep 做門檻，低面數的遠處模型邊緣一樣俐落。不會有披帶的部位填 NO_SASH。
 * y：部位（BODY_PART，與 AvatarFactory 的 BODY_PART 相同）。哪些部位要顯示由衣裝決定，不顯示的部位在頂點著色器縮到一點。
 */
const BODY_PART = { shared: 0, bead: 1, robe: 2, tunic: 3, trousers: 4, leggings: 5, belt: 6 }
const SASH_FROM = [0.13, 0.66]
const SASH_TO = [-0.19, 0.3]
const SASH_N = (() => {
  const [dx, dy] = [SASH_TO[0] - SASH_FROM[0], SASH_TO[1] - SASH_FROM[1]]
  const l = Math.hypot(dx, dy)
  return [-dy / l, dx / l]
})()
const sashDistance = (x, y) => SASH_N[0] * (x - SASH_FROM[0]) + SASH_N[1] * (y - SASH_FROM[1])
const NO_SASH = 9
/** 正在建構的部分：part 是 BODY_PART（skin 用 SKIN_PART），sash 表示這個部分是否計算披帶距離。 */
let part = BODY_PART.robe
let sash = true
const outfitOf = (x, y) => [sash ? sashDistance(x, y) : NO_SASH, part]
/** 在 body 上建構一個部分（期間 outfitOf 依此填屬性）。 */
function piece(p, withSash, build) {
  ;[part, sash] = [p, withSash]
  build()
  ;[part, sash] = [BODY_PART.robe, true]
}

/** skin 的部位屬性 _PART（SCALAR）：0 皮膚（頭、耳朵、手）、1 斗笠。臉只從皮膚取，斗笠不戴時縮到一點。 */
const SKIN_PART = { skin: 0, hat: 1 }

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

/**
 * 把一條輪廓（[半徑, 高度]，不再內插）繞一條鉛直軸轉一圈。
 * color 可以是固定的 RGB，或依輪廓點索引回傳 RGB 的函式（例如綁腿一環深一環淺）。
 * opts.center：軸的 [x, z]；opts.xform：(點, 法線) → [點, 法線]，把整個旋轉體放到別處（斗笠的後仰與位置）。
 */
function revolve(m, curve, color, segs, depth, opts = {}) {
  const [cx, cz] = opts.center ?? [0, 0]
  const colorAt = typeof color === 'function' ? color : () => color
  const base = m.p.length / 3
  curve.forEach(([r, y], i) => {
    const [a, b] = [curve[Math.max(0, i - 1)], curve[Math.min(curve.length - 1, i + 1)]]
    // 輪廓由上往下走；往外的法線是切線順時針轉 90 度
    const [nr, ny] = [a[1] - b[1], b[0] - a[0]]
    for (let s = 0; s <= segs; s++) {
      const theta = (s / segs) * Math.PI * 2
      const [sx, sz] = [Math.sin(theta), Math.cos(theta)]
      let p = [cx + sx * r, y, cz + sz * r * depth]
      let n = norm([sx * nr, ny, (sz * nr) / depth])
      if (opts.xform) [p, n] = opts.xform(p, n)
      m.p.push(...p)
      m.out.push(...outfitOf(p[0], p[1]))
      m.n.push(...n)
      m.col.push(...colorAt(i))
    }
  })
  grid(m, base, curve.length - 1, segs)
}

/** 旋轉體：輪廓先以 Catmull-Rom 內插成平滑曲線（每段 steps 個點），再繞鉛直軸一圈。 */
function lathe(m, profile, color, segs, depth, { steps = FINE ? 3 : 2, center } = {}) {
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
  revolve(m, curve, color, segs, depth, { center })
}

/** 袖子的方向：從肩膀斜向胸前合十處。 */
const sleeveAxis = (side) => [-side * 0.11, -0.1, 0.17]

const body = mesh()
// 袍（鐘形）與寬袖口：只有袍的輪廓（非短褂）的衣裝顯示
lathe(body, ROBE_PROFILE, ROBE, seg(24, 11), ROBE_DEPTH)
for (const side of [-1, 1]) {
  // 袖子：從肩膀垂到胸前合十處，袍與短褂共用（肩膀與手的位置相同）
  piece(BODY_PART.shared, true, () =>
    ellipsoid(body, [side * 0.09, 0.55, 0.08], [0.062, 0.13, 0.066], ROBE, seg(16, 8), sleeveAxis(side), rg(10)),
  )
  // 袍的袖口
  ellipsoid(body, [side * 0.04, 0.505, 0.158], [0.05, 0.022, 0.052], TRIM, seg(12, 8), sleeveAxis(side), rg(6))
  // 鞋：從下襬前緣露出鞋尖，兩種輪廓共用
  piece(BODY_PART.shared, false, () =>
    ellipsoid(body, [side * 0.075, 0.036, 0.135], [0.058, 0.036, 0.09], SHOE, seg(12, 8), undefined, rg(6)),
  )
}

// 念珠（只在完整模型；遠處看不出來，省下面數）：一圈斜掛在肩上的珠子，前低後高，從下巴下方露出、落在合十的手後面。
// 後半圈被頭擋住的珠子不產生。頂點色為 1，顏色完全由衣裝決定。
if (FINE) {
  piece(BODY_PART.bead, false, () => {
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
  })
}

// 武僧短褂：上衣（及臀）、腰帶、長褲、綁腿、束袖口。只有短褂的衣裝顯示，袍的衣裝縮成一點。
// 上衣用衣裝的主色（robe），褲、綁腿、腰帶（與袖口的束帶）各取衣裝的 tunic 色。
piece(BODY_PART.tunic, false, () => lathe(body, TUNIC_PROFILE, ROBE, seg(24, 11), ROBE_DEPTH, { steps: FINE ? 2 : 1 }))
piece(BODY_PART.belt, false, () => {
  revolve(body, BELT_PROFILE, ROBE, seg(24, 10), ROBE_DEPTH)
  if (FINE) {
    // 腰帶在左前方打的結
    ellipsoid(body, [0.055, 0.418, 0.142], [0.026, 0.021, 0.016], ROBE, 8, undefined, 5)
    for (const side of [-1, 1]) {
      // 束袖口：寬袖的末端紮起來的一圈
      ellipsoid(body, [side * 0.034, 0.499, 0.167], [0.043, 0.02, 0.045], ROBE, 12, sleeveAxis(side), 6)
    }
  }
})
for (const side of [-1, 1]) {
  const center = [side * LEG.x, LEG.z]
  piece(BODY_PART.trousers, false, () => lathe(body, TROUSER_PROFILE, ROBE, seg(12, 6), 1, { steps: FINE ? 2 : 1, center }))
  // 綁腿一環深一環淺，看得出一圈圈纏上去的布條
  const wrap = (i) => (FINE && i % 2 === 1 ? [0.84, 0.84, 0.82] : ROBE)
  piece(BODY_PART.leggings, false, () => revolve(body, LEGGING_PROFILE, wrap, seg(12, 6), 1, { center }))
}

const skin = mesh()
part = SKIN_PART.skin
ellipsoid(skin, HEAD.c, HEAD.r, ROBE, seg(32, 13), undefined, rg(21))
for (const side of [-1, 1]) {
  ellipsoid(skin, [side * 0.245, 0.82, -0.02], [0.035, 0.062, 0.046], ROBE, seg(10, 8), undefined, rg(7))
  // 合十的手：兩片手掌貼在一起，指尖朝上略往前
  ellipsoid(skin, [side * 0.014, 0.535, 0.19], [0.02, 0.06, 0.034], ROBE, seg(10, 8), [0, 1, -0.25], rg(7))
}

// 斗笠：上面是竹編的圓錐（頂端一顆小頂、往外一圈深一圈淺、帽沿收一道略深的邊），下面是陰暗的內側。
// 頂點色是竹編的明暗，顏色由衣裝的 hat 色決定。
{
  part = SKIN_PART.hat
  const { radius: R, height: H } = HAT
  const [cos, sin] = [Math.cos(HAT.tilt), Math.sin(HAT.tilt)]
  // 繞 x 軸轉 -tilt（正面往上抬）再移到頭頂
  const rot = ([x, y, z]) => [x, y * cos + z * sin, -y * sin + z * cos]
  const xform = (p, n) => {
    const q = rot(p)
    return [[q[0], q[1] + HAT.y, q[2] + HAT.z], rot(n)]
  }
  const coneY = (r) => H * (1 - r / R) ** 1.12
  const top = FINE
    ? [[0, H + 0.03], [0.018, H + 0.026], [0.03, coneY(0.03) + 0.008], ...[0.04, 0.09, 0.15, 0.21, 0.27, 0.33, 0.375].map((r) => [r, coneY(r)]), [R, 0]]
    : [[0, H], [R * 0.5, coneY(R * 0.5)], [R, 0]]
  // 頂端略深，往外一圈深一圈淺（編織的紋路），最外緣的收邊略深
  const weave = (i) => {
    if (!FINE) return i === 0 ? [0.82, 0.82, 0.82] : [1, 1, 1]
    if (i <= 3) return [0.72, 0.7, 0.68]
    if (i === top.length - 1) return [0.8, 0.8, 0.8]
    return i % 2 === 0 ? [1, 1, 1] : [0.8, 0.8, 0.8]
  }
  revolve(skin, top, weave, seg(28, 12), 1, { xform })
  // 帽沿的邊與內側（由外往內走，法線朝下、朝內）
  const under = FINE
    ? [[R, 0], [R + 0.004, -0.009], [R - 0.012, -0.016], [0, H - 0.03]]
    : [[R, 0], [0, H - 0.03]]
  const shade = (i) => (i <= 1 ? [0.8, 0.8, 0.8] : [0.5, 0.5, 0.5])
  revolve(skin, under, FINE ? shade : [0.55, 0.55, 0.55], seg(28, 12), 1, { xform })
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
  const attributes = {
    POSITION: accessor(new Float32Array(m.p), 'VEC3', 34962, true),
    NORMAL: accessor(new Float32Array(m.n), 'VEC3', 34962),
    COLOR_0: accessor(new Float32Array(m.col), 'VEC3', 34962),
  }
  // 自訂屬性依 glTF 規定以底線開頭；three 的 GLTFLoader 載入後名稱轉小寫（_outfit、_part）
  if (name === 'body') attributes._OUTFIT = accessor(new Float32Array(m.out), 'VEC2', 34962)
  else attributes._PART = accessor(new Float32Array(m.out.filter((_, i) => i % 2 === 1)), 'SCALAR', 34962)
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
