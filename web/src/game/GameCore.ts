import * as THREE from 'three'
import { t, type MessageKey } from '../i18n'
import { AnimationSystem } from './anim/AnimationSystem'
import { AudioManager } from './audio/AudioManager'
import { clearAuth, type StoredAuth } from './core/auth'
import { Emitter } from './core/Emitter'
import { frameCap, isLowBattery } from './core/frameCap'
import { debugPosition, type DebugPosition } from './core/position'
import { normalizeName } from './core/names'
import { decideRename, isRenamePending } from './core/rename'
import { ADAPTIVE_LEVELS, AdaptiveQuality } from './core/AdaptiveQuality'
import { effectivePreset, readDeviceInfo, readNetworkInfo, resolveQuality, saveSettings, type QualityLevel, type QualityPreset, type Settings } from './core/settings'
import { ActionRegistry } from './gameplay/ActionRegistry'
import { gameplayModules } from './gameplay/modules'
import type { GameEvents, GameplayApi } from './gameplay/types'
import { InputController } from './input/InputController'
import { NetworkClient, type ConnectionStatus } from './net/NetworkClient'
import { sanitizeChat, type AuthKind, type ServerMessage } from './net/protocol'
import { BellStriker } from './render/BellStriker'
import { ResourceTracker } from './render/ResourceTracker'
import { buildHallScene, type HallScene } from './render/HallScene'
import { IncenseSystem } from './render/IncenseSystem'
import { HALL_ENV, OUTDOOR_ENV, SceneRenderer } from './render/SceneRenderer'
import { buildTempleScene, type TempleScene } from './render/TempleScene'
import { CarFleet } from './render/CarFleet'
import { resolveMove, type Body } from './world/collide'
import { BOOTH_NPC, sessionState } from './world/vehicles'
import { Vehicles, type RideUi } from './vehicles/Vehicles'
import { VehicleAudio } from './vehicles/sfx'
import { handleKnock, type KnockFlight } from './vehicles/knock'
import { resolveCollisions, stepMover, type MoveConfig } from './world/movement'
import { findPath, type Point } from './world/pathfind'
import { normalizeOutfit } from './world/outfits'
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

/**
 * 伺服器 error 的 code 對應的訊息；未列出的 code 顯示通用訊息（不顯示伺服器的英文 message）。
 * code 來源：server/src（connection.rs、room.rs）與 web/scripts/mock-server.mjs。
 */
const SERVER_ERRORS = new Map<string, MessageKey>([
  ['unsupported_version', 'server.unsupportedVersion'],
  ['invalid_zone', 'server.invalidZone'],
  ['car_unavailable', 'server.carUnavailable'],
  ['booth_crowded', 'server.boothCrowded'],
  ['claim_cooldown', 'server.claimCooldown'],
  ['dismount_first', 'server.dismountFirst'],
  ['session_closed', 'server.sessionClosed'],
])

/** 動作 ack 失敗的提示：timeout（本機逾時）有專屬訊息，其餘（unknown_action、unsupported_data…）通用訊息附上原始 code。 */
export function actionFailedMessage(reason?: string): string {
  if (reason === 'timeout') return t('action.timeout')
  return reason ? t('action.failed', { code: reason }) : t('action.failedUnknown')
}

/** 給 Vue 的低頻狀態摘要。遊戲核心只在內容改變時推送；字串在推送當下以目前語言解析。 */
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
  /** 本機玩家目前的衣裝編號（world/outfits.ts）。 */
  outfit: number
  /** 身份：連線前沿用本機的登入狀態，連線後以伺服器的 welcome.auth 為準。 */
  auth: AuthKind
  actions: UiAction[]
  chat: ChatEntry[]
  stats: Array<{ key: string; label: string; value: string | number }>
  ride: RideUi
  /**
   * pos：本機玩家的場景與座標（取整到 0.1 公尺），只在開啟「顯示效能資訊」時帶出；
   * 沒開時為 null，走路不會讓 UiState 的內容改變而多推送。
   */
  perf: {
    fps: number
    frameMs: number
    calls: number
    triangles: number
    rttMs: number | null
    pos: DebugPosition | null
    carCorrectionP95?: number | null
  }
}

export interface GameCoreOptions {
  canvas: HTMLCanvasElement
  settings: Settings
  wsUrl?: string
  onUi(state: UiState): void
  onToast(message: string): void
  /** 自己的名字確定了（伺服器清理後的結果，或離線模式直接生效）；Vue 據此同步設定。 */
  onNameChanged?(name: string): void
}

/** Battery Status API（Chromium 才有）的最小介面。 */
interface BatteryManagerLike extends EventTarget {
  charging: boolean
  level: number
}

