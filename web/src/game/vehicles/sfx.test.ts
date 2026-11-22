import { describe, expect, it, vi } from 'vitest'
import { VehicleAudio, type SoundPlayer } from './sfx'

describe('VehicleAudio 碰碰車音效', () => {
  it('碰撞聲超過 20 公尺不播、同時最多 3 聲', () => {
    const play = vi.fn()
    const player: SoundPlayer = { play }
    const audio = new VehicleAudio(player, { maxDistance: 20, maxVoices: 3 })

    // 超過 20 公尺：距離 25m 不播
    const far = audio.playBump(25, 0, 0, 0)
    expect(far).toBe(false)
    expect(play).not.toHaveBeenCalled()

    // 剛好 20 公尺邊緣（20.01m）：不播
    const edge = audio.playBump(0, 20.01, 0, 0)
    expect(edge).toBe(false)
    expect(play).not.toHaveBeenCalled()

    // 20 公尺以內（5m）：可以播放，並呼叫 player.play 帶有衰減後的 gain
    const near1 = audio.playBump(5, 0, 0, 0)
    expect(near1).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenLastCalledWith('bump', expect.objectContaining({ gain: expect.closeTo(0.75, 2) }))

    // 同時最多 3 聲：目前已有 1 聲
    const near2 = audio.playBump(10, 0, 0, 0)
    expect(near2).toBe(true)
    expect(play).toHaveBeenCalledTimes(2)

    const near3 = audio.playKnock(0, 5, 0, 0)
    expect(near3).toBe(true)
    expect(play).toHaveBeenCalledTimes(3)
    expect(play).toHaveBeenLastCalledWith('knock', expect.objectContaining({ gain: expect.closeTo(0.75, 2) }))

    // 第 4 聲：超過上限 3 聲，不播
    const near4 = audio.playBump(2, 0, 0, 0)
    expect(near4).toBe(false)
    expect(play).toHaveBeenCalledTimes(3)

    // 釋放一聲後，可再播第 4 聲
    audio.releaseVoice()
    const near5 = audio.playBump(2, 0, 0, 0)
    expect(near5).toBe(true)
    expect(play).toHaveBeenCalledTimes(4)
  })
})
