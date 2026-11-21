export interface InputCallbacks {
  /** 滑鼠或觸控筆點擊（非拖曳）畫面某處；手指點擊不觸發（觸控裝置用虛擬搖桿移動）。座標為相對 canvas 的 NDC（-1..1）。 */
  onTap(ndcX: number, ndcY: number): void
  /** 拖曳旋轉鏡頭（像素位移）。 */
  onRotate(dx: number, dy: number): void
  /** 縮放（正值拉遠）。 */
  onZoom(delta: number): void
  /** 鍵盤方向改變或有任何輸入，需要喚醒渲染迴圈。 */
  onActivity(): void
  /** 一般按鍵按下（例如 KeyE 觸發上下車互動）。 */
  onKey?(code: string): void
}

const TAP_SLOP_PX = 8
const TAP_MAX_MS = 450
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
  private downAt = 0
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
      this.downAt = performance.now()
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
    if (!this.dragging && Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > TAP_SLOP_PX) {
      this.dragging = true
    }
    if (this.dragging) this.cb.onRotate(dx, dy)
  }

  private onUp = (e: PointerEvent): void => {
    const wasSingle = this.pointers.size === 1
    this.pointers.delete(e.pointerId)
    if (wasSingle && e.pointerType !== 'touch' && !this.dragging && performance.now() - this.downAt < TAP_MAX_MS) {
      const r = this.el.getBoundingClientRect()
      this.cb.onTap(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    }
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
    if (this.isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
    if (!e.repeat) this.cb.onKey?.(e.code)
    if (!(e.code in MOVE_KEYS)) return
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
