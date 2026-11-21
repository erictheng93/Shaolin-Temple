// 碰碰車駕駛動力學純函式（不可有任何 import，與後端 server/src/vehicles/drive.rs 完全一致）。

export interface DriveInput {
  dir: number
  mag: number
}

export interface CarMotion {
  heading: number
  vx: number
  vz: number
  w: number
}

export interface DriveOutput {
  force: number
  w: number
  lateralKeep: number
}

export interface CarParams {
  halfWidth: number
  halfHeight: number
  halfLength: number
  mass: number
  linearDamping: number
  angularDamping: number
  restitution: number
  friction: number
  maxSpeed: number
  reverseMaxSpeed: number
  driveForce: number
  turnRate: number
  steerGain: number
  steerBlend: number
  lateralGrip: number
  reverseAngle: number
  reverseBelowSpeed: number
}

/** 將角度環繞至 (-PI, PI] 區間。 */
export function wrapAngle(a: number): number {
  const twoPi = 2 * Math.PI
  const wrapped = (((a + Math.PI) % twoPi) + twoPi) % twoPi - Math.PI
  if (wrapped <= -Math.PI) {
    return Math.PI
  }
  return wrapped
}

/**
 * 依車輛當前運動狀態、玩家輸入與車輛參數，計算推進力、旋轉角速度與側向速度保留比例。
 */
export function drive(m: CarMotion, input: DriveInput, p: CarParams): DriveOutput {
  const speed = m.vx * Math.sin(m.heading) + m.vz * Math.cos(m.heading)
  const lateralKeep = 1.0 - p.lateralGrip
  if (input.mag <= 0.0) {
    return {
      force: 0.0,
      w: m.w,
      lateralKeep,
    }
  }

  const diff = wrapAngle(input.dir - m.heading)
  const reversing = Math.abs(diff) > p.reverseAngle && speed < p.reverseBelowSpeed
  let err: number
  let force: number

  if (reversing) {
    err = wrapAngle(input.dir - (m.heading + Math.PI))
    force = speed > -p.reverseMaxSpeed ? -p.driveForce * input.mag : 0.0
  } else {
    err = diff
    force = speed < p.maxSpeed ? p.driveForce * input.mag * Math.max(0.2, Math.cos(diff)) : 0.0
  }

  const steerScale = 0.3 + 0.7 * Math.min(1.0, Math.abs(speed) / 2.0)
  const targetW = Math.max(-p.turnRate, Math.min(p.turnRate, err * p.steerGain)) * steerScale
  const w = m.w + (targetW - m.w) * p.steerBlend

  return {
    force,
    w,
    lateralKeep,
  }
}
