//! 車輛物理（碰碰車）：以 rapier3d 在伺服器權威模擬。
//!
//! 車輛世界與規則見 docs/superpowers/plans/2026-11-21-bumper-cars.md。

pub mod params;
pub mod drive;
pub mod world;
pub mod knock;
pub use params::*;
pub use drive::*;
pub use world::*;
pub use knock::*;

#[cfg(test)]
mod tests {
    use rapier3d::prelude::*;

    /// 與前端 `web/src/game/vehicles/rapier.test.ts` 相同的情境：無重力、初速 1 m/s、
    /// 以 1/30 秒步進 30 次，應前進 1 公尺。兩邊的結果一致，才代表版本與步長設定對齊。
    #[test]
    fn rapier_steps_a_free_body_one_metre_in_one_second() {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut impulse_joints = ImpulseJointSet::new();
        let mut multibody_joints = MultibodyJointSet::new();
        let mut soft_bodies = SoftBodySet::new();
        let mut pipeline = PhysicsPipeline::new();
        let mut islands = IslandManager::new();
        let mut broad_phase = DefaultBroadPhase::new();
        let mut narrow_phase = NarrowPhase::new();
        let mut ccd = CCDSolver::new();
        let params = IntegrationParameters {
            dt: 1.0 / 30.0,
            ..IntegrationParameters::default()
        };

        let body = bodies.insert(RigidBodyBuilder::dynamic().linvel(Vector::new(1.0, 0.0, 0.0)));
        colliders.insert_with_parent(ColliderBuilder::ball(0.5), body, &mut bodies);

        for _ in 0..30 {
            pipeline.step(
                Vector::new(0.0, 0.0, 0.0),
                &params,
                &mut islands,
                &mut broad_phase,
                &mut narrow_phase,
                &mut bodies,
                &mut colliders,
                &mut impulse_joints,
                &mut multibody_joints,
                &mut soft_bodies,
                &mut ccd,
                &(),
                &(),
            );
        }

        let p = bodies[body].translation();
        assert!((p.x - 1.0).abs() < 1e-4, "x = {}", p.x);
        assert!(p.y.abs() < 1e-6 && p.z.abs() < 1e-6);
    }
}
