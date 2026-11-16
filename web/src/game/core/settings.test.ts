import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUALITY_PRESETS, assetPresetFor, detectQuality, effectivePreset, loadSettings, needsReload, saveSettings } from './settings'

const stubStorage = (init: Record<string, string>) => {
  const store = new Map(Object.entries(init))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  return store
}

describe('settings 舊 key 遷移', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('沒有新 key 時讀取舊 key，儲存後改存新 key 並刪除舊 key', () => {
    const store = stubStorage({ 'online-temple:settings:v1': JSON.stringify({ musicVolume: 0.2 }) })
    const s = loadSettings()
    expect(s.musicVolume).toBe(0.2)
    saveSettings(s)
    expect(store.has('online-temple:settings:v1')).toBe(false)
    expect(JSON.parse(store.get('shaolin-temple:settings:v1')!).musicVolume).toBe(0.2)
  })

  it('新 key 優先於舊 key', () => {
    stubStorage({
      'online-temple:settings:v1': JSON.stringify({ musicVolume: 0.2 }),
      'shaolin-temple:settings:v1': JSON.stringify({ musicVolume: 0.9 }),
    })
    expect(loadSettings().musicVolume).toBe(0.9)
  })
})

describe('衣裝', () => {
  afterEach(() => vi.unstubAllGlobals())
  const KEY = 'shaolin-temple:settings:v1'

  it('第一次造訪（沒有存過）隨機挑一套並立即存起來', () => {
    const store = stubStorage({})
    expect(loadSettings(() => 0.7).outfit).toBe(5)
    expect(JSON.parse(store.get(KEY)!).outfit).toBe(5)
    // 之後載入沿用同一套，不再隨機
    expect(loadSettings(() => 0).outfit).toBe(5)
  })

  it('舊版設定沒有衣裝欄位時也隨機挑一套，其他設定保留', () => {
    const store = stubStorage({ [KEY]: JSON.stringify({ musicVolume: 0.3 }) })
    const s = loadSettings(() => 0.2)
    expect(s.outfit).toBe(1)
    expect(s.musicVolume).toBe(0.3)
    expect(JSON.parse(store.get(KEY)!).outfit).toBe(1)
  })

  it('存過的有效值照用；無效值回預設 0，不隨機', () => {
    stubStorage({ [KEY]: JSON.stringify({ outfit: 3 }) })
    expect(loadSettings(() => 0.9).outfit).toBe(3)
    for (const bad of [8, -1, 2.5, '3', null]) {
      stubStorage({ [KEY]: JSON.stringify({ outfit: bad }) })
      expect(loadSettings(() => 0.9).outfit).toBe(0)
    }
  })

  it('儲存被封鎖時仍回傳一套衣裝', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {},
    })
    expect(loadSettings(() => 0.5).outfit).toBe(4)
  })
})

describe('畫質', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loadSettings 接受 low', () => {
    stubStorage({ 'shaolin-temple:settings:v1': JSON.stringify({ quality: 'low' }) })
    expect(loadSettings().quality).toBe('low')
  })

  it('detectQuality 依裝置資訊判斷', () => {
    expect(detectQuality({ coarse: false })).toBe('high')
    expect(detectQuality({ coarse: false, deviceMemory: 8, cores: 8 })).toBe('high')
    expect(detectQuality({ coarse: false, deviceMemory: 4 })).toBe('medium')
    expect(detectQuality({ coarse: false, deviceMemory: 2 })).toBe('low')
    expect(detectQuality({ coarse: true })).toBe('medium') // iOS Safari：沒有 deviceMemory 與核心數
    expect(detectQuality({ coarse: true, deviceMemory: 4, cores: 8 })).toBe('medium')
    expect(detectQuality({ coarse: true, deviceMemory: 4, cores: 4 })).toBe('low')
    expect(detectQuality({ coarse: true, cores: 4 })).toBe('medium') // iOS：沒有 deviceMemory 時不信任核心數
    expect(detectQuality({ coarse: false, cores: 2 })).toBe('high') // 桌機核心少不降級
  })
})

describe('effectivePreset', () => {
  it('資料節省或 3g 以下時貼圖降到 512、神像用 std，其餘欄位不變', () => {
    for (const net of [{ saveData: true }, { effectiveType: '3g' }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
      const p = effectivePreset('high', net)
      expect(p.textureSize).toBe(512)
      expect(p.statueTier).toBe('std')
      expect(p.activeFps).toBe(QUALITY_PRESETS.high.activeFps)
      expect(p.shadowMapSize).toBe(QUALITY_PRESETS.high.shadowMapSize)
    }
  })

  it('4g、沒有資訊或沒有傳入時照原預設', () => {
    expect(effectivePreset('high', { effectiveType: '4g', saveData: false })).toBe(QUALITY_PRESETS.high)
    expect(effectivePreset('high', {})).toBe(QUALITY_PRESETS.high)
    expect(effectivePreset('high')).toBe(QUALITY_PRESETS.high)
  })

  it('不修改 QUALITY_PRESETS', () => {
    effectivePreset('high', { saveData: true })
    expect(QUALITY_PRESETS.high.textureSize).toBe(1024)
    expect(QUALITY_PRESETS.high.statueTier).toBe('hi')
  })
})

describe('assetPresetFor', () => {
  it('auto 遇資料節省時降級，手動選同一等級不降級，兩者需要重新載入', () => {
    const conn = Object.getOwnPropertyDescriptor(navigator, 'connection')
    Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true })
    try {
      expect(assetPresetFor('high')).toBe(QUALITY_PRESETS.high)
      const auto = assetPresetFor('auto')
      expect(auto.textureSize).toBe(512)
      expect(needsReload(auto, assetPresetFor(detectQuality()))).toBe(detectQuality() === 'high')
    } finally {
      if (conn) Object.defineProperty(navigator, 'connection', conn)
      else delete (navigator as { connection?: unknown }).connection
    }
  })
})

describe('needsReload', () => {
  it('省電與標準載入內容相同，不需重新載入；高畫質與兩者不同', () => {
    expect(needsReload(QUALITY_PRESETS.low, QUALITY_PRESETS.medium)).toBe(false)
    expect(needsReload(QUALITY_PRESETS.medium, QUALITY_PRESETS.high)).toBe(true)
    expect(needsReload(QUALITY_PRESETS.high, QUALITY_PRESETS.low)).toBe(true)
  })

  it('只看載入時決定的欄位，執行中可切換的欄位不算', () => {
    const m = QUALITY_PRESETS.medium
    expect(needsReload(m, { ...m, maxPixelRatio: 2, maxPixels: 1, activeFps: 60 })).toBe(false)
    for (const patch of [{ antialias: true }, { shadowMapSize: 1024 }, { textureSize: 1024 as const }, { detailMaps: 2 as const }, { statueTier: 'hi' as const }]) {
      expect(needsReload(m, { ...m, ...patch })).toBe(true)
    }
  })
})
