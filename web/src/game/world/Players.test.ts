import { describe, expect, it, vi } from 'vitest'

// 角色繪製（Three.js）與本測試無關，換成最小替身。
vi.mock('../render/AvatarFactory', () => {
  const makeAvatar = (opts: { outfit: number }) => ({
    outfit: opts.outfit,
    setOutfit(o: number) {
      this.outfit = o
    },
    root: { visible: true, position: { set() {} }, rotation: { y: 0 } },
    pivot: {},
    head: {},
    setLabelVisible() {},
    said: [] as Array<[string, number]>,
    say(text: string, until: number) {
      this.said.push([text, until])
    },
    tickBubble() {
      return false
    },
    dispose() {},
  })
  return {
    AvatarFactory: class {
      create = makeAvatar
      sync() {}
      dispose() {}
    },
  }
})

const { Players } = await import('./Players')
const { REMOTE_MOVE_TIMEOUT_MS } = await import('./interp')

function makePlayers() {
  const anim = { apply() {}, isActive: (s: { moving: boolean }) => s.moving }
  return new Players({ add() {} } as never, anim as never, 50)
}
const snap = (id: string, n: number, x = 0, z = 0) => ({ id, n, name: id, x, z, heading: 0 })

describe('Players 對話泡泡', () => {
  const said = (a: unknown) => (a as { said: unknown[] }).said
  it('以玩家 id 指定遠端玩家、null 指定本機玩家；找不到的玩家忽略', () => {
    const p = makePlayers()
    const r = p.upsert(snap('b', 1), 0)
    p.say('b', '早安', 6000)
    p.say(null, '你好', 7000)
    p.say('zzz', '沒人', 8000)
    expect(said(r.avatar)).toEqual([['早安', 6000]])
    expect(said(p.local.avatar)).toEqual([['你好', 7000]])
  })
})

describe('Players 短編號對照', () => {
  it('依 n 套用 moves；對照不到的 n（含自己的 n）忽略', () => {
    const p = makePlayers()
    p.upsert(snap('b', 7), 0)
    p.setRemoteTargetByN(7, 1, 2, 0, true, 100)
    p.setRemoteTargetByN(99, 5, 5, 0, true, 100) // 未知編號：不丟例外、不新增玩家
    expect(p.remotes.size).toBe(1)
    const r = p.remotes.get('b')!
    expect(r.to).toMatchObject({ x: 1, z: 2, t: 200 }) // 100 收到，預計 200 走到
    expect(r.serverMoving).toBe(true)
  })

  it('leave 後對照移除，編號回收給新玩家後指向新玩家', () => {
    const p = makePlayers()
    p.upsert(snap('b', 7), 0)
    p.remove('b')
    p.setRemoteTargetByN(7, 1, 1, 0, true, 100) // 已離開：忽略
    p.upsert(snap('c', 7), 200)
    p.setRemoteTargetByN(7, 3, 0, 0, false, 300)
    expect(p.remotes.get('c')!.to).toMatchObject({ x: 3 })
    expect(p.remotes.size).toBe(1)
  })

  it('clearRemotes（welcome 重建）清掉對照', () => {
    const p = makePlayers()
    p.upsert(snap('b', 7), 0)
    p.clearRemotes()
    p.setRemoteTargetByN(7, 1, 1, 0, true, 100)
    expect(p.remotes.size).toBe(0)
  })

  it('sync 直接套用位置與移動狀態，不插值', () => {
    const p = makePlayers()
    p.upsert(snap('b', 1), 0)
    p.syncRemoteByN(1, 4, 4, 1, true, 500)
    const r = p.remotes.get('b')!
    expect(r.from).toBe(r.to)
    expect(r).toMatchObject({ x: 4, z: 4, serverMoving: true })
    expect(() => p.syncRemoteByN(2, 0, 0, 0, false, 500)).not.toThrow()
  })
})

