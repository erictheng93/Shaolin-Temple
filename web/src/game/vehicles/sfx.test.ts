import { describe, expect, it, vi } from 'vitest'
import { synthesizeBumpCar, synthesizeBumpTree, synthesizeBumpWall, synthesizeKnock } from '../audio/impacts'
import { VehicleAudio, type SoundPlayer } from './sfx'

const at = (c: number, x: number, z: number, bump = 1) => ({ c, x, z, bump })

describe('VehicleAudio 碰碰車音效', () => {
  it('碰撞聲超過 20 公尺不播、同時最多 3 聲', () => {
    const play = vi.fn()
    const player: SoundPlayer = { play }
    const audio = new VehicleAudio(player, { maxDistance: 20, maxVoices: 3 })
    // 每次用不同的車號，不受單車冷卻影響；bump 預設 1＝撞建築
    let c = 0
    const bump = (x: number, z: number) => audio.playBump(at(c++, x, z), 0, 0, 0)

    expect(bump(25, 0)).toBe(false)
    expect(bump(0, 20.01)).toBe(false)
    expect(play).not.toHaveBeenCalled()

    expect(bump(5, 0)).toBe(true)
    expect(play).toHaveBeenLastCalledWith('bumpWall', expect.objectContaining({ gain: expect.closeTo(0.75, 2) }))

    expect(bump(10, 0)).toBe(true)
    expect(audio.playKnock(0, 5, 0, 0)).toBe(true)
    expect(play).toHaveBeenLastCalledWith('knock', expect.objectContaining({ gain: expect.closeTo(0.75, 2) }))

    // 第 4 聲：超過上限，不播；釋放一聲後可再播
    expect(bump(2, 0)).toBe(false)
    expect(play).toHaveBeenCalledTimes(3)
    audio.releaseVoice()
    expect(bump(2, 0)).toBe(true)
    expect(play).toHaveBeenCalledTimes(4)
  })

  it('依伺服器說的種類選音效；0 或不認得的種類不播', () => {
    const play = vi.fn()
    const audio = new VehicleAudio({ play }, { maxVoices: 9 })
    expect(audio.playBump(at(0, 1, 1, 1), 0, 0, 0)).toBe(true)
    expect(play).toHaveBeenLastCalledWith('bumpWall', expect.anything())
    expect(audio.playBump(at(1, 1, 1, 2), 0, 0, 0)).toBe(true)
    expect(play).toHaveBeenLastCalledWith('bumpTree', expect.anything())
    expect(audio.playBump(at(2, 1, 1, 3), 0, 0, 0)).toBe(true)
    expect(play).toHaveBeenLastCalledWith('bumpCar', expect.anything())
    expect(audio.playBump(at(3, 1, 1, 0), 0, 0, 0)).toBe(false)
    expect(audio.playBump(at(4, 1, 1, 7), 0, 0, 0)).toBe(false)
    expect(play).toHaveBeenCalledTimes(3)
  })

  it('同一台車 350 毫秒冷卻後才再響', () => {
    const play = vi.fn()
    const audio = new VehicleAudio({ play }, { maxVoices: 9 })
    expect(audio.playBump(at(0, 1, 1, 1), 0, 0, 1000)).toBe(true)
    expect(audio.playBump(at(0, 1, 1, 1), 0, 0, 1349)).toBe(false)
    expect(audio.playBump(at(0, 1, 1, 1), 0, 0, 1350)).toBe(true)
  })

  it('兩車互撞只響一聲，距離遠或隔太久的撞車聲各自響', () => {
    const play = vi.fn()
    const audio = new VehicleAudio({ play }, { maxVoices: 9 })
    expect(audio.playBump(at(0, 0, 5, 3), 0, 0, 1000)).toBe(true)
    expect(audio.playBump(at(1, 1.5, 5, 3), 0, 0, 1000)).toBe(false)
    expect(play).toHaveBeenCalledTimes(1)
    // 另一處（超過 2.5 公尺）的撞車聲不受影響
    expect(audio.playBump(at(2, 8, 5, 3), 0, 0, 1050)).toBe(true)
    // 超過 150 毫秒後，同處別台車的撞車聲照響
    expect(audio.playBump(at(3, 8.5, 5, 3), 0, 0, 1300)).toBe(true)
    expect(play).toHaveBeenCalledTimes(3)
  })
})

describe('撞擊音效合成', () => {
  const sr = 8000
  const fakeCtx = {
    sampleRate: sr,
    createBuffer: (_ch: number, length: number) => {
      const data = new Float32Array(length)
      return { length, getChannelData: () => data }
    },
  } as unknown as BaseAudioContext
  const peak = (data: Float32Array, from: number, to: number) => data.slice(from * sr, to * sr).reduce((m, v) => Math.max(m, Math.abs(v)), 0)

  it('四種聲音都已正規化、沒有 NaN、結尾收乾淨', () => {
    for (const synth of [synthesizeBumpCar, synthesizeBumpWall, synthesizeBumpTree, synthesizeKnock]) {
      const data = synth(fakeCtx).getChannelData(0)
      expect(data.every(Number.isFinite)).toBe(true)
      expect(peak(data, 0, data.length / sr)).toBeCloseTo(0.8, 5)
      expect(Math.abs(data[data.length - 1]!)).toBeLessThan(0.01)
    }
  })

  it('撞樹有樹葉的餘響、撞建築沒有；撞人的落地聲在飛行結束時', () => {
    expect(peak(synthesizeBumpTree(fakeCtx).getChannelData(0), 0.3, 0.6)).toBeGreaterThan(0.02)
    expect(peak(synthesizeBumpWall(fakeCtx).getChannelData(0), 0.3, 0.35)).toBeLessThan(0.02)
    const knock = synthesizeKnock(fakeCtx, 0.9).getChannelData(0)
    expect(peak(knock, 0.9, 0.95)).toBeGreaterThan(peak(knock, 0.8, 0.9))
  })
})
