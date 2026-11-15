import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnimationSystem, createAnimState } from '../../anim/AnimationSystem'
import { Emitter } from '../../core/Emitter'
import { PIVOT_HEIGHT, PROP_INCENSE, PROP_NONE, type AvatarRig } from '../../render/AvatarFactory'
import { ActionRegistry } from '../ActionRegistry'
import type { GameEvents, GameplayApi } from '../types'
import { HALL_CENSERS } from '../../world/zones'
import { INCENSE_MS, PLANT_AT, PROSTRATE_MS, PROSTRATE_STRIKES, worshipModule } from './worship'

const makeRig = () => {
  const rotation = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }) } }
  return { pivot: { rotation, position: { y: 0 } }, head: { rotation: { ...rotation } }, face: 0, prop: 0 } as unknown as AvatarRig
}

function setup() {
  const anim = new AnimationSystem()
  const actions = new ActionRegistry()
  const events = new Emitter<GameEvents>()
  const sfx = new Set<string>()
  const stats = new Map<string, unknown>()
  const offered: string[] = []
  const positions = new Map<string, { x: number; z: number; zone: string }>()
  const api: GameplayApi = {
    actions,
    animations: anim,
    audio: {
      loadSfx: async () => {},
      play: () => {},
      defineSfx: (name) => {
        sfx.add(name)
        return () => sfx.delete(name)
      },
    },
    events,
    setStat: (key, _label, value) => (value === null ? stats.delete(key) : stats.set(key, value)),
    scene: { swingBell: () => {}, offerIncense: (id) => offered.push(id) },
    localPosition: () => ({ x: 0, z: 0 }),
    playerPosition: (id) => positions.get(id) ?? null,
  }
  const uninstall = worshipModule.install(api)
  return { anim, actions, events, sfx, stats, offered, positions, uninstall }
}

const pose = (anim: AnimationSystem, clip: string, duration: number, p: number) => {
  const rig = makeRig()
  const state = createAnimState()
  anim.play(state, clip, 0, duration)
  anim.apply(rig, state, p * duration, 0, 0)
  return rig
}

afterEach(() => {
  vi.useRealTimers()
})

describe('worship 模組', () => {
  it('註冊合十、跪拜、上香、敲鐘；uninstall 清除全部註冊', () => {
    const { anim, actions, sfx, uninstall } = setup()
    expect(actions.list().map((a) => a.id)).toEqual(['bow', 'prostrate', 'incense', 'bell'])
    expect(anim.hasClip('prostrate') && anim.hasClip('incense')).toBe(true)
    expect(sfx.size).toBeGreaterThan(0)
    uninstall()
    expect(actions.list()).toEqual([])
    expect(anim.hasClip('prostrate') || anim.hasClip('incense')).toBe(false)
    expect(sfx.size).toBe(0)
  })

  it('跪拜只在殿內、敲鐘只在庭院；不能用時有原因', () => {
    const { actions } = setup()
    expect(actions.get('prostrate')!.unavailableReason!('courtyard')).toBeTruthy()
    expect(actions.get('prostrate')!.unavailableReason!('hall')).toBeNull()
    expect(actions.get('bell')!.unavailableReason!('hall')).toBeTruthy()
    expect(actions.get('bell')!.unavailableReason!('courtyard')).toBeNull()
    expect(actions.get('incense')!.unavailableReason).toBeUndefined()
  })

  it('跪拜動畫：跪下、三次叩拜到底（引磬對齊）、起身回到原姿勢', () => {
    const { anim } = setup()
    expect(pose(anim, 'prostrate', PROSTRATE_MS, 0).pivot.rotation.x).toBeCloseTo(0)
    expect(pose(anim, 'prostrate', PROSTRATE_MS, 0.999).pivot.position.y).toBeCloseTo(PIVOT_HEIGHT, 2)
    expect(PROSTRATE_STRIKES).toHaveLength(3)
    for (const s of PROSTRATE_STRIKES) {
      const rig = pose(anim, 'prostrate', PROSTRATE_MS, (s * 1000) / PROSTRATE_MS)
      expect(rig.pivot.rotation.x).toBeCloseTo(1.0, 1)
      expect(rig.pivot.position.y).toBeCloseTo(PIVOT_HEIGHT - 0.3)
    }
    // 兩次叩拜之間回到跪姿（前傾小、仍跪著）
    const between = pose(anim, 'prostrate', PROSTRATE_MS, (PROSTRATE_STRIKES[0]! + PROSTRATE_STRIKES[1]!) / 2 / (PROSTRATE_MS / 1000))
    expect(between.pivot.rotation.x).toBeLessThan(0.3)
  })

  it('上香動畫：插香前手上有香，插香後沒有', () => {
    const { anim } = setup()
    expect(pose(anim, 'incense', INCENSE_MS, 0.3).prop).toBe(PROP_INCENSE)
    expect(pose(anim, 'incense', INCENSE_MS, PLANT_AT + 0.02).prop).toBe(PROP_NONE)
  })

  it('任一玩家上香：插香時依他當時的位置找香爐並插一支香；uninstall 後不再插', () => {
    vi.useFakeTimers()
    const { events, offered, positions, uninstall } = setup()
    const censer = HALL_CENSERS[1]!
    const spot = censer.spots[0]!
    // 收到動作時遠端位置還沒到（仍在走道上），插香時才到站位
    positions.set('p-remote', { x: 0, z: 2, zone: 'hall' })
    const startedAt = performance.now()
    events.emit('actionPerformed', { playerId: 'p-remote', actionId: 'incense', local: false, zone: 'hall', startedAt, x: 0, z: 2 })
    positions.set('p-remote', { x: spot.x + 0.3, z: spot.z + 0.2, zone: 'hall' })
    vi.advanceTimersByTime(INCENSE_MS)
    expect(offered).toEqual([censer.id])

    events.emit('actionPerformed', { playerId: 'p-remote', actionId: 'incense', local: false, zone: 'hall', startedAt: performance.now(), x: 0, z: 2 })
    uninstall()
    vi.advanceTimersByTime(INCENSE_MS)
    expect(offered).toHaveLength(1)
  })
})
