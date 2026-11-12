import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import type { QualityPreset } from '../core/settings'
import { SKY_COLOR } from './TempleScene'

/** 場景環境：背景、霧、半球光與主光。 */
export interface Environment {
  background: string
  fog: { near: number; far: number } | null
  hemi: { sky: string; ground: string; intensity: number }
  sun: { color: string; intensity: number; position: [number, number, number] }
  /** 戶外：程序化天空、天空環境光反射、色調映射與即時陰影。null 表示室內，維持原本未經色調映射的畫面。 */
  outdoor: { exposure: number; environmentIntensity: number } | null
}

export const OUTDOOR_ENV: Environment = {
  background: SKY_COLOR,
  fog: { near: 30, far: 125 },
  hemi: { sky: '#dfe6f2', ground: '#7a6a4c', intensity: 0.45 },
  // 清晨低角度的暖色主光，從殿前右側斜照；天空的太陽也在這個方向
  sun: { color: '#ffd2a0', intensity: 3.4, position: [16, 7, 12] },
  outdoor: { exposure: 0.6, environmentIntensity: 0.4 },
}

/** 殿內：暗而暖，主光從殿門方向斜照神龕，讓神像正面受光。 */
export const HALL_ENV: Environment = {
  background: '#140e0b',
  fog: { near: 16, far: 38 },
  hemi: { sky: '#ffe2b8', ground: '#3a2418', intensity: 1.5 },
  sun: { color: '#ffd29a', intensity: 1.9, position: [1.5, 6, 9] },
  outdoor: null,
}

export type CameraBounds = { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number }

type P3 = { x: number; y: number; z: number }

/**
 * 把理想鏡頭位置 d 限制在室內範圍 b：水平方向沿焦點 f 到 d 的連線拉近（不穿牆），
 * 高度保持不變、只受天花板限制。靠牆時鏡頭因此變成較高的俯視角，而不是壓低到角色頭部。
 * 焦點本身應在範圍內。
 */
export function clampCamera(f: P3, d: P3, b: CameraBounds): P3 {
  let t = 1
  const limit = (from: number, to: number, min: number, max: number) => {
    if (to > max && to !== from) t = Math.min(t, (max - from) / (to - from))
    if (to < min && to !== from) t = Math.min(t, (min - from) / (to - from))
  }
  limit(f.x, d.x, b.minX, b.maxX)
  limit(f.z, d.z, b.minZ, b.maxZ)
  t = Math.max(0, t)
  return { x: f.x + (d.x - f.x) * t, y: Math.min(d.y, b.maxY), z: f.z + (d.z - f.z) * t }
}

export interface RendererCallbacks {
  onContextLost(): void
  onContextRestored(): void
}

/**
 * Three.js renderer、場景、鏡頭與畫質。不擁有遊戲物件，只負責把場景畫出來。
 */
export class SceneRenderer {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  private preset: QualityPreset
  private resizeObserver: ResizeObserver
  private width = 1
  private height = 1

  // 第三人稱鏡頭參數
  yaw = 0
  pitch = 0.4
  distance = 10
  minDistance = 5
  maxDistance = 20
  /** 室內鏡頭範圍；鏡頭理想位置在範圍外時沿視線拉近，避免穿牆。 */
  cameraBounds: CameraBounds | null = null
  private focus = new THREE.Vector3()
  private focusY = 1.1
  private desired = new THREE.Vector3()
  private hemi: THREE.HemisphereLight
  private sun: THREE.DirectionalLight
  private sky = new Sky()
  private skyEnv: THREE.WebGLRenderTarget | null = null
  private env: Environment = OUTDOOR_ENV

