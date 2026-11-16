import { Emitter } from '../core/Emitter'
import { backoffDelay } from './backoff'
import { OutboundQueue } from './OutboundQueue'
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
} from './protocol'

/** 伺服器因過載（1013）或違規（1008）關閉連線後，下一次重連至少等待的毫秒數。 */
export const PENALTY_RECONNECT_MS = 5000
const PENALTY_CLOSE_CODES = [1013, 1008]
/** 位置座標與面向的上行精度（0.01）。 */
const round2 = (v: number): number => Math.round(v * 100) / 100

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'reconnecting' | 'closed'

interface NetworkEvents extends Record<string, unknown> {
  status: ConnectionStatus
  message: ServerMessage
  rtt: number
}

export interface NetworkOptions {
  url: string | undefined
  name: string
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
  private pending = new Map<string, PendingAck>()
  private attempt = 0
  private seq = 0
  private reqCounter = 0
  private resumeToken: string | undefined
  private background = false
  /** 收到 unsupported_version：版本不符，重連也不會成功，不再重連。 */
  private versionRejected = false
  /** 最後一次排入佇列的位置，進入背景時據此判斷要不要補送 stop。 */
  private lastPos: { x: number; z: number; heading: number; moving: boolean } | null = null
  private disposed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly opts: Required<Omit<NetworkOptions, 'url'>> & { url: string | undefined }

  constructor(options: NetworkOptions) {
    this.opts = {
      sendHz: 10,
      heartbeatMs: 20_000,
      ackTimeoutMs: 10_000,
      maxBufferedBytes: 64 * 1024,
      ...options,
    }
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
    // moves／sync 是二進位幀；arraybuffer 讓 onmessage 同步拿到資料（預設的 Blob 要非同步讀取，可能打亂訊息順序）。
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      this.sendNow({ t: 'hello', v: PROTOCOL_VERSION, name: this.opts.name, resumeToken: this.resumeToken })
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
    const msg = decode(data)
    if (!msg) return
    switch (msg.t) {
      case 'welcome':
        this.attempt = 0 // 收到 welcome 才算連線成功；只 onopen 就被踢的情況仍要持續退避。
        this.lastPos = null
        this.resumeToken = msg.resumeToken
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
