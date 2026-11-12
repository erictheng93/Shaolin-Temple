import * as THREE from 'three'
import { AnimationSystem } from './anim/AnimationSystem'
import { AudioManager } from './audio/AudioManager'
import { Emitter } from './core/Emitter'
import { QUALITY_PRESETS, resolveQuality, type QualityLevel, type Settings } from './core/settings'
import { ActionRegistry } from './gameplay/ActionRegistry'
import { gameplayModules } from './gameplay/modules'
import type { GameEvents, GameplayApi } from './gameplay/types'
import { InputController } from './input/InputController'
import { NetworkClient, type ConnectionStatus } from './net/NetworkClient'
import type { ServerMessage } from './net/protocol'
import { ResourceTracker } from './render/ResourceTracker'
import { buildHallScene, type HallScene } from './render/HallScene'
import { HALL_ENV, OUTDOOR_ENV, SceneRenderer } from './render/SceneRenderer'
import { buildTempleScene, type TempleScene } from './render/TempleScene'
import { resolveCollisions, stepMover, type MoveConfig } from './world/movement'
import { findPath, type Point } from './world/pathfind'
import { Players } from './world/Players'
import { ZONES, entryCamera, isZoneId, portalApproach, portalAt, portalForTap, type CameraPose, type Portal, type Pose, type ZoneId } from './world/zones'

export interface UiAction {
  id: string
  label: string
  glyph?: string
  cooldownMs: number
  /** 冷卻結束的時間（performance.now 毫秒），UI 自行計算倒數。 */
  readyAt: number
}

/** 給 Vue 的低頻狀態摘要。遊戲核心只在內容改變時推送。 */
export interface UiState {
  status: ConnectionStatus
  networkEnabled: boolean
  room: string | null
  online: number
  quality: QualityLevel
  contextLost: boolean
  /** 場景切換中（畫面淡出黑幕）。 */
  fading: boolean
  zone: ZoneId
  actions: UiAction[]
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

const MOVE_SPEED = 3.2
const SFX_HEARING_RANGE = 28
const UI_PUSH_MS = 250
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
  /** 點擊移動尚未走到的轉折點（目前目標在 mover.target）。 */
  private path: Point[] = []
  private fading = false
  private anim = new AnimationSystem()
  private players: Players
  private input: InputController
  private net: NetworkClient
  private audio = new AudioManager()
  private actions = new ActionRegistry()
  private uninstallers: Array<() => void> = []
  private moveCfg: MoveConfig = moveConfigFor('courtyard')
  private raycaster = new THREE.Raycaster()
  private marker: THREE.Mesh
  private markerUntil = 0

  private settings: Settings
  private quality: QualityLevel
  private raf = 0
  private lastTime = 0
  private lastRender = 0
  private startTime = performance.now()
  private dirty = true
  private snapCamera = true
  private paused = false
  private contextLost = false
  private wasMoving = false
  private disposed = false

  private room: string | null = null
  private selfId: string | null = null
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
    const preset = QUALITY_PRESETS[this.quality]

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

