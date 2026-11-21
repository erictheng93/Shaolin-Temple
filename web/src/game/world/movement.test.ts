import { describe, expect, it } from 'vitest'
import { resolveCollisions, stepMover, type MoveConfig, type MoverState } from './movement'

const cfg: MoveConfig = {
  speed: 2,
  bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
  obstacles: [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }],
}
const mover = (x: number, z: number, target: MoverState['target'] = null): MoverState => ({ x, z, heading: 0, target })

describe('stepMover', () => {
  it('朝目標前進且不超過目標', () => {
    const s = mover(5, 5, { x: 5, z: 6 })
    expect(stepMover(s, { dirX: 0, dirZ: 0 }, 0.25, cfg)).toBe(true)
    expect(s.z).toBeCloseTo(5.5)
    stepMover(s, { dirX: 0, dirZ: 0 }, 10, cfg)
    expect(s.z).toBeCloseTo(6)
    expect(stepMover(s, { dirX: 0, dirZ: 0 }, 0.1, cfg)).toBe(false)
    expect(s.target).toBeNull()
  })

  it('方向輸入取消尋路目標，斜向不會更快', () => {
    const s = mover(5, 5, { x: 0, z: 0 })
    stepMover(s, { dirX: 1, dirZ: 1 }, 0.5, cfg)
    expect(s.target).toBeNull()
    expect(Math.hypot(s.x - 5, s.z - 5)).toBeCloseTo(1)
  })

  it('搖桿半推為半速，鍵盤對角為全速', () => {
    const half = mover(5, 5)
    stepMover(half, { dirX: 0.5, dirZ: 0 }, 1, cfg)
    expect(half.x - 5).toBeCloseTo(1)
    const diag = mover(5, 5)
    stepMover(diag, { dirX: 1, dirZ: 1 }, 1, cfg)
    expect(Math.hypot(diag.x - 5, diag.z - 5)).toBeCloseTo(2)
    expect(stepMover(mover(5, 5), { dirX: 0, dirZ: 0 }, 1, cfg)).toBe(false)
  })

  it('受邊界限制，撞牆時放棄目標', () => {
    const s = mover(9.9, 0, { x: 20, z: 0 })
    stepMover(s, { dirX: 0, dirZ: 0 }, 1, cfg)
    expect(s.x).toBe(10)
    stepMover(s, { dirX: 0, dirZ: 0 }, 1, cfg)
    expect(s.target).toBeNull()
  })

  it('走進空車時速度降為 40%，離開後恢復；有人的車不影響', () => {
    // 空車在 (5, 5)
    const slowCfg: MoveConfig = {
      ...cfg,
      slowZones: () => [{ x: 5, z: 5, heading: 0 }],
    }
    // 站在 (5, 5) 重疊空車時移動 1 秒
    const inCar = mover(5, 5)
    stepMover(inCar, { dirX: 1, dirZ: 0 }, 1, slowCfg)
    // 原速 2，40% 為 0.8
    expect(inCar.x - 5).toBeCloseTo(0.8)

    // 站在 (0, 0) 遠離空車時移動 1 秒
    const outCar = mover(0, 0)
    stepMover(outCar, { dirX: 1, dirZ: 0 }, 1, slowCfg)
    // 恢復原速 2
    expect(outCar.x).toBeCloseTo(2)

    // 有人的車（slowZones 回傳空集合，不影響）
    const occupiedCfg: MoveConfig = {
      ...cfg,
      slowZones: () => [],
    }
    const nearOccupied = mover(5, 5)
    stepMover(nearOccupied, { dirX: 1, dirZ: 0 }, 1, occupiedCfg)
    expect(nearOccupied.x - 5).toBeCloseTo(2)
  })
})

describe('resolveCollisions', () => {
  it('把障礙物內的點推到最近邊緣', () => {
    expect(resolveCollisions(0.8, 0, cfg)).toEqual({ x: 1, z: 0 })
    expect(resolveCollisions(0, -0.9, cfg)).toEqual({ x: 0, z: -1 })
    expect(resolveCollisions(3, 3, cfg)).toEqual({ x: 3, z: 3 })
  })
})
