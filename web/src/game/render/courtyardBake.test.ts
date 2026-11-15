import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { BAKE_SETTINGS, lightmapUrl, patchBakedSun, SUN_HOOK } from './courtyardBake'
import { BAKED_FINGERPRINT } from './courtyardBake.generated'
import { ResourceTracker } from './ResourceTracker'
import { buildPlainCourtyard } from './TempleScene'

describe('庭院烘焙', () => {
  const tracker = new ResourceTracker()
  const court = buildPlainCourtyard(tracker)
  const { bake } = court

  it('目前的幾何與 uv1 和已烘焙的貼圖一致（不一致請執行 npm run bake:lightmaps）', () => {
    expect(bake.fingerprint()).toBe(BAKED_FINGERPRINT)
  })

  it('重建得到相同的指紋（uv1 的產生是確定性的）', () => {
    const t = new ResourceTracker()
    expect(buildPlainCourtyard(t).bake.fingerprint()).toBe(bake.fingerprint())
    t.dispose()
  })

  it('接收者都有 uv1，且落在貼圖範圍內', () => {
    expect(bake.receivers.length).toBeGreaterThan(5)
    for (const { mesh, kind } of bake.receivers) {
      const uv1 = mesh.geometry.attributes.uv1!
      expect(uv1.count).toBe(mesh.geometry.attributes.position!.count)
      if (kind === 'ground' && mesh !== court.ground) {
        // 地面類（鋪石、步道）都在投影範圍內；地面本身 140 公尺寬，超出部分取邊緣值
        for (let i = 0; i < uv1.count; i++) {
          expect(uv1.getX(i)).toBeGreaterThanOrEqual(0)
          expect(uv1.getX(i)).toBeLessThanOrEqual(1)
        }
      }
      if (kind === 'atlas') {
        for (let i = 0; i < uv1.count; i++) {
          for (const v of [uv1.getX(i), uv1.getY(i)]) {
            expect(v).toBeGreaterThan(0)
            expect(v).toBeLessThan(1)
          }
        }
      }
    }
  })

  it('圖集的 chart 互不重疊且在邊界內', () => {
    const size = BAKE_SETTINGS.atlasSize
    const rects = bake.atlas.rects
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(size)
      expect(r.y + r.h).toBeLessThanOrEqual(size)
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!
        const b = rects[j]!
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap, `chart ${i} 與 ${j} 重疊`).toBe(false)
      }
    }
  })

  it('烘焙貼圖網址帶指紋版本參數（重新烘焙後不會拿到快取的舊貼圖）', () => {
    expect(lightmapUrl('atlas', 512).endsWith(`lightmaps/courtyard_atlas_512.ktx2?v=${BAKED_FINGERPRINT}`)).toBe(true)
    expect(lightmapUrl('ground', 1024).endsWith(`lightmaps/courtyard_ground_1k.ktx2?v=${BAKED_FINGERPRINT}`)).toBe(true)
  })

  it('動態物件（樹冠、晾衣）不接收烘焙，地面類與圖集的材質不重複', () => {
    const receivers = new Set(bake.receivers.map((r) => r.mesh))
    expect(receivers.has(court.canopyMesh)).toBe(false)
    expect(receivers.has(court.robeMesh)).toBe(false)
    for (const m of bake.atlasMaterials) expect(bake.groundMaterials.has(m)).toBe(false)
  })

  it('太陽遮罩的 shader 掛點仍存在於 three 的 lights_fragment_begin', () => {
    const chunk = THREE.ShaderChunk.lights_fragment_begin
    expect(chunk.split(SUN_HOOK).length - 1).toBe(1)
    const shader = { fragmentShader: 'void main() {\n#include <lights_fragment_begin>\n}' } as THREE.WebGLProgramParametersWithUniforms
    patchBakedSun(shader)
    expect(shader.fragmentShader).toContain('directLight.color *= bakedSun;')
    expect(shader.fragmentShader).toContain('texture2D( aoMap, vAoMapUv ).a')
  })
})
