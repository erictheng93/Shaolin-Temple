import { describe, expect, it } from 'vitest'
import { FAR_BELL_MAX_MS, FAR_BELL_MIN_MS, nextFarBellDelayMs, runState, synthesizeBirdCall, synthesizeIncenseOffering, synthesizeMuyu, synthesizeQing } from './AudioManager'

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

describe('synthesizeIncenseOffering', () => {
  it('插香前留白，只有入灰的沙聲，磬聲落在插香那一刻', () => {
    const sr = 8000
    const data = synthesizeIncenseOffering(fakeCtx(sr), 2, seeded(7)).getChannelData(0)
    const peak = (from: number, to: number) => data.slice(from * sr, to * sr).reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(peak(0, 1.7)).toBe(0)
    expect(peak(1.7, 2)).toBeGreaterThan(0)
    expect(peak(1.7, 2)).toBeLessThan(0.15)
    expect(peak(2, 2.2)).toBeCloseTo(0.6, 1)
    expect(Math.abs(data[data.length - 1]!)).toBeLessThan(0.01)
  })
})

describe('synthesizeMuyu', () => {
  it('短促、已正規化，餘韻在 0.3 秒內消失', () => {
    const sr = 8000
    const data = synthesizeMuyu(fakeCtx(sr), seeded(3)).getChannelData(0)
    const peak = (from: number, to: number) => data.slice(from * sr, to * sr).reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(data.length / sr).toBeLessThan(0.5)
    expect(peak(0, 0.05)).toBeCloseTo(0.8, 5)
    expect(peak(0.3, 0.4)).toBeLessThan(0.02)
  })
})

describe('synthesizeQing', () => {
  it('壓磬把之前的餘韻收掉，只留一聲短促的敲擊', () => {
    const sr = 8000
    const peak = (data: Float32Array, from: number, to: number) => data.slice(from * sr, to * sr).reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    const open = synthesizeQing(fakeCtx(sr), [0]).getChannelData(0)
    const damped = synthesizeQing(fakeCtx(sr), [0], [1]).getChannelData(0)
    expect(peak(open, 1.5, 2)).toBeGreaterThan(0.1)
    expect(peak(damped, 0.5, 1)).toBeGreaterThan(0.1)
    expect(peak(damped, 1, 1.1)).toBeGreaterThan(0.2)
    expect(peak(damped, 1.5, 2)).toBeLessThan(0.001)
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
