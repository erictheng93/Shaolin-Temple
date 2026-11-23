import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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

describe('敲鐘', () => {
  it('走到鐘亭前的空站位（避開有人的）；只在庭院', () => {
    const { actions } = setup()
    const def = actions.get('bell')!
    expect(def.locksMovement).toBe(true)
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

  it('uninstall 後不再擺動或發聲', () => {
    const { events, played, swings, uninstall } = setup()
    events.emit('actionPerformed', bellEvent('p-a', performance.now()))
    uninstall()
    vi.advanceTimersByTime(BELL_MS)
    expect(swings).toHaveLength(0)
    expect(played).toHaveLength(0)
  })
})
