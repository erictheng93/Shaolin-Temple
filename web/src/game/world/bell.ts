import { t } from '../../i18n'
import { BELL_PAVILION, PLAYER_RADIUS } from './layout'
import { pickFreeSpot, type SpotContext } from './worship'
import type { Pose } from './zones'

const smooth = (x: number) => x * x * (3 - 2 * x)

/**
 * 鐘亭的敲鐘站位與撞木（懸吊的木槌）時間軸。純資料與純函式：玩法模組、撞木的繪製與測試共用同一份數字，
 * 角色的動作、撞木的擺動與鐘聲的時刻因此一致。
 */

/** 鐘的中心（鐘亭正中，TempleScene 的 bellPivot）。 */
export const BELL_CENTER = {
  x: (BELL_PAVILION.minX + BELL_PAVILION.maxX) / 2,
  z: (BELL_PAVILION.minZ + BELL_PAVILION.maxZ) / 2,
}

/**
 * 敲鐘站位：鐘亭面向庭院（+z）的一側，站在鐘亭障礙物（含角色半徑）外 0.15 公尺，左右各一、間距 0.8 公尺
 * （大於兩個角色半徑 0.7，也大於視為有人的 0.6），三人可同時站著不重疊。面向鐘。
 * 撞木從這一側伸向鐘，三條拉繩從撞木尾端垂到三個站位的手前。
 */
export const BELL_STATION_GAP = 0.8
const BELL_STATION_Z = BELL_PAVILION.maxZ + PLAYER_RADIUS + 0.15
export const BELL_STATIONS: ReadonlyArray<Pose> = [-1, 0, 1].map((i) => {
  const x = BELL_CENTER.x + i * BELL_STATION_GAP
  return { x, z: BELL_STATION_Z, heading: Math.atan2(BELL_CENTER.x - x, BELL_CENTER.z - BELL_STATION_Z) }
})

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

/** 個人冷卻：同一個人兩次敲鐘至少間隔 10 秒。 */
export const BELL_COOLDOWN_MS = 10_000
/**
 * 鐘聲未歇：任何人撞到鐘之後 5 秒內（或已有人正在敲、還沒撞到），按敲鐘會提示稍候，不出發。
 * 撞到的時刻在按下後至少 BELL_HIT_MS，所以實際兩聲的間隔至少約 6.75 秒，前一聲的基音已衰減到約 1/8。
 */
export const BELL_QUIET_MS = 5_000
/** 聽者在殿內：隔著殿牆聽到的固定音量（殿內座標與庭院不同，不依距離算）。 */
export const BELL_HALL_GAIN = 0.45
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
