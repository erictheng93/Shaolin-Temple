import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { ResourceTracker } from './ResourceTracker'

/**
 * 把 group 底下「直屬、靜態」的一般 Mesh 依材質合併成一個 Mesh，減少 draw call。
 *
 * - 只處理 group 的直屬子節點與其靜態後代 Mesh；InstancedMesh、Sprite、具名需保留的節點不合併。
 * - skip 回傳 true 的子樹整個保留（例如神像插槽要能單獨替換）。
 * - 合併後的幾何由 tracker 擁有；原本的共用幾何仍由原擁有者釋放。
 * - 保留 position、normal、uv 與烘焙貼圖用的 uv1；同材質中有的幾何沒有 uv1 時補 0，合併才不會失敗。
 */
export function mergeStatic(group: THREE.Object3D, tracker: ResourceTracker, skip: (o: THREE.Object3D) => boolean = () => false): number {
  group.updateMatrixWorld(true)
  const inverse = new THREE.Matrix4().copy(group.matrixWorld).invert()
  const byMaterial = new Map<THREE.Material, { geoms: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>()

  const visit = (o: THREE.Object3D) => {
    if (o !== group && skip(o)) return
    if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh) && !Array.isArray(o.material)) {
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()
      // 只保留合併需要的屬性，避免不同幾何的屬性不一致
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'uv1'].includes(name)) g.deleteAttribute(name)
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position!.count * 2), 2))
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld))
      const entry = byMaterial.get(o.material) ?? { geoms: [], meshes: [] }
      entry.geoms.push(g)
      entry.meshes.push(o)
      byMaterial.set(o.material, entry)
    }
    for (const child of o.children) visit(child)
  }
  visit(group)

  let merged = 0
  for (const [material, { geoms, meshes }] of byMaterial) {
    if (geoms.some((x) => x.attributes.uv1)) {
      for (const x of geoms) {
        if (!x.attributes.uv1) x.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(x.attributes.position!.count * 2), 2))
      }
    }
    // 只有一個的不合併；合併失敗時保留原本的 Mesh，不讓物件消失
    const g = geoms.length >= 2 ? mergeGeometries(geoms, false) : null
    geoms.forEach((x) => x.dispose())
    if (!g) continue
    tracker.track(g)
    const mesh = new THREE.Mesh(g, material)
    mesh.matrixAutoUpdate = false
    group.add(mesh)
    for (const m of meshes) m.removeFromParent()
    merged += meshes.length
  }
  return merged
}
