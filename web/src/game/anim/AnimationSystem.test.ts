import { describe, expect, it } from 'vitest'
import { AnimationSystem, createAnimState } from './AnimationSystem'
import type { AvatarRig } from '../render/AvatarFactory'

const makeRig = () => {
  const rotation = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }) } }
  return { pivot: { rotation, position: { y: 0 } }, head: { rotation: { ...rotation } }, face: 0, prop: 0 } as unknown as AvatarRig
}

describe('nod 片段', () => {
  const rotationAt = (p: number) => {
    const sys = new AnimationSystem()
    const state = createAnimState()
    const rig = makeRig()
    sys.play(state, 'nod', 0, 1200)
    sys.apply(rig, state, p * 1200, 0, 0)
    return rig.pivot.rotation.x
  }

  it('頭尾收斂到 0，中段小幅前傾', () => {
    expect(rotationAt(0)).toBe(0)
    expect(rotationAt(1)).toBeCloseTo(0, 10)
    const mid = rotationAt(0.25)
    expect(mid).toBeGreaterThan(0)
    expect(Math.abs(mid)).toBeLessThan(0.3)
  })
})
