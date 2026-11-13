import * as THREE from 'three'
import { ResourceTracker } from './ResourceTracker'

/** 角色節點結構，動畫片段只操作這些節點。節點本身不含網格，只提供變換。 */
export interface AvatarRig {
  /** 位置與面向。 */
  root: THREE.Group
  /** 腰部樞紐：鞠躬、呼吸等動作旋轉這裡。 */
  pivot: THREE.Group
  head: THREE.Group
  /** 表情（FACE_* 常數）。AnimationSystem 每幀重設為平常的臉，動作片段可以改。 */
  face: number
}

/** 平常的臉：豆豆眼。 */
export const FACE_CALM = 0
/** 瞇瞇笑眼：合十時。 */
export const FACE_SMILE = 1

export interface Avatar extends AvatarRig {
  setLabelVisible(visible: boolean): void
  /** 釋放此角色獨有的資源（名牌貼圖）並移出批次繪製。 */
  dispose(): void
}

interface AvatarRecord {
  rig: AvatarRig
  shadow: THREE.Object3D
  color: THREE.Color
}

/** 臉圖集的格數（橫向排列）。 */
const FACE_COUNT = 2
/** 臉在模型上的範圍（公尺，模型面向 +z）：以 x、y 平面投影成貼圖座標。 */
const FACE_RECT = { x: 0.19, yMin: 0.64, yMax: 1.02, zMin: 0.05 }

