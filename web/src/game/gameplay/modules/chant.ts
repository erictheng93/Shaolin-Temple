import { smooth, type ClipFn } from '../../anim/AnimationSystem'
import { FACE_SMILE, PIVOT_HEIGHT, PROP_CHANT } from '../../render/AvatarFactory'
import { pickChantCushion } from '../../world/worship'
import type { GameplayApi } from '../types'

/**
 * 誦經敲木魚（只在殿內）：走到最近的空蒲團、面向神龕跪坐（不叩拜），身前地上一個木魚、合十的手握木魚槌，
 * 以穩定的節奏敲木魚，開頭與完整誦完時各一聲引磬。固定 24 秒；點擊地面、方向鍵或按任何動作即提前起身
 * （送出 chant_end，其他玩家也停止）。沒有人聲。
 *
 * 多人同時誦經的聲音：所有人的木魚拍點對齊到同一個以伺服器時間為準的節拍格（每 CHANT_BEAT_MS 一拍），
 * 每個客戶端每一拍只發一聲木魚，音量取聽得到的誦經者中最大的（依距離衰減），人多時略為加大（最多 1.4 倍），
 * 所以不論幾個人一起誦經，都是一個整齊的節奏，同時發聲數固定是 1。動畫的敲擊也對齊同一個節拍格，畫面與聲音一致。
 *
 * 之後加入誦經錄音：以 api.audio.loadSfx() 載入（或改用 HTMLMediaElement 播放長音檔），
 * 在 planChantSounds() 回傳的事件裡於每位誦經者的 startS + QING_START_MS 加一筆人聲即可；拍點與時間軸都不用改。
 */

/** 整段誦經的長度。 */
export const CHANT_MS = 24_000
/** 木魚的節拍間隔（約 67 BPM，沉穩不急）。 */
export const CHANT_BEAT_MS = 900
/** 個人冷卻（從開始算）。誦經本身就會鎖定 24 秒；提前起身後 3 秒可再誦。 */
const CHANT_COOLDOWN_MS = 3_000
/** 跪坐下去、結尾起身的時間。 */
const SIT_MS = 1_200
const RISE_MS = 1_300
/** 提前結束時的起身動作長度。 */
export const CHANT_END_MS = 800
/** 坐定後一聲引磬；木魚從 STRIKES_FROM_MS 之後的第一拍敲到 STRIKES_UNTIL_MS 之前的最後一拍；完整誦完再一聲引磬。 */
export const QING_START_MS = 1_600
export const STRIKES_FROM_MS = 2_800
export const STRIKES_UNTIL_MS = CHANT_MS - 3_800
export const QING_END_MS = CHANT_MS - 2_800
/** 跪坐時 pivot 下降的高度與身體前傾（與跪拜相同的跪姿，但不叩拜）。 */
const KNEEL_DROP = 0.3
const KNEEL_LEAN = 0.1
/** 槌的最大抬起角度（弧度）與兩拍之間停在半空的比例。 */
export const MALLET_RAISE = 0.85
const HOVER = 0.35
/** 每拍的相位：0 敲到 → REBOUND 彈回半空 → RAISE_END 抬到最高 → 1 加速落下敲到下一拍。 */
const REBOUND = 0.18
const RAISE_END = 0.72

/** 聲音：木魚放慢一點更沉（0.8 倍速）；聽者以外的誦經者依距離衰減；人多時的加大上限。 */
const WOOD_RATE = 0.8
const WOOD_GAIN = 0.55
const QING_GAIN = 0.5
const REMOTE_GAIN = 0.7
/** 殿內約 16 × 18 公尺，20 公尺外聽不到。 */
export const CHANT_HEARING_RANGE = 20
const CROWD_BOOST = 0.1
const CROWD_BOOST_MAX_PEOPLE = 5
/** 兩聲引磬相隔不到這麼近就只留一聲（兩人幾乎同時開始時）。 */
const QING_MERGE_MS = 400
/** 排程：每 TICK_MS 排好接下來 LOOKAHEAD_MS 內的拍點（AudioContext 時間軸，準確；提前起身最多多響一聲）。 */
const TICK_MS = 100
const LOOKAHEAD_MS = 200

/** 一位誦經者在伺服器時間 startS 開始時，第一拍與最後一拍的伺服器時間（拍點都是 CHANT_BEAT_MS 的整數倍）。 */
export function chantBeats(startS: number): { first: number; last: number } {
  return {
    first: Math.ceil((startS + STRIKES_FROM_MS) / CHANT_BEAT_MS - 1e-9) * CHANT_BEAT_MS,
    last: Math.floor((startS + STRIKES_UNTIL_MS) / CHANT_BEAT_MS + 1e-9) * CHANT_BEAT_MS,
  }
}

