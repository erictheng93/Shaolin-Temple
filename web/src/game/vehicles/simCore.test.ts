import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import RAPIER from '@dimforge/rapier3d-compat'
import { createSimWorld } from './simCore'
import { wrapAngle } from './drive'
import { VEHICLES } from '../world/vehicles'
import { SOLIDS, TREE_SOLIDS, TREES, WORLD_BOUNDS } from '../world/layout'

interface DriveScriptFixture {
  start: { x: number; z: number; heading: number }
  script: Array<{ dir: number; mag: number }>
  expected: Array<{ step: number; x: number; z: number; heading: number }>
}

describe('simCore (碰碰車模擬核心)', () => {
  beforeAll(async () => {
    await RAPIER.init()
  })

  it('與後端 drive-script.json 測試夾具軌跡對齊 (差值 x/z < 0.05m, heading < 0.02 rad)', () => {
    const fixturePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../server/tests/drive-script.json',
    )
    const raw = fs.readFileSync(fixturePath, 'utf-8')
    const fixture: DriveScriptFixture = JSON.parse(raw)

    const sim = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
    const carId = 0
    sim.spawn(carId, fixture.start.x, fixture.start.z, fixture.start.heading)
    sim.setOccupied(carId, true)

    const expectedMap = new Map(fixture.expected.map((e) => [e.step, e]))

    for (let i = 0; i < fixture.script.length; i++) {
      const input = fixture.script[i]!
      sim.setInput(carId, input)
      sim.step()
      const stepNum = i + 1
      const exp = expectedMap.get(stepNum)
      if (exp) {
        const act = sim.state(carId)
        expect(act).not.toBeNull()
        expect(Math.abs(act!.x - exp.x)).toBeLessThan(0.05)
        expect(Math.abs(act!.z - exp.z)).toBeLessThan(0.05)
        const headingDiff = Math.abs(wrapAngle(act!.heading - exp.heading))
        expect(headingDiff).toBeLessThan(0.02)
      }
    }

    sim.free()
  })

  it('車輛前進撞牆不會穿透邊界', () => {
    const sim = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
    const carId = 1
    // 面向東牆 (x = 19)
    sim.spawn(carId, 17.0, 0.0, Math.PI / 2)
    sim.setOccupied(carId, true)
    sim.setInput(carId, { dir: Math.PI / 2, mag: 1.0 })

    for (let i = 0; i < 60; i++) {
      sim.step()
    }

    const state = sim.state(carId)
    expect(state).not.toBeNull()
    // 邊界在 19，車體半寬半長約 0.75，車身不得穿過東牆
    expect(state!.x).toBeLessThan(WORLD_BOUNDS.maxX)
    sim.free()
  })

  /** 跑到第一次有碰撞為止，回傳該步每台車的碰撞種類（c → bump）；60 步內沒撞到回傳空 Map。 */
  function runUntilBump(sim: ReturnType<typeof createSimWorld>, inputs: Record<number, { dir: number; mag: number }>): Map<number, number> {
    for (let i = 0; i < 90; i++) {
      for (const [c, input] of Object.entries(inputs)) sim.setInput(Number(c), input)
      const hits = sim.step()
      if (hits.length > 0) {
        for (const h of hits) expect(sim.state(h.c)!.bump).toBe(h.bump)
        return new Map(hits.map((h) => [h.c, h.bump]))
      }
    }
    return new Map()
  }

  it('車撞樹回報 2（bump）', () => {
    const sim = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES, TREE_SOLIDS)
    const tree = TREES[1]! // (-15, -4)，四周空曠
    sim.spawn(0, tree.x + 5, tree.z, -Math.PI / 2)
    sim.setOccupied(0, true)
    expect(runUntilBump(sim, { 0: { dir: -Math.PI / 2, mag: 1 } }).get(0)).toBe(2)
    sim.free()
  })

  it('沒告知哪些是樹時，樹算 wall（1）；撞邊界牆也是 1', () => {
    const noTrees = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
    const tree = TREES[1]!
    noTrees.spawn(0, tree.x + 5, tree.z, -Math.PI / 2)
    noTrees.setOccupied(0, true)
    expect(runUntilBump(noTrees, { 0: { dir: -Math.PI / 2, mag: 1 } }).get(0)).toBe(1)
    noTrees.free()

    const sim = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES, TREE_SOLIDS)
    sim.spawn(1, 17, 0, Math.PI / 2)
    sim.setOccupied(1, true)
    expect(runUntilBump(sim, { 1: { dir: Math.PI / 2, mag: 1 } }).get(1)).toBe(1)
    sim.free()
  })

  it('兩車互撞都回報 3', () => {
    const sim = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES, TREE_SOLIDS)
    // 庭院中段空曠處面對面對衝
    sim.spawn(0, -3, 12, Math.PI / 2)
    sim.spawn(1, 3, 12, -Math.PI / 2)
    sim.setOccupied(0, true)
    sim.setOccupied(1, true)
    const hit = runUntilBump(sim, { 0: { dir: Math.PI / 2, mag: 1 }, 1: { dir: -Math.PI / 2, mag: 1 } })
    expect(hit.get(0)).toBe(3)
    expect(hit.get(1)).toBe(3)
    sim.free()
  })

  it('free() 之後再呼叫 step 會丟出錯誤', () => {
    const sim = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
    sim.spawn(2, 0, 0, 0)
    sim.free()

    expect(() => sim.step()).toThrow('SimWorld has been freed')
    expect(() => sim.spawn(3, 0, 0, 0)).toThrow('SimWorld has been freed')
    expect(() => sim.state(2)).toThrow('SimWorld has been freed')
  })
})
