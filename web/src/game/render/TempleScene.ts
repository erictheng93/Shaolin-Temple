import * as THREE from 'three'
import { BELL_PAVILION, CENSER, HALL, LANTERNS, TREES } from '../world/layout'
import type { ResourceTracker } from './ResourceTracker'

export const SKY_COLOR = '#cdd4d8'
export const TEMPLE_NAME = '少林寺'

const PALETTE = {
  grass: '#74805f',
  gravel: '#cdc5b3',
  path: '#b3ab9c',
  stone: '#9a958b',
  stoneDark: '#7d786f',
  wood: '#8c3a2c',
  woodDark: '#4a3426',
  roof: '#3b3f47',
  gold: '#c9a24f',
  bronze: '#6f6237',
  trunk: '#5a4434',
  leafA: '#4d6a45',
  leafB: '#5f7b4d',
  mountainA: '#7d8a96',
  mountainB: '#8f9ba5',
  lantern: '#ffcf80',
}

/** 底面為 1×1、高 1 的四角錐（底面中心在 y=0），縮放後作為歇山頂近似。 */
function pyramidGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1)
  g.rotateY(Math.PI / 4)
  g.translate(0, 0.5, 0)
  return g
}

function softCircleTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, inner)
  grad.addColorStop(1, outer)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function plaqueTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 172
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#2b2620'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.strokeStyle = '#c9a24f'
  ctx.lineWidth = 8
  ctx.strokeRect(14, 14, c.width - 28, c.height - 28)
  ctx.fillStyle = '#d9b45e'
  ctx.font = '600 112px "Noto Serif TC", "Songti TC", "PMingLiU", serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // 平均分配字距，讓殿名撐滿匾額
  const chars = [...text]
  const step = (c.width - 160) / chars.length
  chars.forEach((ch, i) => ctx.fillText(ch, 80 + step * (i + 0.5), c.height / 2 + 6))
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

export interface TempleScene {
  root: THREE.Group
  /** 可點擊行走的地面，供射線檢測使用。 */
  walkSurface: THREE.Object3D
  /** 環境動畫（燈籠、香煙、鐘擺）。t 為秒。 */
  update(t: number, dt: number): void
  /** 觸發鐘的擺動。 */
  swingBell(): void
  /** 是否有需要持續重繪的短暫動態（例如鐘擺尚未停止）。 */
  hasTransientMotion(): boolean
}

