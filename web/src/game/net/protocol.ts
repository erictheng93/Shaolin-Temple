/**
 * 前端與 Rust 伺服器之間的訊息格式草案（協定版本 1）。
 *
 * 目前使用 JSON 以便除錯；編碼集中在 encode()/decode()，之後改二進位只需替換這兩個函式。
 * 後端尚未實作，欄位以伺服器定案為準。
 *
 * 語意分類：
 * - 可取代：move/stop。尚未送出的舊位置可被新位置覆蓋。
 * - 需確認：action。帶 reqId，伺服器以 reqId 去重並回 ack，重試不會重複執行。
 */

export const PROTOCOL_VERSION = 1
/** 單則訊息上限（bytes）。超過即丟棄，伺服器端也應設相同上限。 */
export const MAX_MESSAGE_BYTES = 16 * 1024
/**
 * 伺服器對客戶端字串欄位的上限（UTF-8 bytes，見 server/src/protocol.rs）。超過時整則被視為無效訊息，
 * 10 秒內累積 21 則無效訊息會被斷線。前端產生的值都遠低於這些上限。
 */
export const CLIENT_STRING_LIMITS = { reqId: 128, resumeToken: 128, actionId: 32, zone: 32, rawName: 256 } as const

export interface PlayerSnapshot {
  id: string
  name: string
  x: number
  z: number
  /** 面向角度（弧度）。 */
  heading: number
  /** 玩家目前正在進行的動作，沒有則省略。 */
  action?: { id: string; startedAt: number }
  /** 所在場景（'courtyard'、'hall'…）；省略時視為 'courtyard'。 */
  zone?: string
}

/** 批次位置的單筆：[id, x, z, heading, moving]，moving 為 0 或 1。座標建議四捨五入到 0.01 公尺。 */
export type MoveTuple = [id: string, x: number, z: number, heading: number, moving: 0 | 1]

/** 單則 moves 最多筆數；超過時伺服器應拆成多則。 */
export const MAX_MOVES_PER_MESSAGE = 200

export type ClientMessage =
  | { t: 'hello'; v: number; name: string; resumeToken?: string }
  | { t: 'move'; x: number; z: number; heading: number; seq: number }
  | { t: 'stop'; x: number; z: number; heading: number; seq: number }
  | { t: 'action'; reqId: string; id: string; data?: Record<string, unknown> }
  /** 切換場景：x/z/heading 為進入新場景後的位置（出入口的 spawn）。伺服器應驗證玩家確實站在出入口。 */
  | { t: 'zone'; zone: string; x: number; z: number; heading: number }
  | { t: 'ping'; ts: number }

export type ServerMessage =
  | {
      t: 'welcome'
      selfId: string
      room: string
      resumeToken: string
      serverTime: number
      players: PlayerSnapshot[]
    }
  | { t: 'join'; player: PlayerSnapshot }
  | { t: 'leave'; id: string }
  | { t: 'move'; id: string; x: number; z: number; heading: number; moving: boolean }
  /** 批次位置：伺服器每個 tick 一則，只含有變動的玩家。元素為 [id, x, z, heading, moving(0|1)]。 */
  | { t: 'moves'; m: MoveTuple[] }
  | { t: 'action'; playerId: string; id: string; startedAt: number; data?: Record<string, unknown> }
  | { t: 'ack'; reqId: string; ok: boolean; reason?: string }
  /** 某玩家切換場景。 */
  | { t: 'zone'; id: string; zone: string; x: number; z: number; heading: number }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string }

export function encode(msg: ClientMessage): string {
  return JSON.stringify(msg)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length <= 256
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isPlayer(v: unknown): v is PlayerSnapshot {
  if (!isObj(v)) return false
  if (!isStr(v.id) || !isStr(v.name) || !isNum(v.x) || !isNum(v.z) || !isNum(v.heading)) return false
  if (v.zone !== undefined && !isStr(v.zone)) return false
  if (v.action === undefined) return true
  return isObj(v.action) && isStr(v.action.id) && isNum(v.action.startedAt)
}

function isMoveTuple(v: unknown): v is MoveTuple {
  return (
    Array.isArray(v) &&
    v.length === 5 &&
    isStr(v[0]) &&
    isNum(v[1]) &&
    isNum(v[2]) &&
    isNum(v[3]) &&
    (v[4] === 0 || v[4] === 1)
  )
}

/**
 * 解析伺服器訊息。格式不符、過大或未知類型時回傳 null，呼叫端直接忽略，不讓壞資料進入遊戲狀態。
 */
export function decode(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null
  let m: unknown
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(m)) return null
  switch (m.t) {
    case 'welcome':
      return isStr(m.selfId) &&
        isStr(m.room) &&
        isStr(m.resumeToken) &&
        isNum(m.serverTime) &&
        Array.isArray(m.players) &&
        m.players.every(isPlayer)
        ? (m as ServerMessage)
        : null
    case 'join':
      return isPlayer(m.player) ? (m as ServerMessage) : null
    case 'leave':
      return isStr(m.id) ? (m as ServerMessage) : null
    case 'move':
      return isStr(m.id) && isNum(m.x) && isNum(m.z) && isNum(m.heading) && typeof m.moving === 'boolean'
        ? (m as ServerMessage)
        : null
    case 'moves':
      return Array.isArray(m.m) && m.m.length <= MAX_MOVES_PER_MESSAGE && m.m.every(isMoveTuple)
        ? (m as ServerMessage)
        : null
    case 'action':
      return isStr(m.playerId) && isStr(m.id) && isNum(m.startedAt) && (m.data === undefined || isObj(m.data))
        ? (m as ServerMessage)
        : null
    case 'ack':
      return isStr(m.reqId) && typeof m.ok === 'boolean' && (m.reason === undefined || isStr(m.reason))
        ? (m as ServerMessage)
        : null
    case 'zone':
      return isStr(m.id) && isStr(m.zone) && isNum(m.x) && isNum(m.z) && isNum(m.heading) ? (m as ServerMessage) : null
    case 'pong':
      return isNum(m.ts) && isNum(m.serverTime) ? (m as ServerMessage) : null
    case 'error':
      return isStr(m.code) && isStr(m.message) ? (m as ServerMessage) : null
    default:
      return null
  }
}
