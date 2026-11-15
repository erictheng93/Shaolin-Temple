import * as THREE from 'three'

/**
 * 烘焙貼圖用的第二組 UV（`uv1`）。純函式、不依賴 DOM：執行時與烘焙匯出腳本（Node）呼叫同一份程式，
 * 產生的 uv1 完全相同，所以不需要下載 UV 資料；兩邊是否一致由指紋（fingerprint）檢查。
 *
 * - 圖集（atlas）：每個 Mesh 依幾何的 groups 切成 chart（方塊每面、圓柱側面與上下蓋、屋頂每坡），
 *   chart 內沿用原本的貼圖 UV（不重疊），以實際公尺換算成一致的貼圖密度，再以 shelf packing 排進正方形。
 * - 平面投影（planar）：地面類物件直接以世界座標 xz 對應到一個矩形範圍。
 */

/** 每個 chart 四周保留的 texel 數（以圖集邊長 size 計），烘焙時以 margin 延伸填滿，避免 mipmap 混到鄰居。 */
export const ATLAS_PADDING = 6
/** 朝下的面（方塊底面、屋簷下）幾乎看不到，只給這個比例的貼圖密度。 */
const DOWNWARD_DENSITY = 0.25

export interface PlanarBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** 以世界座標 xz 投影到 bounds 的 uv1（超出範圍的部分由貼圖的 ClampToEdge 取邊緣值）。 */
export function assignPlanarUv(mesh: THREE.Mesh, b: PlanarBounds): void {
  mesh.updateWorldMatrix(true, false)
  const g = mesh.geometry
  const pos = g.attributes.position!
  const out = new Float32Array(pos.count * 2)
  const p = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
    out[i * 2] = (p.x - b.minX) / (b.maxX - b.minX)
    out[i * 2 + 1] = (p.z - b.minZ) / (b.maxZ - b.minZ)
  }
  g.setAttribute('uv1', new THREE.BufferAttribute(out, 2))
}

interface Chart {
  geometry: THREE.BufferGeometry
  start: number
  count: number
  uniform: boolean
  uMin: number
  vMin: number
  /** 每單位 uv 對應的公尺數（已乘上密度係數）。 */
  su: number
  sv: number
  /** chart 的實際大小（公尺）。 */
  w: number
  h: number
}

/** 排好的 chart 矩形（texel，含 padding），供測試檢查不重疊。 */
export interface PackedRect {
  x: number
  y: number
  w: number
  h: number
}

export interface AtlasResult {
  /** 每個 texel 的公尺數。 */
  texelSize: number
  rects: PackedRect[]
}

/**
 * 把 meshes 的幾何換成非索引的複本並寫入 uv1（同一個幾何被多個 Mesh 共用時，各自需要不同的 uv1）。
 * 新幾何交給 track 登記釋放。geometry.userData.lightmap === 'uniform' 的幾何整個對應到單一 texel（小物件）。
 */
