import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BELL_CENTER,
  BELL_COOLDOWN_MS,
  BELL_CREW_SWING,
  BELL_HALL_GAIN,
  BELL_HALL_LOWPASS_HZ,
  BELL_HIT_MS,
  BELL_JOIN_MS,
  BELL_MS,
  BELL_PULL_MS,
  BELL_QUIET_MS,
  BELL_STATIONS,
  bellCrewGain,
  bellGain,
} from '../../world/bell'
import type { SpotContext } from '../../world/worship'
import { pose, setup } from './testHarness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const yard = (over: Partial<SpotContext> = {}): SpotContext => ({ zone: 'courtyard', x: 12, z: 4, selfId: 'p-a', others: [], ...over })
const bellEvent = (playerId: string, startedAt: number, local = false) =>
  ({ playerId, actionId: 'bell', local, zone: 'courtyard', startedAt, x: 12, z: -1.5 }) as const
/** 進房快照帶進來的動作（GameCore 在 welcome 之後送的 snapshotActions）。 */
const snapshot = (...actions: Array<[playerId: string, startedAt: number, actionId?: string]>) => ({
  actions: actions.map(([playerId, startedAt, actionId = 'bell']) => ({ playerId, actionId, zone: 'courtyard', startedAt, x: 12, z: -1.5 })),
})
/** 站在 (12, -1.5) 聽一聲 crew 人的鐘（前面沒有別的鐘聲）的音量。 */
const nearGain = (crew: number) => bellGain(Math.hypot(12 - BELL_CENTER.x, -1.5 - BELL_CENTER.z), -Infinity, 0) * bellCrewGain(crew)

