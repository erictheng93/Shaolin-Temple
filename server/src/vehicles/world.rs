//! 碰碰車物理世界：封裝 Rapier3D 物理管線、車輛、障礙物與步行者。

use crate::protocol::{BUMP_CAR, BUMP_NONE, BUMP_TREE, BUMP_WALL};
use crate::vehicles::drive::{CarMotion, DriveInput, drive, wrap_angle};
use crate::vehicles::params::{Params, params};
use crate::world::Zone;
use rapier3d::prelude::*;
use std::collections::HashMap;
use std::sync::Mutex;

// 碰撞體的 user_data 標記撞到它時的撞擊種類（`cars` 幀的 bump）。
// 靜態物是 BUMP_WALL 或 BUMP_TREE；步行者是 BUMP_NONE（撞人由 knock 表示，不設 bump）；
// 車由 collider_to_car 辨識（BUMP_CAR）。
const USER_DATA_WALL: u128 = BUMP_WALL as u128;
const USER_DATA_TREE: u128 = BUMP_TREE as u128;
const USER_DATA_WALKER: u128 = BUMP_NONE as u128;

const GROUP_STATIC: Group = Group::GROUP_1;
const GROUP_CAR: Group = Group::GROUP_2;
const GROUP_WALKER: Group = Group::GROUP_3;

fn car_groups(occupied: bool) -> InteractionGroups {
    if occupied {
        InteractionGroups::new(
            GROUP_CAR,
            GROUP_STATIC | GROUP_CAR,
            InteractionTestMode::And,
        )
    } else {
        InteractionGroups::new(
            GROUP_CAR,
            GROUP_STATIC | GROUP_CAR | GROUP_WALKER,
            InteractionTestMode::And,
        )
    }
}

fn walker_groups() -> InteractionGroups {
    InteractionGroups::new(GROUP_WALKER, GROUP_CAR, InteractionTestMode::And)
}

fn static_groups() -> InteractionGroups {
    InteractionGroups::new(GROUP_STATIC, GROUP_CAR, InteractionTestMode::And)
}

#[derive(Debug, Clone, Copy)]
pub struct CarState {
    pub c: u8,
    pub occupied: bool,
    /// 上次 [`VehicleWorld::clear_bumped`] 以來接觸力最大的那次撞擊的種類（`BUMP_*`，0 = 沒撞）。
    pub bump: u8,
    pub x: f32,
    pub z: f32,
    pub heading: f32,
    pub vx: f32,
    pub vz: f32,
    pub w: f32,
}

/// 一次撞擊：撞擊種類與接觸力（total force magnitude）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bump {
    pub kind: u8,
    pub force: f32,
}

#[derive(Debug, Clone, Default)]
pub struct StepReport {
    /// 這一步每台車接觸力最大的撞擊（索引是車號；只含超過門檻的接觸）。
    pub bumps: [Option<Bump>; 16],
}

impl StepReport {
    pub fn bump(&self, c: u8) -> Option<Bump> {
        self.bumps.get(c as usize).copied().flatten()
    }
}

/// 同一車號保留接觸力較大的撞擊。
fn keep_stronger(slot: &mut Option<Bump>, bump: Bump) {
    if slot.is_none_or(|old| bump.force > old.force) {
        *slot = Some(bump);
    }
}

struct CarSlot {
    body_handle: RigidBodyHandle,
    collider_handle: ColliderHandle,
    occupied: bool,
    input: Option<DriveInput>,
}

pub struct VehicleWorld {
    _zone: &'static Zone,
    params: &'static Params,
    pipeline: PhysicsPipeline,
    islands: IslandManager,
    broad_phase: DefaultBroadPhase,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    soft_bodies: SoftBodySet,
    ccd: CCDSolver,
    integration_parameters: IntegrationParameters,

    cars: [Option<CarSlot>; 16],
    collider_to_car: HashMap<ColliderHandle, u8>,
    walkers: HashMap<u8, RigidBodyHandle>,
    /// 上次 clear_bumped 以來每台車接觸力最大的撞擊（可能跨好幾個物理步）。
    last_bumps: [Option<Bump>; 16],
}

