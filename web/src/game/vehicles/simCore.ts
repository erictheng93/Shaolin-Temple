// 碰碰車前端／mock 共用物理模擬核心（封裝 Rapier3D，只 import 型別與 drive.ts，帶副檔名供 Node 直接載入）。

import { drive, wrapAngle, type CarMotion, type CarParams, type DriveInput } from './drive.ts'

export type RapierModule = typeof import('@dimforge/rapier3d-compat').default

export interface Rect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface VehicleParams {
  car: CarParams
  booth: {
    rect: Rect
    bays: ReadonlyArray<{ x: number; z: number; heading: number }>
    counter: { x: number; z: number }
  }
}

export interface CarState {
  c: number
  occupied: boolean
  bumped: boolean
  x: number
  z: number
  heading: number
  vx: number
  vz: number
  w: number
}

export interface SimCar {
  c: number
  body: unknown
  collider: unknown
  input: DriveInput | null
  occupied: boolean
}

export interface SimWorld {
  spawn(c: number, x: number, z: number, heading: number): void
  remove(c: number): void
  setOccupied(c: number, occupied: boolean): void
  setInput(c: number, input: DriveInput | null): void
  setState(c: number, s: CarMotion & { x: number; z: number }): void
  setKinematic(c: number, kinematic: boolean): void
  step(): number[]
  state(c: number): CarState | null
  cars(): CarState[]
  anyAwake(): boolean
  free(): void
}

const GROUP_STATIC = 0x0001
const GROUP_CAR = 0x0002
const GROUP_WALKER = 0x0004

function carGroups(occupied: boolean): number {
  const membership = GROUP_CAR
  const filter = occupied ? GROUP_STATIC | GROUP_CAR : GROUP_STATIC | GROUP_CAR | GROUP_WALKER
  return (membership << 16) | filter
}

function staticGroups(): number {
  return (GROUP_STATIC << 16) | GROUP_CAR
}

