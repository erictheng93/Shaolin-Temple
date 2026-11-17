import { Emitter } from '../core/Emitter'
import { backoffDelay } from './backoff'
import { OutboundQueue } from './OutboundQueue'
import {
  ChatLimiter,
  FrameContext,
  MAX_MESSAGE_BYTES,
  isOutfit,
  PROTOCOL_VERSION,
  decode,
  encode,
  sanitizeChat,
  type ClientMessage,
  type ServerMessage,
} from './protocol'

/** 伺服器因過載（1013）或違規（1008）關閉連線後，下一次重連至少等待的毫秒數。 */
export const PENALTY_RECONNECT_MS = 5000
const PENALTY_CLOSE_CODES = [1013, 1008]
/** 位置座標與面向的上行精度（0.01）。 */
/** 衣裝限速的補充間隔（毫秒）：伺服器是每 2 秒補 1 個額度。 */
const OUTFIT_REFILL_MS = 2200
/** 被限速擋下的衣裝，每隔這段時間檢查一次額度。 */
const OUTFIT_RETRY_MS = 250
const round2 = (v: number): number => Math.round(v * 100) / 100
/**
 * resumeToken 存在 sessionStorage：重新整理後的新頁面以它接回原本的玩家，
 * 否則舊的自己會在斷線保留期內留在原地。讀寫失敗（隱私模式、測試環境）就當作沒有。
 */
const RESUME_KEY = 'temple.resumeToken'
function loadResumeToken(): string | undefined {
  try {
    return sessionStorage.getItem(RESUME_KEY) ?? undefined
  } catch {
    return undefined
  }
}
function saveResumeToken(token: string): void {
  try {
    sessionStorage.setItem(RESUME_KEY, token)
  } catch {
    // 存不了就只是重新整理後當成新玩家。
  }
}

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'reconnecting' | 'closed'

interface NetworkEvents extends Record<string, unknown> {
  status: ConnectionStatus
  message: ServerMessage
  rtt: number
}

export interface NetworkOptions {
  url: string | undefined
  name: string
  /** 初始衣裝（0..OUTFIT_COUNT-1）；每次 hello 都帶。未給時 hello 不帶，伺服器當作 0（恢復連線時沿用保存的）。 */
  outfit?: number
  /** 位置訊息送出頻率，與渲染頻率分開。 */
  sendHz?: number
  heartbeatMs?: number
  ackTimeoutMs?: number
  /** WebSocket 尚未送出的資料超過此值時暫緩送出，避免弱網路下越積越多。 */
  maxBufferedBytes?: number
}

interface PendingAck {
  msg: Extract<ClientMessage, { t: 'action' }>
  resolve: (ok: boolean, reason?: string) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * WebSocket 連線管理：重連、心跳、送出節流、需確認操作的重送。
 * 未設定 url 時維持 offline，遊戲以單機模式運作。
 */
export class NetworkClient {
  readonly events = new Emitter<NetworkEvents>()
  private ws: WebSocket | null = null
  private status: ConnectionStatus = 'offline'
  private queue = new OutboundQueue()
  /** action 幀的 n → 玩家 id 與伺服器時鐘，由收到的 welcome／join／leave／pong 維護。 */
  private frames = new FrameContext()
  private chatLimiter = new ChatLimiter()
  /**
   * 更換衣裝的限速：規則同聊天（突發 3），補充間隔多留 10% 餘裕，避免與伺服器的計時差讓最後一次選擇被伺服器丟掉。
   */
  private outfitLimiter = new ChatLimiter(() => performance.now(), 3, OUTFIT_REFILL_MS)
  private outfit: number | undefined
  /** 目前的衣裝還沒送給伺服器（被限速擋下或尚未連線）：只留最新的一個值，額度恢復後補送。 */
  private outfitPending = false
  private outfitTimer: ReturnType<typeof setTimeout> | null = null
  private pending = new Map<string, PendingAck>()
  private attempt = 0
  private seq = 0
  private reqCounter = 0
  private resumeToken = loadResumeToken()
  private background = false
  /** 收到 unsupported_version：版本不符，重連也不會成功，不再重連。 */
  private versionRejected = false
  /** 最後一次排入佇列的位置，進入背景時據此判斷要不要補送 stop。 */
  private lastPos: { x: number; z: number; heading: number; moving: boolean } | null = null
  private disposed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly opts: Required<Omit<NetworkOptions, 'url' | 'outfit'>> & { url: string | undefined }

