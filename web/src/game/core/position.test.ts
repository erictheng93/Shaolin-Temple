import { describe, expect, it } from 'vitest'
import { debugPosition, formatPosition } from './position'

describe('效能資訊的本機座標', () => {
  it('取整到 0.1 公尺、面向換成 0～359 的整數度', () => {
    expect(debugPosition('courtyard', 3.24, -11.46, Math.PI / 2)).toEqual({ zone: 'courtyard', x: 3.2, z: -11.5, heading: 90 })
    expect(debugPosition('hall', 0, 0, -Math.PI / 2).heading).toBe(270)
    expect(debugPosition('hall', 0, 0, 2 * Math.PI).heading).toBe(0)
  })

  it('沒有 -0，微小移動取整後相同（UiState 比對不變）', () => {
    expect(Object.is(debugPosition('hall', -0.04, 0, 0).x, 0)).toBe(true)
    expect(debugPosition('hall', 1.21, 2, 0)).toEqual(debugPosition('hall', 1.24, 2, 0))
  })

  it('等寬格式：數值靠右補齊', () => {
    expect(formatPosition({ zone: 'courtyard', x: 3.2, z: -11.5, heading: 90 })).toBe('courtyard x   3.2 z -11.5  90°')
    expect(formatPosition({ zone: 'hall', x: -0.5, z: 7, heading: 180 })).toBe('hall x  -0.5 z   7.0 180°')
  })
})
