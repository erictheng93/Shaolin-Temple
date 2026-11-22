// 開車手感的端到端模擬：真的 Vehicles + VehicleSim，對上一個模擬的伺服器（同一份物理、30 Hz、每 2 步廣播）
// 與有延遲、抖動、依序到達（TCP）的網路。量的是玩家眼睛看到的東西：每幀畫出來的車走了多遠。
import { beforeAll, describe, expect, it } from 'vitest'
import RAPIER from '@dimforge/rapier3d-compat'
import { VehicleSim } from './VehicleSim'
import { Vehicles } from './Vehicles'
import { createSimWorld, type CarState, type SimWorld } from './simCore'
import { dequantizeDrive, quantizeDrive, type DriveInput } from './drive'
import type { CarFleet, CarInstance } from '../render/CarFleet'
import { VEHICLES } from '../world/vehicles'
import { SOLIDS, WORLD_BOUNDS } from '../world/layout'

const RESEND_MS = 200
const STEP_MS = 1000 / VEHICLES.physics.hz

/** 可重現的亂數（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Scenario {
  seconds: number
  /** 單程延遲（毫秒）與抖動（0..jitter 均勻分布，加在單程延遲上）。 */
  oneWayMs?: number
  jitterMs?: number
  /** 每幀間隔（毫秒）與抖動（±）。 */
  frameMs?: number
  frameJitterMs?: number
  /** 指定時間（毫秒）卡住一幀這麼久。 */
  hitch?: { at: number; ms: number }
  /** 下行在這段時間完全不到，之後一次到齊（TCP 重傳）。 */
  stall?: { at: number; ms: number }
  /** 搖桿（世界座標方向向量），依時間決定。 */
  stick: (tMs: number) => { x: number; z: number }
  start?: { x: number; z: number; heading: number }
  /** 另一台車：有 input 就是有人開，沒有就是空車。 */
  other?: { x: number; z: number; heading: number; input?: DriveInput }
  seed?: number
}

interface Frame {
  t: number
  dt: number
  x: number
  z: number
  heading: number
  /** 伺服器此刻的真實位置（用來看畫面與權威狀態差多少）。 */
  sx: number
  sz: number
  other: CarInstance | null
  otherTrue: CarState | null
}

