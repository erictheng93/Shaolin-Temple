/// <reference types="node" />
import { readFileSync } from 'node:fs'
import type * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { BODY_PART, SKIN_PART, makeFaceGeometry } from './AvatarFactory'

// 衣裝靠 scripts/build-avatar.mjs 寫在模型上的自訂屬性：body 的 _OUTFIT（x：到袈裟披帶中線的有號距離，y：部位 BODY_PART）
// 與 skin 的 _PART（皮膚 0、斗笠 1）。這裡用 three 的 GLTFLoader 實際載入，確認屬性在載入後存在（名稱轉成小寫），
// AvatarFactory 才能改名為 robeField／skinPart，並檢查各部位的位置合理。
function load(file: string): Promise<THREE.Group> {
  const buf = readFileSync(new URL(`../../../public/models/${file}`, import.meta.url))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', (g) => resolve(g.scene), reject))
}
const geometryOf = (scene: THREE.Group, name: string) => (scene.getObjectByName(name) as THREE.Mesh).geometry

const MODELS = [
  ['monk.glb', true],
  ['monk-lod.glb', false],
] as const

describe('小沙彌模型的衣裝屬性', () => {
  it.each(MODELS)('%s：body 有 _outfit（VEC2）與頂點色；披帶只在袍與袖子上、偏袒右肩；念珠只在完整模型', async (file, fine) => {
    const scene = await load(file)
    const body = geometryOf(scene, 'body')
    const field = body.getAttribute('_outfit')
    expect(field).toBeDefined()
    expect(field.itemSize).toBe(2)
    expect(field.count).toBe(body.getAttribute('position').count)
    expect(body.getAttribute('color')).toBeDefined()
    const parts = new Set<number>()
    let onSash = 0
    let leftShoulder = Infinity
    let rightShoulder = Infinity
    const pos = body.getAttribute('position')
    for (let i = 0; i < field.count; i++) {
      const part = field.getY(i)
      expect(Number.isInteger(part)).toBe(true)
      parts.add(part)
      if (part > BODY_PART.robe) {
        // 短褂沒有披帶
        expect(Math.abs(field.getX(i))).toBeGreaterThan(1)
        continue
      }
      if (part !== BODY_PART.bead && Math.abs(field.getX(i)) < 0.058) onSash++
      // 肩膀附近（袍頂下方）的頂點離披帶中線多遠：左肩（+x）在帶上、右肩（-x）不在
      if (pos.getY(i) > 0.6 && pos.getY(i) < 0.66) {
        if (pos.getX(i) > 0.08) leftShoulder = Math.min(leftShoulder, Math.abs(field.getX(i)))
        if (pos.getX(i) < -0.08) rightShoulder = Math.min(rightShoulder, Math.abs(field.getX(i)))
      }
    }
    const expected: number[] = [BODY_PART.shared, BODY_PART.robe, BODY_PART.tunic, BODY_PART.trousers, BODY_PART.leggings, BODY_PART.belt]
    if (fine) expected.push(BODY_PART.bead)
    expect([...parts].sort()).toEqual(expected.sort())
    expect(onSash).toBeGreaterThan(0)
    expect(leftShoulder).toBeLessThan(0.058)
    expect(rightShoulder).toBeGreaterThan(0.1)
    expect(geometryOf(scene, 'skin').getAttribute('_outfit')).toBeUndefined()
  })

  it.each(MODELS)('%s：短褂及臀，下面看得出分開的兩條腿與綁腿', async (file) => {
    const body = geometryOf(await load(file), 'body')
    const field = body.getAttribute('_outfit')
    const pos = body.getAttribute('position')
    const range = (part: number) => {
      let [minY, maxY, minAbsX] = [Infinity, -Infinity, Infinity]
      for (let i = 0; i < pos.count; i++) {
        if (field.getY(i) !== part) continue
        minY = Math.min(minY, pos.getY(i))
        maxY = Math.max(maxY, pos.getY(i))
        minAbsX = Math.min(minAbsX, Math.abs(pos.getX(i)))
      }
      return { minY, maxY, minAbsX }
    }
    const tunic = range(BODY_PART.tunic)
    expect(tunic.minY).toBeGreaterThan(0.22)
    expect(tunic.minY).toBeLessThan(0.3)
    // 肩膀與袍同高（頭、袖子與合十的手不動）
    expect(tunic.maxY).toBeCloseTo(range(BODY_PART.robe).maxY, 2)
    const legs = range(BODY_PART.leggings)
    expect(legs.minY).toBeLessThan(0.08)
    // 兩條腿之間有空隙
    expect(legs.minAbsX).toBeGreaterThan(0.005)
    expect(range(BODY_PART.trousers).maxY).toBeGreaterThan(tunic.minY)
  })

  it.each(MODELS)('%s：skin 有 _part 與頂點色；皮膚的頂點色為 1，斗笠在眼睛以上，臉只取自皮膚', async (file) => {
    const skin = geometryOf(await load(file), 'skin')
    const part = skin.getAttribute('_part')
    expect(part).toBeDefined()
    expect(part.itemSize).toBe(1)
    const color = skin.getAttribute('color')
    const pos = skin.getAttribute('position')
    let hat = 0
    let hatMinY = Infinity
    for (let i = 0; i < pos.count; i++) {
      if (part.getX(i) === SKIN_PART.hat) {
        hat++
        hatMinY = Math.min(hatMinY, pos.getY(i))
      } else {
        expect(part.getX(i)).toBe(SKIN_PART.skin)
        // 皮膚乘上頂點色 1，外觀與改動前的單色材質相同
        expect([color.getX(i), color.getY(i), color.getZ(i)]).toEqual([1, 1, 1])
      }
    }
    expect(hat).toBeGreaterThan(0)
    // 眼睛在 y 約 0.8：斗笠最低的地方（後仰的後緣）也在眼睛之上
    expect(hatMinY).toBeGreaterThan(0.88)

    skin.setAttribute('skinPart', part)
    const face = makeFaceGeometry(skin).getAttribute('position')
    expect(face.count).toBeGreaterThan(0)
    // 臉的每個頂點都在頭的橢球面上（不含斗笠的帽沿）
    for (let i = 0; i < face.count; i++) {
      const e = (face.getX(i) / 0.25) ** 2 + ((face.getY(i) - 0.86) / 0.24) ** 2 + ((face.getZ(i) + 0.005) / 0.24) ** 2
      expect(Math.abs(e - 1)).toBeLessThan(1e-3)
    }
  })
})
