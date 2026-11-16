import * as THREE from 'three'
import { MALLET_HEAD_Z, WOODFISH_FORWARD, WOODFISH_STRIKE_Y, createChantPropsGeometry, patchChantPropsMaterial } from './chantProps'
import { createIncenseStickGeometry } from './IncenseSystem'
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
  /** 手上拿的東西（PROP_* 常數）。與 face 相同，每幀重設為 PROP_NONE，動作片段可以改。 */
  prop: number
  /** 手上道具的抬起角度（弧度，0 為放下；誦經時是木魚槌抬離木魚的角度）。每幀重設為 0。 */
  propAngle: number
}

/** 平常的臉：豆豆眼。 */
export const FACE_CALM = 0
/** 瞇瞇笑眼：合十時。 */
export const FACE_SMILE = 1

/** 手上沒有東西。 */
export const PROP_NONE = 0
/** 合十的雙手間拿著一支香（上香時）。 */
export const PROP_INCENSE = 1
/** 誦經：身前地上一個木魚，合十的手握著木魚槌（槌頭指向木魚，依 propAngle 抬起）。 */
export const PROP_CHANT = 2
/** 握槌的位置：合十的手（剛體座標，與手上的香相同的高度）。 */
const MALLET_GRIP = new THREE.Vector3(0, 0.53, 0.21)
/** 槌頭敲到木魚時的位置（角色根節點座標）：木魚頂端加槌頭半徑。 */
const MALLET_TARGET = new THREE.Vector3(0, WOODFISH_STRIKE_Y, WOODFISH_FORWARD)
const WOODFISH_POSE = new THREE.Matrix4().makeTranslation(0, 0, WOODFISH_FORWARD)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)
/**
 * 手上的香相對腳底的姿勢（隨頭與手一起做剛體運動）：從合十的手（y 0.535、z 0.19）往上、
 * 向前傾 0.5 弧度，避免穿過臉（臉的正面在 z 約 0.235）；長 0.42、半徑 0.007。
 */
const HELD_INCENSE = new THREE.Matrix4().compose(
  new THREE.Vector3(0, 0.5, 0.2),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0)),
  new THREE.Vector3(0.007, 0.42, 0.007),
)

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

/**
 * 從膚色網格取出臉部正面的三角形，貼圖座標由 x、y 平面投影而來；臉因此貼合頭的實際曲面。
 * 近處與遠處的膚色幾何各呼叫一次。實測遠處（monk-lod.glb）取到 24 個三角形，UV 涵蓋 u 0.07～0.93、v 0.095～0.895，
 * 五官所在的中央 70% 範圍有 99% 被涵蓋，只缺四個角落，所以兩者用同一個「三個頂點都在範圍內」的條件即可。
 */
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
 * 所有角色以 InstancedMesh 批次繪製：身體（袍與鞋）、膚色部分（頭與手）與臉各分近、遠兩批，加上影子，不論人數多少都是 7 個 draw call（名牌另計，最多 12 個；有人手上拿著香時另加 1 個，有人誦經時木魚與槌另加 1 個）。
 * 臉（五官圖集）近遠都畫，各自貼在該 tier 的頭部曲面上，不投影。
 * 近處用完整模型並投射即時陰影；遠處用低面數模型（monk-lod.glb）且不投影，只留腳下的假影子。
 * 模型是 Q 版小沙彌公仔（public/models/monk.glb，由 scripts/build-avatar.mjs 以程式產生），沒有骨架：
 * 動畫作用在無網格的 rig 節點上，sync() 把 pivot 的旋轉套在腳底、pivot 的升降轉成身體的壓扁與拉長；頭、手與臉不縮放，只隨肩膀升降。
 * 模型載入前（或載入失敗時）以簡單的圓柱與球代替。
 */
