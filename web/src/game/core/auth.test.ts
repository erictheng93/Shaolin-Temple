import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_MAX_BYTES,
  clearAuth,
  consumeAuthRedirect,
  fetchProviders,
  httpBaseFromWs,
  loadAuth,
  loginUrl,
  markLoginPending,
  parseAuthFragment,
  saveAuth,
} from './auth'

describe('parseAuthFragment', () => {
  it('解析登入成功的 session 與 provider（含或不含 #）', () => {
    expect(parseAuthFragment('#session=abc.def&provider=google')).toEqual({
      kind: 'session',
      auth: { session: 'abc.def', provider: 'google' },
    })
    expect(parseAuthFragment('provider=line&session=x%2By')).toEqual({ kind: 'session', auth: { session: 'x+y', provider: 'line' } })
  })

  it('auth_error：cancelled 之外一律視為 failed', () => {
    expect(parseAuthFragment('#auth_error=cancelled')).toEqual({ kind: 'error', error: 'cancelled' })
    expect(parseAuthFragment('#auth_error=failed')).toEqual({ kind: 'error', error: 'failed' })
    expect(parseAuthFragment('#auth_error=whatever')).toEqual({ kind: 'error', error: 'failed' })
  })

  it('不是登入結果時回傳 null；session 格式不符當成失敗', () => {
    expect(parseAuthFragment('')).toBeNull()
    expect(parseAuthFragment('#')).toBeNull()
    expect(parseAuthFragment('#foo=bar')).toBeNull()
    expect(parseAuthFragment('#session=a&provider=facebook')).toEqual({ kind: 'error', error: 'failed' })
    expect(parseAuthFragment('#session=&provider=google')).toEqual({ kind: 'error', error: 'failed' })
    expect(parseAuthFragment(`#session=${'a'.repeat(SESSION_MAX_BYTES + 1)}&provider=google`)).toEqual({ kind: 'error', error: 'failed' })
    expect(parseAuthFragment(`#session=${'a'.repeat(SESSION_MAX_BYTES)}&provider=google`)?.kind).toBe('session')
  })
})

describe('httpBaseFromWs', () => {
  it.each([
    ['wss://host/ws', 'https://host'],
    ['ws://localhost:8080/ws', 'http://localhost:8080'],
    ['ws://localhost:8080/ws/', 'http://localhost:8080'],
    ['wss://example.com/', 'https://example.com'],
    ['wss://example.com', 'https://example.com'],
    ['wss://example.com/game/ws', 'https://example.com/game'],
    ['wss://example.com/wsx', 'https://example.com/wsx'],
  ])('%s → %s', (ws, http) => expect(httpBaseFromWs(ws)).toBe(http))

  it('未設定、無效或不是 ws 協定時回傳 null', () => {
    expect(httpBaseFromWs(undefined)).toBeNull()
    expect(httpBaseFromWs('')).toBeNull()
    expect(httpBaseFromWs('not a url')).toBeNull()
    expect(httpBaseFromWs('https://host/ws')).toBeNull()
  })
})

it('loginUrl 編碼 origin', () => {
  expect(loginUrl('https://host', 'line', 'http://localhost:5173')).toBe(
    'https://host/auth/line/start?origin=http%3A%2F%2Flocalhost%3A5173',
  )
})

