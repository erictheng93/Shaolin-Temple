import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSettings } from '../game/core/settings'
import { setup } from '../game/gameplay/modules/testHarness'
import { pickCushion } from '../game/world/worship'
import en from './en'
import { LOCALES, detectLocale, getLocale, setLocale, t, type Locale, type MessageKey } from './index'
import ja from './ja'
import viDict from './vi'
import zhHant from './zh-Hant'

const DICTS: Record<Locale, Record<MessageKey, string>> = { 'zh-Hant': zhHant, en, ja, vi: viDict }
const keys = Object.keys(zhHant) as MessageKey[]
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
/** 漢字（含擴充 A）、平假名、片假名、半形片假名。 */
const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/

afterEach(() => {
  setLocale('zh-Hant')
  vi.unstubAllGlobals()
})

describe('字典', () => {
  it('LOCALES 與字典一一對應', () => {
    expect(LOCALES.map((l) => l.id).sort()).toEqual(Object.keys(DICTS).sort())
  })

  for (const [locale, dict] of Object.entries(DICTS)) {
    it(`${locale}：key 與來源相同、沒有空字串、佔位符集合與來源一致`, () => {
      expect(Object.keys(dict).sort()).toEqual([...keys].sort())
      for (const k of keys) {
        expect(dict[k].trim(), `${locale} ${k}`).not.toBe('')
        expect(placeholders(dict[k]), `${locale} ${k}`).toEqual(placeholders(zhHant[k]))
      }
    })
  }

  it('en、vi 不含漢字或假名（抓漏翻）', () => {
    for (const locale of ['en', 'vi'] as const) {
      for (const k of keys) expect(DICTS[locale][k], `${locale} ${k}`).not.toMatch(CJK)
    }
  })
})

describe('detectLocale', () => {
  it('zh* → zh-Hant、ja → ja、vi → vi、其餘 → en', () => {
    expect(detectLocale(['zh-TW'])).toBe('zh-Hant')
    expect(detectLocale(['zh-CN'])).toBe('zh-Hant')
    expect(detectLocale(['ja-JP'])).toBe('ja')
    expect(detectLocale(['vi'])).toBe('vi')
    expect(detectLocale(['fr', 'en'])).toBe('en')
    expect(detectLocale([])).toBe('en')
  })

  it('依偏好順序取第一個認得的語言', () => {
    expect(detectLocale(['fr-FR', 'ja', 'en'])).toBe('ja')
    expect(detectLocale(['en-US', 'zh-TW'])).toBe('en')
  })
})

describe('t()', () => {
  it('代換 {name} 佔位符；沒給的佔位符原樣保留', () => {
    expect(t('top.inTemple', { count: 3 })).toBe('3 人在寺中')
    setLocale('en')
    expect(t('top.inTemple', { count: 3 })).toBe('In the temple: 3')
    expect(t('credits.author', { author: 'efyilin' })).toBe('by efyilin')
    expect(t('top.inTemple')).toBe('In the temple: {count}')
  })

  it('setLocale 立即改變之後 t() 的結果', () => {
    setLocale('ja')
    expect(getLocale()).toBe('ja')
    expect(t('action.chant')).toBe('読経')
    setLocale('vi')
    expect(t('action.chant')).toBe('Tụng kinh')
  })
})

describe('遊戲核心的字串在顯示當下解析', () => {
  it('動作標籤存字典 key；「目前不能用」的原因與找不到站位的原因依呼叫當下的語言', () => {
    const { actions, uninstall } = setup()
    expect(actions.get('chant')!.label).toBe('action.chant')
    expect(actions.get('chant')!.unavailableReason!('courtyard')).toContain('殿內')
    setLocale('en')
    expect(t(actions.get('chant')!.label)).toBe('Chant')
    expect(actions.get('chant')!.unavailableReason!('courtyard')).toContain('main hall')
    expect(pickCushion({ zone: 'courtyard', x: 0, z: 0, selfId: 'a', others: [] })).toBe(en['reason.prostrateInHall'])
    uninstall()
  })
})

describe('loadSettings 的 locale', () => {
  const stubStorage = (value: unknown) =>
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'shaolin-temple:settings:v1' ? JSON.stringify(value) : null),
      setItem: () => {},
      removeItem: () => {},
    })

  it('合法的 locale 照用', () => {
    stubStorage({ locale: 'vi' })
    expect(loadSettings().locale).toBe('vi')
  })

  it('不合法或沒有 locale 時依瀏覽器語言推測', () => {
    vi.stubGlobal('navigator', { languages: ['ja-JP'], language: 'ja-JP' })
    stubStorage({ locale: 'xx' })
    expect(loadSettings().locale).toBe('ja')
    stubStorage({ locale: 'toString' })
    expect(loadSettings().locale).toBe('ja')
    stubStorage({ musicVolume: 0.5 })
    expect(loadSettings().locale).toBe('ja')
    vi.stubGlobal('navigator', { languages: ['de'], language: 'de' })
    stubStorage(null)
    expect(loadSettings().locale).toBe('en')
  })
})
