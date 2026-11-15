/**
 * moves／sync 的二進位幀（協定版本 2）。前端解碼、mock 伺服器編碼都用這一份實作；
 * Rust 端在 server/src/protocol.rs（encode_batch／decode_batch），兩邊以 server/tests/protocol-v2.json 的
 * binary 測試向量驗證一致。
 *
 * 這個檔案不 import 任何東西、只用可被移除的型別語法，讓 `node scripts/mock-server.mjs` 能直接載入
 * （Node 22.18 起內建 TypeScript 型別移除）。
 *
 * 幀 = 1 byte 幀型 + N 筆 × 6 bytes，N = (長度 − 1) / 6，0 ≤ N ≤ MAX_MOVES_PER_MESSAGE。整數為 little-endian。
 *
 * | 位移 | 型別 | 內容 |
 * | --- | --- | --- |
 * | 0 | u8 | bit 7：moving；bit 0～6：房內短編號 n（0～127） |
 * | 1 | i16 | x，公分（四捨五入，.5 遠離零），限 ±MAX_COORD_CM |
 * | 3 | i16 | z，公分，同上 |
 * | 5 | u8 | heading：q = round(heading × 128 / π) mod 256；解碼 (q ≤ 128 ? q : q − 256) × π / 128 ∈ (−π, π] |
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
