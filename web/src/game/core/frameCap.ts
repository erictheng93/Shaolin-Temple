/** 平常就省電：這麼久沒有操作也沒有移動，就把幀率上限降到 IDLE_FPS；一有操作立即恢復。 */
export const IDLE_AFTER_MS = 15_000
/** 20 FPS 對緩慢的環境動畫（落葉、樹冠、香煙）仍然順，繪製量是 60 FPS 的三分之一。 */
export const IDLE_FPS = 20
/** 久放（掛機）：更久沒有操作也沒有移動，降到 10 FPS；遠端玩家的插值以時間計，只會變得比較不滑順，速度不變。 */
export const DEEP_IDLE_AFTER_MS = 60_000
export const DEEP_IDLE_FPS = 10
/** 電量過低（未充電且 ≤ 20%）時，不論畫質等級，操作中的幀率上限。 */
export const LOW_BATTERY_FPS = IDLE_FPS

export interface FrameCapInput {
  /** 畫質預設的操作中幀率上限。 */
  activeFps: number
  /** 距離上次操作或移動過了多久（毫秒）。 */
  idleMs: number
  lowBattery: boolean
}

/** 目前的幀率上限：操作中取畫質上限（低電量時再壓到 LOW_BATTERY_FPS），閒置與久放再往下取較小者。 */
export function frameCap({ activeFps, idleMs, lowBattery }: FrameCapInput): number {
  let fps = lowBattery ? Math.min(LOW_BATTERY_FPS, activeFps) : activeFps
  if (idleMs > IDLE_AFTER_MS) fps = Math.min(fps, IDLE_FPS)
  if (idleMs > DEEP_IDLE_AFTER_MS) fps = Math.min(fps, DEEP_IDLE_FPS)
  return fps
}

/** 電量是否過低：沒有在充電且電量 20% 以下。 */
export function isLowBattery(charging: boolean, level: number): boolean {
  return !charging && level <= 0.2
}