function run(sc: Scenario): { frames: Frame[]; vehicles: Vehicles; corrections: number[] } {
  const rand = rng(sc.seed ?? 1)
  const oneWay = sc.oneWayMs ?? 0
  const jitter = sc.jitterMs ?? 0
  const frameMs = sc.frameMs ?? 1000 / 60
  const start = sc.start ?? { x: 0, z: 0, heading: 0 }

  // ---- 伺服器 ----
  const server: SimWorld = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
  server.spawn(0, start.x, start.z, start.heading)
  server.setOccupied(0, true)
  if (sc.other) {
    server.spawn(1, sc.other.x, sc.other.z, sc.other.heading)
    server.setOccupied(1, !!sc.other.input)
    if (sc.other.input) server.setInput(1, sc.other.input)
  }
  let lastSeq = 0
  let lastInputAt = 0
  let serverSteps = 0
  let nextServerStep = rand() * STEP_MS

  // ---- 網路（依序到達）----
  const up: Array<{ at: number; seq: number; input: DriveInput }> = []
  const down: Array<{ at: number; ack: number; cars: CarState[] }> = []
  let lastUpAt = 0
  let lastDownAt = 0
  const delay = () => oneWay + rand() * jitter

  // ---- 客戶端 ----
  let shown: CarInstance[] = []
  const fleet = { sync: (list: CarInstance[]) => (shown = list.map((c) => ({ ...c }))), dispose: () => {} }
  let now = 0
  let seq = 0
  let lastDriveAt = -Infinity
  let lastQ = { dir: -1, mag: -1 }
  const net = {
    sendClaim: () => null,
    sendRide: () => null,
    // 與 NetworkClient.sendDrive 相同的節流：有變化時最多 15 Hz，沒變化時定期重送。
    sendDrive: (dir: number, mag: number): number | null => {
      const q = quantizeDrive(dir, mag)
      const changed = q.dir !== lastQ.dir || q.mag !== lastQ.mag
      if (now - lastDriveAt < (changed ? 1000 / 15 : RESEND_MS)) return null
      seq = (seq + 1) & 0xffff
      lastDriveAt = now
      lastQ = q
      lastUpAt = Math.max(lastUpAt, now + delay())
      up.push({ at: lastUpAt, seq, input: dequantizeDrive(q.dir, q.mag) })
      return seq
    },
  }
  const sim = new VehicleSim(createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES))
  const vehicles = new Vehicles({
    fleet: fleet as unknown as CarFleet,
    net: net as never,
    selfId: () => 'me',
    sim,
  })
  const snapshot = [{ c: 0, kind: 0, driver: 'me', x: start.x, z: start.z, heading: start.heading, fadeAt: null }]
  if (sc.other) {
    snapshot.push({ c: 1, kind: 0, driver: sc.other.input ? 'bot' : (null as never), x: sc.other.x, z: sc.other.z, heading: sc.other.heading, fadeAt: null })
  }
  vehicles.onRtt(2 * oneWay + jitter)
  vehicles.onWelcome(snapshot)

  const serverUntil = (t: number): void => {
    while (nextServerStep <= t) {
      const st = nextServerStep
      while (up.length && up[0]!.at <= st) {
        const m = up.shift()!
        server.setInput(0, m.input)
        lastSeq = m.seq
        lastInputAt = st
      }
      if (st - lastInputAt > VEHICLES.physics.inputTimeoutMs) server.setInput(0, { dir: 0, mag: 0 })
      server.step()
      if (++serverSteps % VEHICLES.physics.broadcastEverySteps === 0) {
        let at = st + delay()
        if (sc.stall && at >= sc.stall.at && at < sc.stall.at + sc.stall.ms) at = sc.stall.at + sc.stall.ms
        lastDownAt = Math.max(lastDownAt, at)
        down.push({ at: lastDownAt, ack: lastSeq, cars: server.cars() })
      }
      nextServerStep += STEP_MS
    }
  }

  const frames: Frame[] = []
  let hitched = false
  while (now < sc.seconds * 1000) {
    let dtMs = frameMs + (rand() * 2 - 1) * (sc.frameJitterMs ?? 0)
    if (sc.hitch && !hitched && now >= sc.hitch.at) {
      dtMs = sc.hitch.ms
      hitched = true
    }
    now += dtMs
    serverUntil(now)
    while (down.length && down[0]!.at <= now) {
      const m = down.shift()!
      vehicles.onCars(m.ack, m.cars, m.at)
    }
    // GameCore 的順序：setStick → advance → riderCar → update
    const s = sc.stick(now)
    const dt = Math.min(0.1, dtMs / 1000)
    vehicles.setStick(s.x, s.z)
    vehicles.advance(dt, now)
    vehicles.update(now, now, dt)
    const me = shown.find((c) => c.c === 0)!
    const truth = server.state(0)!
    frames.push({
      t: now,
      dt: dtMs / 1000,
      x: me.x,
      z: me.z,
      heading: me.heading,
      sx: truth.x,
      sz: truth.z,
      other: shown.find((c) => c.c === 1) ?? null,
      otherTrue: server.state(1),
    })
  }
  server.free()
  return { frames, vehicles, corrections: [...sim.correction.samples] }
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

/** 每幀畫面速度（公尺／秒）的統計，只看 fromMs 之後。 */
function speedStats(frames: Frame[], fromMs: number, pick: (f: Frame) => { x: number; z: number } | null = (f) => f) {
  const v: number[] = []
  for (let i = 1; i < frames.length; i++) {
    const a = pick(frames[i - 1]!)
    const b = pick(frames[i]!)
    if (!a || !b || frames[i]!.t < fromMs) continue
    v.push(Math.hypot(b.x - a.x, b.z - a.z) / frames[i]!.dt)
  }
  const sorted = [...v].sort((p, q) => p - q)
  const mean = v.reduce((p, q) => p + q, 0) / v.length
  return { mean, min: sorted[0]!, max: sorted[sorted.length - 1]!, p01: pct(sorted, 0.01), p99: pct(sorted, 0.99) }
}

const straight = (): { x: number; z: number } => ({ x: 1, z: 0 })
/** 庭院南側往東的空曠直線，極速下可以開 3 秒不碰到東西。 */
const LANE = { x: -9, z: 9, heading: Math.PI / 2 }
const EAST_WALL = WORLD_BOUNDS.maxX - VEHICLES.car.halfLength

const NETS: Array<[string, Partial<Scenario>]> = [
  ['沒有延遲', {}],
  ['單程 40±15 ms', { oneWayMs: 40, jitterMs: 15, frameJitterMs: 2 }],
  ['單程 100±40 ms', { oneWayMs: 100, jitterMs: 40, frameJitterMs: 2 }],
]

