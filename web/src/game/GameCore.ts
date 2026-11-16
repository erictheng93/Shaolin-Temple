import * as THREE from 'three'
import { AnimationSystem } from './anim/AnimationSystem'
import { AudioManager } from './audio/AudioManager'
import { Emitter } from './core/Emitter'
import { frameCap, isLowBattery } from './core/frameCap'
import { ADAPTIVE_LEVELS, AdaptiveQuality } from './core/AdaptiveQuality'
import { effectivePreset, readDeviceInfo, readNetworkInfo, resolveQuality, type QualityLevel, type QualityPreset, type Settings } from './core/settings'
import { ActionRegistry } from './gameplay/ActionRegistry'
import { gameplayModules } from './gameplay/modules'
import type { GameEvents, GameplayApi } from './gameplay/types'
import { InputController } from './input/InputController'
import { NetworkClient, type ConnectionStatus } from './net/NetworkClient'
import { sanitizeChat, type ServerMessage } from './net/protocol'
import { BellStriker } from './render/BellStriker'
import { ResourceTracker } from './render/ResourceTracker'
import { buildHallScene, type HallScene } from './render/HallScene'
import { IncenseSystem } from './render/IncenseSystem'
import { HALL_ENV, OUTDOOR_ENV, SceneRenderer } from './render/SceneRenderer'
import { buildTempleScene, type TempleScene } from './render/TempleScene'
import { resolveCollisions, stepMover, type MoveConfig } from './world/movement'
import { findPath, type Point } from './world/pathfind'
import { Players } from './world/Players'
import type { SpotContext } from './world/worship'
import { CENSERS, ZONES, entryCamera, isZoneId, portalApproach, portalAt, portalForTap, type CameraPose, type Portal, type Pose, type ZoneId } from './world/zones'

export interface UiAction {
  id: string
  label: string
  glyph?: string
  cooldownMs: number
  /** 冷卻結束的時間（performance.now 毫秒），UI 自行計算倒數。 */
  readyAt: number
  /** 目前場景不能用時的原因（按鈕變暗，按下時提示）；可用時沒有這個欄位。 */
  unavailable?: string
}

/** 聊天紀錄的一則（收到伺服器廣播當下建立，name 在當下解析）。 */
export interface ChatEntry {
  /** 本機流水號，給列表 key。 */
  seq: number
  id: string
  name: string
  text: string
  /** 伺服器 Unix 毫秒。 */
  at: number
  /** 收到的時間（performance.now 毫秒），UI 用來淡出舊訊息。 */
  seen: number
  self: boolean
}

/** sendChat 的結果；empty 與 sent 之外都由 UI 提示。 */
export type ChatSendResult = 'sent' | 'empty' | 'rate' | 'offline'

const CHAT_LOG_MAX = 30
const CHAT_BUBBLE_MS = 6000

/** 給 Vue 的低頻狀態摘要。遊戲核心只在內容改變時推送。 */
export interface UiState {
  status: ConnectionStatus
  networkEnabled: boolean
  room: string | null
  online: number
  quality: QualityLevel
  /** 動態畫質目前的等級（0 為完整）與最大等級。 */
  adaptive: { level: number; max: number }
  contextLost: boolean
  /** 場景切換中（畫面淡出黑幕）。 */
  fading: boolean
  zone: ZoneId
  actions: UiAction[]
  chat: ChatEntry[]
  stats: Array<{ key: string; label: string; value: string | number }>
  perf: { fps: number; frameMs: number; calls: number; triangles: number; rttMs: number | null }
}

export interface GameCoreOptions {
  canvas: HTMLCanvasElement
  settings: Settings
  wsUrl?: string
  onUi(state: UiState): void
  onToast(message: string): void
}

/** Battery Status API（Chromium 才有）的最小介面。 */
interface BatteryManagerLike extends EventTarget {
  charging: boolean
  level: number
}

const MOVE_SPEED = 3.2
const SFX_HEARING_RANGE = 28
const UI_PUSH_MS = 250
/** 走向參拜點：離站位這麼近就算抵達（抵達後直接站到站位上並轉向）。 */
const APPROACH_ARRIVE = 0.3
/** 場景切換：淡出時間與淡入前的停留（毫秒），需與 App.vue 的 CSS 過場一致。 */
const FADE_MS = 400
const FADE_HOLD_MS = 150

const moveConfigFor = (zone: ZoneId): MoveConfig => ({ speed: MOVE_SPEED, bounds: ZONES[zone].bounds, obstacles: ZONES[zone].obstacles })

/**
 * 遊戲核心：擁有所有子系統，並負責它們的建立與釋放順序。
 * 渲染頻率（rAF + 畫質幀率上限）與網路頻率（NetworkClient 的 sendHz）分開管理。
 */
