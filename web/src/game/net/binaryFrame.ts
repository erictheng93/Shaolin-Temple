/**
 * 伺服器下行的二進位幀（協定版本 4；v4 未改變二進位幀）：moves／sync（0x01／0x02，自 v2 起）與 action（0x03，v3 起）。
 * 前端解碼、mock 伺服器編碼都用這一份實作；Rust 端在 server/src/protocol.rs（encode_batch／decode_batch、
 * encode_action／decode_action），兩邊以 server/tests/protocol-v6.json 的 binary 測試向量驗證一致。
 *
 * 這個檔案不 import 任何東西、只用可被移除的型別語法，讓 `node scripts/mock-server.mjs` 能直接載入
 * （Node 22.18 起內建 TypeScript 型別移除）。
 *
 * moves／sync：幀 = 1 byte 幀型 + N 筆 × 6 bytes，N = (長度 − 1) / 6，0 ≤ N ≤ MAX_MOVES_PER_MESSAGE。整數為 little-endian。
 *
 * | 位移 | 型別 | 內容 |
 * | --- | --- | --- |
 * | 0 | u8 | bit 7：moving；bit 0～6：房內短編號 n（0～127） |
 * | 1 | i16 | x，公分（四捨五入，.5 遠離零），限 ±MAX_COORD_CM |
 * | 3 | i16 | z，公分，同上 |
 * | 5 | u8 | heading：q = round(heading × 128 / π) mod 256；解碼 (q ≤ 128 ? q : q − 256) × π / 128 ∈ (−π, π] |
 *
 * action：固定 7 bytes（ACTION_FRAME_BYTES）。
 *
 * | 位移 | 型別 | 內容 |
 * | --- | --- | --- |
 * | 0 | u8 | 幀型 0x03 |
 * | 1 | u8 | 執行者的房內短編號 n（0～127；bit 7 保留，須為 0） |
 * | 2 | u8 | 動作編號：ACTION_CODES 的索引 |
 * | 3 | u32 | startedAt（伺服器的 Unix 毫秒）mod 2^32；由 unwrapStartedAt() 以參考時間還原 |
 */

/** 批次位置的單筆：[n, x, z, heading, moving]，n 為房內短編號，moving 為 0 或 1。 */
export type MoveTuple = [n: number, x: number, z: number, heading: number, moving: 0 | 1]
export type BatchMessage = { t: 'moves' | 'sync'; m: MoveTuple[] }

/** 單則 moves／sync 最多筆數；超過時伺服器拆成多則。 */
export const MAX_MOVES_PER_MESSAGE = 200
export const FRAME_MOVES = 0x01
export const FRAME_SYNC = 0x02
export const MOVE_ENTRY_BYTES = 6
/** 房內短編號上限（7 位元）。 */
export const MAX_SHORT_ID = 127
/** 座標上限（公分，±100 公尺）。場景都在 ±19 公尺內，超出視為壞資料。 */
export const MAX_COORD_CM = 10_000
const MOVING_BIT = 0x80
const HEADING_STEP = Math.PI / 128

/** .5 遠離零（與 Rust 的 f64::round 相同；Math.round 的 −0.5 會變成 −0）。 */
const roundAway = (v: number): number => Math.sign(v) * Math.round(Math.abs(v))

export function quantizeCoord(v: number): number {
  const cm = roundAway(v * 100)
  if (!Number.isFinite(cm)) return 0
  return Math.max(-MAX_COORD_CM, Math.min(MAX_COORD_CM, cm)) | 0
}

export function quantizeHeading(heading: number): number {
  const q = roundAway((heading * 128) / Math.PI)
  if (!Number.isFinite(q)) return 0
  return ((q % 256) + 256) % 256
}

export function dequantizeHeading(q: number): number {
  return (q <= 128 ? q : q - 256) * HEADING_STEP
}

/** 編碼一則幀。筆數超過上限或短編號不在 0～127 時回傳 null。 */
export function encodeBatch(msg: BatchMessage): Uint8Array | null {
  if (msg.m.length > MAX_MOVES_PER_MESSAGE) return null
  const out = new Uint8Array(1 + msg.m.length * MOVE_ENTRY_BYTES)
  const view = new DataView(out.buffer)
  out[0] = msg.t === 'moves' ? FRAME_MOVES : FRAME_SYNC
  let o = 1
  for (const [n, x, z, heading, moving] of msg.m) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_SHORT_ID) return null
    view.setUint8(o, n | (moving ? MOVING_BIT : 0))
    view.setInt16(o + 1, quantizeCoord(x), true)
    view.setInt16(o + 3, quantizeCoord(z), true)
    view.setUint8(o + 5, quantizeHeading(heading))
    o += MOVE_ENTRY_BYTES
  }
  return out
}

