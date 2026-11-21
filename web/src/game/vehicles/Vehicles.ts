import { dequantizeDrive, quantizeDrive, wrapAngle } from './drive'
import type { CarFleet, CarInstance } from '../render/CarFleet'
import type { NetworkClient } from '../net/NetworkClient'
import type { CarSnapshot, CarState } from '../net/protocol'
import { REMOTE_SNAP_DISTANCE } from '../world/interp'
import { WORLD_BOUNDS } from '../world/layout'
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
  /** 最近一筆伺服器狀態（含速度）。休眠的車不在 cars 幀裡，所以要自己留著。 */
  sv: CarState
  /** sv 是哪個時刻的狀態（本機時間，毫秒；已扣掉網路抖動）。 */
  svAt: number
  /** 畫面位置與「sv 依速度推算到現在」的差，逐幀衰減；換新的 sv 時畫面才不會跳。 */
  off: CarPose
}

export interface VehiclesDeps {
  fleet: CarFleet
  net: Pick<NetworkClient, 'sendClaim' | 'sendRide' | 'sendDrive'>
  selfId: () => string | null
  sim?: VehicleSim | null
}

/** 收到後超過這麼久（毫秒）還沒用掉的 cars 幀不拿來校正（分頁在背景、長時間卡頓）。 */
const STALE_FRAME_MS = 500
/** 一幀最多推進這麼久的物理（秒）。 */
const MAX_ADVANCE_SEC = 0.5
/** 伺服器每隔這麼久（毫秒）廣播一次 cars。 */
const FRAME_MS = (VEHICLES.physics.broadcastEverySteps / VEHICLES.physics.hz) * 1000
/** 幀的時間軸每幀最多往後漂這麼多（毫秒），讓延遲變長時能慢慢跟上；延遲變短時立刻跟上。 */
const FRAME_DRIFT_MS = 2
/** 別人的車最多依速度往前推算這麼久（秒）；超過（斷線、卡住）就停在原地等下一筆。 */
const MAX_EXTRAPOLATE_SEC = 0.25
/** 推算的位置夾在庭院邊界以內（留車身半寬），車才不會在撞牆前的那一筆畫到牆外。 */
const INSET = VEHICLES.car.halfWidth
/** 畫面與推算位置的差每秒衰減的速率，與自己的車的誤差偏移相同。 */
const OFFSET_DECAY = 10

