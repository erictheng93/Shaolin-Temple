import { describe, expect, it } from 'vitest'
import {
  BOOTH,
  CAR_KINDS,
  distanceToCar,
  knockLanding,
  nearBooth,
  nearestEmptyCar,
  sessionBlocks,
  sessionState,
  formatCountdown,
  stockLeft,
  VEHICLES,
  type CarView,
} from './vehicles'
import { OBSTACLES, PLAYER_RADIUS } from './layout'
import { ZONES } from './zones'
import { findPath } from './pathfind'

describe('vehicles', () => {
  it('CAR_KINDS 包含 4 種車且數量總和為 10', () => {
    expect(CAR_KINDS).toHaveLength(4)
    expect(CAR_KINDS.reduce((sum, k) => sum + k.count, 0)).toBe(10)
    expect(CAR_KINDS.map((k) => k.id)).toEqual(['classic', 'woodfish', 'racer', 'firewheel'])
  })

  it('檔口與停車位不卡進障礙物', () => {
    const boothObstacle = OBSTACLES.find(
      (o) =>
        Math.abs(o.minX - (BOOTH.minX - PLAYER_RADIUS)) < 1e-4 &&
        Math.abs(o.maxX - (BOOTH.maxX + PLAYER_RADIUS)) < 1e-4,
    )
    expect(boothObstacle).toBeDefined()

    const pointsToCheck = [
      ...VEHICLES.booth.bays.map((bay, i) => ({ name: `停車位 ${i}`, x: bay.x, z: bay.z })),
      { name: '櫃台前站位', x: VEHICLES.booth.counter.x, z: VEHICLES.booth.counter.z },
    ]
    for (const pt of pointsToCheck) {
      for (const obs of OBSTACLES) {
        const inside = pt.x >= obs.minX && pt.x <= obs.maxX && pt.z >= obs.minZ && pt.z <= obs.maxZ
        expect(inside, `${pt.name} (${pt.x}, ${pt.z}) 卡進障礙物 ${JSON.stringify(obs)}`).toBe(false)
      }
    }

    const courtyard = ZONES.courtyard
    const path = findPath(courtyard.spawn, courtyard.portals[0]!.spawn, {
      speed: 3.2,
      bounds: courtyard.bounds,
      obstacles: courtyard.obstacles,
    })
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThan(0)
  })

  it('knockLanding 與伺服器同規則', () => {
    const courtyard = ZONES.courtyard
    const landing1 = knockLanding(courtyard, 0.0, 0.0, 0.0, -1.0, 5.0)
    for (const obs of courtyard.obstacles) {
      const inside =
        landing1.x >= obs.minX && landing1.x <= obs.maxX && landing1.z >= obs.minZ && landing1.z <= obs.maxZ
      expect(inside).toBe(false)
    }
    expect(landing1.z).toBeGreaterThan(-1.5)

    const landing2 = knockLanding(courtyard, 18.0, 0.0, 1.0, 0.0, 5.0)
    expect(landing2.x).toBe(19.0)
    expect(landing2.z).toBe(0.0)
  })

  it('stockLeft：場上有 2 台 classic、1 台 firewheel → [2, 3, 2, 0]', () => {
    const fieldCars = [
      { kind: 0 },
      { kind: 0 },
      { kind: 3 },
    ]
    expect(stockLeft(fieldCars)).toEqual([2, 3, 2, 0])
  })

  it('nearestEmptyCar 忽略有人的車與太遠的車', () => {
    const cars: CarView[] = [
      { c: 1, kind: 0, driver: 'player-1', x: 0.5, z: 0.0, heading: 0, fadeAt: null },
      { c: 2, kind: 1, driver: null, x: 5.0, z: 0.0, heading: 0, fadeAt: null },
      { c: 3, kind: 2, driver: null, x: 1.2, z: 0.0, heading: 0, fadeAt: null },
      { c: 4, kind: 3, driver: null, x: 0.8, z: 0.0, heading: 0, fadeAt: null },
    ]
    const nearest = nearestEmptyCar(cars, 0.0, 0.0)
    expect(nearest).not.toBeNull()
    expect(nearest!.c).toBe(4)

    const occupiedOnly = cars.slice(0, 2)
    expect(nearestEmptyCar(occupiedOnly, 0.0, 0.0)).toBeNull()
  })

  it('distanceToCar 在車身內為 0，車身外為定向包圍盒距離', () => {
    const car = { x: 0.0, z: 0.0, heading: 0.0 }
    expect(distanceToCar(car, 0.0, 0.0)).toBe(0)
    expect(distanceToCar(car, 0.3, 0.5)).toBe(0)
    expect(distanceToCar(car, 0.55, 0.0)).toBe(0)
    expect(distanceToCar(car, 0.0, 0.9)).toBe(0)
    expect(distanceToCar(car, 1.55, 0.0)).toBeCloseTo(1.0)
    expect(distanceToCar(car, 0.0, 1.4)).toBeCloseTo(0.5)

    const rotatedCar = { x: 0.0, z: 0.0, heading: Math.PI / 2 }
    expect(distanceToCar(rotatedCar, 0.8, 0.0)).toBe(0)
    expect(distanceToCar(rotatedCar, 0.0, 0.5)).toBe(0)
    expect(distanceToCar(rotatedCar, 1.9, 0.0)).toBeCloseTo(1.0)
  })

  it('nearBooth 正確判斷是否在檔口櫃台半徑內', () => {
    const counter = VEHICLES.booth.counter
    expect(nearBooth(counter.x, counter.z)).toBe(true)
    expect(nearBooth(counter.x + 1.0, counter.z)).toBe(true)
    expect(nearBooth(counter.x + 3.0, counter.z)).toBe(false)
  })
})

describe('廟會時段', () => {
  it('邊界：0 與 1_799_999 開放；1_800_000 與 3_599_999 關閉；3_600_000 又開放', () => {
    expect(sessionState(0).open).toBe(true)
    expect(sessionState(1_799_999).open).toBe(true)
    expect(sessionState(1_800_000).open).toBe(false)
    expect(sessionState(3_599_999).open).toBe(false)
    expect(sessionState(3_600_000).open).toBe(true)
  })

  it('msToChange 是距離下一次開／關的毫秒數', () => {
    expect(sessionState(0).msToChange).toBe(1_800_000)
    expect(sessionState(1_799_999).msToChange).toBe(1)
    expect(sessionState(1_800_000).msToChange).toBe(1_800_000)
    expect(sessionState(3_599_999).msToChange).toBe(1)
    expect(sessionState(3_600_000 * 5 + 600_000).msToChange).toBe(1_200_000)
  })

  it('時段關閉時擋上車與領車，下車與開放時不擋', () => {
    const closed = { open: false }
    expect(sessionBlocks('mount', closed)).toBe(true)
    expect(sessionBlocks('talk', closed)).toBe(true)
    expect(sessionBlocks('dismount', closed)).toBe(false)
    expect(sessionBlocks('mount', { open: true })).toBe(false)
    expect(sessionBlocks('mount', undefined)).toBe(false)
    expect(sessionBlocks(null, closed)).toBe(false)
  })

  it('formatCountdown 顯示 mm:ss', () => {
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(65)).toBe('01:05')
    expect(formatCountdown(1800)).toBe('30:00')
  })
})
