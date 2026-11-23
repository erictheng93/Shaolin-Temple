import type { AnimationSystem } from '../anim/AnimationSystem'
import type { AudioManager } from '../audio/AudioManager'
import type { Emitter } from '../core/Emitter'
import type { MessageKey } from '../../i18n'
import type { ActionRegistry } from './ActionRegistry'

export interface GameEvents extends Record<string, unknown> {
  /**
   * 任一玩家（含自己）開始執行動作。local 表示是本機玩家；zone 是執行者所在場景；
   * startedAt 是動作開始的時間（performance.now 毫秒，遠端玩家已換算成本機時間）。
   * x、z 是收到當下的位置：遠端玩家的最後一筆位置通常比動作晚一個 tick 到，需要準確位置時改用 playerPosition()。
   */
  actionPerformed: { playerId: string; actionId: string; local: boolean; zone: string; startedAt: number; x: number; z: number }
  playerJoined: { id: string; name: string }
  playerLeft: { id: string }
}

/**
 * 玩法模組可使用的介面。刻意保持很小：玩法定案時再依需求擴充，不預先暴露內部系統。
 */
export interface GameplayApi {
  actions: ActionRegistry
  animations: Pick<AnimationSystem, 'registerClip'>
  audio: Pick<AudioManager, 'loadSfx' | 'defineSfx' | 'play'>
  events: Pick<Emitter<GameEvents>, 'on'>
  /** 在 HUD 顯示或更新一項數值；label 是字典 key（顯示當下才翻譯）；value 為 null 時移除。 */
  setStat(key: string, label: MessageKey, value: string | number | null): void
  /**
   * 觸發場景中的互動物件效果：庭院的鐘擺動（strength 是擺動強度的倍率，預設 1）；撞木依 startedAt（performance.now 毫秒）開始的撞鐘時間軸擺動
   * （world/bell.ts 的 strikerAngle，撞到鐘的時刻由呼叫端另外呼叫 swingBell；與目前時間軸相差 BELL_JOIN_MS 內視為同一聲、不重來）；
   * 在香爐（CENSERS 的 id）插一支香。
   */
  scene: { swingBell(strength?: number): void; strikeBell(startedAt: number): void; offerIncense(censerId: string): void }
  /**
   * 伺服器時間 − performance.now()（毫秒），離線時為 0。各客戶端以伺服器時間對齊共同的節拍（例如誦經的木魚），
   * 只差時鐘同步的誤差（約半個來回時間）。
   */
  clockOffset(): number
  /** 自己的玩家座標。 */
  localPosition(): { x: number; z: number }
  /**
   * 玩家目前的位置與場景（自己或遠端；遠端取最新收到的位置，不是插值中的顯示位置）。找不到時回傳 null。
   * 自己的 id 在離線時是 'local'。
   */
  playerPosition(playerId: string): { x: number; z: number; zone: string } | null
}

/**
 * 玩法模組：install 時註冊動作、動畫、音效與事件，回傳的函式負責全部清除。
 */
export interface GameplayModule {
  id: string
  install(api: GameplayApi): () => void
}
