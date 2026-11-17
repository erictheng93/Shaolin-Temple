import { describe, expect, it } from 'vitest'
import { RENAME_MIN_INTERVAL_MS, RENAME_PENDING_MS, decideRename, isRenamePending } from './rename'

describe('decideRename', () => {
  it('與目前名字相同：不送（也不受頻率限制影響）', () => {
    expect(decideRename('慧明', '慧明', 1000, -Infinity)).toBe('unchanged')
    expect(decideRename('慧明', '慧明', 1000, 999)).toBe('unchanged')
  })

  it('間隔不足 RENAME_MIN_INTERVAL_MS 擋下，足夠才送', () => {
    expect(decideRename('淨塵', '慧明', 1000, -Infinity)).toBe('send')
    expect(decideRename('淨塵', '慧明', 1000 + RENAME_MIN_INTERVAL_MS - 1, 1000)).toBe('throttled')
    expect(decideRename('淨塵', '慧明', 1000 + RENAME_MIN_INTERVAL_MS, 1000)).toBe('send')
  })
})

describe('isRenamePending', () => {
  it('送出後 RENAME_PENDING_MS 內算等待中，之後自動過期；沒送過不算', () => {
    expect(isRenamePending(-Infinity, 0)).toBe(false)
    expect(isRenamePending(1000, 1000)).toBe(true)
    expect(isRenamePending(1000, 1000 + RENAME_PENDING_MS - 1)).toBe(true)
    expect(isRenamePending(1000, 1000 + RENAME_PENDING_MS)).toBe(false)
  })
})
