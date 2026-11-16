import { shallowRef } from 'vue'
import en from './en'
import ja from './ja'
import vi from './vi'
import zhHant, { type MessageKey } from './zh-Hant'

export type { MessageKey }

export type Locale = 'zh-Hant' | 'en' | 'ja' | 'vi'

/**
 * 支援的語言。name 是各語言的自稱（不翻譯）；ccDeed 是 CC 授權頁面（deed）對應的語言代碼。
 * 新增語言：加一份 Record<MessageKey, string> 的字典、在這裡與 DICTS 登記，並在 detectLocale 補對應規則。
 */
export const LOCALES: ReadonlyArray<{ id: Locale; name: string; ccDeed: string }> = [
  { id: 'zh-Hant', name: '繁體中文', ccDeed: 'zh-hant' },
  { id: 'en', name: 'English', ccDeed: 'en' },
  { id: 'ja', name: '日本語', ccDeed: 'ja' },
  { id: 'vi', name: 'Tiếng Việt', ccDeed: 'vi' },
]

const DICTS: Record<Locale, Record<MessageKey, string>> = { 'zh-Hant': zhHant, en, ja, vi }

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && Object.hasOwn(DICTS, v)

/**
 * 目前語言。放在 Vue 的 shallowRef：模板與 computed 裡呼叫 t() 會追蹤它，切換時自動重繪。
 * 遊戲核心（非 Vue）在要顯示的當下呼叫 t()，語言改變後由 GameCore.applySettings 重新推送 UiState。
 */
const current = shallowRef<Locale>('zh-Hant')

export const getLocale = (): Locale => current.value

/** 取字串並代換 `{name}` 佔位符；params 沒有的佔位符原樣保留。 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const s = DICTS[current.value][key] ?? zhHant[key] ?? key
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

/** 切換語言，同時更新 <html lang> 與分頁標題。 */
export function setLocale(locale: Locale): void {
  current.value = locale
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
    document.title = t('app.title')
  }
}

/** 依瀏覽器偏好語言推測：zh* → zh-Hant、ja → ja、vi → vi、其餘 → en（依偏好順序取第一個認得的）。 */
export function detectLocale(languages: ReadonlyArray<string> = browserLanguages()): Locale {
  for (const lang of languages) {
    const l = lang.toLowerCase()
    if (l.startsWith('zh')) return 'zh-Hant'
    if (l === 'ja' || l.startsWith('ja-')) return 'ja'
    if (l === 'vi' || l.startsWith('vi-')) return 'vi'
    if (l === 'en' || l.startsWith('en-')) return 'en'
  }
  return 'en'
}

function browserLanguages(): ReadonlyArray<string> {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : []
}