export class GameCore {
  readonly events = new Emitter<GameEvents>()
  private renderer: SceneRenderer
  private tracker = new ResourceTracker()
  private temple: TempleScene
  /** 殿內場景：第一次進殿時才建立，避免拖慢首次進場。 */
  private hall: HallScene | null = null
  private zone: ZoneId = 'courtyard'
  private inPortal = false
  /** 離開各場景前的鏡頭，回來時還原（只用於 restoreCamera 的場景）。 */
  private savedCamera: Partial<Record<ZoneId, CameraPose>> = {}
  /** 尋路尚未走到的轉折點（目前目標在 mover.target）。 */
  private path: Point[] = []
  /** 正在走向定點、抵達後才開始的動作（approach）。玩家自己移動或切換場景時取消。 */
  private pending: { id: string; pose: Pose } | null = null
  /** 本機正在進行、鎖定移動的動作 id（鎖定結束後不一定清除，以 lockedUntil 為準）；用來判斷能不能提前結束（endAction）。 */
  private lockedAction: string | null = null
  /** 香爐裡的香與煙（兩個場景共用，只畫目前場景的香爐）。 */
  private incense: IncenseSystem
  /** 鐘亭的撞木（只在庭院顯示）。 */
  private striker: BellStriker
  private fading = false
  private anim = new AnimationSystem()
  private players: Players
  private input: InputController
  private net: NetworkClient
  private audio = new AudioManager()
  private actions = new ActionRegistry()
  private uninstallers: Array<() => void> = []
  private moveCfg: MoveConfig = moveConfigFor('courtyard')
  /** 虛擬搖桿的類比向量（螢幕座標：x 右、y 下，長度 0～1）；非零時優先於鍵盤。 */
  private stickX = 0
  private stickY = 0
  private raycaster = new THREE.Raycaster()
  private marker: THREE.Mesh
  private markerUntil = 0

  private settings: Settings
  private quality: QualityLevel
  /** 目前畫質對應的預設（自動畫質在慢速網路或資料節省時，貼圖與神像已降級）。 */
  private preset: QualityPreset
  private raf = 0
  private lastTime = 0
  private lastRender = 0
  private startTime = performance.now()
  private adaptive: AdaptiveQuality
  private lastInputAt = performance.now()
  private dirty = true
  private snapCamera = true
  private paused = false
  private contextLost = false
  private wasMoving = false
  private disposed = false
  private lowBattery = false
  private battery: BatteryManagerLike | null = null

  private room: string | null = null
  private selfId: string | null = null
  /** 自己的房內短編號；sync 中出現它代表伺服器校正了自己的位置。 */
  private selfN = -1
  private selfName = '訪客'
  private chatLog: ChatEntry[] = []
  private chatSeq = 0
  private serverOffset = 0
  private rtt: number | null = null
  private stats = new Map<string, { label: string; value: string | number }>()
  private uiTimer: ReturnType<typeof setInterval>
  private lastUiJson = ''
  private frames = 0
  private frameMsSum = 0
  private fps = 0
  private frameMs = 0
  private fpsWindowStart = performance.now()

  constructor(private readonly opts: GameCoreOptions) {
    this.settings = opts.settings
    this.quality = resolveQuality(opts.settings.quality)
    // 自動畫質且為觸控裝置：從等級 1 起步，開頭幾秒不致超出預算（順暢後會自動升回）。
    this.adaptive = new AdaptiveQuality(opts.settings.quality === 'auto' && readDeviceInfo().coarse ? 1 : 0)
    const preset = this.assetPreset()
    this.preset = preset

    this.renderer = new SceneRenderer(opts.canvas, preset, {
      onContextLost: () => {
        this.contextLost = true
        this.stopLoop()
        this.pushUi(true)
      },
      onContextRestored: () => {
        this.contextLost = false
        this.pushUi(true)
        this.wake()
      },
    })
    this.renderer.onResize = () => this.wake()

    this.temple = buildTempleScene(this.renderer.renderer, this.tracker, preset, () => this.wake())
    this.renderer.scene.add(this.temple.root)
    this.incense = new IncenseSystem(this.renderer.scene, this.tracker, CENSERS)
    this.striker = new BellStriker(this.renderer.scene, this.tracker)

    const markerGeo = this.tracker.track(new THREE.RingGeometry(0.28, 0.4, 24))
    markerGeo.rotateX(-Math.PI / 2)
    const markerMat = this.tracker.trackMaterial(
      new THREE.MeshBasicMaterial({ color: '#fff6e0', transparent: true, opacity: 0, depthWrite: false }),
    )
    this.marker = new THREE.Mesh(markerGeo, markerMat)
    this.marker.position.y = 0.08
    this.marker.visible = false
    this.renderer.scene.add(this.marker)

    this.players = new Players(this.renderer.scene, this.anim, this.maxVisibleFor(this.quality))
    // 起始等級的解析度與完整模型範圍（等級 0 時等於預設值）。
    const startLevel = ADAPTIVE_LEVELS[this.adaptive.level]!
    this.renderer.setResolutionScale(startLevel.resolution)
    this.players.nearRadius = startLevel.nearRadius

    this.input = new InputController(opts.canvas, {
      onTap: (x, y) => this.onTap(x, y),
      onRotate: (dx, dy) => {
        this.renderer.rotate(-dx * 0.006, dy * 0.004)
        this.wake()
      },
      onZoom: (d) => {
        this.renderer.zoom(d)
        this.wake()
      },
      onActivity: () => {
        this.lastInputAt = performance.now()
        // 使用者有操作時順便嘗試恢復被系統中斷的音訊（iOS）。
        if (this.audio.audible && !this.audio.running && !this.paused) void this.audio.resume()
        this.wake()
      },
    })

    this.watchBattery()

    this.net = new NetworkClient({ url: opts.wsUrl, name: '' })
    this.net.events.on('status', () => this.pushUi(true))
    this.net.events.on('message', (m) => this.onServerMessage(m))
    this.net.events.on('rtt', (ms) => (this.rtt = ms))

    this.audio.setVolumes(this.volumes())
    this.installGameplay()
    this.actions.subscribe(() => this.pushUi(true))

    document.addEventListener('visibilitychange', this.onVisibility)
    this.uiTimer = setInterval(() => this.pushUi(false), UI_PUSH_MS)
  }

