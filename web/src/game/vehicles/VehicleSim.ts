import type { CarState, SimWorld } from './simCore'
import { createSimWorld } from './simCore'
import { wrapAngle, type DriveInput } from './drive'
import { VEHICLES } from '../world/vehicles'
import { SOLIDS, WORLD_BOUNDS } from '../world/layout'

/**
 * u16 環繞比較：判斷 seq 是否小於等於 ack。
 * 考慮 16-bit 溢位（例如 seq=65535, ack=5 時 65535 <= 5 為 true）。
 */
export function isSeqLe(seq: number, ack: number): boolean {
  const diff = ((seq - ack) << 16) >> 16
  return diff <= 0
}

const STEP = 1 / VEHICLES.physics.hz
/** 一幀最多補幾步（半秒）。卡頓後要把時間補齊，否則車落後伺服器一大段，校正時畫面會用好幾倍速追上去。 */
const MAX_CATCH_UP = 15
/** 校正量在這個距離（公尺）以內時不整個換成伺服器的狀態，只靠近 SOFT_PULL 的比例。約為最高速下兩個物理步。 */
const SOFT_CORRECTION = 0.6
const SOFT_PULL = 0.12
/** 超過這個距離（公尺）不平滑，直接到位。 */
const SNAP_CORRECTION = 3
/**
 * 畫面比物理的上一步領先多少（單位：步）。0 是純內插（最平順、畫面晚一整步約 33 毫秒），
 * 1 是純外推（不延遲，但加減速時每步交界會跳）。取一半：延遲約 17 毫秒，交界的跳動也只有一半。
 */
export const DISPLAY_LEAD = 0.5
/** 重播的上限（步）：延遲超過半秒時不再多補，寧可落後也不要每次校正都跑很多步物理。 */
const MAX_LAG_STEPS = 15

export interface NetworkConnectionInfo {
  saveData?: boolean
  effectiveType?: string
}

export interface ErrorOffset {
  x: number
  z: number
  heading: number
}

type Pose = ErrorOffset

/** 別人的車在畫面上的狀態：上一步的位置（內插用）與還沒補完的誤差偏移。 */
interface Shown {
  prev: Pose | null
  off: Pose
}

/**
 * 不讓畫面上的車畫進牆或障礙物裡。平滑用的偏移與往前推算都可能把車推進去一點，物理上不會發生，畫面上也不該看到。
 * ref 是一個確定合法的位置（物理世界或伺服器給的）。畫面上的車與障礙物重疊時，沿著 ref 離障礙物最開的那一軸
 * 推回 ref 所在的那一側（貼著牆滑行時只修正垂直牆面的方向，不會沿著牆被拉回去）。
 * 車身在兩軸上佔的半寬依車頭方向計算。
 */
export function keepOutside(pose: Pose, ref: { x: number; z: number }): void {
  const s = Math.abs(Math.sin(pose.heading))
  const c = Math.abs(Math.cos(pose.heading))
  const ex = s * VEHICLES.car.halfLength + c * VEHICLES.car.halfWidth
  const ez = c * VEHICLES.car.halfLength + s * VEHICLES.car.halfWidth
  pose.x = Math.max(WORLD_BOUNDS.minX + ex, Math.min(WORLD_BOUNDS.maxX - ex, pose.x))
  pose.z = Math.max(WORLD_BOUNDS.minZ + ez, Math.min(WORLD_BOUNDS.maxZ - ez, pose.z))
  for (const r of SOLIDS) {
    if (pose.x + ex <= r.minX || pose.x - ex >= r.maxX || pose.z + ez <= r.minZ || pose.z - ez >= r.maxZ) continue
    // ref 在各軸上離這個障礙物多遠（負的是物理允許的些微穿透）
    const gapX = Math.max(r.minX - (ref.x + ex), ref.x - ex - r.maxX)
    const gapZ = Math.max(r.minZ - (ref.z + ez), ref.z - ez - r.maxZ)
    // ref 自己就深陷在裡面（不該發生；撞擊瞬間的穿透最多一步的距離）：不知道該推去哪一側，不處理
    if (Math.max(gapX, gapZ) < -0.4) continue
    if (gapX >= gapZ) pose.x = ref.x < (r.minX + r.maxX) / 2 ? r.minX - ex : r.maxX + ex
    else pose.z = ref.z < (r.minZ + r.maxZ) / 2 ? r.minZ - ez : r.maxZ + ez
  }
}

/**
 * 前端車輛物理預測與重播校正：
 * - 當本地玩家騎乘時，以本機物理世界進行前向預測模擬。
 * - 接收到伺服器廣播 cars (帶 ack) 時，剔除已被確認的歷史輸入，將車輛重置為權威狀態後重播未確認輸入。
 * - 校正造成的畫面位移記為誤差偏移，以 exp(-dt * 10) 指數衰減平滑，超過 3 公尺則直接瞬移（不平滑）。
 */
