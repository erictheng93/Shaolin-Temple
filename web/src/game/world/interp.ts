/** 插值的一個端點；t 為客戶端時間（毫秒）。 */
export interface Sample {
  x: number
  z: number
  heading: number
  t: number
}

/**
 * 走到新位置所花的時間（毫秒）：取與上一筆位置的到達間隔，夾在這個範圍內；
 * 間隔超過上限（對方剛從靜止開始走）時用預設值，也就是伺服器的 tick 間隔。
 */
export const REMOTE_STEP_MIN_MS = 50
export const REMOTE_STEP_MAX_MS = 250
export const REMOTE_STEP_DEFAULT_MS = 100

/** 依與上一筆位置的到達間隔，決定走到新位置要花多久。 */
export function stepDuration(gapMs: number): number {
  return gapMs > REMOTE_STEP_MAX_MS ? REMOTE_STEP_DEFAULT_MS : Math.max(REMOTE_STEP_MIN_MS, gapMs)
}
/** 位置差距超過此公尺數視為瞬移（重連、傳送），直接套用不插值。 */
export const REMOTE_SNAP_DISTANCE = 5
/** 移動中的玩家超過此毫秒數沒有新位置，視為已停止（僅影響動畫）。 */
export const REMOTE_MOVE_TIMEOUT_MS = 1000

/** 角度 a 往 b 走最短路徑，k 為 0～1。 */
export function lerpAngle(a: number, b: number, k: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a))
  return a + d * k
}

/**
 * 在 from 與 to 兩筆樣本之間，取 time 時刻的位置（線性）。
 * time 超過 to.t 時停在 to，不外插；早於 from.t 時停在 from。結果寫入 out。
 */
export function sampleBetween(from: Sample, to: Sample, time: number, out: { x: number; z: number; heading: number }): void {
  const span = to.t - from.t
  const k = span > 0 ? Math.min(1, Math.max(0, (time - from.t) / span)) : 1
  out.x = from.x + (to.x - from.x) * k
  out.z = from.z + (to.z - from.z) * k
  out.heading = lerpAngle(from.heading, to.heading, k)
}
