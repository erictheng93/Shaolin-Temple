import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Nameplate } from './Nameplate'

// 測試環境沒有 DOM：canvas 換成只記錄尺寸的替身（名牌只用到 2D context 的這幾個方法）。
beforeEach(() => {
  const ctx = { measureText: (t: string) => ({ width: t.length * 28 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} }
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) })
})
afterEach(() => vi.unstubAllGlobals())

const spriteOf = (parent: THREE.Object3D) => parent.children.find((c): c is THREE.Sprite => c instanceof THREE.Sprite)

describe('Nameplate', () => {
  it('改名時換貼圖並立即釋放舊的；材質沿用；dispose 釋放目前的貼圖與材質', () => {
    const disposed: THREE.Texture[] = []
    const spy = vi.spyOn(THREE.Texture.prototype, 'dispose').mockImplementation(function (this: THREE.Texture) {
      disposed.push(this)
    })
    const parent = new THREE.Group()
    const plate = new Nameplate(parent, '慧明')
    const sprite = spriteOf(parent)!
    const mat = sprite.material
    const first = mat.map!
    const width = sprite.scale.x

    plate.set('看雲閒客')
    expect(disposed).toEqual([first])
    expect(sprite.material).toBe(mat)
    expect(mat.map).not.toBe(first)
    expect(sprite.scale.x).toBeGreaterThan(width) // 名字變長，名牌變寬
    expect(parent.children.filter((c) => c instanceof THREE.Sprite)).toHaveLength(1)

    plate.set('看雲閒客') // 同名不重建
    expect(disposed).toHaveLength(1)

    const current = mat.map!
    const matDispose = vi.spyOn(mat, 'dispose')
    plate.dispose()
    expect(disposed).toEqual([first, current])
    expect(matDispose).toHaveBeenCalledTimes(1)
    expect(spriteOf(parent)).toBeUndefined()
    spy.mockRestore()
  })

  it('名字為空時不建立資源；之後設定名字才建立，可見性沿用', () => {
    const parent = new THREE.Group()
    const plate = new Nameplate(parent, '')
    expect(spriteOf(parent)).toBeUndefined()
    plate.setVisible(false)
    plate.setY(1.5) // 還沒有 sprite 時設定的高度，建立時套用
    plate.set('淨塵')
    expect(spriteOf(parent)!.visible).toBe(false)
    expect(spriteOf(parent)!.position.y).toBe(1.5)
    plate.setY(1.8)
    expect(spriteOf(parent)!.position.y).toBe(1.8)
    plate.setVisible(true)
    expect(spriteOf(parent)!.visible).toBe(true)
    plate.set('')
    expect(spriteOf(parent)!.visible).toBe(false)
    expect(spriteOf(parent)!.material.map).toBeNull() // 已釋放的貼圖不留在材質上
    plate.dispose()
  })
})
