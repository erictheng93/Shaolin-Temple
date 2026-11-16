import { AnimationSystem, createAnimState } from '../../anim/AnimationSystem'
import { Emitter } from '../../core/Emitter'
import type { AvatarRig } from '../../render/AvatarFactory'
import { ActionRegistry } from '../ActionRegistry'
import type { GameEvents, GameplayApi } from '../types'
import { worshipModule } from './worship'

/** 測試用：參拜模組安裝在假的 GameplayApi 上，記錄播放的聲音、鐘的擺動與撞木。 */
export const makeRig = () => {
  const rotation = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }) } }
  return { pivot: { rotation, position: { y: 0 } }, head: { rotation: { ...rotation } }, face: 0, prop: 0, propAngle: 0 } as unknown as AvatarRig
}

export function setup() {
  const anim = new AnimationSystem()
  const actions = new ActionRegistry()
  const events = new Emitter<GameEvents>()
  const sfx = new Set<string>()
  const stats = new Map<string, unknown>()
  const offered: string[] = []
  const positions = new Map<string, { x: number; z: number; zone: string }>()
  const played: Array<{ name: string; gain?: number; rate?: number; at?: number; t: number }> = []
  const swings: number[] = []
  const strikes: number[] = []
  const clock = { offset: 0 }
  const api: GameplayApi = {
    actions,
    animations: anim,
    audio: {
      loadSfx: async () => {},
      play: (name, opts = {}) => {
        played.push({ name, ...opts, t: performance.now() })
      },
      defineSfx: (name) => {
        sfx.add(name)
        return () => sfx.delete(name)
      },
    },
    events,
    setStat: (key, _label, value) => (value === null ? stats.delete(key) : stats.set(key, value)),
    scene: {
      swingBell: () => swings.push(performance.now()),
      strikeBell: (startedAt) => strikes.push(startedAt),
      offerIncense: (id) => offered.push(id),
    },
    clockOffset: () => clock.offset,
    localPosition: () => {
      const p = positions.get('local')
      return p ? { x: p.x, z: p.z } : { x: 0, z: 0 }
    },
    playerPosition: (id) => positions.get(id) ?? null,
  }
  const uninstall = worshipModule.install(api)
  return { anim, actions, events, sfx, stats, offered, positions, played, swings, strikes, clock, uninstall }
}

export const pose = (anim: AnimationSystem, clip: string, duration: number, p: number) => {
  const rig = makeRig()
  const state = createAnimState()
  anim.play(state, clip, 0, duration)
  anim.apply(rig, state, p * duration, 0, 0)
  return rig
}
