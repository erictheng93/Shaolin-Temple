import type { Rect } from './layout'
import { CAR_PARAMS } from './vehicles'

export interface MoverState {
  x: number
  z: number
  heading: number
  /** 尋路的目標點；null 表示沒有目標。 */
  target: { x: number; z: number } | null
}

export interface MoveInput {
  /** 鍵盤／搖桿方向（世界座標）。長度 <= 1 時速度乘上長度，> 1 時以全速移動。非零時優先於尋路目標。 */
  dirX: number
  dirZ: number
}

export interface MoveConfig {
  speed: number
  bounds: Rect
  obstacles: ReadonlyArray<Rect>
  slowZones?: () => Iterable<{ x: number; z: number; heading: number }>
}

const ARRIVE_EPSILON = 0.05

/** 把點推出所有障礙物（取最短推出方向）並限制在邊界內。 */
export function resolveCollisions(x: number, z: number, cfg: MoveConfig): { x: number; z: number } {
  for (const r of cfg.obstacles) {
    if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) {
      const dl = x - r.minX
      const dr = r.maxX - x
      const dn = z - r.minZ
      const df = r.maxZ - z
      const m = Math.min(dl, dr, dn, df)
      if (m === dl) x = r.minX
      else if (m === dr) x = r.maxX
      else if (m === dn) z = r.minZ
      else z = r.maxZ
    }
  }
  const b = cfg.bounds
  return { x: Math.min(b.maxX, Math.max(b.minX, x)), z: Math.min(b.maxZ, Math.max(b.minZ, z)) }
}

/**
 * 推進一步，直接修改 state。回傳本步是否有移動。
 * ponytail: 障礙物推出為逐軸處理，不做尋路；目標在障礙物後方時角色會沿邊緣停下。需要繞路時再加 A* 或導航網格。
 */
export function stepMover(state: MoverState, input: MoveInput, dt: number, cfg: MoveConfig): boolean {
  let dx = input.dirX
  let dz = input.dirZ
  const usingKeys = dx !== 0 || dz !== 0
  if (usingKeys) {
    state.target = null
  } else if (state.target) {
    dx = state.target.x - state.x
    dz = state.target.z - state.z
  } else {
    return false
  }

  const len = Math.hypot(dx, dz)
  if (len < ARRIVE_EPSILON) {
    state.target = null
    return false
  }

  // 方向輸入長度 <= 1（搖桿半推）時按比例減速，> 1（鍵盤對角）時正規化為全速；尋路目標一律全速。
  const scale = usingKeys ? Math.min(1, len) : 1
  let speed = cfg.speed
  if (cfg.slowZones) {
    for (const zone of cfg.slowZones()) {
      if (Math.hypot(state.x - zone.x, state.z - zone.z) <= CAR_PARAMS.radius) {
        speed *= 0.4
        break
      }
    }
  }
  const step = Math.min(speed * scale * dt, usingKeys ? Infinity : len)
  const nx = state.x + (dx / len) * step
  const nz = state.z + (dz / len) * step
  const p = resolveCollisions(nx, nz, cfg)
  const moved = Math.hypot(p.x - state.x, p.z - state.z)
  state.x = p.x
  state.z = p.z
  state.heading = Math.atan2(dx, dz)

  // 被障礙物擋住（幾乎沒前進）時放棄尋路目標，避免角色原地抖動。
  if (!usingKeys && moved < step * 0.1) state.target = null
  return moved > 1e-6
}
