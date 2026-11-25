import { describe, expect, it } from 'vitest'
import { AnimationSystem, createAnimState } from './AnimationSystem'
import { FACE_CALM, FACE_DIZZY, PROP_INCENSE, PROP_NONE, type AvatarRig } from '../render/AvatarFactory'

const makeRig = () => {
  const rotation = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }) } }
  return { pivot: { rotation, position: { y: 0 } }, head: { rotation: { ...rotation } }, lift: 0, face: 0, prop: 0, propAngle: 0 } as unknown as AvatarRig
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

describe('knocked 片段', () => {
  it('knocked 片段在一半時離地最高、結束時回到地面且 pivot 旋轉歸零', () => {
    const sys = new AnimationSystem()
    const state = createAnimState()
    const rig = makeRig()
    sys.play(state, 'knocked', 0, 1800)

    // p = 0.5 (900ms)
    sys.apply(rig, state, 900, 0, 0)
    expect(rig.lift).toBeCloseTo(1.6)

    // p = 1.0 (1800ms 結束)
    sys.apply(rig, state, 1800, 0, 0)
    expect(rig.lift).toBe(0)
    expect(rig.pivot.rotation.x).toBe(0)
    expect(rig.pivot.rotation.y).toBe(0)
    expect(rig.pivot.rotation.z).toBe(0)
  })

  it('apply() 每幀把 lift 重設為 0', () => {
    const sys = new AnimationSystem()
    const state = createAnimState()
    const rig = makeRig()
    rig.lift = 2.5
    sys.apply(rig, state, 0, 0, 0)
    expect(rig.lift).toBe(0)
  })
})

describe('apply() 每幀重設', () => {
  it('臉、手上的東西與槌的角度每幀回到預設，沒有片段時不殘留', () => {
    const sys = new AnimationSystem()
    const state = createAnimState()
    const rig = makeRig()
    Object.assign(rig, { face: FACE_DIZZY, prop: PROP_INCENSE, propAngle: 1 })
    sys.apply(rig, state, 0, 0, 0)
    expect(rig.face).toBe(FACE_CALM)
    expect(rig.prop).toBe(PROP_NONE)
    expect(rig.propAngle).toBe(0)
  })

  it('knocked 片段進行中是暈眩臉；本機走動（moving）會中斷片段並回到平常的臉', () => {
    const sys = new AnimationSystem()
    const state = createAnimState()
    const rig = makeRig()
    sys.play(state, 'knocked', 0, 1800)
    sys.apply(rig, state, 900, 0, 0)
    expect(rig.face).toBe(FACE_DIZZY)
    state.moving = true
    sys.apply(rig, state, 1000, 0.016, 0)
    expect(state.clip).toBeNull()
    expect(rig.face).toBe(FACE_CALM)
  })
})
