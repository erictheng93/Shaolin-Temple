import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CENSER, LANTERNS } from '../world/layout'

/**
 * 殿門外景：從殿內看出殿門的庭院日光景色。
 *
 * 作法（相機投影＋代理幾何）：離線從庭院場景擷取一張半景全景圖（`npm run capture:doorway`，見
 * scripts/capture-doorway.mjs），在殿門外用幾片粗略的「代理幾何」（台基地面、階梯斜面、庭院地面、
 * 香爐與石燈籠的直立片、包住一切的半球）承接它，每個頂點的 UV 由「擷取視點 → 頂點」的方向算出。
 * 從擷取視點看完全正確；鏡頭在殿內移動時，落在代理幾何上的東西（地面、遠景）視差大致正確，
 * 沒有承接面的直立物（樹、鐘亭）會略為滑動。整片是一個 MeshBasicMaterial、一個 draw call，
 * 只有從門洞看得到的像素會通過深度測試。
 *
 * 座標：殿內與庭院方向相同（殿門朝 +z），殿內地板 y=0 對齊主殿台基頂（庭院 y=0.8），
 * 殿門外緣（殿內 z=9.15）對齊庭院主殿正面（z=-9.3）。殿內比庭院看到的主殿外觀大，兩者本來就不一致，
 * 這裡只對齊門口附近。
 */

const deg = THREE.MathUtils.degToRad

/**
 * 門外景貼圖（public/backdrops/hall_doorway.ktx2）的版本：重新擷取後要加一。public/ 的檔案沒有雜湊，
 * 網址帶版本才不會拿到快取的舊圖。改了 DOORWAY_VIEW 或代理幾何也要重新擷取（UV 跟著變）。
 */
export const DOORWAY_VIEW_VERSION = '1'

/** 殿內座標加上這個位移就是庭院座標。 */
export const HALL_TO_COURTYARD: readonly [number, number, number] = [0, 0.8, -18.45]

export const DOORWAY_VIEW = {
  /** 擷取視點（殿內座標）：玩家在殿中走向殿門時，鏡頭大約在這裡。 */
  eye: [0, 2.6, 2] as const,
  /** 全景圖涵蓋的經度（左右）與緯度範圍；超出的方向取邊緣的顏色（貼圖 clamp）。 */
  lonMax: deg(62),
  latMin: deg(-24),
  latMax: deg(36),
  width: 1024,
  height: 512,
  /** 擷取時庭院的曝光（平常 0.6）：室內看出去略為過曝。 */
  exposure: 0.95,
  /** 擷取時混入的暖白霧氣比例，表現亮處溢光。 */
  haze: 0.05,
}

/** 殿門外緣（殿內座標）。 */
const DOOR_OUTER_Z = 9.15
/** 代理半球的半徑：大致是殿門到山門圍牆的距離。 */
const DOME_RADIUS = 30
/** 庭院地面在殿內座標的高度（台基高 0.8）。 */
const GROUND_Y = -0.8
/** 台基前緣、階梯底（殿內座標）、台基半寬與階梯半寬，取自 TempleScene。 */
const TERRACE_EDGE_Z = -8 - HALL_TO_COURTYARD[2]
const STEPS_END_Z = -6.2 - HALL_TO_COURTYARD[2]
const TERRACE_HALF_W = 7.5
const STEPS_HALF_W = 3

/** 殿內座標的一點在全景圖上的 UV（u 向右、v 向下，v=0 是圖的最上排）。範圍外不截斷，交給貼圖 clamp。 */
export function doorwayViewUv(x: number, y: number, z: number): [number, number] {
  const [ex, ey, ez] = DOORWAY_VIEW.eye
  const dx = x - ex
  const dy = y - ey
  const dz = z - ez
  const lon = Math.atan2(dx, dz)
  const lat = Math.atan2(dy, Math.hypot(dx, dz))
  const v = DOORWAY_VIEW
  return [0.5 + lon / (2 * v.lonMax), (v.latMax - lat) / (v.latMax - v.latMin)]
}

/** 代理地面的高度：台基頂 0、階梯處斜坡、其餘是庭院地面。 */
function proxyGroundY(x: number, z: number): number {
  const ax = Math.abs(x)
  if (ax > TERRACE_HALF_W) return GROUND_Y
  if (z <= TERRACE_EDGE_Z) return 0
  if (ax <= STEPS_HALF_W && z <= STEPS_END_Z) return (GROUND_Y * (z - TERRACE_EDGE_Z)) / (STEPS_END_Z - TERRACE_EDGE_Z)
  return GROUND_Y
}

function setViewUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.attributes.position!
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    const [u, v] = doorwayViewUv(p.getX(i), p.getY(i), p.getZ(i))
    uv[i * 2] = u
    uv[i * 2 + 1] = v
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

/**
 * 殿門外的代理幾何（殿內座標，含 UV）：地面網格（台基、階梯、庭院地面）、香爐的直立片、半球。
 * 網格在門口附近較密，UV 的線性內插才不會歪。正面朝向殿內，材質用 DoubleSide 也無妨（只有門洞的像素）。
 */
