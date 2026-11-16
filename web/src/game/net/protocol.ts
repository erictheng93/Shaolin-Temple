/**
 * 前端與 Rust 伺服器之間的訊息格式（協定版本 3）。
 *
 * 位置廣播 moves／sync 與動作廣播 action 是 WebSocket 二進位幀（格式與位元組配置見 binaryFrame.ts），
 * 其餘訊息與所有上行都是 JSON 文字。編碼集中在 encode()/decode()；decode() 依收到的是字串或 ArrayBuffer 分流並驗證。
 * 與 Rust 伺服器共用固定資料 server/tests/protocol-v3.json；增修規格見 docs/BACKEND_TASKS.md「協定增修」與 T8。
 *
 * 版本：前端與伺服器的協定版本不同時，前端在 hello 時收到 error unsupported_version，
 * 不再重連並提示重新整理，不會出現「連上了但訊息解不開」的靜默故障。
 *
 * 語意分類：
 * - 可取代：move/stop。尚未送出的舊位置可被新位置覆蓋。
 * - 需確認：action。帶 reqId，伺服器以 reqId 去重並回 ack，重試不會重複執行。
 *
 * 位置廣播：
 * - 玩家加入房間時伺服器指派房內短編號 n（0～127，離開後回收）；moves／sync 以 n 取代字串 id。
 *   客戶端以 welcome／join 建立 n → 玩家對照，leave 時移除，對照不到的 n 直接忽略。
 * - moves 是增量（只含有變動的玩家）；sync 是整批校正（收件人所在場景的所有其他玩家），客戶端直接套用、不插值。
 * - moves／sync／action 只送給同場景玩家；zone／join／leave 送給同房所有人。
 * - action 幀以 n 指稱執行者、以一個 byte 的編號指稱動作、只帶 startedAt 的低 32 位元；decode() 以 DecodeContext
 *   （FrameContext：由 welcome／join／leave 維護 n → id，由 welcome／pong 估計伺服器時間）還原成與 v2 相同的
 *   { t: 'action', playerId, id, startedAt }，上層看不出差別。
 * - 上行 move／stop 的座標與 heading 四捨五入到 0.01（JSON）。下行 moves／sync 的座標精度 0.01 公尺、heading 一格 2π/256。
 */

import {
  FRAME_ACTION,
  MAX_MOVES_PER_MESSAGE,
  MAX_SHORT_ID,
  decodeAction,
  decodeBatch,
  unwrapStartedAt,
  type MoveTuple,
} from './binaryFrame'

export { MAX_MOVES_PER_MESSAGE, MAX_SHORT_ID, type MoveTuple }

export const PROTOCOL_VERSION = 3
/** 單則訊息上限（bytes）。超過即丟棄，伺服器端也應設相同上限。 */
export const MAX_MESSAGE_BYTES = 16 * 1024
/**
 * 伺服器對客戶端字串欄位的上限（UTF-8 bytes，見 server/src/protocol.rs）。超過時整則被視為無效訊息，
 * 10 秒內累積 21 則無效訊息會被斷線。前端產生的值都遠低於這些上限。
 */
export const CLIENT_STRING_LIMITS = { reqId: 128, resumeToken: 128, actionId: 32, zone: 32, rawName: 256 } as const

