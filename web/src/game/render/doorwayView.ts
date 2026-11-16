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
 * 沒有承接面的直立物（樹、鐘亭）會略為滑動。整片是一個 MeshBasicMaterial（alphaTest）、一個 draw call，
 * 只有從門洞看得到的像素會通過深度測試。
 *
 * 貼圖分上下兩層：上層（第 0 層）是拿掉香爐與石燈籠拍的「底圖」，給地面與半球；下層（第 1 層）是含它們的畫面，
 * alpha 只在它們身上為 1，給它們的直立片。若直立片與地面共用同一張圖，鏡頭一離開擷取點，地面上原本被香爐擋住
 * 的那一塊（圖上畫的仍是香爐）就會露出來，加上直立片四周的地面像素，變成「一張香爐的圖片後面又有一個香爐」。
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
export const DOORWAY_VIEW_VERSION = '2'

/** 殿內座標加上這個位移就是庭院座標。 */
export const HALL_TO_COURTYARD: readonly [number, number, number] = [0, 0.8, -18.45]

/**
 * 半景全景圖（等距柱狀投影）：從 eye 朝 facing（+z 或 -z）看，左右 ±lonMax、上下 latMin～latMax。
 * 經度往 +x 為正（facing = -z 時就是看出去的右邊）。
 */
export interface PanoramaView {
  eye: readonly [number, number, number]
  facing: 1 | -1
  lonMax: number
  latMin: number
  latMax: number
  width: number
  height: number
}

