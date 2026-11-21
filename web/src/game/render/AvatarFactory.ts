import * as THREE from 'three'
import { MALLET_HEAD_Z, WOODFISH_FORWARD, WOODFISH_STRIKE_Y, createChantPropsGeometry, patchChantPropsMaterial } from './chantProps'
import { createIncenseStickGeometry } from './IncenseSystem'
import { Nameplate } from './Nameplate'
import { ResourceTracker } from './ResourceTracker'
import { OUTFITS, normalizeOutfit } from '../world/outfits'

/** 角色節點結構，動畫片段只操作這些節點。節點本身不含網格，只提供變換。 */
export interface AvatarRig {
  /** 位置與面向。 */
  root: THREE.Group
  /** 腰部樞紐：鞠躬、呼吸等動作旋轉這裡。 */
  pivot: THREE.Group
  head: THREE.Group
  /** 表情（FACE_* 常數）。AnimationSystem 每幀重設為平常的臉，動作片段可以改。 */
  face: number
  /** 手上拿的東西（PROP_* 常數）。與 face 相同，每幀重設為 PROP_NONE，動作片段可以改。 */
  prop: number
  /** 手上道具的抬起角度（弧度，0 為放下；誦經時是木魚槌抬離木魚的角度）。每幀重設為 0。 */
  propAngle: number
}

/** 平常的臉：豆豆眼。 */
export const FACE_CALM = 0
/** 瞇瞇笑眼：合十時。 */
export const FACE_SMILE = 1

/** 手上沒有東西。 */
export const PROP_NONE = 0
/** 合十的雙手間拿著一支香（上香時）。 */
export const PROP_INCENSE = 1
/** 誦經：身前地上一個木魚，合十的手握著木魚槌（槌頭指向木魚，依 propAngle 抬起）。 */
export const PROP_CHANT = 2
/** 握槌的位置：合十的手（剛體座標，與手上的香相同的高度）。 */
const MALLET_GRIP = new THREE.Vector3(0, 0.53, 0.21)
/** 槌頭敲到木魚時的位置（角色根節點座標）：木魚頂端加槌頭半徑。 */
const MALLET_TARGET = new THREE.Vector3(0, WOODFISH_STRIKE_Y, WOODFISH_FORWARD)
const WOODFISH_POSE = new THREE.Matrix4().makeTranslation(0, 0, WOODFISH_FORWARD)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)
/**
 * 手上的香相對腳底的姿勢（隨頭與手一起做剛體運動）：從合十的手（y 0.535、z 0.19）往上、
 * 向前傾 0.5 弧度，避免穿過臉（臉的正面在 z 約 0.235）；長 0.42、半徑 0.007。
 */
const HELD_INCENSE = new THREE.Matrix4().compose(
  new THREE.Vector3(0, 0.5, 0.2),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0)),
  new THREE.Vector3(0.007, 0.42, 0.007),
)

export interface Avatar extends AvatarRig {
  /** 設定或更換頭上的名牌；空字串則不顯示。本機玩家進場時才知道名字。 */
  setName(name: string): void
  setLabelVisible(visible: boolean): void
  /** 頭上顯示對話泡泡直到 until（performance.now 毫秒）；新的取代舊的。文字畫在 canvas 上，不經 HTML。 */
  say(text: string, until: number): void
  /** 過期則收掉泡泡並釋放貼圖；回傳泡泡是否仍顯示（給渲染排程判斷是否需要重繪）。 */
  tickBubble(now: number): boolean
  /** 更換衣裝（衣裝編號，見 world/outfits.ts；無效值當成預設）。下一次 sync() 生效。 */
  setOutfit(outfit: number): void
  /** 釋放此角色獨有的資源（名牌貼圖）並移出批次繪製。 */
  dispose(): void
}

interface AvatarRecord {
  rig: AvatarRig
  shadow: THREE.Object3D
  /** 衣裝編號（OUTFITS 的索引），外觀完全由它決定。 */
  outfit: number
}

/** 臉圖集的格數（橫向排列）。 */
const FACE_COUNT = 2
/** 臉在模型上的範圍（公尺，模型面向 +z）：以 x、y 平面投影成貼圖座標。 */
const FACE_RECT = { x: 0.19, yMin: 0.64, yMax: 1.02, zMin: 0.05 }

