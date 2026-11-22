export interface VehicleAudioOptions {
  maxVoices?: number
  maxDistance?: number
}

export interface SoundPlayer {
  play(name: string, opts?: { gain?: number; rate?: number }): void
}

/**
 * 碰碰車音效管理器：
 * - 依與本機玩家的距離線性衰減（超過 20 公尺不播）
 * - 同時最多 3 聲並發（超過時捨棄）
 */
export class VehicleAudio {
  private activeVoices = 0
  readonly maxVoices: number
  readonly maxDistance: number

  constructor(
    private readonly player?: SoundPlayer | null,
    opts: VehicleAudioOptions = {},
  ) {
    this.maxVoices = opts.maxVoices ?? 3
    this.maxDistance = opts.maxDistance ?? 20
  }

  getActiveVoices(): number {
    return this.activeVoices
  }

  releaseVoice(): void {
    if (this.activeVoices > 0) this.activeVoices--
  }

  playBump(carX: number, carZ: number, selfX: number, selfZ: number): boolean {
    return this.triggerSound('bump', carX, carZ, selfX, selfZ, 250)
  }

  playKnock(knockX: number, knockZ: number, selfX: number, selfZ: number): boolean {
    return this.triggerSound('knock', knockX, knockZ, selfX, selfZ, 450)
  }

  private triggerSound(
    name: string,
    x: number,
    z: number,
    selfX: number,
    selfZ: number,
    durationMs: number,
  ): boolean {
    const dist = Math.hypot(x - selfX, z - selfZ)
    if (dist > this.maxDistance) return false
    if (this.activeVoices >= this.maxVoices) return false

    const gain = Math.max(0, 1 - dist / this.maxDistance)
    if (gain < 0.01) return false

    this.activeVoices++
    this.player?.play(name, { gain })

    setTimeout(() => {
      this.releaseVoice()
    }, durationMs)

    return true
  }
}
