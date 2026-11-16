export type QualityLevel = 'medium' | 'high'
export type QualitySetting = 'auto' | QualityLevel

export interface QualityPreset {
  /** devicePixelRatio 上限。 */
  maxPixelRatio: number
  /** 繪製緩衝區總像素上限，高解析度手機也不會超過。 */
  maxPixels: number
  /** 前景時的目標幀率（場景有持續的環境動畫，靜止時也以此幀率繪製）。 */
  activeFps: number
  antialias: boolean
  /**
   * 主光即時陰影貼圖邊長；0 表示不建陰影貼圖。靜態物件的影子是烘焙的，陰影貼圖只給近處角色投影。於下次載入生效。
   */
  shadowMapSize: number
  /** 場景貼圖解析度。於下次載入生效。 */
  textureSize: 512 | 1024
  /** 細節貼圖：1 為底色加法線、2 再加粗糙度。於下次載入生效。 */
  detailMaps: 1 | 2
  /** 殿內寫實神像的層級：std 每尊約 1.5 萬三角形、1024 貼圖；hi 約 4 萬三角形、2048 貼圖。於下次載入生效。 */
  statueTier: 'std' | 'hi'
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  medium: { maxPixelRatio: 1.5, maxPixels: 1920 * 1080, activeFps: 30, antialias: false, shadowMapSize: 0, textureSize: 512, detailMaps: 1, statueTier: 'std' },
  high: { maxPixelRatio: 2, maxPixels: 2560 * 1440, activeFps: 60, antialias: true, shadowMapSize: 2048, textureSize: 1024, detailMaps: 2, statueTier: 'hi' },
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
    quality: (['auto', 'medium', 'high'] as const).includes(r.quality as QualitySetting)
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
  return coarse || (mem !== undefined && mem <= 2) ? 'medium' : 'high'
}

export function resolveQuality(q: QualitySetting): QualityLevel {
  return q === 'auto' ? detectQuality() : q
}
