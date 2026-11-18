import fixtures from '../../../../server/tests/protocol-v4.json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkClient } from './NetworkClient'
import { DEFAULT_OUTFIT, normalizeOutfit } from '../world/outfits'
import { MAX_WIRE_OUTFIT, OUTFIT_COUNT, decode, encode, isOutfit, isOutfitWire, type ClientMessage, type ServerMessage } from './protocol'

const player = { id: 'p', n: 1, name: 'n', x: 0, z: 0, heading: 0 }

describe('衣裝協定', () => {
  it('OUTFIT_COUNT 與共用固定資料（Rust 同樣比對）相同', () => {
    expect(OUTFIT_COUNT).toBe(fixtures.outfitCount)
  })

  it('isOutfit（上行）只接受範圍內的整數', () => {
    for (const ok of [0, 1, OUTFIT_COUNT - 1]) expect(isOutfit(ok)).toBe(true)
    for (const bad of [-1, OUTFIT_COUNT, 1.5, NaN, Infinity, '1', null, undefined, true]) expect(isOutfit(bad)).toBe(false)
  })

  it('isOutfitWire（下行）接受 0～255 的整數，含這個版本還不認得的編號', () => {
    expect(MAX_WIRE_OUTFIT).toBe(255)
    for (const ok of [0, OUTFIT_COUNT - 1, OUTFIT_COUNT, 200, 255]) expect(isOutfitWire(ok)).toBe(true)
    for (const bad of [-1, 256, 1.5, NaN, Infinity, '1', null, undefined, true]) expect(isOutfitWire(bad)).toBe(false)
  })

  it('上行 outfit 與帶衣裝的 hello 原樣編碼', () => {
    expect(JSON.parse(encode({ t: 'outfit', outfit: 3 }))).toEqual({ t: 'outfit', outfit: 3 })
    const hello: ClientMessage = { t: 'hello', v: 4, name: 'n', outfit: 2 }
    expect(JSON.parse(encode(hello))).toEqual(hello)
  })

  it('下行 outfit：驗證 id 與型別；不認得的編號照收', () => {
    const down = { t: 'outfit', id: 'p-1', outfit: 4 }
    expect(decode(JSON.stringify(down))).toEqual(down)
    for (const outfit of [OUTFIT_COUNT, 200, 255]) expect(decode(JSON.stringify({ ...down, outfit }))).toEqual({ ...down, outfit })
    for (const outfit of [256, -1, 1.5, '2', null]) expect(decode(JSON.stringify({ ...down, outfit }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'outfit', outfit: 1 }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'outfit', id: 'p-1' }))).toBeNull()
  })

  it('welcome／join 的玩家：outfit 缺少視為合法（舊伺服器），不是 0～255 的整數則整則忽略', () => {
    const welcome = (players: unknown[]) =>
      decode(JSON.stringify({ t: 'welcome', selfId: 'p', room: 'r', resumeToken: 't', serverTime: 0, auth: 'guest', players }))
    expect(welcome([player])?.t).toBe('welcome')
    expect(welcome([{ ...player, outfit: 5 }])?.t).toBe('welcome')
    for (const outfit of [256, -1, 0.5, '1', null]) {
      expect(welcome([{ ...player, outfit }]), String(outfit)).toBeNull()
      expect(decode(JSON.stringify({ t: 'join', player: { ...player, outfit } })), String(outfit)).toBeNull()
    }
    expect(decode(JSON.stringify({ t: 'join', player: { ...player, outfit: 2 } }))?.t).toBe('join')
  })

  it('舊分頁收到新衣裝（outfit: 200）的快照：welcome 不丟、其他玩家照收，顯示為預設衣裝', () => {
    const other = { ...player, id: 'q', n: 2, outfit: 3 }
    const m = decode(
      JSON.stringify({ t: 'welcome', selfId: 'p', room: 'r', resumeToken: 't', serverTime: 0, auth: 'guest', players: [{ ...player, outfit: 200 }, other] }),
    ) as Extract<ServerMessage, { t: 'welcome' }> | null
    expect(m?.t).toBe('welcome')
    expect(m!.players.map((p) => p.outfit)).toEqual([200, 3])
    expect(m!.players.map((p) => normalizeOutfit(p.outfit))).toEqual([DEFAULT_OUTFIT, 3])
    const join = decode(JSON.stringify({ t: 'join', player: { ...player, outfit: 200 } })) as Extract<ServerMessage, { t: 'join' }> | null
    expect(normalizeOutfit(join?.player.outfit)).toBe(DEFAULT_OUTFIT)
  })
})

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 1
  bufferedAmount = 0
  binaryType = 'blob'
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
  open() {
    this.onopen?.()
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const welcome = { t: 'welcome', selfId: 'a', room: 'r', resumeToken: 't', serverTime: 0, auth: 'guest', players: [] }
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!
const outfits = (s: FakeSocket) => s.sent.filter((m) => m.t === 'outfit').map((m) => m.outfit)
const helloOf = (s: FakeSocket) => s.sent.find((m) => m.t === 'hello')!

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
  vi.spyOn(Math, 'random').mockReturnValue(0.999999)
})

