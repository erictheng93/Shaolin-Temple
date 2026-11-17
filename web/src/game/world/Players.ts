import type * as THREE from 'three'
import { AnimationSystem, createAnimState, type AnimState } from '../anim/AnimationSystem'
import { AvatarFactory, type Avatar } from '../render/AvatarFactory'
import type { PlayerSnapshot } from '../net/protocol'
import { SPAWN } from './layout'
import { DEFAULT_OUTFIT, normalizeOutfit } from './outfits'
import { REMOTE_MOVE_TIMEOUT_MS, REMOTE_SNAP_DISTANCE, sampleBetween, stepDuration, type Sample } from './interp'
import type { MoverState } from './movement'

export interface RemotePlayer {
  id: string
  name: string
  avatar: Avatar
  anim: AnimState
  /** 衣裝編號（world/outfits.ts）。 */
  outfit: number
  x: number
  z: number
  heading: number
  /** 房內短編號，moves／sync 以此指稱。 */
  n: number
  /** 插值的兩個端點：收到新位置當下的顯示位置，與預計走到新位置的時間點。 */
  from: Sample
  to: Sample
  serverMoving: boolean
  /** 最近一次收到此玩家位置的時間（毫秒），給停止看門狗用。 */
  lastMoveAt: number
  zone: string
  /**
   * 正在做鎖定移動的動作直到此時間（毫秒）。期間不播走路、不打斷動作片段：動作訊息是立即轉送，
   * 對方最後一筆位置要等下一個 tick 才到，這段「走完最後一小段」不應該把跪拜或上香的動畫取消。
   */
  lockedUntil: number
}

export interface LocalPlayer {
  avatar: Avatar
  /** 衣裝編號（world/outfits.ts）。 */
  outfit: number
  anim: AnimState
  mover: MoverState
  /** 鎖住移動直到此時間（毫秒），由需要定身的動作設定。 */
  lockedUntil: number
}

const LABEL_LIMIT = 12

const CULL_INTERVAL_S = 0.5