export class AvatarFactory {
  private tracker = new ResourceTracker()
  /**
   * [近, 遠]，各含身體、膚色與臉三個批次。
   * 臉的幾何各自取自該 tier 的膚色幾何（曲面細緻度不同，不能共用）；faceIndex 決定每個角色用圖集的哪一格。
   */
  private tiers: Array<{
    body: THREE.InstancedMesh
    skin: THREE.InstancedMesh
    face: THREE.InstancedMesh
    faceIndex: THREE.InstancedBufferAttribute
    count: number
  }>
  private shadows: THREE.InstancedMesh
  /** 手上的香：有人拿著時才多 1 個 draw call。 */
  private props: THREE.InstancedMesh
  /** 誦經的木魚與槌：每人兩個實例（instPart 0 木魚、1 槌），有人誦經時才多 1 個 draw call。 */
  private chantProps: THREE.InstancedMesh
  private chantPart: THREE.InstancedBufferAttribute
  private grip = new THREE.Vector3()
  private malletDir = new THREE.Vector3()
  private malletAxis = new THREE.Vector3()
  private malletQuat = new THREE.Quaternion()
  private propPose = new THREE.Matrix4()
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
    // 臉的材質與圖集兩個 tier 共用
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
    this.tiers = [true, false].map((near) => {
      const body = make(robeGeo, robeMat)
      body.setColorAt(0, this.localColor) // 建立 instanceColor 緩衝區
      const skin = make(headGeo, skinMat)
      body.castShadow = skin.castShadow = near
      // 臉不投影（兩個 tier 都一樣）；幾何在模型載入後才有
      const face = make(t.track(new THREE.BufferGeometry()), faceMat)
      face.castShadow = false
      const faceIndex = new THREE.InstancedBufferAttribute(new Float32Array(AVATAR_CAPACITY), 1)
      faceIndex.setUsage(THREE.DynamicDrawUsage)
      return { body, skin, face, faceIndex, count: 0 }
    })
    this.shadows = make(shadowGeo, shadowMat)
    this.shadows.renderOrder = -1
    this.props = make(t.track(createIncenseStickGeometry()), t.trackMaterial(new THREE.MeshBasicMaterial({ vertexColors: true })))
    this.props.visible = false
    const chantMat = t.trackMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }))
    patchChantPropsMaterial(chantMat)
    const chantGeo = t.track(createChantPropsGeometry())
    this.chantPart = new THREE.InstancedBufferAttribute(new Float32Array(AVATAR_CAPACITY * 2), 1)
    this.chantPart.setUsage(THREE.DynamicDrawUsage)
    chantGeo.setAttribute('instPart', this.chantPart)
    this.chantProps = new THREE.InstancedMesh(chantGeo, chantMat, AVATAR_CAPACITY * 2)
    this.chantProps.name = 'chant-props'
    this.chantProps.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.chantProps.count = 0
    this.chantProps.frustumCulled = false
    // 自訂 vertex shader 只裝在一般材質上，陰影的深度材質不知道要縮掉另一部分，所以不投影（木魚很小，只差腳邊一點影子）
    this.chantProps.castShadow = false
    this.chantProps.visible = false
    parent.add(this.chantProps)

    // 動態載入 GLTFLoader（與 statues.ts 共用同一個延後載入的區塊）
    void import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
      ;['monk.glb', 'monk-lod.glb'].forEach((file, i) =>
        new GLTFLoader().load(`${import.meta.env.BASE_URL}models/${file}`, (gltf) => {
          const geometryOf = (name: string) => (gltf.scene.getObjectByName(name) as THREE.Mesh | undefined)?.geometry
          const body = geometryOf('body')
          const skin = geometryOf('skin')
          if (!body || !skin) return
          const tier = this.tiers[i]!
          tier.body.geometry = t.track(body)
          tier.skin.geometry = t.track(skin)
          // 臉取自該 tier 自己的膚色幾何，才會貼合各自的頭部曲面
          const face = t.track(makeFaceGeometry(skin))
          face.setAttribute('faceIndex', tier.faceIndex)
          tier.face.geometry = face
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

    const rig: AvatarRig = { root, pivot, head, face: FACE_CALM, prop: PROP_NONE, propAngle: 0 }
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
    let props = 0
    let chant = 0
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
      tier.face.setMatrixAt(tier.count, this.rigidPose)
      tier.faceIndex.setX(tier.count, r.rig.face)
      tier.count++
      if (r.rig.prop === PROP_INCENSE) this.props.setMatrixAt(props++, this.propPose.multiplyMatrices(this.rigidPose, HELD_INCENSE))
      if (r.rig.prop === PROP_CHANT) chant = this.placeChantProps(chant, root.matrixWorld, r.rig.propAngle)
      this.shadows.setMatrixAt(i, r.shadow.matrixWorld)
      i++
    }
    for (const tier of this.tiers) {
      for (const m of [tier.body, tier.skin]) {
        m.count = tier.count
        m.instanceMatrix.needsUpdate = true
      }
      tier.body.instanceColor!.needsUpdate = true
      // 模型還沒載入時沒有臉的幾何（替代用的圓柱與球不畫臉）
      tier.face.count = tier.face.geometry.getAttribute('position') ? tier.count : 0
      tier.face.instanceMatrix.needsUpdate = true
      tier.faceIndex.needsUpdate = true
    }
    this.shadows.count = i
    this.shadows.instanceMatrix.needsUpdate = true
    this.props.count = props
    this.props.visible = props > 0
    this.props.instanceMatrix.needsUpdate = true
    this.chantProps.count = chant
    this.chantProps.visible = chant > 0
    this.chantProps.instanceMatrix.needsUpdate = true
    this.chantPart.needsUpdate = true
  }

  /**
   * 木魚放在角色腳底前方的地上（不隨身體傾斜）；槌從合十的手（剛體姿勢，this.rigidPose）指向木魚頂端，
   * 再繞角色的左右軸抬起 angle。手到木魚的距離隨姿勢略有不同，槌沿長軸稍微伸縮（0.85～1.25 倍），放下時剛好碰到木魚。
   */
  private placeChantProps(i: number, root: THREE.Matrix4, angle: number): number {
    this.chantProps.setMatrixAt(i, this.propPose.multiplyMatrices(root, WOODFISH_POSE))
    this.chantPart.setX(i, 0)
    this.grip.copy(MALLET_GRIP).applyMatrix4(this.rigidPose)
    this.malletDir.copy(MALLET_TARGET).applyMatrix4(root).sub(this.grip)
    const reach = this.malletDir.length()
    this.malletDir.divideScalar(reach || 1)
    this.malletAxis.copy(AXIS_X).transformDirection(root)
    this.malletDir.applyAxisAngle(this.malletAxis, -angle)
    this.malletQuat.setFromUnitVectors(AXIS_Z, this.malletDir)
    const stretch = Math.min(1.25, Math.max(0.85, reach / MALLET_HEAD_Z))
    this.chantProps.setMatrixAt(i + 1, this.propPose.compose(this.grip, this.malletQuat, this.poseScale.set(1, 1, stretch)))
    this.chantPart.setX(i + 1, 1)
    return i + 2
  }

  dispose(): void {
    for (const m of [...this.tiers.flatMap((tier) => [tier.body, tier.skin, tier.face]), this.shadows, this.props, this.chantProps]) {
      m.removeFromParent()
      m.dispose()
    }
    this.records.clear()
    this.tracker.dispose()
  }
}
