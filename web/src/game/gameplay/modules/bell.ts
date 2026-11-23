import { envelope, smooth, type ClipFn } from '../../anim/AnimationSystem'
import { FACE_SMILE, PIVOT_HEIGHT } from '../../render/AvatarFactory'
import {
  BELL_CENTER,
  BELL_COOLDOWN_MS,
  BELL_HALL_LOWPASS_HZ,
  BELL_CREW_MAX,
  BELL_CREW_SWING,
  BELL_HIT_MS,
  BELL_JOIN_MS,
  BELL_MS,
  BELL_PULL_MS,
  bellCrewGain,
  bellGain,
  bellHallGain,
  bellQuietLeft,
  bellRingSlot,
  pickBellStation,
} from '../../world/bell'
import { t } from '../../../i18n'
import type { GameplayApi } from '../types'

/** 往後拉繩時身體後仰、往前推時前傾的角度（弧度），與撞木的擺動同步（world/bell.ts 的時間軸）。 */
const LEAN_BACK = 0.26
const LUNGE = 0.32
/** 撞到後回正的時間，之後合掌致意（小幅鞠躬、笑眼）。 */
const RECOVER_MS = 600
const BOW_FROM_MS = BELL_HIT_MS + 750
/** 收到時撞擊已經過去這麼久（例如從背景回來），就不補響、不補擺。 */
const LATE_MS = 1500

/** 撞鐘：拉繩後仰蓄力（壓低重心）→ 往前推、撞到鐘的那一刻前傾最大 → 回正 → 合掌致意。 */
export const bellStrikeClip: ClipFn = (rig, p) => {
  const ms = p * BELL_MS
  let tilt = 0
  if (ms < BELL_PULL_MS) {
    const e = smooth(ms / BELL_PULL_MS)
    tilt = -LEAN_BACK * e
    rig.pivot.position.y = PIVOT_HEIGHT - 0.05 * e
  } else if (ms < BELL_HIT_MS) {
    const u = (ms - BELL_PULL_MS) / (BELL_HIT_MS - BELL_PULL_MS)
    tilt = -LEAN_BACK + (LUNGE + LEAN_BACK) * u * u
    rig.pivot.position.y = PIVOT_HEIGHT - 0.05 * (1 - u)
  } else if (ms < BELL_HIT_MS + RECOVER_MS) {
    tilt = LUNGE * (1 - smooth((ms - BELL_HIT_MS) / RECOVER_MS))
  }
  if (ms >= BOW_FROM_MS) {
    tilt += envelope((ms - BOW_FROM_MS) / (BELL_MS - BOW_FROM_MS), 0.35, 0.4) * 0.35
    rig.face = FACE_SMILE
  }
  rig.pivot.rotation.x = tilt
}

/** 一聲鐘的紀錄保留多久（從 t0 起算，毫秒）：之後才到的同一聲的加入者已不影響任何事。 */
const RING_KEEP_MS = BELL_MS + BELL_JOIN_MS + LATE_MS

/**
 * 敲鐘（只在庭院敲，全寺都聽得見，殿內較小聲）：自動走到鐘亭前的空站位，拉撞木撞鐘。鐘聲與鐘的擺動發生在撞到的那一刻（t0 + BELL_HIT_MS），
 * 每個客戶端各自以動作的 startedAt 推算，所以執行者與其他玩家看到、聽到的時刻一致（只差伺服器轉送的單程延遲）。
 *
 * 合力敲鐘：開始時間相差 BELL_JOIN_MS 內的 bell 動作（最多三人、各拉一條繩）算同一聲（world/bell.ts 的 bellRingSlot），
 * 撞木只走開啟者的時間軸、鐘聲只響一次，音量與鐘擺依撞到那一刻已加入的人數（BELL_CREW_GAIN、BELL_CREW_SWING）。
 * 個人冷卻 10 秒；鐘聲未歇（任何人撞到鐘之後 5 秒內，或有人正在敲、還沒撞到）時按敲鐘會走到空站位就位等候（startWait），
 * 靜默期一結束自動開始，所以等候的人幾乎同時開始、落在同一聲；抵達時這一聲還可加入就立刻開始。
 * 兩人在網路延遲內同時開始卻沒落在同一聲（相差超過 BELL_JOIN_MS）而在 2 秒內先後撞到時，後一聲以 0.35 倍音量播放。
 * 回傳的函式清除全部註冊與計時器。
 */
