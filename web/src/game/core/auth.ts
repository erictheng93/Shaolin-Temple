/**
 * 登入的本機狀態：解析伺服器導回時的網址 fragment、保存權杖、推導 HTTP 基底、取得可用的登入方式。
 *
 * 流程：入寺畫面整頁導向 <base>/auth/<provider>/start?origin=<origin>；伺服器完成後導回
 * <origin>/#session=<權杖>&provider=<provider>（失敗為 #auth_error=cancelled|failed）。
 * 前端啟動時 consumeAuthRedirect() 存下權杖並立刻把 fragment 從網址清掉；權杖只放在 hello.session。
 * 登入只用來識別玩家，不取得姓名、頭像或電子郵件；顯示的名字一律是玩家自己選的法號。
 * 權杖不可寫進 console 或提示訊息。
 */

export const AUTH_PROVIDERS = ['google', 'line'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]
/** 伺服器在 welcome.auth 回報的身份。 */
export type AuthKind = 'guest' | AuthProvider

export interface StoredAuth {
  session: string
  provider: AuthProvider
}

export type AuthRedirect = { kind: 'session'; auth: StoredAuth } | { kind: 'error'; error: 'cancelled' | 'failed' }

/** hello.session 的上限（UTF-8 bytes，與伺服器一致）。 */
export const SESSION_MAX_BYTES = 512
const KEY = 'shaolin-temple:auth:v1'
export const PROVIDER_LABELS: Record<AuthProvider, string> = { google: 'Google', line: 'LINE' }

export const isAuthProvider = (v: unknown): v is AuthProvider =>
  typeof v === 'string' && (AUTH_PROVIDERS as readonly string[]).includes(v)

const isValidSession = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && new TextEncoder().encode(v).length <= SESSION_MAX_BYTES

/** 解析導回的 fragment（含或不含開頭的 #）。不是登入結果時回傳 null。 */
export function parseAuthFragment(hash: string): AuthRedirect | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const error = params.get('auth_error')
  if (error !== null) return { kind: 'error', error: error === 'cancelled' ? 'cancelled' : 'failed' }
  const session = params.get('session')
  const provider = params.get('provider')
  if (session === null) return null
  // 帶了 session 卻不合格式：當成登入失敗，不保存
  if (!isValidSession(session) || !isAuthProvider(provider)) return { kind: 'error', error: 'failed' }
  return { kind: 'session', auth: { session, provider } }
}

/**
 * 由 VITE_WS_URL 推導伺服器的 HTTP 基底：ws→http、wss→https、去掉結尾的 /ws 路徑與斜線。
 * 例：wss://host/ws → https://host；ws://localhost:8080/ws → http://localhost:8080。無效網址回傳 null。
 */
export function httpBaseFromWs(wsUrl: string | undefined): string | null {
  if (!wsUrl) return null
  let url: URL
  try {
    url = new URL(wsUrl)
  } catch {
    return null
  }
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : null
  if (!protocol) return null
  const path = url.pathname.replace(/\/+$/, '').replace(/\/ws$/, '').replace(/\/+$/, '')
  return `${protocol}//${url.host}${path}`
}

/** 整頁導向的登入網址。 */
export function loginUrl(base: string, provider: AuthProvider, origin: string): string {
  return `${base}/auth/${provider}/start?origin=${encodeURIComponent(origin)}`
}

/** 取得伺服器可用的登入方式；逾時、失敗或格式不符都回傳空陣列（只顯示訪客流程，不顯示錯誤）。 */
export async function fetchProviders(
  base: string | null,
  timeoutMs = 3000,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<AuthProvider[]> {
  if (!base) return []
  const ctrl = new AbortController()
  // 逾時只計「主執行緒有在跑」的時間：入寺畫面掛載的同時會建立 3D 場景（編譯 shader 可能卡住主執行緒好幾秒），
  // 單純的 setTimeout 會在卡住後立刻逾時，把其實早已回來的回應丟掉。每一格最多算 TICK_MAX_MS。
  const TICK_MS = 250
  const TICK_MAX_MS = 500
  let spent = 0
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    spent += Math.min(now - last, TICK_MAX_MS)
    last = now
    if (spent >= timeoutMs) ctrl.abort()
  }, TICK_MS)
  try {
    const res = await fetchImpl(`${base}/auth/providers`, { signal: ctrl.signal, credentials: 'omit' })
    if (!res.ok) return []
    const body: unknown = await res.json()
    const list = (body as { providers?: unknown } | null)?.providers
    if (!Array.isArray(list)) return []
    return AUTH_PROVIDERS.filter((p) => list.includes(p))
  } catch {
    return []
  } finally {
    clearInterval(timer)
  }
}

export function loadAuth(): StoredAuth | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Partial<StoredAuth>
    return isValidSession(r.session) && isAuthProvider(r.provider) ? { session: r.session, provider: r.provider } : null
  } catch {
    return null
  }
}

export function saveAuth(auth: StoredAuth): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(auth))
  } catch {
    // 儲存失敗：這次仍可用，下次要重新登入。
  }
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 忽略
  }
}

/** 「這個分頁剛發起登入」的旗標（sessionStorage：同分頁整頁導向會保留，別的分頁或別人傳來的連結沒有）。 */
const PENDING_KEY = 'shaolin-temple:auth-pending:v1'

/**
 * 導向登入前呼叫：寫入旗標。sessionStorage 不可用時回傳 false，呼叫端不要導向
 * （回來時無法證明是自己發起的登入，權杖不會被保存）。
 */
export function markLoginPending(): boolean {
  try {
    sessionStorage.setItem(PENDING_KEY, '1')
    return sessionStorage.getItem(PENDING_KEY) === '1'
  } catch {
    return false
  }
}

/** 取出並刪除旗標（只能用一次）。 */
function takeLoginPending(): boolean {
  try {
    const pending = sessionStorage.getItem(PENDING_KEY) === '1'
    sessionStorage.removeItem(PENDING_KEY)
    return pending
  } catch {
    return false
  }
}

/**
 * 啟動時呼叫一次：網址帶著登入結果時，一律立刻以 replaceState 把 fragment 從網址清掉（不留在瀏覽紀錄與分享的網址中）。
 * 只有這個分頁剛以 markLoginPending() 發起登入時才採用結果（保存權杖、回傳結果讓呼叫端提示）；
 * 沒有旗標的 #session= 是別人傳來的連結（login CSRF：把受害者登入成攻擊者的帳號），不保存、不覆蓋既有權杖、
 * 也不提示，回傳 null。旗標每次啟動都會被取出刪除，只能用一次。
 */
export function consumeAuthRedirect(
  loc: Pick<Location, 'hash' | 'pathname' | 'search'> = location,
  hist: Pick<History, 'replaceState' | 'state'> = history,
): AuthRedirect | null {
  const pending = takeLoginPending()
  const result = parseAuthFragment(loc.hash)
  if (!result) return null
  try {
    hist.replaceState(hist.state, '', loc.pathname + loc.search)
  } catch {
    // 忽略
  }
  if (!pending) return null
  if (result.kind === 'session') saveAuth(result.auth)
  return result
}