impl VehicleWorld {
    pub fn new(zone: &'static Zone) -> Self {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let impulse_joints = ImpulseJointSet::new();
        let multibody_joints = MultibodyJointSet::new();
        let soft_bodies = SoftBodySet::new();
        let pipeline = PhysicsPipeline::new();
        let islands = IslandManager::new();
        let broad_phase = DefaultBroadPhase::new();
        let narrow_phase = NarrowPhase::new();
        let ccd = CCDSolver::new();
        let integration_parameters = IntegrationParameters {
            dt: 1.0 / 30.0,
            ..IntegrationParameters::default()
        };
        let p = params();

        // 靜態邊界與障礙物（固定在同一個 static 剛體上）
        let ground_handle = bodies.insert(RigidBodyBuilder::fixed());

        // 1. zone.solids（樹以 zone.trees 標記，其餘當牆）
        for rect in zone.solids {
            let cx = ((rect.min_x + rect.max_x) * 0.5) as f32;
            let cz = ((rect.min_z + rect.max_z) * 0.5) as f32;
            let hx = ((rect.max_x - rect.min_x) * 0.5) as f32;
            let hz = ((rect.max_z - rect.min_z) * 0.5) as f32;
            let user_data = if zone.trees.contains(rect) {
                USER_DATA_TREE
            } else {
                USER_DATA_WALL
            };
            let col = ColliderBuilder::cuboid(hx, 1.0, hz)
                .translation(Vector::new(cx, 0.0, cz))
                .user_data(user_data)
                .collision_groups(static_groups())
                .restitution(p.car.restitution)
                .friction(p.car.friction)
                .active_events(ActiveEvents::CONTACT_FORCE_EVENTS)
                .build();
            colliders.insert_with_parent(col, ground_handle, &mut bodies);
        }

        // 2. 檔口實體矩形 booth.rect
        let bx0 = p.booth.rect.min_x;
        let bx1 = p.booth.rect.max_x;
        let bz0 = p.booth.rect.min_z;
        let bz1 = p.booth.rect.max_z;
        let bcx = (bx0 + bx1) * 0.5;
        let bcz = (bz0 + bz1) * 0.5;
        let bhx = (bx1 - bx0) * 0.5;
        let bhz = (bz1 - bz0) * 0.5;
        let booth_col = ColliderBuilder::cuboid(bhx, 1.0, bhz)
            .translation(Vector::new(bcx, 0.0, bcz))
            .user_data(USER_DATA_WALL)
            .collision_groups(static_groups())
            .restitution(p.car.restitution)
            .friction(p.car.friction)
            .active_events(ActiveEvents::CONTACT_FORCE_EVENTS)
            .build();
        colliders.insert_with_parent(booth_col, ground_handle, &mut bodies);

        // 3. 四面邊界牆
        let min_x = zone.bounds.min_x as f32;
        let max_x = zone.bounds.max_x as f32;
        let min_z = zone.bounds.min_z as f32;
        let max_z = zone.bounds.max_z as f32;
        let mid_x = (min_x + max_x) * 0.5;
        let mid_z = (min_z + max_z) * 0.5;
        let hw = (max_x - min_x) * 0.5;
        let hz = (max_z - min_z) * 0.5;
        let thick = 2.0_f32;

        let walls = [
            // 西牆 (x = min_x)
            (
                Vector::new(min_x - thick * 0.5, 0.0, mid_z),
                thick * 0.5,
                hz + thick,
            ),
            // 東牆 (x = max_x)
            (
                Vector::new(max_x + thick * 0.5, 0.0, mid_z),
                thick * 0.5,
                hz + thick,
            ),
            // 北牆 (z = min_z)
            (
                Vector::new(mid_x, 0.0, min_z - thick * 0.5),
                hw + thick,
                thick * 0.5,
            ),
            // 南牆 (z = max_z)
            (
                Vector::new(mid_x, 0.0, max_z + thick * 0.5),
                hw + thick,
                thick * 0.5,
            ),
        ];

        for (center, wall_hx, wall_hz) in walls {
            let wall_col = ColliderBuilder::cuboid(wall_hx, 1.0, wall_hz)
                .translation(center)
                .user_data(USER_DATA_WALL)
                .collision_groups(static_groups())
                .restitution(p.car.restitution)
                .friction(p.car.friction)
                .active_events(ActiveEvents::CONTACT_FORCE_EVENTS)
                .build();
            colliders.insert_with_parent(wall_col, ground_handle, &mut bodies);
        }

        Self {
            _zone: zone,
            params: p,
            pipeline,
            islands,
            broad_phase,
            narrow_phase,
            bodies,
            colliders,
            impulse_joints,
            multibody_joints,
            soft_bodies,
            ccd,
            integration_parameters,
            cars: Default::default(),
            collider_to_car: HashMap::new(),
            walkers: HashMap::new(),
            last_bumps: [None; 16],
        }
    }

