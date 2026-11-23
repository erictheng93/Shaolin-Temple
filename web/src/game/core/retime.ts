import type { AnimationSystem, AnimState } from '../anim/AnimationSystem'
import type { ActionRegistry } from '../gameplay/ActionRegistry'

/** 可以重設動作時間軸的玩家（本機或遠端）：動作片段與鎖定移動的結束時刻。 */
export interface RetimeTarget {
  anim: AnimState
  lockedUntil: number
}

/** retimePlayerAction 需要的 GameCore 狀態。 */
export interface RetimeHost {
  actions: Pick<ActionRegistry, 'get'>
  anim: Pick<AnimationSystem, 'play'>
  local: RetimeTarget
  remotes: ReadonlyMap<string, RetimeTarget>
  /** 伺服器給的自己的 id（離線時為 null，自己的 id 是 'local'）。 */
  selfId: string | null
  /** 本機正在進行、鎖定移動的動作 id（GameCore.lockedAction）。 */
  lockedAction: string | null
}

/**
 * GameplayApi.retimeAction 的實作：把玩家目前正在做的 actionId 改成從 startedAt 開始（動作片段的進度與鎖定移動的結束時刻），冷卻不變。
 * 「正在做」＝動作片段還是這個動作的動畫，鎖定移動的動作還在鎖定中（本機另要求鎖定的就是這個動作）。
 * 不依賴 Three.js／DOM，GameCore 委派給它（retime.test.ts 直接測這份程式）。回傳是否有改（GameCore 據此喚醒渲染）。
 */
export function retimePlayerAction(host: RetimeHost, id: string, actionId: string, startedAt: number, now: number): boolean {
  const def = host.actions.get(actionId)
  if (!def) return false
  const self = id === 'local' || id === host.selfId
  const p = self ? host.local : host.remotes.get(id)
  if (!p || p.anim.clip !== def.animation) return false
  if (def.locksMovement && (now >= p.lockedUntil || (self && host.lockedAction !== actionId))) return false
  host.anim.play(p.anim, def.animation, now, def.durationMs, startedAt)
  if (def.locksMovement) p.lockedUntil = startedAt + def.durationMs
  return true
}
