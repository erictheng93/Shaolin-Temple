import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkClient, PENALTY_RECONNECT_MS } from './NetworkClient'
import { encodeAction, encodeBatch } from './binaryFrame'
import type { ServerMessage } from './protocol'

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 1
  bufferedAmount = 0
  binaryType = 'blob'
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null
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
  receiveBinary(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.slice().buffer })
  }
  drop(code = 1006) {
    this.onclose?.({ code })
  }
}

const welcome = { t: 'welcome', selfId: 'a', room: 'r', resumeToken: 't', serverTime: 0, players: [], auth: 'guest' }
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

describe('NetworkClient 下行二進位幀', () => {
  it('以 arraybuffer 接收，moves／sync 解碼後與 JSON 訊息照收到的順序交給同一個事件', () => {
    const got: ServerMessage[] = []
    client.events.on('message', (m) => got.push(m))
    connectOnline()
    expect(last().binaryType).toBe('arraybuffer')
    last().receiveBinary(encodeBatch({ t: 'moves', m: [[3, 1.5, -2, 0, 1]] })!)
    last().receive({ t: 'leave', id: 'b' })
    last().receiveBinary(encodeBatch({ t: 'sync', m: [] })!)
    last().receiveBinary(new Uint8Array([0x09])) // 未知幀型：忽略
    expect(got.map((m) => m.t)).toEqual(['welcome', 'moves', 'leave', 'sync'])
    expect(got[1]).toEqual({ t: 'moves', m: [[3, 1.5, -2, 0, 1]] })
  })
})

describe('NetworkClient resumeToken', () => {
  it('存進 sessionStorage，重新整理後的新 client 在 hello 帶上', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    connectOnline()
    expect(last().sent[0]!.resumeToken).toBeUndefined()
    client.dispose()
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    client.connect()
    last().open()
    expect(last().sent[0]).toMatchObject({ t: 'hello', resumeToken: 't' })
  })
})

