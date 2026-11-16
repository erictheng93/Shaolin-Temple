import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTFIT, OUTFITS, normalizeOutfit, randomOutfit } from './outfits'

describe('衣裝資料', () => {
  it('恰好 6 套，順序固定（索引即編號，只能加在尾端）', () => {
    expect(OUTFITS).toHaveLength(6)
    expect(OUTFITS.map((o) => o.key)).toEqual(['orange', 'grey', 'brown', 'black', 'kasaya', 'beads'])
    expect(DEFAULT_OUTFIT).toBe(0)
  })

  it('只有袈裟有披帶、只有念珠那套有念珠；顏色都是 #rrggbb', () => {
    expect(OUTFITS.filter((o) => o.sash).map((o) => o.key)).toEqual(['kasaya'])
    expect(OUTFITS.filter((o) => o.beads).map((o) => o.key)).toEqual(['beads'])
    for (const o of OUTFITS) for (const c of [o.robe, o.sash, o.beads]) if (c) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('normalizeOutfit：範圍內的整數照用，其餘回 0', () => {
    expect(normalizeOutfit(0)).toBe(0)
    expect(normalizeOutfit(5)).toBe(5)
    for (const bad of [6, -1, 1.5, Number.NaN, Infinity, '2', null, undefined, {}, true]) expect(normalizeOutfit(bad)).toBe(0)
  })

  it('randomOutfit 落在範圍內', () => {
    expect(randomOutfit(() => 0)).toBe(0)
    expect(randomOutfit(() => 0.999999)).toBe(5)
    expect(randomOutfit(() => 1)).toBe(5)
  })
})

describe('衣裝數量與協定、mock 伺服器一致', () => {
  it('OUTFITS.length === OUTFIT_COUNT，且 mock-server.mjs 的 OUTFIT_COUNT 相同', async () => {
    const { OUTFIT_COUNT } = await import('../net/protocol')
    const { readFileSync } = await import('node:fs')
    expect(OUTFITS).toHaveLength(OUTFIT_COUNT)
    const text = readFileSync(new URL('../../../scripts/mock-server.mjs', import.meta.url), 'utf8')
    expect(Number(/^const OUTFIT_COUNT = (\d+)/m.exec(text)?.[1])).toBe(OUTFIT_COUNT)
  })
})
