import { describe, expect, it } from 'vitest'
import { ActionRegistry, type GameActionDef } from './ActionRegistry'

const def: GameActionDef = { id: 'bow', label: 'action.bow', cooldownMs: 1000, animation: 'bow', durationMs: 500 }

describe('ActionRegistry', () => {
  it('冷卻期間拒絕重複執行', () => {
    const r = new ActionRegistry()
    r.register(def)
    expect(r.tryBegin('bow', 0)).toBe(def)
    expect(r.tryBegin('bow', 999)).toBeNull()
    expect(r.cooldownLeft('bow', 400)).toBe(600)
    expect(r.readyAt('bow')).toBe(1000)
    expect(r.tryBegin('bow', 1000)).toBe(def)
    expect(r.tryBegin('missing', 0)).toBeNull()
  })

  it('重複註冊報錯，取消註冊後通知並可重新註冊', () => {
    const r = new ActionRegistry()
    let calls = 0
    r.subscribe(() => calls++)
    const off = r.register(def)
    expect(() => r.register(def)).toThrow()
    off()
    expect(r.list()).toEqual([])
    expect(calls).toBe(2)
    r.register(def)
  })
})
