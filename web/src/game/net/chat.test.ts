import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkClient } from './NetworkClient'
import { CHAT_MAX_CHARS, ChatLimiter, decode, encode, sanitizeChat, type ServerMessage } from './protocol'

describe('聊天協定', () => {
  it('encode 上行、decode 下行並驗證欄位', () => {
    expect(JSON.parse(encode({ t: 'chat', text: '阿彌陀佛' }))).toEqual({ t: 'chat', text: '阿彌陀佛' })
    const down = { t: 'chat', id: 'p-1', text: '早安', at: 1_700_000_000_000 }
    expect(decode(JSON.stringify(down))).toEqual(down)
    expect(decode(JSON.stringify({ ...down, at: 'x' }))).toBeNull()
    expect(decode(JSON.stringify({ ...down, text: 1 }))).toBeNull()
    expect(decode(JSON.stringify({ t: 'chat', id: 'p-1', at: 1 }))).toBeNull()
    expect(decode(JSON.stringify({ ...down, text: '字'.repeat(CHAT_MAX_CHARS) }))?.t).toBe('chat')
    expect(decode(JSON.stringify({ ...down, text: 'x'.repeat(257) }))).toBeNull()
  })

  it('sanitizeChat：壓縮空白、移除控制與雙向覆寫字元、trim、截到 80 個 Unicode 字元', () => {
    const c = String.fromCharCode
    expect(sanitizeChat(`  你好 ${c(10)}${c(9)} 世界  `)).toBe('你好 世界')
    expect(sanitizeChat(`a${c(0)}b${c(7)}c`)).toBe('abc')
    // U+202E 覆寫、U+202C 結束、U+200F 標記、U+2066 隔離
    expect(sanitizeChat(`x${c(0x202e)}evil${c(0x202c)}${c(0x200f)}${c(0x2066)}y`)).toBe('xevily')
    expect(sanitizeChat(` ${c(10)}${c(0)} `)).toBe('')
    // 零寬字元與 BOM 也移除，且不會在兩個空白之間留下雙空格（與伺服器 clean_chat 一致）
    expect(sanitizeChat(`a ${c(0x200b)} b${c(0xfeff)}${c(0x200d)}c`)).toBe('a bc')
    expect(Array.from(sanitizeChat('字'.repeat(200)))).toHaveLength(CHAT_MAX_CHARS)
    // 代理對（emoji）算一個字元，不會被截成半個
    const emoji = sanitizeChat('😀'.repeat(100))
    expect(Array.from(emoji)).toHaveLength(CHAT_MAX_CHARS)
    expect(emoji.includes(c(0xfffd))).toBe(false)
    // 截斷後尾端的空白也去掉
    expect(sanitizeChat('a'.repeat(79) + ' b')).toBe('a'.repeat(79))
  })

  it('ChatLimiter：突發 3 則，之後每 2 秒補 1 則，額度最多 3', () => {
    let t = 0
    const lim = new ChatLimiter(() => t)
    expect([lim.tryTake(), lim.tryTake(), lim.tryTake(), lim.tryTake()]).toEqual([true, true, true, false])
    t = 1999
    expect(lim.tryTake()).toBe(false)
    t = 2000
    expect(lim.tryTake()).toBe(true)
    expect(lim.tryTake()).toBe(false)
    t = 100_000
    expect([lim.tryTake(), lim.tryTake(), lim.tryTake(), lim.tryTake()]).toEqual([true, true, true, false])
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
}

const welcome = { t: 'welcome', selfId: 'a', room: 'r', resumeToken: 't', serverTime: 0, auth: 'guest', players: [] }
const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1]!
const chats = () => sock().sent.filter((m) => m.t === 'chat')
let client: NetworkClient

function connectOnline(): void {
  client.connect()
  sock().onopen?.()
  sock().onmessage?.({ data: JSON.stringify(welcome) })
}

describe('NetworkClient 聊天', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.instances = []
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('WebSocket', FakeSocket)
    client = new NetworkClient({ url: 'ws://x', name: 'n' })
  })

  afterEach(() => {
    client.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('上線時送出清理後的 chat（不帶 reqId），超過突發 3 則回 rate 不送出，2 秒後補 1 則', () => {
    connectOnline()
    expect(client.sendChat('  你好   世界 ')).toBe('sent')
    expect(client.sendChat('b')).toBe('sent')
    expect(client.sendChat('c')).toBe('sent')
    expect(client.sendChat('d')).toBe('rate')
    expect(chats()).toEqual([
      { t: 'chat', text: '你好 世界' },
      { t: 'chat', text: 'b' },
      { t: 'chat', text: 'c' },
    ])
    vi.advanceTimersByTime(2000)
    expect(client.sendChat('e')).toBe('sent')
  })

  it('空訊息不送出；未連線時丟棄並回 offline', () => {
    expect(client.sendChat('hi')).toBe('offline') // 尚未 connect
    connectOnline()
    expect(client.sendChat('   ')).toBe('empty')
    sock().onclose?.({ code: 1006 })
    expect(client.sendChat('hi')).toBe('offline')
    expect(chats()).toHaveLength(0)
  })

  it('收到下行 chat 以 message 事件交給上層', () => {
    const got: ServerMessage[] = []
    client.events.on('message', (m) => got.push(m))
    connectOnline()
    sock().onmessage?.({ data: JSON.stringify({ t: 'chat', id: 'a', text: '早安', at: 5 }) })
    expect(got.at(-1)).toEqual({ t: 'chat', id: 'a', text: '早安', at: 5 })
  })
})