    this.temple = buildTempleScene(this.tracker, preset, () => this.wake())
    this.renderer.scene.add(this.temple.root)

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
        // 使用者有操作時順便嘗試恢復被系統中斷的音訊（iOS）。
        if (this.audio.audible && !this.audio.running && !this.paused) void this.audio.resume()
        this.wake()
      },
    })

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
    await this.audio.unlock()
    this.audio.startAmbient()
    this.net.connect()
    this.snapCamera = true
    this.wake()
    this.pushUi(true)
  }

  /** 開始渲染場景（進場前就先顯示背景畫面）。 */
  start(): void {
    this.wake()
  }

  performAction(id: string): void {
    const now = performance.now()
    const local = this.players.local
    if (now < local.lockedUntil) return
    const def = this.actions.tryBegin(id, now)
    if (!def) return

    if (def.locksMovement) {
      local.lockedUntil = now + def.durationMs
      local.mover.target = null
      this.path = []
    }
    this.anim.play(local.anim, def.animation, now, def.durationMs)
    if (def.sound) this.audio.play(def.sound)
    this.events.emit('actionPerformed', {
      playerId: this.selfId ?? 'local',
      actionId: id,
      local: true,
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

  applySettings(settings: Settings): void {
    this.settings = settings
    const q = resolveQuality(settings.quality)
    if (q !== this.quality) {
      this.quality = q
      this.renderer.setQuality(QUALITY_PRESETS[q])
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
    clearInterval(this.uiTimer)
    this.stopLoop()
    for (const off of this.uninstallers) off()
    this.uninstallers = []
    this.input.dispose()
    this.net.dispose()
    void this.audio.dispose()
    this.players.dispose()
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

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private frame = (time: number): void => {
    this.raf = 0
    if (this.paused || this.contextLost) return
    const preset = QUALITY_PRESETS[this.quality]

    // 依目標幀率略過多餘的 rAF（高更新率螢幕上限制在 30/60 FPS）。
    const minInterval = 1000 / preset.activeFps - 1
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

    if (now >= local.lockedUntil) {
      const k = this.input.keyDirection
      if (k.x !== 0 || k.y !== 0) this.path = [] // 鍵盤操作取消點擊路徑
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

    const sceneMotion = this.zone === 'courtyard' && this.temple.hasTransientMotion()
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

  private onTap(ndcX: number, ndcY: number): void {
    const local = this.players.local
    if (performance.now() < local.lockedUntil) return
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.renderer.camera)
    const surface = this.zone === 'hall' && this.hall ? this.hall.walkSurface : this.temple.walkSurface
    const hit = this.raycaster.intersectObject(surface, false)[0]
    if (!hit) return
    // 點到主殿建築時走向殿門，而不是被推到建築最近的邊緣。
    const tapPortal = portalForTap(this.zone, hit.point.x, hit.point.z)
    const want = tapPortal ? portalApproach(tapPortal) : { x: hit.point.x, z: hit.point.z }
    const p = resolveCollisions(want.x, want.z, this.moveCfg)
    const path = findPath({ x: local.mover.x, z: local.mover.z }, p, this.moveCfg)
    if (!path) return
    local.mover.target = path.shift() ?? null
    this.path = path
    this.marker.position.set(p.x, 0.08, p.z)
    this.marker.visible = true
    this.markerUntil = performance.now() + 1600
    this.wake()
  }

  // ---------- 場景切換 ----------

  /** 淡出 → 切換場景 → 淡入。期間鎖住移動。 */
  private beginZoneTransition(portal: Portal): void {
    const local = this.players.local
    this.fading = true
    local.mover.target = null
    this.path = []
    local.lockedUntil = performance.now() + FADE_MS * 2 + FADE_HOLD_MS
    this.input.clearKeys()
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
      this.hall = buildHallScene(this.tracker)
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
    this.players.setLocalZone(zone)
    this.inPortal = portalAt(zone, pos.x, pos.z) !== null
    this.marker.visible = false
    this.audio.setIndoor(zone === 'hall')
    this.snapCamera = true
    this.wake()
    this.pushUi(true)
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
          if (p.id === m.selfId) {
            // 伺服器記錄的場景與位置為準（斷線恢復時可能在殿內）。
            const zone: ZoneId = isZoneId(p.zone) ? p.zone : 'courtyard'
            this.applyZone(zone, { x: p.x, z: p.z, heading: p.heading })
          } else {
            const r = this.players.upsert(p)
            if (p.action) {
              const def = this.actions.get(p.action.id)
              if (def) this.anim.play(r.anim, def.animation, performance.now(), def.durationMs, p.action.startedAt - this.serverOffset)
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
        if (m.id !== this.selfId) this.players.setRemoteTarget(m.id, m.x, m.z, m.heading, m.moving)
        break
      case 'moves':
        for (const [id, x, z, heading, moving] of m.m) {
          if (id !== this.selfId) this.players.setRemoteTarget(id, x, z, heading, moving === 1)
        }
        break
      case 'action':
        this.onRemoteAction(m)
        break
      case 'zone':
        if (m.id !== this.selfId) this.players.setRemoteZone(m.id, m.zone, m.x, m.z, m.heading)
        break
      case 'pong':
        this.serverOffset = m.serverTime - performance.now()
        break
      case 'error':
        this.opts.onToast(m.message)
        break
    }
    if (m.t === 'welcome' || m.t === 'join' || m.t === 'leave') this.pushUi(true)
    this.wake()
  }

  private onRemoteAction(m: Extract<ServerMessage, { t: 'action' }>): void {
    if (m.playerId === this.selfId) return
    const r = this.players.remotes.get(m.playerId)
    const def = this.actions.get(m.id)
    if (!r || !def) return
    const now = performance.now()
    const startedAt = m.startedAt - this.serverOffset
    if (now - startedAt > def.durationMs) return
    this.anim.play(r.anim, def.animation, now, def.durationMs, startedAt)
    if (def.sound && r.zone === this.zone && now - startedAt < 1500) {
      const local = this.players.local.mover
      const d = Math.hypot(r.x - local.x, r.z - local.z)
      this.audio.play(def.sound, { gain: Math.max(0, 1 - d / SFX_HEARING_RANGE) * 0.7 })
    }
    this.events.emit('actionPerformed', { playerId: r.id, actionId: m.id, local: false, x: r.x, z: r.z })
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
      },
      setStat: (key, label, value) => {
        if (value === null) this.stats.delete(key)
        else this.stats.set(key, { label, value })
        this.pushUi(true)
      },
      localPosition: () => ({ x: this.players.local.mover.x, z: this.players.local.mover.z }),
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
      contextLost: this.contextLost,
      fading: this.fading,
      zone: this.zone,
      actions: this.actions.list().map((a) => ({
        id: a.id,
        label: a.label,
        glyph: a.glyph,
        cooldownMs: a.cooldownMs,
        readyAt: this.actions.readyAt(a.id),
      })),
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
    return q === 'medium' ? 60 : 120
  }
}

