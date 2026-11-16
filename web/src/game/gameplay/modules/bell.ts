import { envelope, smooth, type ClipFn } from '../../anim/AnimationSystem'
import { FACE_SMILE, PIVOT_HEIGHT } from '../../render/AvatarFactory'
import {
  BELL_CENTER,
  BELL_COOLDOWN_MS,
  BELL_HIT_MS,
  BELL_MS,
  BELL_PULL_MS,
  bellGain,
  bellQuietLeft,
  pickBellStation,
} from '../../world/bell'
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

/**
 * 敲鐘（只在庭院）：自動走到鐘亭前的空站位，拉撞木撞鐘。鐘聲與鐘的擺動發生在撞到的那一刻（startedAt + BELL_HIT_MS），
 * 每個客戶端各自以動作的 startedAt 推算，所以執行者與其他玩家看到、聽到的時刻一致（只差伺服器轉送的單程延遲）。
 *
 * 多人輪流敲：個人冷卻 10 秒；任何人撞到鐘之後 5 秒內（或有人正在敲、還沒撞到）按敲鐘會提示「鐘聲未歇」不出發；
 * 兩人在網路延遲內同時通過檢查而在 2 秒內先後撞到時，後一聲以 0.35 倍音量播放，不會疊成兩聲一樣大的鐘。
 * 回傳的函式清除全部註冊與計時器。
 */
export function installBell(api: GameplayApi): () => void {
  /** 最近一次（含已開始、還沒撞到的）撞到鐘的時間（performance.now 毫秒）。 */
  let lastHitAt = -Infinity
  /** 最近一次實際播放鐘聲的撞擊時間。 */
  let lastPlayedAt = -Infinity
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const off = [
    api.animations.registerClip('bellStrike', bellStrikeClip),
    api.actions.register({
      id: 'bell',
      label: '敲鐘',
      glyph: '🔔',
      cooldownMs: BELL_COOLDOWN_MS,
      animation: 'bellStrike',
      durationMs: BELL_MS,
      locksMovement: true,
      unavailableReason: (zone) => (zone === 'courtyard' ? null : '鐘亭在庭院，出殿後再敲'),
      approach: (ctx) => {
        const wait = bellQuietLeft(lastHitAt, performance.now())
        if (wait > 0) return `鐘聲未歇，約 ${Math.ceil(wait / 1000)} 秒後再敲`
        return pickBellStation(ctx)
      },
    }),
    api.events.on('actionPerformed', (e) => {
      if (e.actionId !== 'bell') return
      api.scene.strikeBell(e.startedAt)
      const hitAt = e.startedAt + BELL_HIT_MS
      lastHitAt = Math.max(lastHitAt, hitAt)
      const timer = setTimeout(
        () => {
          timers.delete(timer)
          if (performance.now() - hitAt > LATE_MS) return
          api.scene.swingBell()
          if (api.playerPosition('local')?.zone !== 'courtyard') return
          const me = api.localPosition()
          api.audio.play('bell', { gain: bellGain(Math.hypot(me.x - BELL_CENTER.x, me.z - BELL_CENTER.z), lastPlayedAt, hitAt) })
          lastPlayedAt = hitAt
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