export const DOORWAY_VIEW = {
  /** 擷取視點（殿內座標）：玩家在殿中走向殿門時，鏡頭大約在這裡。 */
  eye: [0, 2.6, 2] as const,
  facing: 1 as const,
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

/** 一點在全景圖上的 UV（u 沿經度、v 向下，v=0 是圖的最上排）。範圍外不截斷，交給貼圖 clamp。 */
export function panoramaUv(v: PanoramaView, x: number, y: number, z: number): [number, number] {
  const [ex, ey, ez] = v.eye
  const dx = x - ex
  const dy = y - ey
  const dz = (z - ez) * v.facing
  const lon = Math.atan2(dx, dz)
  const lat = Math.atan2(dy, Math.hypot(dx, dz))
  return [0.5 + lon / (2 * v.lonMax), (v.latMax - lat) / (v.latMax - v.latMin)]
}

/**
 * 兩層貼圖：一張圖上下疊兩張同尺寸的全景圖（第 0 層在上，v=0 是圖的最上排）。v 先截在 [0, 1] 再放進該層，
 * 離層的上下緣留 2 個 texel，雙線性取樣與 mipmap 不會混到另一層（超出範圍的方向本來就取邊緣值）。
 */
export function toLayer(v: number, layer: 0 | 1, layerHeight: number): number {
  const margin = 2 / (layerHeight * 2)
  const t = (layer + Math.min(1, Math.max(0, v))) / 2
  return Math.min(layer * 0.5 + 0.5 - margin, Math.max(layer * 0.5 + margin, t))
}

/** 殿內座標的一點在門外景全景圖上的 UV。 */
export function doorwayViewUv(x: number, y: number, z: number): [number, number] {
  return panoramaUv(DOORWAY_VIEW, x, y, z)
}

/** 代理地面的高度：台基頂 0、階梯處斜坡、其餘是庭院地面。 */
function proxyGroundY(x: number, z: number): number {
  const ax = Math.abs(x)
  if (ax > TERRACE_HALF_W) return GROUND_Y
  if (z <= TERRACE_EDGE_Z) return 0
  if (ax <= STEPS_HALF_W && z <= STEPS_END_Z) return (GROUND_Y * (z - TERRACE_EDGE_Z)) / (STEPS_END_Z - TERRACE_EDGE_Z)
  return GROUND_Y
}

/** 寫入 UV：view 的全景圖放在兩層貼圖的第 layer 層。clampZ 有值時，z 大於它的頂點改以 z=clampZ 計算。 */
function setViewUv(g: THREE.BufferGeometry, view: PanoramaView, layer: 0 | 1, clampZ = Infinity): THREE.BufferGeometry {
  const p = g.attributes.position!
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    const [u, v] = panoramaUv(view, p.getX(i), p.getY(i), Math.min(p.getZ(i), clampZ))
    uv[i * 2] = u
    uv[i * 2 + 1] = toLayer(v, layer, view.height)
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

/** 門外景直立片的範圍（殿內座標）：香爐（含石座與常駐的香）與四座石燈籠。擷取底圖時拿掉的也是這些範圍內的物件。 */
export const DOORWAY_CARDS: ReadonlyArray<{ x: number; z: number; halfWidth: number; height: number }> = [
  { x: CENSER.x, z: CENSER.z - HALL_TO_COURTYARD[2], halfWidth: 1.0, height: 2.3 },
  ...LANTERNS.map((l) => ({ x: l.x, z: l.z - HALL_TO_COURTYARD[2], halfWidth: 0.5, height: 2.1 })),
]

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
  // 否則它們會被投影成地上拉長的影子，鏡頭一動就滑開。直立片取下層（只有物件本身不透明），其餘取上層的底圖。
  const cards = DOORWAY_CARDS.map((c) => {
    const g = new THREE.PlaneGeometry(c.halfWidth * 2, c.height, 2, 2)
    g.rotateY(Math.atan2(-c.x, DOOR_OUTER_Z - c.z))
    g.translate(c.x, GROUND_Y + c.height / 2, c.z)
    return g
  })

  // 半球：球心在殿門外緣的地面，只取前方（z ≥ 球心）上半
  const dome = new THREE.SphereGeometry(DOME_RADIUS, 32, 12, 0, Math.PI, 0, Math.PI / 2)
  dome.translate(0, GROUND_Y, DOOR_OUTER_Z)

  const prepare = (g: THREE.BufferGeometry, layer: 0 | 1) => {
    const n = g.index ? g.toNonIndexed() : g.clone()
    for (const name of Object.keys(n.attributes)) if (name !== 'position') n.deleteAttribute(name)
    return setViewUv(n, DOORWAY_VIEW, layer)
  }
  const background = [ground, dome].map((g) => prepare(g, 0))
  const cardParts = cards.map((g) => prepare(g, 1))
  const merged = mergeGeometries([...background, ...cardParts], false)!
  // group 0：地面與半球（底圖），group 1：直立片（單一材質繪製時 group 不影響 draw call，給測試與除錯辨識）
  const backgroundCount = background.reduce((n, g) => n + g.attributes.position!.count, 0)
  merged.addGroup(0, backgroundCount, 0)
  merged.addGroup(backgroundCount, merged.attributes.position!.count - backgroundCount, 1)
  for (const g of [ground, dome, ...cards, ...background, ...cardParts]) g.dispose()
  merged.computeBoundingSphere()
  return merged
}

// ---------- 從庭院看進殿內（殿內景） ----------

/**
 * 庭院主殿正面的殿門：殿內殿門等比縮小 scale 倍，殿內牆外面（z=9.15）對齊主殿正面（庭院 z=-9.3）、
 * 殿內地板對齊台基頂（庭院 y=0.8）。庭院的主殿比殿內小（牆高 3 公尺），門連同橫披窗要收在牆內，所以跟著縮小。
 * 殿內景（下方）也用同一個換算：把殿內縮小後「搬到」主殿正面後面。
 */
export const HALL_FACADE = { scale: 0.62, y: 0.8, z: -9.3 }

/** 殿內座標 → 庭院座標（以殿門為準的等比縮小）。 */
export function hallToFacade(x: number, y: number, z: number): [number, number, number] {
  const k = HALL_FACADE.scale
  return [x * k, HALL_FACADE.y + y * k, HALL_FACADE.z - (DOOR_OUTER_Z - z) * k]
}

/** 庭院座標 → 殿內座標。 */
export function facadeToHall(x: number, y: number, z: number): [number, number, number] {
  const k = HALL_FACADE.scale
  return [x / k, (y - HALL_FACADE.y) / k, DOOR_OUTER_Z - (HALL_FACADE.z - z) / k]
}

/**
 * 殿內景貼圖（public/backdrops/hall_interior.ktx2）的版本：重新擷取後要加一（理由同 DOORWAY_VIEW_VERSION）。
 * 改了殿內的樣子、神像、INTERIOR_FLOOR_VIEW／INTERIOR_BACK_VIEW 或代理房間都要重新擷取。
 */
export const INTERIOR_VIEW_VERSION = '1'

/**
 * 殿內景分兩層、兩個擷取視點（庭院座標）：
 * - 地板層（第 1 層）：從庭院走向殿門時鏡頭的大致位置朝殿內看，給地板、左右牆與天花。鏡頭在高處往下看，
 *   門洞裡大半是地板，這樣地板的解析度與視差都對。
 * - 後牆層（第 0 層）：從低處（約眼睛高度）看，給後牆。同一個視點從高處看，門楣會擋住供桌以上，看不到主佛；
 *   低視點把供桌與主佛（下半身與蓮座）畫在後牆上，像門後掛著一幅殿內的畫，地板與後牆交界兩層都是同一條地板線。
 * 全景圖只涵蓋代理房間從各自視點看出去的範圍，解析度集中在門洞（約 200 像素寬）。
 */
export const INTERIOR_FLOOR_VIEW: PanoramaView = {
  eye: [0, 5, 7],
  facing: -1,
  lonMax: deg(18),
  latMin: deg(-15.5),
  latMax: deg(-3.2),
  width: 1024,
  height: 512,
}
export const INTERIOR_BACK_VIEW: PanoramaView = {
  eye: [0, 2.6, 6],
  facing: -1,
  lonMax: deg(16.5),
  latMin: deg(-6.5),
  latMax: deg(4.5),
  width: 1024,
  height: 512,
}
/** 殿內畫面（未經色調映射）的亮度倍率：從明亮的庭院看進去，室內暗得多。 */
export const INTERIOR_EXPOSURE = 0.26

/**
 * 殿內代理房間（庭院座標）：主殿正面後面的地板、左右牆、後牆與天花，承接殿內景。
 * 都在庭院主殿殿身（z -16.7～-9.3、x ±5.7、y 0.8～3.8）之內，只從門洞看得到。
 * 地板與左右牆對齊縮小後的殿內（地板 y=0、牆 x=±8）；後牆在門後 3 公尺（殿內 z≈4.3），
 * 更深的蒲團、供桌與神像都畫在後牆上（鏡頭離擷取視點越遠，滑動越明顯）。
 * 殿內前排柱（x=±5.2、z=5）在後牆之前、左右牆之內，從門洞只有很斜的角度才看得到，可能被拉成兩半（已知限制）。
 */
export const INTERIOR_ROOM = { halfWidth: 8 * HALL_FACADE.scale, floorY: HALL_FACADE.y + 0.004, ceilingY: 3.74, frontZ: -9.42, backZ: -12.3 }

/** 殿內代理房間的幾何（庭院座標，含 UV）。等距柱狀投影不是線性的，網格切細，UV 的線性內插才不會歪。 */
export function buildInteriorBackdrop(): THREE.BufferGeometry {
  const R = INTERIOR_ROOM
  const parts: THREE.BufferGeometry[] = []
  /** 一片由 origin 沿 a、b 展開的網格。 */
  const grid = (origin: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, na: number, nb: number) => {
    const pos: number[] = []
    const idx: number[] = []
    for (let j = 0; j <= nb; j++) {
      for (let i = 0; i <= na; i++) {
        const p = origin.clone().addScaledVector(a, i / na).addScaledVector(b, j / nb)
        pos.push(p.x, p.y, p.z)
      }
    }
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        const q = j * (na + 1) + i
        idx.push(q, q + 1, q + na + 1, q + 1, q + na + 2, q + na + 1)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    parts.push(g)
  }
  const w = R.halfWidth * 2
  const d = R.frontZ - R.backZ
  const h = R.ceilingY - R.floorY
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  grid(V(-R.halfWidth, R.floorY, R.frontZ), V(w, 0, 0), V(0, 0, -d), 12, 6) // 地板
  grid(V(-R.halfWidth, R.floorY, R.frontZ), V(0, 0, -d), V(0, h, 0), 6, 4) // 左牆
  grid(V(R.halfWidth, R.floorY, R.backZ), V(0, 0, d), V(0, h, 0), 6, 4) // 右牆
  grid(V(-R.halfWidth, R.ceilingY, R.backZ), V(w, 0, 0), V(0, 0, d), 6, 3) // 天花
  const back = parts.length
  grid(V(-R.halfWidth, R.floorY, R.backZ), V(w, 0, 0), V(0, h, 0), 12, 6) // 後牆
  // 擷取時切掉了殿內 z > 8.76（殿門牆、門框、門扇），門檻後面那一小條地板改取 z=8.7 處的畫面，不露出背景色
  const clampZ = hallToFacade(0, 0, 8.7)[2]
  const flat = parts.map((g, i) =>
    i < back ? setViewUv(g.toNonIndexed(), INTERIOR_FLOOR_VIEW, 1, clampZ) : setViewUv(g.toNonIndexed(), INTERIOR_BACK_VIEW, 0),
  )
  const merged = mergeGeometries(flat, false)!
  for (const g of [...parts, ...flat]) g.dispose()
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

/** 兩個擷取共用的片段：全景圖每個像素的方向、sRGB 轉換（抄自 three 的 colorspace chunk）。 */
const CAPTURE_COMMON = /* glsl */ `
uniform float lonMax;
uniform float latMin;
uniform float latMax;
uniform float facing;
varying vec2 vUv;
vec3 panoramaDir() {
  float lon = (vUv.x - 0.5) * 2.0 * lonMax;
  float lat = mix(latMin, latMax, vUv.y);
  return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon) * facing);
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, pow(c, vec3(0.41666)) * 1.055 - 0.055, step(0.0031308, c));
}
`

// ACES 抄自 three 的 tonemapping chunk，讓擷取的圖與遊戲中的庭院一致。
const OUTSIDE_FRAGMENT = /* glsl */ `
uniform samplerCube full;
uniform samplerCube open;
uniform samplerCube skyOnly;
uniform float exposure;
uniform float haze;
${CAPTURE_COMMON}
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
void main() {
  vec3 dir = panoramaDir();
  // 沒有門廊柱的那張有東西就用它；穿過被切掉的台基看到的空洞（地平線以下）用完整那張，地平線以上是天空
  vec4 o = textureCube(open, dir);
  vec3 hdr = o.a > 0.5 ? o.rgb : (dir.y < -0.15 ? textureCube(full, dir).rgb : textureCube(skyOnly, dir).rgb);
  vec3 c = aces(hdr);
  c = mix(c, vec3(1.0, 0.96, 0.88), haze);
  gl_FragColor = vec4(toSrgb(c), 1.0);
}
`

// 殿內不做色調映射（與遊戲中的殿內一致），只乘上亮度倍率。
const INSIDE_FRAGMENT = /* glsl */ `
uniform samplerCube room;
uniform float exposure;
${CAPTURE_COMMON}
void main() {
  vec3 c = clamp(textureCube(room, panoramaDir()).rgb * exposure, 0.0, 1.0);
  gl_FragColor = vec4(toSrgb(c), 1.0);
}
`

/** 從 eye 拍一張 cube map（半精度、線性）。 */
function shootCube(renderer: THREE.WebGLRenderer, scene: THREE.Scene, eye: THREE.Vector3): THREE.WebGLCubeRenderTarget {
  const target = new THREE.WebGLCubeRenderTarget(1024, { type: THREE.HalfFloatType, generateMipmaps: false })
  const camera = new THREE.CubeCamera(0.05, 300, target)
  camera.position.copy(eye)
  scene.add(camera)
  camera.update(renderer, scene)
  scene.remove(camera)
  return target
}

/** 以 fragment 把 cube map 畫成全景圖，讀回 canvas（最上排是 latMax）。 */
function renderPanorama(renderer: THREE.WebGLRenderer, v: PanoramaView, fragment: string, uniforms: Record<string, THREE.IUniform>): HTMLCanvasElement {
  const target = new THREE.WebGLRenderTarget(v.width, v.height, { type: THREE.UnsignedByteType, generateMipmaps: false })
  const material = new THREE.ShaderMaterial({
    vertexShader: CAPTURE_VERTEX,
    fragmentShader: fragment,
    uniforms: {
      ...uniforms,
      lonMax: { value: v.lonMax },
      latMin: { value: v.latMin },
      latMax: { value: v.latMax },
      facing: { value: v.facing },
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
  for (const d of [target, material, quadGeo]) d.dispose()
  return canvas
}

/** 兩張全景圖上下疊成一張兩層貼圖（top 是第 0 層）。 */
function stackLayers(top: HTMLCanvasElement, bottom: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = top.width
  canvas.height = top.height * 2
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(top, 0, 0)
  ctx.drawImage(bottom, 0, top.height)
  return canvas
}

/**
 * 暫時把 root 底下靜態 Mesh 中「三個頂點都落在 boxes 之內」的三角形縮成一點（物件已依材質合併，無法單獨隱藏），
 * 回傳還原函式。只處理非索引幾何（接收烘焙的物件都已轉成非索引）；跨出範圍的三角形不動，不會被拉長。
 */
function collapseInside(root: THREE.Object3D, boxes: ReadonlyArray<THREE.Box3>): () => void {
  root.updateMatrixWorld(true)
  const restore: Array<() => void> = []
  const p = new THREE.Vector3()
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh || o.geometry.index) return
    const attr = o.geometry.attributes.position as THREE.BufferAttribute
    const original = (attr.array as Float32Array).slice()
    let changed = false
    for (let i = 0; i + 2 < attr.count; i += 3) {
      let inside = true
      for (let k = 0; k < 3 && inside; k++) {
        p.fromBufferAttribute(attr, i + k).applyMatrix4(o.matrixWorld)
        inside = boxes.some((b) => b.containsPoint(p))
      }
      if (!inside) continue
      for (let k = 1; k < 3; k++) attr.setXYZ(i + k, attr.getX(i), attr.getY(i), attr.getZ(i))
      changed = true
    }
    if (!changed) return
    attr.needsUpdate = true
    restore.push(() => {
      ;(attr.array as Float32Array).set(original)
      attr.needsUpdate = true
    })
  })
  return () => restore.forEach((f) => f())
}

/**
 * 從庭院場景擷取殿門外景的兩層全景圖（每層左右 ±lonMax、上下 latMin～latMax 的等距柱狀投影）。
 *
 * - 視點是 DOORWAY_VIEW.eye 換算到庭院座標，以裁切平面去掉主殿正面以內的一切（殿身、殿門、殿內景），只留門外的景。
 * - 前排門廊柱離殿門不到 1 公尺，投影到遠處的代理幾何上會隨鏡頭滑動而穿幫，所以每層拍兩次：
 *   A 只切到殿門前（含門廊柱與柱間的台基地面），B 切到門廊柱、門廊樑與匾額之前（沒有柱子，天空隱藏、背景透明）；
 *   合成時 B 有東西的地方用 B，其餘（柱子腳下那一條台基地面）用 A。
 * - 第 0 層（底圖）拍之前把 DOORWAY_CARDS 範圍內的物件（香爐、石燈籠）暫時拿掉；第 1 層是原本的畫面，
 *   alpha 是兩層有差異的像素（就是那些物件本身）。烘焙的影子留在地上（物件本來就在那裡，直立片會補上）。
 * - visible 以外的場景子節點（角色、名牌、動態物件）與庭院裡的香煙 sprite 暫時隱藏。
 * - 回傳畫好的 canvas（寬 width、高 2 × height，第 0 層在上），呼叫端自行存檔。
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
  for (const root of visible) root.traverse((o) => o instanceof THREE.Sprite && o.visible && hidden.push(o))
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
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipZ)]
    sky.visible = mode !== 'geometry'
    for (const o of visible) if (o !== sky && !(o instanceof THREE.Light)) o.visible = mode !== 'sky'
    if (mode === 'geometry') {
      scene.background = null
      renderer.setClearColor(0x000000, 0)
    }
    const target = shootCube(renderer, scene, eye)
    scene.background = prevBackground
    renderer.setClearColor(prevClearColor, prevClearAlpha)
    sky.visible = true
    for (const o of visible) o.visible = true
    return target
  }
  // 主殿正面在 z=-9.3；殿門的門框與門檻凸出到 z≈-9.18，切在 -9.19（門檻前緣那一條被殿內的門檻擋住）
  const doorClip = DOOR_OUTER_Z + HALL_TO_COURTYARD[2] + 0.11
  const skyOnly = shoot(doorClip, 'sky')
  const layer = () => {
    const full = shoot(doorClip, 'all')
    // 門廊柱在 z=-8.6、半徑 0.21，門廊樑前緣在 z=-8.2，掛在樑上的匾額前緣在 z≈-8.13
    const open = shoot(-8.08, 'geometry')
    const canvas = renderPanorama(renderer, v, OUTSIDE_FRAGMENT, {
      full: { value: full.texture },
      open: { value: open.texture },
      skyOnly: { value: skyOnly.texture },
      exposure: { value: v.exposure },
      haze: { value: v.haze },
    })
    full.dispose()
    open.dispose()
    return canvas
  }
  const withObjects = layer()
  const boxes = DOORWAY_CARDS.map((c) => {
    const [x, y, z] = [c.x + HALL_TO_COURTYARD[0], HALL_TO_COURTYARD[1] + GROUND_Y, c.z + HALL_TO_COURTYARD[2]]
    return new THREE.Box3(new THREE.Vector3(x - c.halfWidth, y - 0.01, z - c.halfWidth), new THREE.Vector3(x + c.halfWidth, y + c.height, z + c.halfWidth))
  })
  const restore = visible.map((root) => collapseInside(root, boxes))
  const clean = layer()
  restore.forEach((f) => f())

  renderer.clippingPlanes = prevClip
  renderer.localClippingEnabled = prevLocalClipping
  for (const mat of roofMaterials) {
    mat.clippingPlanes = null
    mat.needsUpdate = true
  }
  for (const o of hidden) o.visible = true
  skyOnly.dispose()

  // 第 1 層的 alpha：與底圖不同的像素（就是被拿掉的物件）
  const ctx = withObjects.getContext('2d')!
  const a = ctx.getImageData(0, 0, v.width, v.height)
  const b = clean.getContext('2d')!.getImageData(0, 0, v.width, v.height).data
  for (let i = 0; i < a.data.length; i += 4) {
    const diff = Math.abs(a.data[i]! - b[i]!) + Math.abs(a.data[i + 1]! - b[i + 1]!) + Math.abs(a.data[i + 2]! - b[i + 2]!)
    a.data[i + 3] = diff > 6 ? 255 : 0
  }
  ctx.putImageData(a, 0, 0)
  return stackLayers(clean, withObjects)
}

/**
 * 從殿內場景擷取殿內景的兩層全景圖：兩個視點（INTERIOR_BACK_VIEW、INTERIOR_FLOOR_VIEW）換算回殿內座標
 * （殿門外 24～26 公尺），以裁切平面去掉殿門牆以外的一切（殿門牆、門框、推開貼牆的門扇、門外景），
 * 等於隔著拿掉的前牆看殿內。霧關掉（視點在殿外，距離比平常遠）。visible 以外的場景子節點（角色、名牌）暫時隱藏；
 * hiddenInHall 是殿內場景中要一併隱藏的物件（門口的光束與門外景）。
 * 呼叫時殿內場景與燈光（HALL_ENV）須已生效、神像已載入。回傳寬 1024、高 2 × 512 的 canvas（後牆層在上）。
 */
export function captureInteriorView(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  visible: ReadonlyArray<THREE.Object3D>,
  hiddenInHall: ReadonlyArray<THREE.Object3D>,
): HTMLCanvasElement {
  const hidden = [...scene.children.filter((o) => o.visible && !visible.includes(o)), ...hiddenInHall.filter((o) => o.visible)]
  for (const o of hidden) o.visible = false
  const prevFog = scene.fog
  scene.fog = null
  const prevClip = renderer.clippingPlanes
  // 保留 z ≤ 8.76（門扇正面在 8.77、殿門牆內面在 8.85）
  renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 8.76)]
  const layer = (v: PanoramaView) => {
    const room = shootCube(renderer, scene, new THREE.Vector3(...facadeToHall(...v.eye)))
    const canvas = renderPanorama(renderer, v, INSIDE_FRAGMENT, { room: { value: room.texture }, exposure: { value: INTERIOR_EXPOSURE } })
    room.dispose()
    return canvas
  }
  const back = layer(INTERIOR_BACK_VIEW)
  const floor = layer(INTERIOR_FLOOR_VIEW)
  renderer.clippingPlanes = prevClip
  scene.fog = prevFog
  for (const o of hidden) o.visible = true
  return stackLayers(back, floor)
}