export class VehicleSim {
  private selfCarId: number | null = null
  private knownCars = new Set<number>()
  private currentInput: DriveInput = { dir: 0, mag: 0 }
  private accumulator = 0

  /** 最近每個本機物理步用的輸入（新的在後），校正時依延遲重播。 */
  private recent: DriveInput[] = []
  /** 自己的車在最近一個物理步之前的位置，畫面在它與目前位置之間內插。 */
  private prev: Pose | null = null
  /** 開車時別人的車也畫本機世界裡的位置：和自己的車在同一條時間軸上，撞到的那一刻兩台車才會貼在一起。 */
  private shown = new Map<number, Shown>()

  /** 歷史輸入序列，上限 120 筆 */
  readonly history: Array<{ seq: number; input: DriveInput }> = []

  /** 當前殘餘誤差偏移 */
  readonly errorOffset: ErrorOffset = { x: 0, z: 0, heading: 0 }

  /** 每次校正的位置修正量（公尺），供上線門檻量測 */
  readonly correction = {
    last: 0,
    samples: [] as number[],
  }

  private disposed = false

  constructor(private readonly world: SimWorld) {}

  /**
   * 根據連線狀態判斷是否載入 Rapier 物理引擎：
   * 開啟資料節省模式 (saveData) 或網路為 2g/3g 時不載入。
   */
  static shouldLoad(conn: NetworkConnectionInfo | undefined): boolean {
    if (!conn) return true
    if (conn.saveData) return false
    if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g') {
      return false
    }
    return true
  }

  /**
   * 非同步動態載入 Rapier 物理模組，若載入失敗或例外則回傳 null。
   */
  static async load(): Promise<VehicleSim | null> {
    try {
      const mod = await import('@dimforge/rapier3d-compat')
      const RAPIER = (mod as any).default ?? mod
      await RAPIER.init()
      const world = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES)
      return new VehicleSim(world)
    } catch (e) {
      console.warn('Failed to load Rapier physics module for VehicleSim:', e)
      return null
    }
  }

  /**
   * 同步場景上的所有車輛狀態。
   * 其他車在本機世界裡也是動態剛體（沒有輸入，照伺服器給的速度滑行）：撞到時兩台車都會被推開，
   * 和伺服器算的結果接近；若當成不會動的運動學剛體，撞空車像撞牆，之後才被校正拉過去。
   * 它們每次校正都重設成伺服器的狀態，本機推錯的不會留下來。
   */
  setCars(cars: Iterable<CarState>, self: number | null): void {
    const present = new Set<number>()

    for (const c of cars) {
      present.add(c.c)
      if (!this.knownCars.has(c.c)) {
        this.world.spawn(c.c, c.x, c.z, c.heading)
        this.knownCars.add(c.c)
        this.shown.set(c.c, { prev: null, off: { x: 0, z: 0, heading: 0 } })
      }

      this.world.setOccupied(c.c, c.c === self || c.occupied)
      // 自己正在開的車不動它（狀態由預測與校正負責）；剛上車時要放到車現在的位置，
      // 否則本機世界裡它還停在上一次同步時的地方。
      if (c.c !== self || this.selfCarId !== self) this.world.setState(c.c, c)
    }

    // 移除已不在列表中的車輛
    for (const id of this.knownCars) {
      if (!present.has(id)) {
        this.world.remove(id)
        this.knownCars.delete(id)
        this.shown.delete(id)
      }
    }

    // 駕駛車輛變更或下車：清空歷史與誤差偏移
    if (this.selfCarId !== self) {
      this.clearHistory()
      this.selfCarId = self
    }
  }

  /**
   * 推送新的駕駛輸入，並排入歷史。
   */
  pushInput(seq: number, input: DriveInput): void {
    this.currentInput = input
    this.history.push({ seq, input })
    if (this.history.length > 120) {
      this.history.shift()
    }
    if (this.selfCarId !== null) {
      this.world.setInput(this.selfCarId, input)
    }
  }

  /**
   * 設定當前輸入（節流未配發 seq 時仍更新物理模擬輸入）。
   */
  setInput(input: DriveInput): void {
    this.currentInput = input
    if (this.selfCarId !== null) {
      this.world.setInput(this.selfCarId, input)
    }
  }

  /**
   * 權威重播校正：
   * 1. 丟掉 seq <= ack 的歷史。
   * 2. 把自己的車設為 server 狀態，其他車設成各自的伺服器狀態。
   * 3. 重播：伺服器的狀態比本機晚 lagSec（來回延遲加上這則訊息等了多久才處理）。
   *    重播最近那幾步實際用過的輸入（輸入只在改變時送出，按住不放時沒有未確認的訊息，但時間差仍然存在），
   *    不足一步的零頭以速度補上；沒給 lagSec 時退回「每則未確認的輸入重播一步」。
   * 4. 與本機「此刻」的狀態（含累加器裡還沒走的時間）比較，兩邊都是連續時間，
   *    否則誤差會隨本機步進的時間點在一整步（極速下 27 公分）之間跳動。
   * 5. 小誤差只靠近一部分、中等誤差整個採用、超過 SNAP_CORRECTION 直接瞬移；
   *    前兩種都把畫面上的位移記進誤差偏移再慢慢衰減，所以校正當下畫面不動。
   */
  reconcile(ack: number, server: CarState, others: CarState[], lagSec?: number): void {
    if (this.selfCarId === null || server.c !== this.selfCarId) return

    // 1. 丟掉 seq <= ack 的歷史
    let i = 0
    while (i < this.history.length) {
      if (isSeqLe(this.history[i]!.seq, ack)) {
        this.history.splice(i, 1)
      } else {
        i++
      }
    }

    const pre = this.world.state(server.c)
    if (!pre) return
    const before = others.map((o) => this.carPose(o.c))

    // 2. 自己與其他車都設成伺服器狀態
    this.world.setState(server.c, server)
    for (const o of others) this.world.setState(o.c, o)

    // 3. 重播
    let replay: ReadonlyArray<{ input: DriveInput }> = this.history
    let frac = 0
    if (lagSec !== undefined) {
      const lag = Math.max(0, Math.min(MAX_LAG_STEPS * STEP, lagSec))
      const n = Math.min(this.recent.length, Math.floor(lag / STEP))
      replay = this.recent.slice(this.recent.length - n).map((input) => ({ input }))
      frac = Math.min(STEP, lag - n * STEP)
    }
    for (const h of replay) {
      this.world.setInput(server.c, h.input)
      this.world.step()
    }
    this.world.setInput(server.c, this.currentInput)

    // 4. 連續時間上的誤差
    const tgt = this.world.state(server.c)
    if (!tgt) return
    const acc = this.pendingTime()
    const ex = tgt.x + tgt.vx * frac - (pre.x + pre.vx * acc)
    const ez = tgt.z + tgt.vz * frac - (pre.z + pre.vz * acc)
    const eh = wrapAngle(tgt.heading + tgt.w * frac - (pre.heading + pre.w * acc))
    const jump = Math.hypot(ex, ez)
    this.correction.last = jump
    this.correction.samples.push(jump)
    if (this.correction.samples.length > 300) {
      this.correction.samples.shift()
    }

    // 5. 套用。小誤差多半只是封包到達時間的抖動，整個採用會讓車每秒 15 次前後抖。
    const snap = !(jump <= SNAP_CORRECTION) // NaN 也當作瞬移，不讓壞數字留在偏移裡
    const k = !snap && jump <= SOFT_CORRECTION ? SOFT_PULL : 1
    const dx = ex * k
    const dz = ez * k
    const dh = eh * k
    this.world.setState(server.c, {
      x: pre.x + dx,
      z: pre.z + dz,
      heading: wrapAngle(pre.heading + dh),
      vx: pre.vx + (tgt.vx - pre.vx) * k,
      vz: pre.vz + (tgt.vz - pre.vz) * k,
      w: pre.w + (tgt.w - pre.w) * k,
    })
    if (snap) {
      this.prev = null
      this.errorOffset.x = this.errorOffset.z = this.errorOffset.heading = 0
    } else {
      // 上一步的位置跟著平移，畫面的位移全部由誤差偏移吸收
      if (this.prev) {
        this.prev.x += dx
        this.prev.z += dz
        this.prev.heading = wrapAngle(this.prev.heading + dh)
      }
      this.errorOffset.x -= dx
      this.errorOffset.z -= dz
      this.errorOffset.heading = wrapAngle(this.errorOffset.heading - dh)
    }

    // 6. 別人的車：直接採用重播的結果（對齊到自己這台車的時間點），畫面的位移同樣記成偏移慢慢補
    const shift = frac - acc
    others.forEach((o, i) => {
      const st = this.world.state(o.c)
      const sh = this.shown.get(o.c)
      if (!st || !sh) return
      st.x += st.vx * shift
      st.z += st.vz * shift
      st.heading = wrapAngle(st.heading + st.w * shift)
      this.world.setState(o.c, st)
      sh.prev = { x: st.x - st.vx * STEP, z: st.z - st.vz * STEP, heading: wrapAngle(st.heading - st.w * STEP) }
      const was = before[i]
      this.alignDisplay(o.c, was ?? st)
    })
  }

  /** 讓某台別人的車在畫面上留在指定的位置（之後慢慢滑到本機世界裡的位置）；差太遠就直接到位。 */
  alignDisplay(c: number, at: Pose): void {
    const sh = this.shown.get(c)
    if (!sh) return
    sh.off.x = sh.off.z = sh.off.heading = 0
    const now = this.carPose(c)
    if (!now) return
    const dx = at.x - now.x
    const dz = at.z - now.z
    if (!(Math.hypot(dx, dz) <= SNAP_CORRECTION)) return
    sh.off.x = dx
    sh.off.z = dz
    sh.off.heading = wrapAngle(at.heading - now.heading)
  }

  /** 累加器裡還沒湊滿一步的時間（秒）。 */
  private pendingTime(): number {
    return Math.max(0, Math.min(STEP, this.accumulator))
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('SimWorld has been freed')
    }
  }

  /**
   * 前向物理步進（累加器，固定 1/30 秒，每次最多補 MAX_CATCH_UP 步），
   * 並對誤差偏移施加 exp(-dt * 10) 衰減。
   */
  advance(dt: number): void {
    this.assertNotDisposed()
    // 誤差偏移衰減
    const decay = Math.exp(-dt * 10)
    this.errorOffset.x *= decay
    this.errorOffset.z *= decay
    this.errorOffset.heading *= decay
    for (const sh of this.shown.values()) {
      sh.off.x *= decay
      sh.off.z *= decay
      sh.off.heading *= decay
    }

    if (this.selfCarId === null) {
      this.accumulator = 0
      return
    }

    this.accumulator += dt
    let steps = 0
    while (this.accumulator >= STEP && steps < MAX_CATCH_UP) {
      this.accumulator -= STEP
      steps++
      for (const [c, sh] of this.shown) {
        const s = this.world.state(c)
        const prev = s ? { x: s.x, z: s.z, heading: s.heading } : null
        if (c === this.selfCarId) this.prev = prev
        else sh.prev = prev
      }
      this.world.setInput(this.selfCarId, this.currentInput)
      this.world.step()
      this.recent.push(this.currentInput)
      if (this.recent.length > 30) this.recent.shift()
    }

    // 卡頓太久補不完：丟掉沒補的時間，落後的部分由下一次校正拉回來
    if (this.accumulator >= STEP) {
      this.accumulator = 0
    }
  }

  /**
   * 取得本地玩家當前預測位姿（已加入殘餘誤差平滑）。
   */
  selfPose(): { x: number; z: number; heading: number } | null {
    if (this.disposed || this.selfCarId === null) return null
    const s = this.world.state(this.selfCarId)
    if (!s) return null
    // 物理固定 30 Hz：不補的話 60 FPS 下車每兩幀才動一次、30 FPS 下每幀走 0、1 或 2 步，看起來一頓一頓。
    // 在上一步與這一步之間依累加器的進度內插（畫面晚最多一步，約 33 毫秒）。
    // 不用速度往前外推：加減速時每一步的交界會跳一下，撞牆的瞬間還會畫進牆裡。
    return this.blend(this.prev, s, this.errorOffset)
  }

  /** 任一台車在畫面上的位置（開車時才有意義）：自己的車是預測的位置，別人的車是本機世界裡推算的位置。 */
  carPose(c: number): Pose | null {
    if (c === this.selfCarId) return this.selfPose()
    if (this.disposed) return null
    const sh = this.shown.get(c)
    const s = sh && this.world.state(c)
    return sh && s ? this.blend(sh.prev, s, sh.off) : null
  }

  private blend(p: Pose | null, s: CarState, off: Pose): Pose {
    // t：要畫的時刻，以「這一步」為 0、「上一步」為 -1（單位：步）
    const t = (p ? this.pendingTime() / STEP : 1) - 1 + DISPLAY_LEAD
    let x = s.x
    let z = s.z
    let h = s.heading
    if (t <= 0 && p) {
      const k = 1 + t
      x = p.x + (s.x - p.x) * k
      z = p.z + (s.z - p.z) * k
      h = p.heading + wrapAngle(s.heading - p.heading) * k
    } else if (t > 0) {
      x += s.vx * t * STEP
      z += s.vz * t * STEP
      h += s.w * t * STEP
    }
    const pose = { x: x + off.x, z: z + off.z, heading: wrapAngle(h + off.heading) }
    keepOutside(pose, s)
    return pose
  }

  /**
   * 清空歷史輸入與誤差偏移（切場景、下車、或背景分頁切回前景時調用）。
   */
  clearHistory(): void {
    this.history.length = 0
    this.recent.length = 0
    this.prev = null
    this.accumulator = 0
    for (const sh of this.shown.values()) {
      sh.prev = null
      sh.off.x = sh.off.z = sh.off.heading = 0
    }
    this.errorOffset.x = 0
    this.errorOffset.z = 0
    this.errorOffset.heading = 0
  }

  /**
   * 釋放物理世界資源。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearHistory()
    this.selfCarId = null
    this.knownCars.clear()
    this.shown.clear()
    this.world.free()
  }
}
