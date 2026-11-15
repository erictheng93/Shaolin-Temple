import type { AvatarRig } from '../render/AvatarFactory'
import { FACE_CALM, FACE_SMILE, PIVOT_HEIGHT, PROP_NONE } from '../render/AvatarFactory'

/** 動畫片段：p 為 0..1 的進度，直接設定 rig 的姿勢。 */
export type ClipFn = (rig: AvatarRig, p: number) => void

export interface AnimState {
  clip: string | null
  clipStart: number
  clipDuration: number
  moving: boolean
  walkPhase: number
}

export const createAnimState = (): AnimState => ({
  clip: null,
  clipStart: 0,
  clipDuration: 0,
  moving: false,
  walkPhase: 0,
})

export const smooth = (x: number) => x * x * (3 - 2 * x)
/** 0→1→0 的平滑包絡，前段 rise、後段 fall 的比例。 */
export const envelope = (p: number, rise = 0.3, fall = 0.35): number =>
  p < rise ? smooth(p / rise) : p > 1 - fall ? smooth((1 - p) / fall) : 1

/**
 * 程序化角色動畫。沒有骨架動畫，只旋轉／位移少數節點，手機上成本很低。
 * 玩法定案後可用 registerClip() 加入新動作，或改接 glTF 骨架動畫。
 */
export class AnimationSystem {
  private clips = new Map<string, ClipFn>([
    ['bow', (rig, p) => {
      rig.pivot.rotation.x = envelope(p) * 0.75
      rig.face = FACE_SMILE
    }],
    // 整尊小幅前傾點頭（rig.head 的旋轉不會繪製）：1.2 秒內點兩下，峰值約 0.22 弧度。
    ['nod', (rig, p) => {
      rig.pivot.rotation.x = Math.abs(Math.sin(p * Math.PI * 2)) * 0.22 * envelope(p, 0.15, 0.15)
    }],
    ['kneel', (rig, p) => {
      const e = envelope(p, 0.2, 0.2)
      rig.pivot.position.y = PIVOT_HEIGHT - e * 0.3
      rig.pivot.rotation.x = e * 0.25
    }],
  ])

  registerClip(name: string, fn: ClipFn): () => void {
    this.clips.set(name, fn)
    return () => this.clips.delete(name)
  }

  hasClip(name: string): boolean {
    return this.clips.has(name)
  }

  play(state: AnimState, clip: string, now: number, durationMs: number, startedAt = now): void {
    state.clip = clip
    state.clipStart = startedAt
    state.clipDuration = durationMs
  }

  isActive(state: AnimState, now: number): boolean {
    return state.moving || (state.clip !== null && now < state.clipStart + state.clipDuration)
  }

  /** 每幀套用姿勢。now 為毫秒，t 為秒（呼吸用）。 */
  apply(rig: AvatarRig, state: AnimState, now: number, dt: number, t: number): void {
    rig.pivot.rotation.set(0, 0, 0)
    rig.pivot.position.y = PIVOT_HEIGHT
    rig.head.rotation.set(0, 0, 0)
    rig.face = FACE_CALM
    rig.prop = PROP_NONE

    if (state.moving) {
      state.walkPhase += dt * 9
      rig.pivot.position.y += Math.abs(Math.sin(state.walkPhase)) * 0.05
      rig.pivot.rotation.z = Math.sin(state.walkPhase) * 0.04
    } else {
      // 靜止時的呼吸起伏，只在有環境重繪時才看得到。
      rig.pivot.position.y += Math.sin(t * 1.3) * 0.008
    }

    if (state.clip) {
      const p = (now - state.clipStart) / state.clipDuration
      if (p >= 1 || state.moving) {
        state.clip = null
      } else if (p >= 0) {
        this.clips.get(state.clip)?.(rig, p)
      }
    }
  }
}