afterEach(() => {
  client?.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NetworkClient.setOutfit', () => {
  it('初始衣裝放進每次 hello（含重連）；沒給就不帶', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n', outfit: 2 })
    connectOnline()
    expect(helloOf(last()).outfit).toBe(2)
    last().drop()
    vi.advanceTimersByTime(60_000)
    last().open()
    expect(helloOf(last()).outfit).toBe(2)
    client.dispose()
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    connectOnline()
    expect('outfit' in helloOf(last())).toBe(false)
  })

  it('已連線：送出 outfit；與目前相同不重送；無效編號忽略', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n', outfit: 1 })
    connectOnline()
    client.setOutfit(1)
    client.setOutfit(OUTFIT_COUNT)
    client.setOutfit(-1)
    client.setOutfit(1.5)
    expect(outfits(last())).toEqual([])
    client.setOutfit(3)
    expect(outfits(last())).toEqual([3])
    client.setOutfit(3)
    expect(outfits(last())).toEqual([3])
  })

  it('被限速擋下時合併成最新的一個，額度恢復後補送；中間的選擇不排隊', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    connectOnline()
    client.setOutfit(1)
    client.setOutfit(2)
    client.setOutfit(3)
    client.setOutfit(4) // 第 4 次：沒有額度
    client.setOutfit(5)
    client.setOutfit(1)
    expect(outfits(last())).toEqual([1, 2, 3])
    vi.advanceTimersByTime(1500)
    expect(outfits(last())).toEqual([1, 2, 3])
    vi.advanceTimersByTime(1500)
    expect(outfits(last())).toEqual([1, 2, 3, 1])
    last().receive({ t: 'outfit', id: 'a', outfit: 1 }) // 伺服器確認：不再重送
    vi.advanceTimersByTime(60_000)
    expect(outfits(last())).toEqual([1, 2, 3, 1])
  })

  it('補送前改回已送出的值：仍以最新選擇為準，不遺失', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    connectOnline()
    client.setOutfit(1)
    client.setOutfit(2)
    client.setOutfit(3)
    client.setOutfit(4)
    client.setOutfit(3) // 又改回 3：最後一次選擇是 3，伺服器上是 3，補送也無妨（伺服器相同值不廣播）
    vi.advanceTimersByTime(5000)
    expect(outfits(last()).at(-1)).toBe(3)
  })

  it('斷線時不送；重連的 hello 帶最新值，且不再補送舊的待送值', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n', outfit: 1 })
    connectOnline()
    last().drop()
    client.setOutfit(4)
    client.setOutfit(5)
    expect(outfits(last())).toEqual([])
    vi.advanceTimersByTime(60_000)
    const second = last()
    expect(second).not.toBe(FakeSocket.instances[0])
    second.open()
    expect(helloOf(second).outfit).toBe(5)
    second.receive(welcome)
    vi.advanceTimersByTime(10_000)
    expect(outfits(second)).toEqual([])
  })

  it('送出後沒有收到自己的回音：等確認時間過後重送目前的衣裝', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    connectOnline()
    client.setOutfit(2)
    expect(outfits(last())).toEqual([2])
    vi.advanceTimersByTime(2500)
    expect(outfits(last())).toEqual([2])
    vi.advanceTimersByTime(1000)
    expect(outfits(last())).toEqual([2, 2])
  })

  it('收到自己且值相同的回音即確認，不重送；其他玩家的同值回音不算', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    connectOnline()
    client.setOutfit(2)
    last().receive({ t: 'outfit', id: 'b', outfit: 2 })
    last().receive({ t: 'outfit', id: 'a', outfit: 2 })
    vi.advanceTimersByTime(60_000)
    expect(outfits(last())).toEqual([2])
  })

  it('較舊值的自己回音不改衣裝、不取消等待：仍重送最新的值；回音照樣交給 GameCore', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    const got: ServerMessage[] = []
    client.events.on('message', (m) => got.push(m))
    connectOnline()
    client.setOutfit(1)
    client.setOutfit(2)
    last().receive({ t: 'outfit', id: 'a', outfit: 1 })
    expect(got.filter((m) => m.t === 'outfit')).toEqual([{ t: 'outfit', id: 'a', outfit: 1 }])
    vi.advanceTimersByTime(3500)
    expect(outfits(last())).toEqual([1, 2, 2])
    last().receive({ t: 'outfit', id: 'a', outfit: 2 })
    vi.advanceTimersByTime(60_000)
    expect(outfits(last())).toEqual([1, 2, 2])
  })

  it('一直沒有回音：同一個值最多重送 2 次；改成別的值重新計數', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    connectOnline()
    client.setOutfit(2)
    vi.advanceTimersByTime(60_000)
    expect(outfits(last())).toEqual([2, 2, 2])
    client.setOutfit(3)
    vi.advanceTimersByTime(60_000)
    expect(outfits(last())).toEqual([2, 2, 2, 3, 3, 3])
  })

  it('等待確認時斷線：不在斷線中重送；重連的 hello 帶衣裝，之後不再重送', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    connectOnline()
    client.setOutfit(2)
    last().drop()
    vi.advanceTimersByTime(1000)
    const second = last()
    expect(second).not.toBe(FakeSocket.instances[0])
    expect(outfits(FakeSocket.instances[0]!)).toEqual([2])
    second.open()
    second.receive(welcome)
    expect(helloOf(second).outfit).toBe(2)
    vi.advanceTimersByTime(60_000)
    expect(outfits(second)).toEqual([])
  })

  it('尚未連線（沒有 socket）時只記住，hello 帶出；離線模式（沒有 url）什麼都不做', () => {
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
    client.setOutfit(2)
    vi.advanceTimersByTime(5000)
    expect(FakeSocket.instances).toHaveLength(0)
    connectOnline()
    expect(helloOf(last()).outfit).toBe(2)
    client.dispose()
    client = new NetworkClient({ url: undefined, name: 'n' })
    client.setOutfit(2)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