    /// 生成一輛車，分配最小的可用編號 0..=15。若已滿 16 輛則返回 None。
    pub fn spawn(&mut self, x: f32, z: f32, heading: f32) -> Option<u8> {
        let c = self.cars.iter().position(|slot| slot.is_none())?;
        let p = self.params;
        let hw = p.car.half_width;
        let hh = p.car.half_height;
        let hl = p.car.half_length;

        let rb = RigidBodyBuilder::dynamic()
            .translation(Vector::new(x, 0.0, z))
            .rotation(Vector::new(0.0, heading, 0.0))
            .locked_axes(
                LockedAxes::TRANSLATION_LOCKED_Y
                    | LockedAxes::ROTATION_LOCKED_X
                    | LockedAxes::ROTATION_LOCKED_Z,
            )
            .linear_damping(p.car.linear_damping)
            .angular_damping(p.car.angular_damping)
            .build();
        let body_handle = self.bodies.insert(rb);

        let col = ColliderBuilder::cuboid(hw, hh, hl)
            .mass(p.car.mass)
            .restitution(p.car.restitution)
            .friction(p.car.friction)
            .collision_groups(car_groups(false))
            .active_events(ActiveEvents::CONTACT_FORCE_EVENTS)
            .contact_force_event_threshold(p.car.mass * 3.0)
            .build();
        let collider_handle = self
            .colliders
            .insert_with_parent(col, body_handle, &mut self.bodies);

        self.collider_to_car.insert(collider_handle, c as u8);
        self.cars[c] = Some(CarSlot {
            body_handle,
            collider_handle,
            occupied: false,
            input: None,
        });

        Some(c as u8)
    }

    pub fn remove(&mut self, c: u8) {
        if let Some(slot) = self.cars.get_mut(c as usize).and_then(|s| s.take()) {
            self.collider_to_car.remove(&slot.collider_handle);
            self.bodies.remove(
                slot.body_handle,
                &mut self.islands,
                &mut self.colliders,
                &mut self.impulse_joints,
                &mut self.multibody_joints,
                &mut self.soft_bodies,
                true,
            );
        }
    }

    pub fn set_occupied(&mut self, c: u8, occupied: bool) {
        if let Some(slot) = self.cars.get_mut(c as usize).and_then(|s| s.as_mut()) {
            slot.occupied = occupied;
            if let Some(collider) = self.colliders.get_mut(slot.collider_handle) {
                collider.set_collision_groups(car_groups(occupied));
            }
            if !occupied {
                slot.input = None;
            }
        }
    }

    pub fn set_input(&mut self, c: u8, input: DriveInput) {
        if let Some(slot) = self.cars.get_mut(c as usize).and_then(|s| s.as_mut()) {
            slot.input = Some(input);
        }
    }

    pub fn set_walker(&mut self, n: u8, pos: Option<(f32, f32)>) {
        match pos {
            Some((x, z)) => {
                if let Some(&handle) = self.walkers.get(&n) {
                    if let Some(body) = self.bodies.get_mut(handle) {
                        body.set_next_kinematic_translation(Vector::new(x, 0.0, z));
                    }
                } else {
                    let rb = RigidBodyBuilder::kinematic_position_based()
                        .translation(Vector::new(x, 0.0, z))
                        .build();
                    let body_handle = self.bodies.insert(rb);
                    let col = ColliderBuilder::ball(0.35)
                        .user_data(USER_DATA_WALKER)
                        .collision_groups(walker_groups())
                        .build();
                    self.colliders
                        .insert_with_parent(col, body_handle, &mut self.bodies);
                    self.walkers.insert(n, body_handle);
                }
            }
            None => {
                if let Some(handle) = self.walkers.remove(&n) {
                    self.bodies.remove(
                        handle,
                        &mut self.islands,
                        &mut self.colliders,
                        &mut self.impulse_joints,
                        &mut self.multibody_joints,
                        &mut self.soft_bodies,
                        true,
                    );
                }
            }
        }
    }

