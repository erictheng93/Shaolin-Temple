import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { setAttributeUpdateRange } from './bufferRange'

describe('setAttributeUpdateRange', () => {
  it('reuses the cached range object without allocating new arrays or objects on subsequent calls', () => {
    const attr = new THREE.BufferAttribute(new Float32Array(100), 1)
    expect(attr.updateRanges).toHaveLength(0)
    expect(attr.version).toBe(0)

    setAttributeUpdateRange(attr, 0, 16)
    expect(attr.version).toBe(1)
    expect(attr.updateRanges).toHaveLength(1)
    expect(attr.updateRanges[0]).toEqual({ start: 0, count: 16 })

    const firstRangeObj = attr.updateRanges[0]
    const initialArrayRef = attr.updateRanges

    // 模擬 Three.js WebGLAttributes 上傳後清空區間
    attr.clearUpdateRanges()
    expect(attr.updateRanges).toHaveLength(0)
    // 陣列實例保持同一個
    expect(attr.updateRanges).toBe(initialArrayRef)

    // 第二次設定
    setAttributeUpdateRange(attr, 0, 32)
    expect(attr.version).toBe(2)
    expect(attr.updateRanges).toHaveLength(1)
    expect(attr.updateRanges[0]).toEqual({ start: 0, count: 32 })
    // 物件與陣列參照皆完全重複利用，無任何 GC 額外配置
    expect(attr.updateRanges[0]).toBe(firstRangeObj)
    expect(attr.updateRanges).toBe(initialArrayRef)
  })
})
