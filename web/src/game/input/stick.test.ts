import { describe, expect, it } from 'vitest'
import { stickFromOffset } from './stick'

// 與 Joystick.vue 相同的參數：底座 120px（半徑 60）、死區 0.12
const R = 60
const DZ = 0.12

describe('stickFromOffset', () => {
  it('原點輸出 0', () => {
    expect(stickFromOffset(0, 0, R, DZ)).toEqual({ knobX: 0, knobY: 0, x: 0, y: 0 })
  })

  it('死區內輸出 0，推桿仍跟著手指', () => {
    const s = stickFromOffset(3, -4, R, DZ) // 長度 5 < 7.2
    expect(s.x).toBe(0)
    expect(s.y).toBe(0)
    expect(s.knobX).toBe(3)
    expect(s.knobY).toBe(-4)
  })

  it('剛出死區時輸出接近 0 且連續', () => {
    const edge = stickFromOffset(R * DZ, 0, R, DZ)
    expect(Math.hypot(edge.x, edge.y)).toBeCloseTo(0, 10)
    const just = stickFromOffset(R * DZ + 0.01, 0, R, DZ)
    expect(just.x).toBeGreaterThan(0)
    expect(just.x).toBeLessThan(0.001)
    expect(just.y).toBe(0)
  })

  it('半推：長度依死區重新映射', () => {
    const s = stickFromOffset(0, -R / 2, R, DZ)
    expect(s.x).toBeCloseTo(0, 12)
    expect(s.y).toBeCloseTo(-(0.5 - DZ) / (1 - DZ), 12)
    expect(s.knobY).toBe(-R / 2)
  })

  it('推到底長度恰為 1', () => {
    const s = stickFromOffset(R, 0, R, DZ)
    expect(s).toEqual({ knobX: R, knobY: 0, x: 1, y: 0 })
  })

  it('超出半徑：推桿限制在半徑上，輸出長度為 1、方向不變', () => {
    const s = stickFromOffset(-300, 400, R, DZ) // 長度 500，方向 (-0.6, 0.8)
    expect(Math.hypot(s.knobX, s.knobY)).toBeCloseTo(R, 10)
    expect(s.knobX).toBeCloseTo(-0.6 * R, 10)
    expect(s.knobY).toBeCloseTo(0.8 * R, 10)
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(1, 12)
    expect(s.x).toBeCloseTo(-0.6, 12)
    expect(s.y).toBeCloseTo(0.8, 12)
  })

  it('斜向：方向與位移相同，長度依死區重新映射', () => {
    const d = (R * 0.7) / Math.SQRT2 // 推 70%、45°
    const s = stickFromOffset(d, d, R, DZ)
    const len = Math.hypot(s.x, s.y)
    expect(len).toBeCloseTo((0.7 - DZ) / (1 - DZ), 12)
    expect(s.x / len).toBeCloseTo(Math.SQRT1_2, 12)
    expect(s.y / len).toBeCloseTo(Math.SQRT1_2, 12)
  })
})
