import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUALITY_PRESETS, detectQuality, effectivePreset, loadSettings, saveSettings } from './settings'

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