export function createSimWorld(
  RAPIER: RapierModule,
  solids: ReadonlyArray<Rect>,
  bounds: Rect,
  p: VehicleParams,
): SimWorld {
  let freed = false

  function assertNotFreed(): void {
    if (freed) {
      throw new Error('SimWorld has been freed')
    }
  }

  const world = new RAPIER.World({ x: 0, y: 0, z: 0 })
  world.timestep = 1.0 / 30.0

  const eventQueue = new RAPIER.EventQueue(true)

  // 靜態邊界與障礙物（固定在同一個 static 剛體上）
  const groundHandle = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())

  // 1. zone.solids
  const hasBooth = solids.some(
    (s) =>
      Math.abs(s.minX - p.booth.rect.minX) < 1e-4 &&
      Math.abs(s.maxX - p.booth.rect.maxX) < 1e-4 &&
      Math.abs(s.minZ - p.booth.rect.minZ) < 1e-4 &&
      Math.abs(s.maxZ - p.booth.rect.maxZ) < 1e-4,
  )
  const allSolids = hasBooth ? solids : [...solids, p.booth.rect]

  for (const rect of allSolids) {
    const cx = (rect.minX + rect.maxX) * 0.5
    const cz = (rect.minZ + rect.maxZ) * 0.5
    const hx = (rect.maxX - rect.minX) * 0.5
    const hz = (rect.maxZ - rect.minZ) * 0.5
    const colDesc = RAPIER.ColliderDesc.cuboid(hx, 1.0, hz)
      .setTranslation(cx, 0.0, cz)
      .setCollisionGroups(staticGroups())
      .setRestitution(p.car.restitution)
      .setFriction(p.car.friction)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
    world.createCollider(colDesc, groundHandle)
  }

  // 2. 四面邊界牆
  const minX = bounds.minX
  const maxX = bounds.maxX
  const minZ = bounds.minZ
  const maxZ = bounds.maxZ
  const midX = (minX + maxX) * 0.5
  const midZ = (minZ + maxZ) * 0.5
  const hw = (maxX - minX) * 0.5
  const hz = (maxZ - minZ) * 0.5
  const thick = 2.0

  const walls = [
    // 西牆 (x = minX)
    { center: { x: minX - thick * 0.5, y: 0.0, z: midZ }, hx: thick * 0.5, hz: hz + thick },
    // 東牆 (x = maxX)
    { center: { x: maxX + thick * 0.5, y: 0.0, z: midZ }, hx: thick * 0.5, hz: hz + thick },
    // 北牆 (z = minZ)
    { center: { x: midX, y: 0.0, z: minZ - thick * 0.5 }, hx: hw + thick, hz: thick * 0.5 },
    // 南牆 (z = maxZ)
    { center: { x: midX, y: 0.0, z: maxZ + thick * 0.5 }, hx: hw + thick, hz: thick * 0.5 },
  ]

  for (const wall of walls) {
    const wallCol = RAPIER.ColliderDesc.cuboid(wall.hx, 1.0, wall.hz)
      .setTranslation(wall.center.x, wall.center.y, wall.center.z)
      .setCollisionGroups(staticGroups())
      .setRestitution(p.car.restitution)
      .setFriction(p.car.friction)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
    world.createCollider(wallCol, groundHandle)
  }

  // 車輛儲存集合
  interface InternalCar {
    c: number
    body: InstanceType<typeof RAPIER.RigidBody>
    collider: InstanceType<typeof RAPIER.Collider>
    input: DriveInput | null
    occupied: boolean
  }

  const cars = new Map<number, InternalCar>()
  const colliderToCar = new Map<number, number>()
  let lastBumped: number[] = []

  function spawn(c: number, x: number, z: number, heading: number): void {
    assertNotFreed()
    remove(c)

    const rot = { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, 0, z)
      .setRotation(rot)
      .enabledTranslations(true, false, true)
      .enabledRotations(false, true, false)
      .setLinearDamping(p.car.linearDamping)
      .setAngularDamping(p.car.angularDamping)
    const body = world.createRigidBody(bodyDesc)

    const colDesc = RAPIER.ColliderDesc.cuboid(p.car.halfWidth, p.car.halfHeight, p.car.halfLength)
      .setMass(p.car.mass)
      .setRestitution(p.car.restitution)
      .setFriction(p.car.friction)
      .setCollisionGroups(carGroups(false))
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(p.car.mass * 3.0)
    const collider = world.createCollider(colDesc, body)

    colliderToCar.set(collider.handle, c)
    cars.set(c, {
      c,
      body,
      collider,
      input: null,
      occupied: false,
    })
  }

  function remove(c: number): void {
    assertNotFreed()
    const car = cars.get(c)
    if (!car) return
    colliderToCar.delete(car.collider.handle)
    world.removeRigidBody(car.body)
    cars.delete(c)
  }

  function setOccupied(c: number, occupied: boolean): void {
    assertNotFreed()
    const car = cars.get(c)
    if (!car) return
    car.occupied = occupied
    car.collider.setCollisionGroups(carGroups(occupied))
    if (!occupied) {
      car.input = null
    }
  }

  function setInput(c: number, input: DriveInput | null): void {
    assertNotFreed()
    const car = cars.get(c)
    if (!car) return
    car.input = input
  }

  function setState(c: number, s: CarMotion & { x: number; z: number }): void {
    assertNotFreed()
    const car = cars.get(c)
    if (!car) return
    car.body.setTranslation({ x: s.x, y: 0, z: s.z }, true)
    const rot = { x: 0, y: Math.sin(s.heading / 2), z: 0, w: Math.cos(s.heading / 2) }
    car.body.setRotation(rot, true)
    car.body.setLinvel({ x: s.vx, y: 0, z: s.vz }, true)
    car.body.setAngvel({ x: 0, y: s.w, z: 0 }, true)
  }

  function setKinematic(c: number, kinematic: boolean): void {
    assertNotFreed()
    const car = cars.get(c)
    if (!car) return
    car.body.setBodyType(
      kinematic ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
      true,
    )
  }

  function step(): number[] {
    assertNotFreed()
    const dt = world.timestep

    // 1. 對每台有輸入的車呼叫 drive()
    for (const car of cars.values()) {
      if (car.input) {
        const body = car.body
        const q = body.rotation()
        const fwdX = 2 * (q.x * q.z + q.w * q.y)
        const fwdZ = q.w * q.w - q.x * q.x - q.y * q.y + q.z * q.z
        const heading = wrapAngle(Math.atan2(fwdX, fwdZ))
        const linvel = body.linvel()
        const angvel = body.angvel()
        const motion: CarMotion = {
          heading,
          vx: linvel.x,
          vz: linvel.z,
          w: angvel.y,
        }
        const out = drive(motion, car.input, p.car)

        // 沿前方施加衝量 force * dt
        const forwardX = Math.sin(heading)
        const forwardZ = Math.cos(heading)
        body.applyImpulse({ x: out.force * dt * forwardX, y: 0.0, z: out.force * dt * forwardZ }, true)

        // 把側向速度乘上 lateral_keep
        const currLinvel = body.linvel()
        const vForward = currLinvel.x * forwardX + currLinvel.z * forwardZ
        const vLateral = currLinvel.x * forwardZ - currLinvel.z * forwardX
        const newVLateral = vLateral * out.lateralKeep
        const newVx = vForward * forwardX + newVLateral * forwardZ
        const newVz = vForward * forwardZ - newVLateral * forwardX
        body.setLinvel({ x: newVx, y: 0.0, z: newVz }, true)

        // 設定 Y 軸角速度為 w
        body.setAngvel({ x: 0.0, y: out.w, z: 0.0 }, true)
      }
    }

    // 2. 物理步進
    world.step(eventQueue)

    // 3. 接觸力事件捕獲
    const bumped = new Set<number>()
    const threshold = p.car.mass * 3.0
    eventQueue.drainContactForceEvents((event) => {
      const force = event.totalForceMagnitude()
      if (force >= threshold) {
        const c1 = colliderToCar.get(event.collider1())
        if (c1 !== undefined) bumped.add(c1)
        const c2 = colliderToCar.get(event.collider2())
        if (c2 !== undefined) bumped.add(c2)
      }
    })

    lastBumped = Array.from(bumped)
    return lastBumped
  }

  function state(c: number): CarState | null {
    assertNotFreed()
    const car = cars.get(c)
    if (!car) return null
    const pos = car.body.translation()
    const q = car.body.rotation()
    const fwdX = 2 * (q.x * q.z + q.w * q.y)
    const fwdZ = q.w * q.w - q.x * q.x - q.y * q.y + q.z * q.z
    const heading = wrapAngle(Math.atan2(fwdX, fwdZ))
    const linvel = car.body.linvel()
    const angvel = car.body.angvel()

    return {
      c,
      occupied: car.occupied,
      bumped: lastBumped.includes(c),
      x: pos.x,
      z: pos.z,
      heading,
      vx: linvel.x,
      vz: linvel.z,
      w: angvel.y,
    }
  }

  function allCarStates(): CarState[] {
    assertNotFreed()
    const result: CarState[] = []
    for (const c of cars.keys()) {
      const s = state(c)
      if (s) result.push(s)
    }
    return result
  }

  function anyAwake(): boolean {
    assertNotFreed()
    for (const car of cars.values()) {
      if (!car.body.isSleeping()) return true
    }
    return false
  }

  function free(): void {
    if (freed) return
    freed = true
    eventQueue.free()
    world.free()
    cars.clear()
    colliderToCar.clear()
  }

  return {
    spawn,
    remove,
    setOccupied,
    setInput,
    setState,
    setKinematic,
    step,
    state,
    cars: allCarStates,
    anyAwake,
    free,
  }
}