export function assignAtlasUvs(
  meshes: readonly THREE.Mesh[],
  size: number,
  track: <T extends THREE.BufferGeometry>(g: T) => T,
): AtlasResult {
  const charts: Chart[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const n = new THREE.Vector3()
  const tu = new THREE.Vector3()
  const tv = new THREE.Vector3()
  for (const mesh of meshes) {
    const src = mesh.geometry
    const uniform = src.userData.lightmap === 'uniform' || !src.attributes.uv
    const g = track(src.index ? src.toNonIndexed() : src.clone())
    g.userData = { ...src.userData }
    mesh.geometry = g
    mesh.updateWorldMatrix(true, false)
    const pos = g.attributes.position!
    const uv = g.attributes.uv
    const ranges = uniform || g.groups.length === 0 ? [{ start: 0, count: pos.count }] : g.groups
    for (const r of ranges) {
      const chart: Chart = { geometry: g, start: r.start, count: r.count, uniform, uMin: 0, vMin: 0, su: 0, sv: 0, w: 0, h: 0 }
      charts.push(chart)
      if (uniform || !uv) continue
      let uMin = Infinity
      let vMin = Infinity
      let uMax = -Infinity
      let vMax = -Infinity
      let area = 0
      let suSum = 0
      let svSum = 0
      let ny = 0
      for (let i = r.start; i < r.start + r.count; i += 3) {
        a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
        b.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld)
        c.fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld)
        const u0 = uv.getX(i)
        const v0 = uv.getY(i)
        const du1 = uv.getX(i + 1) - u0
        const dv1 = uv.getY(i + 1) - v0
        const du2 = uv.getX(i + 2) - u0
        const dv2 = uv.getY(i + 2) - v0
        for (const k of [0, 1, 2]) {
          const u = uv.getX(i + k)
          const v = uv.getY(i + k)
          uMin = Math.min(uMin, u)
          vMin = Math.min(vMin, v)
          uMax = Math.max(uMax, u)
          vMax = Math.max(vMax, v)
        }
        e1.subVectors(b, a)
        e2.subVectors(c, a)
        n.crossVectors(e1, e2)
        const triArea = n.length() / 2
        const det = du1 * dv2 - du2 * dv1
        if (triArea < 1e-9 || Math.abs(det) < 1e-12) continue
        // 解出 ∂P/∂u、∂P/∂v：每單位 uv 在世界空間的長度
        tu.copy(e1).multiplyScalar(dv2).addScaledVector(e2, -dv1).divideScalar(det)
        tv.copy(e2).multiplyScalar(du1).addScaledVector(e1, -du2).divideScalar(det)
        suSum += tu.length() * triArea
        svSum += tv.length() * triArea
        ny += n.y / 2
        area += triArea
      }
      if (area === 0 || !Number.isFinite(uMin)) {
        chart.uniform = true
        continue
      }
      const density = ny / area < -0.7 ? DOWNWARD_DENSITY : 1
      chart.uMin = uMin
      chart.vMin = vMin
      chart.su = (suSum / area) * density
      chart.sv = (svSum / area) * density
      chart.w = (uMax - uMin) * chart.su
      chart.h = (vMax - vMin) * chart.sv
    }
  }

  // 二分搜尋最小的 texel 大小（公尺），使全部 chart 排得進 size × size。
  const pad = ATLAS_PADDING
  const dims = (ch: Chart, texel: number) => {
    const w = Math.max(1, Math.ceil(ch.w / texel)) + pad * 2
    const h = Math.max(1, Math.ceil(ch.h / texel)) + pad * 2
    return h > w ? { w: h, h: w, rotate: true } : { w, h, rotate: false }
  }
  const pack = (texel: number): Array<PackedRect & { rotate: boolean }> | null => {
    const d = charts.map((ch) => dims(ch, texel))
    const order = d.map((_, i) => i).sort((i, j) => d[j]!.h - d[i]!.h || d[j]!.w - d[i]!.w || i - j)
    const placed: Array<PackedRect & { rotate: boolean }> = new Array(charts.length)
    let x = 0
    let y = 0
    let shelf = 0
    for (const i of order) {
      const r = d[i]!
      if (r.w > size) return null
      if (x + r.w > size) {
        y += shelf
        x = 0
        shelf = 0
      }
      if (y + r.h > size) return null
      placed[i] = { x, y, w: r.w, h: r.h, rotate: r.rotate }
      x += r.w
      shelf = Math.max(shelf, r.h)
    }
    return placed
  }
  const totalArea = charts.reduce((s, ch) => s + ch.w * ch.h, 0)
  let lo = Math.sqrt(totalArea) / size
  let hi = Math.max(lo, 1e-4) * 4
  while (!pack(hi)) hi *= 2
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2
    if (pack(mid)) hi = mid
    else lo = mid
  }
  const texel = hi
  const placed = pack(texel)!

  // 寫入 uv1
  for (const g of new Set(charts.map((ch) => ch.geometry))) {
    g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(g.attributes.position!.count * 2), 2))
  }
  charts.forEach((ch, i) => {
    const r = placed[i]!
    const out = ch.geometry.attributes.uv1!.array as Float32Array
    const uv = ch.geometry.attributes.uv
    for (let k = ch.start; k < ch.start + ch.count; k++) {
      let lx: number
      let ly: number
      if (ch.uniform || !uv) {
        lx = ly = 0.5
      } else {
        lx = ((uv.getX(k) - ch.uMin) * ch.su) / texel
        ly = ((uv.getY(k) - ch.vMin) * ch.sv) / texel
        if (r.rotate) [lx, ly] = [ly, lx]
      }
      out[k * 2] = (r.x + pad + lx) / size
      out[k * 2 + 1] = (r.y + pad + ly) / size
    }
  })
  return { texelSize: texel, rects: placed.map(({ x, y, w, h }) => ({ x, y, w, h })) }
}

/**
 * 指紋：64 位元（兩個 FNV-1a 32）雜湊，輸入先量化，避免不同 JS 引擎的三角函式最後一位不同造成誤判。
 */
export class Fingerprint {
  private h1 = 0x811c9dc5
  private h2 = 0x01000193 ^ 0x5bd1e995

  int(v: number): void {
    // 逐位元組混入，兩個雜湊用不同的質數
    for (let s = 0; s < 32; s += 8) {
      const byte = (v >>> s) & 0xff
      this.h1 = Math.imul(this.h1 ^ byte, 0x01000193)
      this.h2 = Math.imul(this.h2 ^ byte, 0x0100019d)
    }
  }

  /** 以 step 量化後混入。 */
  num(v: number, step: number): void {
    this.int(Math.round(v / step) | 0)
  }

  digest(): string {
    const hex = (x: number) => (x >>> 0).toString(16).padStart(8, '0')
    return hex(this.h1) + hex(this.h2)
  }
}