function restState(c: { c: number; driver: string | null; x: number; z: number; heading: number }): CarState {
  return { c: c.c, occupied: c.driver !== null, bumped: false, x: c.x, z: c.z, heading: c.heading, vx: 0, vz: 0, w: 0 }
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
  /** 等下一幀處理的校正：一幀內到了好幾則 cars（網路卡住後一次到齊）時只用最新的一則。 */
  private pending: { ack: number; at: number } | null = null
  /** 最近幾次量到的來回延遲（毫秒），取中位數用，單次的尖峰不會讓車往前衝再拉回來。 */
  private rtts: number[] = []
  private lastAdvanceAt: number | null = null
  /** 最新一則 cars 的時刻（本機時間）。封包晚到時不是用到達時間，而是用「上一則加一個廣播間隔」。 */
  private frameAt = -Infinity
  /** 上一次 update 的時間，也就是各車 x／z／heading 是哪個時刻的畫面。 */
  private shownAt = 0

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
        if (sim && this._riding !== null) this.startPredicting(sim, this._riding)
      },
      (err) => {
        console.warn('VehicleSim load failed, continuing with interpolation:', err)
        this.loadingSim = false
      },
    )
  }

  /** 記一筆來回延遲的量測（毫秒）。 */
  onRtt(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    this.rtts.push(ms)
    if (this.rtts.length > 3) this.rtts.shift()
  }

  private rttMs(): number {
    if (this.rtts.length === 0) return 0
    const sorted = [...this.rtts].sort((a, b) => a - b)
    return sorted[sorted.length >> 1]!
  }

  private getCarStates(): CarState[] {
    const res: CarState[] = []
    for (const car of this.cars.values()) res.push({ ...car.sv, occupied: car.driver !== null })
    return res
  }

  /** 開始騎乘：本機世界同步到目前的狀態；別人的車從畫面上現在的位置滑到本機世界裡的位置。 */
  private startPredicting(sim: VehicleSim, riding: number): void {
    sim.setCars(this.getCarStates(), riding)
    for (const car of this.cars.values()) if (car.c !== riding) sim.alignDisplay(car.c, car)
  }

  /** 不再騎乘（下車、車消失、重連、離開庭院）：丟掉預測用的狀態，所有車改回依伺服器狀態推算。 */
  private stopPredicting(cars: CarState[]): void {
    this.pending = null
    this.sim?.clearHistory()
    this.sim?.setCars(cars, null)
    for (const car of this.cars.values()) this.rebase(car)
  }

  setLocalZone(zone: ZoneId): void {
    this.zone = zone
    if (zone !== 'courtyard') this.stopPredicting([])
  }

  onVisibilityChange(hidden: boolean): void {
    if (!hidden) {
      // 從背景切回前景時清空歷史輸入與平滑偏移，等待下一則權威廣播
      this.pending = null
      this.sim?.clearHistory()
    }
  }

  private addCar(c: CarSnapshot, now: number): void {
    this.cars.set(c.c, {
      c: c.c,
      kind: c.kind,
      driver: c.driver,
      x: c.x,
      z: c.z,
      heading: c.heading,
      fadeAt: c.fadeAt,
      sv: restState(c),
      svAt: now,
      off: { x: 0, z: 0, heading: 0 },
    })
  }

  /** sv 依速度推算到時刻 t 的位置，寫進 out。 */
  private project(car: LocalCar, t: number, out: CarPose): void {
    const s = car.sv
    // 可以是負的：新狀態到達時要往回推到上一幀的時刻，才能和畫面上的位置比較
    const ahead = Math.max(-MAX_EXTRAPOLATE_SEC, Math.min(MAX_EXTRAPOLATE_SEC, (t - car.svAt) / 1000))
    out.x = Math.max(WORLD_BOUNDS.minX + INSET, Math.min(WORLD_BOUNDS.maxX - INSET, s.x + s.vx * ahead))
    out.z = Math.max(WORLD_BOUNDS.minZ + INSET, Math.min(WORLD_BOUNDS.maxZ - INSET, s.z + s.vz * ahead))
    out.heading = wrapAngle(s.heading + s.w * ahead)
  }

  /** sv 換了（或從預測切回推算）：把畫面目前的位置與新的推算位置的差記下來，之後慢慢補上。 */
  private rebase(car: LocalCar): void {
    const o = car.off
    this.project(car, this.shownAt, o)
    o.x = car.x - o.x
    o.z = car.z - o.z
    o.heading = wrapAngle(car.heading - o.heading)
    // 差太遠（重連、傳送）或數字壞掉：直接到位
    if (!(Math.hypot(o.x, o.z) <= REMOTE_SNAP_DISTANCE)) o.x = o.z = o.heading = 0
  }

  onWelcome(cars: CarSnapshot[]): void {
    this.cars.clear()
    this._riding = null
    this.frameAt = -Infinity
    this.stopPredicting([])
    const now = performance.now()
    const self = this.deps.selfId()

    for (const c of cars) {
      this.addCar(c, now)
      if (self && c.driver === self) {
        this._riding = c.c
      }
    }

    if (this._riding !== null && this.sim) this.startPredicting(this.sim, this._riding)
  }

  onCar(m: CarSnapshot): void {
    const existing = this.cars.get(m.c)
    if (existing) {
      existing.kind = m.kind
      existing.driver = m.driver
      existing.fadeAt = m.fadeAt
      existing.sv.occupied = m.driver !== null
    } else {
      this.addCar(m, performance.now())
    }

    const self = this.deps.selfId()
    if (self && m.driver === self) {
      if (this._riding !== m.c) {
        this._riding = m.c
        if (this.sim) this.startPredicting(this.sim, m.c)
      }
    } else if (this._riding === m.c && m.driver !== self) {
      this._riding = null
      this.stopPredicting(this.getCarStates())
    }
  }

  onCarGone(c: number): void {
    this.cars.delete(c)
    if (this._riding === c) {
      this._riding = null
      this.stopPredicting(this.getCarStates())
    }
  }

  onCars(ack: number, cars: CarState[], now: number): void {
    // 幀的時間軸：伺服器固定每 FRAME_MS 送一則，所以這一則的時刻是「上一則 + FRAME_MS」，晚到的部分是網路抖動，
    // 不算進去（否則推算的位置會跟著抖動前後跳）。比預期早到代表先前估得太晚，直接改用到達時間；
    // 晚太多代表中間斷過（沒有車在動時伺服器不送），重新對時。
    const expected = this.frameAt + FRAME_MS
    this.frameAt = now - expected > 1.5 * FRAME_MS ? now : Math.min(now, expected + FRAME_DRIFT_MS)

    for (const s of cars) {
      const car = this.cars.get(s.c)
      if (!car) continue
      car.sv = s
      car.svAt = this.frameAt
      this.rebase(car)
    }

    // 校正留到下一幀（advance）再做：那時才知道這則訊息等了多久，一幀內到好幾則也只算一次。
    if (this.sim !== null && this._riding !== null && cars.some((c) => c.c === this._riding)) {
      this.pending = { ack, at: this.frameAt }
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

  /**
   * 推進本機的物理預測，並套用這一幀之前收到的伺服器狀態。每幀要在讀取騎士位置（riderCar）之前呼叫一次：
   * 否則騎士用的是推進前的位置、車身用的是推進後的位置，人會相對於車前後晃。
   */
  advance(dt: number, now: number): void {
    const last = this.lastAdvanceAt
    this.lastAdvanceAt = null
    if (this.zone !== 'courtyard' || this.sim === null || this._riding === null) return
    this.lastAdvanceAt = now
    // 用真正經過的時間，不用主迴圈夾在 0.1 秒以內的 dt：伺服器的車不會因為這邊卡頓而停下來。
    // dt 為 0（迴圈剛恢復）或上一幀沒在開車時不補。
    const elapsed = dt > 0 && last !== null ? Math.min(MAX_ADVANCE_SEC, Math.max(0, (now - last) / 1000)) : dt
    this.sim.advance(elapsed)

    const pending = this.pending
    this.pending = null
    const self = this.cars.get(this._riding)
    if (!pending || !self) return
    const age = Math.max(0, now - pending.at)
    if (age > STALE_FRAME_MS) return
    const others: CarState[] = []
    for (const car of this.cars.values()) if (car.c !== this._riding) others.push(car.sv)
    // 伺服器的狀態對應到本機大約一個來回延遲之前，再加上這則訊息等到這一幀才處理的時間。
    this.sim.reconcile(pending.ack, self.sv, others, (this.rttMs() + age) / 1000)
  }

  update(now: number, serverNow: number, dt: number): boolean {
    this.shownAt = now
    if (this.zone !== 'courtyard') {
      this.deps.fleet.sync([], now)
      return false
    }

    const predicting = this.sim !== null && this._riding !== null
    let active = predicting
    const decay = Math.exp(-dt * OFFSET_DECAY)
    const instances: CarInstance[] = []

    for (const car of this.cars.values()) {
      // 開車時所有車都畫本機世界裡的位置（同一條時間軸，撞到時才會貼在一起）
      const pose = predicting ? this.sim!.carPose(car.c) : null
      if (pose) {
        car.x = pose.x
        car.z = pose.z
        car.heading = pose.heading
      } else {
        // 沒在開車（或沒有載入物理）：伺服器狀態依速度推算到現在，加上還沒補完的差
        const o = car.off
        o.x *= decay
        o.z *= decay
        o.heading *= decay
        const s = car.sv
        const moving =
          now - car.svAt < MAX_EXTRAPOLATE_SEC * 1000 && Math.abs(s.vx) + Math.abs(s.vz) + Math.abs(s.w) > 0.02
        if (moving || Math.abs(o.x) + Math.abs(o.z) + Math.abs(o.heading) > 0.002) active = true
        this.project(car, now, car)
        car.x += o.x
        car.z += o.z
        car.heading = wrapAngle(car.heading + o.heading)
      }

      let opacity = 1
      if (car.fadeAt !== null && car.fadeAt > 0) {
        opacity = Math.max(0, Math.min(1, (car.fadeAt + VEHICLES.fade.fadeMs - serverNow) / VEHICLES.fade.fadeMs))
        if (opacity > 0 && opacity < 1) active = true
      }

      instances.push({ c: car.c, kind: car.kind, x: car.x, z: car.z, heading: car.heading, opacity })
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
