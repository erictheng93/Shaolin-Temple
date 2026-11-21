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

const fmt = (o: Record<string, number>): string =>
  Object.entries(o)
    .map(([k, x]) => `${k}=${x.toFixed(2)}`)
    .join(' ')

const straight = (): { x: number; z: number } => ({ x: 1, z: 0 })
const LANE = { x: -9, z: 9, heading: Math.PI / 2 }

describe('開車手感（模擬網路）', () => {
  beforeAll(async () => {
    await RAPIER.init()
  })

  it('量測', () => {
    const cases: Array<[string, Partial<Scenario>]> = [
      ['60fps 0ms', {}],
      ['60fps 抖動幀 0ms', { frameJitterMs: 4 }],
      ['30fps 0ms', { frameMs: 1000 / 30, frameJitterMs: 3 }],
      ['60fps 單程40±15', { oneWayMs: 40, jitterMs: 15, frameJitterMs: 2 }],
      ['60fps 單程100±40', { oneWayMs: 100, jitterMs: 40, frameJitterMs: 2 }],
      ['60fps 單程200±80', { oneWayMs: 200, jitterMs: 80, frameJitterMs: 2 }],
      ['60fps 斷流400ms', { oneWayMs: 40, jitterMs: 15, stall: { at: 2000, ms: 400 } }],
      ['60fps 卡頓300ms', { oneWayMs: 40, jitterMs: 15, hitch: { at: 2000, ms: 300 } }],
    ]
    for (const [name, extra] of cases) {
      // 從靜止往 +z 開 3 秒（不會撞到東西），看 1.5 秒之後（已到極速）
      const r = run({ seconds: 3, stick: straight, start: LANE, ...extra })
      const s = speedStats(r.frames, 1500)
      const err = r.frames.filter((f) => f.t > 1500).map((f) => Math.hypot(f.x - f.sx, f.z - f.sz))
      const corr = [...r.corrections].sort((a, b) => a - b)
      process.stdout.write(
        `${name.padEnd(22)} ${fmt(s)} | 校正 p95=${pct(corr, 0.95).toFixed(3)} max=${(corr[corr.length - 1] ?? 0).toFixed(3)} | 領先伺服器 max=${Math.max(...err).toFixed(2)}
`,
      )
    }
    const nets: Array<[string, Partial<Scenario>]> = [
      ['0ms', {}],
      ['40±15', { oneWayMs: 40, jitterMs: 15, frameJitterMs: 2 }],
      ['100±40', { oneWayMs: 100, jitterMs: 40, frameJitterMs: 2 }],
    ]
    const jerk = (frames: Frame[]): number => {
      let worst = 0
      for (let i = 2; i < frames.length; i++) {
        const a = frames[i - 2]!, b = frames[i - 1]!, c = frames[i]!
        const v1 = Math.hypot(b.x - a.x, b.z - a.z) / b.dt
        const v2 = Math.hypot(c.x - b.x, c.z - b.z) / c.dt
        worst = Math.max(worst, Math.abs(v2 - v1))
      }
      return worst
    }
    const worlds: Array<[string, Partial<Scenario>]> = [
      ['撞東牆', { seconds: 6 }],
      ['撞空車', { seconds: 4, other: { x: 5, z: 9, heading: 0 } }],
      ['對撞', { seconds: 4, other: { x: 15, z: 9, heading: -Math.PI / 2, input: { dir: -Math.PI / 2, mag: 1 } } }],
      ['並行', { seconds: 3, other: { x: -9, z: 12, heading: Math.PI / 2, input: { dir: Math.PI / 2, mag: 1 } } }],
      ['蛇行', { seconds: 4, stick: (t) => ({ x: 1, z: Math.sin(t / 300) }) }],
      ['走走停停', { seconds: 4, stick: (t) => (Math.floor(t / 500) % 2 ? { x: 0, z: 0 } : { x: 1, z: 0 }) }],
    ]
    for (const [wn, w] of worlds) {
      for (const [nn, n] of nets) {
        const r = run({ seconds: 3, stick: straight, start: LANE, ...n, ...w })
        const corr = [...r.corrections].sort((a, b) => a - b)
        const maxX = Math.max(...r.frames.map((f) => f.x))
        const last = r.frames[r.frames.length - 1]!
        const os = r.frames[0]!.other ? speedStats(r.frames, 1500, (f) => f.other) : null
        const gap = r.frames.map((f) => (f.other && f.otherTrue ? Math.hypot(f.other.x - f.otherTrue.x, f.other.z - f.otherTrue.z) : 0))
        let hitAt = 0, hitDv = 0
        for (let i = 2; i < r.frames.length; i++) {
          const a = r.frames[i - 2]!, b = r.frames[i - 1]!, c = r.frames[i]!
          const dv = Math.hypot(b.x - a.x, b.z - a.z) / b.dt - Math.hypot(c.x - b.x, c.z - b.z) / c.dt
          if (dv > hitDv) { hitDv = dv; hitAt = i }
        }
        const hf = r.frames[hitAt]!
        if (hf.other) process.stdout.write(`    撞擊那一幀畫面上兩車中心距離=${Math.hypot(hf.x - hf.other.x, hf.z - hf.other.z).toFixed(2)}（實際接觸約 1.80） 全程最近=${Math.min(...r.frames.map((f) => Math.hypot(f.x - f.other!.x, f.z - f.other!.z))).toFixed(2)}
`)
        process.stdout.write(
          `${(wn + ' ' + nn).padEnd(16)} 校正 p95=${pct(corr, 0.95).toFixed(2)} max=${(corr[corr.length - 1] ?? 0).toFixed(2)} | maxX=${maxX.toFixed(2)} 速度變化max=${jerk(r.frames).toFixed(1)} | 結束時與伺服器差=${Math.hypot(last.x - last.sx, last.z - last.sz).toFixed(2)}` +
            (os ? ` | 別車 ${fmt(os)} 落後max=${Math.max(...gap).toFixed(2)}` : '') +
            '\n',
        )
      }
    }
    expect(true).toBe(true)
  })
})
