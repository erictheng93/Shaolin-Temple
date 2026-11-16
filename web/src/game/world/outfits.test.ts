import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTFIT, OUTFITS, normalizeOutfit, randomOutfit } from './outfits'

describe('衣裝資料', () => {
  it('恰好 8 套，順序固定（索引即編號，只能加在尾端）', () => {
    expect(OUTFITS).toHaveLength(8)
    expect(OUTFITS.map((o) => o.key)).toEqual(['orange', 'grey', 'brown', 'black', 'kasaya', 'beads', 'pilgrim', 'warrior'])
    expect(DEFAULT_OUTFIT).toBe(0)
  })

  it('既有 6 套的外觀不變', () => {
    expect(OUTFITS.slice(0, 6)).toEqual([
      { key: 'orange', label: '橘黃僧袍', robe: '#c9853a' },
      { key: 'grey', label: '灰色常服', robe: '#86837d' },
      { key: 'brown', label: '褐色海青', robe: '#6e4f3a' },
      { key: 'black', label: '黑色海青', robe: '#363333' },
      { key: 'kasaya', label: '黃袍披袈裟', robe: '#c99a3e', sash: '#9c2f23' },
      { key: 'beads', label: '灰藍袍掛念珠', robe: '#56687f', beads: '#4a2e1c' },
    ])
  })

  it('配件：只有袈裟有披帶、念珠那套有念珠、行腳僧戴斗笠、武僧穿短褂；顏色都是 #rrggbb', () => {
    expect(OUTFITS.filter((o) => o.sash).map((o) => o.key)).toEqual(['kasaya'])
    expect(OUTFITS.filter((o) => o.beads).map((o) => o.key)).toEqual(['beads'])
    expect(OUTFITS.filter((o) => o.hat).map((o) => o.key)).toEqual(['pilgrim'])
    expect(OUTFITS.filter((o) => o.tunic).map((o) => o.key)).toEqual(['warrior'])
    for (const o of OUTFITS) {
      for (const c of [o.robe, o.sash, o.beads, o.hat, o.tunic?.trousers, o.tunic?.leggings, o.tunic?.belt]) {
        if (c) expect(c).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('normalizeOutfit：範圍內的整數照用，其餘（含比這個版本新的編號）回 0', () => {
    expect(normalizeOutfit(0)).toBe(0)
    expect(normalizeOutfit(7)).toBe(7)
    for (const bad of [8, 200, -1, 1.5, Number.NaN, Infinity, '2', null, undefined, {}, true]) expect(normalizeOutfit(bad)).toBe(0)
  })

  it('randomOutfit 落在範圍內', () => {
    expect(randomOutfit(() => 0)).toBe(0)
    expect(randomOutfit(() => 0.999999)).toBe(7)
    expect(randomOutfit(() => 1)).toBe(7)
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