describe('Players 插值與看門狗', () => {
  it('位置差距超過 5 公尺直接套用', () => {
    const p = makePlayers()
    p.upsert(snap('b', 1), 0)
    p.setRemoteTargetByN(1, 6, 0, 0, true, 100)
    const r = p.remotes.get('b')!
    expect(r.from).toBe(r.to)
    expect(r.x).toBe(6)
  })

  it('每 100 ms 一筆的等速輸入：顯示位置連續、速度恆定，最後停在最新位置不外插', () => {
    const p = makePlayers()
    p.upsert(snap('b', 1), 0)
    const r = p.remotes.get('b')!
    // 每個 tick 前進 0.2 公尺；每 10 ms 取樣一次顯示位置
    const xs: number[] = []
    for (let now = 1000; now <= 1500; now += 10) {
      if (now % 100 === 0 && now <= 1400) p.setRemoteTargetByN(1, ((now - 1000) / 100 + 1) * 0.2, 0, 0, true, now)
      p.update(now, 0.01, 0)
      xs.push(r.x)
    }
    // 第一筆之後（1100 起）每 10 ms 都前進 0.02 公尺，沒有停頓也沒有跳動
    const steady = xs.slice(10, 50)
    for (let i = 1; i < steady.length; i++) expect(steady[i]! - steady[i - 1]!).toBeCloseTo(0.02, 9)
    expect(r.anim.moving).toBe(true)
    p.update(3000, 0.016, 0)
    expect(r.x).toBeCloseTo(1, 9)
  })

  it('鎖定移動的動作期間，最後一筆位置晚到時只滑到定點、不播走路（不會取消動作動畫）', () => {
    const p = makePlayers()
    p.upsert(snap('b', 1), 0)
    p.setRemoteTargetByN(1, 0.2, 0, 0, true, 1000)
    const r = p.remotes.get('b')!
    r.lockedUntil = 9000 // 動作訊息先到
    p.setRemoteTargetByN(1, 0.4, 0, 0, false, 1100) // 下一個 tick 才收到停下的位置
    p.update(1150, 0.05, 0)
    expect(r.anim.moving).toBe(false)
    p.update(3000, 0.05, 0)
    expect(r.x).toBeCloseTo(0.4, 9)
    p.setRemoteTargetByN(1, 2, 0, 0, true, 9500) // 動作結束後再走就恢復
    p.update(9550, 0.05, 0)
    expect(r.anim.moving).toBe(true)
  })

  it('移動中超過 1 秒沒有位置更新，視為停止', () => {
    const p = makePlayers()
    p.upsert(snap('b', 1), 0)
    p.setRemoteTargetByN(1, 0.2, 0, 0, true, 1000)
    const r = p.remotes.get('b')!
    p.update(1000 + REMOTE_MOVE_TIMEOUT_MS, 0.016, 0)
    expect(r.serverMoving).toBe(true)
    p.update(1000 + REMOTE_MOVE_TIMEOUT_MS + 1, 0.016, 0)
    expect(r.serverMoving).toBe(false)
    expect(r.anim.moving).toBe(false)
  })
})

describe('Players 衣裝', () => {
  const outfitOf = (a: unknown) => (a as { outfit: number }).outfit
  it('本機衣裝由建構參數決定；遠端從快照讀取，沒有或無效時為 0', () => {
    const anim = { apply() {}, isActive: () => false }
    const p = new Players({ add() {} } as never, anim as never, 50, 3)
    expect(p.local.outfit).toBe(3)
    expect(outfitOf(p.local.avatar)).toBe(3)
    expect(p.upsert({ ...snap('a', 1), outfit: 4 }, 0).outfit).toBe(4)
    expect(p.upsert(snap('b', 2), 0).outfit).toBe(0)
    expect(p.upsert({ ...snap('c', 3), outfit: 99 } as never, 0).outfit).toBe(0)
  })

  it('setOutfit 更新本機（null）與遠端玩家；找不到或沒變時回傳 false', () => {
    const p = makePlayers()
    const r = p.upsert(snap('b', 1), 0)
    expect(p.setOutfit('b', 5)).toBe(true)
    expect(r.outfit).toBe(5)
    expect(outfitOf(r.avatar)).toBe(5)
    expect(p.setOutfit('b', 5)).toBe(false)
    expect(p.setOutfit(null, 2)).toBe(true)
    expect(outfitOf(p.local.avatar)).toBe(2)
    expect(p.setOutfit('zzz', 1)).toBe(false)
    expect(p.setOutfit(null, 8)).toBe(true) // 無效值（含比這個版本新的編號）當成預設
    expect(p.local.outfit).toBe(0)
  })

  it('既有玩家的快照帶新衣裝時更新，沒帶時保留', () => {
    const p = makePlayers()
    const r = p.upsert({ ...snap('b', 1), outfit: 2 }, 0)
    p.upsert(snap('b', 1), 10)
    expect(r.outfit).toBe(2)
    p.upsert({ ...snap('b', 1), outfit: 1 }, 20)
    expect(outfitOf(r.avatar)).toBe(1)
  })

  it('setRemoteOutfit 只動遠端玩家：自己的（較舊）回音與未知 id 不會改掉本機外觀', () => {
    const p = makePlayers()
    const r = p.upsert({ ...snap('b', 1), outfit: 1 }, 0)
    p.setOutfit(null, 4) // 本機連點：先 3 再 4，之後 3 的回音（id 為自己）才到
    expect(p.setRemoteOutfit('me', 3)).toBe(false) // 自己不在 remotes
    expect(p.local.outfit).toBe(4)
    expect(outfitOf(p.local.avatar)).toBe(4)
    expect(p.setRemoteOutfit('zzz', 2)).toBe(false)
    expect(p.setRemoteOutfit('b', 5)).toBe(true)
    expect(outfitOf(r.avatar)).toBe(5)
  })

  it('welcome 流程：遠端取快照衣裝，本機以本機設定為準（自己的快照不經 upsert）', () => {
    const anim = { apply() {}, isActive: () => false }
    const p = new Players({ add() {} } as never, anim as never, 50, 2)
    const players = [
      { ...snap('me', 0), outfit: 5 }, // 伺服器記錄的自己（可能較舊）
      { ...snap('b', 1), outfit: 3 },
    ]
    for (const s of players) if (s.id !== 'me') p.upsert(s, 0) // GameCore welcome 對自己不呼叫 upsert
    expect(p.local.outfit).toBe(2)
    expect(p.remotes.get('b')?.outfit).toBe(3)
  })
})