/**
 * 管理所有玩家的角色物件與動畫。遠端玩家收到新位置時，從目前顯示的位置等速走過去，花的時間等於位置更新的間隔，
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
    localOutfit = DEFAULT_OUTFIT,
  ) {
    this.factory = new AvatarFactory(parent)
    const outfit = normalizeOutfit(localOutfit)
    const avatar = this.factory.create({ name: '', outfit, local: true })
    parent.add(avatar.root)
    this.local = {
      avatar,
      outfit,
      anim: createAnimState(),
      mover: { x: SPAWN.x, z: SPAWN.z, heading: SPAWN.heading, target: null },
      lockedUntil: 0,
    }
    this.syncLocalTransform()
  }

  get count(): number {
    return this.remotes.size + 1
  }

  /** 房內短編號 → 遠端玩家（不含自己）。 */
  private readonly byN = new Map<number, RemotePlayer>()

  upsert(p: PlayerSnapshot, now = performance.now()): RemotePlayer {
    const existing = this.remotes.get(p.id)
    if (existing) {
      if (existing.n !== p.n) {
        this.byN.delete(existing.n)
        existing.n = p.n
        this.byN.set(p.n, existing)
      }
      existing.zone = p.zone ?? 'courtyard'
      // 恢復連線時改了名字：伺服器對同一個 id 再送一次 join。
      if (p.name !== existing.name) {
        existing.name = p.name
        existing.avatar.setName(p.name)
      }
      const outfit = normalizeOutfit(p.outfit)
      if (p.outfit !== undefined && outfit !== existing.outfit) {
        existing.outfit = outfit
        existing.avatar.setOutfit(outfit)
      }
      this.snapTo(existing, p.x, p.z, p.heading, now)
      return existing
    }
    const outfit = normalizeOutfit(p.outfit)
    const avatar = this.factory.create({ name: p.name, outfit, local: false })
    this.parent.add(avatar.root)
    const r: RemotePlayer = {
      id: p.id,
      name: p.name,
      avatar,
      outfit,
      anim: createAnimState(),
      x: p.x,
      z: p.z,
      heading: p.heading,
      n: p.n,
      from: { x: p.x, z: p.z, heading: p.heading, t: now },
      to: { x: p.x, z: p.z, heading: p.heading, t: now },
      serverMoving: false,
      lastMoveAt: now,
      zone: p.zone ?? 'courtyard',
      lockedUntil: 0,
    }
    this.remotes.set(p.id, r)
    this.byN.set(p.n, r)
    this.cullTimer = CULL_INTERVAL_S // 下一幀重新計算可見性
    return r
  }

  remove(id: string): void {
    const r = this.remotes.get(id)
    if (!r) return
    r.avatar.dispose()
    this.remotes.delete(id)
    if (this.byN.get(r.n) === r) this.byN.delete(r.n)
  }

  clearRemotes(): void {
    for (const r of this.remotes.values()) r.avatar.dispose()
    this.remotes.clear()
    this.byN.clear()
  }

  /** 以短編號套用 moves 的一筆（增量，插值）；對照不到的編號（含自己）忽略。 */
  setRemoteTargetByN(n: number, x: number, z: number, heading: number, moving: boolean, now: number): void {
    const r = this.byN.get(n)
    if (r) this.pushSample(r, x, z, heading, moving, now)
  }

  /** 以短編號套用 sync 的一筆：直接套用位置、面向與移動狀態，不插值。 */
  syncRemoteByN(n: number, x: number, z: number, heading: number, moving: boolean, now: number): void {
    const r = this.byN.get(n)
    if (!r) return
    this.snapTo(r, x, z, heading, now)
    r.serverMoving = moving
  }

  /** 以字串 id 套用單筆位置（舊的 move 訊息）。 */
  setRemoteTarget(id: string, x: number, z: number, heading: number, moving: boolean, now: number): void {
    const r = this.remotes.get(id)
    if (r) this.pushSample(r, x, z, heading, moving, now)
  }

  private pushSample(r: RemotePlayer, x: number, z: number, heading: number, moving: boolean, now: number): void {
    r.serverMoving = moving
    if (Math.hypot(x - r.x, z - r.z) > REMOTE_SNAP_DISTANCE) {
      this.snapTo(r, x, z, heading, now)
      return
    }
    // 從目前顯示的位置出發，位置永遠連續；等速移動且更新間隔穩定時，剛好在下一筆到達時走到，速度恆定。
    this.place(r, now)
    r.from = { x: r.x, z: r.z, heading: r.heading, t: now }
    r.to = { x, z, heading, t: now + stepDuration(now - r.lastMoveAt) }
    r.lastMoveAt = now
  }

  /** 把顯示位置更新到 now。 */
  private place(r: RemotePlayer, now: number): void {
    sampleBetween(r.from, r.to, now, r)
  }

  /** 不插值，直接放到指定位置（兩筆樣本相同）。 */
  private snapTo(r: RemotePlayer, x: number, z: number, heading: number, now: number): void {
    r.x = x
    r.z = z
    r.heading = heading
    r.from = { x, z, heading, t: now }
    r.to = r.from
    r.lastMoveAt = now
  }

  /** 遠端玩家切換場景：直接移到新位置，不做插值。 */
  setRemoteZone(id: string, zone: string, x: number, z: number, heading: number, now: number): void {
    const r = this.remotes.get(id)
    if (!r) return
    r.zone = zone
    this.snapTo(r, x, z, heading, now)
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

  /** 在玩家頭上顯示對話泡泡；playerId 為 null 代表本機玩家，找不到的遠端玩家忽略。 */
  say(playerId: string | null, text: string, until: number): void {
    const avatar = playerId === null ? this.local.avatar : this.remotes.get(playerId)?.avatar
    avatar?.say(text, until)
  }

  /** 更換衣裝；playerId 為 null 代表本機玩家，找不到的遠端玩家忽略。無效值當成預設衣裝。回傳是否有改變。 */
  setOutfit(playerId: string | null, outfit: number): boolean {
    const p = playerId === null ? this.local : this.remotes.get(playerId)
    if (!p) return false
    const o = normalizeOutfit(outfit)
    if (o === p.outfit) return false
    p.outfit = o
    p.avatar.setOutfit(o)
    return true
  }

  /** 伺服器廣播的遠端玩家衣裝。只作用於遠端玩家：本機玩家（含自己的回音）與未知 id 都忽略。回傳是否有改變。 */
  setRemoteOutfit(playerId: string, outfit: number): boolean {
    return this.remotes.has(playerId) && this.setOutfit(playerId, outfit)
  }

  /** 每幀更新。回傳是否仍有動態需要重繪。 */
  update(now: number, dt: number, t: number): boolean {
    let active = false
    for (const r of this.remotes.values()) {
      // 看門狗：移動中卻太久沒收到位置（對方切到背景、封包遺失），視為已停止。
      if (r.serverMoving && now - r.lastMoveAt > REMOTE_MOVE_TIMEOUT_MS) r.serverMoving = false
      this.place(r, now)
      // 還沒走到最新位置時也要播走路動畫（停止訊息到達後仍有最後一小段路）。
      const arriving = now < r.to.t && (r.from.x !== r.to.x || r.from.z !== r.to.z)
      r.anim.moving = now < r.lockedUntil ? false : r.serverMoving || arriving
      if (!r.avatar.root.visible) continue
      r.avatar.root.position.set(r.x, 0, r.z)
      r.avatar.root.rotation.y = r.heading
      this.anim.apply(r.avatar, r.anim, now, dt, t)
      if (this.anim.isActive(r.anim, now)) active = true
      if (r.avatar.tickBubble(now)) active = true
    }

    this.syncLocalTransform()
    this.anim.apply(this.local.avatar, this.local.anim, now, dt, t)
    if (this.anim.isActive(this.local.anim, now)) active = true
    if (this.local.avatar.tickBubble(now)) active = true

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
