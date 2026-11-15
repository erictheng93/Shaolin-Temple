import { describe, expect, it } from 'vitest'
import { FAR_BELL_MAX_MS, FAR_BELL_MIN_MS, nextFarBellDelayMs, runState, synthesizeBirdCall } from './AudioManager'

// 只實作 synthesizeBirdCall 用到的 createBuffer，node 環境沒有 Web Audio。
const fakeCtx = (sampleRate = 8000) =>
  ({
    sampleRate,
    createBuffer: (_ch: number, length: number) => {
      const data = new Float32Array(length)
      return { length, getChannelData: () => data }
    },
  }) as unknown as BaseAudioContext

const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

describe('synthesizeBirdCall', () => {
  it('產生短促、已正規化且可重現的鳥叫', () => {
    const a = synthesizeBirdCall(fakeCtx(), seeded(42))
    const b = synthesizeBirdCall(fakeCtx(), seeded(42))
    const data = a.getChannelData(0)
    const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(peak).toBeCloseTo(0.7, 5)
    expect(a.length / 8000).toBeLessThan(1.5)
    expect(a.length / 8000).toBeGreaterThan(0.1)
    expect(b.getChannelData(0)).toEqual(data)
  })
})


describe('nextFarBellDelayMs', () => {
  it('間隔落在遠鐘的最小與最大值之間', () => {
    expect(nextFarBellDelayMs(() => 0)).toBe(FAR_BELL_MIN_MS)
    expect(nextFarBellDelayMs(() => 0.999999)).toBeLessThanOrEqual(FAR_BELL_MAX_MS)
    const mid = nextFarBellDelayMs(() => 0.5)
    expect(mid).toBeGreaterThan(FAR_BELL_MIN_MS)
    expect(mid).toBeLessThan(FAR_BELL_MAX_MS)
  })
})

describe('runState', () => {
  const v = { master: 0.8, music: 0.6, sfx: 0.8, muted: false }
  it('靜音、總音量 0 或背景時整個音訊暫停', () => {
    expect(runState(v, false, true)).toEqual({ audible: true, musicOn: true })
    expect(runState({ ...v, muted: true }, false, true)).toEqual({ audible: false, musicOn: false })
    expect(runState({ ...v, master: 0 }, false, true)).toEqual({ audible: false, musicOn: false })
    expect(runState(v, true, true)).toEqual({ audible: false, musicOn: false })
  })
  it('環境音量 0 或尚未開始環境音時只停音樂', () => {
    expect(runState({ ...v, music: 0 }, false, true)).toEqual({ audible: true, musicOn: false })
    expect(runState(v, false, false)).toEqual({ audible: true, musicOn: false })
  })
})
