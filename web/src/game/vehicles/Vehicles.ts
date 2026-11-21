import { dequantizeDrive, quantizeDrive } from './drive'
import type { CarFleet, CarInstance } from '../render/CarFleet'
import type { NetworkClient } from '../net/NetworkClient'
import type { CarSnapshot, CarState } from '../net/protocol'
import { REMOTE_SNAP_DISTANCE, sampleBetween, stepDuration, type Sample } from '../world/interp'
import { VEHICLES } from '../world/vehicles'
import type { ZoneId } from '../world/zones'
import { VehicleSim } from './VehicleSim'

export interface CarPose {
  x: number
  z: number
  heading: number
}

export interface RideUi {
  riding: boolean
  nearCar: boolean
  booth: { left: number[] } | null
  /** 領車視窗（GameCore 填入）：是否開啟、等待伺服器中、剛抽到的車種、被拒絕的原因（字典 key）。 */
  claim?: { open: boolean; pending: boolean; result: number | null; error: string | null }
}

interface LocalCar {
  c: number
  kind: number
  driver: string | null
  x: number
  z: number
  heading: number
  fadeAt: number | null
  from: Sample
  to: Sample
  lastMoveAt: number
}

export interface VehiclesDeps {
  fleet: CarFleet
  net: Pick<NetworkClient, 'sendClaim' | 'sendRide' | 'sendDrive'>
  selfId: () => string | null
  sim?: VehicleSim | null
  /** 估計的來回延遲（毫秒）；校正時依它決定要重播幾步。沒有時當作 0。 */
  rttMs?: () => number | null
}

function getNetworkConnection(): { saveData?: boolean; effectiveType?: string } | undefined {
  if (typeof navigator === 'undefined') return undefined
  const nav = navigator as any
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection
  if (!conn) return undefined
  return {
    saveData: Boolean(conn.saveData),
    effectiveType: conn.effectiveType,
  }
}

/**
 * 碰碰車客戶端子系統：管理場景車輛狀態、插值、駕駛輸入、客戶端預測與騎乘 UI 狀態。
 */
export class Vehicles {
  private readonly cars = new Map<number, LocalCar>()
  private _riding: number | null = null
  private zone: ZoneId = 'courtyard'
  private stickMag = 0
  private sim: VehicleSim | null = null
  private loadingSim = false
  private simLoadAttempted = false

  constructor(private readonly deps: VehiclesDeps) {
    if (deps.sim !== undefined) {
      this.sim = deps.sim
      this.simLoadAttempted = true
    }
  }

  get riding(): number | null {
    return this._riding
  }

  /**
   * 取得預測校正的 p95 誤差（公尺），若尚未啟用預測或無樣本則為 null。
   */
  get correctionP95(): number | null {
    if (!this.sim) return null
    const samples = this.sim.correction.samples
    if (samples.length === 0) return null
    const sorted = [...samples].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    return sorted[idx] ?? null
  }

  private maybeLoadSim(): void {
    if (this.simLoadAttempted || this.loadingSim || this.sim) return
    const netInfo = getNetworkConnection()
    if (!VehicleSim.shouldLoad(netInfo)) return
    this.simLoadAttempted = true
    this.loadingSim = true
    VehicleSim.load().then(
      (sim) => {
        this.loadingSim = false
        this.sim = sim
        if (sim && this._riding !== null) {
          sim.setCars(this.getCarStates(), this._riding)
        }
      },
      (err) => {
        console.warn('VehicleSim load failed, continuing with interpolation:', err)
        this.loadingSim = false
      },
    )
  }

  private getCarStates(): CarState[] {
    const res: CarState[] = []
    for (const car of this.cars.values()) {
      res.push({
        c: car.c,
        occupied: car.driver !== null,
        bumped: false,
        x: car.x,
        z: car.z,
        heading: car.heading,
        vx: 0,
        vz: 0,
        w: 0,
      })
    }
    return res
  }

  setLocalZone(zone: ZoneId): void {
    this.zone = zone
    if (zone !== 'courtyard') {
      this.sim?.clearHistory()
      this.sim?.setCars([], null)
    }
  }

  onVisibilityChange(hidden: boolean): void {
    if (!hidden) {
      // 從背景切回前景時清空歷史輸入與平滑偏移，等待下一則權威廣播
      this.sim?.clearHistory()
    }
  }

