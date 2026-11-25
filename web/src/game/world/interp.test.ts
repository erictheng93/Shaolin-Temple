import { describe, expect, it } from 'vitest'
import { REMOTE_STEP_DEFAULT_MS, REMOTE_STEP_MAX_MS, REMOTE_STEP_MIN_MS, lerpAngle, sampleBetween, stepDuration, type Sample } from './interp'

const out = () => ({ x: 0, z: 0, heading: 0 })
const s = (x: number, z: number, heading: number, t: number): Sample => ({ x, z, heading, t })

describe('sampleBetween', () => {
  it('等速輸入下輸出速度恆定', () => {
    // 每 100 ms 前進 0.22 m（2.2 m/s）。每 10 ms 取樣一次，相鄰輸出的位移應固定。
    const a = s(0, 0, 0, 1000)
    const b = s(0.22, 0, 0, 1100)
    const o = out()
    let prev = 0
    const steps: number[] = []
    for (let t = 1000; t <= 1100; t += 10) {
      sampleBetween(a, b, t, o)
      if (t > 1000) steps.push(o.x - prev)
      prev = o.x
    }
    expect(steps).toHaveLength(10)
    for (const d of steps) expect(d).toBeCloseTo(0.022, 9)
  })

  it('跨相鄰兩段（沿同一直線等速）時速度不變', () => {
    const o = out()
    sampleBetween(s(0, 0, 0, 0), s(0.22, 0, 0, 100), 90, o)
    const end1 = o.x
    sampleBetween(s(0.22, 0, 0, 100), s(0.44, 0, 0, 200), 110, o)
    expect(o.x - end1).toBeCloseTo(0.044, 9)
  })

  it('不外插：時間超過較新樣本時停在該樣本；早於較舊樣本時停在較舊樣本', () => {
    const o = out()
    sampleBetween(s(0, 0, 0, 100), s(1, 2, 1, 200), 5000, o)
    expect(o).toEqual({ x: 1, z: 2, heading: 1 })
    sampleBetween(s(0, 0, 0, 100), s(1, 2, 1, 200), 0, o)
    expect(o).toEqual({ x: 0, z: 0, heading: 0 })
  })

  it('兩筆時間相同（瞬移後的重疊樣本）直接取較新者', () => {
    const o = out()
    sampleBetween(s(0, 0, 0, 100), s(3, 4, 0, 100), 100, o)
    expect(o).toEqual({ x: 3, z: 4, heading: 0 })
  })

  it('面向走最短路徑（跨 ±π 不繞遠路）', () => {
    const o = out()
    sampleBetween(s(0, 0, 3.0, 0), s(0, 0, -3.0, 100), 50, o)
    // 3.0 到 -3.0 最短路徑經過 π（共 0.283 rad），中點在 π 附近；若繞遠路會經過 0。
    expect(Math.cos(o.heading)).toBeLessThan(-0.99)
    expect(lerpAngle(0, Math.PI * 1.5, 1)).toBeCloseTo(-Math.PI / 2, 9)
  })
})

describe('stepDuration', () => {
  it('取到達間隔並夾在上下限內；間隔過長（剛從靜止開始走）用伺服器 tick 預設值', () => {
    expect(stepDuration(100)).toBe(100)
    expect(stepDuration(REMOTE_STEP_MIN_MS - 30)).toBe(REMOTE_STEP_MIN_MS)
    expect(stepDuration(REMOTE_STEP_MAX_MS)).toBe(REMOTE_STEP_MAX_MS)
    expect(stepDuration(REMOTE_STEP_MAX_MS + 1)).toBe(REMOTE_STEP_DEFAULT_MS)
    expect(stepDuration(5000)).toBe(REMOTE_STEP_DEFAULT_MS)
  })
})