/** 畫出臉圖集：每格一種表情（順序同 FACE_* 常數），透明底，只有五官與腮紅。 */
function makeFaceAtlas(): THREE.CanvasTexture {
  const S = 256
  const c = document.createElement('canvas')
  c.width = S * FACE_COUNT
  c.height = S
  const g = c.getContext('2d')!
  const INK = '#3a2a22'
  g.lineCap = 'round'
  const blush = (ox: number, x: number, y: number, rx: number, ry: number, a: number) => {
    const grad = g.createRadialGradient(ox + x, y, 0, ox + x, y, rx)
    grad.addColorStop(0, `rgba(235,120,110,${a})`)
    grad.addColorStop(1, 'rgba(235,120,110,0)')
    g.save()
    g.translate(0, y * (1 - ry / rx))
    g.scale(1, ry / rx)
    g.fillStyle = grad
    g.fillRect(ox + x - rx, y - rx, rx * 2, rx * 2)
    g.restore()
  }
  const EY = 150 // 眼睛高度（畫布座標，往下為正）；偏低顯得稚氣
  // 0：豆豆眼
  {
    const ox = 0
    for (const sx of [-1, 1]) {
      blush(ox, 128 + sx * 68, EY + 30, 30, 18, 0.55)
      g.fillStyle = INK
      g.beginPath()
      g.ellipse(ox + 128 + sx * 46, EY, 9, 11, 0, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = 'rgba(255,255,255,0.9)'
      g.beginPath()
      g.arc(ox + 128 + sx * 46 - 3, EY - 4, 2.6, 0, Math.PI * 2)
      g.fill()
    }
    g.strokeStyle = INK
    g.lineWidth = 4
    g.beginPath()
    g.arc(ox + 128, EY + 22, 10, Math.PI * 0.15, Math.PI * 0.85)
    g.stroke()
  }
  // 1：瞇瞇笑眼
  {
    const ox = S
    g.strokeStyle = INK
    for (const sx of [-1, 1]) {
      blush(ox, 128 + sx * 66, EY + 26, 32, 20, 0.6)
      g.lineWidth = 5.5
      g.beginPath()
      g.arc(ox + 128 + sx * 46, EY + 8, 17, Math.PI * 1.15, Math.PI * 1.85)
      g.stroke()
    }
    // ω 嘴
    g.lineWidth = 4
    g.beginPath()
    g.arc(ox + 128 - 8, EY + 26, 8, 0, Math.PI)
    g.stroke()
    g.beginPath()
    g.arc(ox + 128 + 8, EY + 26, 8, 0, Math.PI)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/**
 * 從膚色網格取出臉部正面的三角形，貼圖座標由 x、y 平面投影而來；臉因此貼合頭的實際曲面。
 * 近處與遠處的膚色幾何各呼叫一次。實測遠處（monk-lod.glb）取到 24 個三角形，UV 涵蓋 u 0.07～0.93、v 0.095～0.895，
 * 五官所在的中央 70% 範圍有 99% 被涵蓋，只缺四個角落，所以兩者用同一個「三個頂點都在範圍內」的條件即可。
 * 只取皮膚（skinPart 為 SKIN_PART.skin）的三角形：斗笠的帽沿也落在這個範圍裡，不可算進臉。
 */
export function makeFaceGeometry(skin: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = skin.getAttribute('position')
  const nor = skin.getAttribute('normal')
  const part = skin.getAttribute('skinPart') as THREE.BufferAttribute | undefined
  const index = skin.getIndex()!
  const R = FACE_RECT
  const inside = (i: number) =>
    (!part || part.getX(i) === SKIN_PART.skin) &&
    Math.abs(pos.getX(i)) <= R.x &&
    pos.getY(i) >= R.yMin &&
    pos.getY(i) <= R.yMax &&
    pos.getZ(i) >= R.zMin
  const p: number[] = []
  const n: number[] = []
  const uv: number[] = []
  for (let t = 0; t < index.count; t += 3) {
    const tri = [index.getX(t), index.getX(t + 1), index.getX(t + 2)]
    if (!tri.every(inside)) continue
    for (const i of tri) {
      p.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      n.push(nor.getX(i), nor.getY(i), nor.getZ(i))
      uv.push((pos.getX(i) + R.x) / (R.x * 2), (pos.getY(i) - R.yMin) / (R.yMax - R.yMin))
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return geo
}

/** 袈裟披帶的半寬（公尺），以模型屬性 _OUTFIT.x（到披帶中線的有號距離）做門檻。 */
const SASH_HALF_WIDTH = 0.058
/** 披帶兩側略深的細邊寬度（公尺）。 */
const SASH_HEM = 0.012
/** 替代用圓柱的 robeField.x：遠離披帶中線，不畫披帶。 */
const NO_SASH = 9

/**
 * 身體的部位（模型屬性 _OUTFIT.y，與 scripts/build-avatar.mjs 的 BODY_PART 相同）。
 * shared 永遠顯示（袖子、鞋）；bead 只在有念珠的衣裝；robe（鐘形的袍與寬袖口）與 tunic 以後的部位（短褂）依衣裝的輪廓二選一。
 */
export const BODY_PART = { shared: 0, bead: 1, robe: 2, tunic: 3, trousers: 4, leggings: 5, belt: 6 } as const
/** 膚色網格的部位（模型屬性 _PART）：皮膚（頭、耳朵、手）與斗笠。 */
export const SKIN_PART = { skin: 0, hat: 1 } as const
/** 不顯示的身體部位縮到這一點（藏在袍裡），三角形退化成不繪製。 */
const BODY_HIDE_POINT = '0.0, 0.5, 0.0'
/** 不戴斗笠時，斗笠的頂點縮到頭的中心。 */
const HAT_HIDE_POINT = '0.0, 0.86, 0.0'
/** 戴斗笠時名牌與對話泡泡升高的量（公尺）：鏡頭抬到俯角約 0.8 弧度時，名牌仍在帽沿之上。 */
const HAT_LABEL_LIFT = 0.08

const linearRgba = (hex: string, a: number) => {
  const c = new THREE.Color(hex) // 轉成線性色彩空間
  return new THREE.Vector4(c.r, c.g, c.b, a)
}

/**
 * 身體的衣裝 uniform 色表（主材質與深度材質共用同一份物件）。
 * outfitRobe：袍（或短褂上衣）色，a = 1 表示輪廓是短褂；outfitSash／outfitBeads：a = 1 表示有披帶／念珠；
 * outfitTunic：每套 3 格（褲、綁腿、腰帶），沒有短褂的衣裝填袍色（不會用到）。
 */
function bodyOutfitUniforms() {
  return {
    outfitRobe: { value: OUTFITS.map((o) => linearRgba(o.robe, o.tunic ? 1 : 0)) },
    outfitSash: { value: OUTFITS.map((o) => linearRgba(o.sash ?? o.robe, o.sash ? 1 : 0)) },
    outfitBeads: { value: OUTFITS.map((o) => linearRgba(o.beads ?? o.robe, o.beads ? 1 : 0)) },
    outfitTunic: {
      value: OUTFITS.flatMap((o) =>
        [o.tunic?.trousers, o.tunic?.leggings, o.tunic?.belt].map((hex) => new THREE.Color(hex ?? o.robe)),
      ),
    },
  }
}
type BodyOutfitUniforms = ReturnType<typeof bodyOutfitUniforms>

/** 身體頂點著色器的共用部分：宣告與「依衣裝收合不顯示的部位」，主材質與陰影的深度材質都用，影子才會跟著衣裝。 */
const BODY_VERTEX_HEAD = (n: number) =>
  `attribute float outfitId;\nattribute vec2 robeField;\nuniform vec4 outfitRobe[${n}];\nuniform vec4 outfitBeads[${n}];\n`
const BODY_VERTEX_HIDE = `
        int outfitK = int(outfitId + 0.5);
        int outfitPart = int(robeField.y + 0.5);
        bool outfitIsTunic = outfitRobe[outfitK].a > 0.5;
        if ((outfitPart == ${BODY_PART.bead} && outfitBeads[outfitK].a < 0.5) ||
            (outfitPart == ${BODY_PART.robe} && outfitIsTunic) ||
            (outfitPart >= ${BODY_PART.tunic} && !outfitIsTunic)) transformed = vec3(${BODY_HIDE_POINT});`

/**
 * 修補身體（袍、鞋、念珠、短褂）的 MeshStandardMaterial：依實例的衣裝編號（outfitId）查 uniform 色表上色。
 * - 部位的底色在頂點著色器決定（袍與袖子、鞋用袍色，念珠、褲、綁腿、腰帶各用自己的色），乘在頂點色上（袖口略深、鞋近黑、綁腿的條紋）。
 * - 袈裟：robeField.x 是到披帶中線的有號距離，片段著色器以 smoothstep（寬度取 fwidth）做門檻，低面數模型邊緣一樣俐落。
 *   只有袍、袖子與鞋（shared、robe）會有披帶；鞋與念珠的 x 遠離中線。
 * - 不顯示的部位（不戴的念珠、另一種輪廓）在頂點著色器縮到一點；陰影用 makeBodyDepthMaterial() 做同樣的事。
 * 近、遠兩個 tier 共用這個材質，程式只有一份。
 */
function patchOutfitMaterial(mat: THREE.MeshStandardMaterial, uniforms: BodyOutfitUniforms): void {
  const n = OUTFITS.length
  const varyings = 'varying vec3 vOutfitBase;\nvarying vec4 vOutfitSash;\nvarying float vOutfitGloss;\nvarying float vSashD;\n'
  const edge = SASH_HALF_WIDTH.toFixed(4)
  const hemEdge = (SASH_HALF_WIDTH - SASH_HEM).toFixed(4)
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader =
      BODY_VERTEX_HEAD(n) +
      `uniform vec4 outfitSash[${n}];\nuniform vec3 outfitTunic[${n * 3}];\n` +
      varyings +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        ${BODY_VERTEX_HIDE}
        vOutfitBase = outfitPart == ${BODY_PART.bead} ? outfitBeads[outfitK].rgb
          : outfitPart >= ${BODY_PART.trousers} ? outfitTunic[outfitK * 3 + outfitPart - ${BODY_PART.trousers}]
          : outfitRobe[outfitK].rgb;
        vOutfitSash = outfitPart <= ${BODY_PART.robe} ? outfitSash[outfitK] : vec4(0.0);
        vOutfitGloss = outfitPart == ${BODY_PART.bead} ? 1.0 : 0.0;
        vSashD = robeField.x;`,
      )
    shader.fragmentShader =
      varyings +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float sashD = abs(vSashD);
            float sashAa = max(fwidth(vSashD), 1e-4);
            float band = vOutfitSash.a * (1.0 - smoothstep(${edge} - sashAa, ${edge} + sashAa, sashD));
            float hem = smoothstep(${hemEdge} - sashAa, ${hemEdge} + sashAa, sashD);
            diffuseColor.rgb *= mix(vOutfitBase, vOutfitSash.rgb * mix(1.0, 0.7, hem), band);
          }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.4, vOutfitGloss);',
        )
  }
  mat.customProgramCacheKey = () => 'avatar-outfit-v2'
}

/** 身體投影用的深度材質：與主材質相同的收合規則，不顯示的部位不投影。 */
function makeBodyDepthMaterial(uniforms: BodyOutfitUniforms): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial()
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outfitRobe = uniforms.outfitRobe
    shader.uniforms.outfitBeads = uniforms.outfitBeads
    shader.vertexShader =
      BODY_VERTEX_HEAD(OUTFITS.length) +
      shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${BODY_VERTEX_HIDE}`)
  }
  mat.customProgramCacheKey = () => 'avatar-outfit-depth-v1'
  return mat
}

/** 斗笠的 uniform 色表：a = 1 表示戴斗笠。主材質與深度材質共用。 */
function skinOutfitUniforms() {
  return { outfitHat: { value: OUTFITS.map((o) => linearRgba(o.hat ?? '#ffffff', o.hat ? 1 : 0)) } }
}
type SkinOutfitUniforms = ReturnType<typeof skinOutfitUniforms>
const SKIN_VERTEX_HEAD = (n: number) => `attribute float outfitId;\nattribute float skinPart;\nuniform vec4 outfitHat[${n}];\n`
const SKIN_VERTEX_HIDE = `
        int outfitK = int(outfitId + 0.5);
        if (skinPart > 0.5 && outfitHat[outfitK].a < 0.5) transformed = vec3(${HAT_HIDE_POINT});`

/**
 * 修補膚色網格（頭、耳朵、手、斗笠）的 MeshStandardMaterial。皮膚的頂點色是 1，外觀與單色材質相同；
 * 斗笠的顏色取衣裝的 hat 色乘上頂點色（竹編的明暗），不戴的衣裝在頂點著色器縮到一點（陰影見 makeSkinDepthMaterial）。
 */
function patchSkinMaterial(mat: THREE.MeshStandardMaterial, uniforms: SkinOutfitUniforms): void {
  const varyings = 'varying vec3 vHatColor;\nvarying float vHat;\n'
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader =
      SKIN_VERTEX_HEAD(OUTFITS.length) +
      varyings +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${SKIN_VERTEX_HIDE}\n vHatColor = outfitHat[outfitK].rgb;\n vHat = skinPart;`,
      )
    shader.fragmentShader =
      varyings +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vHatColor * vColor.rgb, step(0.5, vHat));',
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.85, step(0.5, vHat));',
        )
  }
  mat.customProgramCacheKey = () => 'avatar-skin-v1'
}

/** 膚色網格投影用的深度材質：不戴斗笠的人沒有帽子的影子。 */
function makeSkinDepthMaterial(uniforms: SkinOutfitUniforms): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial()
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outfitHat = uniforms.outfitHat
    shader.vertexShader =
      SKIN_VERTEX_HEAD(OUTFITS.length) +
      shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${SKIN_VERTEX_HIDE}`)
  }
  mat.customProgramCacheKey = () => 'avatar-skin-depth-v1'
  return mat
}

/** 每個頂點填同一個值的屬性（替代用幾何補上模型才有的頂點色與部位）。 */
const constantAttribute = (count: number, itemSize: number, value: number) =>
  new THREE.Float32BufferAttribute(new Float32Array(count * itemSize).fill(value), itemSize)

/** 替代用的袍（圓柱）：補上與模型相同的頂點色（全白）與衣裝屬性（不在披帶上、兩種輪廓都顯示）。 */
function makePlaceholderRobe(): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.2, 0.36, 1.05, 8)
  geo.translate(0, 0.525, 0)
  const count = geo.getAttribute('position').count
  geo.setAttribute('color', constantAttribute(count, 3, 1))
  const field = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    field[i * 2] = NO_SASH
    field[i * 2 + 1] = BODY_PART.shared
  }
  geo.setAttribute('robeField', new THREE.Float32BufferAttribute(field, 2))
  return geo
}

