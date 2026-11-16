import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * 誦經的道具：身前地上的木魚（含墊布）與手上的木魚槌。兩者合成一個幾何，以頂點屬性 propPart 區分（0 木魚、1 槌）；
 * AvatarFactory 以一個 InstancedMesh 畫全部人的木魚與槌（每人兩個實例，實例屬性 instPart 指定這個實例畫哪一部分，
 * 另一部分的頂點在 vertex shader 縮到原點，成為零面積三角形）。所以不論幾個人誦經都只多 1 個 draw call（沒人誦經時 0 個）。
 *
 * 座標（公尺）：
 * - 木魚：原點在地面、木魚正下方，+z 是角色前方。放在角色腳底前方 WOODFISH_FORWARD（蒲團半徑 0.36 之外）。
 * - 槌：原點是握把（合十的手），+z 指向槌頭，槌頭中心在 MALLET_HEAD_Z。
 */

/** 木魚在角色前方的距離（角色根節點座標）。 */
export const WOODFISH_FORWARD = 0.5
/** 槌頭敲到木魚時，槌頭中心的高度（木魚頂 0.214 加上槌頭半徑）。 */
export const WOODFISH_STRIKE_Y = 0.246
/** 握把中心到槌頭中心的長度。 */
export const MALLET_HEAD_Z = 0.29
const MALLET_HEAD_RADIUS = 0.032

const PAD_COLOR = '#7a2420'
const BODY_COLOR = '#94401f'
const SLIT_COLOR = '#2b120a'
const STICK_COLOR = '#c8a46e'
const HEAD_COLOR = '#5b3b24'

function paint(g: THREE.BufferGeometry, color: string, part: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g
  if (ng !== g) g.dispose()
  ng.deleteAttribute('uv')
  const c = new THREE.Color(color)
  const n = ng.attributes.position!.count
  const colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3)
  ng.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  ng.setAttribute('propPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1))
  return ng
}

export function createChantPropsGeometry(): THREE.BufferGeometry {
  // 木魚：深紅墊布上一個壓扁的圓球，前方有一道深色的口縫
  const pad = new THREE.CylinderGeometry(0.15, 0.155, 0.035, 20).translate(0, 0.0175, 0)
  const bodyR = 0.115
  const bodyY = 0.035 + bodyR * 0.78
  const body = new THREE.SphereGeometry(bodyR, 18, 12).scale(1.15, 0.78, 1).translate(0, bodyY, 0)
  const arc = Math.PI * 0.9
  // 圓環原本在 xy 平面、從 +x 開始；轉成水平並讓圓弧的中央朝前（+z）
  const slit = new THREE.TorusGeometry(0.113, 0.008, 6, 16, arc)
    .rotateX(Math.PI / 2)
    .rotateY(arc / 2 - Math.PI / 2)
    .scale(1.17, 1, 1)
    .translate(0, bodyY - 0.015, 0)
  // 槌：細木柄（握把後留 3 公分）與包布的槌頭
  const stick = new THREE.CylinderGeometry(0.009, 0.011, 0.3, 6).rotateX(Math.PI / 2).translate(0, 0, 0.12)
  const head = new THREE.SphereGeometry(MALLET_HEAD_RADIUS, 10, 8).translate(0, 0, MALLET_HEAD_Z)

  const parts = [
    paint(pad, PAD_COLOR, 0),
    paint(body, BODY_COLOR, 0),
    paint(slit, SLIT_COLOR, 0),
    paint(stick, STICK_COLOR, 1),
    paint(head, HEAD_COLOR, 1),
  ]
  const g = mergeGeometries(parts, false)!
  parts.forEach((p) => p.dispose())
  return g
}

/** 只畫實例指定的那一部分：在 MeshStandardMaterial 的 vertex shader 把另一部分縮到原點。 */
export function patchChantPropsMaterial(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float propPart;\nattribute float instPart;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n transformed *= step( abs( propPart - instPart ), 0.5 );',
      )
  }
}
