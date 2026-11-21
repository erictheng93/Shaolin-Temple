import type { MessageKey } from '../../i18n/index.ts'
import { BOOTH, type Rect } from './layout.ts'
import type { ZoneDef } from './zones.ts'
import VEHICLES_JSON from '../../../../shared/vehicles.json' with { type: 'json' }

export { BOOTH }

export interface VehicleParams {
  kinds: ReadonlyArray<{
    id: string
    rarity: 'common' | 'rare' | 'mythic'
    count: number
    /** 抽車的權重（伺服器隨機分配時用）。 */
    weight?: number
  }>
  car: {
    halfWidth: number
    halfHeight: number
    halfLength: number
    mass: number
    linearDamping: number
    angularDamping: number
    restitution: number
    friction: number
    maxSpeed: number
    reverseMaxSpeed: number
    driveForce: number
    turnRate: number
    steerGain: number
    steerBlend: number
    lateralGrip: number
    reverseAngle: number
    reverseBelowSpeed: number
  }
  physics: {
    hz: number
    maxCatchUpSteps: number
    broadcastEverySteps: number
    inputTimeoutMs: number
  }
  ride: {
    mountRadius: number
    boothRadius: number
    claimCooldownMs: number
    idleDismountMs: number
    dismountOffset: number
  }
  fade: {
    idleMs: number
    fadeMs: number
  }
  knock: {
    minSpeed: number
    hitRadius: number
    distancePerSpeed: number
    minDistance: number
    maxDistance: number
    flightMs: number
    recoverMs: number
    immuneMs: number
  }
  booth: {
    rect: Rect
    counter: { x: number; z: number }
    bays: ReadonlyArray<{ x: number; z: number; heading: number }>
  }
}

export const VEHICLES: VehicleParams = VEHICLES_JSON as unknown as VehicleParams

export const CAR_PARAMS = {
  radius: VEHICLES.car.halfLength,
}

export const CAR_KINDS: ReadonlyArray<{ id: string; rarity: 'common' | 'rare' | 'mythic'; count: number; label: MessageKey }> = [
  { id: 'classic', rarity: 'common', count: 4, label: 'ride.kind.classic' },
  { id: 'woodfish', rarity: 'common', count: 3, label: 'ride.kind.woodfish' },
  { id: 'racer', rarity: 'rare', count: 2, label: 'ride.kind.racer' },
  { id: 'firewheel', rarity: 'mythic', count: 1, label: 'ride.kind.firewheel' },
]

export interface CarView {
  c: number
  kind: number
  driver: string | null
  x: number
  z: number
  heading: number
  fadeAt: number | null
}

export function knockLanding(
  zone: ZoneDef,
  x: number,
  z: number,
  dx: number,
  dz: number,
  distance: number,
): { x: number; z: number } {
  const stepSize = 0.25
  let lastValid = { x, z }
  let traveled = 0.0

  const inside = (px: number, pz: number): boolean => {
    if (px < zone.bounds.minX || px > zone.bounds.maxX || pz < zone.bounds.minZ || pz > zone.bounds.maxZ) {
      return false
    }
    for (const obs of zone.obstacles) {
      if (px >= obs.minX && px <= obs.maxX && pz >= obs.minZ && pz <= obs.maxZ) {
        return false
      }
    }
    return true
  }

  while (traveled + stepSize <= distance + 1e-6) {
    traveled += stepSize
    const px = x + dx * traveled
    const pz = z + dz * traveled
    if (inside(px, pz)) {
      lastValid = { x: px, z: pz }
    } else {
      return lastValid
    }
  }

  if (distance > traveled + 1e-6) {
    const px = x + dx * distance
    const pz = z + dz * distance
    if (inside(px, pz)) {
      lastValid = { x: px, z: pz }
    }
  }

  return lastValid
}

export function stockLeft(cars: Iterable<{ kind: number }>): number[] {
  const counts = CAR_KINDS.map((k) => k.count)
  for (const car of cars) {
    if (car.kind >= 0 && car.kind < counts.length) {
      counts[car.kind]!--
    }
  }
  return counts.map((c) => Math.max(0, c))
}

export function distanceToCar(car: { x: number; z: number; heading: number }, x: number, z: number): number {
  const relX = x - car.x
  const relZ = z - car.z
  const cosH = Math.cos(car.heading)
  const sinH = Math.sin(car.heading)
  // Local coordinates: forward is +z (sin, cos), right is +x (cos, -sin)
  const localX = relX * cosH - relZ * sinH
  const localZ = relX * sinH + relZ * cosH
  const halfW = VEHICLES.car.halfWidth
  const halfL = VEHICLES.car.halfLength
  const dx = Math.max(0, Math.abs(localX) - halfW)
  const dz = Math.max(0, Math.abs(localZ) - halfL)
  return Math.hypot(dx, dz)
}

export function nearestEmptyCar(cars: Iterable<CarView>, x: number, z: number): CarView | null {
  let nearest: CarView | null = null
  let minDistance = Infinity
  for (const car of cars) {
    if (car.driver !== null) continue
    const d = distanceToCar(car, x, z)
    if (d <= VEHICLES.ride.mountRadius && d < minDistance) {
      nearest = car
      minDistance = d
    }
  }
  return nearest
}

export function nearBooth(x: number, z: number): boolean {
  return Math.hypot(x - VEHICLES.booth.counter.x, z - VEHICLES.booth.counter.z) <= VEHICLES.ride.boothRadius
}

/** 領車 NPC：站在檔口櫃台後、面朝東。y 是腳底高度（墊一張凳子，胸口以上露出櫃台）。衣裝是行腳僧（戴斗笠，好認）。 */
export const BOOTH_NPC = { x: -13.45, y: 0.75, z: 9.25, heading: Math.PI / 2, outfit: 6 }
