import { t } from '../../i18n'
import { BELL_CENTER, BELL_STATION_GAP, BELL_STATIONS } from './layout'
import { pickFreeSpot, type SpotContext } from './worship'
import type { Pose } from './zones'

const smooth = (x: number) => x * x * (3 - 2 * x)

/**
 * 鐘亭的敲鐘站位與撞木（懸吊的木槌）時間軸。純資料與純函式：玩法模組、撞木的繪製與測試共用同一份數字，
 * 角色的動作、撞木的擺動與鐘聲的時刻因此一致。
 */

// 站位資料定義在 layout.ts（Node 的 mock 伺服器要直接載入），這裡照原名轉出口。
export { BELL_CENTER, BELL_STATION_GAP, BELL_STATIONS }

/** 敲鐘：走到最近的空站位。不在庭院或站位都有人時回傳原因。 */
export function pickBellStation(ctx: SpotContext): Pose | string {
  if (ctx.zone !== 'courtyard') return t('reason.bellInCourtyard')
  return pickFreeSpot(BELL_STATIONS, ctx, 'bell') ?? t('reason.bellTaken')
}

// ---------- 時間軸（毫秒，從動作開始算） ----------

/** 整個敲鐘動作：拉繩把撞木往後蓄力 → 往前推撞到鐘 → 撞木回彈、角色合掌致意。 */
export const BELL_MS = 3400
/** 往後蓄力到底。 */
export const BELL_PULL_MS = 1400
/** 撞到鐘的時刻：鐘聲與鐘的擺動都在這一刻（每個客戶端各自以 startedAt 推算）。 */
export const BELL_HIT_MS = 1750

// ---------- 撞木（懸吊的木槌） ----------

/**
 * 撞木：一根水平的圓木，兩條繩子從鐘亭頂板（y 2.95，與鐘的懸點同高）垂下，像平行四邊形一樣前後擺動、保持水平。
 * 擺角 θ > 0 往鐘（-z）擺。靜止時圓木中心在 (x, pivotY - length, z)，頭端在 z - halfLength。
 */
export const STRIKER = { x: BELL_CENTER.x, pivotY: 2.95, length: 1.05, z: -2.6, halfLength: 0.65, radius: 0.09 } as const
/**
 * 撞擊高度（約 1.9 公尺，鐘口往上約三分之一）的鐘面：TempleScene 的鐘懸在 2.95、往下 0.15 起算輪廓，
 * 該高度位於輪廓 (0.58, -1.05)～(0.48, -0.6) 之間，半徑約 0.547。
 */
const BELL_FACE_Z = BELL_CENTER.z + 0.547
/** 撞木頭端碰到鐘面時的擺角（約 0.19 弧度）。 */
export const STRIKER_CONTACT = Math.asin((STRIKER.z - STRIKER.halfLength - BELL_FACE_Z) / STRIKER.length)
/** 往後蓄力的最大擺角。 */
const STRIKER_PULL = -0.32

/**
 * 撞木在動作開始後 ms 毫秒的擺角：慢慢往後拉、往前加速撞到鐘（BELL_HIT_MS 時剛好是 STRIKER_CONTACT），
 * 撞到後回彈、衰減到靜止。撞到之後的擺角不會超過 STRIKER_CONTACT（不會穿進鐘裡）。
 */
export function strikerAngle(ms: number): number {
  if (ms <= 0 || ms >= BELL_MS) return 0
  if (ms < BELL_PULL_MS) return STRIKER_PULL * smooth(ms / BELL_PULL_MS)
  if (ms < BELL_HIT_MS) {
    const u = (ms - BELL_PULL_MS) / (BELL_HIT_MS - BELL_PULL_MS)
    return STRIKER_PULL + (STRIKER_CONTACT - STRIKER_PULL) * u * u
  }
  const v = (ms - BELL_HIT_MS) / (BELL_MS - BELL_HIT_MS)
  return STRIKER_CONTACT * (1 - v) ** 2 * Math.cos(3 * Math.PI * v)
}

// ---------- 多人輪流敲的聲音規則 ----------

/**
 * 個人冷卻：同一個人兩次敲鐘至少間隔 6 秒。必須小於兩聲的最短間隔（BELL_HIT_MS + BELL_QUIET_MS = 6.75 秒），
 * 同一組人才能每一聲都一起敲。
 */
export const BELL_COOLDOWN_MS = 6_000
/**
 * 鐘聲未歇：任何人撞到鐘之後 5 秒內（或已有人正在敲、還沒撞到），按敲鐘會先走到空站位就位等候，靜默期一結束才開始。
 * 撞到的時刻在開始後 BELL_HIT_MS，所以實際兩聲的間隔至少約 6.75 秒，前一聲的基音已衰減到約 1/8。
 */
