import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PIVOT_HEIGHT, PROP_CHANT, PROP_NONE } from '../../render/AvatarFactory'
import { HALL_CUSHIONS } from '../../world/zones'
import {
  CHANT_BEAT_MS,
  CHANT_END_MS,
  CHANT_HEARING_RANGE,
  CHANT_MS,
  QING_END_MS,
  QING_START_MS,
  chantBeats,
  malletLift,
  planChantSounds,
  type ChanterInfo,
} from './chant'
import { pose, setup } from './testHarness'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const chantEvent = (playerId: string, actionId: string, startedAt: number, local = false) =>
  ({ playerId, actionId, local, zone: 'hall', startedAt, x: 0, z: 0 }) as const
const woods = (played: ReturnType<typeof setup>['played']) => played.filter((p) => p.name === 'wood')
const qings = (played: ReturnType<typeof setup>['played']) => played.filter((p) => p.name === 'qing')
const onGrid = (s: number) => Math.abs(s / CHANT_BEAT_MS - Math.round(s / CHANT_BEAT_MS)) < 1e-6

describe('誦經：動作', () => {
  it('走到殿內最近的空蒲團（與跪拜相同的選法）；庭院不能用', () => {
    const { actions } = setup()
    const def = actions.get('chant')!
    expect(def.locksMovement).toBe(true)
    expect(def.unavailableReason!('courtyard')).toContain('殿內')
    const ctx = { zone: 'hall' as const, x: 1.8, z: 3.5, selfId: 'p-a', others: [] }
    expect(def.approach!(ctx)).toBe(HALL_CUSHIONS.find((c) => c.x === 1.8 && c.z === 3.1))
    expect(def.approach!({ ...ctx, others: [{ x: 1.8, z: 3.1 }] })).not.toMatchObject({ x: 1.8, z: 3.1 })
    expect(def.approach!({ ...ctx, zone: 'courtyard' })).toBeTypeOf('string')
    // 起身不顯示在動作列、不鎖定
    const end = actions.get('chant_end')!
    expect(end.hidden).toBe(true)
    expect(end.locksMovement).toBeFalsy()
  })

  it('跪坐、身前有木魚與槌；槌在拍點上剛好敲到木魚（角度 0），兩拍之間抬起', () => {
    const { anim } = setup()
    const at = (ms: number) => pose(anim, 'chant', CHANT_MS, ms / CHANT_MS)
    // 片段從 0 開始、時鐘差 0：第一拍是 STRIKES_FROM_MS 之後第一個 900 的倍數
    const { first, last } = chantBeats(0)
    const mid = at(first + CHANT_BEAT_MS * 3)
    expect(mid.pivot.position.y).toBeCloseTo(PIVOT_HEIGHT - 0.3)
    expect(mid.prop).toBe(PROP_CHANT)
    expect(mid.pivot.rotation.x).toBeLessThan(0.3) // 跪坐，不叩拜
    for (let b = first; b <= last; b += CHANT_BEAT_MS) expect(at(b).propAngle).toBeCloseTo(0, 6)
    expect(at(first + CHANT_BEAT_MS * 0.6).propAngle).toBeGreaterThan(0.5)
    // 結尾起身、放下道具
    expect(at(CHANT_MS - 1).prop).toBe(PROP_NONE)
    expect(at(CHANT_MS - 1).pivot.position.y).toBeCloseTo(PIVOT_HEIGHT, 1)
    // 提前結束的起身
    expect(pose(anim, 'chantEnd', CHANT_END_MS, 0).pivot.position.y).toBeCloseTo(PIVOT_HEIGHT - 0.3)
    expect(pose(anim, 'chantEnd', CHANT_END_MS, 0.999).pivot.position.y).toBeCloseTo(PIVOT_HEIGHT, 2)
  })

  it('槌的抬起是連續的（進入與離開敲擊段都不跳動）', () => {
    const startS = 123_456.7
    let prev = malletLift(startS, startS)
    for (let t = startS; t < startS + CHANT_MS; t += 10) {
      const v = malletLift(t, startS)
      expect(Math.abs(v - prev)).toBeLessThan(0.08)
      prev = v
    }
  })
})

