import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CarFleet, CAR_CAPACITY } from './CarFleet'
import { ResourceTracker } from './ResourceTracker'

describe('CarFleet 渲染組件', () => {
  it('初始化時使用替代用幾何，設置容量為 16', () => {
    const parent = new THREE.Group()
    const tracker = new ResourceTracker()
    const fleet = new CarFleet(parent, tracker)

    expect(parent.children.length).toBe(1)
    const instMesh = parent.children[0] as THREE.InstancedMesh
    expect(instMesh.isInstancedMesh).toBe(true)
    expect(instMesh.count).toBe(0)
    expect(fleet.visible).toBe(true)

    fleet.visible = false
    expect(fleet.visible).toBe(false)
    expect(instMesh.visible).toBe(false)

    fleet.dispose()
    expect(parent.children.length).toBe(0)
    tracker.dispose()
  })

  it('sync 能正確同步實例座標、朝向、車種與透明度', () => {
    const parent = new THREE.Group()
    const tracker = new ResourceTracker()
    const fleet = new CarFleet(parent, tracker)
    const instMesh = parent.children[0] as THREE.InstancedMesh

    const testCars = [
      { kind: 0, x: 1.5, z: -2.0, heading: Math.PI / 4, opacity: 1.0 },
      { kind: 3, x: -3.0, z: 4.5, heading: Math.PI, opacity: 0.5 },
    ]

    fleet.sync(testCars, 100)
    expect(instMesh.count).toBe(2)

    const mat = new THREE.Matrix4()
    instMesh.getMatrixAt(0, mat)
    const pos = new THREE.Vector3()
    const rot = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    mat.decompose(pos, rot, scale)

    expect(pos.x).toBeCloseTo(1.5)
    expect(pos.z).toBeCloseTo(-2.0)
    expect(scale.x).toBeCloseTo(1.0)

    const kindAttr = instMesh.geometry.getAttribute('kindId')
    const opacityAttr = instMesh.geometry.getAttribute('opacity')
    expect(kindAttr.getX(0)).toBe(0)
    expect(kindAttr.getX(1)).toBe(3)
    expect(opacityAttr.getX(0)).toBeCloseTo(1.0)
    expect(opacityAttr.getX(1)).toBeCloseTo(0.5)

    // 超出容量上限截斷保護
    const overflowCars = Array.from({ length: 20 }, (_, i) => ({
      kind: i % 4,
      x: i,
      z: i,
      heading: 0,
      opacity: 1,
    }))
    fleet.sync(overflowCars, 200)
    expect(instMesh.count).toBe(CAR_CAPACITY)

    tracker.dispose()
  })
})
