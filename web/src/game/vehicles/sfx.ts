import { BUMP_CAR, BUMP_TREE, BUMP_WALL } from '../net/binaryFrame'

export interface VehicleAudioOptions {
  maxVoices?: number
  maxDistance?: number
}

export interface SoundPlayer {
  play(name: string, opts?: { gain?: number; rate?: number }): void
}

/** 車撞到的東西：另一台車、樹，其餘（主殿、鐘亭、檔口、石燈籠、香爐、圍牆）都算建築。 */
export type BumpKind = 'car' | 'tree' | 'wall'

/** 同一台車兩次碰撞聲的最短間隔（毫秒）：頂著東西時 bump 每一幀都會亮。 */
const BUMP_COOLDOWN_MS = 350
/** 兩車互撞時兩台都會標 car：這段時間（毫秒）與距離（公尺）內已響過一聲撞車聲，就不再響第二聲。 */
const CAR_DEDUP_MS = 150
const CAR_DEDUP_DIST = 2.5

const KIND_OF: Record<number, BumpKind> = { [BUMP_WALL]: 'wall', [BUMP_TREE]: 'tree', [BUMP_CAR]: 'car' }

const SOUNDS: Record<BumpKind | 'knock', { name: string; ms: number }> = {
  car: { name: 'bumpCar', ms: 500 },
  wall: { name: 'bumpWall', ms: 350 },
  tree: { name: 'bumpTree', ms: 1100 },
  knock: { name: 'knock', ms: 1150 },
}

/**
 * 碰碰車音效管理器：
 * - 依與本機玩家的距離線性衰減（超過 20 公尺不播）
 * - 同時最多 3 聲並發（超過時捨棄）
 * - 每台車的碰撞聲有冷卻；兩車互撞只響一聲（依時間與距離去重）
 */
export class VehicleAudio {
  private activeVoices = 0
  /** 車號 → 上次發出碰撞聲的時間。車號是協定裡的小整數，不會無限增長。 */
  private readonly lastBump = new Map<number, number>()
  /** 上一聲撞車聲的時間與位置，兩車互撞去重用。 */
  private lastCarBump: { at: number; x: number; z: number } | null = null
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

  /** car.bump 是伺服器說的碰撞種類（協定的 BUMP_*）；0 或不認得的值不播。 */
  playBump(car: { c: number; x: number; z: number; bump: number }, selfX: number, selfZ: number, now: number): boolean {
    const kind = KIND_OF[car.bump]
    if (kind === undefined) return false
    if (now - (this.lastBump.get(car.c) ?? -Infinity) < BUMP_COOLDOWN_MS) return false
    this.lastBump.set(car.c, now)
    if (kind === 'car') {
      const last = this.lastCarBump
      if (last && now - last.at <= CAR_DEDUP_MS && Math.hypot(car.x - last.x, car.z - last.z) <= CAR_DEDUP_DIST) return false
      this.lastCarBump = { at: now, x: car.x, z: car.z }
    }
    return this.triggerSound(kind, car.x, car.z, selfX, selfZ)
  }

  playKnock(knockX: number, knockZ: number, selfX: number, selfZ: number): boolean {
    return this.triggerSound('knock', knockX, knockZ, selfX, selfZ)
  }

  private triggerSound(kind: BumpKind | 'knock', x: number, z: number, selfX: number, selfZ: number): boolean {
    const dist = Math.hypot(x - selfX, z - selfZ)
    if (dist > this.maxDistance) return false
    if (this.activeVoices >= this.maxVoices) return false

    const gain = Math.max(0, 1 - dist / this.maxDistance)
    if (gain < 0.01) return false

    const sound = SOUNDS[kind]
    this.activeVoices++
    // 音高略微隨機，連續幾次碰撞不會一模一樣
    this.player?.play(sound.name, { gain, rate: 0.94 + Math.random() * 0.12 })

    setTimeout(() => {
      this.releaseVoice()
    }, sound.ms)

    return true
  }
}