/**
 * 解碼並驗證一則幀。空的幀、未知幀型、長度不是 1 + 6N、超過筆數上限、座標超出 ±MAX_COORD_CM 都回傳 null，
 * 整則丟棄（與 JSON 訊息「任一筆錯誤就整則拒絕」相同）。
 */
export function decodeBatch(data: ArrayBuffer | ArrayBufferView): BatchMessage | null {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length === 0) return null
  const kind = bytes[0]
  const t = kind === FRAME_MOVES ? 'moves' : kind === FRAME_SYNC ? 'sync' : null
  if (!t) return null
  const body = bytes.length - 1
  if (body % MOVE_ENTRY_BYTES !== 0) return null
  const count = body / MOVE_ENTRY_BYTES
  if (count > MAX_MOVES_PER_MESSAGE) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const m: MoveTuple[] = new Array(count)
  for (let i = 0, o = 1; i < count; i++, o += MOVE_ENTRY_BYTES) {
    const head = view.getUint8(o)
    const x = view.getInt16(o + 1, true)
    const z = view.getInt16(o + 3, true)
    if (Math.abs(x) > MAX_COORD_CM || Math.abs(z) > MAX_COORD_CM) return null
    m[i] = [head & MAX_SHORT_ID, x / 100, z / 100, dequantizeHeading(view.getUint8(o + 5)), head & MOVING_BIT ? 1 : 0]
  }
  return { t, m }
}

// ---- action（協定版本 3）----

export const FRAME_ACTION = 0x03
export const ACTION_FRAME_BYTES = 7
/**
 * 動作編號對照表：索引即線路上的編號，是協定的一部分。必須與 server/src/world.rs 的 ACTIONS（同一順序）
 * 及固定資料 binary.action.codes 相同（兩邊測試都檢查）；mock 伺服器也以它當動作允許清單。
 * 只能在尾端新增（舊客戶端收到不認得的編號會整則忽略，與它不認得動作 id 時相同）；改順序或刪除要升協定版本。
 */
export const ACTION_CODES = ['bow', 'prostrate', 'chant', 'chant_end', 'incense', 'bell'] as const
const WRAP = 2 ** 32
const HALF_WRAP = 2 ** 31

/** 動作幀解碼後、還原玩家與時間之前的內容。 */
export interface ActionFrame {
  n: number
  id: string
  /** startedAt mod 2^32。 */
  startedAtLow: number
}

/** 編碼一則動作幀。短編號不在 0～127、動作不在對照表、startedAt 不是有限的非負數時回傳 null。 */
export function encodeAction(msg: { n: number; id: string; startedAt: number }): Uint8Array | null {
  const code = (ACTION_CODES as readonly string[]).indexOf(msg.id)
  const { n, startedAt } = msg
  if (code < 0 || !Number.isInteger(n) || n < 0 || n > MAX_SHORT_ID) return null
  if (!Number.isFinite(startedAt) || startedAt < 0) return null
  const out = new Uint8Array(ACTION_FRAME_BYTES)
  const view = new DataView(out.buffer)
  out[0] = FRAME_ACTION
  out[1] = n
  out[2] = code
  view.setUint32(3, Math.floor(startedAt) % WRAP, true)
  return out
}

/** 解碼並驗證一則動作幀。幀型不是 0x03、長度不是 7、n 超過 127、動作編號不在對照表都回傳 null（整則丟棄）。 */
export function decodeAction(data: ArrayBuffer | ArrayBufferView): ActionFrame | null {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length !== ACTION_FRAME_BYTES || bytes[0] !== FRAME_ACTION) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = view.getUint8(1)
  const id: string | undefined = ACTION_CODES[view.getUint8(2)]
  if (n > MAX_SHORT_ID || id === undefined) return null
  return { n, id, startedAtLow: view.getUint32(3, true) }
}

/**
 * 由 startedAt 的低 32 位元還原絕對毫秒：取 mod 2^32 相同、且離參考時間（客戶端估計的伺服器現在時間）最近的值。
 * startedAt − reference 在 [−2^31, 2^31) 毫秒（約 ±24.8 天）內都正確；動作訊息是即時轉送的，
 * 實際差距只有轉送延遲加上時鐘估計誤差（毫秒到秒），分頁凍結數小時後才收到也仍正確。
 */
export function unwrapStartedAt(low: number, reference: number): number {
  const ref = Math.floor(reference)
  let d = (((low - (ref % WRAP)) % WRAP) + WRAP) % WRAP
  if (d >= HALF_WRAP) d -= WRAP
  return ref + d
}

// ---- cars（協定版本 6）----

export const FRAME_CARS = 0x04
export const CAR_ENTRY_BYTES = 12
export const MAX_CARS = 16
export const MAX_VEL_CM_S = 3000

