import type * as THREE from 'three'

interface CachedRangeAttribute extends THREE.BufferAttribute {
  _cachedRange?: { start: number; count: number }
}

/**
 * 設定 BufferAttribute 的單一更新區間（零每幀物件/陣列配置）。
 *
 * Three.js 的 WebGLAttributes 在每次上傳後會呼叫 attribute.clearUpdateRanges()，
 * 其內部行為是 this.updateRanges.length = 0，保留原有陣列實例。
 * 此處重複利用附加在 attribute 上的快取物件，直接寫入 updateRanges[0]，
 * 避免每幀 new Array 與 new Object 的 GC 負擔。
 */
export function setAttributeUpdateRange(
  attr: THREE.BufferAttribute,
  start: number,
  count: number,
): void {
  const cachedAttr = attr as CachedRangeAttribute
  let range = cachedAttr._cachedRange
  if (!range) {
    range = { start, count }
    cachedAttr._cachedRange = range
  } else {
    range.start = start
    range.count = count
  }
  attr.updateRanges[0] = range
  attr.updateRanges.length = 1
  attr.needsUpdate = true
}
