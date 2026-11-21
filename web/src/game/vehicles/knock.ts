import type { AnimState } from '../anim/AnimationSystem'
import type { RemotePlayer } from '../world/Players'

export interface KnockMessage {
  id: string
  x: number
  z: number
  toX: number
  toZ: number
  at: number
}

export interface KnockFlight {
  fromX: number
  fromZ: number
  toX: number
  toZ: number
  start: number
  end: number
}

export interface KnockContext {
  selfId: string | null
  serverOffset: number
  fading: boolean
  local: {
    mover: { x: number; z: number; target: { x: number; z: number } | null }
    anim: AnimState
    lockedUntil: number
  }
  clearLocalActions: () => void
  playAnim: (anim: AnimState, clip: string, now: number, durationMs: number, startedAt?: number) => void
  playAudio: (knockX: number, knockZ: number, selfX: number, selfZ: number) => void
  setKnockFlight: (flight: KnockFlight | null) => void
  syncLocalTransform: () => void
  remotes: Map<string, RemotePlayer>
  applyRemoteKnock: (
    r: RemotePlayer,
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    startAt: number,
    endAt: number,
  ) => void
  syncRemoteByN: (n: number, x: number, z: number, heading: number, moving: boolean, now: number) => void
}

/**
 * 處理伺服器送來的 knock 撞飛訊息：
 * - 播放音效（VehicleAudio 距離衰減與並發限制）
 * - 本機玩家：
 *   - 若在淡入淡出轉場中或已過期超過 1800ms：只套用落點，不播片段，不鎖定移動
 *   - 正常情況：清除路徑、pending、中斷鎖定動作（不發送 endAction），鎖定 1800ms，播放 knocked，前 900ms 線性位移到落點
 * - 遠端玩家：
 *   - 若已過期：只以 syncRemoteByN 套用落點
 *   - 正常情況：設定 lockedUntil = localAt + 1800，清除現有片段並播放 knocked，前 900ms 線性位移到落點
 */
export function handleKnock(ctx: KnockContext, m: KnockMessage, now: number): void {
  const local = ctx.local
  const isSelf = ctx.selfId !== null && m.id === ctx.selfId
  const localAt = m.at - ctx.serverOffset
  const expired = now >= localAt + 1800

  ctx.playAudio(m.x, m.z, local.mover.x, local.mover.z)

  if (isSelf) {
    if (ctx.fading || expired) {
      local.mover.x = m.toX
      local.mover.z = m.toZ
      local.mover.target = null
      ctx.syncLocalTransform()
      ctx.setKnockFlight(null)
      return
    }

    ctx.clearLocalActions()
    local.mover.target = null
    local.lockedUntil = localAt + 1800
    ctx.playAnim(local.anim, 'knocked', now, 1800, localAt)

    const flight: KnockFlight = {
      fromX: m.x,
      fromZ: m.z,
      toX: m.toX,
      toZ: m.toZ,
      start: localAt,
      end: localAt + 900,
    }
    ctx.setKnockFlight(flight)

    // 立即取樣當前時間的位置
    const p = Math.min(1, Math.max(0, (now - flight.start) / (flight.end - flight.start)))
    local.mover.x = flight.fromX + (flight.toX - flight.fromX) * p
    local.mover.z = flight.fromZ + (flight.toZ - flight.fromZ) * p
    ctx.syncLocalTransform()
    if (p >= 1) ctx.setKnockFlight(null)
  } else {
    const r = ctx.remotes.get(m.id)
    if (!r) return
    if (expired) {
      ctx.syncRemoteByN(r.n, m.toX, m.toZ, r.heading, false, now)
      return
    }
    r.lockedUntil = localAt + 1800
    r.anim.clip = null
    ctx.playAnim(r.anim, 'knocked', now, 1800, localAt)
    ctx.applyRemoteKnock(r, m.x, m.z, m.toX, m.toZ, localAt, localAt + 900)
  }
}