describe('敲鐘', () => {
  it('走到鐘亭前的空站位（避開有人的）；只在庭院', () => {
    const { actions } = setup()
    const def = actions.get('bell')!
    expect(def.locksMovement).toBe(true)
    // 個人冷卻 6 秒，且小於兩聲最短間隔，同一組人才能每一聲都敲
    expect(def.cooldownMs).toBe(BELL_COOLDOWN_MS)
    expect(def.cooldownMs).toBeLessThan(BELL_HIT_MS + BELL_QUIET_MS)
    expect(def.unavailableReason!('hall')).toBeTruthy()
    const spot = def.approach!(yard())
    expect(BELL_STATIONS).toContain(spot)
    const other = def.approach!(yard({ others: [spot as { x: number; z: number }] }))
    expect(other).not.toBe(spot)
  })

  it('撞到鐘的那一刻才擺動與發聲，按下時只開始撞木的時間軸；遠端以 startedAt 推算同一時刻', () => {
    const { events, played, swings, strikes, positions } = setup()
    positions.set('local', { x: 12, z: -1.5, zone: 'courtyard' })
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('local', t0, true))
    expect(strikes).toEqual([t0])
    expect(played).toEqual([])
    vi.advanceTimersByTime(BELL_HIT_MS - 1)
    expect(swings).toEqual([])
    vi.advanceTimersByTime(1)
    expect(swings).toEqual([t0 + BELL_HIT_MS])
    expect(played.map((p) => [p.name, p.t])).toEqual([['bell', t0 + BELL_HIT_MS]])

    // 遠端：動作訊息晚 300 毫秒才到（startedAt 已換算成本機時間），撞擊仍在 startedAt + BELL_HIT_MS
    vi.advanceTimersByTime(20_000)
    const t1 = performance.now() - 300
    events.emit('actionPerformed', bellEvent('p-remote', t1))
    vi.advanceTimersByTime(BELL_MS)
    expect(swings[1]).toBe(t1 + BELL_HIT_MS)
    expect(played[1]).toMatchObject({ name: 'bell', t: t1 + BELL_HIT_MS })
  })

  it('鐘聲未歇（有人正在敲，或撞到後 5 秒內）時仍出發到空站位，抵達後就位等候到靜默期結束', () => {
    const { actions, events } = setup()
    const def = actions.get('bell')!
    expect(def.startWait!(performance.now())).toBe(0)
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('p-remote', t0))
    // 不再拒絕：仍回傳站位
    expect(BELL_STATIONS).toContain(def.approach!(yard()))
    // 剛開始的這一聲還能加入：立刻開始
    vi.advanceTimersByTime(BELL_JOIN_MS)
    expect(def.startWait!(performance.now())).toBe(0)
    // 過了加入窗口（還沒撞到也算未歇）：要等到撞到後 5 秒
    vi.advanceTimersByTime(1)
    expect(def.startWait!(performance.now())).toBe(t0 + BELL_HIT_MS + BELL_QUIET_MS - performance.now())
    vi.advanceTimersByTime(BELL_HIT_MS + BELL_QUIET_MS - BELL_JOIN_MS - 2)
    expect(def.startWait!(performance.now())).toBe(1)
    vi.advanceTimersByTime(1)
    expect(def.startWait!(performance.now())).toBe(0)
  })

  it('三條繩子都有人拉了：第四人不能加入這一聲，要等靜默期', () => {
    const { actions, events } = setup()
    const t0 = performance.now()
    for (const id of ['p-a', 'p-b', 'p-c']) events.emit('actionPerformed', bellEvent(id, t0))
    expect(actions.get('bell')!.startWait!(t0 + 100)).toBeGreaterThan(0)
  })

  it('合力敲鐘：三人在窗口內開始只響一聲（三人倍率）、撞木只走開啟者的時間軸、鐘只擺一次（較大）', () => {
    const solo = setup()
    solo.positions.set('local', { x: 12, z: -1.5, zone: 'courtyard' })
    solo.events.emit('actionPerformed', bellEvent('p-a', performance.now()))
    vi.advanceTimersByTime(BELL_MS)

    const { events, played, swings, swingStrengths, strikes, positions } = setup()
    positions.set('local', { x: 12, z: -1.5, zone: 'courtyard' })
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('local', t0, true))
    vi.advanceTimersByTime(200)
    events.emit('actionPerformed', bellEvent('p-b', t0 + 150))
    // 亂序：開始得比開啟者早、晚到的也加入，不改時間軸
    events.emit('actionPerformed', bellEvent('p-c', t0 - 120))
    // 重複的事件不重複計入
    events.emit('actionPerformed', bellEvent('p-b', t0 + 150))
    expect(strikes).toEqual([t0])
    vi.advanceTimersByTime(BELL_MS)
    expect(played.map((p) => [p.name, p.t])).toEqual([['bell', t0 + BELL_HIT_MS]])
    expect(played[0]!.gain!).toBeCloseTo((solo.played[0]!.gain! * bellCrewGain(3)) / bellCrewGain(1))
    expect(played[0]!.gain!).toBeLessThanOrEqual(1)
    expect(swings).toEqual([t0 + BELL_HIT_MS])
    expect(swingStrengths).toEqual([BELL_CREW_SWING[2]])
    expect(solo.swingStrengths).toEqual([1])
  })

  it('合力敲鐘：加入者（本機與遠端）的動作時間軸重設到這一聲的 t0，開啟者不重設', () => {
    const { events, retimed } = setup()
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('p-a', t0))
    expect(retimed).toEqual([])
    vi.advanceTimersByTime(400)
    // 本機加入：自己的動作在 t0 + 400 開始，改走 t0 的時間軸
    events.emit('actionPerformed', bellEvent('local', t0 + 400, true))
    events.emit('actionPerformed', bellEvent('p-b', t0 + 650))
    // 重複的事件不再重設
    events.emit('actionPerformed', bellEvent('p-b', t0 + 650))
    expect(retimed).toEqual([
      { playerId: 'local', actionId: 'bell', startedAt: t0 },
      { playerId: 'p-b', actionId: 'bell', startedAt: t0 },
    ])
    // 超過加入窗口的另開一聲：開啟者不重設
    events.emit('actionPerformed', bellEvent('p-c', t0 + BELL_JOIN_MS + 300))
    expect(retimed).toHaveLength(2)
  })

  it('合力敲鐘亂序：開啟得較早的事件晚到時加入既有那一聲，對齊的是那一聲的 t0（不往前移）', () => {
    const { events, retimed, strikes } = setup()
    const t0 = performance.now()
    // 加入者 p-b 的事件先到，開啟了這一聲；較早開始的 p-a 晚到
    events.emit('actionPerformed', bellEvent('p-b', t0))
    vi.advanceTimersByTime(300)
    events.emit('actionPerformed', bellEvent('p-a', t0 - 250))
    events.emit('actionPerformed', bellEvent('local', t0 + 300, true))
    expect(strikes).toEqual([t0])
    expect(retimed).toEqual([
      { playerId: 'p-a', actionId: 'bell', startedAt: t0 },
      { playerId: 'local', actionId: 'bell', startedAt: t0 },
    ])
  })

  it('撞到之後才到的加入者不補響、不重啟撞木', () => {
    const { events, played, swings, strikes, positions } = setup()
    positions.set('local', { x: 12, z: -1.5, zone: 'courtyard' })
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('p-a', t0))
    vi.advanceTimersByTime(BELL_HIT_MS + 100)
    events.emit('actionPerformed', bellEvent('p-b', t0 + 300))
    vi.advanceTimersByTime(BELL_MS)
    expect(strikes).toEqual([t0])
    expect(played).toHaveLength(1)
    expect(swings).toHaveLength(1)
  })

  it('兩人幾乎同時敲卻不在同一聲（超過加入窗口）：2 秒內的第二聲壓低，不會疊成兩聲一樣大的鐘', () => {
    const { events, played, strikes, positions } = setup()
    positions.set('local', { x: 0, z: 11, zone: 'courtyard' })
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('p-a', t0))
    events.emit('actionPerformed', bellEvent('p-b', t0 + BELL_JOIN_MS + 300))
    vi.advanceTimersByTime(BELL_MS * 2)
    expect(strikes).toEqual([t0, t0 + BELL_JOIN_MS + 300])
    expect(played.map((p) => p.name)).toEqual(['bell', 'bell'])
    expect(played[1]!.gain!).toBeCloseTo(played[0]!.gain! * 0.35)
    expect(played[0]!.gain!).toBeGreaterThan(0.3 * bellCrewGain(1))
    expect(played.every((p) => p.lowpass === undefined)).toBe(true)
  })

  it('聽者在殿內：以殿內固定音量播放（不依座標），鐘不擺（庭院場景沒在更新）；太晚收到（背景回來）不補響', () => {
    const { events, played, swings, positions } = setup()
    positions.set('local', { x: 0, z: 5, zone: 'hall' })
    events.emit('actionPerformed', bellEvent('p-a', performance.now()))
    vi.advanceTimersByTime(BELL_MS)
    expect(swings).toHaveLength(0)
    expect(played.map((p) => [p.name, p.gain])).toEqual([['bell', BELL_HALL_GAIN * bellCrewGain(1)]])
    expect(played[0]!.lowpass).toBe(BELL_HALL_LOWPASS_HZ)
    positions.set('local', { x: 0, z: 5, zone: 'courtyard' })
    events.emit('actionPerformed', bellEvent('p-a', performance.now() - BELL_HIT_MS - 2000))
    vi.advanceTimersByTime(BELL_MS)
    expect(swings).toHaveLength(0)
    expect(played).toHaveLength(1)
  })

  it('聽者在殿內：2 秒內的第二聲仍套合併倍率', () => {
    const { events, played, positions } = setup()
    positions.set('local', { x: 0, z: 5, zone: 'hall' })
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('p-a', t0))
    events.emit('actionPerformed', bellEvent('p-b', t0 + BELL_JOIN_MS + 300))
    vi.advanceTimersByTime(BELL_MS * 2)
    const solo = BELL_HALL_GAIN * bellCrewGain(1)
    expect(played).toHaveLength(2)
    expect(played[0]!.gain!).toBeCloseTo(solo)
    expect(played[1]!.gain!).toBeCloseTo(solo * 0.35)
  })

  it('聽者在殿內：合力敲鐘同樣套人數倍率，仍有低通濾波', () => {
    const { events, played, swings, positions } = setup()
    positions.set('local', { x: 0, z: 5, zone: 'hall' })
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('p-a', t0))
    events.emit('actionPerformed', bellEvent('p-b', t0 + 300))
    vi.advanceTimersByTime(BELL_MS)
    expect(swings).toHaveLength(0)
    expect(played).toHaveLength(1)
    expect(played[0]!.gain!).toBeCloseTo(BELL_HALL_GAIN * bellCrewGain(2))
    expect(played[0]!.lowpass).toBe(BELL_HALL_LOWPASS_HZ)
  })

  it('聽者在殿內也記錄鐘聲未歇：走出去馬上敲要就位等候', () => {
    const { actions, events, positions } = setup()
    positions.set('local', { x: 0, z: 5, zone: 'hall' })
    events.emit('actionPerformed', bellEvent('p-a', performance.now()))
    vi.advanceTimersByTime(BELL_HIT_MS + 1000)
    expect(actions.get('bell')!.startWait!(performance.now())).toBe(BELL_QUIET_MS - 1000)
  })

  it('撞鐘動畫：拉繩後仰、撞到時前傾最大、最後回正', () => {
    const { anim } = setup()
    expect(pose(anim, 'bellStrike', BELL_MS, BELL_PULL_MS / BELL_MS).pivot.rotation.x).toBeLessThan(-0.2)
    expect(pose(anim, 'bellStrike', BELL_MS, BELL_HIT_MS / BELL_MS).pivot.rotation.x).toBeGreaterThan(0.3)
    expect(Math.abs(pose(anim, 'bellStrike', BELL_MS, 0.999).pivot.rotation.x)).toBeLessThan(0.02)
  })

  describe('進房快照裡正在敲鐘的人（snapshotActions）', () => {
    it('兩人同一聲（亂序給入）：一聲、兩人對齊最早開始的 t0、撞木一條時間軸、撞到時響一次（兩人音量）', () => {
      const { events, played, swings, swingStrengths, strikes, retimed, positions } = setup()
      positions.set('local', { x: 12, z: -1.5, zone: 'courtyard' })
      const t0 = performance.now() - 400
      events.emit('snapshotActions', snapshot(['p-b', t0 + 300], ['p-a', t0]))
      expect(strikes).toEqual([t0])
      expect(retimed).toEqual([{ playerId: 'p-b', actionId: 'bell', startedAt: t0 }])
      vi.advanceTimersByTime(BELL_HIT_MS - 400 - 1)
      expect(played).toEqual([])
      vi.advanceTimersByTime(1)
      expect(played.map((p) => [p.name, p.t])).toEqual([['bell', t0 + BELL_HIT_MS]])
      expect(played[0]!.gain!).toBeCloseTo(nearGain(2))
      expect(swings).toEqual([t0 + BELL_HIT_MS])
      expect(swingStrengths).toEqual([BELL_CREW_SWING[1]])
      vi.advanceTimersByTime(BELL_MS)
      expect(played).toHaveLength(1)
    })

    it('快照之後即時加入的第三人加入同一聲（三人音量）；同一個動作的即時事件晚到不重複計人、不重啟撞木', () => {
      const { actions, events, played, strikes, retimed, positions } = setup()
      positions.set('local', { x: 12, z: -1.5, zone: 'courtyard' })
      const def = actions.get('bell')!
      const t0 = performance.now() - 300
      events.emit('snapshotActions', snapshot(['p-a', t0], ['p-b', t0 + 200]))
      // 快照裡的 p-b 的即時事件晚到：仍是兩人，繩子還有空，可以加入
      events.emit('actionPerformed', bellEvent('p-b', t0 + 200))
      expect(def.startWait!(performance.now())).toBe(0)
      vi.advanceTimersByTime(100)
      events.emit('actionPerformed', bellEvent('p-c', t0 + 400))
      // 三條繩子都有人了
      expect(def.startWait!(performance.now())).toBeGreaterThan(0)
      expect(strikes).toEqual([t0])
      expect(retimed).toEqual([
        { playerId: 'p-b', actionId: 'bell', startedAt: t0 },
        { playerId: 'p-c', actionId: 'bell', startedAt: t0 },
      ])
      vi.advanceTimersByTime(BELL_MS)
      expect(played.map((p) => [p.name, p.t])).toEqual([['bell', t0 + BELL_HIT_MS]])
      expect(played[0]!.gain!).toBeCloseTo(nearGain(3))
    })

    it('剛開啟的一聲還能加入：剛進場按敲鐘立刻開始', () => {
      const { actions, events } = setup()
      events.emit('snapshotActions', snapshot(['p-a', performance.now() - 200]))
      expect(actions.get('bell')!.startWait!(performance.now())).toBe(0)
    })

    it('快照裡的動作已經撞過很久：不響、不擺，但鐘聲未歇仍依它判斷（撞到後 5 秒內按敲鐘要等候，過了立刻開始）', () => {
      // 撞到已 3.25 秒（超過 LATE_MS）：不補響；剛進場按敲鐘要等到撞到後 5 秒，即再等 1.75 秒
      const a = setup()
      a.positions.set('local', { x: 12, z: -1.5, zone: 'courtyard' })
      const startedAt = performance.now() - 5000
      a.events.emit('snapshotActions', snapshot(['p-a', startedAt]))
      vi.advanceTimersByTime(BELL_MS)
      expect(a.played).toEqual([])
      expect(a.swings).toEqual([])
      expect(a.actions.get('bell')!.startWait!(startedAt + 5000)).toBe(BELL_HIT_MS + BELL_QUIET_MS - 5000)
      expect(a.actions.get('bell')!.startWait!(startedAt + BELL_HIT_MS + BELL_QUIET_MS)).toBe(0)

      // 動作還在進行中、但撞到已超過 LATE_MS（1.5 秒）：同樣不補響，等候時間照算
      const b = setup()
      b.positions.set('local', { x: 12, z: -1.5, zone: 'courtyard' })
      const recent = performance.now() - (BELL_HIT_MS + 1600)
      b.events.emit('snapshotActions', snapshot(['p-a', recent]))
      vi.advanceTimersByTime(BELL_MS)
      expect(b.played).toEqual([])
      expect(b.actions.get('bell')!.startWait!(recent + BELL_HIT_MS + 1600)).toBe(BELL_QUIET_MS - 1600)

      // 撞到已超過 5 秒：立刻開始
      const c = setup()
      c.events.emit('snapshotActions', snapshot(['p-a', performance.now() - 10_000]))
      vi.advanceTimersByTime(BELL_MS)
      expect(c.played).toEqual([])
      expect(c.actions.get('bell')!.startWait!(performance.now())).toBe(0)
    })

    it('聽者在殿內：快照帶進來的一聲照殿內規則（固定音量、低通、不擺鐘）', () => {
      const { events, played, swings, positions } = setup()
      positions.set('local', { x: 0, z: 5, zone: 'hall' })
      events.emit('snapshotActions', snapshot(['p-a', performance.now() - 100], ['p-b', performance.now()]))
      vi.advanceTimersByTime(BELL_MS)
      expect(swings).toEqual([])
      expect(played).toHaveLength(1)
      expect(played[0]!.gain!).toBeCloseTo(BELL_HALL_GAIN * bellCrewGain(2))
      expect(played[0]!.lowpass).toBe(BELL_HALL_LOWPASS_HZ)
    })

    it('其他模組不因快照補播聲音或補插香（參拜、上香、誦經）', () => {
      const { events, played, offered, positions } = setup()
      positions.set('local', { x: 0, z: 5, zone: 'hall' })
      const now = performance.now()
      events.emit('snapshotActions', snapshot(['p-a', now, 'bow'], ['p-b', now - 100, 'prostrate'], ['p-c', now - 50, 'incense'], ['p-d', now - 10, 'chant']))
      vi.advanceTimersByTime(30_000)
      expect(played).toEqual([])
      expect(offered).toEqual([])
    })
  })

  it('uninstall 後不再擺動或發聲', () => {
    const { events, played, swings, uninstall } = setup()
    events.emit('actionPerformed', bellEvent('p-a', performance.now()))
    uninstall()
    vi.advanceTimersByTime(BELL_MS)
    expect(swings).toHaveLength(0)
    expect(played).toHaveLength(0)
  })
})
