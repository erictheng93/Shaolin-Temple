import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkClient, PENALTY_RECONNECT_MS } from './NetworkClient'

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 1
  bufferedAmount = 0
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send(text: string) {
    this.sent.push(JSON.parse(text))
  }
  close() {}
  // 測試輔助
  open() {
    this.onopen?.()
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  drop(code = 1006) {
    this.onclose?.({ code })
  }
}

const welcome = { t: 'welcome', selfId: 'a', room: 'r', resumeToken: 't', serverTime: 0, players: [] }
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!
const stops = (s: FakeSocket) => s.sent.filter((m) => m.t === 'stop')

let client: NetworkClient

function connectOnline(): void {
  client.connect()
  last().open()
  last().receive(welcome)
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('WebSocket', FakeSocket)
  // 退避取上限（第 n 次 = 500 × 2^n − 1 ms），讓「至少等 5 秒」與一般退避可以分辨。
  vi.spyOn(Math, 'random').mockReturnValue(0.999999)
  client = new NetworkClient({ url: 'ws://x', name: 'n' })
})

afterEach(() => {
  client.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NetworkClient 上行座標', () => {
  it('move／stop 的 x、z、heading 四捨五入到 0.01', () => {
    connectOnline()
    client.sendPosition(1.23456, -7.8951, 3.14159, true)
    vi.advanceTimersByTime(100)
    expect(last().sent.at(-1)).toMatchObject({ t: 'move', x: 1.23, z: -7.9, heading: 3.14 })
    client.sendPosition(1.006, 2.004, 0.5, false)
    vi.advanceTimersByTime(100)
    expect(last().sent.at(-1)).toMatchObject({ t: 'stop', x: 1.01, z: 2, heading: 0.5 })
  })
})

describe('NetworkClient 進入背景', () => {
  it('最後位置是移動中時，立即補送 stop（用最後已知位置）並清佇列', () => {
    connectOnline()
    client.sendPosition(1.234, 2.345, 0.5, true) // 還在佇列，尚未 flush
    client.setBackground(true)
    expect(last().sent.at(-1)).toMatchObject({ t: 'stop', x: 1.23, z: 2.35, heading: 0.5 })
    const count = last().sent.length
    vi.advanceTimersByTime(500)
    expect(last().sent.length).toBe(count) // 佇列已清，之後不再送出
  })

  it('已經停止、或從未移動時，不補送 stop', () => {
    connectOnline()
    client.setBackground(true)
    expect(stops(last())).toHaveLength(0)
    client.setBackground(false)
    client.sendPosition(1, 1, 0, true)
    client.sendPosition(1, 1, 0, false)
    client.setBackground(true)
    expect(stops(last())).toHaveLength(0) // 靜止的 stop 還在佇列被清掉，伺服器最後收到的仍是上一次 flush 的狀態
  })

  it('補送 stop 後再次進入背景不重複補送', () => {
    connectOnline()
    client.sendPosition(1, 1, 0, true)
    client.setBackground(true)
    client.setBackground(false)
    client.setBackground(true)
    expect(stops(last())).toHaveLength(1)
  })
})

describe('NetworkClient 重連', () => {
  it('退避計數在收到 welcome 才歸零，onopen 不算', () => {
    client.connect()
    last().open()
    last().drop() // 開了但沒收到 welcome：第 0 次退避，上限 499 ms
    vi.advanceTimersByTime(498)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
    last().open()
    last().drop() // 仍沒 welcome：第 1 次退避，上限 999 ms
    vi.advanceTimersByTime(998)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)
    last().open()
    last().receive(welcome) // 歸零
    last().drop()
    vi.advanceTimersByTime(498)
    expect(FakeSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(4)
  })

  it.each([1013, 1008])('close code %i 後下一次重連至少等 5 秒', (code) => {
    connectOnline()
    last().drop(code)
    vi.advanceTimersByTime(PENALTY_RECONNECT_MS - 1)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('其他 close code 仍用一般退避', () => {
    connectOnline()
    last().drop(1006)
    vi.advanceTimersByTime(499)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('unsupported_version 後不再重連（含回前景與手動 connect）', () => {
    const codes: string[] = []
    client.events.on('message', (m) => m.t === 'error' && codes.push(m.code))
    client.connect()
    last().open()
    last().receive({ t: 'error', code: 'unsupported_version', message: 'x' })
    last().drop(1000)
    vi.advanceTimersByTime(120_000)
    client.setBackground(true)
    client.setBackground(false)
    client.connect()
    expect(FakeSocket.instances).toHaveLength(1)
    expect(client.connectionStatus).toBe('closed')
    expect(codes).toEqual(['unsupported_version'])
  })

  it('其他 error 不影響重連', () => {
    client.connect()
    last().open()
    last().receive({ t: 'error', code: 'invalid_zone', message: 'x' })
    last().drop(1000)
    vi.advanceTimersByTime(499)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