  /** 進入遊戲：必須在使用者點擊事件中呼叫，才能啟用音訊。 */
  async enter(playerName: string): Promise<void> {
    this.net.setName(playerName)
    this.selfName = playerName || '訪客'
    await this.audio.unlock()
    this.audio.startAmbient()
    this.net.connect()
    this.snapCamera = true
    this.wake()
    this.pushUi(true)
  }

  /**
   * 送出聊天。連線時由伺服器回音顯示（不先顯示，避免重複）；離線模式（沒有 VITE_WS_URL）本機直接回音。
   * 斷線時直接丟棄，回傳 'offline' 讓 UI 提示。
   */
  sendChat(text: string): ChatSendResult {
    const res = this.net.sendChat(text)
    if (res === 'offline' && !this.net.enabled) {
      this.onChat({ t: 'chat', id: this.selfId ?? 'local', text: sanitizeChat(text), at: Date.now() })
      return 'sent'
    }
    return res
  }

  /** 開始渲染場景（進場前就先顯示背景畫面）。 */
  start(): void {
    this.wake()
  }

  /**
   * 玩家按下動作。不能在目前場景使用時提示原因；需要先走到定點的動作（approach）先自動走過去，抵達後才開始。
   * 正在做可提前結束的動作（endAction，例如誦經）時，按任何動作都先起身；按的是同一個動作就只起身。
   */
  performAction(id: string): void {
    const now = performance.now()
    this.lastInputAt = now
    const local = this.players.local
    const def = this.actions.get(id)
    if (!def || def.hidden || this.fading) return
    if (now < local.lockedUntil) {
      const interrupted = this.interruptLocal()
      if (!interrupted || interrupted === id) return
    }
    const reason = def.unavailableReason?.(this.zone)
    if (reason) {
      this.opts.onToast(reason)
      return
    }
    if (this.actions.cooldownLeft(id, now) > 0) return
    if (!def.approach) {
      this.beginAction(id, null)
      return
    }
    const spot = def.approach(this.spotContext())
    if (typeof spot === 'string') {
      this.opts.onToast(spot)
      return
    }
    if (Math.hypot(spot.x - local.mover.x, spot.z - local.mover.z) <= APPROACH_ARRIVE) {
      this.beginAction(id, spot)
      return
    }
    if (!this.walkTo(spot)) {
      this.opts.onToast('走不過去，請換個位置再試')
      return
    }
    this.pending = { id, pose: spot }
  }

  /** 開始執行動作（已在定點或不需要定點）：冷卻、鎖定移動、動畫、音效、事件與送出。 */
  private beginAction(id: string, pose: Pose | null): void {
    const now = performance.now()
    const local = this.players.local
    const def = this.actions.tryBegin(id, now)
    if (!def) return
    if (pose) {
      // 站到站位上、面向神龕或香爐；位置與面向一起送出（排在動作之前）
      Object.assign(local.mover, { x: pose.x, z: pose.z, heading: pose.heading, target: null })
      this.path = []
      this.marker.visible = false
      this.net.sendPosition(pose.x, pose.z, pose.heading, false)
    }
    if (def.locksMovement) {
      local.lockedUntil = now + def.durationMs
      this.lockedAction = id
      local.mover.target = null
      this.path = []
    }
    this.anim.play(local.anim, def.animation, now, def.durationMs)
    if (def.sound) this.audio.play(def.sound)
    this.events.emit('actionPerformed', {
      playerId: this.selfId ?? 'local',
      actionId: id,
      local: true,
      zone: this.zone,
      startedAt: now,
      x: local.mover.x,
      z: local.mover.z,
    })
    this.wake()
    this.pushUi(true)

    void this.net.sendAction(id).then((res) => {
      if (this.disposed) return
      if (res.ok) def.onConfirmed?.()
      else this.opts.onToast(res.reason === 'timeout' ? '連線不穩，動作未送達' : `動作未完成：${res.reason ?? '未知原因'}`)
    })
  }

