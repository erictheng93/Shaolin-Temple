/**
 * 進場後改名的判斷（純函式，GameCore 使用）。
 * 伺服器在「清理後與目前名字相同」時不廣播 name、被頻率限制丟棄時也不回覆，所以「等待伺服器回報」的狀態必須會過期，
 * 否則下一次重連的 welcome 會冒出一則莫名的「名字已更新為…」。
 */

/** 改名的最短間隔：伺服器約每 2 秒只接受 1 次，太快的改名會被忽略，所以本機先擋下。 */
export const RENAME_MIN_INTERVAL_MS = 2100
/** 送出改名後這麼久還沒收到 name，就不再視為等待中。 */
export const RENAME_PENDING_MS = 10_000

export type RenameDecision = 'unchanged' | 'throttled' | 'send'

/** next 是整理過的名字；lastSentAt 是上次送出改名的時間（沒送過為 -Infinity）。 */
export function decideRename(next: string, current: string, now: number, lastSentAt: number): RenameDecision {
  if (next === current) return 'unchanged'
  if (now - lastSentAt < RENAME_MIN_INTERVAL_MS) return 'throttled'
  return 'send'
}

/** 送出改名後是否仍在等伺服器回報（sentAt 為 -Infinity 表示沒有等待中的改名）。 */
export function isRenamePending(sentAt: number, now: number): boolean {
  return now - sentAt < RENAME_PENDING_MS
}
