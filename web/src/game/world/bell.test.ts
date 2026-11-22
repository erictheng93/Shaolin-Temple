import { describe, expect, it } from 'vitest'
import {
  BELL_CENTER,
  BELL_HIT_MS,
  BELL_MERGE_MS,
  BELL_MS,
  BELL_QUIET_MS,
  BELL_STATIONS,
  STRIKER,
  STRIKER_CONTACT,
  BELL_HALL_GAIN,
  bellGain,
  bellHallGain,
  bellQuietLeft,
  pickBellStation,
  strikerAngle,
} from './bell'
import { BELL_PAVILION, OBSTACLES, PLAYER_RADIUS } from './layout'
import { OCCUPIED_RADIUS, type SpotContext } from './worship'
import { ZONES } from './zones'

const ctx = (over: Partial<SpotContext> = {}): SpotContext => ({
  zone: 'courtyard',
  x: ZONES.courtyard.spawn.x,
  z: ZONES.courtyard.spawn.z,
  selfId: 'p-a',
  others: [],
  ...over,
})

describe('鐘亭站位', () => {
  it('三個站位在鐘亭面向庭院的一側、在鐘亭障礙物之外', () => {
    expect(BELL_STATIONS).toHaveLength(3)
    for (const s of BELL_STATIONS) {
      expect(s.z).toBeGreaterThan(BELL_PAVILION.maxZ + PLAYER_RADIUS)
      expect(s.x).toBeGreaterThan(BELL_PAVILION.minX)
      expect(s.x).toBeLessThan(BELL_PAVILION.maxX)
      for (const o of OBSTACLES) expect(s.x > o.minX && s.x < o.maxX && s.z > o.minZ && s.z < o.maxZ).toBe(false)
    }
  })

  it('彼此不重疊（間距大於兩個角色半徑，也大於視為有人的距離）', () => {
    BELL_STATIONS.forEach((a, i) =>
      BELL_STATIONS.forEach((b, j) => {
        if (i < j) {
          const d = Math.hypot(a.x - b.x, a.z - b.z)
          expect(d).toBeGreaterThan(PLAYER_RADIUS * 2)
          expect(d).toBeGreaterThan(OCCUPIED_RADIUS)
        }
      }),
    )
  })

  it('每個站位都面向鐘', () => {
    for (const s of BELL_STATIONS) {
      // heading 的前方是 (sin h, cos h)
      const fx = Math.sin(s.heading)
      const fz = Math.cos(s.heading)
      const d = Math.hypot(BELL_CENTER.x - s.x, BELL_CENTER.z - s.z)
      expect((fx * (BELL_CENTER.x - s.x) + fz * (BELL_CENTER.z - s.z)) / d).toBeCloseTo(1, 6)
    }
  })

  it('只在庭院；避開有人的站位；都有人時回傳原因', () => {
    expect(pickBellStation(ctx({ zone: 'hall' }))).toBeTypeOf('string')
    const first = pickBellStation(ctx())
    expect(BELL_STATIONS).toContain(first)
    const second = pickBellStation(ctx({ others: [first as { x: number; z: number }] }))
    expect(BELL_STATIONS).toContain(second)
    expect(second).not.toBe(first)
    expect(pickBellStation(ctx({ others: BELL_STATIONS }))).toBeTypeOf('string')
  })
})

describe('撞木時間軸', () => {
  it('開始與結束時靜止；往後蓄力；撞到鐘的那一刻剛好碰到鐘面', () => {
    expect(strikerAngle(0)).toBe(0)
    expect(strikerAngle(BELL_MS)).toBe(0)
    expect(strikerAngle(1000)).toBeLessThan(-0.2)
    expect(strikerAngle(BELL_HIT_MS)).toBeCloseTo(STRIKER_CONTACT, 6)
    // 碰到時頭端剛好在鐘面（撞擊高度的半徑 0.547）
    const headZ = STRIKER.z - STRIKER.halfLength - STRIKER.length * Math.sin(STRIKER_CONTACT)
    expect(headZ).toBeCloseTo(BELL_CENTER.z + 0.547, 6)
  })

  it('整段都不會穿進鐘裡，撞到之前一直在往鐘的方向加速', () => {
    let prev = -Infinity
    for (let ms = 0; ms <= BELL_MS; ms += 5) {
      const a = strikerAngle(ms)
      expect(a).toBeLessThanOrEqual(STRIKER_CONTACT + 1e-9)
      if (ms > 1400 && ms <= BELL_HIT_MS) {
        expect(a).toBeGreaterThanOrEqual(prev)
      }
      prev = a
    }
  })
})

describe('多人輪流敲的聲音規則', () => {
  it('前一聲撞到後 5 秒內不能再出發敲', () => {
    expect(bellQuietLeft(-Infinity, 0)).toBe(0)
    expect(bellQuietLeft(1000, 1000)).toBe(BELL_QUIET_MS)
    expect(bellQuietLeft(1000, 1000 + BELL_QUIET_MS)).toBe(0)
  })

  it('依距離衰減（最遠仍有 0.3）；與前一聲太近的鐘聲壓低', () => {
    expect(bellGain(0, -Infinity, 0)).toBe(1)
    expect(bellGain(1000, -Infinity, 0)).toBe(0.3)
    const near = bellGain(3, -Infinity, 10_000)
    expect(bellGain(3, 10_000 - BELL_MERGE_MS + 1, 10_000)).toBeCloseTo(near * 0.35)
    expect(bellGain(3, 10_000 - BELL_MERGE_MS, 10_000)).toBe(near)
  })

  it('殿內聽者：固定音量，不看距離；2 秒內的第二聲同樣壓低', () => {
    expect(bellHallGain(-Infinity, 10_000)).toBe(BELL_HALL_GAIN)
    expect(BELL_HALL_GAIN).toBeLessThan(bellGain(3, -Infinity, 0))
    expect(bellHallGain(10_000 - BELL_MERGE_MS + 1, 10_000)).toBeCloseTo(BELL_HALL_GAIN * 0.35)
    expect(bellHallGain(10_000 - BELL_MERGE_MS, 10_000)).toBe(BELL_HALL_GAIN)
  })
})
