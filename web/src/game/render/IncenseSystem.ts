import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { CenserDef, ZoneId } from '../world/zones'
import type { ResourceTracker } from './ResourceTracker'
import { setAttributeUpdateRange } from './bufferRange'

/** 一支香燒完的時間（毫秒）：長度從 100% 燒到 BURNT_FRACTION 後消失，最後幾秒煙漸淡。 */
export const STICK_LIFE_MS = 120_000
const BURNT_FRACTION = 0.35
const SMOKE_FADE_MS = 6_000
/** 每支香同時飄著的煙團數。 */
const PUFFS_PER_STICK = 3
const STICK_COLOR = '#7a2e1c'
const EMBER_COLOR = '#ff7a2a'

/**
 * 香的幾何：高 1、底在原點的細圓柱，頂端 4% 是燃燒中的橘紅色（頂點色）。由每個實例的縮放決定粗細與長短，
 * 燒短時頂端仍在最上面。香爐裡的香與角色手上的香共用這個造型。
 */
export function createIncenseStickGeometry(): THREE.BufferGeometry {
  const part = (y0: number, y1: number, color: string) => {
    const g = new THREE.CylinderGeometry(1, 1, y1 - y0, 5, 1, false).toNonIndexed()
    g.translate(0, (y0 + y1) / 2, 0)
    const c = new THREE.Color(color)
    const n = g.attributes.position!.count
    g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3))
    g.deleteAttribute('uv')
    return g
  }
  const parts = [part(0, 0.96, STICK_COLOR), part(0.96, 1, EMBER_COLOR)]
  const g = mergeGeometries(parts, false)!
  parts.forEach((p) => p.dispose())
  return g
}

interface Stick {
  censer: number
  slot: number
  /** 插下的時間（performance.now 毫秒）；常駐的香為 -Infinity。 */
  plantedAt: number
  permanent: boolean
  seed: number
}

/**
 * 香爐裡的香與香煙（動態物件）：所有香爐共用一個香的 InstancedMesh 與一個煙的 InstancedMesh，
 * 只畫目前場景的香爐，不論香有多少都是 2 個 draw call（沒有香時 0 個）。
 * 不併入任何靜態幾何、不與接收烘焙光照的物件共用材質（庭院香爐的香也一樣）。
 * 每個香爐有上限，超過時最舊的一支先消失。
 */
export class IncenseSystem {
  private sticks: Stick[] = []
  private zone: ZoneId = 'courtyard'
  private stickMesh: THREE.InstancedMesh
  private smokeMesh: THREE.InstancedMesh
  private smokeAlpha: THREE.InstancedBufferAttribute
  /** 每個香爐每個插香位置（slot）在香爐內的偏移與傾斜。 */
  private slots: Array<Array<{ dx: number; dz: number; tiltX: number; tiltZ: number }>>
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private v = new THREE.Vector3()
  private s = new THREE.Vector3()
  private tip = new THREE.Vector3()

