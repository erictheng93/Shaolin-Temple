import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BELL_HALL_GAIN, BELL_HALL_LOWPASS_HZ, BELL_HIT_MS, BELL_MS, BELL_PULL_MS, BELL_QUIET_MS, BELL_STATIONS } from '../../world/bell'
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

  it('鐘聲未歇（有人正在敲，或撞到後 5 秒內）時不出發，提示稍候', () => {
    const { actions, events } = setup()
    const def = actions.get('bell')!
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('p-remote', t0))
    // 還沒撞到也算
    expect(def.approach!(yard())).toMatch(/鐘聲未歇，約 \d+ 秒後再敲/)
    vi.advanceTimersByTime(BELL_HIT_MS + BELL_QUIET_MS - 1)
    expect(def.approach!(yard())).toBeTypeOf('string')
    vi.advanceTimersByTime(1)
    expect(BELL_STATIONS).toContain(def.approach!(yard()))
  })

  it('兩人幾乎同時敲：2 秒內的第二聲壓低，不會疊成兩聲一樣大的鐘', () => {
    const { events, played, positions } = setup()
    positions.set('local', { x: 0, z: 11, zone: 'courtyard' })
    const t0 = performance.now()
    events.emit('actionPerformed', bellEvent('p-a', t0))
    events.emit('actionPerformed', bellEvent('p-b', t0 + 500))
    vi.advanceTimersByTime(BELL_MS)
    expect(played.map((p) => p.name)).toEqual(['bell', 'bell'])
    expect(played[1]!.gain!).toBeCloseTo(played[0]!.gain! * 0.35)
    expect(played[0]!.gain!).toBeGreaterThan(0.3)
    expect(played.every((p) => p.lowpass === undefined)).toBe(true)
  })

  it('聽者在殿內：以殿內固定音量播放（不依座標），鐘不擺（庭院場景沒在更新）；太晚收到（背景回來）不補響', () => {
    const { events, played, swings, positions } = setup()
    positions.set('local', { x: 0, z: 5, zone: 'hall' })
    events.emit('actionPerformed', bellEvent('p-a', performance.now()))
    vi.advanceTimersByTime(BELL_MS)
    expect(swings).toHaveLength(0)
    expect(played.map((p) => [p.name, p.gain])).toEqual([['bell', BELL_HALL_GAIN]])
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
    events.emit('actionPerformed', bellEvent('p-b', t0 + 500))
    vi.advanceTimersByTime(BELL_MS)
    expect(played.map((p) => p.gain)).toEqual([BELL_HALL_GAIN, BELL_HALL_GAIN * 0.35])
  })

  it('聽者在殿內也記錄鐘聲未歇：走出去馬上敲要等', () => {
    const { actions, events, positions } = setup()
    positions.set('local', { x: 0, z: 5, zone: 'hall' })
    events.emit('actionPerformed', bellEvent('p-a', performance.now()))
    vi.advanceTimersByTime(BELL_HIT_MS + 1000)
    expect(actions.get('bell')!.approach!(yard())).toMatch(/鐘聲未歇/)
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
