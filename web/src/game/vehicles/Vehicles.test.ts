import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Vehicles } from './Vehicles'
import type { CarFleet } from '../render/CarFleet'
import type { NetworkClient } from '../net/NetworkClient'
import { VEHICLES } from '../world/vehicles'

describe('Vehicles 子系統', () => {
  let mockFleet: { sync: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
  let mockNet: { sendClaim: ReturnType<typeof vi.fn>; sendRide: ReturnType<typeof vi.fn>; sendDrive: ReturnType<typeof vi.fn> }
  let selfId: string | null = 'me'
  let vehicles: Vehicles

  beforeEach(() => {
    selfId = 'me'
    mockFleet = {
      sync: vi.fn(),
      dispose: vi.fn(),
    }
    mockNet = {
      sendClaim: vi.fn(),
      sendRide: vi.fn(),
      sendDrive: vi.fn(),
    }
    vehicles = new Vehicles({
      fleet: mockFleet as unknown as CarFleet,
      net: mockNet as unknown as Pick<NetworkClient, 'sendClaim' | 'sendRide' | 'sendDrive'>,
      selfId: () => selfId,
    })
  })

  it('welcome 重建車的清單且清除騎乘狀態', () => {
    // 斷線前騎乘中
    vehicles.onCar({ c: 1, kind: 0, driver: 'me', x: 0, z: 0, heading: 0, fadeAt: null })
    expect(vehicles.riding).toBe(1)

    // 重連收到 welcome，快照中自己沒有在開車
    vehicles.onWelcome([
      { c: 2, kind: 1, driver: 'other', x: 5, z: 5, heading: 0, fadeAt: null },
    ])
    expect(vehicles.riding).toBeNull()
    // 車數等於快照
    expect(vehicles.riderCar('other')).toEqual({ x: 5, z: 5, heading: 0 })
    expect(vehicles.riderCar('me')).toBeNull()
  })

  it('car 訊息的 driver 是自己時 riding 變成該編號', () => {
    expect(vehicles.riding).toBeNull()
    vehicles.onCar({ c: 3, kind: 2, driver: 'me', x: 1, z: 2, heading: 0.5, fadeAt: null })
    expect(vehicles.riding).toBe(3)

    // 換其他人開或下車
    vehicles.onCar({ c: 3, kind: 2, driver: 'someone_else', x: 1, z: 2, heading: 0.5, fadeAt: null })
    expect(vehicles.riding).toBeNull()
  })

  it('時段結束：伺服器廣播 driver 為 null 的 car 時，本機騎乘狀態清除且車仍在（之後淡出）', () => {
    vehicles.onCar({ c: 5, kind: 1, driver: 'me', x: 0, z: 0, heading: 0, fadeAt: null })
    expect(vehicles.riding).toBe(5)
    vehicles.onCar({ c: 5, kind: 1, driver: null, x: 0, z: 0, heading: 0, fadeAt: Date.now() + 15000 })
    expect(vehicles.riding).toBeNull()
    expect(vehicles.riderCar('me')).toBeNull()
  })

  it('carGone 移除車並在 riding 相同時清除騎乘', () => {
    vehicles.onCar({ c: 4, kind: 0, driver: 'me', x: 0, z: 0, heading: 0, fadeAt: null })
    expect(vehicles.riding).toBe(4)

    vehicles.onCarGone(4)
    expect(vehicles.riding).toBeNull()
    expect(vehicles.riderCar('me')).toBeNull()
  })

  const lastShown = (): { x: number; z: number; heading: number } => {
    const calls = mockFleet.sync.mock.calls
    return calls[calls.length - 1]![0][0]
  }
  const moving = (x: number, vx: number) => ({ c: 0, occupied: true, bumped: false, x, z: 0, heading: Math.PI / 2, vx, vz: 0, w: 0 })

  it('別人的車依伺服器給的速度推算到現在', () => {
    vehicles.onCar({ c: 0, kind: 0, driver: 'other', x: 0, z: 0, heading: Math.PI / 2, fadeAt: null })
    vehicles.update(1000, 1000, 0)
    vehicles.onCars(0, [moving(0, 6)], 1000)

    // 50 毫秒後：0 + 6 m/s × 0.05 s
    vehicles.update(1050, 1050, 0.05)
    expect(lastShown().x).toBeCloseTo(0.3, 3)
    // 一直沒有新的狀態：最多推算 0.25 秒就停住，不會一路開出去
    vehicles.update(3000, 3000, 0.05)
    expect(lastShown().x).toBeCloseTo(1.5, 3)
  })

  it('封包晚到（網路抖動）時畫面上的車維持等速', () => {
    vehicles.onCar({ c: 0, kind: 0, driver: 'other', x: 0, z: 0, heading: Math.PI / 2, fadeAt: null })
    const frame = (VEHICLES.physics.broadcastEverySteps / VEHICLES.physics.hz) * 1000
    // 伺服器每 frame 毫秒送一則、車以 6 m/s 前進；到達時間輪流晚 0、30、10、40 毫秒
    const late = [0, 30, 10, 40]
    const arrivals = Array.from({ length: 40 }, (_, k) => ({ at: 1000 + k * frame + late[k % 4]!, x: (6 * k * frame) / 1000 }))
    const speeds: number[] = []
    let prev: number | null = null
    for (let t = 1000; t < 1000 + 39 * frame; t += 16) {
      while (arrivals.length && arrivals[0]!.at <= t) {
        const a = arrivals.shift()!
        vehicles.onCars(0, [moving(a.x, 6)], a.at)
      }
      vehicles.update(t, t, 0.016)
      const x = lastShown().x
      if (prev !== null && t > 1500) speeds.push((x - prev) / 0.016)
      prev = x
    }
    expect(Math.min(...speeds)).toBeGreaterThan(5.4)
    expect(Math.max(...speeds)).toBeLessThan(6.6)
  })

  it('新狀態與畫面有落差時滑過去，不會跳', () => {
    vehicles.onCar({ c: 0, kind: 0, driver: null, x: 0, z: 9, heading: 0, fadeAt: null })
    vehicles.update(1000, 1000, 0)
    vehicles.onCars(1, [{ c: 0, occupied: false, bumped: false, x: 2, z: 9, heading: 0, vx: 0, vz: 0, w: 0 }], 1000)

    vehicles.update(1016, 1016, 0.016)
    expect(lastShown().x).toBeGreaterThan(0)
    expect(lastShown().x).toBeLessThan(0.5)
    for (let t = 1032; t <= 2000; t += 16) vehicles.update(t, t, 0.016)
    expect(lastShown().x).toBeCloseTo(2, 2)
  })

  it('超過 5 公尺直接套用', () => {
    vehicles.onCar({ c: 0, kind: 0, driver: null, x: 0, z: 0, heading: 0, fadeAt: null })
    vehicles.onCars(0, [{ c: 0, occupied: false, bumped: false, x: 0, z: 0, heading: 0, vx: 0, vz: 0, w: 0 }], 1000)

    // 突變 10 公尺 (> 5m SNAP)
    vehicles.onCars(1, [{ c: 0, occupied: false, bumped: false, x: 10, z: 0, heading: 0, vx: 0, vz: 0, w: 0 }], 1100)
    vehicles.update(1100, 1100, 0.05)

    expect(lastShown().x).toBe(10)
  })

  it('推算的位置不會畫到庭院邊界外', () => {
    vehicles.onCar({ c: 0, kind: 0, driver: 'other', x: 18, z: 0, heading: Math.PI / 2, fadeAt: null })
    vehicles.update(1000, 1000, 0)
    vehicles.onCars(0, [moving(18, 8)], 1000)
    vehicles.update(1200, 1200, 0.2)
    // 車頭朝 +x：車身在 x 方向佔半個車長
    expect(lastShown().x).toBeLessThanOrEqual(19 - VEHICLES.car.halfLength + 1e-9)
  })

  it('淡出的不透明度（fadeAt 前為 1、過一半為 0.5、結束為 0）', () => {
    const fadeAt = 100000
    const fadeMs = VEHICLES.fade.fadeMs // 15000
    vehicles.onCar({ c: 0, kind: 0, driver: null, x: 0, z: 0, heading: 0, fadeAt })

    // fadeAt 之前
    vehicles.update(1000, fadeAt - 1000, 0.05)
    let syncList = mockFleet.sync.mock.calls[mockFleet.sync.mock.calls.length - 1]![0]
    expect(syncList[0].opacity).toBe(1)

    // 過一半
    vehicles.update(1000, fadeAt + fadeMs / 2, 0.05)
    syncList = mockFleet.sync.mock.calls[mockFleet.sync.mock.calls.length - 1]![0]
    expect(syncList[0].opacity).toBeCloseTo(0.5, 2)

    // 結束
    vehicles.update(1000, fadeAt + fadeMs + 100, 0.05)
    syncList = mockFleet.sync.mock.calls[mockFleet.sync.mock.calls.length - 1]![0]
    expect(syncList[0].opacity).toBe(0)
  })

  it('ui() 在檔口旁回傳各車種剩餘數', () => {
    const cx = VEHICLES.booth.counter.x // -12.0
    const cz = VEHICLES.booth.counter.z // 9.25

    // 場景已有 kind 0 一台，kind 3 一台
    vehicles.onCar({ c: 0, kind: 0, driver: null, x: 0, z: 0, heading: 0, fadeAt: null })
    vehicles.onCar({ c: 1, kind: 3, driver: null, x: 0, z: 0, heading: 0, fadeAt: null })

    // 站在櫃檯旁 (距離 <= boothRadius 2.5m)
    const uiNear = vehicles.ui(cx, cz)
    expect(uiNear.booth).not.toBeNull()
    // 配額：kind 0 限 4，kind 1 限 3，kind 2 限 2，kind 3 限 1
    // 剩餘：[4 - 1, 3, 2, 1 - 1] = [3, 3, 2, 0]
    expect(uiNear.booth?.left).toEqual([3, 3, 2, 0])

    // 站得太遠 (x = 0, z = 0)
    const uiFar = vehicles.ui(0, 0)
    expect(uiFar.booth).toBeNull()
  })

  it('toggleRide 在沒有空車時不送出', () => {
    // 沒有任何車
    vehicles.toggleRide(0, 0)
    expect(mockNet.sendRide).not.toHaveBeenCalled()

    // 附近有一台已被佔用的車
    vehicles.onCar({ c: 0, kind: 0, driver: 'someone', x: 0.5, z: 0.5, heading: 0, fadeAt: null })
    vehicles.toggleRide(0, 0)
    expect(mockNet.sendRide).not.toHaveBeenCalled()

    // 附近出現一台空車（距離 <= mountRadius 2.0m）
    vehicles.onCar({ c: 1, kind: 0, driver: null, x: 0.8, z: 0.8, heading: 0, fadeAt: null })
    vehicles.toggleRide(0, 0)
    expect(mockNet.sendRide).toHaveBeenCalledWith(1)

    // 自己已在騎乘中 -> toggleRide 代表下車
    mockNet.sendRide.mockClear()
    vehicles.onCar({ c: 1, kind: 0, driver: 'me', x: 0.8, z: 0.8, heading: 0, fadeAt: null })
    expect(vehicles.riding).toBe(1)
    vehicles.toggleRide(0, 0)
    expect(mockNet.sendRide).toHaveBeenCalledWith(null)
  })

  it('切到殿內後 update 不畫車', () => {
    vehicles.onCar({ c: 0, kind: 0, driver: null, x: 0, z: 0, heading: 0, fadeAt: null })

    vehicles.setLocalZone('hall')
    const active = vehicles.update(1000, 1000, 0.05)
    expect(active).toBe(false)
    const lastSync = mockFleet.sync.mock.calls[mockFleet.sync.mock.calls.length - 1]![0]
    expect(lastSync).toEqual([])

    vehicles.setLocalZone('courtyard')
    vehicles.update(1000, 1000, 0.05)
    const courtSync = mockFleet.sync.mock.calls[mockFleet.sync.mock.calls.length - 1]![0]
    expect(courtSync).toHaveLength(1)
  })
})
