import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { ZONES } from '../world/zones'
import { DOORWAY_VIEW, buildDoorwayBackdrop, doorwayViewUv } from './doorwayView'
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
})
