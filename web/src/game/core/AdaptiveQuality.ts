/**
 * 依實際幀間隔動態調整畫質（智慧省電）。
 * 網頁讀不到裝置溫度；過熱降頻、同場人數變多或裝置本身較慢，都會表現為幀間隔變長，所以只看幀間隔。
 * 降得快（約 2 秒）、升得慢（約 30 秒）；升回去馬上又撐不住時，下次等更久再試，避免畫質來回跳。
 */

/** 等級 0 為完整畫質，數字越大越省。resolution 是繪製解析度倍率；nearRadius 內的角色用完整模型並投影，之外用低面數且不投影。 */
export const ADAPTIVE_LEVELS = [
  { resolution: 1, nearRadius: 14 },
  { resolution: 0.85, nearRadius: 14 },
  { resolution: 0.7, nearRadius: 9 },
  { resolution: 0.6, nearRadius: 5 },
] as const

/** 判斷一次所需的取樣時間。 */
const WINDOW_MS = 2000
/**
 * 平均幀間隔超過「目標 × 1.35」且超過 28 ms 才算吃力。
 * 28 ms 的下限是為了非 60 Hz 的螢幕：75 Hz 螢幕配 60 FPS 上限時，正常的幀間隔就是 26.7 ms。
 */
const SLOW_RATIO = 1.35
const SLOW_FLOOR_MS = 28
/** 平均幀間隔低於吃力門檻的這個比例，才算有餘裕。 */
const FAST_RATIO = 0.85
/** 持續有餘裕多久才升回一級；升級失敗時加倍，上限 MAX_RECOVER_MS。 */
const RECOVER_MS = 30_000
const MAX_RECOVER_MS = 240_000
/** 超過這個間隔視為暫停（切到背景、裝置休眠），不列入判斷。 */
const PAUSE_MS = 1000
/** 開始或暫停後先觀望：載入貼圖、編譯 shader 的卡頓不算。 */
const GRACE_MS = 3000

export class AdaptiveQuality {
  level = 0
  private graceUntil = -1
  private windowStart = -1
  private frames = 0
  private goodSince = -1
  private recoverMs = RECOVER_MS
  private raisedAt = -Infinity

  /** 每畫一幀呼叫一次。now 與 intervalMs（與上一幀的間隔）單位為毫秒；回傳等級是否改變。 */
  sample(now: number, intervalMs: number, targetMs: number): boolean {
    if (this.graceUntil < 0 || intervalMs > PAUSE_MS) {
      this.graceUntil = now + GRACE_MS
      this.windowStart = this.goodSince = -1
      return false
    }
    if (now < this.graceUntil) return false
    if (this.windowStart < 0) {
      this.windowStart = now
      this.frames = 0
      return false
    }
    this.frames++
    const span = now - this.windowStart
    if (span < WINDOW_MS) return false
    const average = span / this.frames
    this.windowStart = now
    this.frames = 0

    const slowMs = Math.max(targetMs * SLOW_RATIO, SLOW_FLOOR_MS)
    if (average > slowMs) {
      this.goodSince = -1
      if (this.level >= ADAPTIVE_LEVELS.length - 1) return false
      if (now - this.raisedAt < RECOVER_MS) this.recoverMs = Math.min(this.recoverMs * 2, MAX_RECOVER_MS)
      this.level++
      return true
    }
    if (average >= slowMs * FAST_RATIO || this.level === 0) {
      this.goodSince = -1
      return false
    }
    if (this.goodSince < 0) this.goodSince = now - span
    if (now - this.goodSince < this.recoverMs) return false
    this.level--
    this.raisedAt = now
    this.goodSince = -1
    return true
  }
}
