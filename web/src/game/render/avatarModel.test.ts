/// <reference types="node" />
import { readFileSync } from 'node:fs'
import type * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'

// 衣裝靠 scripts/build-avatar.mjs 寫在 body 上的自訂屬性 _OUTFIT（x：到袈裟披帶中線的有號距離，y：念珠 1）。
// 這裡用 three 的 GLTFLoader 實際載入，確認屬性在載入後存在（名稱轉成小寫 _outfit），AvatarFactory 才能改名為 robeField。
function load(file: string): Promise<THREE.Group> {
  const buf = readFileSync(new URL(`../../../public/models/${file}`, import.meta.url))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', (g) => resolve(g.scene), reject))
}

describe('小沙彌模型的衣裝屬性', () => {
  it.each([
    ['monk.glb', true],
    ['monk-lod.glb', false],
  ])('%s：body 有 _outfit（VEC2）與頂點色；念珠只在完整模型', async (file, hasBeads) => {
    const scene = await load(file)
    const body = (scene.getObjectByName('body') as THREE.Mesh).geometry
    const field = body.getAttribute('_outfit')
    expect(field).toBeDefined()
    expect(field.itemSize).toBe(2)
    expect(field.count).toBe(body.getAttribute('position').count)
    expect(body.getAttribute('color')).toBeDefined()
    let beads = 0
    let onSash = 0
    let leftShoulder = Infinity
    let rightShoulder = Infinity
    const pos = body.getAttribute('position')
    for (let i = 0; i < field.count; i++) {
      if (field.getY(i) > 0.5) beads++
      else if (Math.abs(field.getX(i)) < 0.058) onSash++
      // 肩膀附近（袍頂下方）的頂點離披帶中線多遠：左肩（+x）在帶上、右肩（-x）不在
      if (pos.getY(i) > 0.6 && pos.getY(i) < 0.66) {
        if (pos.getX(i) > 0.08) leftShoulder = Math.min(leftShoulder, Math.abs(field.getX(i)))
        if (pos.getX(i) < -0.08) rightShoulder = Math.min(rightShoulder, Math.abs(field.getX(i)))
      }
    }
    expect(beads > 0).toBe(hasBeads)
    expect(onSash).toBeGreaterThan(0)
    expect(leftShoulder).toBeLessThan(0.058)
    expect(rightShoulder).toBeGreaterThan(0.1)
    expect((scene.getObjectByName('skin') as THREE.Mesh).geometry.getAttribute('_outfit')).toBeUndefined()
  })
})