const liftAt = (phase: number) =>
  phase < REBOUND
    ? HOVER * smooth(phase / REBOUND)
    : phase < RAISE_END
      ? HOVER + (1 - HOVER) * smooth((phase - REBOUND) / (RAISE_END - REBOUND))
      : 1 - ((phase - RAISE_END) / (1 - RAISE_END)) ** 2

/**
 * 槌抬起的比例（0 敲在木魚上、1 最高），nowS 與 startS 都是伺服器時間。第一拍之前停在半空、
 * 在第一拍前一拍內抬起落下；最後一拍後彈回半空停住。拍點上剛好是 0。
 */
export function malletLift(nowS: number, startS: number): number {
  const { first, last } = chantBeats(startS)
  if (nowS < first - CHANT_BEAT_MS * (1 - REBOUND) || nowS >= last + CHANT_BEAT_MS * REBOUND) return HOVER
  if (nowS >= last) return liftAt((nowS - last) / CHANT_BEAT_MS)
  const x = (nowS - first) / CHANT_BEAT_MS
  return liftAt(x - Math.floor(x))
}

/** 誦經的動作片段；拍點由 offset()（伺服器時間 − performance.now）換算，與聲音用同一個節拍格。 */
export const chantClip =
  (offset: () => number): ClipFn =>
  (rig, p, now) => {
    const ms = p * CHANT_MS
    const sit = ms < SIT_MS ? smooth(ms / SIT_MS) : ms > CHANT_MS - RISE_MS ? smooth((CHANT_MS - ms) / RISE_MS) : 1
    const o = offset()
    const lift = malletLift(now + o, now - ms + o)
    rig.pivot.position.y = PIVOT_HEIGHT - sit * KNEEL_DROP
    // 槌落下時身體跟著微微前傾
    rig.pivot.rotation.x = sit * (KNEEL_LEAN + (1 - lift) * 0.04)
    if (sit > 0.5) rig.face = FACE_SMILE // 瞇眼誦經
    if (ms > 250 && ms < CHANT_MS - RISE_MS * 0.6) {
      rig.prop = PROP_CHANT
      rig.propAngle = lift * MALLET_RAISE
    }
  }

/** 提前結束：從跪坐起身。 */
export const chantEndClip: ClipFn = (rig, p) => {
  const k = 1 - smooth(p)
  rig.pivot.position.y = PIVOT_HEIGHT - k * KNEEL_DROP
  rig.pivot.rotation.x = k * KNEEL_LEAN
}

export interface ChanterInfo {
  /** 開始的伺服器時間。 */
  startS: number
  /** 是不是本機玩家自己。 */
  local: boolean
  /** 與聽者的距離（公尺），自己為 0。 */
  distance: number
}

export interface PlannedSound {
  /** 播放的伺服器時間。 */
  atS: number
  sound: 'wood' | 'qing'
  gain: number
}

const chanterGain = (c: ChanterInfo) => (c.local ? 1 : REMOTE_GAIN * Math.max(0, 1 - c.distance / CHANT_HEARING_RANGE))

/**
 * 排出 (fromS, toS] 之間要播放的聲音（純函式）：
 * - 木魚：節拍格上的每一拍，只要有一位聽得到的誦經者在這一拍敲，就只播一聲；
 *   音量 = 最大的個人音量 × (1 + 0.1 × (人數 − 1，最多算 5 人))，上限 1，再乘木魚的基本音量。
 * - 引磬：每位誦經者開始後 QING_START_MS 一聲、QING_END_MS 一聲（提前結束的人已從清單移除，不會響）；
 *   相隔 QING_MERGE_MS 內的引磬只留最大聲的一聲。
 */
