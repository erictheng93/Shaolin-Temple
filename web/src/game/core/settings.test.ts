import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSettings, saveSettings } from './settings'

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
