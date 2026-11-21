/// <reference types="node" />
import { readFileSync } from 'node:fs'
import type * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'

function loadCars(): Promise<THREE.Group> {
  const buf = readFileSync(new URL('../../../public/models/cars.glb', import.meta.url))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', (g) => resolve(g.scene), reject))
}

describe('碰碰車模型（cars.glb）', () => {
  it('幾何體具有 _kind 屬性、頂點數與索引正確，總三角形數 ≤ 6000', async () => {
    const scene = await loadCars()
    const mesh = scene.getObjectByName('cars') as THREE.Mesh | undefined
    expect(mesh).toBeDefined()
    const geometry = mesh!.geometry
    const pos = geometry.getAttribute('position')
    const kind = geometry.getAttribute('_kind')
    expect(pos).toBeDefined()
    expect(kind).toBeDefined()
    expect(kind.itemSize).toBe(1)
    expect(kind.count).toBe(pos.count)

    const index = geometry.getIndex()
    expect(index).toBeDefined()
    const triCount = index!.count / 3
    expect(triCount).toBeLessThanOrEqual(6000)
    expect(triCount).toBeGreaterThan(500)
  })

  it('四個車種（0: classic, 1: woodfish, 2: racer, 3: firewheel）皆存在且包圍盒在 1.1 × 0.9 × 1.8 公尺內', async () => {
    const scene = await loadCars()
    const mesh = scene.getObjectByName('cars') as THREE.Mesh
    const geometry = mesh.geometry
    const pos = geometry.getAttribute('position')
    const kind = geometry.getAttribute('_kind')

    const kindsPresent = new Set<number>()
    const boundsByKind = new Map<number, { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }>()

    for (let i = 0; i < pos.count; i++) {
      const k = kind.getX(i)
      expect(Number.isInteger(k)).toBe(true)
      kindsPresent.add(k)

      let b = boundsByKind.get(k)
      if (!b) {
        b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }
        boundsByKind.set(k, b)
      }
      const x = pos.getX(i)
      const y = pos.getY(i)
      const z = pos.getZ(i)
      b.minX = Math.min(b.minX, x)
      b.maxX = Math.max(b.maxX, x)
      b.minY = Math.min(b.minY, y)
      b.maxY = Math.max(b.maxY, y)
      b.minZ = Math.min(b.minZ, z)
      b.maxZ = Math.max(b.maxZ, z)
    }

    expect([...kindsPresent].sort()).toEqual([0, 1, 2, 3])

    for (const k of [0, 1, 2, 3]) {
      const b = boundsByKind.get(k)!
      const width = b.maxX - b.minX
      const height = b.maxY - b.minY
      const depth = b.maxZ - b.minZ

      expect(width, `車種 ${k} 寬度超標`).toBeLessThanOrEqual(1.1)
      expect(height, `車種 ${k} 高度超標`).toBeLessThanOrEqual(0.9)
      expect(depth, `車種 ${k} 長度超標`).toBeLessThanOrEqual(1.8)

      // 寬高長皆具備合理的實體尺寸
      expect(width).toBeGreaterThan(0.5)
      expect(height).toBeGreaterThan(0.3)
      expect(depth).toBeGreaterThan(0.6)
    }
  })

  it('模型網格與材質不含任何人體／人形部位字樣（尤其是 firewheel 風火輪）', async () => {
    const scene = await loadCars()
    const banned = /(head|skin|monk|avatar|face|arm|leg|hand|body|torso)/i

    scene.traverse((obj) => {
      expect(obj.name).not.toMatch(banned)
      const m = obj as THREE.Mesh
      if (m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        for (const mat of mats) {
          expect(mat.name).not.toMatch(banned)
        }
      }
    })
  })
})