    pub fn step(&mut self) -> StepReport {
        let dt = self.integration_parameters.dt;

        // 1. 對每台有輸入的車呼叫 drive()
        for c in 0..16 {
            if let Some(slot) = &self.cars[c]
                && let Some(input) = slot.input
            {
                let body = &mut self.bodies[slot.body_handle];
                let fwd = body.rotation() * Vector::new(0.0, 0.0, 1.0);
                let heading = wrap_angle(fwd.x.atan2(fwd.z));
                let linvel = body.linvel();
                let angvel = body.angvel();
                let motion = CarMotion {
                    heading,
                    vx: linvel.x,
                    vz: linvel.z,
                    w: angvel.y,
                };
                let out = drive(&motion, &input, &self.params.car);

                // 沿前方施加衝量 force * dt
                let forward_x = heading.sin();
                let forward_z = heading.cos();
                let impulse =
                    Vector::new(out.force * dt * forward_x, 0.0, out.force * dt * forward_z);
                body.apply_impulse(impulse, true);

                // 把側向速度乘上 lateral_keep
                let curr_linvel = body.linvel();
                let v_forward = curr_linvel.x * forward_x + curr_linvel.z * forward_z;
                let v_lateral = curr_linvel.x * forward_z - curr_linvel.z * forward_x;
                let new_v_lateral = v_lateral * out.lateral_keep;
                let new_vx = v_forward * forward_x + new_v_lateral * forward_z;
                let new_vz = v_forward * forward_z - new_v_lateral * forward_x;
                body.set_linvel(Vector::new(new_vx, 0.0, new_vz), true);

                // 設定 Y 軸角速度為 w
                body.set_angvel(Vector::new(0.0, out.w, 0.0), true);
            }
        }

        // 2. 接觸力事件捕獲
        struct ContactRecorder<'a> {
            collider_to_car: &'a HashMap<ColliderHandle, u8>,
            threshold: f32,
            bumps: Mutex<[Option<Bump>; 16]>,
        }

        impl ContactRecorder<'_> {
            /// `me` 撞到 `other` 時記下的種類；`other` 是步行者（或沒有標記）時不算撞擊。
            fn kind_against(&self, colliders: &ColliderSet, other: ColliderHandle) -> u8 {
                if self.collider_to_car.contains_key(&other) {
                    return BUMP_CAR;
                }
                match colliders.get(other).map(|c| c.user_data) {
                    Some(USER_DATA_WALL) => BUMP_WALL,
                    Some(USER_DATA_TREE) => BUMP_TREE,
                    _ => BUMP_NONE,
                }
            }

