import { CENSERS, HALL_CUSHIONS, type CenserDef, type Pose, type ZoneId } from './zones'

/**
 * 參拜點的選擇（純函式，方便測試）。蒲團與香爐前站位的佔用不經伺服器：
 * 只看同場景其他玩家的位置（含正在走向的目的地），避開已經有人的點。兩人幾乎同時選到同一點是可接受的小瑕疵；
 * 為了降低同一位置同時按下時選到同一點的機率，距離分數加上依玩家 id 而定的小偏移。
 */

export interface SpotContext {
  zone: ZoneId
  x: number
  z: number
  selfId: string
  /** 同場景其他玩家的位置（顯示位置與最新收到的位置都放進來）。 */
  others: ReadonlyArray<{ x: number; z: number }>
}

/** 其他玩家離參拜點這麼近就視為有人。 */
export const OCCUPIED_RADIUS = 0.6
/** 已經站在參拜點這麼近的範圍內，就直接用這一點。 */
const ALREADY_THERE = 0.3
/** 依玩家 id 的偏移上限（公尺）：同一處同時按下的兩人，多半會選到不同的點。 */
const JITTER = 0.8

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

/** 0..1 的雜湊值，同一組字串在所有客戶端相同。 */
export function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

const isFree = (spot: Pose, others: SpotContext['others']) => others.every((o) => dist(o, spot) > OCCUPIED_RADIUS)

/** 從候選點中挑一個沒人的：已站在某點就用它，否則取距離加偏移最小者。都有人時回傳 null。 */
export function pickFreeSpot(spots: ReadonlyArray<Pose>, ctx: SpotContext, salt: string): Pose | null {
  let best: Pose | null = null
  let bestScore = Infinity
  spots.forEach((spot, i) => {
    if (!isFree(spot, ctx.others)) return
    const d = dist(ctx, spot)
    const score = d <= ALREADY_THERE ? -1 : d + hash01(`${ctx.selfId}:${salt}:${i}`) * JITTER
    if (score < bestScore) {
      bestScore = score
      best = spot
    }
  })
  return best
}

/** 跪拜：殿內最近的空蒲團。不在殿內或全部有人時回傳原因。 */
export function pickCushion(ctx: SpotContext): Pose | string {
  if (ctx.zone !== 'hall') return '跪拜要在殿內的蒲團上進行'
  return pickFreeSpot(HALL_CUSHIONS, ctx, 'cushion') ?? '蒲團都有人了，請稍候再試'
}

/** 上香：依香爐由近到遠，找第一個還有空站位的香爐。 */
export function pickCenserSpot(ctx: SpotContext): Pose | string {
  const censers = CENSERS.filter((c) => c.zone === ctx.zone).sort((a, b) => dist(ctx, a) - dist(ctx, b))
  if (censers.length === 0) return '這裡沒有香爐'
  for (const c of censers) {
    const spot = pickFreeSpot(c.spots, ctx, c.id)
    if (spot) return spot
  }
  return '香爐前都有人，請稍候再試'
}

/** 上香的人插香時，由他的位置推出是哪個香爐：同場景中站位離他最近、且在 maxDistance 內的香爐。 */
export function censerForPosition(zone: string, x: number, z: number, maxDistance = 1.5): CenserDef | null {
  let best: CenserDef | null = null
  let bestD = maxDistance
  for (const c of CENSERS) {
    if (c.zone !== zone) continue
    for (const s of c.spots) {
      const d = Math.hypot(s.x - x, s.z - z)
      if (d <= bestD) {
        bestD = d
        best = c
      }
    }
  }
  return best
}
