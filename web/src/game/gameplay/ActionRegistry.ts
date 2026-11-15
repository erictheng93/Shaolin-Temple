import type { SpotContext } from '../world/worship'
import type { Pose, ZoneId } from '../world/zones'

/**
 * 玩家可執行的動作定義。玩法定案後，新動作只需註冊一筆定義，UI 動作列、動畫、音效、網路確認都會自動接上。
 */
export interface GameActionDef {
  id: string
  /** 按鈕文字。 */
  label: string
  /** 按鈕上的單字或符號，選填。 */
  glyph?: string
  /** 兩次執行之間的最短間隔（毫秒）。伺服器仍會驗證，這裡只是避免無效請求。 */
  cooldownMs: number
  /** 動畫片段名稱，對應 AnimationSystem 的片段表。 */
  animation: string
  /** 動畫持續時間（毫秒）。 */
  durationMs: number
  /** 執行期間是否鎖住移動。 */
  locksMovement?: boolean
  /** 音效名稱，對應 AudioManager 的音效表。 */
  sound?: string
  /** 伺服器確認後的本地效果（例如更新計數）。 */
  onConfirmed?: () => void
  /**
   * 依場景判斷能不能用：可用回傳 null，不可用回傳給玩家看的原因（按鈕變暗，按下時提示原因）。
   * 只依場景判斷，因為 UI 是低頻摘要，不隨位置每幀更新。
   */
  unavailableReason?: (zone: ZoneId) => string | null
  /**
   * 需要先走到定點再執行：回傳站位與面向，角色會自動走過去、轉向後才開始動作（冷卻、動畫、送出都從抵達時算起）；
   * 回傳字串表示現在找不到可用的點（提示玩家原因）。
   */
  approach?: (ctx: SpotContext) => Pose | string
}

export class ActionRegistry {
  private defs = new Map<string, GameActionDef>()
  private lastPerformed = new Map<string, number>()
  private listeners = new Set<() => void>()

  register(def: GameActionDef): () => void {
    if (this.defs.has(def.id)) throw new Error(`動作 ${def.id} 已註冊`)
    this.defs.set(def.id, def)
    this.notify()
    return () => {
      this.defs.delete(def.id)
      this.lastPerformed.delete(def.id)
      this.notify()
    }
  }

  get(id: string): GameActionDef | undefined {
    return this.defs.get(id)
  }

  list(): GameActionDef[] {
    return [...this.defs.values()]
  }

  /** 冷卻結束的時間（毫秒）；從未執行過為 0。 */
  readyAt(id: string): number {
    const def = this.defs.get(id)
    const last = this.lastPerformed.get(id)
    return def && last !== undefined ? last + def.cooldownMs : 0
  }

  /** 剩餘冷卻時間（毫秒），0 表示可執行。 */
  cooldownLeft(id: string, now: number): number {
    const def = this.defs.get(id)
    const last = this.lastPerformed.get(id)
    if (!def || last === undefined) return 0
    return Math.max(0, last + def.cooldownMs - now)
  }

  /** 嘗試開始執行；冷卻中或未註冊時回傳 false。 */
  tryBegin(id: string, now: number): GameActionDef | null {
    const def = this.defs.get(id)
    if (!def || this.cooldownLeft(id, now) > 0) return null
    this.lastPerformed.set(id, now)
    return def
  }

  /** 動作列表變動時通知（UI 用）。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }
}
