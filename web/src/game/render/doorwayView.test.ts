import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { ZONES } from '../world/zones'
import {
  DOORWAY_CARDS,
  DOORWAY_VIEW,
  HALL_FACADE,
  INTERIOR_BACK_VIEW,
  INTERIOR_FLOOR_VIEW,
  INTERIOR_ROOM,
  buildDoorwayBackdrop,
  buildInteriorBackdrop,
  doorwayViewUv,
  hallToFacade,
  panoramaUv,
  toLayer,
} from './doorwayView'
import { HALL_DOOR } from './hallDoorway'

describe('殿門外景', () => {
  const geometry = buildDoorwayBackdrop()
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  mesh.updateMatrixWorld()

  it('擷取視點正前方對到圖的水平中線', () => {
    const [ex, ey, ez] = DOORWAY_VIEW.eye
    const [u, v] = doorwayViewUv(ex, ey, ez + 10)
    expect(u).toBeCloseTo(0.5)
    expect(v).toBeCloseTo(DOORWAY_VIEW.latMax / (DOORWAY_VIEW.latMax - DOORWAY_VIEW.latMin))
  })

  it('代理幾何都在擷取視點前方、門外，地面不低於全景圖的下緣', () => {
    const p = geometry.attributes.position!
    const uv = geometry.attributes.uv!
    for (let i = 0; i < p.count; i++) {
      expect(p.getZ(i)).toBeGreaterThanOrEqual(HALL_DOOR.wallOuterZ - 1e-6)
      // v > 1 表示比 latMin 還低，會被 clamp 成最下排；代理幾何不該落在那裡
      expect(uv.getY(i)).toBeLessThanOrEqual(1)
    }
  })

  it('從殿內鏡頭範圍內任何位置看出門洞，都看得到外景（不會露出背景色）', () => {
    const b = ZONES.hall.cameraBounds!
    const raycaster = new THREE.Raycaster()
    const from = new THREE.Vector3()
    const to = new THREE.Vector3()
    let rays = 0
    for (let x = b.minX + 0.4; x <= b.maxX - 0.4; x += 2.4) {
      for (let z = -6; z <= b.maxZ - 0.4; z += 2.4) {
        for (const y of [1.6, 3.5, b.maxY]) {
          from.set(x, y, z)
          for (const dx of [-1.45, 0, 1.45]) {
            for (const dy of [0.3, 1.8, 3.55]) {
              to.set(dx, dy, HALL_DOOR.wallOuterZ)
              raycaster.set(from, to.clone().sub(from).normalize())
              expect(raycaster.intersectObject(mesh).length, `(${x}, ${y}, ${z}) → (${dx}, ${dy})`).toBeGreaterThan(0)
              rays++
            }
          }
        }
      }
    }
    expect(rays).toBeGreaterThan(100)
  })

  it('門扇與門框不進入殿內可走範圍，出入口在門洞之內', () => {
    const hall = ZONES.hall
    // 門扇正面在 z=8.77，可走範圍（角色中心）到 bounds.maxZ
    expect(hall.bounds.maxZ).toBeLessThan(8.77)
    const portal = hall.portals[0]!.rect
    expect(portal.minX).toBeGreaterThanOrEqual(-HALL_DOOR.halfWidth)
    expect(portal.maxX).toBeLessThanOrEqual(HALL_DOOR.halfWidth)
  })

  it('直立片與地面／半球取不同的貼圖層：物件只出現在直立片上（防止香爐在門外景出現兩個）', () => {
    // 重現方式：直立片與它後面的地面若取同一張圖，鏡頭一離開擷取點，地面上被香爐擋住的那一塊（圖上仍畫著香爐）
    // 就會露出來，變成兩個香爐。所以地面與半球只能取第 0 層（底圖，沒有香爐與石燈籠），直立片只能取第 1 層。
    const [background, cards] = geometry.groups
    expect(geometry.groups.length).toBe(2)
    const uv = geometry.attributes.uv!
    for (let i = background!.start; i < background!.start + background!.count; i++) expect(uv.getY(i)).toBeLessThan(0.5)
    for (let i = cards!.start; i < cards!.start + cards!.count; i++) expect(uv.getY(i)).toBeGreaterThan(0.5)
    expect(cards!.count).toBe(DOORWAY_CARDS.length * 2 * 2 * 6)
  })

  it('直立片從擷取視點看涵蓋整個物件（香爐連石座與香、石燈籠連頂蓋）', () => {
    const [ex, , ez] = DOORWAY_VIEW.eye
    for (const c of DOORWAY_CARDS) {
      // 物件的外緣（石座半寬約 0.85 × halfWidth，離擷取視點最近的那一側）投影到直立片所在的平面上，仍要在直立片之內
      const d = Math.hypot(c.x - ex, c.z - ez)
      const r = c.halfWidth * 0.85
      expect((r * d) / (d - r)).toBeLessThanOrEqual(c.halfWidth + 1e-6)
      // 最高點：香爐的香約 1.9、石燈籠頂約 1.95（離地）
      expect(c.height).toBeGreaterThan(1.95)
    }
  })
})