  constructor(
    private readonly canvas: HTMLCanvasElement,
    preset: QualityPreset,
    private readonly callbacks: RendererCallbacks,
  ) {
    this.preset = preset
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: preset.antialias,
      powerPreference: 'low-power',
      stencil: false,
    })
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.2, 160)
    this.hemi = new THREE.HemisphereLight()
    this.sun = new THREE.DirectionalLight()
    this.scene.add(this.hemi, this.sun, this.sun.target)

    // 即時陰影：正交範圍涵蓋整個庭院（含圍牆）。
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    const shadow = this.sun.shadow
    shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize)
    Object.assign(shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 160 })
    shadow.bias = -0.0004
    shadow.normalBias = 0.04

    // 程序化天空（大氣散射）：不需要 HDR 檔。z 由 shader 固定在遠平面，不受鏡頭 far 影響。
    this.sky.scale.setScalar(10000)
    Object.assign(this.sky.material.uniforms.turbidity!, { value: 5 })
    Object.assign(this.sky.material.uniforms.rayleigh!, { value: 2.2 })
    Object.assign(this.sky.material.uniforms.mieCoefficient!, { value: 0.006 })
    Object.assign(this.sky.material.uniforms.mieDirectionalG!, { value: 0.82 })
    this.sky.material.uniforms.sunPosition!.value.set(...OUTDOOR_ENV.sun.position).normalize()
    this.scene.add(this.sky)
    this.setEnvironment(OUTDOOR_ENV)

    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    this.resize()
  }

  /** 把天空烘成環境貼圖，供寫實材質的環境光與反射使用。context 恢復後內容會遺失，需重建。 */
  private bakeSkyEnvironment(): THREE.Texture {
    this.skyEnv?.dispose()
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const scene = new THREE.Scene()
    const parent = this.sky.parent
    scene.add(this.sky)
    this.skyEnv = pmrem.fromScene(scene, 0, 0.1, 100)
    parent?.add(this.sky)
    pmrem.dispose()
    return this.skyEnv.texture
  }

  setEnvironment(env: Environment): void {
    this.env = env
    this.sky.visible = env.outdoor !== null
    this.scene.environment = env.outdoor ? (this.skyEnv?.texture ?? this.bakeSkyEnvironment()) : null
    this.scene.environmentIntensity = env.outdoor?.environmentIntensity ?? 1
    this.renderer.toneMapping = env.outdoor ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping
    this.renderer.toneMappingExposure = env.outdoor?.exposure ?? 1
    this.sun.castShadow = env.outdoor !== null
    this.renderer.setClearColor(env.background)
    this.scene.background = new THREE.Color(env.background)
    this.scene.fog = env.fog ? new THREE.Fog(env.background, env.fog.near, env.fog.far) : null
    this.hemi.color.set(env.hemi.sky)
    this.hemi.groundColor.set(env.hemi.ground)
    this.hemi.intensity = env.hemi.intensity
    this.sun.color.set(env.sun.color)
    this.sun.intensity = env.sun.intensity
    // 拉遠主光，讓陰影的正交視錐包住整個場地（平行光只看方向，不影響照明）
    this.sun.position.set(...env.sun.position).multiplyScalar(env.outdoor ? 4 : 1)
    this.sun.target.position.set(0, 0, 0)
  }

  /** 設定鏡頭距離範圍與室內邊界（切換場景時呼叫）。 */
  setCameraLimits(limits: { distance: number; min: number; max: number }, bounds: CameraBounds | null): void {
    this.minDistance = limits.min
    this.maxDistance = limits.max
    this.distance = limits.distance
    this.cameraBounds = bounds
  }

  /** 套用畫質；antialias 需重建 context，於下次載入生效。 */
  setQuality(preset: QualityPreset): void {
    this.preset = preset
    this.resize()
  }

  /** 依畫質限制像素比例與總像素數。 */
  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth)
    const h = Math.max(1, this.canvas.clientHeight)
    let ratio = Math.min(window.devicePixelRatio || 1, this.preset.maxPixelRatio)
    const pixels = w * h * ratio * ratio
    if (pixels > this.preset.maxPixels) ratio *= Math.sqrt(this.preset.maxPixels / pixels)
    this.width = w
    this.height = h
    this.renderer.setPixelRatio(ratio)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    // 直式手機畫面加大視角，避免左右太窄。
    this.camera.fov = w < h ? 62 : 50
    this.camera.updateProjectionMatrix()
    this.onResize?.()
  }

  onResize: (() => void) | null = null

  get viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /**
   * 鏡頭跟隨目標。回傳鏡頭是否仍在移動（需要繼續重繪）。
   * snap=true 時直接到位（初次進場、恢復前景）。
   */
  follow(x: number, z: number, dt: number, snap = false, focusY = 1.1): boolean {
    // 注視高度平滑變化，避免跨過門檻時鏡頭突然抬頭
    this.focusY = snap ? focusY : this.focusY + (focusY - this.focusY) * (1 - Math.exp(-dt * 3))
    this.focus.set(x, this.focusY, z)
    const horiz = Math.cos(this.pitch) * this.distance
    this.desired.set(
      x + Math.sin(this.yaw) * horiz,
      this.focusY + Math.sin(this.pitch) * this.distance,
      z + Math.cos(this.yaw) * horiz,
    )
    this.clampToBounds()
    const cam = this.camera.position
    if (snap) {
      cam.copy(this.desired)
    } else {
      cam.lerp(this.desired, 1 - Math.exp(-dt * 6))
    }
    this.camera.lookAt(this.focus)
    return cam.distanceToSquared(this.desired) > 1e-4 || Math.abs(this.focusY - focusY) > 0.005
  }

  /** 理想鏡頭位置超出室內範圍時，沿焦點到鏡頭的直線拉回到範圍內。 */
  private clampToBounds(): void {
    if (!this.cameraBounds) return
    const c = clampCamera(this.focus, this.desired, this.cameraBounds)
    this.desired.set(c.x, c.y, c.z)
  }

  zoom(delta: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance + delta, this.minDistance, this.maxDistance)
  }

  rotate(dYaw: number, dPitch: number): void {
    this.yaw += dYaw
    this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, 0.25, 1.2)
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  get stats(): { calls: number; triangles: number } {
    const r = this.renderer.info.render
    return { calls: r.calls, triangles: r.triangles }
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.resizeObserver.disconnect()
    this.skyEnv?.dispose()
    this.sky.geometry.dispose()
    this.sky.material.dispose()
    this.renderer.dispose()
  }

  private onLost = (e: Event): void => {
    // preventDefault 才會讓瀏覽器嘗試恢復 context。
    e.preventDefault()
    this.callbacks.onContextLost()
  }

  private onRestored = (): void => {
    if (this.skyEnv) {
      this.bakeSkyEnvironment()
      this.setEnvironment(this.env)
    }
    this.callbacks.onContextRestored()
  }
}