export function buildDoorwayBackdrop(): THREE.BufferGeometry {
  const half = [0, 0.5, 1, 1.5, 2, 2.5, STEPS_HALF_W, STEPS_HALF_W + 0.01, 4, 5, 6, TERRACE_HALF_W, TERRACE_HALF_W + 0.01, 9, 11, 14, 18, 23, 31]
  const xs = [...half.slice(1).map((x) => -x).reverse(), ...half]
  const zs = [DOOR_OUTER_Z, 9.6, 10, TERRACE_EDGE_Z, TERRACE_EDGE_Z + 0.01, 11, 11.6, STEPS_END_Z, 13, 14, 15.5, 17, 19, 21.5, 24.5, 28, 32, 36, 40]
  const pos: number[] = []
  for (const z of zs) for (const x of xs) pos.push(x, proxyGroundY(x, z), z)
  const index: number[] = []
  const nx = xs.length
  for (let j = 0; j < zs.length - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      const b = a + 1
      const c = a + nx
      const d = c + 1
      // 從上方（+y）看是逆時針
      index.push(a, c, b, b, c, d)
    }
  }
  const ground = new THREE.BufferGeometry()
  ground.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  ground.setIndex(index)

  // 香爐（庭院中軸上、殿門外約 8 公尺）與石燈籠是門洞裡最顯眼的直立物：各給一片面向殿門的直立承接面，
  // 否則它們會被投影成地上拉長的影子，鏡頭一動就滑開
  const card = (x: number, z: number, w: number, h: number) => {
    const g = new THREE.PlaneGeometry(w, h, 2, 2)
    g.rotateY(Math.atan2(-x, DOOR_OUTER_Z - z))
    g.translate(x, GROUND_Y + h / 2, z)
    return g
  }
  const cards = [
    card(CENSER.x, CENSER.z - HALL_TO_COURTYARD[2], 1.8, 2.0),
    ...LANTERNS.map((l) => card(l.x, l.z - HALL_TO_COURTYARD[2], 0.9, 1.8)),
  ]

  // 半球：球心在殿門外緣的地面，只取前方（z ≥ 球心）上半
  const dome = new THREE.SphereGeometry(DOME_RADIUS, 32, 12, 0, Math.PI, 0, Math.PI / 2)
  dome.translate(0, GROUND_Y, DOOR_OUTER_Z)

  const sources = [ground, ...cards, dome]
  const parts = sources.map((g) => {
    const n = g.index ? g.toNonIndexed() : g
    for (const name of Object.keys(n.attributes)) if (name !== 'position') n.deleteAttribute(name)
    return setViewUv(n)
  })
  const merged = mergeGeometries(parts, false)!
  for (const g of [...sources, ...parts]) g.dispose()
  merged.computeBoundingSphere()
  return merged
}

// ---------- 離線擷取（只給 scripts/capture-doorway.mjs 在開發伺服器上呼叫，遊戲不會用到） ----------

const CAPTURE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// ACES 與 sRGB 轉換抄自 three 的 tonemapping／colorspace chunk，讓擷取的圖與遊戲中的庭院一致。
const CAPTURE_FRAGMENT = /* glsl */ `
uniform samplerCube full;
uniform samplerCube open;
uniform samplerCube skyOnly;
uniform float lonMax;
uniform float latMin;
uniform float latMax;
uniform float exposure;
uniform float haze;
varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 inputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= exposure / 0.6;
  color = outputMat * RRTAndODTFit(inputMat * color);
  return clamp(color, 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, pow(c, vec3(0.41666)) * 1.055 - 0.055, step(0.0031308, c));
}
void main() {
  float lon = (vUv.x - 0.5) * 2.0 * lonMax;
  float lat = mix(latMin, latMax, vUv.y);
  vec3 dir = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  // 沒有門廊柱的那張有東西就用它；穿過被切掉的台基看到的空洞（地平線以下）用完整那張，地平線以上是天空
  vec4 o = textureCube(open, dir);
  vec3 hdr = o.a > 0.5 ? o.rgb : (dir.y < -0.15 ? textureCube(full, dir).rgb : textureCube(skyOnly, dir).rgb);
  vec3 c = aces(hdr);
  c = mix(c, vec3(1.0, 0.96, 0.88), haze);
  gl_FragColor = vec4(toSrgb(c), 1.0);
}
`

/**
 * 從庭院場景擷取殿門外景的全景圖（左右 ±lonMax、上下 latMin～latMax 的等距柱狀投影）。
 *
 * - 視點是 DOORWAY_VIEW.eye 換算到庭院座標，以裁切平面去掉主殿正面以內的一切（殿身、門板），只留門外的景。
 * - 前排門廊柱離殿門不到 1 公尺，投影到遠處的代理幾何上會隨鏡頭滑動而穿幫，所以拍兩次：
 *   A 只切到門板前（含門廊柱與柱間的台基地面），B 切到門廊柱之前（沒有柱子，天空隱藏、背景透明）；
 *   合成時 B 有東西的地方用 B，其餘（柱子腳下那一條台基地面）用 A。
 * - visible 以外的場景子節點（角色、名牌、動態物件）暫時隱藏。
 * - 回傳畫好的 canvas（最上排是 latMax），呼叫端自行存檔。
 */
