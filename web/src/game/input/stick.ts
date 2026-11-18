/** 搖桿換算結果：推桿顯示位移（限制在半徑內，像素）與輸出向量（長度 0～1）。 */
export interface StickResult {
  knobX: number
  knobY: number
  x: number
  y: number
}

/**
 * 手指相對底座中心的位移 → 推桿位移與類比輸出：
 * 推桿限制在半徑內；死區內輸出 0，死區外把 deadZone～1 重新映射到 0～1，方向與位移相同。
 */
export function stickFromOffset(dx: number, dy: number, radius: number, deadZone: number): StickResult {
  const len = Math.hypot(dx, dy)
  if (len > radius) {
    dx = (dx / len) * radius
    dy = (dy / len) * radius
  }
  const m = Math.min(1, len / radius)
  if (m < deadZone) return { knobX: dx, knobY: dy, x: 0, y: 0 }
  const s = (m - deadZone) / (1 - deadZone)
  return { knobX: dx, knobY: dy, x: (dx / Math.min(len, radius)) * s, y: (dy / Math.min(len, radius)) * s }
}
