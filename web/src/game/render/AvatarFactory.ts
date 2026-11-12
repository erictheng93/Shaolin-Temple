import * as THREE from 'three'
import { ResourceTracker } from './ResourceTracker'

/** 角色節點結構，動畫片段只操作這些節點。節點本身不含網格，只提供變換。 */
export interface AvatarRig {
  /** 位置與面向。 */
  root: THREE.Group
  /** 腰部樞紐：鞠躬、呼吸等動作旋轉這裡。 */
  pivot: THREE.Group
  head: THREE.Group
}

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

const ROBE_COLORS = ['#a35d3a', '#6b7a8f', '#8a7a5a', '#5d6e5a', '#7a5a6e', '#b08a4a', '#4f5d6e', '#9a6a5a']
const LOCAL_ROBE = '#c9853a'
export const PIVOT_HEIGHT = 0.55
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
 * 所有角色的袍、頭、影子各用一個 InstancedMesh 繪製：不論人數多少都是 3 個 draw call（名牌另計，最多 12 個）。
 * 動畫作用在無網格的 rig 節點上，sync() 每幀把節點的世界矩陣寫進批次。
 */
export class AvatarFactory {
  private tracker = new ResourceTracker()
  private robes: THREE.InstancedMesh
  private heads: THREE.InstancedMesh
  private shadows: THREE.InstancedMesh
  private records = new Set<AvatarRecord>()
  private robeColors = ROBE_COLORS.map((c) => new THREE.Color(c))
  private localColor = new THREE.Color(LOCAL_ROBE)

  constructor(parent: THREE.Object3D) {
    const t = this.tracker
    const robeGeo = t.track(new THREE.CylinderGeometry(0.2, 0.36, 1.05, 8))
    robeGeo.translate(0, 0.525 - PIVOT_HEIGHT, 0)
    const headGeo = t.track(new THREE.IcosahedronGeometry(0.17, 1))
    const shadowGeo = t.track(new THREE.CircleGeometry(0.45, 16))
    shadowGeo.rotateX(-Math.PI / 2)

    // 袍色由 instanceColor 決定，材質本身用白色。
    const robeMat = t.trackMaterial(new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }))
    const skinMat = t.trackMaterial(new THREE.MeshLambertMaterial({ color: '#e2c4a4', flatShading: true }))

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
    this.robes = make(robeGeo, robeMat)
    this.robes.setColorAt(0, this.localColor) // 建立 instanceColor 緩衝區
    this.heads = make(headGeo, skinMat)
    this.robes.castShadow = this.heads.castShadow = true
    this.shadows = make(shadowGeo, shadowMat)
    this.shadows.renderOrder = -1
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
      label.position.y = 1.65
      root.add(label)
    }

    const record: AvatarRecord = {
      rig: { root, pivot, head },
      shadow,
      color: opts.local ? this.localColor : this.robeColors[opts.colorIndex % this.robeColors.length]!,
    }
    this.records.add(record)

    return {
      root,
      pivot,
      head,
      setLabelVisible(visible) {
        if (label) label.visible = visible
      },
      dispose: () => {
        this.records.delete(record)
        root.removeFromParent()
        labelTex?.dispose()
        labelMat?.dispose()
      },
    }
  }

  /** 把可見角色的姿勢寫進批次繪製。每次繪製前呼叫一次。 */
  sync(): void {
    let i = 0
    for (const r of this.records) {
      const { root, pivot, head } = r.rig
      if (!root.visible || i >= AVATAR_CAPACITY) continue
      root.updateMatrixWorld(true)
      this.robes.setMatrixAt(i, pivot.matrixWorld)
      this.robes.setColorAt(i, r.color)
      this.heads.setMatrixAt(i, head.matrixWorld)
      this.shadows.setMatrixAt(i, r.shadow.matrixWorld)
      i++
    }
    for (const m of [this.robes, this.heads, this.shadows]) {
      m.count = i
      m.instanceMatrix.needsUpdate = true
    }
    this.robes.instanceColor!.needsUpdate = true
  }

  dispose(): void {
    for (const m of [this.robes, this.heads, this.shadows]) {
      m.removeFromParent()
      m.dispose()
    }
    this.records.clear()
    this.tracker.dispose()
  }
}
