import * as THREE from 'three'
import { CUSHION_RADIUS, HALL_AISLE_HALF_WIDTH, HALL_ALTAR, HALL_CENSERS, HALL_CUSHIONS, HALL_PILLARS, HALL_ROOM, HALL_STATUES, HALL_TABLE } from '../world/zones'
import type { QualityPreset } from '../core/settings'
import type { ResourceTracker } from './ResourceTracker'
import { DOORWAY_VIEW_VERSION } from './doorwayView'
import { HALL_DOOR, HALL_DOOR_TOP, buildHallDoorway } from './hallDoorway'
import { mergeStatic } from './mergeStatic'
import { HALL_ENV } from './SceneRenderer'
import { buildStatue, createStatueKit, createStatueLoaders, loadStatueModel, type StatueId } from './statues'

/**
 * 殿內場景（少林寺）：紅柱、藻井、彩繪樑、光明燈牆、宮燈、三座神龕與神像、供桌與三個香爐、蒲團陣列。
 * 神像的寫實模型在建立場景時才開始下載（第一次進殿），到齊前顯示程序化造型（見 statues.ts）。
 * 香爐裡的香與香煙是動態物件，由 GameCore 擁有的 IncenseSystem 繪製，不在這裡。
 * 殿門在 +z，神龕在 -z；玩家進殿後面向 -z。
 */

export interface HallScene {
  root: THREE.Group
  walkSurface: THREE.Object3D
  /** 三尊神像的插槽：先放程序化造型，寫實模型下載完成後替換。 */
  statueSlots: Record<StatueId, THREE.Group>
  /** 寫實模型與門外景貼圖全部載入（或失敗）後 resolve；失敗的那尊維持程序化造型。 */
  statuesReady: Promise<void>
  update(t: number, dt: number): void
  /** 停止尚未完成的下載（之後到的模型不再加入場景）。資源仍由 tracker 釋放。 */
  dispose(): void
}

const PALETTE = {
  floorA: '#8a7f70',
  floorB: '#7a6f61',
  wallLow: '#5c1c14',
  wallHigh: '#e2d4b4',
  ceiling: '#3a2a20',
  pillar: '#8e2a1f',
  gold: '#c9a043',
  beam: '#2f5e63',
  beamTrim: '#b3863a',
  stone: '#8d8678',
  altar: '#6b2119',
  cloth: '#a3231b',
  bronze: '#6f6237',
  candle: '#c62f25',
  cushion: '#b5832f',
  lantern: '#d23a26',
  lampCell: '#ffd98a',
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** 匾額貼圖：深底金字，字距平均分配。 */
function plaqueTexture(text: string, bg = '#2b1a14'): THREE.CanvasTexture {
  return canvasTexture(1024, 256, (ctx) => {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, 1024, 256)
    ctx.strokeStyle = '#c9a24f'
    ctx.lineWidth = 12
    ctx.strokeRect(18, 18, 988, 220)
    ctx.fillStyle = '#e0bd62'
    ctx.font = '600 150px "Noto Serif TC", "Songti TC", "PMingLiU", serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const chars = [...text]
    const step = 860 / chars.length
    chars.forEach((ch, i) => ctx.fillText(ch, 82 + step * (i + 0.5), 136))
  })
}

function glowTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,240,200,1)')
    g.addColorStop(0.35, 'rgba(255,190,90,0.7)')
    g.addColorStop(1, 'rgba(255,140,40,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  })
}

/**
 * @param onChange 神像換成寫實模型時呼叫（喚醒渲染迴圈）。
 */
