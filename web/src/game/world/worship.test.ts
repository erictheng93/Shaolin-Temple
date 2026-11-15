import { describe, expect, it } from 'vitest'
import { OCCUPIED_RADIUS, censerForPosition, pickCenserSpot, pickCushion, type SpotContext } from './worship'
import { COURTYARD_CENSER, HALL_CENSERS, HALL_CUSHIONS, ZONES } from './zones'

const ctx = (over: Partial<SpotContext> = {}): SpotContext => ({
  zone: 'hall',
  x: ZONES.hall.spawn.x,
  z: ZONES.hall.spawn.z,
  selfId: 'p-a',
  others: [],
  ...over,
})
const asPose = (v: ReturnType<typeof pickCushion>) => {
  if (typeof v === 'string') throw new Error(v)
  return v
}

describe('pickCushion', () => {
  it('不在殿內時回傳原因', () => {
    expect(pickCushion(ctx({ zone: 'courtyard' }))).toBeTypeOf('string')
  })

  it('選離自己近的空蒲團，避開已經有人的', () => {
    const first = asPose(pickCushion(ctx({ x: 1.8, z: 3.5 })))
    expect(first).toMatchObject({ x: 1.8, z: 3.1 })
    const second = asPose(pickCushion(ctx({ x: 1.8, z: 3.5, others: [{ x: 1.8, z: 3.1 }] })))
    expect(second).not.toMatchObject({ x: 1.8, z: 3.1 })
    expect(Math.hypot(second.x - 1.8, second.z - 3.5)).toBeLessThan(2.5)
  })

  it('已經跪在空蒲團上就用同一個', () => {
    const c = HALL_CUSHIONS[7]!
    expect(pickCushion(ctx({ x: c.x + 0.1, z: c.z }))).toBe(c)
  })

  it('兩人先後按下（後者看得到前者的位置）一定選到不同蒲團', () => {
    const a = asPose(pickCushion(ctx({ selfId: 'p-a' })))
    const b = asPose(pickCushion(ctx({ selfId: 'p-b', others: [a] })))
    expect(b).not.toBe(a)
  })

  it('同一處同時按下的兩人，多半選到不同蒲團（依 id 的小偏移）', () => {
    let same = 0
    for (let i = 0; i < 200; i++) {
      const a = pickCushion(ctx({ selfId: `p-${i}` }))
      const b = pickCushion(ctx({ selfId: `q-${i}` }))
      if (a === b) same++
    }
    expect(same / 200).toBeLessThan(0.5)
  })

  it('全部有人時回傳原因', () => {
    expect(pickCushion(ctx({ others: HALL_CUSHIONS }))).toBeTypeOf('string')
    // 稍遠的人不算佔用
    const near = HALL_CUSHIONS.map((c) => ({ x: c.x + OCCUPIED_RADIUS + 0.05, z: c.z }))
    expect(pickCushion(ctx({ others: near }))).toBeTypeOf('object')
  })
})

describe('pickCenserSpot 與 censerForPosition', () => {
  it('殿內走向最近的香爐，有人時換下一個站位或下一個香爐', () => {
    const side = HALL_CENSERS.find((c) => c.x > 0)!
    const spot = asPose(pickCenserSpot(ctx({ x: side.x, z: 0 })))
    expect(censerForPosition('hall', spot.x, spot.z)).toBe(side)
    const taken = side.spots
    const next = asPose(pickCenserSpot(ctx({ x: side.x, z: 0, others: taken })))
    expect(censerForPosition('hall', next.x, next.z)).not.toBe(side)
  })

  it('庭院走向中央大香爐', () => {
    const spot = asPose(pickCenserSpot(ctx({ zone: 'courtyard', x: 0, z: 11 })))
    expect(censerForPosition('courtyard', spot.x, spot.z)).toBe(COURTYARD_CENSER)
  })

  it('由位置推出香爐：容許遠端位置的誤差，太遠或不同場景則沒有', () => {
    for (const c of [COURTYARD_CENSER, ...HALL_CENSERS]) {
      for (const s of c.spots) expect(censerForPosition(c.zone, s.x + 0.4, s.z + 0.4)).toBe(c)
    }
    expect(censerForPosition('hall', 0, 3)).toBeNull()
    expect(censerForPosition('courtyard', HALL_CENSERS[0]!.spots[0]!.x, HALL_CENSERS[0]!.spots[0]!.z)).toBeNull()
  })
})