const MOVE_SPEED = 3.2
const SFX_HEARING_RANGE = 28
const UI_PUSH_MS = 250
/** 伺服器糾正本機位置時，差距小於這個距離（公尺）就滑過去，否則瞬移。 */
const SMOOTH_CORRECTION_M = 1
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
  /** 小幅糾正還沒滑完的位移。 */
  private slideX = 0
  private slideZ = 0
  private posTrail: Array<{ t: number; x: number; z: number }> = []
  /** 被人擋住、完全走不動的起始時間。 */
  private blockedSince: number | null = null
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
  readonly fleet: CarFleet
  private npcNod: () => void = () => {}
  private claimUi: { open: boolean; pending: boolean; result: number | null; error: string | null } = { open: false, pending: false, result: null, error: null }
  readonly vehicles: Vehicles
  private lastPortalToastAt = -Infinity
  private fading = false
  private anim = new AnimationSystem()
  private players: Players
  private input: InputController
  private net: NetworkClient
  private audio = new AudioManager()
  private actions = new ActionRegistry()
  private uninstallers: Array<() => void> = []
  private moveCfg!: MoveConfig
  private vehicleAudio: VehicleAudio
  private knockFlight: KnockFlight | null = null
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
  /** 自己目前的名字（伺服器確認過的；離線模式為本機設定）。 */
  private selfName = ''
  /** 送出改名的時間（頻率限制用）。 */
  private lastRenameAt = -Infinity
  /** 等伺服器回報 name 的改名是何時送出的；收到回報後重設。超過 RENAME_PENDING_MS 自動不算等待中（不需計時器）。 */
  private renameSentAt = -Infinity
  private auth: AuthKind = 'guest'
  /** 自己的房內短編號；sync 中出現它代表伺服器校正了自己的位置。 */
  private selfN = -1
  private chatLog: ChatEntry[] = []
  private chatSeq = 0
  private serverOffset = 0
  /** 伺服器廣播的廟會手動狀態；null＝依時鐘。每次 welcome 重設（有手動狀態時伺服器會在 welcome 後補送）。 */
  private fairOverride: boolean | null = null
  private rtt: number | null = null
  private stats = new Map<string, { label: MessageKey; value: string | number }>()
  private uiTimer: ReturnType<typeof setInterval>
  private lastUiStatus: ConnectionStatus | '' = ''
  private lastUiNetworkEnabled = false
  private lastUiRoom: string | null = null
  private lastUiOnline = -1
  private lastUiQuality: QualityLevel | '' = ''
  private lastUiAdaptiveLevel = -1
  private lastUiContextLost = false
  private lastUiFading = false
  private lastUiZone: ZoneId | '' = ''
  private lastUiOutfit = -1
  private lastUiAuth: AuthKind = 'guest'
  private lastUiChatLen = 0
  private lastUiStatsSize = -1
  private lastUiPendingCooldowns = 0
  private lastUiPerfFps = -1
  private lastUiPerfFrameMs = -1
  private lastUiPerfCalls = -1
  private lastUiPerfTriangles = -1
  private lastUiPerfRtt: number | null = null
  private lastUiPerfPosKey = ''
  private lastUiPerfCorrectionP95: number | null | undefined = undefined
  private lastUiRideKey = ''
  private frames = 0
  private frameMsSum = 0
  private fps = 0
  private frameMs = 0
  private fpsWindowStart = performance.now()
  private readonly isTouch = readDeviceInfo().coarse

  constructor(private readonly opts: GameCoreOptions) {
    this.settings = opts.settings
    this.quality = resolveQuality(opts.settings.quality)
    // 自動畫質且為觸控裝置：固定從等級 1 起、最高也只到等級 1。幀率有上限時「順暢」量不出 GPU 餘裕，升到完整解析度只是多發熱。
    const floor = this.adaptiveFloor(opts.settings)
    this.adaptive = new AdaptiveQuality(floor, floor)
    const preset = this.assetPreset()
    this.preset = preset

    // 起始等級的解析度與完整模型範圍（等級 0 時等於預設值）。
    const startLevel = ADAPTIVE_LEVELS[this.adaptive.level]!

    this.renderer = new SceneRenderer(
      opts.canvas,
      preset,
      {
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
      },
      startLevel.resolution,
    )
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

    this.players = new Players(this.renderer.scene, this.anim, this.maxVisibleFor(this.quality), opts.settings.outfit)
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
      onKey: (code) => {
        if (code === 'KeyE') {
          this.toggleRide()
        }
      },
    })

    this.watchBattery()

    this.net = new NetworkClient({ url: opts.wsUrl, name: '', outfit: this.players.local.outfit })
    this.fleet = new CarFleet(this.renderer.scene, this.tracker)
    // 模型到齊前是替代用的方塊；載入完成後重繪一次。
    void this.fleet.load().then(() => this.wake())
    // 領車 NPC：站在檔口櫃台後的凳子上（櫃台頂 1.15 公尺，不墊高只看得到頭頂）。
    this.npcNod = this.players.addNpc({ name: t('ride.npcName'), zone: 'courtyard', ...BOOTH_NPC })
    this.vehicles = new Vehicles({
      fleet: this.fleet,
      net: this.net,
      selfId: () => this.selfId,
    })
    this.vehicleAudio = new VehicleAudio(this.audio)
    this.moveCfg = {
      ...moveConfigFor('courtyard'),
      slowZones: () => this.vehicles.slowZones(),
    }
    this.net.events.on('status', () => this.pushUi(true))
    this.net.events.on('message', (m) => this.onServerMessage(m))
    this.net.events.on('rtt', (ms) => {
      this.rtt = ms
      this.vehicles.onRtt(ms)
    })
    this.net.events.on('sessionExpired', () => {
      // 權杖失效：清掉本機權杖，照常以訪客身份遊玩（權杖本身不出現在提示或 console）
      clearAuth()
      this.toast('auth.expired')
    })

    this.audio.setVolumes(this.volumes())
    this.installGameplay()
    this.actions.subscribe(() => this.pushUi(true))

    document.addEventListener('visibilitychange', this.onVisibility)
    this.uiTimer = setInterval(() => this.pushUi(false), UI_PUSH_MS)
  }

  /**
   * 進入遊戲：必須在使用者點擊事件中呼叫，才能啟用音訊。auth 是本機存的登入權杖（沒有登入為 null），
   * 只放進 hello.session；顯示的名字一律是玩家自己選的。
   */
  async enter(playerName: string, auth: StoredAuth | null = null): Promise<void> {
    this.selfName = playerName
    this.auth = auth?.provider ?? 'guest'
    this.net.setSession(auth?.session)
    this.net.setName(playerName)
    this.players.local.avatar.setName(playerName)
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

  /**
   * 更換本機玩家的衣裝：立即套用到角色、存進設定、重繪並更新 UiState。無效值當成預設衣裝。
   * 離線模式到此為止；連線時另外通知伺服器（見下方接點）。
   */
  setOutfit(outfit: number): void {
    const o = normalizeOutfit(outfit)
    if (o !== this.settings.outfit) {
      this.settings = { ...this.settings, outfit: o }
      saveSettings(this.settings)
    }
    if (!this.players.setOutfit(null, o)) return
    // 本機立即換，不等伺服器；限速、補送與重連時的 hello 由 NetworkClient 負責。
    this.net.setOutfit(o)
    this.wake()
    this.pushUi(true)
  }

  /**
   * 進場後改名。空白時用隨機法號。連線中送 rename，以伺服器回報的名字為準（收到後提示）；
   * 斷線中則在重連的 hello 帶新名字；離線模式直接生效。
   */
  rename(name: string): void {
    const next = normalizeName(name)
    const now = performance.now()
    // 與目前名字相同：不送、不佔用頻率額度，也不提示（伺服器對同名不會回報）
    const decision = decideRename(next, this.selfName, now, this.net.enabled ? this.lastRenameAt : -Infinity)
    if (decision === 'unchanged') return
    if (!this.net.enabled) {
      this.applySelfName(next, true)
      return
    }
    if (decision === 'throttled') {
      this.toast('name.throttled')
      return
    }
    this.lastRenameAt = this.renameSentAt = now
    this.net.setName(next)
  }

  /** 自己的名字確定了：同步回設定，必要時提示。 */
  private applySelfName(name: string, announce: boolean): void {
    this.selfName = name
    // 自己頭上的名牌跟著換（伺服器清理後的結果為準）
    this.players.local.avatar.setName(name)
    this.wake()
    this.opts.onNameChanged?.(name)
    if (announce) this.toast('name.updated', { name })
  }

  /** 開始渲染場景（進場前就先顯示背景畫面）。 */
  start(): void {
    this.wake()
  }

  /** E 鍵與上下車按鈕：騎乘中下車；旁邊有空車就上車；否則在領車 NPC 前開關領車視窗。 */
  toggleRide(): void {
    if (this.fading || performance.now() < this.players.local.lockedUntil) return
    const local = this.players.local.mover
    const ride = this.vehicles.ui(local.x, local.z)
    if (!ride.riding && !ride.nearCar && ride.booth) {
      this.setClaimOpen(!this.claimUi.open)
      return
    }
    // 時段關閉：旁邊有空車也不能上（領車視窗照常開，裡面顯示倒數，按「抽一台」時才提示）
    if (!ride.riding && ride.nearCar && this.sessionClosed()) {
      this.toast('server.sessionClosed')
      return
    }
    this.vehicles.toggleRide(local.x, local.z)
  }

  /** 廟會時段是否關閉：離線或尚未收到伺服器時間時視為開放。 */
  private sessionClosed(): boolean {
    return this.net.enabled && this.selfId !== null && !(this.fairOverride ?? sessionState(performance.now() + this.serverOffset).open)
  }

  /** 手動開關廟會時段（暫時的功能）：送出與目前相反的狀態，畫面等伺服器廣播才變。 */
  toggleFair(): void {
    if (this.net.enabled && this.selfId !== null) this.net.sendFair(this.sessionClosed())
  }

  /** 開關領車視窗。 */
  setClaimOpen(open: boolean): void {
    this.claimUi = { open, pending: false, result: null, error: null }
    this.pushUi(true)
  }

  /** 在領車視窗裡按「抽一台」：車種由伺服器隨機分配。 */
  claimCar(): void {
    if (this.claimUi.pending) return
    if (this.sessionClosed()) {
      this.toast('server.sessionClosed')
      return
    }
    this.claimUi = { open: true, pending: true, result: null, error: null }
    this.vehicles.claim()
    this.pushUi(true)
  }

  /**
   * 玩家按下動作。不能在目前場景使用時提示原因；需要先走到定點的動作（approach）先自動走過去，抵達後才開始。
   * 正在做可提前結束的動作（endAction，例如誦經）時，按任何動作都先起身；按的是同一個動作就只起身。
   */
  performAction(id: string): void {
    const now = performance.now()
    this.lastInputAt = now
    if (this.vehicles.riding !== null) {
      this.toast('reason.dismountFirst')
      return
    }
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
      this.toast('move.unreachable')
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
      else this.opts.onToast(actionFailedMessage(res.reason))
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

  /** 動態畫質的等級下限：自動畫質且為觸控裝置時為 1（不升到完整解析度），其餘為 0。 */
  private adaptiveFloor(settings: Settings): number {
    return settings.quality === 'auto' && readDeviceInfo().coarse ? 1 : 0
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
    // 自動 ↔ 手動切換時動態畫質的下限也要跟著變；下限拉高時等級被推上去，同步解析度與完整模型範圍。
    if (settingChanged && this.adaptive.setMinLevel(this.adaptiveFloor(settings))) {
      const level = ADAPTIVE_LEVELS[this.adaptive.level]!
      this.renderer.setResolutionScale(level.resolution)
      this.players.nearRadius = level.nearRadius
    }
    this.audio.setVolumes(this.volumes())
    // 設定面板的衣裝選擇也可能經由這裡進來（App 的 settings 與 UiState.outfit 同步）
    if (settings.outfit !== this.players.local.outfit) this.setOutfit(settings.outfit)
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
    this.vehicles.dispose()
    this.fleet.dispose()
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
    const fps = frameCap({
      activeFps: preset.activeFps,
      idleMs: time - this.lastInputAt,
      lowBattery: this.lowBattery,
      touch: this.isTouch,
    })
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

    if (this.knockFlight !== null) {
      const flight = this.knockFlight
      const p = Math.min(1, Math.max(0, (now - flight.start) / (flight.end - flight.start)))
      local.mover.x = flight.fromX + (flight.toX - flight.fromX) * p
      local.mover.z = flight.fromZ + (flight.toZ - flight.fromZ) * p
      this.players.syncLocalTransform()
      if (p >= 1) {
        this.knockFlight = null
      }
      wantsMove = true
    }

    const riding = this.vehicles.riding !== null
    if (riding) {
      this.lastInputAt = now
      this.path = []
      this.pending = null
      const k = this.moveInput()
      wantsMove = k.x !== 0 || k.y !== 0
      const yaw = this.renderer.yaw
      const dirX = Math.cos(yaw) * k.x + Math.sin(yaw) * k.y
      const dirZ = -Math.sin(yaw) * k.x + Math.cos(yaw) * k.y
      this.vehicles.setStick(dirX, dirZ)
      // 先推進物理再讀騎士位置，騎士與車身才是同一個時間點。
      this.vehicles.advance(dt, now)

      const rider = this.vehicles.riderCar(this.selfId ?? '')
      if (rider) {
        local.mover.x = rider.x
        local.mover.z = rider.z
        local.mover.heading = rider.heading
        local.mover.target = null
      }
      moving = false
      local.anim.moving = false
      if (local.anim.clip !== 'ride' && local.anim.clip !== 'knocked') {
        this.anim.play(local.anim, 'ride', now, Infinity)
      }
      if (this.wasMoving) {
        this.net.sendPosition(local.mover.x, local.mover.z, local.mover.heading, false)
        this.wasMoving = false
      }
    } else {
      if (local.anim.clip === 'ride') {
        local.anim.clip = null
      }
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
        const beforeX = local.mover.x
        const beforeZ = local.mover.z
        moving = stepMover(local.mover, { dirX, dirZ }, dt, this.moveCfg)
        if (moving) moving = this.collideLocal(beforeX, beforeZ, now)
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
            this.toast('move.blocked')
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
    }

    // 走進出入口（從外面踏入，避免出生點剛好在出入口時來回觸發）
    // 小幅糾正：約 150 毫秒內補完（每幀補掉剩餘位移的一部分）。補上去的量也加到位置紀錄裡，
    // 之後的糾正才不會把同一段差額再算一次。
    if (this.slideX !== 0 || this.slideZ !== 0) {
      const a = 1 - Math.exp(-dt / 0.05)
      const p = resolveCollisions(local.mover.x + this.slideX * a, local.mover.z + this.slideZ * a, this.moveCfg)
      const ax = p.x - local.mover.x
      const az = p.z - local.mover.z
      for (const s of this.posTrail) {
        s.x += ax
        s.z += az
      }
      local.mover.x = p.x
      local.mover.z = p.z
      this.slideX *= 1 - a
      this.slideZ *= 1 - a
      if (Math.hypot(this.slideX, this.slideZ) < 0.005) this.slideX = this.slideZ = 0
      moving = true
    }
    // 最近 1.5 秒走過的位置，糾正時用來找「伺服器算那個位置時本機在哪裡」
    this.posTrail.push({ t: now, x: local.mover.x, z: local.mover.z })
    while (this.posTrail.length > 2 && this.posTrail[0]!.t < now - 1500) this.posTrail.shift()
    const portal = portalAt(this.zone, local.mover.x, local.mover.z)
    if (portal) {
      if (riding) {
        if (now - this.lastPortalToastAt > 4000) {
          this.toast('ride.dismountFirst')
          this.lastPortalToastAt = now
        }
      } else if (!this.inPortal && !this.fading && this.knockFlight === null) {
        this.beginZoneTransition(portal)
      }
    }
    this.inPortal = portal !== null && !riding && this.knockFlight === null

    // 車先算好這一幀的位置，騎在上面的人（players.update 會讀 riderCar）才不會比車晚一幀。
    const serverNow = now + this.serverOffset
    const vehiclesActive = this.vehicles.update(now, serverNow, dt)
    const playersActive = this.players.update(now, dt, t, (id) => this.vehicles.riderCar(id))
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

    const sceneMotion =
      this.zone === 'courtyard' && (this.temple.hasTransientMotion() || striking || vehiclesActive)
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
    if (this.vehicles.riding !== null) return
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
      this.toast(portal.to === 'hall' ? 'zone.entered' : 'zone.returned', { zone: t(ZONES[portal.to].name) })
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
    if (this.vehicles.riding !== null) {
      this.net.sendRide(null)
    }
    this.vehicles.setLocalZone(zone)
    if (zone === 'hall' && !this.hall) {
      this.hall = buildHallScene(this.renderer.renderer, this.tracker, this.assetPreset(), () => this.wake())
      this.renderer.scene.add(this.hall.root)
    }
    if (zone !== this.zone) {
      const r = this.renderer
      this.savedCamera[this.zone] = { yaw: r.yaw, pitch: r.pitch, distance: r.distance }
    }
    this.zone = zone
    this.moveCfg = {
      ...moveConfigFor(zone),
      slowZones: () => this.vehicles.slowZones(),
    }
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
    this.knockFlight = null
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
  /**
   * 本機先行的玩家碰撞：走進別人的範圍時自己少走一半、對方在畫面上被推開一半（world/collide.ts，與伺服器同一套規則）。
   * 回傳這一幀實際上有沒有移動。
   */
  private collideLocal(prevX: number, prevZ: number, now: number): boolean {
    const m = this.players.local.mover
    const others: Body[] = []
    for (const r of this.players.remotes.values()) {
      if (r.zone !== this.zone || this.vehicles.riderCar(r.id)) continue
      // 定點動作中的人推不動；合十之類不鎖定移動的動作不算
      others.push({ n: r.n, x: r.x, z: r.z, rooted: now < r.lockedUntil })
    }
    if (others.length === 0) return true
    const valid = (x: number, z: number) => {
      const p = resolveCollisions(x, z, this.moveCfg)
      return Math.abs(p.x - x) < 1e-6 && Math.abs(p.z - z) < 1e-6
    }
    const r = resolveMove({ x: m.x, z: m.z }, { x: prevX, z: prevZ }, others, 0, valid)
    m.x = r.x
    m.z = r.z
    for (const o of r.moved) this.players.nudgeRemoteByN(o.n, o.x, o.z)
    // 被人擋住走不動超過 1.5 秒：放棄點擊移動的目標（人會被推開，所以不重新尋路）
    const advanced = Math.hypot(m.x - prevX, m.z - prevZ) > 1e-4
    if (advanced) this.blockedSince = null
    else if (this.blockedSince === null) this.blockedSince = now
    else if (now - this.blockedSince > 1500 && m.target) {
      m.target = null
      this.path = []
      this.pending = null
      this.marker.visible = false
      this.blockedSince = null
    }
    return advanced
  }

  /**
   * 伺服器把本機玩家放到 (x, z)。這個位置是伺服器「一個來回延遲之前」算的，那之後本機已經又走了一段：
   * 所以拿它和本機當時的位置比，只把差額補到現在的位置上（伺服器照單全收時差額是 0，完全不動）。
   * 差額小（被人推了一下、碰撞結果略有出入）就滑過去，差額大（下車、被撞飛落地、被拒絕）才瞬移到伺服器的位置。
   */
  private correctLocal(x: number, z: number): void {
    const cur = this.players.local.mover
    const at = performance.now() - (this.rtt ?? 0)
    // 走過的位置紀錄裡，時間不晚於 at 的最後一筆；沒有紀錄就用現在的位置
    let past: { x: number; z: number } = cur
    for (let i = this.posTrail.length - 1; i >= 0; i--) {
      if (this.posTrail[i]!.t <= at) {
        past = this.posTrail[i]!
        break
      }
      past = this.posTrail[i]!
    }
    const dx = x - past.x
    const dz = z - past.z
    if (Math.hypot(dx, dz) < SMOOTH_CORRECTION_M) {
      // 已經在補的位移也算在「當時的位置」裡，所以直接換成新的差額
      this.slideX = dx
      this.slideZ = dz
      this.wake()
      return
    }
    this.posTrail.length = 0
    this.slideX = this.slideZ = 0
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
    this.vehicles.onVisibilityChange(document.hidden)
    if (document.hidden) {
      if (this.vehicles.riding !== null) {
        this.net.sendRide(null)
      }
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
        this.auth = m.auth
        this.serverOffset = m.serverTime - performance.now()
        this.players.clearRemotes()
        for (const p of m.players) {
          // 自己的位置平常由本機決定；短編號只對照遠端玩家，moves 中不會有自己，sync 中的自己是伺服器的校正。
          if (p.id === m.selfId) {
            this.selfN = p.n
            // 伺服器清理過的名字為準（斷線期間改名時，重連的 hello 已帶新名字）
            const pending = isRenamePending(this.renameSentAt, performance.now())
            if (p.name !== this.selfName || pending) this.applySelfName(p.name, pending)
            this.renameSentAt = -Infinity
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
        this.vehicles.onWelcome(m.cars ?? [])
        this.fairOverride = null
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
      case 'outfit':
        // 自己的回音一律忽略：本機已立即套用，較舊的回音晚到不可把外觀改回去（setRemoteOutfit 只動遠端玩家）。
        if (m.id !== this.selfId) this.players.setRemoteOutfit(m.id, m.outfit)
        break
      case 'name':
        if (m.id === this.selfId) {
          this.applySelfName(m.name, isRenamePending(this.renameSentAt, performance.now()) || m.name !== this.selfName)
          this.renameSentAt = -Infinity
        } else {
          this.players.rename(m.id, m.name)
        }
        break
      case 'pong':
        this.serverOffset = m.serverTime - performance.now()
        break
      case 'car':
        this.vehicles.onCar(m)
        // 自己剛領到車：視窗顯示抽到的車種，NPC 點頭。
        if (this.claimUi.pending && m.driver !== null && m.driver === this.selfId) {
          this.claimUi = { open: true, pending: false, result: m.kind, error: null }
          this.npcNod()
        }
        this.pushUi(true)
        this.wake()
        break
      case 'carGone':
        this.vehicles.onCarGone(m.c)
        this.pushUi(true)
        this.wake()
        break
      case 'fair':
        this.fairOverride = m.open
        this.pushUi(true)
        break
      case 'cars':
        this.vehicles.onCars(m.ack, m.cars, performance.now())
        for (const c of m.cars) {
          if (c.bumped) {
            this.vehicleAudio.playBump(c.x, c.z, this.players.local.mover.x, this.players.local.mover.z)
          }
        }
        this.wake()
        break
      case 'knock':
        this.onKnock(m)
        this.wake()
        break
      case 'error':
        if (this.claimUi.pending) {
          // 領車被拒絕：原因顯示在視窗裡，不另外跳提示。
          this.claimUi = { open: true, pending: false, result: null, error: SERVER_ERRORS.get(m.code) ?? 'server.error' }
          this.pushUi(true)
          break
        }
        this.toast(SERVER_ERRORS.get(m.code) ?? 'server.error')
        break
    }
    if (m.t === 'welcome' || m.t === 'join' || m.t === 'leave' || m.t === 'name' || m.t === 'car' || m.t === 'carGone') this.pushUi(true)
    this.wake()
  }

  private onChat(m: Extract<ServerMessage, { t: 'chat' }>): void {
    const self = m.id === (this.selfId ?? 'local')
    const now = performance.now()
    const name = (self ? this.selfName : this.players.remotes.get(m.id)?.name) || t('player.visitor')
    this.chatLog = [...this.chatLog, { seq: ++this.chatSeq, id: m.id, name, text: m.text, at: m.at, seen: now, self }].slice(-CHAT_LOG_MAX)
    this.players.say(self ? null : m.id, m.text, now + CHAT_BUBBLE_MS)
    this.pushUi(true)
  }

  private onKnock(m: Extract<ServerMessage, { t: 'knock' }>): void {
    const now = performance.now()
    handleKnock(
      {
        selfId: this.selfId,
        serverOffset: this.serverOffset,
        fading: this.fading,
        local: this.players.local,
        clearLocalActions: () => {
          this.pending = null
          this.path = []
          this.lockedAction = null
          this.players.local.anim.clip = null
        },
        playAnim: (anim, clip, n, durationMs, startedAt) => {
          this.anim.play(anim, clip, n, durationMs, startedAt)
        },
        playAudio: (knockX, knockZ, selfX, selfZ) => {
          if (this.zone === 'courtyard') {
            this.vehicleAudio.playKnock(knockX, knockZ, selfX, selfZ)
          }
        },
        setKnockFlight: (flight) => {
          this.knockFlight = flight
        },
        syncLocalTransform: () => {
          this.players.syncLocalTransform()
        },
        remotes: this.players.remotes,
        applyRemoteKnock: (r, fromX, fromZ, toX, toZ, startAt, endAt) => {
          this.players.applyKnock(r, fromX, fromZ, toX, toZ, startAt, endAt)
        },
        syncRemoteByN: (n, x, z, heading, moving, time) => {
          this.players.syncRemoteByN(n, x, z, heading, moving, time)
        },
      },
      m,
      now,
    )
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
    const now = performance.now()
    const curOnline = this.net.enabled ? this.players.count : 1
    const curStatus = this.net.connectionStatus
    const curNetworkEnabled = this.net.enabled
    const curRoom = this.room
    const curQuality = this.quality
    const curAdaptiveLevel = this.adaptive.level
    const curContextLost = this.contextLost
    const curFading = this.fading
    const curZone = this.zone
    const curOutfit = this.players.local.outfit
    const curAuth = this.auth
    const curChatLen = this.chatLog.length
    const curStatsSize = this.stats.size

    // 檢查冷卻中的動作數量是否有變化（例如冷卻到期）
    let activeCooldowns = 0
    const actionList = this.actions.list()
    for (let i = 0; i < actionList.length; i++) {
      if (this.actions.readyAt(actionList[i]!.id) > now) {
        activeCooldowns++
      }
    }

    const curRide = this.vehicles.ui(this.players.local.mover.x, this.players.local.mover.z)
    // 走離 NPC 就關掉領車視窗（剛抽到車、正在看結果時不關）。
    if (this.claimUi.open && !curRide.booth && this.claimUi.result === null) this.claimUi = { open: false, pending: false, result: null, error: null }
    curRide.claim = this.claimUi
    if (curZone === 'courtyard' && this.net.enabled && this.selfId !== null) {
      const ss = sessionState(now + this.serverOffset)
      curRide.session = this.fairOverride === null ? { open: ss.open, secs: Math.ceil(ss.msToChange / 1000) } : { open: this.fairOverride, secs: 0, manual: true }
    }
    const curRideKey = `${curRide.session ? `${curRide.session.open}/${curRide.session.secs}/${curRide.session.manual}` : ''}:${curRide.riding}:${curRide.nearCar}:${curRide.booth ? curRide.booth.left.join(',') : ''}:${this.claimUi.open}:${this.claimUi.pending}:${this.claimUi.result}:${this.claimUi.error}`

    let dirty = force
    if (!dirty) {
      if (
        curStatus !== this.lastUiStatus ||
        curNetworkEnabled !== this.lastUiNetworkEnabled ||
        curRoom !== this.lastUiRoom ||
        curOnline !== this.lastUiOnline ||
        curQuality !== this.lastUiQuality ||
        curAdaptiveLevel !== this.lastUiAdaptiveLevel ||
        curContextLost !== this.lastUiContextLost ||
        curFading !== this.lastUiFading ||
        curZone !== this.lastUiZone ||
        curOutfit !== this.lastUiOutfit ||
        curAuth !== this.lastUiAuth ||
        curChatLen !== this.lastUiChatLen ||
        curStatsSize !== this.lastUiStatsSize ||
        activeCooldowns !== this.lastUiPendingCooldowns ||
        curRideKey !== this.lastUiRideKey
      ) {
        dirty = true
      }
    }

    const showStats = this.settings.showStats
    const curFps = now - this.lastRender > 1500 ? 0 : this.fps
    const r = this.renderer.stats
    const curCalls = r.calls
    const curTriangles = r.triangles
    const curFrameMs = this.frameMs
    const curRtt = this.rtt
    const curPos = this.debugPos()
    const curPosKey = curPos ? `${curPos.zone}:${curPos.x}:${curPos.z}:${curPos.heading}` : ''

    const curCorrectionP95 = this.vehicles.correctionP95

    if (!dirty && showStats) {
      if (
        curFps !== this.lastUiPerfFps ||
        curFrameMs !== this.lastUiPerfFrameMs ||
        curCalls !== this.lastUiPerfCalls ||
        curTriangles !== this.lastUiPerfTriangles ||
        curRtt !== this.lastUiPerfRtt ||
        curPosKey !== this.lastUiPerfPosKey ||
        curCorrectionP95 !== this.lastUiPerfCorrectionP95
      ) {
        dirty = true
      }
    }

    if (!dirty) return

    this.lastUiStatus = curStatus
    this.lastUiNetworkEnabled = curNetworkEnabled
    this.lastUiRoom = curRoom
    this.lastUiOnline = curOnline
    this.lastUiQuality = curQuality
    this.lastUiAdaptiveLevel = curAdaptiveLevel
    this.lastUiContextLost = curContextLost
    this.lastUiFading = curFading
    this.lastUiZone = curZone
    this.lastUiOutfit = curOutfit
    this.lastUiAuth = curAuth
    this.lastUiChatLen = curChatLen
    this.lastUiStatsSize = curStatsSize
    this.lastUiPendingCooldowns = activeCooldowns
    this.lastUiRideKey = curRideKey
    this.lastUiPerfFps = curFps
    this.lastUiPerfFrameMs = curFrameMs
    this.lastUiPerfCalls = curCalls
    this.lastUiPerfTriangles = curTriangles
    this.lastUiPerfRtt = curRtt
    this.lastUiPerfPosKey = curPosKey
    this.lastUiPerfCorrectionP95 = curCorrectionP95

    const state: UiState = {
      status: curStatus,
      networkEnabled: curNetworkEnabled,
      room: curRoom,
      online: curOnline,
      quality: curQuality,
      adaptive: { level: curAdaptiveLevel, max: ADAPTIVE_LEVELS.length - 1 },
      contextLost: curContextLost,
      fading: curFading,
      zone: curZone,
      outfit: curOutfit,
      auth: curAuth,
      actions: actionList.filter((a) => !a.hidden).map((a) => {
        const unavailable = a.unavailableReason?.(curZone)
        return {
          id: a.id,
          label: t(a.label),
          glyph: a.glyph,
          cooldownMs: a.cooldownMs,
          readyAt: this.actions.readyAt(a.id),
          ...(unavailable ? { unavailable } : {}),
        }
      }),
      chat: this.chatLog,
      stats: [...this.stats].map(([key, s]) => ({ key, label: t(s.label), value: s.value })),
      ride: curRide,
      perf: {
        fps: curFps,
        frameMs: curFrameMs,
        calls: curCalls,
        triangles: curTriangles,
        rttMs: curRtt,
        pos: curPos,
        carCorrectionP95: curCorrectionP95,
      },
    }

    this.opts.onUi(state)
  }

  /** 以目前語言提示（toast 以發出當下的語言為準，已顯示的不回頭改）。 */
  private toast(key: MessageKey, params?: Record<string, string | number>): void {
    this.opts.onToast(t(key, params))
  }

  /** 效能資訊面板的本機座標；沒開效能資訊時為 null。 */
  private debugPos(): DebugPosition | null {
    if (!this.settings.showStats) return null
    const m = this.players.local.mover
    return debugPosition(this.zone, m.x, m.z, m.heading)
  }

  private volumes() {
    const s = this.settings
    return { master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume, muted: s.muted }
  }

  private maxVisibleFor(q: QualityLevel): number {
    return q === 'low' ? 40 : q === 'medium' ? 60 : 120
  }
}

