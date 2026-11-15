import { describe, expect, it } from 'vitest'
import { backoffDelay } from './backoff'
import { OutboundQueue } from './OutboundQueue'
import { MAX_MESSAGE_BYTES, decode } from './protocol'

describe('decode', () => {
  it('接受合法訊息', () => {
    const m = decode(JSON.stringify({ t: 'move', id: 'a', x: 1, z: 2, heading: 0, moving: true }))
    expect(m).toEqual({ t: 'move', id: 'a', x: 1, z: 2, heading: 0, moving: true })
  })

  it('拒絕格式錯誤、未知類型、非有限數值與過大訊息', () => {
    expect(decode('not json')).toBeNull()
    expect(decode(JSON.stringify({ t: 'nope' }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'move', id: 'a', x: 'x', z: 0, heading: 0, moving: true }))).toBeNull()
    expect(decode('{"t":"pong","ts":1e999,"serverTime":0}')).toBeNull()
    expect(decode(JSON.stringify({ t: 'error', code: 'x', message: 'y'.repeat(MAX_MESSAGE_BYTES) }))).toBeNull()
    expect(decode(new ArrayBuffer(4))).toBeNull()
  })

  it('批次位置：合法時接受，任一筆格式錯誤或超過上限就整則拒絕', () => {
    const ok = { t: 'moves', m: [[0, 1.25, -3, 0.5, 1], [65535, 0, 0, 0, 0]] }
    expect(decode(JSON.stringify(ok))).toEqual(ok)
    expect(decode(JSON.stringify({ t: 'moves', m: [[1, 1, 2, 3, 2]] }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'moves', m: [[1, 1, 2, 3]] }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'moves', m: Array(201).fill([1, 0, 0, 0, 0]) }))).toBeNull()
  })

  it('短編號必須是 0～65535 的整數，字串 id 不再被接受', () => {
    for (const bad of ['a', -1, 65536, 1.5, null]) {
      expect(decode(JSON.stringify({ t: 'moves', m: [[bad, 0, 0, 0, 0]] }))).toBeNull()
      expect(decode(JSON.stringify({ t: 'join', player: { id: 'a', n: bad, name: 'n', x: 0, z: 0, heading: 0 } }))).toBeNull()
    }
    expect(decode(JSON.stringify({ t: 'join', player: { id: 'a', name: 'n', x: 0, z: 0, heading: 0 } }))).toBeNull()
  })

  it('sync：格式同 moves，筆數上限相同', () => {
    const ok = { t: 'sync', m: [[3, 1, 2, 0.5, 1], [4, 0, 0, 0, 0]] }
    expect(decode(JSON.stringify(ok))).toEqual(ok)
    expect(decode(JSON.stringify({ t: 'sync', m: [['a', 1, 2, 3, 1]] }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'sync', m: [[1, 1, 2, 3, 2]] }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'sync', m: Array(200).fill([1, 0, 0, 0, 0]) }))).not.toBeNull()
    expect(decode(JSON.stringify({ t: 'sync', m: Array(201).fill([1, 0, 0, 0, 0]) }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'sync' }))).toBeNull()
  })

  it('場景切換訊息與快照中的 zone 欄位', () => {
    const z = { t: 'zone', id: 'a', zone: 'hall', x: 0, z: 7.4, heading: 3.14 }
    expect(decode(JSON.stringify(z))).toEqual(z)
    expect(decode(JSON.stringify({ ...z, zone: 5 }))).toBeNull()
    const join = { t: 'join', player: { id: 'a', n: 2, name: 'n', x: 0, z: 0, heading: 0, zone: 'hall' } }
    expect(decode(JSON.stringify(join))).toEqual(join)
    expect(decode(JSON.stringify({ t: 'join', player: { ...join.player, zone: 1 } }))).toBeNull()
  })

  it('welcome 內任一玩家不合法就整則拒絕', () => {
    const ok = { id: 'a', n: 0, name: 'n', x: 0, z: 0, heading: 0 }
    const base = { t: 'welcome', selfId: 'a', room: 'r', resumeToken: 't', serverTime: 0 }
    expect(decode(JSON.stringify({ ...base, players: [ok] }))).not.toBeNull()
    expect(decode(JSON.stringify({ ...base, players: [ok, { ...ok, x: null }] }))).toBeNull()
  })
})

describe('backoffDelay', () => {
  it('隨次數成長並受上限限制', () => {
    const max = () => 0.999999
    expect(backoffDelay(0, 500, 30_000, max)).toBe(499)
    expect(backoffDelay(3, 500, 30_000, max)).toBe(3999)
    expect(backoffDelay(20, 500, 30_000, max)).toBe(29_999)
    expect(backoffDelay(5, 500, 30_000, () => 0)).toBe(0)
  })
})

describe('OutboundQueue', () => {
  it('位置只保留最新一筆，其他訊息依序保留', () => {
    const q = new OutboundQueue()
    q.push({ t: 'move', x: 1, z: 0, heading: 0, seq: 1 })
    q.push({ t: 'action', reqId: 'r1', id: 'bow' })
    q.push({ t: 'move', x: 2, z: 0, heading: 0, seq: 2 })
    q.push({ t: 'stop', x: 3, z: 0, heading: 0, seq: 3 })
    expect(q.drain()).toEqual([
      { t: 'action', reqId: 'r1', id: 'bow' },
      { t: 'stop', x: 3, z: 0, heading: 0, seq: 3 },
    ])
    expect(q.size).toBe(0)
  })

  it('超過上限丟棄最舊的', () => {
    const q = new OutboundQueue(2)
    for (let i = 0; i < 5; i++) q.push({ t: 'ping', ts: i })
    expect(q.drain()).toEqual([{ t: 'ping', ts: 3 }, { t: 'ping', ts: 4 }])
  })
})