/** 碰撞種類（旗標 byte 的 bit 5–6）：0 沒撞、1 建築與其他靜態物、2 樹、3 另一台車。 */
export const BUMP_NONE = 0
export const BUMP_WALL = 1
export const BUMP_TREE = 2
export const BUMP_CAR = 3
export type Bump = 0 | 1 | 2 | 3

export interface CarWireState {
  c: number
  occupied: boolean
  bump: Bump
  x: number
  z: number
  heading: number
  vx: number
  vz: number
  w: number
}

export function quantizeHeadingI16(heading: number): number {
  const scaled = roundAway((heading * 32768) / Math.PI)
  if (!Number.isFinite(scaled)) return 0
  const low16 = ((scaled % 65536) + 65536) % 65536
  return low16 >= 32768 ? low16 - 65536 : low16
}

export function dequantizeHeadingI16(q: number): number {
  return (q * Math.PI) / 32768
}

export function quantizeVel(v: number): number {
  const cm_s = roundAway(v * 100)
  if (!Number.isFinite(cm_s)) return 0
  return Math.max(-MAX_VEL_CM_S, Math.min(MAX_VEL_CM_S, cm_s)) | 0
}

export function quantizeAngvel(w: number): number {
  const scaled = roundAway(w * 16)
  if (!Number.isFinite(scaled)) return 0
  return Math.max(-127, Math.min(127, scaled)) | 0
}

/** 編碼一則 cars 幀。車輛數超過 16 或編號超出 0..15 時回傳 null。 */
export function encodeCars(ack: number, cars: readonly CarWireState[]): Uint8Array | null {
  if (cars.length > MAX_CARS) return null
  if (!Number.isInteger(ack) || ack < 0 || ack > 0xffff) return null
  const out = new Uint8Array(3 + cars.length * CAR_ENTRY_BYTES)
  const view = new DataView(out.buffer)
  out[0] = FRAME_CARS
  view.setUint16(1, ack, true)
  let o = 3
  for (const car of cars) {
    if (!Number.isInteger(car.c) || car.c < 0 || car.c >= MAX_CARS) return null
    let flag = car.c & 0x0f
    if (car.occupied) flag |= 0x10
    if (!Number.isInteger(car.bump) || car.bump < 0 || car.bump > 3) return null
    flag |= car.bump << 5
    view.setUint8(o, flag)
    view.setInt16(o + 1, quantizeCoord(car.x), true)
    view.setInt16(o + 3, quantizeCoord(car.z), true)
    view.setInt16(o + 5, quantizeHeadingI16(car.heading), true)
    view.setInt16(o + 7, quantizeVel(car.vx), true)
    view.setInt16(o + 9, quantizeVel(car.vz), true)
    view.setInt8(o + 11, quantizeAngvel(car.w))
    o += CAR_ENTRY_BYTES
  }
  return out
}

/** 解碼並驗證一則 cars 幀。格式或數值超出邊界時回傳 null。 */
export function decodeCars(data: ArrayBuffer | ArrayBufferView): { ack: number; cars: CarWireState[] } | null {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length < 3 || bytes[0] !== FRAME_CARS) return null
  const body = bytes.length - 3
  if (body % CAR_ENTRY_BYTES !== 0) return null
  const count = body / CAR_ENTRY_BYTES
  if (count > MAX_CARS) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ack = view.getUint16(1, true)
  const cars: CarWireState[] = new Array(count)
  let seenC = 0
  for (let i = 0, o = 3; i < count; i++, o += CAR_ENTRY_BYTES) {
    const flag = view.getUint8(o)
    if ((flag & 0x80) !== 0) return null
    const c = flag & 0x0f
    if ((seenC & (1 << c)) !== 0) return null
    seenC |= 1 << c
    const occupied = (flag & 0x10) !== 0
    const bump = ((flag >> 5) & 0x03) as Bump
    const x = view.getInt16(o + 1, true)
    const z = view.getInt16(o + 3, true)
    if (Math.abs(x) > MAX_COORD_CM || Math.abs(z) > MAX_COORD_CM) return null
    const heading = dequantizeHeadingI16(view.getInt16(o + 5, true))
    const vx = view.getInt16(o + 7, true)
    const vz = view.getInt16(o + 9, true)
    if (Math.abs(vx) > MAX_VEL_CM_S || Math.abs(vz) > MAX_VEL_CM_S) return null
    const w = view.getInt8(o + 11)
    cars[i] = {
      c,
      occupied,
      bump,
      x: x / 100,
      z: z / 100,
      heading,
      vx: vx / 100,
      vz: vz / 100,
      w: w / 16,
    }
  }
  return { ack, cars }
}

