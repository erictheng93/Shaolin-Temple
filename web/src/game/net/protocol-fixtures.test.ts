import fixtures from '../../../../server/tests/protocol-v1.json'
import { expect, it } from 'vitest'
import { decode, encode, type ClientMessage } from './protocol'

it('Rust 共用 v1 固定資料可由前端收發', () => {
  for (const message of fixtures.server) expect(decode(JSON.stringify(message))).toEqual(message)
  for (const message of fixtures.client) expect(JSON.parse(encode(message as ClientMessage))).toEqual(message)
})
