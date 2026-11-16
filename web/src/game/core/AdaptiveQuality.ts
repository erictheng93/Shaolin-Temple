/**
 * 依實際幀間隔動態調整畫質（智慧省電）。
 * 網頁讀不到裝置溫度；過熱降頻、同場人數變多或裝置本身較慢，都會表現為幀間隔變長，所以只看幀間隔。
 * 降得快（約 2 秒）、升得慢（約 30 秒）；升回去馬上又撐不住時，下次等更久再試，避免畫質來回跳。
 * 幀率有上限時，幀間隔量不出餘裕（GPU 用四成或九成五，趕得上就都是同一個間隔），所以「順暢」不代表不燙：
 * 觸控裝置以 minLevel 擋住最高等級；穩定很久之後才變慢視為過熱，隔很久才再升回。
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
/**
 * 同一等級穩定運作超過這麼久才變慢，視為過熱降頻（場景負載造成的變慢通常馬上出現）：升回的等待時間拉長到 THERMAL_RECOVER_MS。
 * 熱要幾分鐘才累積回來，上面「升回後 30 秒內又撐不住」的加倍抓不到，不這樣做會每 30 秒升回去再把手機加熱。
 * 兩個數值未經手機實測校正。
 */
const THERMAL_AFTER_MS = 120_000
const THERMAL_RECOVER_MS = 600_000
/** 超過這個間隔視為暫停（切到背景、裝置休眠），不列入判斷。 */
const PAUSE_MS = 1000
/** 開始或暫停後先觀望：載入貼圖、編譯 shader 的卡頓不算。 */
const GRACE_MS = 3000

export class AdaptiveQuality {
  level: number
  private graceUntil = -1
  private windowStart = -1
  private frames = 0
  private goodSince = -1
  private recoverMs = RECOVER_MS
  private raisedAt = -Infinity
  /** 目前等級從何時起沒有變過（暫停後重算）。 */
  private stableSince = -1

  /** startLevel：起始等級。minLevel：最高只升到這一級（觸控裝置自動畫質時兩者都是 1，不升到完整解析度）。 */
  constructor(
    startLevel = 0,
    private readonly minLevel = 0,
  ) {
    this.level = Math.min(Math.max(minLevel, Math.floor(startLevel)), ADAPTIVE_LEVELS.length - 1)
  }

  /** 每畫一幀呼叫一次。now 與 intervalMs（與上一幀的間隔）單位為毫秒；回傳等級是否改變。 */
  sample(now: number, intervalMs: number, targetMs: number): boolean {
    if (this.graceUntil < 0 || intervalMs > PAUSE_MS) {
      this.graceUntil = now + GRACE_MS
      this.windowStart = this.goodSince = -1
      this.stableSince = now
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
      if (now - this.stableSince > THERMAL_AFTER_MS) this.recoverMs = Math.max(this.recoverMs, THERMAL_RECOVER_MS)
      else if (now - this.raisedAt < RECOVER_MS && this.recoverMs < MAX_RECOVER_MS) this.recoverMs = Math.min(this.recoverMs * 2, MAX_RECOVER_MS)
      this.level++
      this.stableSince = now
      return true
    }
    if (average >= slowMs * FAST_RATIO || this.level <= this.minLevel) {
      this.goodSince = -1
      return false
    }
    if (this.goodSince < 0) this.goodSince = now - span
    if (now - this.goodSince < this.recoverMs) return false
    this.level--
    this.stableSince = now
    this.raisedAt = now
    this.goodSince = -1
    return true
  }
}
