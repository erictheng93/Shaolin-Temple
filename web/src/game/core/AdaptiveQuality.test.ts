import { describe, expect, it } from 'vitest'
import { ADAPTIVE_LEVELS, AdaptiveQuality } from './AdaptiveQuality'

/** 以固定幀間隔跑一段時間，回傳結束時間。 */
function run(a: AdaptiveQuality, from: number, durationMs: number, intervalMs: number, targetMs = 1000 / 30): number {
  let now = from
  for (; now < from + durationMs; now += intervalMs) a.sample(now, intervalMs, targetMs)
  return now
}

describe('AdaptiveQuality', () => {
  const lowest = ADAPTIVE_LEVELS.length - 1

  it('持續變慢時逐級降低，恢復順暢後慢慢升回，升級失敗會延長等待', () => {
    const a = new AdaptiveQuality()
    let now = run(a, 0, 20_000, 33) // 順暢：維持完整畫質
    expect(a.level).toBe(0)

    now = run(a, now, 5_000, 60) // 約 17 FPS：幾秒內降級
    expect(a.level).toBeGreaterThanOrEqual(1)
    now = run(a, now, 60_000, 60)
    expect(a.level).toBe(lowest) // 最多降到最低一級

    now = run(a, now, 20_000, 33) // 恢復順暢但未滿 30 秒：不升
    expect(a.level).toBe(lowest)
    now = run(a, now, 15_000, 33)
    expect(a.level).toBe(lowest - 1)

    now = run(a, now, 5_000, 60) // 升回去馬上又撐不住
    expect(a.level).toBe(lowest)
    now = run(a, now, 45_000, 33) // 這次要等 60 秒才再試
    expect(a.level).toBe(lowest)
    run(a, now, 20_000, 33)
    expect(a.level).toBe(lowest - 1)
  })

  it('75 Hz 螢幕的正常幀間隔與切到背景的長間隔都不會觸發降級', () => {
    const a = new AdaptiveQuality()
    const now = run(a, 0, 30_000, 26.7, 1000 / 60)
    expect(a.level).toBe(0)
    a.sample(now + 60_000, 60_000, 1000 / 60) // 背景一分鐘後回來
    run(a, now + 60_000, 10_000, 16.7, 1000 / 60)
    expect(a.level).toBe(0)
  })
})