describe('NetworkClient action 幀', () => {
  const T = 1_794_787_200_000
  const player = (id: string, n: number) => ({ id, n, name: id, x: 0, z: 0, heading: 0 })
  const actions = (got: ServerMessage[]) => got.filter((m) => m.t === 'action')

  function online(got: ServerMessage[]): void {
    client.events.on('message', (m) => got.push(m))
    client.connect()
    last().open()
    last().receive({ ...welcome, serverTime: T, players: [player('a', 0), player('b', 4)] })
  }

  it('以 welcome／join 的短編號還原 playerId，startedAt 還原成伺服器的絕對毫秒', () => {
    const got: ServerMessage[] = []
    online(got)
    last().receiveBinary(encodeAction({ n: 4, id: 'bell', startedAt: T - 50 })!)
    last().receive({ t: 'join', player: player('c', 9) })
    last().receiveBinary(encodeAction({ n: 9, id: 'chant', startedAt: T + 20 })!)
    expect(actions(got)).toEqual([
      { t: 'action', playerId: 'b', id: 'bell', startedAt: T - 50 },
      { t: 'action', playerId: 'c', id: 'chant', startedAt: T + 20 },
    ])
  })

  it('對照不到的 n（從未加入、或已 leave）整則忽略', () => {
    const got: ServerMessage[] = []
    online(got)
    last().receiveBinary(encodeAction({ n: 5, id: 'bow', startedAt: T })!)
    last().receive({ t: 'leave', id: 'b' })
    last().receiveBinary(encodeAction({ n: 4, id: 'bow', startedAt: T })!)
    expect(actions(got)).toEqual([])
  })

  it('同一玩家以新編號 join 時舊編號失效；編號回收給新玩家後指向新玩家', () => {
    const got: ServerMessage[] = []
    online(got)
    last().receive({ t: 'join', player: player('b', 6) })
    last().receiveBinary(encodeAction({ n: 4, id: 'bow', startedAt: T })!)
    last().receive({ t: 'join', player: player('d', 4) })
    last().receiveBinary(encodeAction({ n: 4, id: 'bow', startedAt: T })!)
    last().receiveBinary(encodeAction({ n: 6, id: 'bow', startedAt: T })!)
    expect(actions(got).map((m) => m.t === 'action' && m.playerId)).toEqual(['d', 'b'])
  })

  it('未知動作編號、長度不符、以 JSON 送來的 action 都忽略', () => {
    const got: ServerMessage[] = []
    online(got)
    const unknown = encodeAction({ n: 4, id: 'bow', startedAt: T })!
    unknown[2] = 6
    last().receiveBinary(unknown)
    last().receiveBinary(encodeAction({ n: 4, id: 'bow', startedAt: T })!.slice(0, 6))
    last().receive({ t: 'action', playerId: 'b', id: 'bow', startedAt: T })
    expect(actions(got)).toEqual([])
  })

  it('重連後的 welcome 整批重建對照', () => {
    const got: ServerMessage[] = []
    online(got)
    last().drop()
    vi.advanceTimersByTime(1000)
    last().open()
    last().receive({ ...welcome, serverTime: T, players: [player('a', 0), player('e', 4)] })
    last().receiveBinary(encodeAction({ n: 4, id: 'incense', startedAt: T })!)
    expect(actions(got)).toEqual([{ t: 'action', playerId: 'e', id: 'incense', startedAt: T }])
  })
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

describe('NetworkClient 改名', () => {
  const hellos = () => FakeSocket.instances.flatMap((s) => s.sent.filter((m) => m.t === 'hello'))

  it('連線中改名：送 rename（未送出的舊改名被蓋掉），之後重連的 hello 帶新名字', () => {
    connectOnline()
    client.setName('慧明')
    client.setName('淨塵')
    vi.advanceTimersByTime(100)
    expect(last().sent.filter((m) => m.t === 'rename')).toEqual([{ t: 'rename', name: '淨塵' }])
    last().drop()
    vi.advanceTimersByTime(1000)
    last().open()
    expect(hellos().at(-1)).toMatchObject({ t: 'hello', name: '淨塵', resumeToken: 't' })
  })

  it('斷線中改名不送 rename，重連的 hello 直接帶新名字', () => {
    connectOnline()
    last().drop()
    client.setName('悟遠')
    vi.advanceTimersByTime(1000)
    last().open()
    last().receive(welcome)
    vi.advanceTimersByTime(100)
    expect(hellos().at(-1)).toMatchObject({ name: '悟遠' })
    expect(FakeSocket.instances.flatMap((s) => s.sent).filter((m) => m.t === 'rename')).toEqual([])
  })

  it('hello 送出後、welcome 前改名：welcome 清佇列後仍補送 rename', () => {
    client.connect()
    last().open()
    client.setName('明心')
    last().receive(welcome)
    vi.advanceTimersByTime(100)
    expect(last().sent.filter((m) => m.t === 'rename')).toEqual([{ t: 'rename', name: '明心' }])
  })

  it('未連線前改名只影響 hello', () => {
    client.setName('清泉')
    connectOnline()
    vi.advanceTimersByTime(100)
    expect(hellos()).toEqual([{ t: 'hello', v: 4, name: '清泉' }])
    expect(last().sent.some((m) => m.t === 'rename')).toBe(false)
  })
})

describe('NetworkClient 登入權杖', () => {
  it('沒有權杖時 hello 不帶 session 欄位', () => {
    connectOnline()
    expect('session' in last().sent[0]!).toBe(false)
  })

  it('hello 帶 session；伺服器回 auth 與登入相同時權杖保留', () => {
    const expired = vi.fn()
    client.events.on('sessionExpired', expired)
    client.setSession('tok')
    client.connect()
    last().open()
    expect(last().sent[0]).toMatchObject({ t: 'hello', session: 'tok' })
    last().receive({ ...welcome, auth: 'google' })
    last().drop()
    vi.advanceTimersByTime(1000)
    last().open()
    expect(last().sent[0]).toMatchObject({ session: 'tok' })
    expect(expired).not.toHaveBeenCalled()
  })

  it('帶了 session 卻收到 guest：權杖失效，發出 sessionExpired，之後的 hello 不再帶 session', () => {
    const expired = vi.fn()
    client.events.on('sessionExpired', expired)
    client.setSession('tok')
    client.connect()
    last().open()
    last().receive({ ...welcome, auth: 'guest' })
    expect(expired).toHaveBeenCalledTimes(1)
    last().drop()
    vi.advanceTimersByTime(1000)
    last().open()
    expect('session' in last().sent[0]!).toBe(false)
    last().receive({ ...welcome, auth: 'guest' })
    expect(expired).toHaveBeenCalledTimes(1) // 沒帶 session 的訪客不算失效
  })

  it('建構時的 session 選項同樣生效', () => {
    client.dispose()
    client = new NetworkClient({ url: 'ws://x', name: 'n', session: 'abc' })
    client.connect()
    last().open()
    expect(last().sent[0]).toMatchObject({ session: 'abc' })
  })
})
