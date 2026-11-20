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

  it('carGone 移除車並在 riding 相同時清除騎乘', () => {
    vehicles.onCar({ c: 4, kind: 0, driver: 'me', x: 0, z: 0, heading: 0, fadeAt: null })
    expect(vehicles.riding).toBe(4)

    vehicles.onCarGone(4)
    expect(vehicles.riding).toBeNull()
    expect(vehicles.riderCar('me')).toBeNull()
  })

  it('cars 幀在兩筆之間插值', () => {
    vehicles.onCar({ c: 0, kind: 0, driver: null, x: 0, z: 0, heading: 0, fadeAt: null })

    // 第一筆位置到達 t=1000
    vehicles.onCars(0, [{ c: 0, occupied: false, bumped: false, x: 0, z: 0, heading: 0, vx: 0, vz: 0, w: 0 }], 1000)
    // 第二筆位置到達 t=1100，移動到 x=4 (< 5m SNAP)
    vehicles.onCars(1, [{ c: 0, occupied: false, bumped: false, x: 4, z: 0, heading: 0, vx: 0, vz: 0, w: 0 }], 1100)

    // 在 t=1150 時更新（走到預計 100ms 間隔的一半）
    vehicles.update(1150, 1150, 0.05)
    expect(mockFleet.sync).toHaveBeenCalled()
    const lastSync = mockFleet.sync.mock.calls[mockFleet.sync.mock.calls.length - 1]![0]
    expect(lastSync).toHaveLength(1)
    expect(lastSync[0].x).toBeCloseTo(2, 1)
  })

  it('超過 5 公尺直接套用', () => {
    vehicles.onCar({ c: 0, kind: 0, driver: null, x: 0, z: 0, heading: 0, fadeAt: null })
    vehicles.onCars(0, [{ c: 0, occupied: false, bumped: false, x: 0, z: 0, heading: 0, vx: 0, vz: 0, w: 0 }], 1000)

    // 突變 10 公尺 (> 5m SNAP)
    vehicles.onCars(1, [{ c: 0, occupied: false, bumped: false, x: 10, z: 0, heading: 0, vx: 0, vz: 0, w: 0 }], 1100)
    vehicles.update(1100, 1100, 0.05)

    const lastSync = mockFleet.sync.mock.calls[mockFleet.sync.mock.calls.length - 1]![0]
    expect(lastSync[0].x).toBe(10)
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