describe('開車手感（模擬網路）', () => {
  beforeAll(async () => {
    await RAPIER.init()
  })

  // 極速 8 m/s；物理的油門是開關式的，每步速度本來就在 7.8～8.2 之間。
  // 修正前同樣的情境是 6.4～9.3（40±15）、5.6～10.8（200±80）。
  describe.each([
    ...NETS,
    ['單程 200±80 ms', { oneWayMs: 200, jitterMs: 80, frameJitterMs: 2 }],
    ['30 FPS', { frameMs: 1000 / 30, frameJitterMs: 3 }],
    ['幀間隔不穩', { frameJitterMs: 4 }],
    ['下行斷 400 ms 後一次到齊', { oneWayMs: 40, jitterMs: 15, stall: { at: 2000, ms: 400 } }],
    ['卡頓 300 ms', { oneWayMs: 40, jitterMs: 15, hitch: { at: 2000, ms: 300 } }],
  ] as Array<[string, Partial<Scenario>]>)('%s', (_name, net) => {
    it('直線極速時畫面上的車接近等速', () => {
      const r = run({ seconds: 3, stick: straight, start: LANE, ...net })
      const s = speedStats(r.frames, 1500)
      expect(s.min).toBeGreaterThan(7.2)
      expect(s.max).toBeLessThan(9.0)
    })
  })

  describe.each(NETS)('%s', (_name, net) => {
    it('撞牆時不會畫到牆外，也不會卡在與伺服器不同的位置', () => {
      const r = run({ seconds: 6, stick: straight, start: LANE, ...net })
      expect(Math.max(...r.frames.map((f) => f.x))).toBeLessThanOrEqual(EAST_WALL + 1e-6)
      const last = r.frames[r.frames.length - 1]!
      expect(Math.hypot(last.x - last.sx, last.z - last.sz)).toBeLessThan(0.1)
    })

    it('貼著場內障礙物（香爐）撞上去時不會畫進去', () => {
      // 香爐在 x -0.9～0.9、z -2.4～-0.6；從西邊正對著它開過去
      const r = run({ seconds: 3, stick: straight, start: { x: -12, z: -1.5, heading: Math.PI / 2 }, ...net })
      const front = Math.max(...r.frames.map((f) => f.x)) + VEHICLES.car.halfLength
      expect(front).toBeLessThanOrEqual(-0.9 + 1e-6)
      expect(front).toBeGreaterThan(-0.9 - 0.3) // 真的有撞到
    })

    it('蛇行與走走停停時校正量都小', () => {
      for (const stick of [
        (t: number) => ({ x: 1, z: Math.sin(t / 300) }),
        (t: number) => (Math.floor(t / 500) % 2 ? { x: 0, z: 0 } : { x: 1, z: 0 }),
      ]) {
        const r = run({ seconds: 4, stick, start: LANE, ...net })
        const corr = [...r.corrections].sort((a, b) => a - b)
        expect(pct(corr, 0.95)).toBeLessThan(0.3)
      }
    })

    it('並行的另一台車畫面上也接近等速', () => {
      const r = run({
        seconds: 3,
        stick: straight,
        start: LANE,
        other: { x: -9, z: 12, heading: Math.PI / 2, input: { dir: Math.PI / 2, mag: 1 } },
        ...net,
      })
      const s = speedStats(r.frames, 1500, (f) => f.other)
      // 修正前（兩筆位置之間插值）在 100±40 ms 下是 0～18.8 m/s
      expect(s.min).toBeGreaterThan(6.5)
      expect(s.max).toBeLessThan(10.6)
    })

    it('撞上空車與對撞後，兩台車在畫面上不會疊在一起', () => {
      for (const other of [
        { x: 5, z: 9, heading: 0 },
        { x: 15, z: 9, heading: -Math.PI / 2, input: { dir: -Math.PI / 2, mag: 1 } },
      ]) {
        const r = run({ seconds: 4, stick: straight, start: LANE, other, ...net })
        const nearest = Math.min(...r.frames.map((f) => Math.hypot(f.x - f.other!.x, f.z - f.other!.z)))
        // 兩台車側面相貼時中心相距 2 × 半寬 = 1.1；平滑中的偏移容許一點重疊
        expect(nearest).toBeGreaterThan(2 * VEHICLES.car.halfWidth - 0.15)
        // 也不會隔空彈開：車頭對車尾相貼是 2 × 半長 = 1.8，最近的那一刻要看得出碰到了
        expect(nearest).toBeLessThan(2 * VEHICLES.car.halfLength + 0.3)
        const corr = [...r.corrections].sort((a, b) => a - b)
        expect(corr[corr.length - 1]).toBeLessThan(1.5)
      }
    })
  })
})