  /**
   * 提前結束本機正在進行的鎖定動作（只限有 endAction 的動作）：解除鎖定，改為執行 endAction（送出後其他玩家也停止）。
   * 回傳被結束的動作 id；沒有可結束的動作時回傳 null。
   */
  private interruptLocal(): string | null {
    const local = this.players.local
    const running = this.lockedAction
    const def = running ? this.actions.get(running) : undefined
    if (!running || !def?.endAction || performance.now() >= local.lockedUntil) return null
    local.lockedUntil = 0
    this.lockedAction = null
    local.anim.clip = null
    this.beginAction(def.endAction, null)
    return running
  }

  /** 以尋路走向某點並顯示目標標記（直到抵達或 markerMs 過後）。找不到路時回傳 false。 */
  private walkTo(p: Point, markerMs = 60_000): boolean {
    const local = this.players.local
    const path = findPath({ x: local.mover.x, z: local.mover.z }, p, this.moveCfg)
    if (!path) return false
    local.mover.target = path.shift() ?? null
    this.path = path
    this.marker.position.set(p.x, 0.08, p.z)
    this.marker.visible = true
    this.markerUntil = performance.now() + markerMs
    this.wake()
    return true
  }

  /** 參拜點選擇需要的資訊：自己的位置與同場景其他玩家（顯示位置與最新收到的位置都算）。 */
  private spotContext(): SpotContext {
    const local = this.players.local.mover
    const others: Array<{ x: number; z: number }> = []
    for (const r of this.players.remotes.values()) {
      if (r.zone !== this.zone) continue
      others.push({ x: r.x, z: r.z }, { x: r.to.x, z: r.to.z })
    }
    return { zone: this.zone, x: local.x, z: local.z, selfId: this.selfId ?? 'local', others }
  }

  /** 載入資產用的預設：只有自動畫質才依網路狀況降級，使用者明確選的畫質照選擇。 */
  private assetPreset(): QualityPreset {
    return effectivePreset(this.quality, this.settings.quality === 'auto' ? readNetworkInfo() : undefined)
  }