export function installBell(api: GameplayApi): () => void {
  /** 最近一次（含已開始、還沒撞到的）撞到鐘的時間（performance.now 毫秒）。 */
  let lastHitAt = -Infinity
  /** 最近一次實際播放鐘聲的撞擊時間。 */
  let lastPlayedAt = -Infinity
  /** 最近的幾聲鐘（含還沒撞到的），用來判斷新的 bell 動作是加入還是另開一聲。 */
  let rings: Array<{ t0: number; players: string[] }> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  /** 撞到鐘的那一刻：依已加入的人數發聲（只在庭院擺鐘）。 */
  const ringOut = (ring: { t0: number; players: string[] }) => {
    const hitAt = ring.t0 + BELL_HIT_MS
    if (performance.now() - hitAt > LATE_MS) return
    const crew = ring.players.length
    // 全寺都聽得見：殿內的人以固定的較小音量聽到。鐘只在庭院才擺（殿內不更新庭院場景，擺動會留著等回庭院才播）。
    const zone = api.playerPosition('local')?.zone
    if (zone === 'courtyard') api.scene.swingBell(BELL_CREW_SWING[Math.min(BELL_CREW_MAX, crew) - 1]!)
    let gain: number
    let lowpass: number | undefined
    if (zone === 'courtyard') {
      const me = api.localPosition()
      gain = bellGain(Math.hypot(me.x - BELL_CENTER.x, me.z - BELL_CENTER.z), lastPlayedAt, hitAt)
    } else if (zone === 'hall') {
      gain = bellHallGain(lastPlayedAt, hitAt)
      lowpass = BELL_HALL_LOWPASS_HZ
    } else return
    gain *= bellCrewGain(crew)
    api.audio.play('bell', lowpass === undefined ? { gain } : { gain, lowpass })
    lastPlayedAt = hitAt
  }

  const off = [
    api.animations.registerClip('bellStrike', bellStrikeClip),
    api.actions.register({
      id: 'bell',
      label: 'action.bell',
      glyph: '🔔',
      cooldownMs: BELL_COOLDOWN_MS,
      animation: 'bellStrike',
      durationMs: BELL_MS,
      locksMovement: true,
      unavailableReason: (zone) => (zone === 'courtyard' ? null : t('reason.bellInCourtyard')),
      approach: pickBellStation,
      // 這一聲還能加入（開啟不到 BELL_JOIN_MS、繩子還有空）就立刻開始；否則等到鐘聲歇了
      startWait: (now) =>
        rings.some((r) => Math.abs(now - r.t0) <= BELL_JOIN_MS && r.players.length < BELL_CREW_MAX) ? 0 : bellQuietLeft(lastHitAt, now),
    }),
    api.events.on('actionPerformed', (e) => {
      if (e.actionId !== 'bell') return
      rings = rings.filter((r) => performance.now() - r.t0 <= RING_KEEP_MS)
      const slot = bellRingSlot(rings, e.playerId, e.startedAt)
      if (slot.kind === 'dup') return
      if (slot.kind === 'join') {
        // 加入這一聲：同一根撞木、同一聲鐘，只增加人數（撞到那一刻才算音量）
        rings[slot.index]!.players.push(e.playerId)
        return
      }
      const ring = { t0: e.startedAt, players: [e.playerId] }
      rings.push(ring)
      api.scene.strikeBell(ring.t0)
      const hitAt = ring.t0 + BELL_HIT_MS
      lastHitAt = Math.max(lastHitAt, hitAt)
      const timer = setTimeout(
        () => {
          timers.delete(timer)
          ringOut(ring)
        },
        Math.max(0, hitAt - performance.now()),
      )
      timers.add(timer)
    }),
  ]

  return () => {
    off.forEach((fn) => fn())
    timers.forEach((t) => clearTimeout(t))
    timers.clear()
  }
}
