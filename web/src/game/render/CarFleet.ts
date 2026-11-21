import * as THREE from 'three'
import type { ResourceTracker } from './ResourceTracker'

export const CAR_MODEL_VERSION = 2
export const CAR_CAPACITY = 16

export interface CarInstance {
  c?: number
  kind: number
  x: number
  z: number
  heading: number
  opacity: number
}

const BAYER_SHADER = `
if (vOpacity < 0.999) {
  mat4 bayer = mat4(
    1.0, 13.0,  4.0, 16.0,
    9.0,  5.0, 12.0,  8.0,
    3.0, 15.0,  2.0, 14.0,
   11.0,  7.0, 10.0,  6.0
  ) / 17.0;
  int x = int(mod(gl_FragCoord.x, 4.0));
  int y = int(mod(gl_FragCoord.y, 4.0));
  if (vOpacity < bayer[x][y]) discard;
}
`

function patchCarMaterial(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float carKind;\nattribute float kindId;\nattribute float opacity;\nvarying float vOpacity;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n transformed *= step( abs( carKind - kindId ), 0.5 );\n vOpacity = opacity;',
      )
    shader.fragmentShader =
      'varying float vOpacity;\n' +
      shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n' + BAYER_SHADER,
      )
  }
}

function createFallbackGeometry(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(0.8, 0.4, 1.2).toNonIndexed()
  const pos = box.getAttribute('position')!
  const norm = box.getAttribute('normal')!
  const count = pos.count
  const totalCount = count * 4

  const positions = new Float32Array(totalCount * 3)
  const normals = new Float32Array(totalCount * 3)
  const colors = new Float32Array(totalCount * 3)
  const carKinds = new Float32Array(totalCount)

  const palette: Array<readonly [number, number, number]> = [
    [0.9, 0.2, 0.2], // 經典碰碰車（紅）
    [0.8, 0.6, 0.2], // 木魚車（木色）
    [0.2, 0.5, 0.9], // 跑車（藍）
    [0.9, 0.5, 0.1], // 風火輪（橙）
  ]

  for (let k = 0; k < 4; k++) {
    const offset = k * count
    const [cr, cg, cb] = palette[k] as readonly [number, number, number]
    for (let i = 0; i < count; i++) {
      const idx = offset + i
      positions[idx * 3] = pos.getX(i)
      positions[idx * 3 + 1] = pos.getY(i)
      positions[idx * 3 + 2] = pos.getZ(i)

      normals[idx * 3] = norm.getX(i)
      normals[idx * 3 + 1] = norm.getY(i)
      normals[idx * 3 + 2] = norm.getZ(i)

      colors[idx * 3] = cr
      colors[idx * 3 + 1] = cg
      colors[idx * 3 + 2] = cb

      carKinds[idx] = k
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setAttribute('carKind', new THREE.BufferAttribute(carKinds, 1))
  box.dispose()
  return geo
}

export class CarFleet {
  private mesh: THREE.InstancedMesh
  private kindAttr: THREE.InstancedBufferAttribute
  private opacityAttr: THREE.InstancedBufferAttribute
  private dummy = new THREE.Object3D()
  private tracker: ResourceTracker
  private loaded = false
  private disposed = false

  constructor(parent: THREE.Object3D, tracker: ResourceTracker) {
    this.tracker = tracker

    // 備用方塊幾何：四種車型各自帶 carKind (0..3) 與辨識顏色，避免著色器收合消失
    const fallbackGeo = tracker.track(createFallbackGeometry())

    const mat = tracker.trackMaterial(
      new THREE.MeshStandardMaterial({
        roughness: 0.5,
        metalness: 0.1,
        vertexColors: true,
      }),
    )
    patchCarMaterial(mat)

    const depthMat = tracker.trackMaterial(
      new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
      }),
    )
    patchCarMaterial(depthMat)

    const kindArray = new Float32Array(CAR_CAPACITY)
    const opacityArray = new Float32Array(CAR_CAPACITY).fill(1)
    this.kindAttr = new THREE.InstancedBufferAttribute(kindArray, 1)
    this.opacityAttr = new THREE.InstancedBufferAttribute(opacityArray, 1)

    fallbackGeo.setAttribute('kindId', this.kindAttr)
    fallbackGeo.setAttribute('opacity', this.opacityAttr)

    this.mesh = new THREE.InstancedMesh(fallbackGeo, mat, CAR_CAPACITY)
    this.mesh.customDepthMaterial = depthMat
    this.mesh.castShadow = true
    this.mesh.receiveShadow = false
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    // 車散布整個庭院，實例位置每幀在變；InstancedMesh 的包圍球只算一次，不關掉會被誤剔除。
    this.mesh.frustumCulled = false

    // 初始化所有實例矩陣為縮放 0
    for (let i = 0; i < CAR_CAPACITY; i++) {
      this.dummy.scale.set(0, 0, 0)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true

    parent.add(this.mesh)
  }

  async load(): Promise<void> {
    if (this.loaded || this.disposed) return
    try {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
      const baseUrl = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : '/'
      const url = `${baseUrl}models/cars.glb?v=${CAR_MODEL_VERSION}`

      const gltf = await new Promise<any>((resolve, reject) => {
        new GLTFLoader().load(url, resolve, undefined, reject)
      })

      if (this.disposed) return

      const loadedMesh = gltf.scene.getObjectByName('cars') as THREE.Mesh | undefined
      if (!loadedMesh || !loadedMesh.geometry) {
        console.warn('cars.glb 缺少 cars 幾何體')
        return
      }

      const geo = loadedMesh.geometry
      if (this.disposed) {
        geo.dispose()
        return
      }

      const kindAttr = geo.getAttribute('_kind')
      if (kindAttr) {
        geo.setAttribute('carKind', kindAttr)
        geo.deleteAttribute('_kind')
      }

      this.tracker.track(geo)
      geo.setAttribute('kindId', this.kindAttr)
      geo.setAttribute('opacity', this.opacityAttr)

      this.mesh.geometry = geo
      this.loaded = true
    } catch (err) {
      console.warn('載入碰碰車模型失敗，維持使用方塊替代幾何：', err)
    }
  }

  sync(
    cars: Iterable<{ kind: number; x: number; z: number; heading: number; opacity: number }>,
    _t: number,
  ): void {
    let count = 0
    const kindArr = this.kindAttr.array as Float32Array
    const opacityArr = this.opacityAttr.array as Float32Array

    for (const c of cars) {
      if (count >= CAR_CAPACITY) break
      this.dummy.position.set(c.x, 0, c.z)
      this.dummy.rotation.set(0, c.heading, 0)
      this.dummy.scale.set(1, 1, 1)
      this.dummy.updateMatrix()

      this.mesh.setMatrixAt(count, this.dummy.matrix)
      kindArr[count] = c.kind
      opacityArr[count] = Math.max(0, Math.min(1, c.opacity))
      count++
    }

    for (let i = count; i < CAR_CAPACITY; i++) {
      this.dummy.scale.set(0, 0, 0)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
      opacityArr[i] = 0
    }

    this.mesh.instanceMatrix.needsUpdate = true
    this.kindAttr.needsUpdate = true
    this.opacityAttr.needsUpdate = true
    this.mesh.count = count
  }

  get visible(): boolean {
    return this.mesh.visible
  }

  set visible(v: boolean) {
    this.mesh.visible = v
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mesh.removeFromParent()
  }
}
