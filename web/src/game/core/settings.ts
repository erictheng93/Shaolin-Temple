export type QualityLevel = 'low' | 'medium' | 'high'
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
  // 省電：與標準相同的材質與烘焙，只降繪製解析度；角色的近距離完整模型與臉不受畫質影響。
  low: { maxPixelRatio: 1, maxPixels: 1280 * 720, activeFps: 30, antialias: false, shadowMapSize: 0, textureSize: 512, detailMaps: 1, statueTier: 'std' },
  medium: { maxPixelRatio: 1.5, maxPixels: 1600 * 900, activeFps: 30, antialias: false, shadowMapSize: 0, textureSize: 512, detailMaps: 1, statueTier: 'std' },
  high: { maxPixelRatio: 2, maxPixels: 2560 * 1440, activeFps: 60, antialias: true, shadowMapSize: 2048, textureSize: 1024, detailMaps: 2, statueTier: 'hi' },
}

/** 兩個畫質預設在「載入時決定」的欄位是否不同：不同的話，切換後要重新載入才會完整套用。 */
export function needsReload(a: QualityPreset, b: QualityPreset): boolean {
  return (
    a.antialias !== b.antialias ||
    a.shadowMapSize !== b.shadowMapSize ||
    a.textureSize !== b.textureSize ||
    a.detailMaps !== b.detailMaps ||
    a.statueTier !== b.statueTier
  )
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

export interface DeviceInfo {
  /** 主要輸入是觸控（`(pointer: coarse)`），即手機或平板。 */
  coarse: boolean
  /** `navigator.deviceMemory`（GB，Chromium 才有，已粗略化）；iOS Safari 沒有，為 undefined。 */
  deviceMemory?: number
  /** `navigator.hardwareConcurrency`；不明時為 undefined。 */
  cores?: number
}

/** 讀取目前裝置的資訊。 */
export function readDeviceInfo(): DeviceInfo {
  return {
    coarse: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    cores: navigator.hardwareConcurrency || undefined,
  }
}

/**
 * 依裝置推測畫質（純函式，不傳參數時讀取目前裝置）：
 * - low：記憶體 ≤ 2 GB，或觸控裝置、有 deviceMemory 且核心數 ≤ 4。
 * - medium：其他觸控裝置，或記憶體 ≤ 4 GB。
 * - high：其餘（桌機）。
 * iOS Safari 沒有 deviceMemory，核心數也為防指紋而不可靠，所以只看 deviceMemory 有值（Chromium）時的核心數；iPhone 落在 medium（不以 UA 猜測）。
 */
export function detectQuality(info: DeviceInfo = readDeviceInfo()): QualityLevel {
  const { coarse, deviceMemory: mem, cores } = info
  if ((mem !== undefined && mem <= 2) || (coarse && mem !== undefined && cores !== undefined && cores <= 4)) return 'low'
  if (coarse || (mem !== undefined && mem <= 4)) return 'medium'
  return 'high'
}

export function resolveQuality(q: QualitySetting): QualityLevel {
  return q === 'auto' ? detectQuality() : q
}

export interface NetworkInfo {
  /** `navigator.connection.saveData`：使用者開啟了資料節省模式。 */
  saveData?: boolean
  /** `navigator.connection.effectiveType`：'slow-2g' | '2g' | '3g' | '4g'。 */
  effectiveType?: string
}

/** 讀取目前網路狀況。Safari、Firefox 沒有 `navigator.connection`，回傳空物件（視為不受限）。 */
export function readNetworkInfo(): NetworkInfo {
  const c = (navigator as Navigator & { connection?: NetworkInfo }).connection
  return { saveData: c?.saveData, effectiveType: c?.effectiveType }
}

/**
 * 依網路狀況取得實際用來載入資產的預設（純函式，不修改 `QUALITY_PRESETS`）：
 * 資料節省模式或 slow-2g／2g／3g 時，把下載量大的欄位降到最小（貼圖 512、神像 std），
 * 幀率、解析度與陰影與網路無關，維持不變。
 * 呼叫端只在畫質設定為 `auto` 時傳入 `net`；使用者明確選了某個畫質就不傳，照選擇載入。
 */
export function effectivePreset(level: QualityLevel, net?: NetworkInfo): QualityPreset {
  const preset = QUALITY_PRESETS[level]
  const slow = net?.saveData === true || ['slow-2g', '2g', '3g'].includes(net?.effectiveType ?? '')
  return slow ? { ...preset, textureSize: 512, statueTier: 'std' } : preset
}

/** 某個畫質設定實際會載入的資產預設：只有 `auto` 才依網路狀況降級。GameCore 與設定面板共用，兩邊判斷一致。 */
export function assetPresetFor(setting: QualitySetting): QualityPreset {
  return effectivePreset(resolveQuality(setting), setting === 'auto' ? readNetworkInfo() : undefined)
}