export interface PlayerSnapshot {
  id: string
  /** 房內短編號（0～127），moves／sync 以此指稱玩家。 */
  n: number
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
  /** 批次位置（二進位幀）：伺服器每個 tick 一則，只含有變動的玩家。元素為 [n, x, z, heading, moving(0|1)]。 */
  | { t: 'moves'; m: MoveTuple[] }
  /**
   * 整批位置校正（二進位幀；切換場景後、moves 被丟棄後）：直接套用位置、面向與移動狀態，不插值。
   * 若含收件人自己的短編號，代表伺服器拒絕了他送出的位置，須回到這個位置。
   */
  | { t: 'sync'; m: MoveTuple[] }
  /**
   * 其他玩家開始一個動作（二進位幀，解碼時以 DecodeContext 還原 playerId 與絕對 startedAt）。
   * startedAt 是伺服器的 Unix 毫秒。v3 的幀不帶 data（伺服器只接受空的 data）。
   */
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

const isShortId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_SHORT_ID

function isPlayer(v: unknown): v is PlayerSnapshot {
  if (!isObj(v)) return false
  if (!isStr(v.id) || !isShortId(v.n) || !isStr(v.name) || !isNum(v.x) || !isNum(v.z) || !isNum(v.heading)) return false
  if (v.zone !== undefined && !isStr(v.zone)) return false
  if (v.action === undefined) return true
  return isObj(v.action) && isStr(v.action.id) && isNum(v.action.startedAt)
}

/** 還原 action 幀所需的連線狀態。 */
export interface DecodeContext {
  /** 房內短編號 → 玩家 id；對照不到回傳 undefined。 */
  playerIdOf(n: number): string | undefined
  /** 客戶端估計的伺服器現在時間（Unix 毫秒），用來還原 startedAt 的高位。 */
  serverNow(): number
}

/**
 * 一條連線的 DecodeContext：看過的每則伺服器訊息都交給 observe()。welcome 重建 n → id 對照並校正時鐘、
 * join 加入（同一玩家換了編號時移除舊的）、leave 移除、pong 校正時鐘。重連後的 welcome 會整批重建。
 */
export class FrameContext implements DecodeContext {
  private readonly ids = new Map<number, string>()
  private offset: number | null = null

  constructor(private readonly clock: () => number = () => performance.now()) {}

  playerIdOf(n: number): string | undefined {
    return this.ids.get(n)
  }

  serverNow(): number {
    return this.clock() + (this.offset ?? 0)
  }

  observe(m: ServerMessage): void {
    switch (m.t) {
      case 'welcome':
        this.ids.clear()
        for (const p of m.players) this.ids.set(p.n, p.id)
        this.offset = m.serverTime - this.clock()
        break
      case 'join':
        for (const [n, id] of this.ids) if (id === m.player.id) this.ids.delete(n)
        this.ids.set(m.player.n, m.player.id)
        break
      case 'leave':
        for (const [n, id] of this.ids) if (id === m.id) this.ids.delete(n)
        break
      case 'pong':
        this.offset = m.serverTime - this.clock()
        break
    }
  }
}

/** 解碼 action 幀並以 ctx 還原；格式不符、沒有 ctx、或對照不到 n（例如 leave 之後才到）都回傳 null。 */
function decodeActionMessage(raw: ArrayBuffer, ctx: DecodeContext | undefined): ServerMessage | null {
  const frame = decodeAction(raw)
  if (!frame || !ctx) return null
  const playerId = ctx.playerIdOf(frame.n)
  if (playerId === undefined) return null
  return { t: 'action', playerId, id: frame.id, startedAt: unwrapStartedAt(frame.startedAtLow, ctx.serverNow()) }
}

/**
 * 解析伺服器訊息。格式不符、過大或未知類型時回傳 null，呼叫端直接忽略，不讓壞資料進入遊戲狀態。
 * ArrayBuffer（WebSocket binaryType = 'arraybuffer'）是二進位幀（moves／sync／action）；字串是 JSON。
 * moves／sync／action 只接受二進位幀，以 JSON 送來的視為無效（舊版格式）。action 幀需要 ctx 才能還原。
 */
export function decode(raw: unknown, ctx?: DecodeContext): ServerMessage | null {
  if (raw instanceof ArrayBuffer) {
    if (raw.byteLength > MAX_MESSAGE_BYTES || raw.byteLength === 0) return null
    return new Uint8Array(raw)[0] === FRAME_ACTION ? decodeActionMessage(raw, ctx) : decodeBatch(raw)
  }
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
