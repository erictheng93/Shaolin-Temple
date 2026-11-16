import * as THREE from 'three'

/** 名牌高度（公尺）；寬度依文字長度。 */
const LABEL_HEIGHT = 0.28

function makeLabelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  const font = '500 28px system-ui, "Noto Sans TC", sans-serif'
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 24
  c.width = w
  c.height = 44
  ctx.font = font
  ctx.fillStyle = 'rgba(20,22,28,0.55)'
  ctx.beginPath()
  ctx.roundRect(0, 0, w, 44, 22)
  ctx.fill()
  ctx.fillStyle = '#f4efe6'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, 23)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * 角色頭上的名牌（一個 Sprite）。貼圖與材質是這個名牌獨有的，由它自己擁有並釋放：
 * 改名時換掉貼圖並立即釋放舊的（材質沿用），dispose() 釋放目前的貼圖與材質。名字為空時不建立任何 GPU 資源。
 */
export class Nameplate {
  private sprite: THREE.Sprite | null = null
  private material: THREE.SpriteMaterial | null = null
  private texture: THREE.CanvasTexture | null = null
  private text = ''
  private visible = true
  private y = 0

  constructor(
    private readonly parent: THREE.Object3D,
    name: string,
  ) {
    this.set(name)
  }

  /** 名牌的高度（公尺，相對於 parent）；戴斗笠的衣裝會升高，換衣裝時重新設定。 */
  setY(y: number): void {
    this.y = y
    if (this.sprite) this.sprite.position.y = y
  }

  get name(): string {
    return this.text
  }

  /** 改名。同名時不做事；換貼圖後舊貼圖立刻釋放。 */
  set(name: string): void {
    if (name === this.text) return
    this.text = name
    this.texture?.dispose()
    this.texture = null
    if (!name) {
      if (this.material) this.material.map = null
      if (this.sprite) this.sprite.visible = false
      return
    }
    const tex = makeLabelTexture(name)
    this.texture = tex
    if (!this.material || !this.sprite) {
      this.material = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true })
      this.sprite = new THREE.Sprite(this.material)
      this.sprite.position.y = this.y
      this.parent.add(this.sprite)
    } else {
      // 從沒有貼圖（名字曾被清空）換回有貼圖時 shader 的 USE_MAP 會變，要重新編譯
      if (!this.material.map) this.material.needsUpdate = true
      this.material.map = tex
    }
    const img = tex.image as HTMLCanvasElement
    this.sprite.scale.set((img.width / img.height) * LABEL_HEIGHT, LABEL_HEIGHT, 1)
    this.sprite.visible = this.visible
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.sprite) this.sprite.visible = visible && !!this.text
  }

  dispose(): void {
    this.texture?.dispose()
    this.material?.dispose()
    this.sprite?.removeFromParent()
    this.texture = null
    this.material = null
    this.sprite = null
  }
}
