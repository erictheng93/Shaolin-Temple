import RAPIER from '@dimforge/rapier3d-compat'
import { expect, test } from 'vitest'

// 與後端 `server/src/vehicles/mod.rs` 的冒煙測試相同的情境：無重力、初速 1 m/s、
// 以 1/30 秒步進 30 次，應前進 1 公尺。兩邊的結果一致，才代表版本與步長設定對齊。
test('Rapier 以 1/30 秒步進 30 次，自由剛體前進 1 公尺', async () => {
  await RAPIER.init()
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 })
  world.timestep = 1 / 30
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setLinvel(1, 0, 0))
  world.createCollider(RAPIER.ColliderDesc.ball(0.5), body)

  for (let i = 0; i < 30; i++) world.step()

  const p = body.translation()
  expect(Math.abs(p.x - 1)).toBeLessThan(1e-4)
  expect(Math.abs(p.y)).toBeLessThan(1e-6)
  expect(Math.abs(p.z)).toBeLessThan(1e-6)
  world.free()
})
