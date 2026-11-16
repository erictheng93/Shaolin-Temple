import { envelope, smooth, type ClipFn } from '../../anim/AnimationSystem'
import { synthesizeQing } from '../../audio/AudioManager'
import { FACE_SMILE, PIVOT_HEIGHT, PROP_INCENSE } from '../../render/AvatarFactory'
import { censerForPosition, pickCenserSpot, pickCushion } from '../../world/worship'
import type { GameplayModule } from '../types'
import { installBell } from './bell'
import { installChant } from './chant'

/** 跪拜：跪下（前 KNEEL_IN）→ 叩拜三次 → 起身（最後 1 - KNEEL_OUT）。 */
export const PROSTRATE_MS = 8000
const KNEEL_IN = 0.14
const KNEEL_OUT = 0.86
const BOWS = 3
/** 每次叩拜中，前傾到底（BOW_DOWN）、停住到 BOW_HOLD、再回到跪姿。 */
const BOW_DOWN = 0.45
const BOW_HOLD = 0.6
/** 跪下時 pivot 下降的高度（身體壓扁）與叩拜時最大前傾角（弧度）。 */
const KNEEL_DROP = 0.3
const BOW_TILT = 1.0

/** 每次叩拜到底的時間（秒），引磬對齊這些時間敲。 */
export const PROSTRATE_STRIKES = Array.from({ length: BOWS }, (_, k) => {
  const p = KNEEL_IN + ((k + (BOW_DOWN + BOW_HOLD) / 2) / BOWS) * (KNEEL_OUT - KNEEL_IN)
  return (p * PROSTRATE_MS) / 1000
})

const bowShape = (phase: number) =>
  phase < BOW_DOWN ? smooth(phase / BOW_DOWN) : phase < BOW_HOLD ? 1 : smooth((1 - phase) / (1 - BOW_HOLD))

export const prostrateClip: ClipFn = (rig, p) => {
  const kneel = p < KNEEL_IN ? smooth(p / KNEEL_IN) : p > KNEEL_OUT ? smooth((1 - p) / (1 - KNEEL_OUT)) : 1
  let bow = 0
  if (p > KNEEL_IN && p < KNEEL_OUT) {
    const q = ((p - KNEEL_IN) / (KNEEL_OUT - KNEEL_IN)) * BOWS
    bow = bowShape(q - Math.floor(q))
  }
  rig.pivot.position.y = PIVOT_HEIGHT - kneel * KNEEL_DROP
  rig.pivot.rotation.x = kneel * 0.12 + bow * (BOW_TILT - 0.12)
  if (bow > 0.3) rig.face = FACE_SMILE
}

/** 上香：舉香（前 RAISE）→ 三拜 → 前傾插香（PLANT_AT 時香離手、插進香爐）→ 回正。 */
export const INCENSE_MS = 6000
export const PLANT_AT = 0.8
const RAISE = 0.12
const BOWS_END = 0.64
const INCENSE_TILT = 0.4

export const incenseClip: ClipFn = (rig, p) => {
  if (p < PLANT_AT) rig.prop = PROP_INCENSE
  if (p > RAISE && p < BOWS_END) {
    const q = ((p - RAISE) / (BOWS_END - RAISE)) * BOWS
    rig.pivot.rotation.x = envelope(q - Math.floor(q), 0.4, 0.45) * INCENSE_TILT
    rig.face = FACE_SMILE
  } else if (p >= BOWS_END) {
    // 前傾把香插進香爐，插完回正
    rig.pivot.rotation.x = envelope((p - BOWS_END) / (1 - BOWS_END), 0.45, 0.4) * 0.28
  }
}

/**
 * 參拜玩法：合十、跪拜（殿內走到空蒲團）、誦經敲木魚（殿內走到空蒲團，chant.ts）、上香（走到最近的香爐前）、
 * 敲鐘（庭院走到鐘亭前，bell.ts）。動作列依註冊順序排列。
 * 上香插下的香由每個客戶端各自依執行者插香當下的位置推出是哪個香爐，不經伺服器、不需新的協定欄位。
 */
export const worshipModule: GameplayModule = {
  id: 'worship',
  install(api) {
    let count = 0
    const counted = () => api.setStat('worship.count', '禮敬', ++count)
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const off = [
      api.animations.registerClip('prostrate', prostrateClip),
      api.animations.registerClip('incense', incenseClip),
      api.audio.defineSfx('qing', (ctx) => synthesizeQing(ctx)),
      api.audio.defineSfx('qing3', (ctx) => synthesizeQing(ctx, PROSTRATE_STRIKES)),
      api.actions.register({
        id: 'bow',
        label: '合十',
        glyph: '🙏',
        cooldownMs: 2500,
        animation: 'bow',
        durationMs: 2200,
        locksMovement: true,
        sound: 'wood',
        onConfirmed: counted,
      }),
      api.actions.register({
        id: 'prostrate',
        label: '跪拜',
        glyph: '🧎',
        cooldownMs: PROSTRATE_MS + 1000,
        animation: 'prostrate',
        durationMs: PROSTRATE_MS,
        locksMovement: true,
        sound: 'qing3',
        unavailableReason: (zone) => (zone === 'hall' ? null : '跪拜要在殿內的蒲團上進行'),
        approach: pickCushion,
        onConfirmed: counted,
      }),
      installChant(api, counted),
      api.actions.register({
        id: 'incense',
        label: '上香',
        glyph: '香',
        cooldownMs: INCENSE_MS + 2000,
        animation: 'incense',
        durationMs: INCENSE_MS,
        locksMovement: true,
        sound: 'qing',
        approach: pickCenserSpot,
        onConfirmed: counted,
      }),
      installBell(api),
      api.events.on('actionPerformed', (e) => {
        // 插香的那一刻依執行者當時的位置找香爐；遠端玩家的最後一筆位置通常比動作晚到，所以不在收到動作時就決定。
        if (e.actionId === 'incense') {
          const timer = setTimeout(
            () => {
              timers.delete(timer)
              const p = api.playerPosition(e.playerId)
              const censer = p && censerForPosition(p.zone, p.x, p.z)
              if (censer) api.scene.offerIncense(censer.id)
            },
            Math.max(0, e.startedAt + INCENSE_MS * PLANT_AT - performance.now()),
          )
          timers.add(timer)
        }
      }),
    ]

    return () => {
      off.forEach((fn) => fn())
      timers.forEach((t) => clearTimeout(t))
      timers.clear()
      api.setStat('worship.count', '', null)
    }
  },
}
