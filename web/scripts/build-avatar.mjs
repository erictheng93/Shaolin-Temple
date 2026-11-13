// 把 AI 生成的小沙彌白模（約 33 萬面、只有 POSITION）轉成遊戲用模型：
// 去掉地板 → 依位置分出膚色／袍／鞋 → 減面 → 拆成 body（袍與鞋，帶頂點色）與 skin（合十的手，加上程序產生的光滑頭、耳朵與頸）→ 輸出 GLB。
// 用法：node scripts/build-avatar.mjs [來源.glb] [輸出.glb] [目標三角形數]
// 之後若改用 Blender 流程（展 UV、烘焙法線），輸出同樣的 body／skin 兩個節點即可直接取代。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MeshoptSimplifier } from 'meshoptimizer'

const [src = '../3D白模/b5a31ad874d64c96b75e0465e1c34997.glb', out = 'public/models/monk.glb', target = '6000'] = process.argv.slice(2)
const HEIGHT = 1.15 // 成品身高（公尺）；來源模型高 2 個單位、腳底在 y=-1
const SHOE = [0.2, 0.18, 0.16]
// 頭不用白模的：白模的五官減面後只剩凹陷與稜角，而臉改用貼圖畫（AvatarFactory 的臉圖集）。
// 這裡直接產生一顆光滑的橢球當頭、兩顆小橢球當耳朵、一段短圓柱當頸（成品座標，公尺），白模的膚色部分只留合十的手。
const HEAD = { c: [0, 0.86, -0.005], r: [0.25, 0.24, 0.24] }
const EARS = [-1, 1].map((side) => ({ c: [side * 0.245, 0.82, -0.02], r: [0.035, 0.062, 0.046] }))
/** 頸部：光滑的短圓柱，上端埋進頭裡、下端埋進衣領。 */
const NECK = { x: 0, z: -0.01, radius: 0.09, bottom: 0.54, top: 0.68 }
/** 白模的膚色部分只保留合十的手：這個高度以上、或這個高度以上且在手的後方（頸部殘片）的都去掉。 */
const HANDS_TOP = 0.63
const NECK_SCRAPS = { above: 0.58, behindZ: 0.13 }
/** 橢球的經緯分段：完整模型要看不出輪廓的折線，遠處模型從簡。 */
const [HEAD_SEG, HEAD_RINGS] = Number(target) >= 4000 ? [48, 32] : [16, 12]

// 讀 GLB：單一 mesh、POSITION + uint32 索引
const glb = readFileSync(src)
const jsonLen = glb.readUInt32LE(12)
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString())
const bin = glb.subarray(20 + jsonLen + 8)
const prim = json.meshes[0].primitives[0]
const read = (accIndex, Type, width) => {
  const acc = json.accessors[accIndex]
  const view = json.bufferViews[acc.bufferView]
  const start = bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  return new Type(bin.buffer.slice(start, start + acc.count * width * Type.BYTES_PER_ELEMENT))
}
const pos = read(prim.attributes.POSITION, Float32Array, 3)
const srcIdx = read(prim.indices, Uint32Array, 1)

// 去掉模型自帶的地板
const kept = []
for (let i = 0; i < srcIdx.length; i += 3) {
  const [a, b, c] = [srcIdx[i], srcIdx[i + 1], srcIdx[i + 2]]
  if (pos[a * 3 + 1] < -0.985 && pos[b * 3 + 1] < -0.985 && pos[c * 3 + 1] < -0.985) continue
  kept.push(a, b, c)
}

// 依位置分類（針對合十姿勢的這尊模型）：0 袍、1 膚色（頭、頸、合十的手）、2 鞋
const count = pos.length / 3
const cls = new Uint8Array(count)
for (let i = 0; i < count; i++) {
  const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]
  cls[i] = y < -0.9 ? 2 : y > 0.1 || (z > 0.27 && Math.abs(x) < 0.12 && y > -0.2) ? 1 : 0
}
// 分類當作頂點屬性參與減面，讓膚色與袍的交界不被抹掉
const attrs = new Float32Array(count * 2)
for (let i = 0; i < count; i++) {
  attrs[i * 2] = cls[i] === 1 ? 1 : 0
  attrs[i * 2 + 1] = cls[i] === 2 ? 1 : 0
}

await MeshoptSimplifier.ready
const [idx, error] = MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(kept), pos, 3, attrs, 2, [0.5, 0.5], null, Number(target) * 3, 0.05)