describe('誦經：多人時的聲音（共同節拍格，每拍只發一聲）', () => {
  // 六個人在不同時間開始（含自己），距離各不相同
  const crowd: ChanterInfo[] = [
    { startS: 10_000, local: true, distance: 0 },
    { startS: 10_437, local: false, distance: 1.3 },
    { startS: 11_250, local: false, distance: 3 },
    { startS: 12_901, local: false, distance: 6 },
    { startS: 14_077, local: false, distance: 9 },
    { startS: 15_500, local: false, distance: 15 },
  ]

  it('所有木魚都落在同一個節拍格上，每一拍最多一聲，音量有上限', () => {
    const sounds = planChantSounds(crowd, 0, 60_000)
    const wood = sounds.filter((s) => s.sound === 'wood')
    expect(wood.length).toBeGreaterThan(10)
    expect(new Set(wood.map((s) => s.atS)).size).toBe(wood.length)
    for (const s of wood) {
      expect(onGrid(s.atS)).toBe(true)
      expect(s.gain).toBeLessThanOrEqual(0.55 + 1e-9)
    }
    // 從第一個人的第一拍到最後一個人的最後一拍，每一拍都有一聲（節奏不中斷）
    const first = Math.min(...crowd.map((c) => chantBeats(c.startS).first))
    const last = Math.max(...crowd.map((c) => chantBeats(c.startS).last))
    expect(wood.length).toBe((last - first) / CHANT_BEAT_MS + 1)
  })

  it('每一聲木魚的時刻，每個正在敲的人的槌都剛好落在木魚上（畫面與聲音一致）', () => {
    for (const s of planChantSounds(crowd, 0, 60_000).filter((x) => x.sound === 'wood')) {
      for (const c of crowd) {
        const { first, last } = chantBeats(c.startS)
        if (s.atS >= first && s.atS <= last) expect(malletLift(s.atS, c.startS)).toBeCloseTo(0, 6)
      }
    }
  })

  it('人多時只略為加大（最多 1.4 倍）；聽不到的人（太遠）不出聲', () => {
    const alone = planChantSounds([crowd[1]!], 0, 60_000).filter((s) => s.sound === 'wood')
    const many = planChantSounds(crowd.slice(1), 0, 60_000).filter((s) => s.sound === 'wood')
    const maxAlone = Math.max(...alone.map((s) => s.gain))
    expect(Math.max(...many.map((s) => s.gain))).toBeLessThanOrEqual(maxAlone * 1.4 + 1e-9)
    expect(planChantSounds([{ startS: 0, local: false, distance: CHANT_HEARING_RANGE + 1 }], 0, 60_000)).toEqual([])
  })

  it('引磬：每人開頭與結尾各一聲，幾乎同時的引磬只留一聲', () => {
    const one = planChantSounds([crowd[0]!], 0, 60_000).filter((s) => s.sound === 'qing')
    expect(one.map((s) => s.atS)).toEqual([10_000 + QING_START_MS, 10_000 + QING_END_MS])
    const twin = planChantSounds(
      [
        { startS: 0, local: true, distance: 0 },
        { startS: 200, local: false, distance: 2 },
      ],
      0,
      60_000,
    ).filter((s) => s.sound === 'qing')
    expect(twin).toHaveLength(2)
  })

  it('分段排程不漏拍也不重複（每段是 (from, to]）', () => {
    const whole = planChantSounds(crowd, 0, 60_000)
    const pieces = []
    for (let t = 0; t < 60_000; t += 137) pieces.push(...planChantSounds(crowd, t, t + 137))
    expect(pieces).toEqual(whole)
  })
})

describe('誦經：模組的排程', () => {
  it('兩人先後開始：本機每一拍只播一聲木魚，拍點對齊伺服器時間的節拍格', () => {
    const { events, played, positions, clock } = setup()
    clock.offset = 1_700_000_000_123.4 - performance.now()
    positions.set('local', { x: 1.8, z: 3.1, zone: 'hall' })
    positions.set('p-b', { x: 3.05, z: 3.1, zone: 'hall' })
    const t0 = performance.now()
    events.emit('actionPerformed', chantEvent('local', 'chant', t0, true))
    vi.advanceTimersByTime(1300)
    events.emit('actionPerformed', chantEvent('p-b', 'chant', performance.now(), false))
    vi.advanceTimersByTime(CHANT_MS + 2000)
    const w = woods(played)
    const ats = w.map((p) => p.at! + clock.offset)
    expect(new Set(ats).size).toBe(ats.length)
    for (const s of ats) expect(onGrid(s)).toBe(true)
    // 兩人的敲擊段聯集，每拍一聲
    const a = chantBeats(t0 + clock.offset)
    const b = chantBeats(t0 + 1300 + clock.offset)
    expect(w.length).toBe((b.last - a.first) / CHANT_BEAT_MS + 1)
    // 每一聲都提前排程在 AudioContext 上（at 不早於排程當下）
    for (const p of w) expect(p.at!).toBeGreaterThanOrEqual(p.t)
    expect(qings(played)).toHaveLength(4)
  })

  it('提前起身（chant_end）：之後不再有木魚，也沒有收尾的引磬；沒人誦經時計時器停止', () => {
    const { events, played, positions } = setup()
    positions.set('local', { x: 1.8, z: 3.1, zone: 'hall' })
    const t0 = performance.now()
    events.emit('actionPerformed', chantEvent('local', 'chant', t0, true))
    vi.advanceTimersByTime(8000)
    const before = woods(played).length
    expect(before).toBeGreaterThan(3)
    const endAt = performance.now()
    events.emit('actionPerformed', chantEvent('local', 'chant_end', endAt, true))
    vi.advanceTimersByTime(CHANT_MS)
    // 已排程的最多 200 毫秒內一聲
    expect(woods(played).filter((p) => p.at! > endAt + 200)).toEqual([])
    expect(woods(played).length - before).toBeLessThanOrEqual(1)
    expect(qings(played)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('不同場景或太遠的人的木魚聽不到；完整誦完有開頭與收尾兩聲引磬', () => {
    const { events, played, positions } = setup()
    positions.set('local', { x: 0, z: 0, zone: 'courtyard' })
    positions.set('p-b', { x: 1.8, z: 3.1, zone: 'hall' })
    events.emit('actionPerformed', chantEvent('p-b', 'chant', performance.now()))
    vi.advanceTimersByTime(CHANT_MS + 1000)
    expect(played).toEqual([])
    positions.set('local', { x: -1.8, z: 3.1, zone: 'hall' })
    events.emit('actionPerformed', chantEvent('p-b', 'chant', performance.now()))
    vi.advanceTimersByTime(CHANT_MS + 1000)
    expect(qings(played)).toHaveLength(2)
    expect(woods(played).length).toBeGreaterThan(15)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uninstall 清除排程', () => {
    const { events, played, uninstall, positions } = setup()
    positions.set('local', { x: 1.8, z: 3.1, zone: 'hall' })
    events.emit('actionPerformed', chantEvent('local', 'chant', performance.now(), true))
    uninstall()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(CHANT_MS)
    expect(played).toEqual([])
  })
})