/** 替代用的頭（球）：頂點色全白、全部是皮膚（沒有斗笠）。 */
function makePlaceholderHead(): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.17, 1)
  geo.translate(0, 1.2, 0)
  const count = geo.getAttribute('position').count
  geo.setAttribute('color', constantAttribute(count, 3, 1))
  geo.setAttribute('skinPart', constantAttribute(count, 1, SKIN_PART.skin))
  return geo
}

/** 名牌與對話泡泡的額外高度：戴斗笠的衣裝升高。 */
const labelLift = (outfit: number) => (OUTFITS[outfit]?.hat ? HAT_LABEL_LIFT : 0)

const ORIGIN = new THREE.Vector3()
export const PIVOT_HEIGHT = 0.55
/** 小沙彌模型的身高（公尺），與 scripts/build-avatar.mjs 的 HEIGHT 一致。 */
const FIGURE_HEIGHT = 1.15
/**
 * 肩膀（袍頂、頭底）的高度（公尺），取自 scripts/build-avatar.mjs 的 ROBE_PROFILE 與 HEAD。
 * 頭與手以剛體跟著這個高度上下移動，不做縮放，避免蹲坐時頭被壓扁、臉變形。
 */
const SHOULDER_HEIGHT = 0.66
/**
 * 模型網址的版本。/models/* 快取一天且檔名固定，程式（檔名有雜湊）卻立即換新：
 * 重跑 npm run build:avatar 後要加一，否則舊快取的模型缺新屬性，角色會停在替代用的圓柱。
 */