  onWelcome(cars: CarSnapshot[]): void {
    this.cars.clear()
    this._riding = null
    this.sim?.clearHistory()
    this.sim?.setCars([], null)
    const now = performance.now()
    const self = this.deps.selfId()

    for (const c of cars) {
      const car: LocalCar = {
        c: c.c,
        kind: c.kind,
        driver: c.driver,
        x: c.x,
        z: c.z,
        heading: c.heading,
        fadeAt: c.fadeAt,
        from: { x: c.x, z: c.z, heading: c.heading, t: now },
        to: { x: c.x, z: c.z, heading: c.heading, t: now },
        lastMoveAt: now,
      }
      this.cars.set(c.c, car)
      if (self && c.driver === self) {
        this._riding = c.c
      }
    }

    if (this._riding !== null) {
      this.sim?.setCars(this.getCarStates(), this._riding)
    }
  }

  onCar(m: CarSnapshot): void {
    const now = performance.now()
    const existing = this.cars.get(m.c)
    if (existing) {
      existing.kind = m.kind
      existing.driver = m.driver
      existing.fadeAt = m.fadeAt
    } else {
      const car: LocalCar = {
        c: m.c,
        kind: m.kind,
        driver: m.driver,
        x: m.x,
        z: m.z,
        heading: m.heading,
        fadeAt: m.fadeAt,
        from: { x: m.x, z: m.z, heading: m.heading, t: now },
        to: { x: m.x, z: m.z, heading: m.heading, t: now },
        lastMoveAt: now,
      }
      this.cars.set(m.c, car)
    }

    const self = this.deps.selfId()
    if (self && m.driver === self) {
      if (this._riding !== m.c) {
        this._riding = m.c
        this.sim?.setCars(this.getCarStates(), this._riding)
      }
    } else if (this._riding === m.c && m.driver !== self) {
      this._riding = null
      this.sim?.clearHistory()
      this.sim?.setCars(this.getCarStates(), null)
    }
  }

  onCarGone(c: number): void {
    this.cars.delete(c)
    if (this._riding === c) {
      this._riding = null
      this.sim?.clearHistory()
      this.sim?.setCars(this.getCarStates(), null)
    }
  }

  onCars(ack: number, cars: CarState[], now: number): void {
    for (const s of cars) {
      const car = this.cars.get(s.c)
      if (!car) continue

      if (Math.hypot(s.x - car.x, s.z - car.z) > REMOTE_SNAP_DISTANCE) {
        car.x = s.x
        car.z = s.z
        car.heading = s.heading
        car.from = { x: s.x, z: s.z, heading: s.heading, t: now }
        car.to = car.from
        car.lastMoveAt = now
        continue
      }

      sampleBetween(car.from, car.to, now, car)
      car.from = { x: car.x, z: car.z, heading: car.heading, t: now }
      car.to = { x: s.x, z: s.z, heading: s.heading, t: now + stepDuration(now - car.lastMoveAt) }
      car.lastMoveAt = now
    }

    if (this.sim !== null && this._riding !== null) {
      const selfCar = cars.find((c) => c.c === this._riding)
      if (selfCar) {
        const others = cars.filter((c) => c.c !== this._riding)
        // 伺服器的狀態對應到本機大約一個來回延遲之前的時間點，要把這段時間重播回來。
        const lagSteps = Math.max(0, Math.min(15, Math.round(((this.deps.rttMs?.() ?? 0) / 1000) * VEHICLES.physics.hz)))
        this.sim.reconcile(ack, selfCar, others, lagSteps)
      }
    }
  }

  riderCar(playerId: string): CarPose | null {
    if (this._riding !== null) {
      const self = this.deps.selfId()
      if (playerId === (self ?? '') || playerId === 'local') {
        if (this.sim !== null) {
          const pose = this.sim.selfPose()
          if (pose) return pose
        }
        const car = this.cars.get(this._riding)
        if (car) return { x: car.x, z: car.z, heading: car.heading }
      }
    }
    for (const car of this.cars.values()) {
      if (car.driver === playerId) {
        return { x: car.x, z: car.z, heading: car.heading }
      }
    }
    return null
  }

