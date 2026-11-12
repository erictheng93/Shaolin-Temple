import type * as THREE from 'three'
import { AnimationSystem, createAnimState, type AnimState } from '../anim/AnimationSystem'
import { AvatarFactory, colorIndexFor, type Avatar } from '../render/AvatarFactory'
import type { PlayerSnapshot } from '../net/protocol'
import { SPAWN } from './layout'
import type { MoverState } from './movement'

export interface RemotePlayer {
  id: string
  name: string
  avatar: Avatar
  anim: AnimState
  x: number
  z: number
  heading: number
  tx: number
  tz: number
  theading: number
  serverMoving: boolean
  zone: string
}

export interface LocalPlayer {
  avatar: Avatar
  anim: AnimState
  mover: MoverState
  /** 鎖住移動直到此時間（毫秒），由需要定身的動作設定。 */
  lockedUntil: number
}

const LABEL_LIMIT = 12
const CULL_INTERVAL_S = 0.5

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a
  d = Math.atan2(Math.sin(d), Math.cos(d))
  return a + d * k
}

/**
 * 管理所有玩家的角色物件與動畫。遠端玩家以指數平滑追上伺服器位置，
 * 並只顯示距離最近的 maxVisible 人，限制繪製量。
 */
export class Players {
  readonly local: LocalPlayer
  readonly remotes = new Map<string, RemotePlayer>()
  private factory: AvatarFactory
  private cullTimer = 0
  /** 離本機玩家這個距離內的角色用完整模型並投影，其餘用低面數模型（由動態畫質調整）。 */
  nearRadius = 14
  /** 本機玩家所在場景；只顯示同場景的遠端玩家。 */
  localZone = 'courtyard'

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly anim: AnimationSystem,
    public maxVisible: number,
  ) {
    this.factory = new AvatarFactory(parent)
    const avatar = this.factory.create({ name: '', colorIndex: 0, local: true })
    parent.add(avatar.root)
    this.local = {
      avatar,
      anim: createAnimState(),
      mover: { x: SPAWN.x, z: SPAWN.z, heading: SPAWN.heading, target: null },
      lockedUntil: 0,
    }
    this.syncLocalTransform()
  }

  get count(): number {
    return this.remotes.size + 1
  }

  upsert(p: PlayerSnapshot): RemotePlayer {
    const existing = this.remotes.get(p.id)
    if (existing) {
      existing.tx = p.x
      existing.tz = p.z
      existing.theading = p.heading
      existing.zone = p.zone ?? 'courtyard'
      return existing
    }
    const avatar = this.factory.create({ name: p.name, colorIndex: colorIndexFor(p.id), local: false })
    this.parent.add(avatar.root)
    const r: RemotePlayer = {
      id: p.id,
      name: p.name,
      avatar,
      anim: createAnimState(),
      x: p.x,
      z: p.z,
      heading: p.heading,
      tx: p.x,
      tz: p.z,
      theading: p.heading,
      serverMoving: false,
      zone: p.zone ?? 'courtyard',
    }
    this.remotes.set(p.id, r)
    this.cullTimer = CULL_INTERVAL_S // 下一幀重新計算可見性
    return r
  }

  remove(id: string): void {
    const r = this.remotes.get(id)
    if (!r) return
    r.avatar.dispose()
    this.remotes.delete(id)
  }

  clearRemotes(): void {
    for (const r of this.remotes.values()) r.avatar.dispose()
    this.remotes.clear()
  }

  setRemoteTarget(id: string, x: number, z: number, heading: number, moving: boolean): void {
    const r = this.remotes.get(id)
    if (!r) return
    r.tx = x
    r.tz = z
    r.theading = heading
    r.serverMoving = moving
  }

  /** 遠端玩家切換場景：直接移到新位置，不做插值。 */
  setRemoteZone(id: string, zone: string, x: number, z: number, heading: number): void {
    const r = this.remotes.get(id)
    if (!r) return
    r.zone = zone
    r.x = r.tx = x
    r.z = r.tz = z
    r.heading = r.theading = heading
    r.serverMoving = false
    this.cullTimer = CULL_INTERVAL_S
  }

  /** 本機玩家切換場景後立即重新計算可見性。 */
  setLocalZone(zone: string): void {
    this.localZone = zone
    this.cull()
  }

  syncLocalTransform(): void {
    const { root } = this.local.avatar
    root.position.set(this.local.mover.x, 0, this.local.mover.z)
    root.rotation.y = this.local.mover.heading
  }

  /** 每幀更新。回傳是否仍有動態需要重繪。 */
  update(now: number, dt: number, t: number): boolean {
    let active = false
    const k = 1 - Math.exp(-dt * 10)
    for (const r of this.remotes.values()) {
      const dx = r.tx - r.x
      const dz = r.tz - r.z
      const far = dx * dx + dz * dz
      if (far > 25) {
        // 差距過大（重連、瞬移）直接跳過去。
        r.x = r.tx
        r.z = r.tz
      } else {
        r.x += dx * k
        r.z += dz * k
      }
      r.heading = lerpAngle(r.heading, r.theading, k)
      r.anim.moving = r.serverMoving || far > 0.0004
      if (!r.avatar.root.visible) continue
      r.avatar.root.position.set(r.x, 0, r.z)
      r.avatar.root.rotation.y = r.heading
      this.anim.apply(r.avatar, r.anim, now, dt, t)
      if (this.anim.isActive(r.anim, now) || Math.abs(r.theading - r.heading) > 0.01) active = true
    }

    this.syncLocalTransform()
    this.anim.apply(this.local.avatar, this.local.anim, now, dt, t)
    if (this.anim.isActive(this.local.anim, now)) active = true

    this.cullTimer += dt
    if (this.cullTimer >= CULL_INTERVAL_S) {
      this.cullTimer = 0
      this.cull()
    }
    this.factory.sync(this.local.mover.x, this.local.mover.z, this.nearRadius)
    return active
  }

  /** 依距離決定哪些遠端玩家要畫出來、哪些要顯示名牌。 */
  private cull(): void {
    const { x, z } = this.local.mover
    const list: RemotePlayer[] = []
    for (const r of this.remotes.values()) {
      if (r.zone === this.localZone) list.push(r)
      else r.avatar.root.visible = false
    }
    if (list.length > this.maxVisible || list.length > LABEL_LIMIT) {
      list.sort((a, b) => (a.x - x) ** 2 + (a.z - z) ** 2 - ((b.x - x) ** 2 + (b.z - z) ** 2))
    }
    list.forEach((r, i) => {
      r.avatar.root.visible = i < this.maxVisible
      r.avatar.setLabelVisible(i < LABEL_LIMIT)
    })
  }

  dispose(): void {
    this.clearRemotes()
    this.local.avatar.dispose()
    this.factory.dispose()
  }
}