export function captureDoorwayView(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  visible: ReadonlyArray<THREE.Object3D>,
  sky: THREE.Object3D,
  roofMaterials: ReadonlyArray<THREE.Material>,
): HTMLCanvasElement {
  const v = DOORWAY_VIEW
  const hidden = scene.children.filter((o) => o.visible && !visible.includes(o) && o !== sky)
  for (const o of hidden) o.visible = false
  // 主殿的屋簷（前緣在庭院 z=-6.8）在門洞上緣會變成一片懸空的瓦面，也切掉；鐘亭屋頂從 z=-6.7 開始，不受影響
  const prevLocalClipping = renderer.localClippingEnabled
  renderer.localClippingEnabled = true
  const eavePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 6.75)
  for (const mat of roofMaterials) {
    mat.clippingPlanes = [eavePlane]
    mat.needsUpdate = true
  }

  const eye = new THREE.Vector3(v.eye[0] + HALL_TO_COURTYARD[0], v.eye[1] + HALL_TO_COURTYARD[1], v.eye[2] + HALL_TO_COURTYARD[2])
  const prevClip = renderer.clippingPlanes
  const prevBackground = scene.background
  const prevClearColor = renderer.getClearColor(new THREE.Color())
  const prevClearAlpha = renderer.getClearAlpha()
  const shoot = (clipZ: number, mode: 'all' | 'geometry' | 'sky') => {
    const target = new THREE.WebGLCubeRenderTarget(1024, { type: THREE.HalfFloatType, generateMipmaps: false })
    const camera = new THREE.CubeCamera(0.05, 300, target)
    camera.position.copy(eye)
    scene.add(camera)
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipZ)]
    sky.visible = mode !== 'geometry'
    for (const o of visible) if (o !== sky && !(o instanceof THREE.Light)) o.visible = mode !== 'sky'
    if (mode === 'geometry') {
      scene.background = null
      renderer.setClearColor(0x000000, 0)
    }
    camera.update(renderer, scene)
    scene.remove(camera)
    scene.background = prevBackground
    renderer.setClearColor(prevClearColor, prevClearAlpha)
    sky.visible = true
    for (const o of visible) o.visible = true
    return target
  }
  // 庭院的門板正面在 z=-9.25
  const full = shoot(DOOR_OUTER_Z + HALL_TO_COURTYARD[2] + 0.11, 'all')
  // 門廊柱在 z=-8.6、半徑 0.21，門廊樑前緣在 z=-8.2
  const open = shoot(-8.15, 'geometry')
  const skyOnly = shoot(DOOR_OUTER_Z + HALL_TO_COURTYARD[2] + 0.11, 'sky')
  renderer.clippingPlanes = prevClip
  renderer.localClippingEnabled = prevLocalClipping
  for (const mat of roofMaterials) {
    mat.clippingPlanes = null
    mat.needsUpdate = true
  }
  for (const o of hidden) o.visible = true

  const target = new THREE.WebGLRenderTarget(v.width, v.height, { type: THREE.UnsignedByteType, generateMipmaps: false })
  const material = new THREE.ShaderMaterial({
    vertexShader: CAPTURE_VERTEX,
    fragmentShader: CAPTURE_FRAGMENT,
    uniforms: {
      full: { value: full.texture },
      open: { value: open.texture },
      skyOnly: { value: skyOnly.texture },
      lonMax: { value: v.lonMax },
      latMin: { value: v.latMin },
      latMax: { value: v.latMax },
      exposure: { value: v.exposure },
      haze: { value: v.haze },
    },
    depthTest: false,
    depthWrite: false,
  })
  const quadGeo = new THREE.PlaneGeometry(2, 2)
  const quad = new THREE.Mesh(quadGeo, material)
  quad.frustumCulled = false
  const quadScene = new THREE.Scene()
  quadScene.add(quad)
  const prevTarget = renderer.getRenderTarget()
  renderer.setRenderTarget(target)
  renderer.render(quadScene, new THREE.Camera())
  const pixels = new Uint8Array(v.width * v.height * 4)
  renderer.readRenderTargetPixels(target, 0, 0, v.width, v.height, pixels)
  renderer.setRenderTarget(prevTarget)

  const canvas = document.createElement('canvas')
  canvas.width = v.width
  canvas.height = v.height
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(v.width, v.height)
  const row = v.width * 4
  // render target 第 0 列是最下排（latMin）；圖檔最上排要是 latMax
  for (let y = 0; y < v.height; y++) image.data.set(pixels.subarray((v.height - 1 - y) * row, (v.height - y) * row), y * row)
  ctx.putImageData(image, 0, 0)

  for (const d of [full, open, skyOnly, target, material, quadGeo]) d.dispose()
  return canvas
}
