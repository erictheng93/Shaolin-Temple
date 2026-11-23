import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../i18n'
import { ActionRegistry } from '../gameplay/ActionRegistry'
import type { SpotContext } from '../world/worship'
import type { Pose } from '../world/zones'
import { APPROACH_ARRIVE, ApproachFlow, type ApproachCancel } from './approachFlow'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const SPOT: Pose = { x: 5, z: 2, heading: 1 }
const ctx: SpotContext = { zone: 'courtyard', x: 0, z: 0, selfId: 'me', others: [] }

/** 假的 GameCore：記錄站位、開始、尋路與提示；wait 是 startWait 目前的回傳值（null 表示動作沒有 startWait）。 */
function setup(opts: { wait?: number | null; walkable?: boolean; spot?: Pose | string } = {}) {
  const actions = new ActionRegistry()
  const state = { wait: opts.wait === undefined ? 1000 : opts.wait }
  actions.register({
    id: 'bell',
    label: 'action.bell',
    cooldownMs: 0,
    animation: 'bellStrike',
    durationMs: 1000,
    approach: () => opts.spot ?? SPOT,
    ...(state.wait === null ? {} : { startWait: () => state.wait ?? 0 }),
  })
  const me = { x: 0, z: 0 }
  const stood: Pose[] = []
  const begun: Array<{ id: string; pose: Pose }> = []
  const walks: Pose[] = []
  const toasts: string[] = []
  const flow = new ApproachFlow({
    actions,
    position: () => me,
    standAt: (pose) => {
      stood.push(pose)
      Object.assign(me, { x: pose.x, z: pose.z })
    },
    begin: (id, pose) => begun.push({ id, pose }),
    walkTo: (pose) => {
      walks.push(pose)
      return opts.walkable ?? true
    },
    toast: (text) => toasts.push(text),
  })
  /** 走到站位上（路走完）。 */
  const arrive = () => Object.assign(me, { x: SPOT.x + 0.1, z: SPOT.z })
  return { flow, me, state, stood, begun, walks, toasts, arrive }
}

const waitingToast = () => t('action.waiting', { action: t('action.bell') })

/** 走過去、抵達後進入就位等候。 */
function waiting() {
  const s = setup()
  s.flow.start('bell', ctx)
  s.arrive()
  expect(s.flow.update(performance.now(), false)).toBe(true)
  expect(s.flow.state).toBe('waiting')
  return s
}

