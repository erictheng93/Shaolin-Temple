import type { ClientMessage } from './protocol'

/**
 * 待送出訊息佇列。
 * - move/stop 屬可取代狀態：佇列中只保留最新一筆位置。
 * - rename 同樣可取代：只保留最新一筆改名。
 * - 其他訊息依序排隊，超過上限時丟棄最舊的，避免斷線期間無限累積。
 */
export class OutboundQueue {
  private items: ClientMessage[] = []

  constructor(private readonly limit = 64) {}

  push(msg: ClientMessage): void {
    if (msg.t === 'move' || msg.t === 'stop') {
      const i = this.items.findIndex((m) => m.t === 'move' || m.t === 'stop')
      if (i !== -1) this.items.splice(i, 1)
    } else if (msg.t === 'rename') {
      const i = this.items.findIndex((m) => m.t === 'rename')
      if (i !== -1) this.items.splice(i, 1)
    }
    this.items.push(msg)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
  }

  /** 取出全部待送訊息並清空佇列。 */
  drain(): ClientMessage[] {
    const out = this.items
    this.items = []
    return out
  }

  get size(): number {
    return this.items.length
  }

  clear(): void {
    this.items = []
  }
}
