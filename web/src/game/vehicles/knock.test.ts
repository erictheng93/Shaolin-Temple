import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleKnock, type KnockContext, type KnockFlight, type KnockMessage } from './knock'
import type { RemotePlayer } from '../world/Players'
import { createAnimState } from '../anim/AnimationSystem'

describe('knock 撞飛處理', () => {
  let ctx: KnockContext
  let clearLocalActions: ReturnType<typeof vi.fn>
  let playAnim: ReturnType<typeof vi.fn>
  let playAudio: ReturnType<typeof vi.fn>
  let setKnockFlight: ReturnType<typeof vi.fn>
  let syncLocalTransform: ReturnType<typeof vi.fn>
  let applyRemoteKnock: ReturnType<typeof vi.fn>
  let syncRemoteByN: ReturnType<typeof vi.fn>
  let flightState: KnockFlight | null
  let endActionSent: boolean

  beforeEach(() => {
    flightState = null
    endActionSent = false
    clearLocalActions = vi.fn(() => {
      // 確保清除動作時絕不可發送 endAction
      if (endActionSent) throw new Error('不應呼叫 endAction')
    })
    playAnim = vi.fn((anim, clip) => {
      anim.clip = clip
    })
    playAudio = vi.fn()
    setKnockFlight = vi.fn((f) => {
      flightState = f
    })
    syncLocalTransform = vi.fn()
    applyRemoteKnock = vi.fn((r, fx, fz, _tx, _tz) => {
      r.x = fx
      r.z = fz
    })
    syncRemoteByN = vi.fn()

    ctx = {
      selfId: 'p_me',
      serverOffset: 100, // serverNow = localNow + 100
      fading: false,
      local: {
        mover: { x: 0, z: 0, target: { x: 5, z: 5 } },
        anim: createAnimState(),
        lockedUntil: 0,
      },
      clearLocalActions: clearLocalActions as unknown as () => void,
      playAnim: playAnim as unknown as KnockContext['playAnim'],
      playAudio: playAudio as unknown as KnockContext['playAudio'],
      setKnockFlight: setKnockFlight as unknown as KnockContext['setKnockFlight'],
      syncLocalTransform: syncLocalTransform as unknown as () => void,
      remotes: new Map<string, RemotePlayer>(),
      applyRemoteKnock: applyRemoteKnock as unknown as KnockContext['applyRemoteKnock'],
      syncRemoteByN: syncRemoteByN as unknown as KnockContext['syncRemoteByN'],
    }
  })

  it('本機被撞飛：取消走向香爐的 pending、1.8 秒內不接受移動、結束時位於落點', () => {
    const now = 1000
    // 伺服器時間為 1100 (now + 100)，m.at = 1100 => localAt = 1000
    const m: KnockMessage = {
      id: 'p_me',
      x: 0,
      z: 0,
      toX: 3,
      toZ: 4,
      at: 1100,
    }

    handleKnock(ctx, m, now)

    // 1. 取消走向香爐的 pending / 目標
    expect(clearLocalActions).toHaveBeenCalled()
    expect(ctx.local.mover.target).toBeNull()

    // 2. 1.8 秒內鎖定移動 (lockedUntil = 1000 + 1800 = 2800)
    expect(ctx.local.lockedUntil).toBe(2800)
    expect(ctx.local.anim.clip).toBe('knocked')
    expect(playAnim).toHaveBeenCalledWith(ctx.local.anim, 'knocked', now, 1800, 1000)

    // 3. 拋物線航程已建立，前 900ms 內線性移動
    expect(flightState).toMatchObject({
      fromX: 0,
      fromZ: 0,
      toX: 3,
      toZ: 4,
      start: 1000,
      end: 1900,
    })

    // 模擬 900ms 後落地（例如此時執行飛行插值），位置達到落點
    const p = 1
    ctx.local.mover.x = flightState!.fromX + (flightState!.toX - flightState!.fromX) * p
    ctx.local.mover.z = flightState!.fromZ + (flightState!.toZ - flightState!.fromZ) * p
    expect(ctx.local.mover.x).toBe(3)
    expect(ctx.local.mover.z).toBe(4)
  })

  it('本機在淡入淡出中被撞：位置更新、不播片段、轉場照常完成後可以移動', () => {
    const now = 1000
    ctx.fading = true
    const m: KnockMessage = {
      id: 'p_me',
      x: 0,
      z: 0,
      toX: 6,
      toZ: 8,
      at: 1100,
    }

    handleKnock(ctx, m, now)

    // 位置直接更新到落點
    expect(ctx.local.mover.x).toBe(6)
    expect(ctx.local.mover.z).toBe(8)
    expect(syncLocalTransform).toHaveBeenCalled()

    // 不播片段，不設定 flight
    expect(playAnim).not.toHaveBeenCalled()
    expect(ctx.local.anim.clip).toBeNull()
    expect(flightState).toBeNull()

    // 不鎖定移動（lockedUntil 保持 0，轉場完成後可立即移動）
    expect(ctx.local.lockedUntil).toBe(0)
  })

  it('撞飛中的上香動作被中斷且不送 endAction', () => {
    const now = 1000
    // 設定正在上香
    ctx.local.anim.clip = 'bow'
    ctx.local.lockedUntil = 2500

    const m: KnockMessage = {
      id: 'p_me',
      x: 0,
      z: 0,
      toX: 2,
      toZ: 2,
      at: 1100,
    }

    handleKnock(ctx, m, now)

    // clearLocalActions 執行且無呼叫任何發送 endAction 的動作
    expect(clearLocalActions).toHaveBeenCalled()
    expect(endActionSent).toBe(false)
    // 動作片段被替換成 knocked
    expect(ctx.local.anim.clip).toBe('knocked')
  })

  it('遠端玩家被撞飛時取代原本的鎖定片段', () => {
    const now = 1000
    const remoteAnim = createAnimState()
    remoteAnim.clip = 'kneel' // 原本在跪拜

    const remote: RemotePlayer = {
      id: 'p_remote',
      name: 'Bob',
      avatar: {} as never,
      anim: remoteAnim,
      outfit: 0,
      x: 1,
      z: 1,
      heading: 0,
      n: 2,
      from: { x: 1, z: 1, heading: 0, t: 1000 },
      to: { x: 1, z: 1, heading: 0, t: 1000 },
      serverMoving: false,
      lastMoveAt: 1000,
      zone: 'courtyard',
      lockedUntil: 3000,
    }
    ctx.remotes.set('p_remote', remote)

    const m: KnockMessage = {
      id: 'p_remote',
      x: 1,
      z: 1,
      toX: 5,
      toZ: 5,
      at: 1100,
    }

    handleKnock(ctx, m, now)

    // 原本的 kneel 片段被取代成 knocked
    expect(remote.anim.clip).toBe('knocked')
    expect(remote.lockedUntil).toBe(2800)
    expect(applyRemoteKnock).toHaveBeenCalledWith(remote, 1, 1, 5, 5, 1000, 1900)
  })

  it('過期的 knock 只套用落點', () => {
    const now = 5000 // 遠大於 localAt (1000) + 1800 = 2800
    const mSelf: KnockMessage = {
      id: 'p_me',
      x: 0,
      z: 0,
      toX: 10,
      toZ: 10,
      at: 1100, // localAt = 1000
    }

    handleKnock(ctx, mSelf, now)

    // 本機過期：只套用落點，不鎖定移動，不播片段
    expect(ctx.local.mover.x).toBe(10)
    expect(ctx.local.mover.z).toBe(10)
    expect(ctx.local.lockedUntil).toBe(0)
    expect(playAnim).not.toHaveBeenCalled()

    // 遠端過期：呼叫 syncRemoteByN 直接瞬移到落點，不播片段
    const remote: RemotePlayer = {
      id: 'p_remote',
      name: 'Bob',
      avatar: {} as never,
      anim: createAnimState(),
      outfit: 0,
      x: 1,
      z: 1,
      heading: 0.5,
      n: 5,
      from: { x: 1, z: 1, heading: 0.5, t: 1000 },
      to: { x: 1, z: 1, heading: 0.5, t: 1000 },
      serverMoving: false,
      lastMoveAt: 1000,
      zone: 'courtyard',
      lockedUntil: 0,
    }
    ctx.remotes.set('p_remote', remote)

    const mRemote: KnockMessage = {
      id: 'p_remote',
      x: 1,
      z: 1,
      toX: 12,
      toZ: 12,
      at: 1100,
    }

    handleKnock(ctx, mRemote, now)
    expect(syncRemoteByN).toHaveBeenCalledWith(5, 12, 12, 0.5, false, now)
    expect(applyRemoteKnock).not.toHaveBeenCalled()
  })
})
