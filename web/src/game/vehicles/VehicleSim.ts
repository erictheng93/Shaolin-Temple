import type { CarState, SimWorld } from './simCore'
import { createSimWorld } from './simCore'
import { wrapAngle, type DriveInput } from './drive'
import { VEHICLES } from '../world/vehicles'
import { SOLIDS, WORLD_BOUNDS } from '../world/layout'

/**
 * u16 環繞比較：判斷 seq 是否小於等於 ack。
 * 考慮 16-bit 溢位（例如 seq=65535, ack=5 時 65535 <= 5 為 true）。
 */
export function isSeqLe(seq: number, ack: number): boolean {
  const diff = ((seq - ack) << 16) >> 16
  return diff <= 0
}

export interface NetworkConnectionInfo {
  saveData?: boolean
  effectiveType?: string
}

export interface ErrorOffset {
  x: number
  z: number
  heading: number
}

/**
 * 前端車輛物理預測與重播校正：
 * - 當本地玩家騎乘時，以本機物理世界進行前向預測模擬。
 * - 接收到伺服器廣播 cars (帶 ack) 時，剔除已被確認的歷史輸入，將車輛重置為權威狀態後重播未確認輸入。
 * - 重播前後位置差距記為誤差偏移，以 exp(-dt * 10) 指數衰減平滑，超過 3 公尺則直接瞬移（不平滑）。
 */
export class VehicleSim {
  private selfCarId: number | null = null
  private knownCars = new Set<number>()
  private currentInput: DriveInput = { dir: 0, mag: 0 }
  private accumulator = 0

  /** 歷史輸入序列，上限 120 筆 */
  readonly history: Array<{ seq: number; input: DriveInput }> = []

  /** 當前殘餘誤差偏移 */
  readonly errorOffset: ErrorOffset = { x: 0, z: 0, heading: 0 }

  /** 每次校正的位置修正量（公尺），供上線門檻量測 */
  readonly correction = {
    last: 0,
    samples: [] as number[],
  }

  private disposed = false

  constructor(private readonly world: SimWorld) {}

