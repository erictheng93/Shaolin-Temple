import { describe, expect, it } from 'vitest'
import { frameCap, isLowBattery } from './frameCap'

describe('frameCap', () => {
  it('操作中取畫質上限', () => {
    expect(frameCap({ activeFps: 60, idleMs: 0, lowBattery: false })).toBe(60)
    expect(frameCap({ activeFps: 30, idleMs: 15_000, lowBattery: false })).toBe(30)
  })
  it('閒置超過 15 秒降到 20 FPS，畫質上限更低時不升高', () => {
    expect(frameCap({ activeFps: 60, idleMs: 15_001, lowBattery: false })).toBe(20)
    expect(frameCap({ activeFps: 15, idleMs: 20_000, lowBattery: false })).toBe(15)
  })
  it('閒置超過 60 秒降到 10 FPS', () => {
    expect(frameCap({ activeFps: 60, idleMs: 60_001, lowBattery: false })).toBe(10)
    expect(frameCap({ activeFps: 30, idleMs: 59_000, lowBattery: false })).toBe(20)
  })
  it('低電量把操作中的上限壓到 20 FPS', () => {
    expect(frameCap({ activeFps: 60, idleMs: 0, lowBattery: true })).toBe(20)
    expect(frameCap({ activeFps: 15, idleMs: 0, lowBattery: true })).toBe(15)
  })
  it('低電量加久放取較小者', () => {
    expect(frameCap({ activeFps: 60, idleMs: 90_000, lowBattery: true })).toBe(10)
  })
  it('觸控設備閒置超過 8 秒提前降到 20 FPS', () => {
    expect(frameCap({ activeFps: 60, idleMs: 8_000, lowBattery: false, touch: true })).toBe(60)
    expect(frameCap({ activeFps: 60, idleMs: 8_001, lowBattery: false, touch: true })).toBe(20)
    expect(frameCap({ activeFps: 30, idleMs: 10_000, lowBattery: false, touch: true })).toBe(20)
  })
})

describe('isLowBattery', () => {
  it('未充電且 20% 以下才算', () => {
    expect(isLowBattery(false, 0.2)).toBe(true)
    expect(isLowBattery(false, 0.21)).toBe(false)
    expect(isLowBattery(true, 0.05)).toBe(false)
  })
})