export function planChantSounds(chanters: readonly ChanterInfo[], fromS: number, toS: number): PlannedSound[] {
  const out: PlannedSound[] = []
  const audible = chanters.map((c) => ({ c, gain: chanterGain(c), beats: chantBeats(c.startS) })).filter((a) => a.gain > 0.01)
  if (!audible.length || toS <= fromS) return out

  for (let b = Math.floor(fromS / CHANT_BEAT_MS + 1e-9) * CHANT_BEAT_MS + CHANT_BEAT_MS; b <= toS; b += CHANT_BEAT_MS) {
    const striking = audible.filter((a) => b >= a.beats.first && b <= a.beats.last)
    if (!striking.length) continue
    const loudest = Math.max(...striking.map((a) => a.gain))
    const crowd = 1 + CROWD_BOOST * (Math.min(striking.length, CROWD_BOOST_MAX_PEOPLE) - 1)
    out.push({ atS: b, sound: 'wood', gain: Math.min(1, loudest * crowd) * WOOD_GAIN })
  }

  const qings = audible
    .flatMap((a) => [a.c.startS + QING_START_MS, a.c.startS + QING_END_MS].map((atS) => ({ atS, gain: a.gain * QING_GAIN })))
    .sort((a, b) => b.gain - a.gain || a.atS - b.atS)
  // 先在全部候選上合併、再切視窗：tick 每次只排一小段，若先切視窗，相近的兩聲落在不同呼叫就合併不到。
  const kept: typeof qings = []
  for (const q of qings) if (kept.every((k) => Math.abs(k.atS - q.atS) >= QING_MERGE_MS)) kept.push(q)
  for (const q of kept) if (q.atS > fromS && q.atS <= toS) out.push({ atS: q.atS, sound: 'qing', gain: q.gain })
  return out.sort((a, b) => a.atS - b.atS)
}

/**
 * 註冊誦經與提前結束（chant_end，不顯示在動作列），並以節拍格排程木魚與引磬。onConfirmed 是伺服器確認後的計數。
 * 排程計時器只在有人誦經時運作。回傳的函式清除全部註冊與計時器。
 */
export function installChant(api: GameplayApi, onConfirmed: () => void): () => void {
  /** 正在誦經的人：玩家 id → 開始時間（performance.now 毫秒）。 */
  const chanters = new Map<string, { startedAt: number; local: boolean }>()
  let timer: ReturnType<typeof setInterval> | null = null
  /** 已排程到的伺服器時間。 */
  let plannedUntil = -Infinity

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const tick = () => {
    const now = performance.now()
    for (const [id, c] of chanters) if (now - c.startedAt > CHANT_MS) chanters.delete(id)
    if (!chanters.size) return stop()
    const o = api.clockOffset()
    const listener = api.playerPosition('local')
    const list: ChanterInfo[] = []
    for (const [id, c] of chanters) {
      const p = c.local ? listener : api.playerPosition(id)
      if (!p || !listener || p.zone !== listener.zone) continue
      list.push({ startS: c.startedAt + o, local: c.local, distance: c.local ? 0 : Math.hypot(p.x - listener.x, p.z - listener.z) })
    }
    // 從背景回來或剛開始時從現在起排，不補過去的拍點
    const fromS = Math.max(plannedUntil, now + o)
    const toS = now + o + LOOKAHEAD_MS
    for (const s of planChantSounds(list, fromS, toS)) {
      api.audio.play(s.sound, { gain: s.gain, rate: s.sound === 'wood' ? WOOD_RATE : 1, at: s.atS - o })
    }
    plannedUntil = toS
  }

  const off = [
    api.animations.registerClip('chant', chantClip(() => api.clockOffset())),
    api.animations.registerClip('chantEnd', chantEndClip),
    api.actions.register({
      id: 'chant',
      label: '誦經',
      glyph: '經',
      cooldownMs: CHANT_COOLDOWN_MS,
      animation: 'chant',
      durationMs: CHANT_MS,
      locksMovement: true,
      endAction: 'chant_end',
      unavailableReason: (zone) => (zone === 'hall' ? null : '誦經要在殿內的蒲團上進行，請先進殿'),
      approach: pickChantCushion,
      onConfirmed,
    }),
    api.actions.register({
      id: 'chant_end',
      label: '起身',
      cooldownMs: 0,
      animation: 'chantEnd',
      durationMs: CHANT_END_MS,
      hidden: true,
    }),
    api.events.on('actionPerformed', (e) => {
      if (e.actionId === 'chant') {
        chanters.set(e.playerId, { startedAt: e.startedAt, local: e.local })
        if (!timer) {
          plannedUntil = -Infinity
          timer = setInterval(tick, TICK_MS)
        }
        tick()
      } else if (chanters.has(e.playerId)) {
        // 提前起身（chant_end）或改做其他動作：之後的木魚與收尾引磬都不再排
        chanters.delete(e.playerId)
      }
    }),
    api.events.on('playerLeft', (e) => {
      chanters.delete(e.id)
    }),
  ]

  return () => {
    off.forEach((fn) => fn())
    stop()
    chanters.clear()
  }
}