  /**
   * 根據連線狀態判斷是否載入 Rapier 物理引擎：
   * 開啟資料節省模式 (saveData) 或網路為 2g/3g 時不載入。
   */
  static shouldLoad(conn: NetworkConnectionInfo | undefined): boolean {
    if (!conn) return true
    if (conn.saveData) return false
    if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g') {
      return false
    }
    return true
  }

  /**
   * 非同步動態載入 Rapier 物理模組，若載入失敗或例外則回傳 null。
   */
  static async load(): Promise<VehicleSim | null> {
    try {
      const mod = await import('@dimforge/rapier3d-compat')
      const RAPIER = (mod as any).default ?? mod
      await RAPIER.init()
      const world = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
      return new VehicleSim(world)
    } catch (e) {
      console.warn('Failed to load Rapier physics module for VehicleSim:', e)
      return null
    }
  }

  /**
   * 同步場景上的所有車輛狀態：
   * - 自己騎乘的車設為 dynamic。
   * - 其他車輛設為 kinematic 並設定對應位置與速度。
   */
  setCars(cars: Iterable<CarState>, self: number | null): void {
    const present = new Set<number>()

    for (const c of cars) {
      present.add(c.c)
      if (!this.knownCars.has(c.c)) {
        this.world.spawn(c.c, c.x, c.z, c.heading)
        this.knownCars.add(c.c)
      }

      if (c.c === self) {
        this.world.setKinematic(c.c, false)
        this.world.setOccupied(c.c, true)
      } else {
        this.world.setKinematic(c.c, true)
        this.world.setOccupied(c.c, c.occupied)
        this.world.setState(c.c, c)
      }
    }

    // 移除已不在列表中的車輛
    for (const id of this.knownCars) {
      if (!present.has(id)) {
        this.world.remove(id)
        this.knownCars.delete(id)
      }
    }

    // 駕駛車輛變更或下車：清空歷史與誤差偏移
    if (this.selfCarId !== self) {
      this.clearHistory()
      this.selfCarId = self
    }
  }

  /**
   * 推送新的駕駛輸入，並排入歷史。
   */
  pushInput(seq: number, input: DriveInput): void {
    this.currentInput = input
    this.history.push({ seq, input })
    if (this.history.length > 120) {
      this.history.shift()
    }
    if (this.selfCarId !== null) {
      this.world.setInput(this.selfCarId, input)
    }
  }

  /**
   * 設定當前輸入（節流未配發 seq 時仍更新物理模擬輸入）。
   */
  setInput(input: DriveInput): void {
    this.currentInput = input
    if (this.selfCarId !== null) {
      this.world.setInput(this.selfCarId, input)
    }
  }

  /**
   * 權威重播校正：
   * 1. 丟掉 seq <= ack 的歷史。
   * 2. 把自己的車設為 server 狀態。
   * 3. 其他車以伺服器速度隨步數外推。
   * 4. 依序重播剩餘的未確認輸入。
   * 5. 依位置差計算誤差偏移並以指數平滑（>3m 則直接瞬移）。
   */
  reconcile(ack: number, server: CarState, others: CarState[]): void {
    if (this.selfCarId === null || server.c !== this.selfCarId) return

    // 1. 丟掉 seq <= ack 的歷史
    let i = 0
    while (i < this.history.length) {
      if (isSeqLe(this.history[i]!.seq, ack)) {
        this.history.splice(i, 1)
      } else {
        i++
      }
    }

    // 記錄校正前玩家眼見的視覺位置
    const prePose = this.world.state(server.c)
    const oldVisualX = prePose ? prePose.x + this.errorOffset.x : server.x
    const oldVisualZ = prePose ? prePose.z + this.errorOffset.z : server.z
    const oldVisualHeading = prePose ? wrapAngle(prePose.heading + this.errorOffset.heading) : server.heading

    // 2. 將自己的車重設為伺服器權威狀態
    this.world.setState(server.c, server)

    // 3. 其他車設成各自的伺服器狀態並隨重播步數外推
    const otherClones = others.map((o) => ({
      c: o.c,
      x: o.x,
      z: o.z,
      heading: o.heading,
      vx: o.vx,
      vz: o.vz,
      w: o.w,
    }))
    for (const o of otherClones) {
      this.world.setState(o.c, o)
    }

    // 4. 重播剩餘輸入
    const dt = 1 / 30
    for (const h of this.history) {
      for (const o of otherClones) {
        o.x += o.vx * dt
        o.z += o.vz * dt
        o.heading = wrapAngle(o.heading + o.w * dt)
        this.world.setState(o.c, o)
      }
      this.world.setInput(server.c, h.input)
      this.world.step()
    }

    // 5. 計算位置差與誤差偏移
    const newPose = this.world.state(server.c)
    if (newPose) {
      const jump = Math.hypot(oldVisualX - newPose.x, oldVisualZ - newPose.z)
      this.correction.last = jump
      this.correction.samples.push(jump)
      if (this.correction.samples.length > 300) {
        this.correction.samples.shift()
      }

      if (jump > 3.0) {
        // 超過 3 公尺直接套用，不平滑
        this.errorOffset.x = 0
        this.errorOffset.z = 0
        this.errorOffset.heading = 0
      } else {
        this.errorOffset.x = oldVisualX - newPose.x
        this.errorOffset.z = oldVisualZ - newPose.z
        this.errorOffset.heading = wrapAngle(oldVisualHeading - newPose.heading)
      }
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('SimWorld has been freed')
    }
  }

  /**
   * 前向物理步進（累加器，固定 1/30 秒，每次最多步進 3 步），
   * 並對誤差偏移施加 exp(-dt * 10) 衰減。
   */
  advance(dt: number): void {
    this.assertNotDisposed()
    // 誤差偏移衰減
    const decay = Math.exp(-dt * 10)
    this.errorOffset.x *= decay
    this.errorOffset.z *= decay
    this.errorOffset.heading *= decay

    if (this.selfCarId === null) {
      this.accumulator = 0
      return
    }

    this.accumulator += dt
    let steps = 0
    while (this.accumulator >= 1 / 30 && steps < 3) {
      this.accumulator -= 1 / 30
      steps++
      this.world.setInput(this.selfCarId, this.currentInput)
      this.world.step()
    }

    if (this.accumulator >= 1 / 30) {
      this.accumulator = 0
    }
  }

  /**
   * 取得本地玩家當前預測位姿（已加入殘餘誤差平滑）。
   */
  selfPose(): { x: number; z: number; heading: number } | null {
    if (this.disposed || this.selfCarId === null) return null
    const s = this.world.state(this.selfCarId)
    if (!s) return null
    return {
      x: s.x + this.errorOffset.x,
      z: s.z + this.errorOffset.z,
      heading: wrapAngle(s.heading + this.errorOffset.heading),
    }
  }

  /**
   * 清空歷史輸入與誤差偏移（切場景、下車、或背景分頁切回前景時調用）。
   */
  clearHistory(): void {
    this.history.length = 0
    this.errorOffset.x = 0
    this.errorOffset.z = 0
    this.errorOffset.heading = 0
  }

  /**
   * 釋放物理世界資源。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearHistory()
    this.selfCarId = null
    this.knownCars.clear()
    this.world.free()
  }
}