const AVATAR_MODEL_VERSION = 2
/** 同時繪製的角色上限（含自己）。需大於最高畫質的可見人數。 */
export const AVATAR_CAPACITY = 160

/** 對話泡泡貼圖：每行最多 BUBBLE_LINE_CHARS 個字元自動換行，半透明底，與名牌同色系。 */
const BUBBLE_LINE_CHARS = 14
function makeBubbleTexture(text: string): THREE.CanvasTexture {
  const chars = Array.from(text)
  const lines: string[] = []
  for (let i = 0; i < chars.length; i += BUBBLE_LINE_CHARS) lines.push(chars.slice(i, i + BUBBLE_LINE_CHARS).join(''))
  const font = '500 28px system-ui, "Noto Sans TC", sans-serif'
  const lineH = 38
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  ctx.font = font
  const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 32
  c.width = w
  c.height = lines.length * lineH + 20
  ctx.font = font
  ctx.fillStyle = 'rgba(244,239,230,0.88)'
  ctx.beginPath()
  ctx.roundRect(0, 0, w, c.height, 20)
  ctx.fill()
  ctx.fillStyle = '#2a241c'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  lines.forEach((l, i) => ctx.fillText(l, w / 2, 10 + lineH * (i + 0.5) + 1))
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * 角色工廠與批次繪製擁有者。
 * 所有角色以 InstancedMesh 批次繪製：身體（袍或短褂、鞋）、膚色部分（頭、手與斗笠）與臉各分近、遠兩批，加上影子，不論人數多少都是 7 個 draw call（名牌另計，最近 12 人加上自己最多 13 個，對話泡泡每個正在說話的人 1 個；有人手上拿著香時另加 1 個，有人誦經時木魚與槌另加 1 個）。
 * 臉（五官圖集）近遠都畫，各自貼在該 tier 的頭部曲面上，不投影。
 * 近處用完整模型並投射即時陰影；遠處用低面數模型（monk-lod.glb）且不投影，只留腳下的假影子。
 * 模型是 Q 版小沙彌公仔（public/models/monk.glb，由 scripts/build-avatar.mjs 以程式產生），沒有骨架：
 * 動畫作用在無網格的 rig 節點上，sync() 把 pivot 的旋轉套在腳底、pivot 的升降轉成身體的壓扁與拉長；頭、手與臉不縮放，只隨肩膀升降。
 * 模型載入前（或載入失敗時）以簡單的圓柱與球代替。
 */
export class AvatarFactory {
  private tracker = new ResourceTracker()
  /**
   * [近, 遠]，各含身體、膚色與臉三個批次。
   * 臉的幾何各自取自該 tier 的膚色幾何（曲面細緻度不同，不能共用）；faceIndex 決定每個角色用圖集的哪一格。
   */
  private tiers: Array<{
    body: THREE.InstancedMesh
    /** 每個實例的衣裝編號（身體與膚色共用的實例屬性 outfitId）。 */
    outfit: THREE.InstancedBufferAttribute
    skin: THREE.InstancedMesh
    face: THREE.InstancedMesh
    faceIndex: THREE.InstancedBufferAttribute
    count: number
  }>
  private shadows: THREE.InstancedMesh
  /** 手上的香：有人拿著時才多 1 個 draw call。 */
  private props: THREE.InstancedMesh
  /** 誦經的木魚與槌：每人兩個實例（instPart 0 木魚、1 槌），有人誦經時才多 1 個 draw call。 */
  private chantProps: THREE.InstancedMesh
  private chantPart: THREE.InstancedBufferAttribute
  private grip = new THREE.Vector3()
  private malletDir = new THREE.Vector3()
  private malletAxis = new THREE.Vector3()
  private malletQuat = new THREE.Quaternion()
  private propPose = new THREE.Matrix4()
  private records = new Set<AvatarRecord>()
  private pose = new THREE.Matrix4()
  private poseScale = new THREE.Vector3()
  /** 頭、手與臉的剛體姿勢（不縮放），與 shoulderOffset 都是重用的暫存物件。 */
  private rigidPose = new THREE.Matrix4()
  private shoulderOffset = new THREE.Vector3()
  private static readonly UNIT_SCALE = new THREE.Vector3(1, 1, 1)

  constructor(parent: THREE.Object3D) {
    const t = this.tracker
    const shadowGeo = t.track(new THREE.CircleGeometry(0.45, 16))
    shadowGeo.rotateX(-Math.PI / 2)

    // 袍色與配件由實例的衣裝編號決定（patchOutfitMaterial），材質本身用白色；模型的頂點色把袖口與鞋子壓暗。
    const bodyUniforms = bodyOutfitUniforms()
    const robeMat = t.trackMaterial(new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.85 }))
    patchOutfitMaterial(robeMat, bodyUniforms)
    // 皮膚的頂點色是 1（與單色材質相同）；斗笠的顏色與收合同樣依實例的衣裝編號（patchSkinMaterial）
    const skinUniforms = skinOutfitUniforms()
    const skinMat = t.trackMaterial(new THREE.MeshStandardMaterial({ color: '#d2a07c', vertexColors: true, roughness: 0.7 }))
    patchSkinMaterial(skinMat, skinUniforms)
    // 陰影那一趟用同樣收合的深度材質：不戴的念珠、斗笠與另一種輪廓不投影
    const bodyDepthMat = t.trackMaterial(makeBodyDepthMaterial(bodyUniforms))
    const skinDepthMat = t.trackMaterial(makeSkinDepthMaterial(skinUniforms))

    const c = document.createElement('canvas')
    c.width = c.height = 64
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(0,0,0,0.35)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
    const shadowMat = t.trackMaterial(
      new THREE.MeshBasicMaterial({ map: t.track(new THREE.CanvasTexture(c)), transparent: true, depthWrite: false }),
    )

    const make = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geo, mat, AVATAR_CAPACITY)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      // 角色分散在整個場地，包圍球每幀都在變；交給 GPU 裁切比每幀重算便宜。
      mesh.frustumCulled = false
      parent.add(mesh)
      return mesh
    }
    // 臉的材質與圖集兩個 tier 共用
    const faceMat = t.trackMaterial(
      new THREE.MeshStandardMaterial({
        map: t.track(makeFaceAtlas()),
        transparent: true,
        depthWrite: false,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    )
    faceMat.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float faceIndex;\n' +
        shader.vertexShader.replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>\n vMapUv.x = (vMapUv.x + faceIndex) / ${FACE_COUNT}.0;`,
        )
    }
    this.tiers = [true, false].map((near) => {
      // 衣裝編號是實例屬性，同一份掛在該 tier 的身體與膚色幾何上，所以替代用的圓柱與球每個 tier 各一份
      const outfit = new THREE.InstancedBufferAttribute(new Float32Array(AVATAR_CAPACITY), 1)
      outfit.setUsage(THREE.DynamicDrawUsage)
      const robeGeo = t.track(makePlaceholderRobe())
      robeGeo.setAttribute('outfitId', outfit)
      const headGeo = t.track(makePlaceholderHead())
      headGeo.setAttribute('outfitId', outfit)
      const body = make(robeGeo, robeMat)
      const skin = make(headGeo, skinMat)
      body.customDepthMaterial = bodyDepthMat
      skin.customDepthMaterial = skinDepthMat
      body.castShadow = skin.castShadow = near
      // 臉不投影（兩個 tier 都一樣）；幾何在模型載入後才有
      const face = make(t.track(new THREE.BufferGeometry()), faceMat)
      face.castShadow = false
      const faceIndex = new THREE.InstancedBufferAttribute(new Float32Array(AVATAR_CAPACITY), 1)
      faceIndex.setUsage(THREE.DynamicDrawUsage)
      return { body, outfit, skin, face, faceIndex, count: 0 }
    })
    this.shadows = make(shadowGeo, shadowMat)
    this.shadows.renderOrder = -1
    this.props = make(t.track(createIncenseStickGeometry()), t.trackMaterial(new THREE.MeshBasicMaterial({ vertexColors: true })))
    this.props.visible = false
    const chantMat = t.trackMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }))
    patchChantPropsMaterial(chantMat)
    const chantGeo = t.track(createChantPropsGeometry())
    this.chantPart = new THREE.InstancedBufferAttribute(new Float32Array(AVATAR_CAPACITY * 2), 1)
    this.chantPart.setUsage(THREE.DynamicDrawUsage)
    chantGeo.setAttribute('instPart', this.chantPart)
    this.chantProps = new THREE.InstancedMesh(chantGeo, chantMat, AVATAR_CAPACITY * 2)
    this.chantProps.name = 'chant-props'
    this.chantProps.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.chantProps.count = 0
    this.chantProps.frustumCulled = false
    // 自訂 vertex shader 只裝在一般材質上，陰影的深度材質不知道要縮掉另一部分，所以不投影（木魚很小，只差腳邊一點影子）
    this.chantProps.castShadow = false
    this.chantProps.visible = false
    parent.add(this.chantProps)

    // 動態載入 GLTFLoader（與 statues.ts 共用同一個延後載入的區塊）
    void import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
      ;['monk.glb', 'monk-lod.glb'].forEach((file, i) =>
        new GLTFLoader().load(`${import.meta.env.BASE_URL}models/${file}?v=${AVATAR_MODEL_VERSION}`, (gltf) => {
          const geometryOf = (name: string) => (gltf.scene.getObjectByName(name) as THREE.Mesh | undefined)?.geometry
          const body = geometryOf('body')
          const skin = geometryOf('skin')
          if (!body || !skin) return
          // build-avatar.mjs 的自訂屬性 _OUTFIT、_PART（GLTFLoader 轉成小寫）改名為著色器用的 robeField、skinPart
          const field = body.getAttribute('_outfit')
          const skinPart = skin.getAttribute('_part')
          if (!field || !skinPart || !body.getAttribute('color') || !skin.getAttribute('color')) {
            console.warn(`${file} 缺少衣裝屬性，請重新執行 npm run build:avatar`)
            return
          }
          body.setAttribute('robeField', field)
          body.deleteAttribute('_outfit')
          skin.setAttribute('skinPart', skinPart)
          skin.deleteAttribute('_part')
          const tier = this.tiers[i]!
          body.setAttribute('outfitId', tier.outfit)
          skin.setAttribute('outfitId', tier.outfit)
          tier.body.geometry = t.track(body)
          tier.skin.geometry = t.track(skin)
          // 臉取自該 tier 自己的膚色幾何，才會貼合各自的頭部曲面
          const face = t.track(makeFaceGeometry(skin))
          face.setAttribute('faceIndex', tier.faceIndex)
          tier.face.geometry = face
        }),
      )
    })
  }

  create(opts: { name: string; outfit: number; local: boolean }): Avatar {
    const root = new THREE.Group()
    const pivot = new THREE.Group()
    pivot.position.y = PIVOT_HEIGHT
    root.add(pivot)
    const head = new THREE.Group()
    head.position.y = 1.05 - PIVOT_HEIGHT + 0.15
    pivot.add(head)
    const shadow = new THREE.Object3D()
    shadow.position.y = 0.06
    root.add(shadow)

    // 名牌的貼圖與材質由 Nameplate 擁有（每個角色獨有，改名時換掉），不登記在共用的 tracker
    const label = new Nameplate(root, opts.name)

    // 對話泡泡：只在名牌顯示中的人（最近 12 人）與本機玩家頭上顯示。
    let labelOn = opts.local
    let bubble: THREE.Sprite | null = null
    let bubbleUntil = 0
    const clearBubble = () => {
      if (!bubble) return
      bubble.removeFromParent()
      ;(bubble.material as THREE.SpriteMaterial).map?.dispose()
      bubble.material.dispose()
      bubble = null
    }

    const rig: AvatarRig = { root, pivot, head, face: FACE_CALM, prop: PROP_NONE, propAngle: 0 }
    const record: AvatarRecord = { rig, shadow, outfit: normalizeOutfit(opts.outfit) }
    this.records.add(record)
    /** 名牌與泡泡的高度（戴斗笠時升高）；換衣裝時重新放。 */
    const bubbleY = () => FIGURE_HEIGHT + (label.name ? 0.55 : 0.3) + labelLift(record.outfit)
    const placeLabels = () => {
      label.setY(FIGURE_HEIGHT + 0.3 + labelLift(record.outfit))
      if (bubble) bubble.position.y = bubbleY()
    }
    placeLabels()

    return Object.assign(rig, {
      setName: (name: string) => {
        label.set(name)
        placeLabels()
      },
      setLabelVisible(visible: boolean) {
        label.setVisible(visible)
        labelOn = visible || opts.local
        if (bubble) bubble.visible = labelOn
      },
      say: (text: string, until: number) => {
        clearBubble()
        const tex = makeBubbleTexture(text)
        bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false, transparent: true }))
        const img = tex.image as HTMLCanvasElement
        bubble.scale.set((img.width / img.height) * 0.24 * (img.height / 44), 0.24 * (img.height / 44), 1)
        bubble.center.set(0.5, 0)
        bubble.position.y = bubbleY()
        bubble.renderOrder = 10
        bubble.visible = labelOn
        root.add(bubble)
        bubbleUntil = until
      },
      tickBubble: (now: number) => {
        if (bubble && now >= bubbleUntil) clearBubble()
        return bubble !== null
      },
      setOutfit: (outfit: number) => {
        record.outfit = normalizeOutfit(outfit)
        placeLabels()
      },
      dispose: () => {
        this.records.delete(record)
        root.removeFromParent()
        label.dispose()
        clearBubble()
      },
    })
  }

  /**
   * 把可見角色的姿勢寫進批次繪製。每次繪製前呼叫一次。
   * 距離 (x, z) 在 nearRadius 內的角色用完整模型並投影，其餘用低面數模型。
   */
  sync(x: number, z: number, nearRadius: number): void {
    let i = 0
    let props = 0
    let chant = 0
    for (const tier of this.tiers) tier.count = 0
    for (const r of this.records) {
      const { root, pivot } = r.rig
      if (!root.visible || i >= AVATAR_CAPACITY) continue
      root.updateMatrixWorld(true)
      // 公仔式動畫：整尊繞腳底傾斜；pivot 下降（蹲坐）時壓扁、上升（走路彈跳、呼吸）時拉長，體積大致不變。
      const stretch = 1 + (pivot.position.y - PIVOT_HEIGHT) / FIGURE_HEIGHT
      const side = 1 / Math.sqrt(stretch)
      this.pose.compose(ORIGIN, pivot.quaternion, this.poseScale.set(side, stretch, side)).premultiply(root.matrixWorld)
      const tier = this.tiers[(root.position.x - x) ** 2 + (root.position.z - z) ** 2 <= nearRadius * nearRadius ? 0 : 1]!
      tier.body.setMatrixAt(tier.count, this.pose)
      tier.outfit.setX(tier.count, r.outfit)
      // 頭、耳朵、手與臉：同樣的傾斜，但不縮放，只跟著肩膀的高度升降（手比袖口多降約 3 公分，可接受）。
      this.rigidPose
        .compose(this.shoulderOffset.set(0, SHOULDER_HEIGHT * (stretch - 1), 0).applyQuaternion(pivot.quaternion), pivot.quaternion, AvatarFactory.UNIT_SCALE)
        .premultiply(root.matrixWorld)
      tier.skin.setMatrixAt(tier.count, this.rigidPose)
      tier.face.setMatrixAt(tier.count, this.rigidPose)
      tier.faceIndex.setX(tier.count, r.rig.face)
      tier.count++
      if (r.rig.prop === PROP_INCENSE) this.props.setMatrixAt(props++, this.propPose.multiplyMatrices(this.rigidPose, HELD_INCENSE))
      if (r.rig.prop === PROP_CHANT) chant = this.placeChantProps(chant, root.matrixWorld, r.rig.propAngle)
      this.shadows.setMatrixAt(i, r.shadow.matrixWorld)
      i++
    }
    for (const tier of this.tiers) {
      if (tier.count > 0) {
        const matCount = tier.count * 16
        for (const m of [tier.body, tier.skin]) {
          m.count = tier.count
          m.instanceMatrix.updateRanges = [{ start: 0, count: matCount }]
          m.instanceMatrix.needsUpdate = true
        }
        tier.outfit.updateRanges = [{ start: 0, count: tier.count }]
        tier.outfit.needsUpdate = true

        const hasFace = Boolean(tier.face.geometry.getAttribute('position'))
        tier.face.count = hasFace ? tier.count : 0
        if (hasFace) {
          tier.face.instanceMatrix.updateRanges = [{ start: 0, count: matCount }]
          tier.face.instanceMatrix.needsUpdate = true
          tier.faceIndex.updateRanges = [{ start: 0, count: tier.count }]
          tier.faceIndex.needsUpdate = true
        }
      } else {
        tier.body.count = 0
        tier.skin.count = 0
        tier.face.count = 0
      }
    }
    this.shadows.count = i
    if (i > 0) {
      this.shadows.instanceMatrix.updateRanges = [{ start: 0, count: i * 16 }]
      this.shadows.instanceMatrix.needsUpdate = true
    }
    this.props.count = props
    this.props.visible = props > 0
    if (props > 0) {
      this.props.instanceMatrix.updateRanges = [{ start: 0, count: props * 16 }]
      this.props.instanceMatrix.needsUpdate = true
    }
    this.chantProps.count = chant
    this.chantProps.visible = chant > 0
    if (chant > 0) {
      this.chantProps.instanceMatrix.updateRanges = [{ start: 0, count: chant * 16 }]
      this.chantProps.instanceMatrix.needsUpdate = true
      this.chantPart.updateRanges = [{ start: 0, count: chant }]
      this.chantPart.needsUpdate = true
    }
  }

  /**
   * 木魚放在角色腳底前方的地上（不隨身體傾斜）；槌從合十的手（剛體姿勢，this.rigidPose）指向木魚頂端，
   * 再繞角色的左右軸抬起 angle。手到木魚的距離隨姿勢略有不同，槌沿長軸稍微伸縮（0.85～1.25 倍），放下時剛好碰到木魚。
   */
  private placeChantProps(i: number, root: THREE.Matrix4, angle: number): number {
    this.chantProps.setMatrixAt(i, this.propPose.multiplyMatrices(root, WOODFISH_POSE))
    this.chantPart.setX(i, 0)
    this.grip.copy(MALLET_GRIP).applyMatrix4(this.rigidPose)
    this.malletDir.copy(MALLET_TARGET).applyMatrix4(root).sub(this.grip)
    const reach = this.malletDir.length()
    this.malletDir.divideScalar(reach || 1)
    this.malletAxis.copy(AXIS_X).transformDirection(root)
    this.malletDir.applyAxisAngle(this.malletAxis, -angle)
    this.malletQuat.setFromUnitVectors(AXIS_Z, this.malletDir)
    const stretch = Math.min(1.25, Math.max(0.85, reach / MALLET_HEAD_Z))
    this.chantProps.setMatrixAt(i + 1, this.propPose.compose(this.grip, this.malletQuat, this.poseScale.set(1, 1, stretch)))
    this.chantPart.setX(i + 1, 1)
    return i + 2
  }

  dispose(): void {
    for (const m of [...this.tiers.flatMap((tier) => [tier.body, tier.skin, tier.face]), this.shadows, this.props, this.chantProps]) {
      m.removeFromParent()
      m.dispose()
    }
    this.records.clear()
    this.tracker.dispose()
  }
}
