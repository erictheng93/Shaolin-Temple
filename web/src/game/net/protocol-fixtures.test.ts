import fixtures from '../../../../server/tests/protocol-v5.json'
import { describe, expect, it } from 'vitest'
import {
  ACTION_CODES,
  decodeAction,
  decodeCars,
  encodeAction,
  encodeBatch,
  encodeCars,
  unwrapStartedAt,
  type BatchMessage,
} from './binaryFrame'
import { FrameContext, KIND_COUNT, PROTOCOL_VERSION, decode, encode, type ClientMessage, type DecodeContext } from './protocol'

const fromHex = (hex: string): ArrayBuffer => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out.buffer
}
const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

it('Rust 共用 v5 固定資料可由前端收發', () => {
  for (const m of fixtures.client) if (m.t === 'hello') expect(m.v).toBe(PROTOCOL_VERSION)
  for (const message of fixtures.server) expect(decode(JSON.stringify(message))).toEqual(message)
  for (const message of fixtures.client) expect(JSON.parse(encode(message as ClientMessage))).toEqual(message)
})

it('車種數量與固定資料 kindCount 相同', () => {
  expect(KIND_COUNT).toBe(fixtures.kindCount)
})

it('固定資料涵蓋 v4/v5 新增的訊息：welcome.auth 三種身份、name、rename、帶／不帶 session 的 hello、car、carGone、knock', () => {
  const auths = fixtures.server.flatMap((m) => (m.t === 'welcome' && 'auth' in m ? [m.auth] : []))
  expect(new Set(auths)).toEqual(new Set(['guest', 'google', 'line']))
  expect(fixtures.server.some((m) => m.t === 'name')).toBe(true)
  expect(fixtures.server.some((m) => m.t === 'car')).toBe(true)
  expect(fixtures.server.some((m) => m.t === 'carGone')).toBe(true)
  expect(fixtures.server.some((m) => m.t === 'knock')).toBe(true)
  expect(fixtures.client.some((m) => m.t === 'rename')).toBe(true)
  expect(fixtures.client.some((m) => m.t === 'claim')).toBe(true)
  expect(fixtures.client.some((m) => m.t === 'ride')).toBe(true)
  expect(fixtures.client.some((m) => m.t === 'drive')).toBe(true)
  const hellos = fixtures.client.filter((m) => m.t === 'hello')
  expect(hellos.some((m) => 'session' in m)).toBe(true)
  expect(hellos.some((m) => !('session' in m))).toBe(true)
})

it('invalid.server：前端 decode() 全部拒絕', () => {
  expect(fixtures.invalid.server.length).toBeGreaterThanOrEqual(8)
  for (const v of fixtures.invalid.server) expect(decode(JSON.stringify(v.message)), v.name).toBeNull()
})

describe('moves／sync 二進位幀（與 Rust 共用的測試向量）', () => {
  it('解碼結果與 decoded 完全相同', () => {
    expect(fixtures.binary.valid.length).toBeGreaterThanOrEqual(6)
    for (const v of fixtures.binary.valid) expect(decode(fromHex(v.hex)), v.name).toEqual(v.decoded)
  })

  it('mock 伺服器使用的編碼器產生相同的位元組', () => {
    for (const v of fixtures.binary.valid) expect(toHex(encodeBatch(v.input as BatchMessage)!), v.name).toBe(v.hex)
  })

  it('長度不合、未知幀型、筆數或座標超出範圍都整則拒絕', () => {
    expect(fixtures.binary.invalid.length).toBeGreaterThanOrEqual(8)
    for (const v of fixtures.binary.invalid) expect(decode(fromHex(v.hex)), v.name).toBeNull()
  })
})

