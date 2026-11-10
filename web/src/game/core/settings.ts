export type QualityLevel = 'low' | 'medium' | 'high'
export type QualitySetting = 'auto' | QualityLevel

export interface QualityPreset {
  /** devicePixelRatio 上限。 */
  maxPixelRatio: number
  /** 繪製緩衝區總像素上限，高解析度手機也不會超過。 */
  maxPixels: number
  /** 有移動或動畫時的目標幀率。 */
  activeFps: number
  /** 畫面靜止時的環境動畫幀率（燭火、香煙）；0 表示完全停止重繪。 */
  idleFps: number
  antialias: boolean
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { maxPixelRatio: 1, maxPixels: 1280 * 720, activeFps: 30, idleFps: 0, antialias: false },
  medium: { maxPixelRatio: 1.5, maxPixels: 1920 * 1080, activeFps: 30, idleFps: 8, antialias: false },
  high: { maxPixelRatio: 2, maxPixels: 2560 * 1440, activeFps: 60, idleFps: 15, antialias: true },
}

export interface Settings {
  quality: QualitySetting
  masterVolume: number
  musicVolume: number
  sfxVolume: number
  muted: boolean
  playerName: string
  showStats: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.8,
  muted: false,
  playerName: '',
  showStats: false,
}

const KEY = 'shaolin-temple:settings:v1'
/** 改名前的 key。讀不到新 key 時沿用一次，下次儲存後刪除。 */
const LEGACY_KEY = 'online-temple:settings:v1'

const clamp01 = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback

/** 讀取設定。私密瀏覽或儲存被封鎖時回傳預設值。 */
export function loadSettings(): Settings {
  let raw: unknown
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY) ?? 'null')
  } catch {
    raw = null
  }
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const r = raw as Partial<Record<keyof Settings, unknown>>
  const d = DEFAULT_SETTINGS
  return {
    quality: (['auto', 'low', 'medium', 'high'] as const).includes(r.quality as QualitySetting)
      ? (r.quality as QualitySetting)
      : d.quality,
    masterVolume: clamp01(r.masterVolume, d.masterVolume),
    musicVolume: clamp01(r.musicVolume, d.musicVolume),
    sfxVolume: clamp01(r.sfxVolume, d.sfxVolume),
    muted: typeof r.muted === 'boolean' ? r.muted : d.muted,
    playerName: typeof r.playerName === 'string' ? r.playerName.slice(0, 16) : d.playerName,
    showStats: typeof r.showStats === 'boolean' ? r.showStats : d.showStats,
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // 儲存失敗不影響遊玩。
  }
}

/** 依裝置推測畫質：觸控為主或記憶體少的裝置用 medium，否則 high。 */
export function detectQuality(): QualityLevel {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (mem !== undefined && mem <= 2) return 'low'
  return coarse ? 'medium' : 'high'
}

export function resolveQuality(q: QualitySetting): QualityLevel {
  return q === 'auto' ? detectQuality() : q
}