  constructor(options: NetworkOptions) {
    this.opts = {
      sendHz: 10,
      heartbeatMs: 20_000,
      ackTimeoutMs: 10_000,
      maxBufferedBytes: 64 * 1024,
      ...options,
    }
    if (isOutfit(options.outfit)) this.outfit = options.outfit
    window.addEventListener('online', this.onBrowserOnline)
  }

  get connectionStatus(): ConnectionStatus {
    return this.status
  }

  get enabled(): boolean {
    return !!this.opts.url
  }

  /** 設定顯示名稱，於下次 hello 生效。 */
  setName(name: string): void {
    this.opts.name = name
  }

  connect(): void {
    if (!this.opts.url || this.disposed || this.versionRejected || this.ws) return
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    // moves／sync／action 是二進位幀；arraybuffer 讓 onmessage 同步拿到資料（預設的 Blob 要非同步讀取，可能打亂訊息順序）。
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      this.sendNow({
        t: 'hello',
        v: PROTOCOL_VERSION,
        name: this.opts.name,
        resumeToken: this.resumeToken,
        outfit: this.outfit,
      })
      // hello 已帶最新衣裝，斷線期間或被限速而待送的值不必再送。
      this.outfitPending = false
      this.clearOutfitTimer()
      // 重送尚未確認的操作；伺服器以 reqId 去重。
      for (const p of this.pending.values()) this.sendNow(p.msg)
      this.setStatus('online')
      this.startTimers()
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onclose = (ev) => this.onSocketClosed(ev.code)
    // onerror 之後一定會有 onclose，統一在 onclose 處理。
    ws.onerror = () => {}
  }

  /** 位置更新（可取代）。只放進佇列，由定時器以 sendHz 送出。 */
  sendPosition(x: number, z: number, heading: number, moving: boolean): void {
    if (!this.enabled || this.background) return
    this.lastPos = { x: round2(x), z: round2(z), heading: round2(heading), moving }
    const p = this.lastPos
    this.queue.push({ t: moving ? 'move' : 'stop', x: p.x, z: p.z, heading: p.heading, seq: ++this.seq })
  }