export function buildTempleScene(tracker: ResourceTracker): TempleScene {
  const root = new THREE.Group()
  root.name = 'temple'

  const mat = (color: string, extra: THREE.MeshLambertMaterialParameters = {}) =>
    tracker.trackMaterial(new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra }))
  const geo = <T extends THREE.BufferGeometry>(g: T) => tracker.track(g)

  const m = {
    grass: mat(PALETTE.grass),
    gravel: mat(PALETTE.gravel),
    path: mat(PALETTE.path),
    stone: mat(PALETTE.stone),
    stoneDark: mat(PALETTE.stoneDark),
    wood: mat(PALETTE.wood),
    woodDark: mat(PALETTE.woodDark),
    roof: mat(PALETTE.roof),
    gold: mat(PALETTE.gold),
    bronze: mat(PALETTE.bronze),
    trunk: mat(PALETTE.trunk),
    leaf: mat('#ffffff'),
    mountain: mat('#ffffff'),
    lantern: mat('#fff3d8', { emissive: PALETTE.lantern, emissiveIntensity: 0.9 }),
  }

  const box = geo(new THREE.BoxGeometry(1, 1, 1))
  const pyramid = geo(pyramidGeometry())
  const cylinder = geo(new THREE.CylinderGeometry(0.5, 0.5, 1, 10))

  const add = (g: THREE.BufferGeometry, material: THREE.Material, pos: [number, number, number], scale: [number, number, number]) => {
    const mesh = new THREE.Mesh(g, material)
    mesh.position.set(...pos)
    mesh.scale.set(...scale)
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    root.add(mesh)
    return mesh
  }

  const tmp = new THREE.Object3D()
  const instanced = (
    g: THREE.BufferGeometry,
    material: THREE.Material,
    items: ReadonlyArray<{ pos: [number, number, number]; scale: [number, number, number]; rotY?: number; color?: string }>,
  ) => {
    const mesh = new THREE.InstancedMesh(g, material, items.length)
    items.forEach((it, i) => {
      tmp.position.set(...it.pos)
      tmp.scale.set(...it.scale)
      tmp.rotation.set(0, it.rotY ?? 0, 0)
      tmp.updateMatrix()
      mesh.setMatrixAt(i, tmp.matrix)
      if (it.color) mesh.setColorAt(i, new THREE.Color(it.color))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.matrixAutoUpdate = false
    root.add(mesh)
    return mesh
  }

  // 地面
  const groundGeo = geo(new THREE.PlaneGeometry(140, 140))
  groundGeo.rotateX(-Math.PI / 2)
  const ground = new THREE.Mesh(groundGeo, m.grass)
  ground.name = 'ground'
  root.add(ground)
  add(box, m.gravel, [0, 0.02, -3.5], [30, 0.04, 31])
  add(box, m.path, [0, 0.03, 16], [3.2, 0.04, 9])
  add(box, m.path, [0, 0.035, -4], [3.2, 0.04, 4.6])

  // 主殿：台基、階梯、殿身、柱、樑、屋頂
  const hallCx = (HALL.minX + HALL.maxX) / 2
  const hallCz = -13 // 台基 z 範圍 -18..-8
  const base = 0.8
  add(box, m.stone, [hallCx, base / 2, hallCz], [15, base, 10])
  ;[0.6, 0.4, 0.2].forEach((h, i) => add(box, m.stoneDark, [0, h / 2, -7.7 + i * 0.6], [6, h, 0.6]))
  add(box, m.wood, [hallCx, base + 1.5, hallCz], [11.4, 3, 7.4])
  add(box, m.woodDark, [0, base + 1.2, hallCz + 3.72], [3.2, 2.4, 0.06])
  // 匾額：深色木框加上寫有殿名的貼圖
  // 前排柱子在 x=±1.4（半徑 0.21），匾額寬度需小於 2.38 才不被遮住。
  add(box, m.woodDark, [0, base + 2.72, hallCz + 3.74], [2.36, 0.5, 0.06])
  const plaqueMat = tracker.trackMaterial(new THREE.MeshLambertMaterial({ map: tracker.track(plaqueTexture(TEMPLE_NAME)) }))
  const plaque = new THREE.Mesh(geo(new THREE.PlaneGeometry(2.24, 0.38)), plaqueMat)
  plaque.position.set(0, base + 2.72, hallCz + 3.78)
  root.add(plaque)

  const pillarH = 3.2
  const pillars: Array<{ pos: [number, number, number]; scale: [number, number, number] }> = []
  for (const x of [-6.6, -4, -1.4, 1.4, 4, 6.6]) {
    pillars.push({ pos: [x, base + pillarH / 2, -8.6], scale: [0.42, pillarH, 0.42] })
    pillars.push({ pos: [x, base + pillarH / 2, -17.4], scale: [0.42, pillarH, 0.42] })
  }
  for (const z of [-11.5, -14.5]) {
    pillars.push({ pos: [-6.6, base + pillarH / 2, z], scale: [0.42, pillarH, 0.42] })
    pillars.push({ pos: [6.6, base + pillarH / 2, z], scale: [0.42, pillarH, 0.42] })
  }
  // 鐘亭柱
  const bx = (BELL_PAVILION.minX + BELL_PAVILION.maxX) / 2
  const bz = (BELL_PAVILION.minZ + BELL_PAVILION.maxZ) / 2
  const pavBase = 0.35
  const pavH = 2.6
  for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]] as const) {
    pillars.push({ pos: [bx + dx, pavBase + pavH / 2, bz + dz], scale: [0.3, pavH, 0.3] })
  }
  instanced(cylinder, m.wood, pillars)

  const beamY = base + pillarH
  add(box, m.woodDark, [hallCx, beamY + 0.2, hallCz], [14, 0.4, 9.6])
  add(pyramid, m.roof, [hallCx, beamY + 0.4, hallCz], [17.5, 2.4, 12.4])
  add(box, m.woodDark, [hallCx, beamY + 2.3, hallCz], [7.5, 1.1, 3.6])
  add(pyramid, m.roof, [hallCx, beamY + 2.8, hallCz], [9.5, 1.8, 5.8])
  add(box, m.roof, [hallCx, beamY + 4.65, hallCz], [5.2, 0.18, 0.3])
  const finialGeo = geo(new THREE.OctahedronGeometry(0.28))
  add(finialGeo, m.gold, [hallCx - 2.7, beamY + 4.85, hallCz], [1, 1.6, 1])
  add(finialGeo, m.gold, [hallCx + 2.7, beamY + 4.85, hallCz], [1, 1.6, 1])

  // 鐘亭
  add(box, m.stone, [bx, pavBase / 2, bz], [4.3, pavBase, 4.3])
  add(box, m.woodDark, [bx, pavBase + pavH + 0.12, bz], [3.8, 0.24, 3.8])
  add(pyramid, m.roof, [bx, pavBase + pavH + 0.24, bz], [5.4, 1.7, 5.4])
  add(finialGeo, m.gold, [bx, pavBase + pavH + 2.0, bz], [0.8, 1.2, 0.8])
  const bellPivot = new THREE.Group()
  bellPivot.position.set(bx, pavBase + pavH, bz)
  root.add(bellPivot)
  const bellProfile = [
    [0, -1.25], [0.62, -1.25], [0.58, -1.05], [0.48, -0.6], [0.44, -0.2], [0.4, -0.05], [0, 0],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  const bell = new THREE.Mesh(geo(new THREE.LatheGeometry(bellProfile, 12)), m.bronze)
  bell.position.y = -0.15
  bellPivot.add(bell)

  // 香爐與香
  add(box, m.stoneDark, [CENSER.x, 0.15, CENSER.z], [1.7, 0.3, 1.7])
  const censerProfile = [
    [0, 0], [0.35, 0], [0.3, 0.25], [0.7, 0.45], [0.78, 0.85], [0.72, 0.9], [0.6, 0.62], [0, 0.6],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  const censerMesh = new THREE.Mesh(geo(new THREE.LatheGeometry(censerProfile, 14)), m.bronze)
  censerMesh.position.set(CENSER.x, 0.3, CENSER.z)
  root.add(censerMesh)
  instanced(
    cylinder,
    m.wood,
    [-0.12, 0, 0.12].map((dx, i) => ({
      pos: [CENSER.x + dx, 1.45, CENSER.z + (i - 1) * 0.04] as [number, number, number],
      scale: [0.03, 0.9, 0.03] as [number, number, number],
    })),
  )

  const smokeTex = tracker.track(softCircleTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)'))
  const smoke: Array<{ sprite: THREE.Sprite; material: THREE.SpriteMaterial; phase: number }> = []
  for (let i = 0; i < 5; i++) {
    const material = tracker.track(
      new THREE.SpriteMaterial({ map: smokeTex, color: '#eef0f2', transparent: true, depthWrite: false, opacity: 0 }),
    )
    const sprite = new THREE.Sprite(material)
    root.add(sprite)
    smoke.push({ sprite, material, phase: i / 5 })
  }

  // 石燈籠
  const lanternItems = (y: number, s: [number, number, number]) =>
    LANTERNS.map((l) => ({ pos: [l.x, y, l.z] as [number, number, number], scale: s }))
  instanced(box, m.stoneDark, lanternItems(0.15, [0.7, 0.3, 0.7]))
  instanced(box, m.stone, lanternItems(0.7, [0.25, 0.8, 0.25]))
  instanced(box, m.lantern, lanternItems(1.3, [0.45, 0.4, 0.45]))
  instanced(pyramid, m.stoneDark, lanternItems(1.5, [0.9, 0.45, 0.9]))

  // 樹
  instanced(
    cylinder,
    m.trunk,
    TREES.map((t) => ({ pos: [t.x, 1.1 * t.scale, t.z] as [number, number, number], scale: [0.35 * t.scale, 2.2 * t.scale, 0.35 * t.scale] as [number, number, number] })),
  )
  const canopy = geo(new THREE.IcosahedronGeometry(1, 0))
  instanced(
    canopy,
    m.leaf,
    TREES.flatMap((t, i) => [
      { pos: [t.x, 3 * t.scale, t.z] as [number, number, number], scale: [1.9 * t.scale, 1.6 * t.scale, 1.9 * t.scale] as [number, number, number], rotY: i, color: PALETTE.leafA },
      { pos: [t.x + 0.3, 4.1 * t.scale, t.z - 0.2] as [number, number, number], scale: [1.3 * t.scale, 1.2 * t.scale, 1.3 * t.scale] as [number, number, number], rotY: i * 2, color: PALETTE.leafB },
    ]),
  )

  // 遠山（融入霧中）
  const mountainGeo = geo(new THREE.ConeGeometry(1, 1, 7, 1))
  instanced(
    mountainGeo,
    m.mountain,
    [
      { x: -55, z: -70, r: 30, h: 28 },
      { x: -10, z: -85, r: 40, h: 38 },
      { x: 40, z: -72, r: 32, h: 30 },
      { x: 75, z: -40, r: 26, h: 22 },
      { x: -80, z: -30, r: 28, h: 24 },
    ].map((mt, i) => ({
      pos: [mt.x, mt.h / 2, mt.z] as [number, number, number],
      scale: [mt.r, mt.h, mt.r] as [number, number, number],
      rotY: i,
      color: i % 2 ? PALETTE.mountainA : PALETTE.mountainB,
    })),
  )

  // 鐘擺：阻尼簡諧運動
  let bellAngle = 0
  let bellVel = 0

  return {
    root,
    walkSurface: ground,
    update(t, dt) {
      m.lantern.emissiveIntensity = 0.85 + Math.sin(t * 7.3) * 0.05 + Math.sin(t * 3.1) * 0.05
      for (const s of smoke) {
        const p = (t * 0.12 + s.phase) % 1
        s.sprite.position.set(CENSER.x + Math.sin(t * 0.6 + s.phase * 6) * 0.25 * p, 1.9 + p * 2.6, CENSER.z)
        const size = 0.35 + p * 1.1
        s.sprite.scale.set(size, size, 1)
        s.material.opacity = Math.sin(p * Math.PI) * 0.35
      }
      if (bellAngle !== 0 || bellVel !== 0) {
        const k = 18
        const damping = 1.6
        bellVel += (-k * bellAngle - damping * bellVel) * dt
        bellAngle += bellVel * dt
        if (Math.abs(bellAngle) < 0.0005 && Math.abs(bellVel) < 0.002) bellAngle = bellVel = 0
        bellPivot.rotation.x = bellAngle
      }
    },
    swingBell() {
      bellVel += 1.2
    },
    hasTransientMotion() {
      return bellAngle !== 0 || bellVel !== 0
    },
  }
}
