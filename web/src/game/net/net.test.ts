import { describe, expect, it } from 'vitest'
import { backoffDelay } from './backoff'
import { OutboundQueue } from './OutboundQueue'
import { FRAME_MOVES, FRAME_SYNC, MAX_COORD_CM, MOVE_ENTRY_BYTES, encodeBatch, quantizeCoord } from './binaryFrame'
import { MAX_MESSAGE_BYTES, decode, encode, type MoveTuple } from './protocol'

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
    expect(decode(new Uint8Array(4))).toBeNull() // 只接受 ArrayBuffer（binaryType = 'arraybuffer'）
  })

  it('批次位置：二進位幀解成與 v1 相同形狀的 tuple，JSON 的 moves／sync 不再接受', () => {
    const ok = { t: 'moves', m: [[0, 1.25, -3, 0.5, 1], [127, 0, 0, 0, 0]] } as const
    const frame = encodeBatch({ t: 'moves', m: ok.m.map((t) => [...t]) as MoveTuple[] })!
    expect(frame.byteLength).toBe(1 + 2 * MOVE_ENTRY_BYTES)
    const got = decode(frame.slice().buffer)
    expect(got).toEqual({ t: 'moves', m: [[0, 1.25, -3, 20 * (Math.PI / 128), 1], [127, 0, 0, 0, 0]] })
    // v1 的 JSON 批次位置：v2 只以二進位幀送出，收到 JSON 版代表伺服器版本不對，整則忽略
    expect(decode(JSON.stringify(ok))).toBeNull()
    expect(decode(JSON.stringify({ t: 'sync', m: [] }))).toBeNull()
  })

  it('二進位幀：長度不合、未知幀型、筆數超過上限、座標超出 ±100 公尺都整則拒絕', () => {
    const entry = (n: number, xCm: number, zCm: number): number[] => [n, xCm & 0xff, (xCm >> 8) & 0xff, zCm & 0xff, (zCm >> 8) & 0xff, 0]
    const frame = (kind: number, ...entries: number[][]): ArrayBuffer => new Uint8Array([kind, ...entries.flat()]).buffer
    expect(decode(frame(FRAME_SYNC))).toEqual({ t: 'sync', m: [] })
    expect(decode(frame(FRAME_MOVES, entry(1, MAX_COORD_CM, -MAX_COORD_CM)))).toEqual({ t: 'moves', m: [[1, 100, -100, 0, 0]] })
    expect(decode(new ArrayBuffer(0))).toBeNull()
    expect(decode(frame(0x04, entry(1, 0, 0)))).toBeNull()
    expect(decode(frame(0x00))).toBeNull()
    expect(decode(frame(FRAME_MOVES, entry(1, 0, 0)).slice(0, 6))).toBeNull()
    expect(decode(frame(FRAME_MOVES, entry(1, 0, 0), [0]))).toBeNull()
    expect(decode(frame(FRAME_MOVES, entry(1, MAX_COORD_CM + 1, 0)))).toBeNull()
    expect(decode(frame(FRAME_MOVES, entry(1, 0, -MAX_COORD_CM - 1)))).toBeNull()
    expect(decode(frame(FRAME_SYNC, ...Array.from({ length: 200 }, () => entry(1, 0, 0))))).not.toBeNull()
    expect(decode(frame(FRAME_SYNC, ...Array.from({ length: 201 }, () => entry(1, 0, 0))))).toBeNull()
    expect(decode(new ArrayBuffer(MAX_MESSAGE_BYTES + 1))).toBeNull()
  })

  it('量化：座標精度 0.01 公尺（.5 遠離零），heading 一格 2π/256 且解回 (−π, π]', () => {
    const round = (x: number, h: number) => decode(encodeBatch({ t: 'moves', m: [[0, x, -x, h, 0]] })!.slice().buffer)!
    for (const x of [0, 0.01, -0.01, 1.23, -18.99, 19, -19, 7.4, 8.6]) {
      const m = round(x, 0) as { m: MoveTuple[] }
      expect(m.m[0]![1]).toBe(x)
      expect(m.m[0]![2]).toBe(-x + 0)
    }
    expect(quantizeCoord(-0.125)).toBe(-13)
    expect(quantizeCoord(0.125)).toBe(13)
    for (const h of [0, 0.5, -0.5, 3, -3, Math.PI, -Math.PI, 6.0]) {
      const got = (round(0, h) as { m: MoveTuple[] }).m[0]![3]
      const wrapped = Math.atan2(Math.sin(h), Math.cos(h))
      expect(Math.abs(Math.atan2(Math.sin(got - wrapped), Math.cos(got - wrapped)))).toBeLessThanOrEqual(Math.PI / 256 + 1e-12)
      expect(got).toBeGreaterThan(-Math.PI)
      expect(got).toBeLessThanOrEqual(Math.PI)
    }
  })

  it('編碼端拒絕放不進幀的值', () => {
    expect(encodeBatch({ t: 'moves', m: [[128, 0, 0, 0, 0]] })).toBeNull()
    expect(encodeBatch({ t: 'moves', m: [[-1, 0, 0, 0, 0]] })).toBeNull()
    expect(encodeBatch({ t: 'moves', m: Array.from({ length: 201 }, () => [0, 0, 0, 0, 0] as MoveTuple) })).toBeNull()
  })

  it('短編號必須是 0～127 的整數', () => {
    for (const bad of ['a', -1, 128, 65535, 1.5, null]) {
      expect(decode(JSON.stringify({ t: 'join', player: { id: 'a', n: bad, name: 'n', x: 0, z: 0, heading: 0 } }))).toBeNull()
    }
    expect(decode(JSON.stringify({ t: 'join', player: { id: 'a', n: 127, name: 'n', x: 0, z: 0, heading: 0 } }))).not.toBeNull()
    expect(decode(JSON.stringify({ t: 'join', player: { id: 'a', name: 'n', x: 0, z: 0, heading: 0 } }))).toBeNull()
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
    const base = { t: 'welcome', selfId: 'a', room: 'r', resumeToken: 't', serverTime: 0, auth: 'guest' }
    expect(decode(JSON.stringify({ ...base, players: [ok] }))).not.toBeNull()
    expect(decode(JSON.stringify({ ...base, players: [ok, { ...ok, x: null }] }))).toBeNull()
  })

  it('welcome.auth 必填，只接受 guest／google／line', () => {
    const base = { t: 'welcome', selfId: 'a', room: 'r', resumeToken: 't', serverTime: 0, players: [] }
    for (const auth of ['guest', 'google', 'line']) expect(decode(JSON.stringify({ ...base, auth }))).toEqual({ ...base, auth })
    expect(decode(JSON.stringify(base))).toBeNull()
    for (const auth of ['admin', 'Google', '', null, 1, ['guest']]) expect(decode(JSON.stringify({ ...base, auth })), String(auth)).toBeNull()
  })

  it('name：id 與 name 都要是字串', () => {
    const ok = { t: 'name', id: 'a', name: '慧明' }
    expect(decode(JSON.stringify(ok))).toEqual(ok)
    expect(decode(JSON.stringify({ t: 'name', id: 'a' }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'name', name: 'x' }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'name', id: 1, name: 'x' }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'name', id: 'a', name: null }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'name', id: 'a', name: 'x'.repeat(257) }))).toBeNull()
  })
})

