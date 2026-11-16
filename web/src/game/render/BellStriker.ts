import * as THREE from 'three'
import { BELL_MS, BELL_STATIONS, STRIKER, strikerAngle } from '../world/bell'
import type { ResourceTracker } from './ResourceTracker'

/** 兩條吊繩在圓木上的位置（沿 z，相對圓木中心）。 */
const HANG_OFFSETS = [-0.4, 0.4] as const
/** 拉繩下端：站位前方、合十的手的高度。 */
const HAND_FORWARD = 0.24
const HAND_Y = 0.6
/** 拉繩下端跟著撞木前後移動的比例（角色前後傾時手移動的距離約為撞木的一半）。 */
const HAND_FOLLOW = 0.5
const ROPE_RADIUS = 0.012
const LOG_COLOR = '#5e4127'
const ROPE_COLOR = '#9c8559'

/**
 * 鐘亭的撞木（動態物件）：一根懸吊的圓木（兩條吊繩）與從圓木尾端垂到各敲鐘站位的拉繩。
 * 全部是同一個圓柱的實例（圓木與繩子以 instanceColor 上色），1 個 draw call，只在庭院顯示。
 * 不併入庭院的靜態幾何、不與接收烘焙的物件共用材質、不在 TempleScene 的 root 底下，所以不影響烘焙指紋。
 * 不投影也不接收即時陰影（即時陰影貼圖只留給角色）。
 */
export class BellStriker {
  private mesh: THREE.InstancedMesh
  private startedAt = -Infinity
  private angle = Number.NaN
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private from = new THREE.Vector3()
  private to = new THREE.Vector3()
  private scale = new THREE.Vector3()
  private static readonly UP = new THREE.Vector3(0, 1, 0)

  constructor(parent: THREE.Object3D, tracker: ResourceTracker) {
    // 高 1、底在原點的圓柱，依實例縮放成圓木或繩子
    const geo = tracker.track(new THREE.CylinderGeometry(1, 1, 1, 12, 1).translate(0, 0.5, 0))
    const mat = tracker.trackMaterial(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 }))
    this.mesh = new THREE.InstancedMesh(geo, mat, 1 + HANG_OFFSETS.length + BELL_STATIONS.length)
    this.mesh.name = 'bell-striker'
    this.mesh.frustumCulled = false
    const log = new THREE.Color(LOG_COLOR)
    const rope = new THREE.Color(ROPE_COLOR)
    for (let i = 0; i < this.mesh.count; i++) this.mesh.setColorAt(i, i === 0 ? log : rope)
    parent.add(this.mesh)
    this.pose(0)
  }

  set visible(v: boolean) {
    this.mesh.visible = v
  }

  /** 開始一次撞鐘（startedAt 為動作開始的 performance.now 毫秒）。同時有兩人敲時以較晚開始的為準。 */
  strike(startedAt: number): void {
    this.startedAt = Math.max(this.startedAt, startedAt)
  }

  /** 每幀更新；回傳是否仍在擺動。 */
  update(now: number): boolean {
    const ms = now - this.startedAt
    const active = ms > 0 && ms < BELL_MS
    this.pose(active ? strikerAngle(ms) : 0)
    return active
  }

  dispose(): void {
    this.mesh.removeFromParent()
  }

  private pose(angle: number): void {
    if (angle === this.angle) return
    this.angle = angle
    const { x, pivotY, length: L, z, halfLength, radius } = STRIKER
    // 平行四邊形擺動：圓木保持水平，往鐘（-z）擺時略為升高
    const dz = -L * Math.sin(angle)
    const logY = pivotY - L * Math.cos(angle)
    let i = 0
    this.segment(i++, this.from.set(x, logY, z + halfLength + dz), this.to.set(x, logY, z - halfLength + dz), radius)
    for (const off of HANG_OFFSETS) {
      this.segment(i++, this.from.set(x, pivotY, z + off), this.to.set(x, logY, z + off + dz), ROPE_RADIUS)
    }
    for (const s of BELL_STATIONS) {
      this.from.set(x, logY, z + halfLength + dz)
      this.to.set(s.x + Math.sin(s.heading) * HAND_FORWARD, HAND_Y, s.z + Math.cos(s.heading) * HAND_FORWARD + dz * HAND_FOLLOW)
      this.segment(i++, this.from, this.to, ROPE_RADIUS)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  /** 第 i 個實例：從 a 到 b、半徑 r 的圓柱。 */
  private segment(i: number, a: THREE.Vector3, b: THREE.Vector3, r: number): void {
    const dir = b.sub(a)
    const len = dir.length()
    this.q.setFromUnitVectors(BellStriker.UP, dir.divideScalar(len))
    this.mesh.setMatrixAt(i, this.m.compose(a, this.q, this.scale.set(r, len, r)))
  }
}