describe('action 二進位幀（與 Rust 共用的測試向量）', () => {
  const { action } = fixtures.binary

  it('動作編號對照表與固定資料（= server/src/world.rs 的 ACTIONS）相同', () => {
    expect([...ACTION_CODES]).toEqual(action.codes)
  })

  it('編碼結果等於 hex，解碼結果等於 decoded', () => {
    expect(action.valid.length).toBe(action.codes.length)
    for (const v of action.valid) {
      expect(toHex(encodeAction(v.input)!), v.name).toBe(v.hex)
      expect(decodeAction(fromHex(v.hex)), v.name).toEqual(v.decoded)
    }
  })

  it('長度不符、n 超過 127、未知動作編號都整則拒絕', () => {
    expect(action.invalid.length).toBeGreaterThanOrEqual(6)
    const ctx: DecodeContext = { playerIdOf: () => 'p', serverNow: () => 0 }
    for (const v of action.invalid) {
      expect(decodeAction(fromHex(v.hex)), v.name).toBeNull()
      expect(decode(fromHex(v.hex), ctx), v.name).toBeNull()
    }
  })

  it('startedAt 由低 32 位元與參考時間還原（含回繞與範圍邊界）', () => {
    expect(action.unwrap.length).toBeGreaterThanOrEqual(8)
    for (const v of action.unwrap) expect(unwrapStartedAt(v.low, v.reference), v.name).toBe(v.startedAt)
  })

  it('decode() 以 DecodeContext 還原成與 v2 JSON 相同的形狀；沒有 ctx 或對照不到 n 時回傳 null', () => {
    for (const v of action.valid) {
      const ctx: DecodeContext = {
        playerIdOf: (n) => (n === v.input.n ? `p-${n}` : undefined),
        serverNow: () => v.input.startedAt + 80.5,
      }
      expect(decode(fromHex(v.hex), ctx), v.name).toEqual({
        t: 'action',
        playerId: `p-${v.input.n}`,
        id: v.input.id,
        startedAt: v.input.startedAt,
      })
      expect(decode(fromHex(v.hex)), v.name).toBeNull()
      expect(decode(fromHex(v.hex), { ...ctx, playerIdOf: () => undefined }), v.name).toBeNull()
    }
  })

  it('FrameContext 以 welcome／pong 的 serverTime 校正時鐘', () => {
    let now = 1000
    const ctx = new FrameContext(() => now)
    ctx.observe({ t: 'welcome', selfId: 'a', room: 'r', resumeToken: 't', serverTime: 5_000_000, players: [], cars: [], auth: 'guest' })
    now = 1500
    expect(ctx.serverNow()).toBe(5_000_500)
    ctx.observe({ t: 'pong', ts: 0, serverTime: 6_000_000 })
    now = 1600
    expect(ctx.serverNow()).toBe(6_000_100)
  })
})

describe('cars 二進位幀（與 Rust 共用的測試向量）', () => {
  const { cars } = fixtures.binary

  it('編碼結果等於 hex，解碼結果等於 decoded', () => {
    for (const v of cars.valid) {
      expect(toHex(encodeCars(v.input.ack, v.input.cars)!), v.name).toBe(v.hex)
      const decoded = decodeCars(fromHex(v.hex))
      expect(decoded, v.name).not.toBeNull()
      expect(decoded!.ack, v.name).toBe(v.decoded.ack)
      expect(decoded!.cars.length, v.name).toBe(v.decoded.cars.length)
      for (let i = 0; i < decoded!.cars.length; i++) {
        const actual = decoded!.cars[i]!
        const expected = v.decoded.cars[i]!
        expect(actual.c, v.name).toBe(expected.c)
        expect(actual.occupied, v.name).toBe(expected.occupied)
        expect(actual.bumped, v.name).toBe(expected.bumped)
        expect(actual.x, v.name).toBeCloseTo(expected.x, 2)
        expect(actual.z, v.name).toBeCloseTo(expected.z, 2)
        let d = ((actual.heading - expected.heading) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
        if (d > Math.PI) d = 2 * Math.PI - d
        expect(d, v.name).toBeLessThan(1e-4)
        expect(actual.vx, v.name).toBeCloseTo(expected.vx, 2)
        expect(actual.vz, v.name).toBeCloseTo(expected.vz, 2)
        expect(actual.w, v.name).toBeCloseTo(expected.w, 2)
      }
      expect(decode(fromHex(v.hex)), v.name).toEqual({
        t: 'cars',
        ack: v.decoded.ack,
        cars: decoded!.cars,
      })
    }
  })

  it('格式不符或超出限制回傳 null', () => {
    for (const v of cars.invalid) {
      expect(decodeCars(fromHex(v.hex)), v.name).toBeNull()
      expect(decode(fromHex(v.hex)), v.name).toBeNull()
    }
  })
})