describe('殿內景（從庭院看進殿門）', () => {
  const geometry = buildInteriorBackdrop()
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  mesh.updateMatrixWorld()
  const R = INTERIOR_ROOM

  it('兩層之間留有間隔，toLayer 不會取到另一層', () => {
    expect(toLayer(-1, 0, 512)).toBeGreaterThan(0)
    expect(toLayer(2, 0, 512)).toBeLessThan(0.5)
    expect(toLayer(-1, 1, 512)).toBeGreaterThan(0.5)
    expect(toLayer(2, 1, 512)).toBeLessThan(1)
  })

  it('代理房間在庭院主殿殿身之內（只從門洞看得到），且落在各自全景圖的範圍內', () => {
    const p = geometry.attributes.position!
    for (let i = 0; i < p.count; i++) {
      const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)]
      expect(Math.abs(x)).toBeLessThan(5.7)
      expect(y).toBeGreaterThan(0.8)
      expect(y).toBeLessThan(3.8)
      expect(z).toBeLessThan(HALL_FACADE.z)
      expect(z).toBeGreaterThan(-16.7)
      const view = Math.abs(z - R.backZ) < 1e-6 && y > R.floorY + 1e-6 && y < R.ceilingY - 1e-6 ? INTERIOR_BACK_VIEW : INTERIOR_FLOOR_VIEW
      const [u, v] = panoramaUv(view, x, y, Math.min(z, hallToFacade(0, 0, 8.7)[2]))
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('從庭院各處看進門洞，都看得到殿內景（不會露出殿身內部或天空）', () => {
    const raycaster = new THREE.Raycaster()
    const from = new THREE.Vector3()
    const to = new THREE.Vector3()
    const door = hallToFacade(1.45, 3.55, 9.15)
    let rays = 0
    for (let x = -14; x <= 14; x += 3.5) {
      for (let z = -4; z <= 16; z += 4) {
        for (const y of [1.6, 4, 7]) {
          from.set(x, y, z)
          for (const dx of [-1, 0, 1]) {
            for (const fy of [0.1, 0.5, 0.95]) {
              to.set(dx * door[0], HALL_FACADE.y + 0.14 + fy * (door[1] - HALL_FACADE.y - 0.14), HALL_FACADE.z)
              const dir = to.clone().sub(from).normalize()
              // 斜到看不進門洞的角度（被抱框擋住）不算
              if (Math.abs(dir.x / dir.z) > 2) continue
              raycaster.set(from, dir)
              expect(raycaster.intersectObject(mesh).length, `(${x}, ${y}, ${z}) → (${to.x.toFixed(2)}, ${to.y.toFixed(2)})`).toBeGreaterThan(0)
              rays++
            }
          }
        }
      }
    }
    expect(rays).toBeGreaterThan(200)
  })
})