export const BELL_QUIET_MS = 5_000
/**
 * 合力敲鐘：一聲鐘由第一個開始的 bell 動作開啟（開始時間 t0），之後開始時間與 t0 相差不超過這麼久的 bell 動作
 * 都算加入同一聲（一起拉同一根撞木），不另外響、不重啟撞木、不另外擺鐘。
 */
export const BELL_JOIN_MS = 700
/** 一聲最多幾人一起拉（三條拉繩）。 */
export const BELL_CREW_MAX = BELL_STATIONS.length
/**
 * 依一起拉的人數（1～3）的音量倍率。最大為 1：鐘的音檔峰值 0.8，靠近鐘時距離倍率約 0.93，
 * 再乘超過 1 的倍率在音效與總音量都開到最大時會削波（音訊鏈沒有壓縮器）。所以一人敲比以前小約 3 dB，三人與以前一人一樣大。
 */
export const BELL_CREW_GAIN: readonly number[] = [0.7, 0.85, 1]
/** 依人數的鐘擺強度（swingBell 的倍率，1 為一人）。 */
export const BELL_CREW_SWING: readonly number[] = [1, 1.1, 1.2]
/** 聽者在殿內：隔著殿牆聽到的固定音量（殿內座標與庭院不同，不依距離算）。乘上一人的 BELL_CREW_GAIN 約為 0.45。 */
export const BELL_HALL_GAIN = 0.64
/** 聽者在殿內：低通濾波的截止頻率（Hz），留下低沉的嗡聲、去掉金屬的亮度，像隔著殿牆；可憑耳朵調。 */
export const BELL_HALL_LOWPASS_HZ = 700
/** 兩人幾乎同時敲（網路延遲內都通過了上面的檢查）：與前一聲相隔不到 2 秒的鐘聲只以 0.35 倍音量播放。 */
export const BELL_MERGE_MS = 2_000
const BELL_MERGE_GAIN = 0.35

/** 現在按敲鐘還要等多久（毫秒），0 表示可以敲。lastHitAt 是最近一次撞到（或預定撞到）鐘的時間。 */
export function bellQuietLeft(lastHitAt: number, now: number): number {
  return Math.max(0, lastHitAt + BELL_QUIET_MS - now)
}

/**
 * 一聲鐘的音量：依聽者到鐘的距離（庭院約 38 公尺寬，最遠處仍聽得到，最小 0.3），
 * 與前一聲相隔不到 BELL_MERGE_MS 時再乘 BELL_MERGE_GAIN。prevHitAt 沒有前一聲時傳 -Infinity。
 */
export function bellGain(listenerDistance: number, prevHitAt: number, hitAt: number): number {
  const distance = Math.min(1, Math.max(0.3, 1 - listenerDistance / 45))
  return hitAt - prevHitAt < BELL_MERGE_MS ? distance * BELL_MERGE_GAIN : distance
}

/** 聽者在殿內時一聲鐘的音量：固定 BELL_HALL_GAIN，合併規則與 bellGain 相同。 */
export function bellHallGain(prevHitAt: number, hitAt: number): number {
  return hitAt - prevHitAt < BELL_MERGE_MS ? BELL_HALL_GAIN * BELL_MERGE_GAIN : BELL_HALL_GAIN
}

/** 一起拉的人數的音量倍率（超出 1～BELL_CREW_MAX 時取最近的一端）。 */
export function bellCrewGain(crew: number): number {
  return BELL_CREW_GAIN[Math.min(BELL_CREW_MAX, Math.max(1, Math.round(crew))) - 1]!
}

/** 一聲鐘：開啟它的動作開始時間 t0（performance.now 毫秒）與已加入的玩家（含開啟者）。 */
export interface BellRing {
  t0: number
  players: readonly string[]
}

/**
 * 一個 bell 動作（playerId 在 startedAt 開始）屬於哪一聲：
 * - `join`：與某一聲的 t0 相差不超過 BELL_JOIN_MS（前後皆可），加入 t0 最接近的那一聲；
 * - `dup`：該玩家已在那一聲（重複的事件），忽略；
 * - `open`：都不合，另開一聲（t0 = startedAt）。
 *
 * 一聲的 t0 一旦開啟就不再改變（撞木與排好的鐘聲不跳動）。事件不依 startedAt 順序到達時，
 * 晚到但開始得較早的動作只要在窗口內，同樣加入既有的那一聲，不把 t0 往前移；離得更遠的另開一聲（由 bellGain 的 2 秒合併規則壓低）。
 */
export function bellRingSlot(
  rings: ReadonlyArray<BellRing>,
  playerId: string,
  startedAt: number,
): { kind: 'open' } | { kind: 'join'; index: number } | { kind: 'dup' } {
  let index = -1
  let best = Infinity
  rings.forEach((r, i) => {
    const d = Math.abs(startedAt - r.t0)
    if (d <= BELL_JOIN_MS && d < best) {
      best = d
      index = i
    }
  })
  if (index < 0) return { kind: 'open' }
  return rings[index]!.players.includes(playerId) ? { kind: 'dup' } : { kind: 'join', index }
}