  applySettings(settings: Settings): void {
    // 等級相同但 auto ↔ 手動切換時，網路降級與否會變（例如 auto 的 high 因 3G 降到 512 貼圖，改選手動 high），也要更新預設。
    const settingChanged = settings.quality !== this.settings.quality
    this.settings = settings
    const q = resolveQuality(settings.quality)
    if (q !== this.quality || settingChanged) {
      this.quality = q
      this.preset = this.assetPreset()
      this.renderer.setQuality(this.preset)
      this.players.maxVisible = this.maxVisibleFor(q)
    }
    this.audio.setVolumes(this.volumes())
    this.wake()
    this.pushUi(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.battery?.removeEventListener('levelchange', this.onBattery)
    this.battery?.removeEventListener('chargingchange', this.onBattery)
    this.battery = null
    clearInterval(this.uiTimer)
    this.stopLoop()
    for (const off of this.uninstallers) off()
    this.uninstallers = []
    this.input.dispose()
    this.incense.dispose()
    this.striker.dispose()
    this.net.dispose()
    void this.audio.dispose()
    this.players.dispose()
    this.hall?.dispose()
    this.tracker.dispose()
    this.renderer.dispose()
    this.events.clear()
  }

  // ---------- 渲染迴圈 ----------

  /** 喚醒渲染迴圈並要求立即重繪（迴圈在背景分頁或 context 遺失時停止）。 */
  private wake = (): void => {
    this.dirty = true
    if (this.paused || this.contextLost || this.disposed) return
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  /** 低電量時降低幀率上限；Safari／Firefox 沒有 getBattery，維持原樣。 */
  private onBattery = (): void => {
    const b = this.battery
    if (!b) return
    const low = isLowBattery(b.charging, b.level)
    if (low === this.lowBattery) return
    this.lowBattery = low
    this.wake()
  }

  private watchBattery(): void {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> }
    if (typeof nav.getBattery !== 'function') return
    nav
      .getBattery()
      .then((b) => {
        if (this.disposed) return
        this.battery = b
        b.addEventListener('levelchange', this.onBattery)
        b.addEventListener('chargingchange', this.onBattery)
        this.onBattery()
      })
      .catch(() => {})
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private frame = (time: number): void => {
    this.raf = 0
    if (this.paused || this.contextLost) return
    const preset = this.preset

    // 依目標幀率略過多餘的 rAF（高更新率螢幕上限制在 30/60 FPS）。
    const fps = frameCap({ activeFps: preset.activeFps, idleMs: time - this.lastInputAt, lowBattery: this.lowBattery })
    const minInterval = 1000 / fps - 1
    if (!this.dirty && time - this.lastRender < minInterval) {
      this.raf = requestAnimationFrame(this.frame)
      return
    }

    const dt = this.lastTime ? Math.min(0.1, (time - this.lastTime) / 1000) : 0
    this.lastTime = time
    const t = (time - this.startTime) / 1000
    const cpuStart = performance.now()

    this.update(time, dt, t)
    this.renderer.render()
    // 依實際幀間隔動態調整：變慢時降低解析度、縮小完整模型與投影的範圍，順暢一段時間後再升回。
    if (this.lastRender && this.adaptive.sample(time, time - this.lastRender, 1000 / fps)) {
      const level = ADAPTIVE_LEVELS[this.adaptive.level]!
      this.renderer.setResolutionScale(level.resolution)
      this.players.nearRadius = level.nearRadius
      this.pushUi(true)
    }
    this.lastRender = time
    this.dirty = false
    this.countFrame(performance.now() - cpuStart, time)

    // 場景有持續的環境動畫（落葉、樹影、香煙），前景時不降幀也不停止；背景分頁由 onVisibility 停止迴圈。
    this.raf = requestAnimationFrame(this.frame)
  }

  private update(now: number, dt: number, t: number): boolean {
    const local = this.players.local
    let moving = false
    // 有移動意圖就保持迴圈運作；喚醒後第一幀 dt=0 不會位移，不能只看本幀是否移動。
    let wantsMove = false

    // 可提前結束的動作（誦經）進行中按方向鍵：起身，接著照常移動
    if (now < local.lockedUntil) {
      const k = this.moveInput()
      if (k.x !== 0 || k.y !== 0) this.interruptLocal()
    }
    if (now >= local.lockedUntil) {
      const k = this.moveInput()
      if (k.x !== 0 || k.y !== 0) {
        // 鍵盤／搖桿操作取消尋路路徑與正在走向定點的動作
        this.path = []
        this.pending = null
      }
      wantsMove = k.x !== 0 || k.y !== 0 || local.mover.target !== null
      const yaw = this.renderer.yaw
      // 鏡頭在角色後方 (sin yaw, cos yaw) 方向，畫面「上」= 遠離鏡頭。
      const dirX = Math.cos(yaw) * k.x + Math.sin(yaw) * k.y
      const dirZ = -Math.sin(yaw) * k.x + Math.cos(yaw) * k.y
      const target = local.mover.target
      moving = stepMover(local.mover, { dirX, dirZ }, dt, this.moveCfg)
      if (target && !local.mover.target) {
        // 抵達轉折點就接著走下一段；被擋住（離轉折點仍遠）則放棄整條路徑。
        const arrived = Math.hypot(target.x - local.mover.x, target.z - local.mover.z) < 0.2
        local.mover.target = arrived ? (this.path.shift() ?? null) : null
        if (!arrived) this.path = []
      }
      // 走向定點的動作：路走完（或被擋住）時，抵達就開始，沒抵達就提示
      if (this.pending && !local.mover.target) {
        const { id, pose } = this.pending
        this.pending = null
        if (Math.hypot(pose.x - local.mover.x, pose.z - local.mover.z) <= APPROACH_ARRIVE) {
          this.beginAction(id, pose)
          moving = false
        } else {
          this.opts.onToast('被擋住了，沒有走到')
        }
      }
    }
    local.anim.moving = moving

    if (moving) {
      this.net.sendPosition(local.mover.x, local.mover.z, local.mover.heading, true)
    } else if (this.wasMoving) {
      this.net.sendPosition(local.mover.x, local.mover.z, local.mover.heading, false)
    }
    this.wasMoving = moving

    // 走進出入口（從外面踏入，避免出生點剛好在出入口時來回觸發）
    const portal = portalAt(this.zone, local.mover.x, local.mover.z)
    if (portal && !this.inPortal && !this.fading) this.beginZoneTransition(portal)
    this.inPortal = portal !== null

    const playersActive = this.players.update(now, dt, t)
    this.incense.update(now, t)
    const striking = this.zone === 'courtyard' && this.striker.update(now)
    if (this.zone === 'hall') this.hall?.update(t, dt)
    else this.temple.update(t, dt)
    // 殿內越靠近神龕（z 從 1 到 -3.5），鏡頭注視點越往上抬，像抬頭仰望神像。
    const lookUp = this.zone === 'hall' ? Math.min(1, Math.max(0, (1 - local.mover.z) / 4.5)) : 0
    const cameraMoving = this.renderer.follow(local.mover.x, local.mover.z, dt, this.snapCamera, 1.1 + lookUp * 1.6)
    this.snapCamera = false

    let markerActive = false
    if (this.marker.visible) {
      const left = this.markerUntil - now
      const mat = this.marker.material as THREE.MeshBasicMaterial
      if (left <= 0 || !local.mover.target) {
        this.marker.visible = false
      } else {
        mat.opacity = Math.min(1, left / 400) * 0.8
        const s = 1 + Math.sin(t * 6) * 0.08
        this.marker.scale.set(s, 1, s)
        markerActive = true
      }
    }

    const sceneMotion = this.zone === 'courtyard' && (this.temple.hasTransientMotion() || striking)
    if (moving || wantsMove) this.lastInputAt = now
    return moving || wantsMove || playersActive || cameraMoving || markerActive || sceneMotion
  }

  private countFrame(cpuMs: number, time: number): void {
    // 迴圈剛從停止狀態恢復：重開統計區間，避免把閒置時間算進幀率。
    if (time - this.fpsWindowStart > 2000) {
      this.fpsWindowStart = time
      this.frames = 0
      this.frameMsSum = 0
      return
    }
    this.frames++
    this.frameMsSum += cpuMs
    const elapsed = time - this.fpsWindowStart
    if (elapsed >= 1000) {
      this.fps = Math.round((this.frames * 1000) / elapsed)
      this.frameMs = this.frameMsSum / this.frames
      this.frames = 0
      this.frameMsSum = 0
      this.fpsWindowStart = time
    }
  }

  // ---------- 輸入 ----------

  /** 滑鼠點擊地面：尋路走過去（桌機；觸控裝置用搖桿，InputController 不會送出手指點擊）。 */
  private onTap(ndcX: number, ndcY: number): void {
    // 鎖定中只有可提前結束的動作（誦經）能被點擊打斷：起身並走向點擊處
    if (performance.now() < this.players.local.lockedUntil && !this.interruptLocal()) return
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.renderer.camera)
    const surface = this.zone === 'hall' && this.hall ? this.hall.walkSurface : this.temple.walkSurface
    const hit = this.raycaster.intersectObject(surface, false)[0]
    if (!hit) return
    // 點到主殿建築時走向殿門，而不是被推到建築最近的邊緣。
    const tapPortal = portalForTap(this.zone, hit.point.x, hit.point.z)
    const want = tapPortal ? portalApproach(tapPortal) : { x: hit.point.x, z: hit.point.z }
    this.pending = null
    this.walkTo(resolveCollisions(want.x, want.z, this.moveCfg), 1600)
  }

  /** 虛擬搖桿輸入（螢幕座標，長度 0～1）。高頻呼叫，只存值並喚醒迴圈。 */
  setMoveStick(x: number, y: number): void {
    if (x === this.stickX && y === this.stickY) return
    this.stickX = x
    this.stickY = y
    this.wake()
  }

  /** 目前的移動方向輸入：搖桿非零時優先於鍵盤。 */
  private moveInput(): { x: number; y: number } {
    return this.stickX !== 0 || this.stickY !== 0 ? { x: this.stickX, y: this.stickY } : this.input.keyDirection
  }

  // ---------- 場景切換 ----------

  /** 淡出 → 切換場景 → 淡入。期間鎖住移動。 */
  private beginZoneTransition(portal: Portal): void {
    const local = this.players.local
    this.fading = true
    local.mover.target = null
    this.path = []
    this.pending = null
    this.lockedAction = null
    local.lockedUntil = performance.now() + FADE_MS * 2 + FADE_HOLD_MS
    this.input.clearKeys()
    this.stickX = this.stickY = 0
    this.pushUi(true)
    setTimeout(() => {
      if (this.disposed) return
      this.applyZone(portal.to, portal.spawn)
      this.net.sendZone(portal.to, portal.spawn.x, portal.spawn.z, portal.spawn.heading)
      this.opts.onToast(portal.to === 'hall' ? `進入 ${ZONES.hall.name}` : `回到${ZONES.courtyard.name}`)
      setTimeout(() => {
        if (this.disposed) return
        this.fading = false
        this.pushUi(true)
        this.wake()
      }, FADE_HOLD_MS)
    }, FADE_MS)
  }

  /** 立即切換到指定場景與位置（無過場）。 */
  private applyZone(zone: ZoneId, pose: Pose): void {
    if (zone === 'hall' && !this.hall) {
      this.hall = buildHallScene(this.renderer.renderer, this.tracker, this.assetPreset(), () => this.wake())
      this.renderer.scene.add(this.hall.root)
    }
    if (zone !== this.zone) {
      const r = this.renderer
      this.savedCamera[this.zone] = { yaw: r.yaw, pitch: r.pitch, distance: r.distance }
    }
    this.zone = zone
    this.moveCfg = moveConfigFor(zone)
    this.temple.root.visible = zone === 'courtyard'
    if (this.hall) this.hall.root.visible = zone === 'hall'
    this.renderer.setEnvironment(zone === 'hall' ? HALL_ENV : OUTDOOR_ENV)
    const def = ZONES[zone]
    this.renderer.setCameraLimits(def.camera, def.cameraBounds)
    // 出殿回到庭院時還原進殿前的視角；殿內則放在角色背後看向神龕。
    const cam = entryCamera(zone, pose, this.savedCamera[zone], this.renderer.pitch)
    this.renderer.yaw = cam.yaw
    this.renderer.pitch = cam.pitch
    this.renderer.distance = cam.distance

    const pos = resolveCollisions(pose.x, pose.z, this.moveCfg)
    Object.assign(this.players.local.mover, { ...pos, heading: pose.heading, target: null })
    this.path = []
    this.pending = null
    this.players.setLocalZone(zone)
    this.incense.setZone(zone)
    this.striker.visible = zone === 'courtyard'
    this.inPortal = portalAt(zone, pos.x, pos.z) !== null
    this.marker.visible = false
    this.audio.setIndoor(zone === 'hall')
    this.snapCamera = true
    this.wake()
    this.pushUi(true)
  }

  /** 伺服器拒絕了自己送出的位置（跳太遠或穿過障礙物）：回到伺服器上的位置，取消進行中的移動。 */
  private correctLocal(x: number, z: number): void {
    const pos = resolveCollisions(x, z, this.moveCfg)
    Object.assign(this.players.local.mover, { ...pos, target: null })
    this.path = []
    this.pending = null
    this.marker.visible = false
    this.snapCamera = true
    this.wake()
  }

  // ---------- 生命週期 ----------

  private onVisibility = (): void => {
    if (document.hidden) {
      this.paused = true
      this.stopLoop()
      this.input.clearKeys()
      this.net.setBackground(true)
      void this.audio.suspend()
    } else {
      this.paused = false
      // 回前景：時間基準重設，避免一次跳一大步；鏡頭直接到位。
      this.lastTime = 0
      this.snapCamera = true
      this.net.setBackground(false)
      if (this.audio.unlocked) void this.audio.resume()
      this.wake()
    }
  }

  // ---------- 網路 ----------

  private onServerMessage(m: ServerMessage): void {
    switch (m.t) {
      case 'welcome': {
        this.selfId = m.selfId
        this.room = m.room
        this.serverOffset = m.serverTime - performance.now()
        this.players.clearRemotes()
        for (const p of m.players) {
          // 自己的位置平常由本機決定；短編號只對照遠端玩家，moves 中不會有自己，sync 中的自己是伺服器的校正。
          if (p.id === m.selfId) {
            this.selfN = p.n
            // 伺服器記錄的場景與位置為準（斷線恢復時可能在殿內）。
            const zone: ZoneId = isZoneId(p.zone) ? p.zone : 'courtyard'
            this.applyZone(zone, { x: p.x, z: p.z, heading: p.heading })
          } else {
            const r = this.players.upsert(p)
            if (p.action) {
              const def = this.actions.get(p.action.id)
              if (def) {
                const startedAt = p.action.startedAt - this.serverOffset
                if (def.locksMovement) r.lockedUntil = startedAt + def.durationMs
                this.anim.play(r.anim, def.animation, performance.now(), def.durationMs, startedAt)
              }
            }
          }
        }
        break
      }
      case 'join':
        if (m.player.id !== this.selfId) {
          this.players.upsert(m.player)
          this.events.emit('playerJoined', { id: m.player.id, name: m.player.name })
        }
        break
      case 'leave':
        this.players.remove(m.id)
        this.events.emit('playerLeft', { id: m.id })
        break
      case 'move':
        if (m.id !== this.selfId) this.players.setRemoteTarget(m.id, m.x, m.z, m.heading, m.moving, performance.now())
        break
      case 'moves': {
        const now = performance.now()
        for (const [n, x, z, heading, moving] of m.m) this.players.setRemoteTargetByN(n, x, z, heading, moving === 1, now)
        break
      }
      case 'sync': {
        const now = performance.now()
        for (const [n, x, z, heading, moving] of m.m) {
          if (n === this.selfN) this.correctLocal(x, z)
          else this.players.syncRemoteByN(n, x, z, heading, moving === 1, now)
        }
        break
      }
      case 'action':
        this.onRemoteAction(m)
        break
      case 'zone':
        if (m.id !== this.selfId) this.players.setRemoteZone(m.id, m.zone, m.x, m.z, m.heading, performance.now())
        break
      case 'chat':
        this.onChat(m)
        break
      case 'pong':
        this.serverOffset = m.serverTime - performance.now()
        break
      case 'error':
        this.opts.onToast(m.code === 'unsupported_version' ? '遊戲已更新，請重新整理頁面' : m.message)
        break
    }
    if (m.t === 'welcome' || m.t === 'join' || m.t === 'leave') this.pushUi(true)
    this.wake()
  }

  private onChat(m: Extract<ServerMessage, { t: 'chat' }>): void {
    const self = m.id === (this.selfId ?? 'local')
    const now = performance.now()
    const name = self ? this.selfName : (this.players.remotes.get(m.id)?.name ?? '訪客')
    this.chatLog = [...this.chatLog, { seq: ++this.chatSeq, id: m.id, name, text: m.text, at: m.at, seen: now, self }].slice(-CHAT_LOG_MAX)
    this.players.say(self ? null : m.id, m.text, now + CHAT_BUBBLE_MS)
    this.pushUi(true)
  }

  private onRemoteAction(m: Extract<ServerMessage, { t: 'action' }>): void {
    if (m.playerId === this.selfId) return
    const r = this.players.remotes.get(m.playerId)
    const def = this.actions.get(m.id)
    if (!r || !def) return
    const now = performance.now()
    const startedAt = m.startedAt - this.serverOffset
    // 新的動作取代原本的動作片段；不鎖定的動作（例如誦經的「起身」）同時解除原本的鎖定。
    // 已經過期的動作也照樣取代（片段下一幀就結束），延遲很久才到的「起身」仍能讓對方停下來。
    r.lockedUntil = def.locksMovement ? startedAt + def.durationMs : Math.min(r.lockedUntil, startedAt)
    this.anim.play(r.anim, def.animation, now, def.durationMs, startedAt)
    if (now - startedAt > def.durationMs) {
      // 過期的一般動作不再播聲音、不通知玩法；只用來結束其他動作的（hidden）仍要通知，玩法才會停止對應的聲音
      if (def.hidden) this.events.emit('actionPerformed', { playerId: r.id, actionId: m.id, local: false, zone: r.zone, startedAt, x: r.x, z: r.z })
      return
    }
    if (def.sound && r.zone === this.zone && now - startedAt < 1500) {
      const local = this.players.local.mover
      const d = Math.hypot(r.x - local.x, r.z - local.z)
      this.audio.play(def.sound, { gain: Math.max(0, 1 - d / SFX_HEARING_RANGE) * 0.7 })
    }
    this.events.emit('actionPerformed', { playerId: r.id, actionId: m.id, local: false, zone: r.zone, startedAt, x: r.x, z: r.z })
  }

  // ---------- 玩法模組 ----------

  private installGameplay(): void {
    const api: GameplayApi = {
      actions: this.actions,
      animations: this.anim,
      audio: this.audio,
      events: this.events,
      scene: {
        swingBell: () => {
          this.temple.swingBell()
          this.wake()
        },
        strikeBell: (startedAt) => {
          this.striker.strike(startedAt)
          this.wake()
        },
        offerIncense: (censerId) => {
          if (this.incense.add(censerId, performance.now())) this.wake()
        },
      },
      setStat: (key, label, value) => {
        if (value === null) this.stats.delete(key)
        else this.stats.set(key, { label, value })
        this.pushUi(true)
      },
      clockOffset: () => this.serverOffset,
      localPosition: () => ({ x: this.players.local.mover.x, z: this.players.local.mover.z }),
      playerPosition: (id) => {
        if (id === 'local' || id === this.selfId) return { x: this.players.local.mover.x, z: this.players.local.mover.z, zone: this.zone }
        const r = this.players.remotes.get(id)
        return r ? { x: r.to.x, z: r.to.z, zone: r.zone } : null
      },
    }
    for (const mod of gameplayModules) {
      try {
        this.uninstallers.push(mod.install(api))
      } catch (err) {
        console.error(`玩法模組 ${mod.id} 安裝失敗`, err)
      }
    }
  }

  // ---------- UI 橋接 ----------

  private pushUi(force: boolean): void {
    if (this.disposed) return
    const r = this.renderer.stats
    const state: UiState = {
      status: this.net.connectionStatus,
      networkEnabled: this.net.enabled,
      room: this.room,
      online: this.net.enabled ? this.players.count : 1,
      quality: this.quality,
      adaptive: { level: this.adaptive.level, max: ADAPTIVE_LEVELS.length - 1 },
      contextLost: this.contextLost,
      fading: this.fading,
      zone: this.zone,
      actions: this.actions.list().filter((a) => !a.hidden).map((a) => {
        const unavailable = a.unavailableReason?.(this.zone)
        return {
          id: a.id,
          label: a.label,
          glyph: a.glyph,
          cooldownMs: a.cooldownMs,
          readyAt: this.actions.readyAt(a.id),
          ...(unavailable ? { unavailable } : {}),
        }
      }),
      chat: this.chatLog,
      stats: [...this.stats].map(([key, s]) => ({ key, ...s })),
      // 迴圈停止時不再計幀，顯示 0 而非最後一次的數值。
      perf: { fps: performance.now() - this.lastRender > 1500 ? 0 : this.fps, frameMs: this.frameMs, calls: r.calls, triangles: r.triangles, rttMs: this.rtt },
    }
    const json = JSON.stringify(state)
    if (!force && json === this.lastUiJson) return
    this.lastUiJson = json
    this.opts.onUi(state)
  }

  private volumes() {
    const s = this.settings
    return { master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume, muted: s.muted }
  }

  private maxVisibleFor(q: QualityLevel): number {
    return q === 'low' ? 40 : q === 'medium' ? 60 : 120
  }
}