            fn record(
                &self,
                colliders: &ColliderSet,
                me: ColliderHandle,
                other: ColliderHandle,
                force: f32,
            ) {
                let Some(&c) = self.collider_to_car.get(&me) else {
                    return;
                };
                let kind = self.kind_against(colliders, other);
                if kind == BUMP_NONE {
                    return;
                }
                let mut bumps = self.bumps.lock().unwrap();
                keep_stronger(&mut bumps[c as usize], Bump { kind, force });
            }
        }

        impl<'a> EventHandler for ContactRecorder<'a> {
            fn handle_collision_event(
                &self,
                _bodies: &RigidBodySet,
                _colliders: &ColliderSet,
                _event: CollisionEvent,
                _contact_pair: Option<&ContactPair>,
            ) {
            }

            fn handle_contact_force_event(
                &self,
                _dt: f32,
                _bodies: &RigidBodySet,
                colliders: &ColliderSet,
                contact_pair: &ContactPair,
                total_force_magnitude: f32,
            ) {
                if total_force_magnitude >= self.threshold {
                    let (a, b) = (contact_pair.collider1, contact_pair.collider2);
                    self.record(colliders, a, b, total_force_magnitude);
                    self.record(colliders, b, a, total_force_magnitude);
                }
            }

            fn handle_soft_body_tear_event(
                &self,
                _soft_bodies: &SoftBodySet,
                _event: &SoftBodyTearEvent,
            ) {
            }
        }

        let recorder = ContactRecorder {
            collider_to_car: &self.collider_to_car,
            threshold: self.params.car.mass * 3.0,
            bumps: Mutex::new([None; 16]),
        };

        // 3. 物理步進
        self.pipeline.step(
            Vector::new(0.0, 0.0, 0.0),
            &self.integration_parameters,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.soft_bodies,
            &mut self.ccd,
            &(),
            &recorder,
        );

        let report = StepReport {
            bumps: recorder.bumps.into_inner().unwrap(),
        };
        self.accumulate(&report);
        report
    }

    /// 把一步的撞擊併入這個廣播間隔的累積：每台車只留接觸力最大的那次。
    fn accumulate(&mut self, report: &StepReport) {
        for (slot, bump) in self.last_bumps.iter_mut().zip(report.bumps) {
            if let Some(bump) = bump {
                keep_stronger(slot, bump);
            }
        }
    }

    /// 廣播 `cars` 幀之後呼叫：清掉累積的撞擊，下一個間隔重新取最大者。
    pub fn clear_bumped(&mut self) {
        self.last_bumps = [None; 16];
    }

    pub fn car(&self, c: u8) -> Option<CarState> {
        let slot = self.cars.get(c as usize)?.as_ref()?;
        let body = self.bodies.get(slot.body_handle)?;
        let p = body.translation();
        let fwd = body.rotation() * Vector::new(0.0, 0.0, 1.0);
        let heading = wrap_angle(fwd.x.atan2(fwd.z));
        let linvel = body.linvel();
        let angvel = body.angvel();

        Some(CarState {
            c,
            occupied: slot.occupied,
            bump: self.last_bumps[c as usize].map_or(BUMP_NONE, |b| b.kind),
            x: p.x,
            z: p.z,
            heading,
            vx: linvel.x,
            vz: linvel.z,
            w: angvel.y,
        })
    }

    pub fn cars(&self) -> impl Iterator<Item = CarState> + '_ {
        (0..16).filter_map(|c| self.car(c as u8))
    }

    pub fn any_awake(&self) -> bool {
        self.cars.iter().flatten().any(|slot| {
            self.bodies
                .get(slot.body_handle)
                .is_some_and(|b| !b.is_sleeping())
        })
    }

    pub fn is_awake(&self, c: u8) -> bool {
        let Some(slot) = self.cars.get(c as usize).and_then(|s| s.as_ref()) else {
            return false;
        };
        self.bodies
            .get(slot.body_handle)
            .is_some_and(|b| !b.is_sleeping())
    }

    /// 點 (x, z) 到車身長方體（平面 2D 邊界）的歐幾里得距離。在長方體內部為 0。
    pub fn distance_to_car(&self, c: u8, x: f32, z: f32) -> Option<f32> {
        let slot = self.cars.get(c as usize)?.as_ref()?;
        let body = self.bodies.get(slot.body_handle)?;
        let p = body.translation();
        let fwd = body.rotation() * Vector::new(0.0, 0.0, 1.0);
        let heading = wrap_angle(fwd.x.atan2(fwd.z));

        let dx = x - p.x;
        let dz = z - p.z;
        // 旋轉至車體本地坐標系
        let lx = dx * heading.cos() - dz * heading.sin();
        let lz = dx * heading.sin() + dz * heading.cos();

        let hw = self.params.car.half_width;
        let hl = self.params.car.half_length;

        let qx = (lx.abs() - hw).max(0.0);
        let qz = (lz.abs() - hl).max(0.0);
        Some((qx * qx + qz * qz).sqrt())
    }

    /// 以 (x, z) 為中心，半對角線半徑範圍內沒有其他車。
    pub fn bay_is_free(&self, x: f32, z: f32) -> bool {
        let hw = self.params.car.half_width;
        let hl = self.params.car.half_length;
        let r = hw.hypot(hl);
        for c in 0..16 {
            if let Some(dist) = self.distance_to_car(c as u8, x, z)
                && dist < r
            {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::COURTYARD;
    use std::f32::consts::{FRAC_PI_2, PI};

    #[test]
    fn car_accelerates_toward_stick_direction() {
        let mut world = VehicleWorld::new(&COURTYARD);
        let c = world.spawn(0.0, 8.0, 0.0).unwrap();
        world.set_input(c, DriveInput { dir: 0.0, mag: 1.0 });
        for _ in 0..60 {
            world.step();
        }
        let car = world.car(c).unwrap();
        assert!(car.z > 8.0 + 3.0, "z = {}", car.z);
        assert!(car.x.abs() < 0.05, "x = {}", car.x);
    }

    #[test]
    fn car_never_enters_a_solid_or_leaves_bounds() {
        let mut world = VehicleWorld::new(&COURTYARD);
        let c = world.spawn(0.0, 2.0, PI).unwrap();
        world.set_input(c, DriveInput { dir: PI, mag: 1.0 });
        for _ in 0..300 {
            world.step();
            let car = world.car(c).unwrap();
            assert!(
                COURTYARD.bounds.contains(car.x as f64, car.z as f64),
                "car out of bounds: ({}, {})",
                car.x,
                car.z
            );
            for s in COURTYARD.solids {
                assert!(
                    !s.contains(car.x as f64, car.z as f64),
                    "car entered solid: ({}, {}) in {:?}",
                    car.x,
                    car.z,
                    s
                );
            }
        }
    }

    /// 全速開到第一次超過門檻的撞擊為止，回傳那一步記下的種類與累積後 `car()` 回報的種類。
    fn first_bump(world: &mut VehicleWorld, c: u8, dir: f32) -> (u8, u8) {
        world.set_input(c, DriveInput { dir, mag: 1.0 });
        for _ in 0..300 {
            let report = world.step();
            if let Some(bump) = report.bump(c) {
                return (bump.kind, world.car(c).unwrap().bump);
            }
        }
        panic!("car {c} never bumped into anything");
    }

    #[test]
    fn hitting_a_wall_reports_a_bump() {
        // 往 -z 撞香爐（中心 0, -1.5），香爐屬於「牆」類
        let mut world = VehicleWorld::new(&COURTYARD);
        let c = world.spawn(0.0, 2.0, PI).unwrap();
        assert_eq!(world.car(c).unwrap().bump, BUMP_NONE);
        assert_eq!(first_bump(&mut world, c, PI), (BUMP_WALL, BUMP_WALL));
    }

    #[test]
    fn hitting_the_boundary_wall_reports_wall() {
        // 往 +x 撞東側邊界牆（x = 19），路上沒有其他障礙物
        let mut world = VehicleWorld::new(&COURTYARD);
        let c = world.spawn(12.0, 8.0, FRAC_PI_2).unwrap();
        assert_eq!(first_bump(&mut world, c, FRAC_PI_2), (BUMP_WALL, BUMP_WALL));
    }

    #[test]
    fn hitting_a_tree_reports_tree() {
        // 往 -z 撞樹（中心 -15, -4，半寬 0.5）
        let mut world = VehicleWorld::new(&COURTYARD);
        let c = world.spawn(-15.0, 1.0, PI).unwrap();
        assert_eq!(first_bump(&mut world, c, PI), (BUMP_TREE, BUMP_TREE));
    }

    #[test]
    fn two_cars_colliding_both_report_car() {
        let mut world = VehicleWorld::new(&COURTYARD);
        let a = world.spawn(0.0, 7.0, 0.0).unwrap();
        let b = world.spawn(0.0, 13.0, PI).unwrap();
        world.set_occupied(a, true);
        world.set_occupied(b, true);
        world.set_input(a, DriveInput { dir: 0.0, mag: 1.0 });
        world.set_input(b, DriveInput { dir: PI, mag: 1.0 });
        for _ in 0..300 {
            let report = world.step();
            if report.bump(a).is_some() || report.bump(b).is_some() {
                assert_eq!(report.bump(a).map(|x| x.kind), Some(BUMP_CAR));
                assert_eq!(report.bump(b).map(|x| x.kind), Some(BUMP_CAR));
                assert_eq!(world.car(a).unwrap().bump, BUMP_CAR);
                assert_eq!(world.car(b).unwrap().bump, BUMP_CAR);
                world.clear_bumped();
                assert_eq!(world.car(a).unwrap().bump, BUMP_NONE);
                assert_eq!(world.car(b).unwrap().bump, BUMP_NONE);
                return;
            }
        }
        panic!("cars never collided");
    }

    #[test]
    fn strongest_contact_in_an_interval_wins() {
        let mut world = VehicleWorld::new(&COURTYARD);
        let c = world.spawn(0.0, 8.0, 0.0).unwrap();
        let step = |kind, force| {
            let mut report = StepReport::default();
            report.bumps[c as usize] = Some(Bump { kind, force });
            report
        };
        // 同一步內：力較大的取代較小的，較小的不取代較大的
        let mut slot = None;
        keep_stronger(
            &mut slot,
            Bump {
                kind: BUMP_WALL,
                force: 100.0,
            },
        );
        keep_stronger(
            &mut slot,
            Bump {
                kind: BUMP_CAR,
                force: 300.0,
            },
        );
        keep_stronger(
            &mut slot,
            Bump {
                kind: BUMP_TREE,
                force: 200.0,
            },
        );
        assert_eq!(slot.map(|b| b.kind), Some(BUMP_CAR));

        // 跨物理步（同一個廣播間隔）：取最大者，與先後無關
        world.accumulate(&step(BUMP_WALL, 100.0));
        world.accumulate(&step(BUMP_TREE, 500.0));
        world.accumulate(&step(BUMP_CAR, 200.0));
        world.accumulate(&StepReport::default());
        assert_eq!(world.car(c).unwrap().bump, BUMP_TREE);

        // 廣播後清除，下一個間隔重新計算
        world.clear_bumped();
        assert_eq!(world.car(c).unwrap().bump, BUMP_NONE);
        world.accumulate(&step(BUMP_WALL, 50.0));
        assert_eq!(world.car(c).unwrap().bump, BUMP_WALL);
    }

    #[test]
    fn walker_contact_does_not_set_bump() {
        // 步行者快速撞上空車（空車與步行者有碰撞），不算 bump：撞人由 knock 表示
        let mut world = VehicleWorld::new(&COURTYARD);
        let c = world.spawn(0.0, 8.0, 0.0).unwrap();
        for step in 0..=40 {
            let z = 5.0 + step as f32 * 0.2;
            world.set_walker(1, Some((0.0, z)));
            let report = world.step();
            assert_eq!(report.bump(c), None, "step {step}");
            assert_eq!(world.car(c).unwrap().bump, BUMP_NONE, "step {step}");
        }
        assert!(
            world.car(c).unwrap().z > 8.5,
            "the walker must actually push the car"
        );
    }

    #[test]
    fn idle_world_falls_asleep() {
        let mut world = VehicleWorld::new(&COURTYARD);
        let _c = world.spawn(0.0, 8.0, 0.0).unwrap();
        for _ in 0..120 {
            world.step();
        }
        assert!(!world.any_awake());
    }

    #[test]
    fn walker_pushes_an_empty_car_but_not_an_occupied_one() {
        // 空車：被推動
        {
            let mut world = VehicleWorld::new(&COURTYARD);
            let c = world.spawn(0.0, 8.0, 0.0).unwrap();
            for step in 0..=20 {
                let z = 6.0 + step as f32 * 0.1;
                world.set_walker(1, Some((0.0, z)));
                world.step();
            }
            let car = world.car(c).unwrap();
            assert!(
                car.z > 8.0 + 0.5,
                "empty car should be pushed: z = {}",
                car.z
            );
        }

        // 載人車：不與步行者碰撞
        {
            let mut world = VehicleWorld::new(&COURTYARD);
            let c = world.spawn(0.0, 8.0, 0.0).unwrap();
            world.set_occupied(c, true);
            for step in 0..=20 {
                let z = 6.0 + step as f32 * 0.1;
                world.set_walker(1, Some((0.0, z)));
                world.step();
            }
            let car = world.car(c).unwrap();
            let disp = ((car.x - 0.0).powi(2) + (car.z - 8.0).powi(2)).sqrt();
            assert!(
                disp < 0.01,
                "occupied car should not be moved by walker: disp = {}",
                disp
            );
        }
    }

    #[test]
    fn spawn_returns_none_when_sixteen_exist() {
        let mut world = VehicleWorld::new(&COURTYARD);
        for i in 0..16 {
            let res = world.spawn(i as f32, 0.0, 0.0);
            assert_eq!(res, Some(i as u8));
        }
        assert_eq!(world.spawn(100.0, 0.0, 0.0), None);
    }

    #[derive(serde::Serialize, serde::Deserialize, Debug)]
    struct DriveScriptFile {
        start: StartPose,
        script: Vec<DriveInputData>,
        expected: Vec<ExpectedPoint>,
    }

    #[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug)]
    struct StartPose {
        x: f32,
        z: f32,
        heading: f32,
    }

    #[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug)]
    struct DriveInputData {
        dir: f32,
        mag: f32,
    }

    #[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
    struct ExpectedPoint {
        step: usize,
        x: f32,
        z: f32,
        heading: f32,
    }

    #[test]
    fn drive_script_matches_fixture() {
        let fixture_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/drive-script.json");
        let update_fixture = std::env::var("UPDATE_FIXTURES").as_deref() == Ok("1");
        if !update_fixture && !fixture_path.exists() {
            panic!(
                "fixture file {:?} does not exist. Run with UPDATE_FIXTURES=1 to generate.",
                fixture_path
            );
        }

        let (start, script) = if update_fixture {
            let start = StartPose {
                x: 0.0,
                z: 8.0,
                heading: 0.0,
            };
            let mut script = Vec::with_capacity(90);
            // 直行 30 步
            for _ in 0..30 {
                script.push(DriveInputData { dir: 0.0, mag: 1.0 });
            }
            // 右轉 30 步
            for _ in 0..30 {
                script.push(DriveInputData {
                    dir: FRAC_PI_2,
                    mag: 1.0,
                });
            }
            // 對著東側邊界牆全速 30 步
            for _ in 0..30 {
                script.push(DriveInputData {
                    dir: FRAC_PI_2,
                    mag: 1.0,
                });
            }
            (start, script)
        } else {
            let content =
                std::fs::read_to_string(&fixture_path).expect("failed to read drive-script.json");
            let file: DriveScriptFile =
                serde_json::from_str(&content).expect("invalid drive-script.json");
            (file.start, file.script)
        };

        let mut world = VehicleWorld::new(&COURTYARD);
        let c = world.spawn(start.x, start.z, start.heading).unwrap();

        let mut simulated_points = Vec::new();
        for (i, input) in script.iter().enumerate() {
            world.set_input(
                c,
                DriveInput {
                    dir: input.dir,
                    mag: input.mag,
                },
            );
            world.step();
            let step_num = i + 1;
            if step_num % 10 == 0 {
                let car = world.car(c).unwrap();
                simulated_points.push(ExpectedPoint {
                    step: step_num,
                    x: car.x,
                    z: car.z,
                    heading: car.heading,
                });
            }
        }

        if update_fixture {
            let file = DriveScriptFile {
                start,
                script,
                expected: simulated_points,
            };
            let json = serde_json::to_string_pretty(&file).expect("serialize drive-script");
            std::fs::create_dir_all(fixture_path.parent().unwrap()).unwrap();
            std::fs::write(&fixture_path, json).expect("write drive-script.json");
        } else {
            let content =
                std::fs::read_to_string(&fixture_path).expect("failed to read drive-script.json");
            let file: DriveScriptFile =
                serde_json::from_str(&content).expect("invalid drive-script.json");
            assert_eq!(file.expected.len(), simulated_points.len());
            for (exp, act) in file.expected.iter().zip(simulated_points.iter()) {
                assert_eq!(exp.step, act.step);
                assert!(
                    (exp.x - act.x).abs() < 1e-3,
                    "step {}: expected x {}, got {}",
                    exp.step,
                    exp.x,
                    act.x
                );
                assert!(
                    (exp.z - act.z).abs() < 1e-3,
                    "step {}: expected z {}, got {}",
                    exp.step,
                    exp.z,
                    act.z
                );
                assert!(
                    (exp.heading - act.heading).abs() < 1e-3,
                    "step {}: expected heading {}, got {}",
                    exp.step,
                    exp.heading,
                    act.heading
                );
            }
        }
    }
}