describe('fetchProviders', () => {
  const ok = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

  it('只回傳已知的提供者，順序固定', async () => {
    expect(await fetchProviders('https://h', 3000, ok({ providers: ['line', 'x', 'google'] }))).toEqual(['google', 'line'])
    expect(await fetchProviders('https://h', 3000, ok({ providers: [] }))).toEqual([])
  })

  it('沒有基底、HTTP 錯誤、格式不符、網路錯誤都回傳空陣列', async () => {
    expect(await fetchProviders(null)).toEqual([])
    expect(await fetchProviders('https://h', 3000, (async () => ({ ok: false })) as unknown as typeof fetch)).toEqual([])
    expect(await fetchProviders('https://h', 3000, ok({ nope: 1 }))).toEqual([])
    expect(await fetchProviders('https://h', 3000, ok(null))).toEqual([])
    expect(await fetchProviders('https://h', 3000, (async () => Promise.reject(new Error('x'))) as typeof fetch)).toEqual([])
  })

  it('逾時即中止並回傳空陣列', async () => {
    vi.useFakeTimers()
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
    const p = fetchProviders('https://h', 3000, hang)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await p).toEqual([])
    vi.useRealTimers()
  })

  it('主執行緒卡住的時間不算進逾時：卡住 10 秒後回應仍會被收下', async () => {
    vi.useFakeTimers()
    let respond!: (v: unknown) => void
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((resolve, reject) => {
        respond = resolve
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const p = fetchProviders('https://h', 3000, slow)
    await vi.advanceTimersByTimeAsync(1000)
    vi.setSystemTime(Date.now() + 10_000) // 主執行緒卡了 10 秒（計時器沒機會跑）
    await vi.advanceTimersByTimeAsync(250) // 卡住後第一格只算 500 ms
    respond({ ok: true, json: async () => ({ providers: ['google'] }) })
    expect(await p).toEqual(['google'])
    vi.useRealTimers()
  })
})

describe('本機權杖', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('存、讀、清', () => {
    expect(loadAuth()).toBeNull()
    saveAuth({ session: 's', provider: 'google' })
    expect(loadAuth()).toEqual({ session: 's', provider: 'google' })
    clearAuth()
    expect(loadAuth()).toBeNull()
  })

  it('壞資料或 localStorage 丟例外時視為未登入', () => {
    store.set('shaolin-temple:auth:v1', '{"session":1,"provider":"google"}')
    expect(loadAuth()).toBeNull()
    store.set('shaolin-temple:auth:v1', 'not json')
    expect(loadAuth()).toBeNull()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    expect(loadAuth()).toBeNull()
    expect(() => saveAuth({ session: 's', provider: 'line' })).not.toThrow()
    expect(() => clearAuth()).not.toThrow()
  })

  describe('consumeAuthRedirect（只採用這個分頁自己發起的登入）', () => {
    let session: Map<string, string>
    const stubSession = () =>
      vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => session.get(k) ?? null,
        setItem: (k: string, v: string) => session.set(k, v),
        removeItem: (k: string) => session.delete(k),
      })
    beforeEach(() => {
      session = new Map()
      stubSession()
    })
    const loc = (hash: string) => ({ hash, pathname: '/app/', search: '?q=1' })
    const run = (hash: string) => {
      const replaceState = vi.fn()
      return { result: consumeAuthRedirect(loc(hash), { replaceState, state: null }), replaceState }
    }

    it('有旗標＋合法 fragment：保存權杖、清 fragment、清旗標', () => {
      expect(markLoginPending()).toBe(true)
      const { result, replaceState } = run('#session=tok&provider=line')
      expect(result).toEqual({ kind: 'session', auth: { session: 'tok', provider: 'line' } })
      expect(replaceState).toHaveBeenCalledWith(null, '', '/app/?q=1')
      expect(loadAuth()).toEqual({ session: 'tok', provider: 'line' })
      expect(session.size).toBe(0)
    })

    it('沒有旗標＋合法 fragment（別人傳來的連結）：不保存、既有權杖不變、fragment 仍被清掉、回傳 null', () => {
      saveAuth({ session: 'mine', provider: 'google' })
      const { result, replaceState } = run('#session=attacker&provider=line')
      expect(result).toBeNull()
      expect(replaceState).toHaveBeenCalledTimes(1)
      expect(loadAuth()).toEqual({ session: 'mine', provider: 'google' })
    })

    it('旗標只能用一次；沒有登入結果的啟動也會消耗旗標', () => {
      markLoginPending()
      expect(run('#session=a&provider=google').result?.kind).toBe('session')
      expect(run('#session=b&provider=line').result).toBeNull()
      expect(loadAuth()).toEqual({ session: 'a', provider: 'google' })
      markLoginPending()
      expect(run('').result).toBeNull() // 例如從登入頁按上一頁回來
      expect(run('#session=c&provider=line').result).toBeNull()
      expect(loadAuth()?.session).toBe('a')
    })

    it('auth_error：有旗標才回傳（提示），沒有旗標不回傳；兩者都清 fragment、都不保存', () => {
      markLoginPending()
      const withFlag = run('#auth_error=cancelled')
      expect(withFlag.result).toEqual({ kind: 'error', error: 'cancelled' })
      expect(withFlag.replaceState).toHaveBeenCalledTimes(1)
      const without = run('#auth_error=failed')
      expect(without.result).toBeNull()
      expect(without.replaceState).toHaveBeenCalledTimes(1)
      expect(loadAuth()).toBeNull()
    })

    it('沒有登入結果時不動網址', () => {
      const { result, replaceState } = run('#other')
      expect(result).toBeNull()
      expect(replaceState).not.toHaveBeenCalled()
    })

    it('sessionStorage 丟例外：markLoginPending 回傳 false（不導向），導回的 session 也不保存，fragment 照樣清掉', () => {
      const boom = () => {
        throw new Error('blocked')
      }
      vi.stubGlobal('sessionStorage', { getItem: boom, setItem: boom, removeItem: boom })
      expect(markLoginPending()).toBe(false)
      const { result, replaceState } = run('#session=tok&provider=google')
      expect(result).toBeNull()
      expect(replaceState).toHaveBeenCalledTimes(1)
      expect(loadAuth()).toBeNull()
    })
  })
})