/** 畫出臉圖集：每格一種表情（順序同 FACE_* 常數），透明底，只有五官與腮紅。 */
function makeFaceAtlas(): THREE.CanvasTexture {
  const S = 256
  const c = document.createElement('canvas')
  c.width = S * FACE_COUNT
  c.height = S
  const g = c.getContext('2d')!
  const INK = '#3a2a22'
  g.lineCap = 'round'
  const blush = (ox: number, x: number, y: number, rx: number, ry: number, a: number) => {
    const grad = g.createRadialGradient(ox + x, y, 0, ox + x, y, rx)
    grad.addColorStop(0, `rgba(235,120,110,${a})`)
    grad.addColorStop(1, 'rgba(235,120,110,0)')
    g.save()
    g.translate(0, y * (1 - ry / rx))
    g.scale(1, ry / rx)
    g.fillStyle = grad
    g.fillRect(ox + x - rx, y - rx, rx * 2, rx * 2)
    g.restore()
  }
  const EY = 150 // 眼睛高度（畫布座標，往下為正）；偏低顯得稚氣
  // 0：豆豆眼
  {
    const ox = 0
    for (const sx of [-1, 1]) {
      blush(ox, 128 + sx * 68, EY + 30, 30, 18, 0.55)
      g.fillStyle = INK
      g.beginPath()
      g.ellipse(ox + 128 + sx * 46, EY, 9, 11, 0, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = 'rgba(255,255,255,0.9)'
      g.beginPath()
      g.arc(ox + 128 + sx * 46 - 3, EY - 4, 2.6, 0, Math.PI * 2)
      g.fill()
    }
    g.strokeStyle = INK
    g.lineWidth = 4
    g.beginPath()
    g.arc(ox + 128, EY + 22, 10, Math.PI * 0.15, Math.PI * 0.85)
    g.stroke()
  }
  // 1：瞇瞇笑眼
  {
    const ox = S
    g.strokeStyle = INK
    for (const sx of [-1, 1]) {
      blush(ox, 128 + sx * 66, EY + 26, 32, 20, 0.6)
      g.lineWidth = 5.5
      g.beginPath()
      g.arc(ox + 128 + sx * 46, EY + 8, 17, Math.PI * 1.15, Math.PI * 1.85)
      g.stroke()
    }
    // ω 嘴
    g.lineWidth = 4
    g.beginPath()
    g.arc(ox + 128 - 8, EY + 26, 8, 0, Math.PI)
    g.stroke()
    g.beginPath()
    g.arc(ox + 128 + 8, EY + 26, 8, 0, Math.PI)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** 從膚色網格取出臉部正面的三角形，貼圖座標由 x、y 平面投影而來；臉因此貼合頭的實際曲面。 */
function makeFaceGeometry(skin: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = skin.getAttribute('position')
  const nor = skin.getAttribute('normal')
  const index = skin.getIndex()!
  const R = FACE_RECT
  const inside = (i: number) =>
    Math.abs(pos.getX(i)) <= R.x && pos.getY(i) >= R.yMin && pos.getY(i) <= R.yMax && pos.getZ(i) >= R.zMin
  const p: number[] = []
  const n: number[] = []
  const uv: number[] = []
  for (let t = 0; t < index.count; t += 3) {
    const tri = [index.getX(t), index.getX(t + 1), index.getX(t + 2)]
    if (!tri.every(inside)) continue
    for (const i of tri) {
      p.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      n.push(nor.getX(i), nor.getY(i), nor.getZ(i))
      uv.push((pos.getX(i) + R.x) / (R.x * 2), (pos.getY(i) - R.yMin) / (R.yMax - R.yMin))
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return geo
}

const ROBE_COLORS = ['#a35d3a', '#6b7a8f', '#8a7a5a', '#5d6e5a', '#7a5a6e', '#b08a4a', '#4f5d6e', '#9a6a5a']
const LOCAL_ROBE = '#c9853a'
const ORIGIN = new THREE.Vector3()
export const PIVOT_HEIGHT = 0.55
/** 小沙彌模型的身高（公尺），與 scripts/build-avatar.mjs 的 HEIGHT 一致。 */
const FIGURE_HEIGHT = 1.15
/**
 * 肩膀（袍頂、頭底）的高度（公尺），取自 scripts/build-avatar.mjs 的 ROBE_PROFILE 與 HEAD。
 * 頭與手以剛體跟著這個高度上下移動，不做縮放，避免蹲坐時頭被壓扁、臉變形。
 */
const SHOULDER_HEIGHT = 0.66
/** 同時繪製的角色上限（含自己）。需大於最高畫質的可見人數。 */
export const AVATAR_CAPACITY = 160

/** 字串雜湊成顏色索引，同一玩家在所有客戶端顏色一致。 */
export function colorIndexFor(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h) % ROBE_COLORS.length
}

function makeLabelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  const font = '500 28px system-ui, "Noto Sans TC", sans-serif'
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 24
  c.width = w
  c.height = 44
  ctx.font = font
  ctx.fillStyle = 'rgba(20,22,28,0.55)'
  ctx.beginPath()
  ctx.roundRect(0, 0, w, 44, 22)
  ctx.fill()
  ctx.fillStyle = '#f4efe6'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, 23)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * 角色工廠與批次繪製擁有者。
 * 所有角色以 InstancedMesh 批次繪製：身體（袍與鞋）與膚色部分（頭與手）各分近、遠兩批，加上影子，不論人數多少都是 5 個 draw call（名牌另計，最多 12 個）。
 * 近處用完整模型並投射即時陰影；遠處用低面數模型（monk-lod.glb）且不投影，只留腳下的假影子。
 * 模型是 Q 版小沙彌公仔（public/models/monk.glb，由 scripts/build-avatar.mjs 以程式產生），沒有骨架：
 * 動畫作用在無網格的 rig 節點上，sync() 把 pivot 的旋轉套在腳底、pivot 的升降轉成身體的壓扁與拉長；頭、手與臉不縮放，只隨肩膀升降。
 * 模型載入前（或載入失敗時）以簡單的圓柱與球代替。
 */
export class AvatarFactory {
  private tracker = new ResourceTracker()
  /** [近, 遠]，各含身體與膚色兩個批次。 */
  private tiers: Array<{ body: THREE.InstancedMesh; skin: THREE.InstancedMesh; count: number }>
  private shadows: THREE.InstancedMesh
  /** 臉：只畫在近處的完整模型上，一個 draw call；每個角色用哪一格由 faceIndex 決定。 */
  private faces: THREE.InstancedMesh
  private faceIndex = new THREE.InstancedBufferAttribute(new Float32Array(AVATAR_CAPACITY), 1)
  private records = new Set<AvatarRecord>()
  private robeColors = ROBE_COLORS.map((c) => new THREE.Color(c))
  private localColor = new THREE.Color(LOCAL_ROBE)
  private pose = new THREE.Matrix4()
  private poseScale = new THREE.Vector3()
  /** 頭、手與臉的剛體姿勢（不縮放），與 shoulderOffset 都是重用的暫存物件。 */
  private rigidPose = new THREE.Matrix4()
  private shoulderOffset = new THREE.Vector3()
  private static readonly UNIT_SCALE = new THREE.Vector3(1, 1, 1)

  constructor(parent: THREE.Object3D) {
    const t = this.tracker
    const robeGeo = t.track(new THREE.CylinderGeometry(0.2, 0.36, 1.05, 8))
    robeGeo.translate(0, 0.525, 0)
    const headGeo = t.track(new THREE.IcosahedronGeometry(0.17, 1))
    headGeo.translate(0, 1.2, 0)
    const shadowGeo = t.track(new THREE.CircleGeometry(0.45, 16))
    shadowGeo.rotateX(-Math.PI / 2)

    // 袍色由 instanceColor 決定，材質本身用白色；模型的頂點色把鞋子壓暗。
    const robeMat = t.trackMaterial(new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.85 }))
    const skinMat = t.trackMaterial(new THREE.MeshStandardMaterial({ color: '#d2a07c', roughness: 0.7 }))

    const c = document.createElement('canvas')
    c.width = c.height = 64
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(0,0,0,0.35)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
    const shadowMat = t.trackMaterial(
      new THREE.MeshBasicMaterial({ map: t.track(new THREE.CanvasTexture(c)), transparent: true, depthWrite: false }),
    )

    const make = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geo, mat, AVATAR_CAPACITY)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      // 角色分散在整個場地，包圍球每幀都在變；交給 GPU 裁切比每幀重算便宜。
      mesh.frustumCulled = false
      parent.add(mesh)
      return mesh
    }
    this.tiers = [true, false].map((near) => {
      const body = make(robeGeo, robeMat)
      body.setColorAt(0, this.localColor) // 建立 instanceColor 緩衝區
      const skin = make(headGeo, skinMat)
      body.castShadow = skin.castShadow = near
      return { body, skin, count: 0 }
    })
    this.shadows = make(shadowGeo, shadowMat)
    this.shadows.renderOrder = -1

    const faceMat = t.trackMaterial(
      new THREE.MeshStandardMaterial({
        map: t.track(makeFaceAtlas()),
        transparent: true,
        depthWrite: false,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    )
    faceMat.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float faceIndex;\n' +
        shader.vertexShader.replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>\n vMapUv.x = (vMapUv.x + faceIndex) / ${FACE_COUNT}.0;`,
        )
    }
    this.faceIndex.setUsage(THREE.DynamicDrawUsage)
    this.faces = make(t.track(new THREE.BufferGeometry()), faceMat)

    // 動態載入 GLTFLoader（與 statues.ts 共用同一個延後載入的區塊）
    void import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
      ;['monk.glb', 'monk-lod.glb'].forEach((file, i) =>
        new GLTFLoader().load(`${import.meta.env.BASE_URL}models/${file}`, (gltf) => {
          const geometryOf = (name: string) => (gltf.scene.getObjectByName(name) as THREE.Mesh | undefined)?.geometry
          const body = geometryOf('body')
          const skin = geometryOf('skin')
          if (!body || !skin) return
          this.tiers[i]!.body.geometry = t.track(body)
          this.tiers[i]!.skin.geometry = t.track(skin)
          if (i === 0) {
            const face = t.track(makeFaceGeometry(skin))
            face.setAttribute('faceIndex', this.faceIndex)
            this.faces.geometry = face
          }
        }),
      )
    })
  }

  create(opts: { name: string; colorIndex: number; local: boolean }): Avatar {
    const root = new THREE.Group()
    const pivot = new THREE.Group()
    pivot.position.y = PIVOT_HEIGHT
    root.add(pivot)
    const head = new THREE.Group()
    head.position.y = 1.05 - PIVOT_HEIGHT + 0.15
    pivot.add(head)
    const shadow = new THREE.Object3D()
    shadow.position.y = 0.06
    root.add(shadow)

    let label: THREE.Sprite | null = null
    let labelTex: THREE.Texture | null = null
    let labelMat: THREE.SpriteMaterial | null = null
    if (opts.name) {
      labelTex = makeLabelTexture(opts.name)
      labelMat = new THREE.SpriteMaterial({ map: labelTex, depthWrite: false, transparent: true })
      label = new THREE.Sprite(labelMat)
      const img = labelTex.image as HTMLCanvasElement
      label.scale.set((img.width / img.height) * 0.28, 0.28, 1)
      label.position.y = FIGURE_HEIGHT + 0.3
      root.add(label)
    }

    const rig: AvatarRig = { root, pivot, head, face: FACE_CALM }
    const record: AvatarRecord = {
      rig,
      shadow,
      color: opts.local ? this.localColor : this.robeColors[opts.colorIndex % this.robeColors.length]!,
    }
    this.records.add(record)

    return Object.assign(rig, {
      setLabelVisible(visible: boolean) {
        if (label) label.visible = visible
      },
      dispose: () => {
        this.records.delete(record)
        root.removeFromParent()
        labelTex?.dispose()
        labelMat?.dispose()
      },
    })
  }

  /**
   * 把可見角色的姿勢寫進批次繪製。每次繪製前呼叫一次。
   * 距離 (x, z) 在 nearRadius 內的角色用完整模型並投影，其餘用低面數模型。
   */
  sync(x: number, z: number, nearRadius: number): void {
    let i = 0
    for (const tier of this.tiers) tier.count = 0
    for (const r of this.records) {
      const { root, pivot } = r.rig
      if (!root.visible || i >= AVATAR_CAPACITY) continue
      root.updateMatrixWorld(true)
      // 公仔式動畫：整尊繞腳底傾斜；pivot 下降（蹲坐）時壓扁、上升（走路彈跳、呼吸）時拉長，體積大致不變。
      const stretch = 1 + (pivot.position.y - PIVOT_HEIGHT) / FIGURE_HEIGHT
      const side = 1 / Math.sqrt(stretch)
      this.pose.compose(ORIGIN, pivot.quaternion, this.poseScale.set(side, stretch, side)).premultiply(root.matrixWorld)
      const tier = this.tiers[(root.position.x - x) ** 2 + (root.position.z - z) ** 2 <= nearRadius * nearRadius ? 0 : 1]!
      tier.body.setMatrixAt(tier.count, this.pose)
      tier.body.setColorAt(tier.count, r.color)
      // 頭、耳朵、手與臉：同樣的傾斜，但不縮放，只跟著肩膀的高度升降（手比袖口多降約 3 公分，可接受）。
      this.rigidPose
        .compose(this.shoulderOffset.set(0, SHOULDER_HEIGHT * (stretch - 1), 0).applyQuaternion(pivot.quaternion), pivot.quaternion, AvatarFactory.UNIT_SCALE)
        .premultiply(root.matrixWorld)
      tier.skin.setMatrixAt(tier.count, this.rigidPose)
      if (tier === this.tiers[0]) {
        this.faces.setMatrixAt(tier.count, this.rigidPose)
        this.faceIndex.setX(tier.count, r.rig.face)
      }
      tier.count++
      this.shadows.setMatrixAt(i, r.shadow.matrixWorld)
      i++
    }
    for (const tier of this.tiers) {
      for (const m of [tier.body, tier.skin]) {
        m.count = tier.count
        m.instanceMatrix.needsUpdate = true
      }
      tier.body.instanceColor!.needsUpdate = true
    }
    this.shadows.count = i
    this.shadows.instanceMatrix.needsUpdate = true
    // 模型還沒載入時沒有臉的幾何（替代用的圓柱與球不畫臉）
    this.faces.count = this.faces.geometry.getAttribute('position') ? this.tiers[0]!.count : 0
    this.faces.instanceMatrix.needsUpdate = true
    this.faceIndex.needsUpdate = true
  }

  dispose(): void {
    for (const m of [...this.tiers.flatMap((tier) => [tier.body, tier.skin]), this.shadows, this.faces]) {
      m.removeFromParent()
      m.dispose()
    }
    this.records.clear()
    this.tracker.dispose()
  }
}
