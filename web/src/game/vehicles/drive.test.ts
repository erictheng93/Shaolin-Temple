import { describe, expect, it } from 'vitest'
import { drive, wrapAngle, type CarMotion, type DriveInput } from './drive'
import { VEHICLES } from '../world/vehicles'

describe('drive (駕駛動力學純函式)', () => {
  const p = VEHICLES.car

  it('放開搖桿不施力且保持原有角速度', () => {
    const m: CarMotion = { heading: 0.0, vx: 0.0, vz: 0.0, w: 1.0 }
    const input: DriveInput = { dir: 0.0, mag: 0.0 }
    const out = drive(m, input, p)
    expect(out.force).toBe(0.0)
    expect(out.w).toBe(1.0)
  })

  it('全速向前推進', () => {
    const m: CarMotion = { heading: 0.0, vx: 0.0, vz: 0.0, w: 0.0 }
    const input: DriveInput = { dir: 0.0, mag: 1.0 }
    const out = drive(m, input, p)
    expect(out.force).toBe(1400.0)
    expect(Math.abs(out.w)).toBeLessThan(1e-6)
  })

  it('達到最高速後不再施力', () => {
    const m: CarMotion = { heading: 0.0, vx: 0.0, vz: 8.0, w: 0.0 }
    const input: DriveInput = { dir: 0.0, mag: 1.0 }
    const out = drive(m, input, p)
    expect(out.force).toBe(0.0)
  })

  it('朝向目標轉向走劣弧', () => {
    const m: CarMotion = { heading: 3.0, vx: 0.0, vz: 0.0, w: 0.0 }
    const input: DriveInput = { dir: -3.0, mag: 1.0 }
    const out = drive(m, input, p)
    expect(out.w).toBeGreaterThan(0.0)
  })

  it('低速時搖桿往後推判定為倒車', () => {
    const m: CarMotion = { heading: 0.0, vx: 0.0, vz: 0.0, w: 0.0 }
    const input: DriveInput = { dir: Math.PI, mag: 1.0 }
    const out = drive(m, input, p)
    expect(out.force).toBe(-1400.0)
    expect(Math.abs(out.w)).toBeLessThan(1e-6)
  })

  it('高速時搖桿往後推仍保持前向迴轉', () => {
    const m: CarMotion = { heading: 0.0, vx: 0.0, vz: 5.0, w: 0.0 }
    const input: DriveInput = { dir: Math.PI, mag: 1.0 }
    const out = drive(m, input, p)
    expect(out.force).toBeGreaterThanOrEqual(0.0)
    expect(out.w).not.toBe(0.0)
  })

  it('wrapAngle 映射至 (-PI, PI] 半開區間', () => {
    expect(wrapAngle(Math.PI)).toBe(Math.PI)
    expect(wrapAngle(-Math.PI)).toBe(Math.PI)
    expect(Math.abs(wrapAngle((3.0 * Math.PI) / 2.0) - -Math.PI / 2.0)).toBeLessThan(1e-6)
  })
})