  constructor(
    parent: THREE.Object3D,
    tracker: ResourceTracker,
    private readonly censers: ReadonlyArray<CenserDef>,
  ) {
    const capacity = censers.reduce((n, c) => n + c.sticks.cap + c.permanent, 0)
    this.slots = censers.map((c) => {
      // 常駐的香排在中央一列；玩家的香以黃金角均勻散布在內外徑之間的環上
      const fixed = Array.from({ length: c.permanent }, (_, i) => ({ dx: (i - (c.permanent - 1) / 2) * 0.06, dz: 0, tiltX: 0, tiltZ: 0 }))
      const ring = Array.from({ length: c.sticks.cap }, (_, i) => {
        const { innerRadius: r0, outerRadius: r1 } = c.sticks
        const r = Math.sqrt(r0 * r0 + ((i + 0.5) / c.sticks.cap) * (r1 * r1 - r0 * r0))
        const a = i * 2.39996
        return { dx: Math.cos(a) * r, dz: Math.sin(a) * r, tiltX: Math.sin(i * 1.7) * 0.07, tiltZ: Math.cos(i * 2.3) * 0.07 }
      })
      return [...fixed, ...ring]
    })
    censers.forEach((c, ci) => {
      for (let i = 0; i < c.permanent; i++) this.sticks.push({ censer: ci, slot: i, plantedAt: -Infinity, permanent: true, seed: i / c.permanent })
    })

    const stickMat = tracker.trackMaterial(new THREE.MeshBasicMaterial({ vertexColors: true }))
    this.stickMesh = new THREE.InstancedMesh(tracker.track(createIncenseStickGeometry()), stickMat, capacity)
    this.stickMesh.name = 'incense-sticks'

    const smokeTex = tracker.track(softCircle())
    // 面向鏡頭的煙團：以實例矩陣的平移為中心、x 軸長度為大小，在 view space 展開；每個實例自己的透明度。
    const smokeMat = tracker.trackMaterial(
      new THREE.ShaderMaterial({
        uniforms: { map: { value: smokeTex }, color: { value: new THREE.Color('#e9e4dc') } },
        vertexShader: /* glsl */ `
          attribute float alpha;
          varying float vAlpha;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vAlpha = alpha;
            vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            center.xy += position.xy * length(instanceMatrix[0].xyz);
            gl_Position = projectionMatrix * center;
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D map;
          uniform vec3 color;
          varying float vAlpha;
          varying vec2 vUv;
          void main() {
            gl_FragColor = vec4(color, texture2D(map, vUv).a * vAlpha);
            #include <colorspace_fragment>
          }`,
        transparent: true,
        depthWrite: false,
      }),
    )
    this.smokeAlpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity * PUFFS_PER_STICK), 1)
    this.smokeAlpha.setUsage(THREE.DynamicDrawUsage)
    const smokeGeo = tracker.track(new THREE.PlaneGeometry(1, 1))
    smokeGeo.setAttribute('alpha', this.smokeAlpha)
    this.smokeMesh = new THREE.InstancedMesh(smokeGeo, smokeMat, capacity * PUFFS_PER_STICK)
    this.smokeMesh.name = 'incense-smoke'
    this.smokeMesh.renderOrder = 2

    for (const mesh of [this.stickMesh, this.smokeMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      mesh.visible = false
      // 香爐分散在兩個場景，包圍球每次都要重算；實例很少，交給 GPU 裁切。
      mesh.frustumCulled = false
      parent.add(mesh)
    }
  }

  /** 目前場景裡的香數（不含常駐），測試與除錯用。 */
  count(censerId?: string): number {
    return this.sticks.filter((s) => !s.permanent && (censerId === undefined || this.censers[s.censer]!.id === censerId)).length
  }

  setZone(zone: ZoneId): void {
    this.zone = zone
  }

  /** 在香爐插一支香。超過該香爐上限時，最舊的一支先消失。 */
  add(censerId: string, now: number): boolean {
    const ci = this.censers.findIndex((c) => c.id === censerId)
    if (ci < 0) return false
    const c = this.censers[ci]!
    const mine = this.sticks.filter((s) => s.censer === ci && !s.permanent)
    if (mine.length >= c.sticks.cap) {
      const oldest = mine.reduce((a, b) => (a.plantedAt <= b.plantedAt ? a : b))
      this.sticks.splice(this.sticks.indexOf(oldest), 1)
    }
    // 第一個沒被佔用的插香位置（常駐的香佔前面幾個）
    const used = new Set(this.sticks.filter((s) => s.censer === ci).map((s) => s.slot))
    let slot = c.permanent
    while (used.has(slot)) slot++
    this.sticks.push({ censer: ci, slot, plantedAt: now, permanent: false, seed: Math.random() })
    return true
  }

  /** 每幀更新香的長度與煙。now 為 performance.now 毫秒，t 為秒。 */
  update(now: number, t: number): void {
    for (let i = this.sticks.length - 1; i >= 0; i--) {
      const s = this.sticks[i]!
      if (!s.permanent && now - s.plantedAt >= STICK_LIFE_MS) {
        this.sticks.splice(i, 1)
      }
    }
    let n = 0
    let puffs = 0
    for (const s of this.sticks) {
      const c = this.censers[s.censer]!
      if (c.zone !== this.zone) continue
      const age = s.permanent ? 0 : Math.max(0, now - s.plantedAt)
      const left = 1 - (1 - BURNT_FRACTION) * (age / STICK_LIFE_MS)
      const slot = this.slots[s.censer]![s.slot]!
      const length = c.sticks.length * left
      this.q.setFromEuler(this.e.set(slot.tiltX, 0, slot.tiltZ))
      this.v.set(c.x + slot.dx, c.ashY, c.z + slot.dz)
      this.m.compose(this.v, this.q, this.s.set(c.sticks.radius, length, c.sticks.radius))
      this.stickMesh.setMatrixAt(n++, this.m)

      // 煙從香頭往上飄、逐漸變大變淡；燒完前幾秒漸淡
      this.tip.set(0, length, 0).applyQuaternion(this.q).add(this.v)
      const fade = s.permanent ? 1 : Math.min(1, (STICK_LIFE_MS - age) / SMOKE_FADE_MS)
      const scale = c.sticks.length / 0.42
      for (let k = 0; k < PUFFS_PER_STICK; k++) {
        const p = (t * 0.22 + s.seed + k / PUFFS_PER_STICK) % 1
        const sway = Math.sin(t * 0.8 + s.seed * 9 + p * 3) * 0.06 * p * scale
        this.v.set(this.tip.x + sway, this.tip.y + 0.02 + p * 0.9 * scale, this.tip.z + sway * 0.5)
        const size = (0.05 + p * 0.3) * scale
        this.m.compose(this.v, this.q.identity(), this.s.set(size, size, size))
        this.smokeMesh.setMatrixAt(puffs, this.m)
        this.smokeAlpha.setX(puffs, Math.sin(p * Math.PI) * 0.28 * fade)
        puffs++
      }
    }
    this.stickMesh.count = n
    this.smokeMesh.count = puffs
    this.stickMesh.visible = n > 0
    this.smokeMesh.visible = puffs > 0
    if (n > 0) {
      setAttributeUpdateRange(this.stickMesh.instanceMatrix, 0, n * 16)
    }
    if (puffs > 0) {
      setAttributeUpdateRange(this.smokeMesh.instanceMatrix, 0, puffs * 16)
      setAttributeUpdateRange(this.smokeAlpha, 0, puffs)
    }
  }

  /** 移出場景；GPU 資源由建構時的 tracker 釋放。 */
  dispose(): void {
    this.stickMesh.removeFromParent()
    this.smokeMesh.removeFromParent()
    this.sticks = []
  }
}

function softCircle(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,0.9)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}