  /**
   * 需確認的操作。回傳 Promise，伺服器 ack 後 resolve；離線模式直接視為成功。
   */
  sendAction(id: string, data?: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    if (!this.enabled) return Promise.resolve({ ok: true })
    const reqId = `${Date.now().toString(36)}-${(++this.reqCounter).toString(36)}`
    const msg: PendingAck['msg'] = { t: 'action', reqId, id, data }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        resolve({ ok: false, reason: 'timeout' })
      }, this.opts.ackTimeoutMs)
      this.pending.set(reqId, { msg, timer, resolve: (ok, reason) => resolve({ ok, reason }) })
      if (this.status === 'online') this.sendNow(msg)
    })
  }

  /**
   * 送出聊天（不需確認、不重送）。回傳 'sent'；'empty' 清理後沒有內容；'rate' 超過限速；'offline' 未連線（直接丟棄）。
   * 限速先於連線判斷；離線模式（沒有 url）也回 'offline'，由呼叫端自行回音。
   */
  sendChat(text: string): 'sent' | 'empty' | 'rate' | 'offline' {
    const clean = sanitizeChat(text)
    if (!clean) return 'empty'
    if (!this.chatLimiter.tryTake()) return 'rate'
    if (!this.enabled || this.status !== 'online') return 'offline'
    return this.sendNow({ t: 'chat', text: clean }) ? 'sent' : 'offline'
  }

  /**
   * 更換衣裝。記住目前衣裝（之後每次 hello 都帶，含重連）；已連線時送出 outfit 訊息。
   * 超過限速時只保留最新的選擇、不排隊，額度恢復後補送；斷線時不送（重連的 hello 會帶）。
   * 無效編號（非整數或超出範圍）忽略。
   */
  setOutfit(outfit: number): void {
    if (!isOutfit(outfit) || this.disposed) return
    const changed = outfit !== this.outfit
    this.outfit = outfit
    if (!this.enabled) return
    if (changed) this.outfitPending = true
    if (this.outfitPending) this.trySendOutfit()
  }

  private trySendOutfit(): void {
    this.clearOutfitTimer()
    if (!this.outfitPending || this.outfit === undefined || this.status !== 'online') return
    if (this.outfitLimiter.tryTake()) {
      if (this.sendNow({ t: 'outfit', outfit: this.outfit })) {
        this.outfitPending = false
        return
      }
    }
    this.outfitTimer = setTimeout(() => this.trySendOutfit(), OUTFIT_RETRY_MS)
  }

  private clearOutfitTimer(): void {
    if (this.outfitTimer) clearTimeout(this.outfitTimer)
    this.outfitTimer = null
  }

  /**
   * 切換場景（需送達，但可被更新的場景取代）。離線模式忽略。
   * 斷線期間會留在佇列，重連後的 hello 之後送出；伺服器以 resumeToken 恢復時也會帶回場景。
   */
  sendZone(zone: string, x: number, z: number, heading: number): void {
    if (!this.enabled) return
    const msg = { t: 'zone' as const, zone, x, z, heading }
    if (this.status === 'online' && this.sendNow(msg)) return
    this.queue.push(msg)
  }

  /** 進入背景：停止送位置、清掉過期位置；連線保留以免回前景時重新加入。 */
  setBackground(background: boolean): void {
    this.background = background
    if (background) {
      // 背景分頁不再送位置；若最後狀態是移動中，先補一則 stop，否則其他人會看到角色一直走。
      const last = this.lastPos
      if (this.enabled && last?.moving) {
        this.sendNow({ t: 'stop', x: last.x, z: last.z, heading: last.heading, seq: ++this.seq })
        last.moving = false
      }
      this.queue.clear()
    } else if (this.enabled && !this.ws && !this.disposed && !this.versionRejected) {
      // 回前景時若已斷線，不等退避計時直接重連。
      this.clearReconnectTimer()
      this.connect()
    }
  }

  dispose(): void {
    this.disposed = true
    window.removeEventListener('online', this.onBrowserOnline)
    this.clearReconnectTimer()
    this.clearOutfitTimer()
    this.stopTimers()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve(false, 'disposed')
    }
    this.pending.clear()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close(1000)
      this.ws = null
    }
    this.setStatus('closed')
    this.events.clear()
  }

  private onBrowserOnline = (): void => {
    if (this.enabled && !this.ws && !this.disposed && !this.versionRejected) {
      this.clearReconnectTimer()
      this.connect()
    }
  }

  private onMessage(data: unknown): void {
    const msg = decode(data, this.frames)
    if (!msg) return
    this.frames.observe(msg)
    switch (msg.t) {
      case 'welcome':
        this.attempt = 0 // 收到 welcome 才算連線成功；只 onopen 就被踢的情況仍要持續退避。
        this.lastPos = null
        this.resumeToken = msg.resumeToken
        saveResumeToken(msg.resumeToken)
        // 伺服器快照是權威狀態：斷線期間累積的位置與場景訊息已過時。
        this.queue.clear()
        break
      case 'ack': {
        const p = this.pending.get(msg.reqId)
        if (p) {
          clearTimeout(p.timer)
          this.pending.delete(msg.reqId)
          p.resolve(msg.ok, msg.reason)
        }
        break
      }
      case 'error':
        if (msg.code === 'unsupported_version') this.versionRejected = true
        break
      case 'pong':
        this.events.emit('rtt', Math.max(0, performance.now() - msg.ts))
        break
    }
    this.events.emit('message', msg)
  }

  private onSocketClosed(code: number): void {
    this.ws = null
    this.stopTimers()
    if (this.disposed) return
    if (this.versionRejected) {
      this.setStatus('closed')
      return
    }
    this.scheduleReconnect(PENALTY_CLOSE_CODES.includes(code) ? PENALTY_RECONNECT_MS : 0)
  }

  private scheduleReconnect(minDelayMs = 0): void {
    this.setStatus('reconnecting')
    const delay = Math.max(minDelayMs, backoffDelay(this.attempt++))
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private sendNow(msg: ClientMessage): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    const text = encode(msg)
    if (text.length > MAX_MESSAGE_BYTES) return false
    ws.send(text)
    return true
  }

  private flush = (): void => {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || this.queue.size === 0) return
    // 慢速網路：暫緩送出，讓佇列合併位置，而不是在瀏覽器緩衝區堆積。
    if (ws.bufferedAmount > this.opts.maxBufferedBytes) return
    for (const msg of this.queue.drain()) this.sendNow(msg)
  }

  private startTimers(): void {
    this.stopTimers()
    this.flushTimer = setInterval(this.flush, 1000 / this.opts.sendHz)
    this.heartbeatTimer = setInterval(
      () => this.sendNow({ t: 'ping', ts: performance.now() }),
      this.opts.heartbeatMs,
    )
  }

  private stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.flushTimer = this.heartbeatTimer = null
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.events.emit('status', status)
  }
}
