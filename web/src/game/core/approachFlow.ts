import { t } from '../../i18n'
import type { ActionRegistry } from '../gameplay/ActionRegistry'
import type { SpotContext } from '../world/worship'
import type { Pose } from '../world/zones'

/** 走向定點：離站位這麼近就算抵達（抵達後直接站到站位上並轉向）。 */
export const APPROACH_ARRIVE = 0.3

/**
 * 取消走向定點／就位等候的原因。`action`（按任何動作）與 `background`（切到背景）只取消定點上的等候，
 * 還在路上的不取消（按動作時由之後的流程重新決定；背景期間迴圈停止，回前景接著走）；其餘全部取消。
 */
export type ApproachCancel =
  | 'move' // 鍵盤／搖桿移動
  | 'tap' // 點擊地面
  | 'action' // 按任何動作（同一個動作會重新就位）
  | 'zone' // 切換場景（過場開始與套用場景）
  | 'background' // 切到背景
  | 'knock' // 被車撞飛
  | 'correction' // 伺服器位置糾正（大到要瞬移）
  | 'ride' // 騎車中
  | 'blocked' // 被人擋住走不動超過 1.5 秒（不提示）

/** ApproachFlow 需要的 GameCore 能力，全部是本機玩家的操作。 */
export interface ApproachHost {
  actions: Pick<ActionRegistry, 'get'>
  /** 本機玩家目前的位置。 */
  position(): { x: number; z: number }
  /** 站到站位上、面向站位方向，並送出一次位置。 */
  standAt(pose: Pose): void
  /** 開始動作（冷卻、鎖定、動畫、送出）；pose 不為 null 時先站到站位上。 */
  begin(id: string, pose: Pose): void
  /** 以尋路走向站位；找不到路時回傳 false。 */
  walkTo(pose: Pose): boolean
  /** 顯示提示（已翻譯好的文字）。 */
  toast(text: string): void
}

/**
 * 需要先走到定點的動作（GameActionDef.approach）在本機的狀態機：走向定點 → 抵達 →（startWait > 0 時）就位等候 → 開始。
 * 不依賴 Three.js／DOM，GameCore 委派給它（approachFlow.test.ts 直接測這份程式）。
 */
export class ApproachFlow {
  /** 正在走向定點、抵達後才開始的動作；waiting 表示已站在定點上、等 startWait 歸零才開始。 */
  private pending: { id: string; pose: Pose; waiting?: boolean } | null = null

  constructor(private host: ApproachHost) {}

  /** 目前的狀態（測試與除錯用）。 */
  get state(): 'idle' | 'walking' | 'waiting' {
    return this.pending ? (this.pending.waiting ? 'waiting' : 'walking') : 'idle'
  }

  /**
   * 玩家按下有 approach 的動作（場景、冷卻等檢查已通過）：找站位，已在站位上就抵達，否則尋路走過去。
   * 找不到站位或走不到時提示原因。
   */
  start(id: string, ctx: SpotContext): void {
    const def = this.host.actions.get(id)
    if (!def?.approach) return
    const spot = def.approach(ctx)
    if (typeof spot === 'string') {
      this.host.toast(spot)
      return
    }
    const me = this.host.position()
    if (Math.hypot(spot.x - me.x, spot.z - me.z) <= APPROACH_ARRIVE) {
      this.arrive(id, spot)
      return
    }
    if (!this.host.walkTo(spot)) {
      this.host.toast(t('move.unreachable'))
      return
    }
    this.pending = { id, pose: spot }
  }

  /** 取消（見 ApproachCancel：有些原因只取消定點上的等候）。 */
  cancel(cause: ApproachCancel): void {
    if (cause === 'action' || cause === 'background') {
      if (this.pending?.waiting) this.pending = null
      return
    }
    this.pending = null
  }

  /**
   * 每幀（可以移動時）呼叫。walking：本機玩家還有尋路目標。
   * 走向定點：路走完（或被擋住）時，抵達就開始（或就位等候），沒抵達就提示；等候中等到 startWait 歸零才開始，被推離站位則取消。
   * 回傳這一幀是否剛抵達（GameCore 據此把這一幀視為沒在走）。
   */
  update(now: number, walking: boolean): boolean {
    const p = this.pending
    if (!p) return false
    const me = this.host.position()
    const off = Math.hypot(p.pose.x - me.x, p.pose.z - me.z) > APPROACH_ARRIVE
    if (p.waiting) {
      if (off) {
        // 等候中可能被走過的玩家推離站位；開始時會貼回站位，推遠了會瞬移，所以取消
        this.pending = null
        this.host.toast(t('move.blocked'))
      } else if ((this.host.actions.get(p.id)?.startWait?.(now) ?? 0) <= 0) {
        this.pending = null
        this.host.begin(p.id, p.pose)
      }
      return false
    }
    if (walking) return false
    this.pending = null
    if (off) {
      this.host.toast(t('move.blocked'))
      return false
    }
    this.arrive(p.id, p.pose)
    return true
  }

  /** 抵達定點：動作要求等候（startWait > 0）時站到定點上等（提示一次），否則立刻開始。 */
  private arrive(id: string, pose: Pose): void {
    const def = this.host.actions.get(id)
    if (def?.startWait && def.startWait(performance.now()) > 0) {
      this.host.standAt(pose)
      this.pending = { id, pose, waiting: true }
      this.host.toast(t('action.waiting', { action: t(def.label) }))
      return
    }
    this.host.begin(id, pose)
  }
}
