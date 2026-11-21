import { beforeAll, describe, expect, it } from 'vitest'
import RAPIER from '@dimforge/rapier3d-compat'
import { DISPLAY_LEAD, VehicleSim, isSeqLe } from './VehicleSim'
import { createSimWorld, type CarState } from './simCore'
import { VEHICLES } from '../world/vehicles'
import { SOLIDS, WORLD_BOUNDS } from '../world/layout'
import { Vehicles } from './Vehicles'

describe('VehicleSim (客戶端車輛預測與重播校正)', () => {
  beforeAll(async () => {
    await RAPIER.init()
  })

  function createTestSim(): VehicleSim {
    const world = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
    return new VehicleSim(world)
  }

  function makeCar(c: number, x = 0, z = 0, heading = 0): CarState {
    return {
      c,
      occupied: true,
      bumped: false,
      x,
      z,
      heading,
      vx: 0,
      vz: 0,
      w: 0,
    }
  }

  it('1. 延遲 150 ms、直線行駛時預測位置與伺服器最終位置相差小於 5 公分', () => {
    // 建立伺服器世界與客戶端世界
    const serverWorld = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
    const clientSim = createTestSim()

    const startX = 0
    const startZ = 0
    const startHeading = 0
    serverWorld.spawn(0, startX, startZ, startHeading)
    serverWorld.setOccupied(0, true)

    clientSim.setCars([makeCar(0, startX, startZ, startHeading)], 0)

    // 模擬 150 ms RTT：以 1/30s (33.3ms) 為一步，上行 2 步延遲，下行 3 步延遲（合計 5 步 ≈ 167 ms）
    const uplinkDelay = 2
    const downlinkDelay = 3

    interface ClientPacket {
      seq: number
      input: { dir: number; mag: number }
      deliverAtStep: number
    }
    interface ServerSnapshot {
      ack: number
      car: CarState
      deliverAtStep: number
    }

    const uplinkQueue: ClientPacket[] = []
    const downlinkQueue: ServerSnapshot[] = []

    let serverProcessedSeq = 0
    const totalSteps = 60 // 行駛 2 秒

    for (let step = 1; step <= totalSteps; step++) {
      // 1. 客戶端：送出輸入並模擬前進一步
      const input = { dir: 0, mag: 1 }
      clientSim.pushInput(step, input)
      clientSim.advance(1 / 30)

      // 排入上行佇列
      uplinkQueue.push({ seq: step, input, deliverAtStep: step + uplinkDelay })

      // 2. 伺服器：接收到達的輸入
      while (uplinkQueue.length > 0 && uplinkQueue[0]!.deliverAtStep <= step) {
        const p = uplinkQueue.shift()!
        serverWorld.setInput(0, p.input)
        serverProcessedSeq = p.seq
      }

      // 伺服器步進一步
      serverWorld.step()

      // 伺服器狀態排入下行佇列
      const s = serverWorld.state(0)!
      downlinkQueue.push({
        ack: serverProcessedSeq,
        car: { ...s },
        deliverAtStep: step + downlinkDelay,
      })

      // 3. 客戶端：接收到達的伺服器校正
      while (downlinkQueue.length > 0 && downlinkQueue[0]!.deliverAtStep <= step) {
        const snap = downlinkQueue.shift()!
        clientSim.reconcile(snap.ack, snap.car, [])
      }
    }

    // 讓伺服器處理完所有剩餘的上行輸入封包並送達客戶端
    let drainStep = totalSteps
    while (uplinkQueue.length > 0 || downlinkQueue.length > 0) {
      drainStep++
      while (uplinkQueue.length > 0 && uplinkQueue[0]!.deliverAtStep <= drainStep) {
        const p = uplinkQueue.shift()!
        serverWorld.setInput(0, p.input)
        serverProcessedSeq = p.seq
        serverWorld.step()
        const s = serverWorld.state(0)!
        downlinkQueue.push({
          ack: serverProcessedSeq,
          car: { ...s },
          deliverAtStep: drainStep + downlinkDelay,
        })
      }

      while (downlinkQueue.length > 0 && downlinkQueue[0]!.deliverAtStep <= drainStep) {
        const snap = downlinkQueue.shift()!
        clientSim.reconcile(snap.ack, snap.car, [])
      }
    }

    const clientPose = clientSim.selfPose()!
    const serverPose = serverWorld.state(0)!

    // 畫面比物理晚 1 - DISPLAY_LEAD 步：累加器剛好歸零時，沿行進方向落後這麼多步的距離。
    // 橫向（x）不受影響，仍要在 5 公分以內。
    const behind = (Math.hypot(serverPose.vx, serverPose.vz) / VEHICLES.physics.hz) * (1 - DISPLAY_LEAD)
    expect(Math.abs(clientPose.x - serverPose.x)).toBeLessThan(0.05)
    expect(Math.abs(serverPose.z - clientPose.z - behind)).toBeLessThan(0.05)

    serverWorld.free()
    clientSim.dispose()
  })

  it('2. 校正後不重播已被確認的輸入：ack 之後的歷史長度等於未確認的輸入數', () => {
    const sim = createTestSim()
    sim.setCars([makeCar(0, 0, 0, 0)], 0)

    for (let i = 1; i <= 10; i++) {
      sim.pushInput(i, { dir: 0, mag: 1 })
    }

    expect(sim.history.length).toBe(10)

    // ack = 6：應剔除 1..6，保留 7..10
    sim.reconcile(6, makeCar(0, 0, 1, 0), [])

    expect(sim.history.length).toBe(4)
    expect(sim.history.map((h) => h.seq)).toEqual([7, 8, 9, 10])

    sim.dispose()
  })

  it('3. seq 環繞（65530 → 5）時歷史正確裁切', () => {
    expect(isSeqLe(65530, 5)).toBe(true)
    expect(isSeqLe(65535, 5)).toBe(true)
    expect(isSeqLe(0, 5)).toBe(true)
    expect(isSeqLe(5, 5)).toBe(true)
    expect(isSeqLe(6, 5)).toBe(false)
    expect(isSeqLe(10, 5)).toBe(false)

    const sim = createTestSim()
    sim.setCars([makeCar(0, 0, 0, 0)], 0)

    const seqs = [65530, 65534, 65535, 0, 1, 5, 6, 10]
    for (const seq of seqs) {
      sim.pushInput(seq, { dir: 0, mag: 1 })
    }

    expect(sim.history.length).toBe(8)

    // ack = 5
    sim.reconcile(5, makeCar(0, 0, 1, 0), [])

    expect(sim.history.length).toBe(2)
    expect(sim.history.map((h) => h.seq)).toEqual([6, 10])

    sim.dispose()
  })

  it('4. 伺服器位置突然相差 4 公尺時直接套用（不平滑）', () => {
    const sim = createTestSim()
    sim.setCars([makeCar(0, 0, 9, 0)], 0)

    // 初始位置在 (0, 9)：庭院南側的空地
    expect(sim.selfPose()!.x).toBeCloseTo(0, 2)
    expect(sim.selfPose()!.z).toBeCloseTo(9, 2)

    // 伺服器突然報告 (4, 9)
    sim.reconcile(0, makeCar(0, 4, 9, 0), [])

    // 差距 4m > 3m，誤差偏移直接設為 0，直接跳至 4
    expect(sim.errorOffset.x).toBe(0)
    expect(sim.errorOffset.z).toBe(0)
    expect(sim.selfPose()!.x).toBeCloseTo(4, 2)

    sim.dispose()
  })

  it('5. 誤差偏移在 300 ms 內衰減到 5% 以下', () => {
    const sim = createTestSim()
    sim.setCars([makeCar(0, 0, 0, 0)], 0)

    // 模擬 1 公尺的微小誤差 (< 3m)
    sim.reconcile(0, makeCar(0, 1, 0, 0), [])

    // 初始偏移量約為 1 公尺
    const initialOffset = Math.hypot(sim.errorOffset.x, sim.errorOffset.z)
    expect(initialOffset).toBeGreaterThan(0.9)

    // 推進 300 ms (0.3 秒)
    sim.advance(0.3)

    const remainingOffset = Math.hypot(sim.errorOffset.x, sim.errorOffset.z)
    // exp(-0.3 * 10) = exp(-3) ≈ 0.0498 < 0.05 (5%)
    expect(remainingOffset / initialOffset).toBeLessThan(0.05)

    sim.dispose()
  })

  it('6. 下車後歷史與偏移清空', () => {
    const sim = createTestSim()
    sim.setCars([makeCar(0, 0, 0, 0)], 0)

    sim.pushInput(1, { dir: 0, mag: 1 })
    // 校正量要超過柔性校正的範圍（0.6 公尺）才會產生誤差偏移
    sim.reconcile(0, makeCar(0, 1.5, 0, 0), [])

    expect(sim.history.length).toBe(1)
    expect(Math.hypot(sim.errorOffset.x, sim.errorOffset.z)).toBeGreaterThan(0)

    // 下車 (self 設為 null)
    sim.setCars([makeCar(0, 1.5, 0, 0)], null)

    expect(sim.history.length).toBe(0)
    expect(sim.errorOffset.x).toBe(0)
    expect(sim.errorOffset.z).toBe(0)
    expect(sim.selfPose()).toBeNull()

    sim.dispose()
  })

  it('7. shouldLoad 在 saveData 或 2g/3g 時為 false', () => {
    expect(VehicleSim.shouldLoad({ saveData: true })).toBe(false)
    expect(VehicleSim.shouldLoad({ effectiveType: 'slow-2g' })).toBe(false)
    expect(VehicleSim.shouldLoad({ effectiveType: '2g' })).toBe(false)
    expect(VehicleSim.shouldLoad({ effectiveType: '3g' })).toBe(false)
    expect(VehicleSim.shouldLoad({ effectiveType: '4g' })).toBe(true)
    expect(VehicleSim.shouldLoad(undefined)).toBe(true)
    expect(VehicleSim.shouldLoad({})).toBe(true)
  })

  it('8. load 失敗時 Vehicles 繼續使用插值顯示', () => {
    // 模擬 Vehicles 載入失敗或無 sim 時的插值行為
    const fleetMock = {
      sync: () => {},
      dispose: () => {},
    }
    const netMock = {
      sendClaim: () => null,
      sendRide: () => null,
      sendDrive: () => null,
    }
    const vehicles = new Vehicles({
      fleet: fleetMock as any,
      net: netMock as any,
      selfId: () => 'p1',
    })

    // 加入一輛車並收到 cars 快照
    vehicles.onWelcome([{ c: 0, kind: 0, driver: null, x: 5, z: 5, heading: 0, fadeAt: null }])
    expect(vehicles.ui(5, 5).nearCar).toBe(true)

    // 收到 cars 訊息進行插值
    vehicles.onCars(0, [makeCar(0, 6, 6, 0)], 1000)
    // 呼叫 update 不應拋錯
    const active = vehicles.update(1016, 1016, 0.016)
    expect(typeof active).toBe('boolean')

    vehicles.dispose()
  })

  it('9. dispose 後 world 已釋放', () => {
    const sim = createTestSim()
    sim.dispose()

    expect(() => {
      sim.advance(0.1)
    }).toThrow('SimWorld has been freed')
  })

  it('10. 150ms 延遲下單獨開車 60 秒無碰撞量測：correction p95 < 0.30 公尺上線門檻', () => {
    const serverWorld = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
    const clientSim = createTestSim()

    // 初始位置放置在庭院開闊區域
    serverWorld.spawn(0, 0, 0, 0)
    serverWorld.setOccupied(0, true)
    clientSim.setCars([makeCar(0, 0, 0, 0)], 0)

    const uplinkDelay = 2 // ~66ms
    const downlinkDelay = 3 // ~100ms（合計 167ms RTT）

    interface ClientPacket {
      seq: number
      input: { dir: number; mag: number }
      deliverAtStep: number
    }
    interface ServerSnapshot {
      ack: number
      car: CarState
      deliverAtStep: number
    }

    const uplinkQueue: ClientPacket[] = []
    const downlinkQueue: ServerSnapshot[] = []

    let serverProcessedSeq = 0
    const totalSteps = 1800 // 60 秒 @ 30fps

    for (let step = 1; step <= totalSteps; step++) {
      // 緩慢轉彎平滑駕駛，避免撞牆
      const t = step / 30
      const dir = Math.sin(t * 0.5) * 0.5
      const input = { dir, mag: 0.8 }

      clientSim.pushInput(step, input)
      clientSim.advance(1 / 30)

      uplinkQueue.push({ seq: step, input, deliverAtStep: step + uplinkDelay })

      while (uplinkQueue.length > 0 && uplinkQueue[0]!.deliverAtStep <= step) {
        const p = uplinkQueue.shift()!
        serverWorld.setInput(0, p.input)
        serverProcessedSeq = p.seq
      }

      serverWorld.step()

      const s = serverWorld.state(0)!
      downlinkQueue.push({
        ack: serverProcessedSeq,
        car: { ...s },
        deliverAtStep: step + downlinkDelay,
      })

      while (downlinkQueue.length > 0 && downlinkQueue[0]!.deliverAtStep <= step) {
        const snap = downlinkQueue.shift()!
        clientSim.reconcile(snap.ack, snap.car, [])
      }
    }

    const samples = clientSim.correction.samples
    expect(samples.length).toBeGreaterThan(100)

    const sorted = [...samples].sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!

    // 上線門檻：p95 < 0.30 公尺
    expect(p95).toBeLessThan(0.3)

    serverWorld.free()
    clientSim.dispose()
  })
})

