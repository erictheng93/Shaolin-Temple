import fixtures from '../../../../server/tests/protocol-v2.json'
import { describe, expect, it } from 'vitest'
import { encodeBatch, type BatchMessage } from './moveFrame'
import { decode, encode, type ClientMessage } from './protocol'

const fromHex = (hex: string): ArrayBuffer => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out.buffer
}
const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

it('Rust 共用 v2 固定資料可由前端收發', () => {
  for (const message of fixtures.server) expect(decode(JSON.stringify(message))).toEqual(message)
  for (const message of fixtures.client) expect(JSON.parse(encode(message as ClientMessage))).toEqual(message)
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