describe('走向定點與就位等候（ApproachFlow）', () => {
  it('抵達時 startWait > 0：就位等候、站到站位上（只送一次）、提示一次，不開始動作', () => {
    const { flow, stood, begun, walks, toasts, arrive } = setup()
    flow.start('bell', ctx)
    expect(walks).toEqual([SPOT])
    expect(flow.state).toBe('walking')
    // 路還沒走完：不做事
    expect(flow.update(performance.now(), true)).toBe(false)
    arrive()
    expect(flow.update(performance.now(), false)).toBe(true)
    expect(flow.state).toBe('waiting')
    expect(stood).toEqual([SPOT])
    expect(toasts).toEqual([waitingToast()])
    expect(begun).toEqual([])
    // 繼續等：不再站位、不再提示
    for (let i = 0; i < 5; i++) flow.update(performance.now(), false)
    expect(stood).toHaveLength(1)
    expect(toasts).toHaveLength(1)
    expect(begun).toEqual([])
  })

  it('已經站在站位上按下：直接就位等候，不尋路', () => {
    const { flow, me, stood, walks, toasts, begun } = setup()
    Object.assign(me, { x: SPOT.x, z: SPOT.z + APPROACH_ARRIVE - 0.01 })
    flow.start('bell', ctx)
    expect(walks).toEqual([])
    expect(flow.state).toBe('waiting')
    expect(stood).toEqual([SPOT])
    expect(toasts).toEqual([waitingToast()])
    expect(begun).toEqual([])
  })

  it('等候中 startWait 歸零的那一次輪詢開始動作，而且只開始一次', () => {
    const { flow, state, begun, toasts } = waiting()
    state.wait = 5
    flow.update(performance.now(), false)
    expect(begun).toEqual([])
    state.wait = 0
    expect(flow.update(performance.now(), false)).toBe(false)
    expect(begun).toEqual([{ id: 'bell', pose: SPOT }])
    expect(flow.state).toBe('idle')
    for (let i = 0; i < 5; i++) flow.update(performance.now(), false)
    expect(begun).toHaveLength(1)
    expect(toasts).toHaveLength(1)
  })

  it.each([0, null])('抵達時 startWait 為 %s（null＝沒有 startWait）：立刻開始，不提示等候', (wait) => {
    const { flow, begun, toasts, stood, arrive } = setup({ wait })
    flow.start('bell', ctx)
    arrive()
    expect(flow.update(performance.now(), false)).toBe(true)
    expect(begun).toEqual([{ id: 'bell', pose: SPOT }])
    expect(toasts).toEqual([])
    // 站位由開始動作負責（beginAction 會站上去），不另外站一次
    expect(stood).toEqual([])
    expect(flow.state).toBe('idle')
  })

  it('等候中離站位超過抵達門檻：取消、提示 move.blocked，之後歸零也不開始', () => {
    const { flow, me, state, begun, toasts } = waiting()
    // 門檻內：仍在等
    Object.assign(me, { x: SPOT.x + APPROACH_ARRIVE - 0.01, z: SPOT.z })
    flow.update(performance.now(), false)
    expect(flow.state).toBe('waiting')
    Object.assign(me, { x: SPOT.x + APPROACH_ARRIVE + 0.01, z: SPOT.z })
    flow.update(performance.now(), false)
    expect(flow.state).toBe('idle')
    expect(toasts).toEqual([waitingToast(), t('move.blocked')])
    Object.assign(me, { x: SPOT.x, z: SPOT.z })
    state.wait = 0
    flow.update(performance.now(), false)
    expect(begun).toEqual([])
  })

  // GameCore 的每一條取消路徑對應的原因（GameCore.ts 中 approach.cancel(...) 的呼叫處）
  const causes: Array<[string, ApproachCancel]> = [
    ['鍵盤／搖桿移動', 'move'],
    ['點擊地面', 'tap'],
    ['按另一個動作', 'action'],
    ['切換場景', 'zone'],
    ['切到背景', 'background'],
    ['被車撞飛', 'knock'],
    ['伺服器位置糾正', 'correction'],
    ['騎車', 'ride'],
    ['被人擋住走不動', 'blocked'],
  ]

  it.each(causes)('等候中%s：取消等候，之後 startWait 歸零也不開始', (_name, cause) => {
    const { flow, state, begun, toasts } = waiting()
    flow.cancel(cause)
    expect(flow.state).toBe('idle')
    state.wait = 0
    flow.update(performance.now(), false)
    expect(begun).toEqual([])
    expect(toasts).toEqual([waitingToast()])
  })

  it('等候中按同一個動作：取消後重新就位（再站一次、再提示一次），不開始', () => {
    const { flow, stood, toasts, begun } = waiting()
    flow.cancel('action')
    flow.start('bell', ctx)
    expect(flow.state).toBe('waiting')
    expect(stood).toEqual([SPOT, SPOT])
    expect(toasts).toEqual([waitingToast(), waitingToast()])
    expect(begun).toEqual([])
  })

  it('還在路上時：按動作、切到背景不取消（照原本行為），其餘原因取消', () => {
    for (const [, cause] of causes) {
      const { flow, arrive, begun, state } = setup({ wait: 0 })
      flow.start('bell', ctx)
      flow.cancel(cause)
      arrive()
      state.wait = 0
      flow.update(performance.now(), false)
      expect(begun.length, cause).toBe(cause === 'action' || cause === 'background' ? 1 : 0)
    }
  })

  it('走向定點途中被擋住沒走到：提示 move.blocked、不開始', () => {
    const { flow, me, begun, toasts, stood } = setup({ wait: 0 })
    flow.start('bell', ctx)
    // 尋路目標被放棄（撞到障礙物），人還離站位很遠
    Object.assign(me, { x: SPOT.x - 1, z: SPOT.z })
    expect(flow.update(performance.now(), false)).toBe(false)
    expect(toasts).toEqual([t('move.blocked')])
    expect(begun).toEqual([])
    expect(stood).toEqual([])
    expect(flow.state).toBe('idle')
  })

  it('找不到站位時提示原因；走不到時提示 move.unreachable；都不進入走向定點', () => {
    const none = setup({ spot: '沒有空位' })
    none.flow.start('bell', ctx)
    expect(none.toasts).toEqual(['沒有空位'])
    expect(none.flow.state).toBe('idle')
    const blocked = setup({ walkable: false })
    blocked.flow.start('bell', ctx)
    expect(blocked.toasts).toEqual([t('move.unreachable')])
    expect(blocked.flow.state).toBe('idle')
  })
})