  setStick(dirX: number, dirZ: number): void {
    const mag = Math.min(1, Math.hypot(dirX, dirZ))
    this.stickMag = mag
    if (this._riding !== null) {
      const dir = mag > 0.01 ? Math.atan2(dirX, dirZ) : 0
      const seq = this.deps.net.sendDrive(dir, mag)
      if (this.sim !== null) {
        // 預測用伺服器會看到的量化值，否則方向與油門有系統性的小誤差。
        const q = quantizeDrive(dir, mag)
        const input = dequantizeDrive(q.dir, q.mag)
        if (seq !== null) {
          this.sim.pushInput(seq, input)
        } else {
          this.sim.setInput(input)
        }
      }
    }
  }

  claim(): void {
    this.maybeLoadSim()
    this.deps.net.sendClaim()
  }

  toggleRide(localX: number, localZ: number): void {
    this.maybeLoadSim()
    if (this._riding !== null) {
      this.deps.net.sendRide(null)
      return
    }

    let nearest: LocalCar | null = null
    let nearestDist = Infinity
    for (const car of this.cars.values()) {
      if (car.driver !== null) continue
      const d = Math.hypot(car.x - localX, car.z - localZ)
      if (d <= VEHICLES.ride.mountRadius && d < nearestDist) {
        nearestDist = d
        nearest = car
      }
    }

    if (nearest) {
      this.deps.net.sendRide(nearest.c)
    }
  }

  update(now: number, serverNow: number, dt: number): boolean {
    if (this.zone !== 'courtyard') {
      this.deps.fleet.sync([], now)
      return false
    }

    let active = false
    if (this.sim !== null && this._riding !== null) {
      this.sim.advance(dt)
      active = true
    }

    const instances: CarInstance[] = []

    for (const car of this.cars.values()) {
      let x = car.x
      let z = car.z
      let heading = car.heading

      if (this.sim !== null && this._riding === car.c) {
        const pose = this.sim.selfPose()
        if (pose) {
          x = pose.x
          z = pose.z
          heading = pose.heading
          car.x = x
          car.z = z
          car.heading = heading
        }
      } else {
        sampleBetween(car.from, car.to, now, car)
        x = car.x
        z = car.z
        heading = car.heading
      }

      if (
        now < car.to.t &&
        (car.from.x !== car.to.x || car.from.z !== car.to.z || car.from.heading !== car.to.heading)
      ) {
        active = true
      }

      let opacity = 1
      if (car.fadeAt !== null && car.fadeAt > 0) {
        opacity = Math.max(0, Math.min(1, (car.fadeAt + VEHICLES.fade.fadeMs - serverNow) / VEHICLES.fade.fadeMs))
        if (opacity > 0 && opacity < 1) active = true
      }

      instances.push({
        c: car.c,
        kind: car.kind,
        x,
        z,
        heading,
        opacity,
      })
    }

    this.deps.fleet.sync(instances, now)

    if (this._riding !== null && this.stickMag > 0.01) {
      active = true
    }

    return active
  }

  /**
   * 庭院中的空車（沒有駕駛），用於行走推車阻力區（slowZones）。
   */
  *slowZones(): Iterable<{ x: number; z: number; heading: number }> {
    if (this.zone !== 'courtyard') return
    for (const car of this.cars.values()) {
      if (car.driver === null) {
        yield { x: car.x, z: car.z, heading: car.heading }
      }
    }
  }

  ui(localX: number, localZ: number): RideUi {
    const riding = this._riding !== null
    let nearCar = false
    if (!riding) {
      for (const car of this.cars.values()) {
        if (car.driver !== null) continue
        if (Math.hypot(car.x - localX, car.z - localZ) <= VEHICLES.ride.mountRadius) {
          nearCar = true
          break
        }
      }
    }

    let booth: { left: number[] } | null = null
    const counterDist = Math.hypot(localX - VEHICLES.booth.counter.x, localZ - VEHICLES.booth.counter.z)
    if (counterDist <= VEHICLES.ride.boothRadius) {
      this.maybeLoadSim()
      const counts = [0, 0, 0, 0]
      for (const car of this.cars.values()) {
        if (car.kind >= 0 && car.kind < 4) {
          counts[car.kind] = (counts[car.kind] ?? 0) + 1
        }
      }
      const left = VEHICLES.kinds.map((k, i) => Math.max(0, k.count - (counts[i] ?? 0)))
      booth = { left }
    }

    return {
      riding,
      nearCar,
      booth,
    }
  }

  dispose(): void {
    this.sim?.dispose()
    this.sim = null
    this.cars.clear()
    this._riding = null
    this.deps.fleet.dispose()
  }
}
