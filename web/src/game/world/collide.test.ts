/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIN_DIST, SEPARATE_PER_TICK, TOLERANCE, resolveMove, separate, type Body, type Moved } from './collide'

const always = () => true
const body = (n: number, x: number, z: number, rooted = false): Body => ({ n, x, z, rooted })

describe('resolveMove', () => {
  it('正面重疊由兩人各分一半', () => {
    const r = resolveMove({ x: 0.2, z: 0 }, { x: -1, z: 0 }, [body(1, 0.5, 0)], 0, always)
    expect(r.x).toBeCloseTo(0.05, 12)
    expect(r.moved).toEqual([{ n: 1, x: expect.closeTo(0.65, 12), z: 0 }])
  })
  it('推不動的人不動，重疊量全部由走的人承擔', () => {
    const r = resolveMove({ x: 0.2, z: 0 }, { x: -1, z: 0 }, [body(1, 0.5, 0, true)], 0, always)
    expect(r.x).toBeCloseTo(-0.1, 12)
    expect(r.moved).toEqual([])
  })
  it('被推的人背後是牆時不動，走的人被擋住', () => {
    const r = resolveMove({ x: 0.2, z: 0 }, { x: -1, z: 0 }, [body(1, 0.5, 0)], 0, (x) => x <= 0.6)
    expect(r.x).toBeCloseTo(-0.1, 12)
    expect(r.moved).toEqual([])
  })
  it('重疊量在容許範圍內時不處理', () => {
    const r = resolveMove({ x: 0, z: 0 }, { x: -1, z: 0 }, [body(1, 0.5, 0)], TOLERANCE, always)
    expect(r).toEqual({ x: 0, z: 0, moved: [] })
  })
  it('兩人在同一點時確定地分開，不出現 NaN', () => {
    const r = resolveMove({ x: 0, z: 0 }, { x: 0, z: 0 }, [body(1, 0, 0)], 0, always)
    expect(r.x).toBeGreaterThan(0)
    expect(r.moved[0]!.x).toBeLessThan(0)
    expect(Number.isFinite(r.x + r.z + r.moved[0]!.x + r.moved[0]!.z)).toBe(true)
  })
  it('結果不合法時退回原位', () => {
    const r = resolveMove({ x: 0.2, z: 0 }, { x: -1, z: 0 }, [body(1, 0.5, 0, true)], 0, (x) => x > 0 || x === -1)
    expect(r).toMatchObject({ x: -1, z: 0 })
  })
})

describe('separate', () => {
  it('每人每個 tick 最多移動上限', () => {
    const out = separate([body(0, 0, 0), body(1, 0.2, 0)], always)
    expect(out).toEqual([
      { n: 0, x: expect.closeTo(-SEPARATE_PER_TICK, 12), z: 0 },
      { n: 1, x: expect.closeTo(0.2 + SEPARATE_PER_TICK, 12), z: 0 },
    ])
  })
  it('兩個推不動的人都不動', () => {
    expect(separate([body(0, 0, 0, true), body(1, 0.2, 0, true)], always)).toEqual([])
  })
  it('一方推不動時另一方移開', () => {
    const out = separate([body(0, 0, 0, true), body(1, 0.55, 0)], always)
    expect(out).toEqual([{ n: 1, x: expect.closeTo(0.6, 12), z: 0 }])
  })
  it('反覆呼叫後所有人互不重疊', () => {
    let bodies = [0, 1, 2, 3, 4].map((n) => body(n, n * 0.01, 0))
    for (let tick = 0; tick < 80; tick++) {
      for (const m of separate(bodies, always)) bodies = bodies.map((b) => (b.n === m.n ? { ...b, x: m.x, z: m.z } : b))
    }
    for (const a of bodies) for (const b of bodies) if (a.n < b.n) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(MIN_DIST - 0.01)
  })
})

// ---- 與 Rust 共用的固定資料 ----
interface MoveCase {
  name: string
  mover: [number, number]
  prev: [number, number]
  others: Body[]
  tolerance: number
  maxX?: number
  expected?: { x: number; z: number; moved: Moved[] }
}
interface SeparateCase {
  name: string
  bodies: Body[]
  maxX?: number
  expected?: Moved[]
}
const FIXTURE = new URL('../../../../server/tests/collide-script.json', import.meta.url)
const validOf = (maxX?: number) => (x: number) => maxX === undefined || x <= maxX

describe('共用固定資料 collide-script.json', () => {
  const file = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { _comment: string; moveCases: MoveCase[]; separateCases: SeparateCase[] }
  const runMove = (c: MoveCase) => resolveMove({ x: c.mover[0], z: c.mover[1] }, { x: c.prev[0], z: c.prev[1] }, c.others, c.tolerance, validOf(c.maxX))
  const runSeparate = (c: SeparateCase) => separate(c.bodies, validOf(c.maxX))

  if (process.env.UPDATE_FIXTURES === '1') {
    it('寫回預期結果', () => {
      for (const c of file.moveCases) c.expected = runMove(c)
      for (const c of file.separateCases) c.expected = runSeparate(c)
      writeFileSync(FIXTURE, JSON.stringify(file, null, 2) + '\n')
    })
    return
  }
  const near = (a: Moved[], b: Moved[]) => {
    expect(a.map((m) => m.n)).toEqual(b.map((m) => m.n))
    a.forEach((m, i) => {
      expect(Math.abs(m.x - b[i]!.x)).toBeLessThan(1e-9)
      expect(Math.abs(m.z - b[i]!.z)).toBeLessThan(1e-9)
    })
  }
  it('至少 8 筆移動與 4 筆分離的案例', () => {
    expect(file.moveCases.length).toBeGreaterThanOrEqual(8)
    expect(file.separateCases.length).toBeGreaterThanOrEqual(4)
  })
  it.each(file.moveCases.map((c) => [c.name, c] as const))('移動：%s', (_, c) => {
    const r = runMove(c)
    expect(Math.abs(r.x - c.expected!.x)).toBeLessThan(1e-9)
    expect(Math.abs(r.z - c.expected!.z)).toBeLessThan(1e-9)
    near(r.moved, c.expected!.moved)
  })
  it.each(file.separateCases.map((c) => [c.name, c] as const))('分離：%s', (_, c) => near(runSeparate(c), c.expected!))
})
