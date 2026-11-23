import { describe, expect, it } from 'vitest'
import { AnimationSystem, createAnimState } from '../anim/AnimationSystem'
import { ActionRegistry } from '../gameplay/ActionRegistry'
import { retimePlayerAction, type RetimeHost, type RetimeTarget } from './retime'

const NOW = 10_000
const DURATION = 3400

/** 測試用的 GameCore 狀態：一個鎖定移動的動作 lock、一個不鎖定的動作 free；本機與遠端 p-r 都正在做 lock（從 NOW - 500 開始）。 */
function setup() {
  const actions = new ActionRegistry()
  actions.register({ id: 'lock', label: 'action.bell', cooldownMs: 0, animation: 'lockClip', durationMs: DURATION, locksMovement: true })
  actions.register({ id: 'free', label: 'action.bow', cooldownMs: 0, animation: 'freeClip', durationMs: 1000 })
  const anim = new AnimationSystem()
  const doing = (clip: string, startedAt: number, duration: number, lockedUntil: number): RetimeTarget => {
    const state = createAnimState()
    anim.play(state, clip, startedAt, duration, startedAt)
    return { anim: state, lockedUntil }
  }
  const local = doing('lockClip', NOW - 500, DURATION, NOW - 500 + DURATION)
  const remote = doing('lockClip', NOW - 500, DURATION, NOW - 500 + DURATION)
  const host: RetimeHost = { actions, anim, local, remotes: new Map([['p-r', remote]]), selfId: 'p-self', lockedAction: 'lock' }
  return { host, local, remote, doing }
}

const snap = (p: RetimeTarget) => ({ clip: p.anim.clip, clipStart: p.anim.clipStart, clipDuration: p.anim.clipDuration, lockedUntil: p.lockedUntil })

describe('retimePlayerAction（GameplayApi.retimeAction 的實作）', () => {
  it('正在做該動作：片段改從 startedAt 開始，鎖定移動的 lockedUntil 改為 startedAt + durationMs（本機以 local、自己的 id 或遠端 id）', () => {
    for (const id of ['local', 'p-self', 'p-r']) {
      const { host, local, remote } = setup()
      const p = id === 'p-r' ? remote : local
      expect(retimePlayerAction(host, id, 'lock', NOW - 900, NOW)).toBe(true)
      expect(snap(p)).toEqual({ clip: 'lockClip', clipStart: NOW - 900, clipDuration: DURATION, lockedUntil: NOW - 900 + DURATION })
    }
  })

  it('片段已不是該動作的動畫：不做事', () => {
    const { host, local, remote } = setup()
    local.anim.clip = 'walkSomething'
    remote.anim.clip = null
    const before = [snap(local), snap(remote)]
    expect(retimePlayerAction(host, 'local', 'lock', NOW - 900, NOW)).toBe(false)
    expect(retimePlayerAction(host, 'p-r', 'lock', NOW - 900, NOW)).toBe(false)
    expect([snap(local), snap(remote)]).toEqual(before)
  })

  it('鎖定移動的動作但鎖定已過期：不做事（本機與遠端）', () => {
    const { host, local, remote } = setup()
    local.lockedUntil = NOW
    remote.lockedUntil = NOW - 1
    const before = [snap(local), snap(remote)]
    expect(retimePlayerAction(host, 'local', 'lock', NOW - 900, NOW)).toBe(false)
    expect(retimePlayerAction(host, 'p-r', 'lock', NOW - 900, NOW)).toBe(false)
    expect([snap(local), snap(remote)]).toEqual(before)
  })

  it('本機的 lockedAction 不是該動作：不做事；遠端玩家不看 lockedAction', () => {
    const { host, local, remote } = setup()
    host.lockedAction = 'other'
    const before = snap(local)
    expect(retimePlayerAction(host, 'local', 'lock', NOW - 900, NOW)).toBe(false)
    expect(retimePlayerAction(host, 'p-self', 'lock', NOW - 900, NOW)).toBe(false)
    expect(snap(local)).toEqual(before)
    host.lockedAction = null
    expect(retimePlayerAction(host, 'local', 'lock', NOW - 900, NOW)).toBe(false)
    expect(snap(local)).toEqual(before)
    // 遠端：lockedAction（只描述本機）不影響
    expect(retimePlayerAction(host, 'p-r', 'lock', NOW - 900, NOW)).toBe(true)
    expect(snap(remote).clipStart).toBe(NOW - 900)
  })

  it('未知的動作 id、對照不到的玩家：不做事', () => {
    const { host, local, remote } = setup()
    const before = [snap(local), snap(remote)]
    expect(retimePlayerAction(host, 'local', 'nope', NOW - 900, NOW)).toBe(false)
    expect(retimePlayerAction(host, 'p-ghost', 'lock', NOW - 900, NOW)).toBe(false)
    expect([snap(local), snap(remote)]).toEqual(before)
  })

  it('不鎖定移動的動作：只改片段，不動 lockedUntil（也不看 lockedAction 與鎖定是否過期）', () => {
    const { host, doing } = setup()
    const local = doing('freeClip', NOW - 200, 1000, 1234)
    const remote = doing('freeClip', NOW - 200, 1000, 0)
    host.local = local
    host.remotes = new Map([['p-r', remote]])
    host.lockedAction = null
    expect(retimePlayerAction(host, 'local', 'free', NOW - 600, NOW)).toBe(true)
    expect(retimePlayerAction(host, 'p-r', 'free', NOW - 600, NOW)).toBe(true)
    expect(snap(local)).toEqual({ clip: 'freeClip', clipStart: NOW - 600, clipDuration: 1000, lockedUntil: 1234 })
    expect(snap(remote)).toEqual({ clip: 'freeClip', clipStart: NOW - 600, clipDuration: 1000, lockedUntil: 0 })
  })
})
