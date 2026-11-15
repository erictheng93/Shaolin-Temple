import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CENSERS, COURTYARD_CENSER, HALL_CENSERS } from '../world/zones'
import { IncenseSystem, STICK_LIFE_MS } from './IncenseSystem'
import { ResourceTracker } from './ResourceTracker'

// node 環境沒有 canvas：煙的貼圖只需要一個假的 2D context。
beforeEach(() => {
  const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' }
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) })
})
afterEach(() => vi.unstubAllGlobals())

const make = () => {
  const scene = new THREE.Scene()
  const tracker = new ResourceTracker()
  const sys = new IncenseSystem(scene, tracker, CENSERS)
  const meshes = () => scene.children as THREE.InstancedMesh[]
  return { scene, tracker, sys, meshes }
}

describe('IncenseSystem', () => {
  it('每個香爐有上限，超過時最舊的一支先消失', () => {
    const { sys } = make()
    const hall = HALL_CENSERS[0]!
    for (let i = 0; i < hall.sticks.cap + 3; i++) sys.add(hall.id, i)
    expect(sys.count(hall.id)).toBe(hall.sticks.cap)
    expect(sys.add('unknown', 0)).toBe(false)
  })

  it('只畫目前場景的香爐；香燒完就消失', () => {
    const { sys, meshes } = make()
    sys.add(COURTYARD_CENSER.id, 0)
    sys.add(HALL_CENSERS[2]!.id, 0)
    sys.setZone('courtyard')
    sys.update(1000, 1)
    const [sticks, smoke] = meshes()
    expect(sticks!.count).toBe(1)
    expect(smoke!.count).toBe(3)
    sys.setZone('hall')
    sys.update(1000, 1)
    // 殿內：主佛前的常駐香 + 剛插的一支
    const permanent = HALL_CENSERS.reduce((n, c) => n + c.permanent, 0)
    expect(sticks!.count).toBe(permanent + 1)
    sys.update(STICK_LIFE_MS + 1, 2)
    expect(sticks!.count).toBe(permanent)
    expect(sys.count()).toBe(0)
  })

  it('沒有香時不繪製（不多 draw call）；dispose 移出場景', () => {
    const scene = new THREE.Scene()
    const sys = new IncenseSystem(scene, new ResourceTracker(), [COURTYARD_CENSER])
    sys.update(0, 0)
    expect((scene.children as THREE.InstancedMesh[]).every((m) => !m.visible && m.count === 0)).toBe(true)
    sys.dispose()
    expect(scene.children).toHaveLength(0)
  })
})
