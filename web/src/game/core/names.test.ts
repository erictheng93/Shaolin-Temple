import { describe, expect, it } from 'vitest'
import { EXCLUDED_NAMES, LINEAGE_CHARS, TEMPLE_NAMES, normalizeName, randomTempleName } from './names'

/** 指定必須排除的真實知名僧人／宗教人物法號（需求原文的清單）。 */
const REQUIRED_EXCLUDED = [
  '玄奘', '慧能', '惠能', '神秀', '達摩', '鑑真', '法顯', '玄覺', '道信', '弘忍', '僧璨', '慧可', '智顗', '慧遠',
  '道安', '虛雲', '印光', '弘一', '太虛', '星雲', '聖嚴', '證嚴', '惟覺', '淨空', '一行', '濟公', '道濟', '悟空',
  '悟能', '悟淨', '法海',
]

/** CJK 統一表意文字（基本區），不含空白、標點、拉丁字母。 */
const HAN_ONLY = /^[一-鿿]+$/u
/** 常見的簡體字形；字表必須是繁體。 */
const SIMPLIFIED = '净觉静禅圆远云尘听扫种叶灯钟间闲莲杂'

describe('預設法號', () => {
  it('組合數至少 300 種且不重複', () => {
    expect(TEMPLE_NAMES.length).toBeGreaterThanOrEqual(300)
    expect(new Set(TEMPLE_NAMES).size).toBe(TEMPLE_NAMES.length)
  })

  it('全部 2～4 個字（≤ 16 字元）、只有漢字、沒有簡體字形', () => {
    for (const name of TEMPLE_NAMES) {
      const len = [...name].length
      expect(len, name).toBeGreaterThanOrEqual(2)
      expect(len, name).toBeLessThanOrEqual(4)
      expect(name, name).toMatch(HAN_ONLY)
      for (const ch of SIMPLIFIED) expect(name.includes(ch), `${name} 含簡體 ${ch}`).toBe(false)
    }
  })

  it('雅號只佔少數，主要是兩字法號', () => {
    const style = TEMPLE_NAMES.filter((n) => [...n].length > 2).length
    expect(style).toBeGreaterThan(0)
    expect(style / TEMPLE_NAMES.length).toBeLessThan(0.1)
  })

  it('不以少林寺現行字輩當首字', () => {
    for (const name of TEMPLE_NAMES) expect(LINEAGE_CHARS.includes(name[0]!), name).toBe(false)
  })

  it('窮舉：不等於也不包含任何排除的法號（排除清單涵蓋指定名單）', () => {
    for (const x of REQUIRED_EXCLUDED) expect(EXCLUDED_NAMES).toContain(x)
    for (const name of TEMPLE_NAMES) {
      for (const x of EXCLUDED_NAMES) expect(name.includes(x), `${name} 命中 ${x}`).toBe(false)
    }
  })

  it('固定 rng 時結果固定；rng 的邊界值也落在清單內', () => {
    const seq = (seed: number) => {
      let s = seed
      // 線性同餘：測試用的決定性亂數
      const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
      return Array.from({ length: 20 }, () => randomTempleName(rng))
    }
    expect(seq(42)).toEqual(seq(42))
    expect(randomTempleName(() => 0)).toBe(TEMPLE_NAMES[0])
    expect(randomTempleName(() => 0.999999999)).toBe(TEMPLE_NAMES.at(-1))
    expect(TEMPLE_NAMES).toContain(randomTempleName())
  })
})

describe('normalizeName', () => {
  it('去控制字元與頭尾空白、最多 16 個 Unicode 字元', () => {
    expect(normalizeName('  慧明 ')).toBe('慧明')
    expect(normalizeName('a\u0000b\nc')).toBe('abc')
    expect(normalizeName('字'.repeat(20))).toBe('字'.repeat(16))
    expect([...normalizeName('😀'.repeat(20))]).toHaveLength(16)
  })

  it('空白時用隨機法號，不是「訪客」', () => {
    expect(normalizeName('   ', () => 0)).toBe(TEMPLE_NAMES[0])
    expect(TEMPLE_NAMES).toContain(normalizeName(''))
  })
})