// 整體算平滑法線（面積加權），拆開後頸部接縫才不會有明暗斷差
const nor = new Float32Array(pos.length)
for (let i = 0; i < idx.length; i += 3) {
  const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3]
  const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
  const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
  for (const v of [a, b, c]) for (let k = 0; k < 3; k++) nor[v + k] += n[k]
}

/** 取出符合條件的三角形，壓縮頂點並轉成遊戲座標（腳底在 y=0）。 */
function part(isSkin) {
  const remap = new Map()
  const p = [], n = [], col = [], indices = []
  const scale = HEIGHT / 2
  for (let i = 0; i < idx.length; i += 3) {
    const tri = [idx[i], idx[i + 1], idx[i + 2]]
    if (tri.filter((v) => cls[v] === 1).length >= 2 !== isSkin) continue
    if (isSkin && tri.some((v) => {
      const y = (pos[v * 3 + 1] + 1) * scale
      return y >= HANDS_TOP || (y >= NECK_SCRAPS.above && pos[v * 3 + 2] * scale < NECK_SCRAPS.behindZ)
    })) continue
    for (const v of tri) {
      let j = remap.get(v)
      if (j === undefined) {
        j = remap.size
        remap.set(v, j)
        p.push(pos[v * 3] * scale, (pos[v * 3 + 1] + 1) * scale, pos[v * 3 + 2] * scale)
        const len = Math.hypot(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]) || 1
        n.push(nor[v * 3] / len, nor[v * 3 + 1] / len, nor[v * 3 + 2] / len)
        col.push(...(cls[v] === 2 ? SHOE : [1, 1, 1]))
      }
      indices.push(j)
    }
  }
  if (isSkin) {
    for (const { c, r, seg, rings } of [{ ...HEAD, seg: HEAD_SEG, rings: HEAD_RINGS }, ...EARS.map((e) => ({ ...e, seg: 12, rings: 8 }))]) {
      const base = p.length / 3
      for (let a = 0; a <= rings; a++) {
        const phi = (a / rings) * Math.PI
        for (let b = 0; b <= seg; b++) {
          const theta = (b / seg) * Math.PI * 2
          const d = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)]
          p.push(c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2])
          // 橢球的法線：方向除以半徑後正規化
          const g = [d[0] / r[0], d[1] / r[1], d[2] / r[2]]
          const len = Math.hypot(...g)
          n.push(g[0] / len, g[1] / len, g[2] / len)
        }
      }
      for (let a = 0; a < rings; a++) {
        for (let b = 0; b < seg; b++) {
          const v = base + a * (seg + 1) + b
          if (a > 0) indices.push(v, v + seg + 1, v + 1)
          if (a < rings - 1) indices.push(v + 1, v + seg + 1, v + seg + 2)
        }
      }
    }
  }
  if (isSkin) {
    const base = p.length / 3
    const seg = 16
    for (let b = 0; b <= seg; b++) {
      const theta = (b / seg) * Math.PI * 2
      const [dx, dz] = [Math.sin(theta), Math.cos(theta)]
      for (const y of [NECK.bottom, NECK.top]) {
        p.push(NECK.x + dx * NECK.radius, y, NECK.z + dz * NECK.radius)
        n.push(dx, 0, dz)
      }
    }
    for (let b = 0; b < seg; b++) {
      const v = base + b * 2
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3)
    }
  }
  return { p: new Float32Array(p), n: new Float32Array(n), col: isSkin ? null : new Float32Array(col), indices: new Uint16Array(indices) }
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
for (const [name, isSkin] of [['body', false], ['skin', true]]) {
  const m = part(isSkin)
  if (m.p.length / 3 > 65535) throw new Error(`${name} 頂點數超過 16 位元索引上限`)
  const attributes = { POSITION: accessor(m.p, 'VEC3', 34962, true), NORMAL: accessor(m.n, 'VEC3', 34962) }
  if (m.col) attributes.COLOR_0 = accessor(m.col, 'VEC3', 34962)
  gltf.meshes.push({ name, primitives: [{ attributes, indices: accessor(m.indices, 'SCALAR', 34963) }] })
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
console.log(`${src}：${srcIdx.length / 3} 面 → ${report.join('、')}（誤差 ${error.toFixed(4)}），${(file.length / 1024).toFixed(0)} KB → ${out}`)