describe('encode', () => {
  it('rename', () => {
    expect(JSON.parse(encode({ t: 'rename', name: '淨塵' }))).toEqual({ t: 'rename', name: '淨塵' })
  })

  it('hello 帶 session 時才有這個欄位', () => {
    expect(JSON.parse(encode({ t: 'hello', v: 4, name: 'n', session: 's' }))).toEqual({ t: 'hello', v: 4, name: 'n', session: 's' })
    const without = JSON.parse(encode({ t: 'hello', v: 4, name: 'n', resumeToken: undefined, session: undefined }))
    expect(without).toEqual({ t: 'hello', v: 4, name: 'n' })
    expect('session' in without).toBe(false)
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

  it('改名只保留最新一筆（可取代），不影響位置與其他訊息', () => {
    const q = new OutboundQueue()
    q.push({ t: 'rename', name: 'a' })
    q.push({ t: 'move', x: 1, z: 0, heading: 0, seq: 1 })
    q.push({ t: 'rename', name: 'b' })
    q.push({ t: 'ping', ts: 1 })
    expect(q.drain()).toEqual([
      { t: 'move', x: 1, z: 0, heading: 0, seq: 1 },
      { t: 'rename', name: 'b' },
      { t: 'ping', ts: 1 },
    ])
  })

  it('超過上限丟棄最舊的', () => {
    const q = new OutboundQueue(2)
    for (let i = 0; i < 5; i++) q.push({ t: 'ping', ts: i })
    expect(q.drain()).toEqual([{ t: 'ping', ts: 3 }, { t: 'ping', ts: 4 }])
  })
})
