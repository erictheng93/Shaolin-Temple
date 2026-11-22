// 玩家之間的硬碰撞：圓形分離的純函式。前端、mock 伺服器與 Rust 伺服器（server/src/collide.rs）逐行相同，
// 以共用固定資料 server/tests/collide-script.json 鎖住結果。只用加減乘除與開根號，各平台結果一致。
// 這個檔沒有 import，Node 可以直接載入。設計見 docs/superpowers/specs/2026-11-21-player-collision-design.md。

/** 人與人的碰撞半徑（公尺）。對場景障礙物仍用 PLAYER_RADIUS（0.35）的加邊。 */
export const BODY_RADIUS = 0.3
/** 兩人中心的最小距離。 */
export const MIN_DIST = BODY_RADIUS * 2
/** 伺服器驗證玩家送來的位置時，重疊量不超過這個值就不處理（吸收延遲造成的不一致）。 */
export const TOLERANCE = 0.15
/** 每個 tick 的全體分離中，每人最多被移動的距離（約每秒 1 公尺）。 */
export const SEPARATE_PER_TICK = 0.1

export interface Body {
  /** 房內短編號；處理順序依它由小到大，兩邊才會算出同樣的結果。 */
  n: number
  x: number
  z: number
  /** 推不動（正在做定點動作）。 */
  rooted: boolean
}
export interface Moved {
  n: number
  x: number
  z: number
}
export type Valid = (x: number, z: number) => boolean

/**
 * 處理一個人的移動。mover 是想去的位置（已通過邊界與障礙物檢查），prev 是移動前的位置。
 * 重疊量由兩人各分一半：mover 少走一半、對方被往外推一半；對方推不動，或被推過去的位置不合法時，
 * 全部由 mover 承擔。回傳 mover 的新位置與被推動的人（各自的新位置）。
 */
export function resolveMove(
  mover: { x: number; z: number },
  prev: { x: number; z: number },
  others: ReadonlyArray<Body>,
  tolerance: number,
  valid: Valid,
): { x: number; z: number; moved: Moved[] } {
  const list = others.map((o) => ({ ...o })).sort((a, b) => a.n - b.n)
  const pushed = new Set<number>()
  let x = mover.x
  let z = mover.z
  for (let round = 0; round < 2; round++) {
    for (const o of list) {
      const dx = x - o.x
      const dz = z - o.z
      const d = Math.sqrt(dx * dx + dz * dz)
      const pen = MIN_DIST - d
      if (pen <= tolerance) continue
      let ux: number
      let uz: number
      if (d < 1e-9) {
        // 兩人在同一點：往 mover 來的方向退；連來的方向都沒有就固定往 +x
        const px = prev.x - o.x
        const pz = prev.z - o.z
        const pd = Math.sqrt(px * px + pz * pz)
        ux = pd < 1e-9 ? 1 : px / pd
        uz = pd < 1e-9 ? 0 : pz / pd
      } else {
        ux = dx / d
        uz = dz / d
      }
      let share = o.rooted ? 0 : 0.5
      if (share > 0) {
        const bx = o.x - ux * pen * share
        const bz = o.z - uz * pen * share
        if (valid(bx, bz)) {
          o.x = bx
          o.z = bz
          pushed.add(o.n)
        } else {
          share = 0
        }
      }
      x += ux * pen * (1 - share)
      z += uz * pen * (1 - share)
    }
  }
  if (!valid(x, z)) {
    x = prev.x
    z = prev.z
  }
  return { x, z, moved: list.filter((o) => pushed.has(o.n)).map(({ n, x, z }) => ({ n, x, z })) }
}

/**
 * 每個 tick 的全體分離：仍然重疊的兩人各往外移。所有配對都以「這個 tick 開始時」的位置計算，
 * 每人把各配對的位移加總後，長度限制在 SEPARATE_PER_TICK 以內；移過去不合法的人不動。回傳位置有變的人。
 */
export function separate(bodies: ReadonlyArray<Body>, valid: Valid): Moved[] {
  const list = [...bodies].sort((a, b) => a.n - b.n)
  const dx = new Array<number>(list.length).fill(0)
  const dz = new Array<number>(list.length).fill(0)
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!
      const b = list[j]!
      if (a.rooted && b.rooted) continue
      const ex = a.x - b.x
      const ez = a.z - b.z
      const d = Math.sqrt(ex * ex + ez * ez)
      const pen = MIN_DIST - d
      if (pen <= 0) continue
      // 方向由 b 指向 a；同一點時短編號小的往 −x
      const ux = d < 1e-9 ? -1 : ex / d
      const uz = d < 1e-9 ? 0 : ez / d
      const sa = a.rooted ? 0 : b.rooted ? 1 : 0.5
      const sb = 1 - sa
      dx[i]! += ux * pen * sa
      dz[i]! += uz * pen * sa
      dx[j]! -= ux * pen * sb
      dz[j]! -= uz * pen * sb
    }
  }
  const out: Moved[] = []
  for (let i = 0; i < list.length; i++) {
    let mx = dx[i]!
    let mz = dz[i]!
    const len = Math.sqrt(mx * mx + mz * mz)
    if (len < 1e-12) continue
    if (len > SEPARATE_PER_TICK) {
      mx *= SEPARATE_PER_TICK / len
      mz *= SEPARATE_PER_TICK / len
    }
    const b = list[i]!
    if (valid(b.x + mx, b.z + mz)) out.push({ n: b.n, x: b.x + mx, z: b.z + mz })
  }
  return out
}