export function buildHallScene(renderer: THREE.WebGLRenderer, tracker: ResourceTracker, preset: QualityPreset, onChange: () => void): HallScene {
  const root = new THREE.Group()
  root.name = 'hall'
  const R = HALL_ROOM
  const W = R.maxX - R.minX
  const D = R.maxZ - R.minZ
  const H = R.height

  const lambert = (color: string, extra: THREE.MeshLambertMaterialParameters = {}) =>
    tracker.trackMaterial(new THREE.MeshLambertMaterial({ color, ...extra }))
  const geo = <T extends THREE.BufferGeometry>(g: T) => tracker.track(g)
  const m = {
    wallLow: lambert(PALETTE.wallLow),
    wallHigh: lambert(PALETTE.wallHigh),
    ceiling: lambert(PALETTE.ceiling),
    pillar: lambert(PALETTE.pillar),
    gold: tracker.trackMaterial(new THREE.MeshPhongMaterial({ color: PALETTE.gold, shininess: 28, specular: '#7a6434' })),
    beam: lambert(PALETTE.beam),
    beamTrim: lambert(PALETTE.beamTrim),
    stone: lambert(PALETTE.stone),
    altar: tracker.trackMaterial(new THREE.MeshPhongMaterial({ color: PALETTE.altar, shininess: 40, specular: '#553' })),
    cloth: lambert(PALETTE.cloth),
    bronze: tracker.trackMaterial(new THREE.MeshPhongMaterial({ color: PALETTE.bronze, shininess: 50, specular: '#776' })),
    candle: lambert(PALETTE.candle),
    cushion: lambert(PALETTE.cushion),
    lantern: lambert(PALETTE.lantern, { emissive: '#ff5a2a', emissiveIntensity: 0.55 }),
    lampCell: lambert('#fff1cf', { emissive: PALETTE.lampCell, emissiveIntensity: 0.8 }),
    lampFrame: lambert('#3d1610'),
    fruit: lambert('#e08a2a'),
    flower: lambert('#e7c13d'),
    leaf: lambert('#4f7a43'),
  }
  const box = geo(new THREE.BoxGeometry(1, 1, 1))
  const cyl = geo(new THREE.CylinderGeometry(1, 1, 1, 16))
  const sphere = geo(new THREE.SphereGeometry(1, 14, 10))

  const add = (g: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number], scale: [number, number, number], rotY = 0) => {
    const mesh = new THREE.Mesh(g, mat)
    mesh.position.set(...pos)
    mesh.scale.set(...scale)
    mesh.rotation.y = rotY
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    root.add(mesh)
    return mesh
  }
  const tmp = new THREE.Object3D()
  const instanced = (g: THREE.BufferGeometry, mat: THREE.Material, items: ReadonlyArray<{ pos: [number, number, number]; scale: [number, number, number] }>) => {
    const mesh = new THREE.InstancedMesh(g, mat, items.length)
    items.forEach((it, i) => {
      tmp.position.set(...it.pos)
      tmp.scale.set(...it.scale)
      tmp.rotation.set(0, 0, 0)
      tmp.updateMatrix()
      mesh.setMatrixAt(i, tmp.matrix)
    })
    mesh.computeBoundingSphere()
    root.add(mesh)
    return mesh
  }

  // ---------- 地板：石磚 ----------
  const floorTex = tracker.track(
    canvasTexture(256, 256, (ctx) => {
      ctx.fillStyle = PALETTE.floorA
      ctx.fillRect(0, 0, 256, 256)
      ctx.fillStyle = PALETTE.floorB
      ctx.fillRect(0, 0, 128, 128)
      ctx.fillRect(128, 128, 128, 128)
      ctx.strokeStyle = 'rgba(40,30,20,0.5)'
      ctx.lineWidth = 3
      ctx.strokeRect(0, 0, 256, 256)
      ctx.beginPath()
      ctx.moveTo(128, 0)
      ctx.lineTo(128, 256)
      ctx.moveTo(0, 128)
      ctx.lineTo(256, 128)
      ctx.stroke()
    }),
  )
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping
  floorTex.repeat.set(W / 2, D / 2)
  const floorGeo = geo(new THREE.PlaneGeometry(W, D))
  floorGeo.rotateX(-Math.PI / 2)
  const floor = new THREE.Mesh(floorGeo, tracker.trackMaterial(new THREE.MeshLambertMaterial({ map: floorTex })))
  floor.name = 'hall-floor'
  root.add(floor)
  // 中央紅色走道毯
  add(box, m.cloth, [0, 0.01, 2.6], [HALL_AISLE_HALF_WIDTH * 2, 0.02, 11.4])

  // ---------- 牆：下段深紅木作、上段米色 ----------
  const dado = 1.3
  const wall = (x: number, z: number, w: number, d: number) => {
    add(box, m.wallLow, [x, dado / 2, z], [w, dado, d])
    add(box, m.wallHigh, [x, dado + (H - dado) / 2, z], [w, H - dado, d])
  }
  wall(0, R.minZ, W, 0.3) // 後牆
  wall(R.minX, 0, 0.3, D) // 左牆
  wall(R.maxX, 0, 0.3, D) // 右牆
  const doorW = HALL_DOOR.halfWidth * 2
  const sideW = (W - doorW) / 2
  wall(R.minX + sideW / 2, R.maxZ, sideW, 0.3)
  wall(R.maxX - sideW / 2, R.maxZ, sideW, 0.3)
  add(box, m.wallHigh, [0, (H + HALL_DOOR_TOP) / 2, R.maxZ], [doorW, H - HALL_DOOR_TOP, 0.3])
  // 殿門：門框、橫披窗、推開的格扇門、門外的庭院景色與地上的日光（hallDoorway.ts）
  const doorway = buildHallDoorway(root, tracker, { lacquer: m.pillar, lacquerDark: m.altar, gold: m.gold }, box, new THREE.Vector3(...HALL_ENV.sun.position).normalize())

  // ---------- 天花、彩繪樑、藻井 ----------
  add(box, m.ceiling, [0, H + 0.1, 0], [W, 0.2, D])
  for (const z of [6, 2, -2, -6]) {
    add(box, m.beam, [0, H - 0.35, z], [W, 0.45, 0.4])
    add(box, m.beamTrim, [0, H - 0.6, z], [W, 0.06, 0.42])
  }
  const caissonZ = 0
  const rings: Array<[number, number, THREE.Material]> = [
    [2.6, 0.12, m.beamTrim],
    [2.2, 0.16, m.beam],
    [1.75, 0.2, m.gold],
    [1.3, 0.24, m.altar],
    [0.85, 0.28, m.gold],
  ]
  // 藻井：由外而內、逐層下降的八角環，從下方仰看形成層層內收的效果
  const octa = geo(new THREE.CylinderGeometry(1, 1, 1, 8))
  rings.forEach(([r, h, mat], i) => {
    add(octa, mat, [0, H - 0.2 - i * 0.07, caissonZ], [r, h, r], Math.PI / 8)
  })

  // ---------- 柱子 ----------
  instanced(cyl, m.pillar, HALL_PILLARS.map((p) => ({ pos: [p.x, H / 2, p.z], scale: [0.3, H, 0.3] })))
  instanced(cyl, m.stone, HALL_PILLARS.map((p) => ({ pos: [p.x, 0.15, p.z], scale: [0.42, 0.3, 0.42] })))
  instanced(cyl, m.gold, HALL_PILLARS.map((p) => ({ pos: [p.x, H - 0.85, p.z], scale: [0.34, 0.2, 0.34] })))

  // ---------- 光明燈牆（兩側） ----------
  const cells: Array<{ pos: [number, number, number]; scale: [number, number, number] }> = []
  const frames: Array<{ pos: [number, number, number]; scale: [number, number, number] }> = []
  for (const side of [-1, 1]) {
    const x = side * (R.maxX - 0.25)
    frames.push({ pos: [x, 2.7, 1.5], scale: [0.18, 2.6, 7.4] })
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 18; col++) {
        cells.push({ pos: [x - side * 0.1, 1.6 + row * 0.36, -2 + col * 0.4], scale: [0.04, 0.26, 0.3] })
      }
    }
  }
  instanced(box, m.lampFrame, frames)
  instanced(box, m.lampCell, cells)

  // ---------- 宮燈 ----------
  const lanterns = [-3, 3].flatMap((x) => [4.5, -1].map((z) => ({ x, z })))
  instanced(sphere, m.lantern, lanterns.map((l) => ({ pos: [l.x, H - 1.6, l.z], scale: [0.32, 0.4, 0.32] })))
  instanced(cyl, m.gold, lanterns.flatMap((l) => [
    { pos: [l.x, H - 1.17, l.z] as [number, number, number], scale: [0.16, 0.08, 0.16] as [number, number, number] },
    { pos: [l.x, H - 2.03, l.z] as [number, number, number], scale: [0.16, 0.08, 0.16] as [number, number, number] },
  ]))
  instanced(cyl, m.lampFrame, lanterns.map((l) => ({ pos: [l.x, H - 0.6, l.z], scale: [0.012, 1.1, 0.012] })))

  // ---------- 神龕台基 ----------
  const A = HALL_ALTAR
  const altarW = A.maxX - A.minX
  add(box, m.stone, [0, 0.22, (A.minZ + A.maxZ) / 2], [altarW, 0.44, A.maxZ - A.minZ])
  const upperFront = -6.0
  add(box, m.altar, [0, 0.77, (A.minZ + upperFront) / 2], [altarW - 0.4, 0.66, upperFront - A.minZ])
  add(box, m.gold, [0, 1.12, upperFront + 0.02], [altarW - 0.4, 0.06, 0.06])
  add(box, m.gold, [0, 0.46, upperFront + 0.02], [altarW - 0.4, 0.04, 0.06])
  const altarTop = 1.1

  // 三座神龕（柱、頂、匾額）
  const shrine = (x: number, z: number, w: number, h: number, text: string) => {
    for (const side of [-1, 1]) add(box, m.pillar, [x + side * (w / 2), altarTop + h / 2, z + 0.75], [0.16, h, 0.16])
    add(box, m.altar, [x, altarTop + h + 0.12, z + 0.2], [w + 0.5, 0.24, 1.5])
    add(box, m.gold, [x, altarTop + h + 0.27, z + 0.2], [w + 0.6, 0.06, 1.6])
    const tex = tracker.track(plaqueTexture(text))
    const plaque = new THREE.Mesh(geo(new THREE.PlaneGeometry(Math.min(w, 2.4), Math.min(w, 2.4) / 4)), lambert('#ffffff', { map: tex }))
    plaque.position.set(x, altarTop + h + 0.6, z + 0.9)
    root.add(plaque)
    add(box, m.lampFrame, [x, altarTop + h + 0.6, z + 0.86], [Math.min(w, 2.4) + 0.14, Math.min(w, 2.4) / 4 + 0.12, 0.05])
  }
  const S = HALL_STATUES
  shrine(S.buddha.x, S.buddha.z, 3, 4.1, '佛光普照')
  shrine(S.guanyin.x, S.guanyin.z, 2.2, 3.2, '慈航普渡')
  shrine(S.mazu.x, S.mazu.z, 2.2, 3.2, '海國慈航')

  // 神像插槽
  const kit = createStatueKit(tracker)
  const statueSlots = {} as Record<StatueId, THREE.Group>
  for (const id of ['buddha', 'guanyin', 'mazu'] as const) {
    const slot = new THREE.Group()
    slot.name = `slot:${id}`
    slot.position.set(S[id].x, altarTop, S[id].z)
    slot.add(buildStatue(kit, id))
    root.add(slot)
    statueSlots[id] = slot
  }

  // ---------- 供桌 ----------
  const T = HALL_TABLE
  const tableW = T.maxX - T.minX
  const tableZ = (T.minZ + T.maxZ) / 2
  const tableD = T.maxZ - T.minZ
  add(box, m.altar, [0, 0.95, tableZ], [tableW, 0.1, tableD])
  add(box, m.cloth, [0, 0.47, T.maxZ - 0.02], [tableW - 0.1, 0.9, 0.04])
  add(box, m.gold, [0, 0.78, T.maxZ + 0.005], [tableW - 0.1, 0.12, 0.03])
  for (const sx of [-1, 1]) add(box, m.altar, [sx * (tableW / 2 - 0.08), 0.45, tableZ], [0.12, 0.9, tableD - 0.05])

  const top = 1.0
  // 香爐：每尊神像正前方一個（位置來自 HALL_CENSERS）。香與煙由 IncenseSystem 繪製。
  const censerProfile = [[0, 0], [0.12, 0], [0.1, 0.06], [0.24, 0.12], [0.27, 0.3], [0.24, 0.32], [0.2, 0.22], [0, 0.22]] as const
  const censerGeo = geo(new THREE.LatheGeometry(censerProfile.map(([r, y]) => new THREE.Vector2(r, y)), 16))
  for (const c of HALL_CENSERS) add(censerGeo, m.bronze, [c.x, top, c.z], [1, 1, 1])

  // 燭台與紅燭
  const candles = [-3.6, -1.6, 1.6, 3.6].map((x) => ({ x, z: tableZ }))
  instanced(cyl, m.gold, candles.map((c) => ({ pos: [c.x, top + 0.05, c.z], scale: [0.09, 0.1, 0.09] })))
  instanced(cyl, m.candle, candles.map((c) => ({ pos: [c.x, top + 0.3, c.z], scale: [0.045, 0.4, 0.045] })))
  const glow = tracker.track(glowTexture())
  const flames = candles.map((c) => {
    const mat = tracker.track(new THREE.SpriteMaterial({ map: glow, color: '#ffd28a', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
    const s = new THREE.Sprite(mat)
    s.position.set(c.x, top + 0.56, c.z)
    root.add(s)
    return s
  })

  // 花瓶與鮮花、果盤
  const vaseProfile = [[0, 0], [0.07, 0], [0.11, 0.1], [0.1, 0.24], [0.05, 0.34], [0.07, 0.4], [0, 0.4]] as const
  const vaseGeo = geo(new THREE.LatheGeometry(vaseProfile.map(([r, y]) => new THREE.Vector2(r, y)), 14))
  for (const x of [-2.6, 2.6]) {
    add(vaseGeo, m.bronze, [x, top, tableZ], [1, 1, 1])
    instanced(sphere, m.flower, Array.from({ length: 7 }, (_, i) => ({
      pos: [x + Math.sin(i * 2.4) * 0.12, top + 0.5 + (i % 3) * 0.06, tableZ + Math.cos(i * 2.4) * 0.1] as [number, number, number],
      scale: [0.06, 0.06, 0.06] as [number, number, number],
    })))
  }
  for (const x of [-0.9, 0.9]) {
    add(cyl, m.gold, [x, top + 0.02, tableZ], [0.2, 0.03, 0.2])
    instanced(sphere, m.fruit, [[0, 0.09, 0], [0.09, 0.09, 0.05], [-0.09, 0.09, 0.04], [0, 0.09, -0.08], [0.02, 0.19, 0]].map(([dx, dy, dz]) => ({
      pos: [x + dx!, top + dy!, tableZ + dz!] as [number, number, number],
      scale: [0.075, 0.075, 0.075] as [number, number, number],
    })))
  }

  // ---------- 蒲團陣列 ----------
  // 圓鼓的蒲團：側面外凸、頂面微隆（半徑 1、高 1，依 CUSHION_RADIUS 縮放）
  const cushionProfile = [[0, 0], [0.9, 0], [1, 0.35], [0.94, 0.8], [0.6, 1], [0, 1.04]] as const
  const cushionGeo = geo(new THREE.LatheGeometry(cushionProfile.map(([r, y]) => new THREE.Vector2(r, y)), 14))
  instanced(cushionGeo, m.cushion, HALL_CUSHIONS.map((c) => ({ pos: [c.x, 0, c.z], scale: [CUSHION_RADIUS, 0.15, CUSHION_RADIUS] })))

  // 靜態物件依材質合併以減少 draw call。神像各自合併、不跨插槽，才能單獨換成寫實模型；
  // 地板（點擊射線目標）不合併。
  for (const slot of Object.values(statueSlots)) for (const statue of slot.children) mergeStatic(statue, tracker)
  mergeStatic(root, tracker, (o) => o === floor || o.name.startsWith('slot:') || o.name.startsWith('doorway-'))

  // 寫實神像：三尊同時下載，各自到齊就替換；失敗的維持程序化造型（媽祖是紅布覆蓋的佔位）。
  let disposed = false
  const statuesReady = createStatueLoaders(renderer).then(async (loaders) => {
    // 門外景貼圖與神像共用 loader（同一組 Basis 轉碼 worker）；到之前門洞是亮色
    const backdropReady = loaders.ktx2.loadAsync(`${import.meta.env.BASE_URL}backdrops/hall_doorway.ktx2?v=${DOORWAY_VIEW_VERSION}`).then(
      (tex) => {
        tracker.track(tex)
        if (disposed) return
        tex.anisotropy = preset.statueTier === 'hi' ? 4 : 1
        doorway.backdrop.map = tex
        doorway.backdrop.color.set('#ffffff')
        doorway.backdrop.needsUpdate = true
        onChange()
      },
      (err) => console.warn('門外景貼圖載入失敗，維持亮色', err),
    )
    await Promise.all([
      backdropReady,
      ...
      (Object.keys(statueSlots) as StatueId[]).map(async (id) => {
        try {
          // 先載入到暫存的 Group，確認場景還在才換進插槽
          const staging = new THREE.Group()
          await loadStatueModel(staging, id, preset.statueTier, loaders, tracker)
          if (disposed) return
          const slot = statueSlots[id]
          slot.clear()
          slot.add(...staging.children)
          onChange()
        } catch (err) {
          console.warn('神像模型載入失敗，維持替代造型', id, err)
        }
      }),
    ])
    loaders.dispose()
  }).catch((err) => console.warn('神像 loader 建立失敗', err))

  return {
    root,
    walkSurface: floor,
    statueSlots,
    statuesReady,
    dispose() {
      disposed = true
    },
    update(t) {
      flames.forEach((f, i) => {
        const k = 1 + Math.sin(t * 11 + i * 1.7) * 0.08 + Math.sin(t * 23 + i) * 0.05
        f.scale.set(0.16 * k, 0.24 * k, 1)
      })
      m.lantern.emissiveIntensity = 0.5 + Math.sin(t * 1.7) * 0.04
    },
  }
}
