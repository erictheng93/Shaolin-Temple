export interface InputCallbacks {
  /** 拖曳旋轉鏡頭（像素位移）。 */
  onRotate(dx: number, dy: number): void
  /** 縮放（正值拉遠）。 */
  onZoom(delta: number): void
  /** 鍵盤方向改變或有任何輸入，需要喚醒渲染迴圈。 */
  onActivity(): void
}

const DRAG_SLOP_PX = 8
const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
}

/**
 * 指標與鍵盤輸入。不知道遊戲邏輯，只把原始輸入轉成意圖回呼。
 */
export class InputController {
  private pointers = new Map<number, { x: number; y: number }>()
  private downPos = { x: 0, y: 0 }
  private dragging = false
  private pinchDist = 0
  private keys = new Set<string>()

  constructor(
    private readonly el: HTMLElement,
    private readonly cb: InputCallbacks,
  ) {
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerup', this.onUp)
    el.addEventListener('pointercancel', this.onCancel)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('contextmenu', this.preventDefault)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.clearKeys)
  }

  /** 鍵盤在畫面座標的方向（x 右、y 下），未按鍵時為 0。 */
  get keyDirection(): { x: number; y: number } {
    let x = 0
    let y = 0
    for (const k of this.keys) {
      const d = MOVE_KEYS[k]
      if (d) {
        x += d[0]
        y += d[1]
      }
    }
    return { x: Math.sign(x), y: Math.sign(y) }
  }

  clearKeys = (): void => {
    this.keys.clear()
    this.cb.onActivity()
  }

  dispose(): void {
    const el = this.el
    el.removeEventListener('pointerdown', this.onDown)
    el.removeEventListener('pointermove', this.onMove)
    el.removeEventListener('pointerup', this.onUp)
    el.removeEventListener('pointercancel', this.onCancel)
    el.removeEventListener('wheel', this.onWheel)
    el.removeEventListener('contextmenu', this.preventDefault)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.clearKeys)
  }

  private preventDefault = (e: Event): void => e.preventDefault()

  private onDown = (e: PointerEvent): void => {
    this.el.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.pointers.size === 1) {
      this.downPos = { x: e.clientX, y: e.clientY }
      this.dragging = false
    } else if (this.pointers.size === 2) {
      this.dragging = true
      this.pinchDist = this.currentPinchDistance()
    }
    this.cb.onActivity()
  }

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    if (this.pointers.size === 2) {
      const d = this.currentPinchDistance()
      if (this.pinchDist > 0) this.cb.onZoom((this.pinchDist - d) * 0.03)
      this.pinchDist = d
      return
    }
    if (!this.dragging && Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > DRAG_SLOP_PX) {
      this.dragging = true
    }
    if (this.dragging) this.cb.onRotate(dx, dy)
  }

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId)
    if (this.pointers.size < 2) this.pinchDist = 0
  }

  private onCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId)
    this.pinchDist = 0
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    this.cb.onZoom(Math.sign(e.deltaY) * 0.8)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.code in MOVE_KEYS) || this.isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    if (!this.keys.has(e.code)) {
      this.keys.add(e.code)
      this.cb.onActivity()
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.keys.delete(e.code)) this.cb.onActivity()
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  }

  private currentPinchDistance(): number {
    const [a, b] = [...this.pointers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
}
