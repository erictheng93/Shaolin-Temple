import type { CarFleet, CarInstance } from '../render/CarFleet'
import type { NetworkClient } from '../net/NetworkClient'
import type { CarSnapshot, CarState } from '../net/protocol'
import { REMOTE_SNAP_DISTANCE, sampleBetween, stepDuration, type Sample } from '../world/interp'
import { VEHICLES } from '../world/vehicles'
import type { ZoneId } from '../world/zones'

export interface CarPose {
  x: number
  z: number
  heading: number
}

export interface RideUi {
  riding: boolean
  nearCar: boolean
  booth: { left: number[] } | null
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
}

/**
 * 碰碰車客戶端子系統：管理場景車輛狀態、插值、駕駛輸入與騎乘 UI 狀態。
 */
export class Vehicles {
  private readonly cars = new Map<number, LocalCar>()
  private _riding: number | null = null
  private zone: ZoneId = 'courtyard'
  private stickMag = 0

  constructor(private readonly deps: VehiclesDeps) {}

  get riding(): number | null {
    return this._riding
  }

  setLocalZone(zone: ZoneId): void {
    this.zone = zone
  }

  onWelcome(cars: CarSnapshot[]): void {
    this.cars.clear()
    this._riding = null
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
      this._riding = m.c
    } else if (this._riding === m.c && m.driver !== self) {
      this._riding = null
    }
  }

  onCarGone(c: number): void {
    this.cars.delete(c)
    if (this._riding === c) {
      this._riding = null
    }
  }

  onCars(_ack: number, cars: CarState[], now: number): void {
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
  }

  riderCar(playerId: string): CarPose | null {
    if (this._riding !== null) {
      const self = this.deps.selfId()
      if (playerId === (self ?? '') || playerId === 'local') {
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
      this.deps.net.sendDrive(dir, mag)
    }
  }

  claim(kind: number): void {
    this.deps.net.sendClaim(kind)
  }

  toggleRide(localX: number, localZ: number): void {
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

  update(now: number, serverNow: number, _dt: number): boolean {
    if (this.zone !== 'courtyard') {
      this.deps.fleet.sync([], now)
      return false
    }

    let active = false
    const instances: CarInstance[] = []

    for (const car of this.cars.values()) {
      sampleBetween(car.from, car.to, now, car)
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
        x: car.x,
        z: car.z,
        heading: car.heading,
        opacity,
      })
    }

    this.deps.fleet.sync(instances, now)

    if (this._riding !== null && this.stickMag > 0.01) {
      active = true
    }

    return active
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
    this.cars.clear()
    this._riding = null
    this.deps.fleet.dispose()
  }
}
