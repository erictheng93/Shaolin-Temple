use super::*;
use crate::protocol::{CarSnapshot, CarState as WireCarState};
use crate::vehicles::{
    drive::{wrap_angle, DriveInput},
    params::params,
};
use std::f32::consts::PI;
use std::time::Duration;
use tokio::time::Instant;

#[derive(Debug, Clone)]
pub struct Car {
    pub kind: u8,
    pub driver: Option<String>,
    pub empty_since: Option<Instant>,
    pub last_input_at: Instant,
    pub fade_at: Option<f64>,
}

impl Room {
    /// 領車：須在庭院、未騎乘、未撞飛、距檔口櫃台 ≤ boothRadius；
    /// 冷卻內回 claim_cooldown；該車種已達 count 回 car_unavailable；
    /// 依序找第一個 bay_is_free 的停車位，都沒有回 booth_crowded；
    /// 成功則生車、玩家上車、廣播 car。
    pub(crate) fn claim(&mut self, who: &Who, kind: u8, now: Instant) {
        let Some(p) = self.live(who) else { return };
        let p_params = params();

        if p.zone.id != world::COURTYARD.id
            || p.riding.is_some()
            || p.knocked_until.is_some_and(|t| now < t)
        {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "目前無法領車".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        }

        let dx = p.x - p_params.booth.counter.x as f64;
        let dz = p.z - p_params.booth.counter.z as f64;
        if dx.hypot(dz) > p_params.ride.booth_radius as f64 {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "距離檔口過遠".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        }

        if p.claim_at
            .is_some_and(|t| now.duration_since(t) < Duration::from_millis(p_params.ride.claim_cooldown_ms))
        {
            let error = ServerMessage::Error {
                code: "claim_cooldown".into(),
                message: "領車冷卻中".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        }

        if kind as usize >= p_params.kinds.len() {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "無效的車種".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        }

        let current_count = self.cars.values().filter(|c| c.kind == kind).count() as u8;
        if current_count >= p_params.kinds[kind as usize].count {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "該車種已無庫存".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        }

        let bay = p_params
            .booth
            .bays
            .iter()
            .find(|b| self.vehicles.bay_is_free(b.x, b.z));
        let Some(bay) = bay else {
            let error = ServerMessage::Error {
                code: "booth_crowded".into(),
                message: "檔口暫無空位".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        };

        let Some(c) = self.vehicles.spawn(bay.x, bay.z, bay.heading) else {
            let error = ServerMessage::Error {
                code: "booth_crowded".into(),
                message: "檔口暫無空位".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        };

        self.vehicles.set_occupied(c, true);
        self.cars.insert(
            c,
            Car {
                kind,
                driver: Some(who.id.clone()),
                empty_since: None,
                last_input_at: now,
                fade_at: None,
            },
        );

        let p = self.players.get_mut(&who.id).unwrap();
        p.riding = Some(c);
        p.claim_at = Some(now);
        p.last_drive_seq = 0;
        p.last_active_drive = now;
        p.drive_seq_init = false;
        p.moving = false;
        p.action = None;
        p.dirty = false;
        p.x = bay.x as f64;
        p.z = bay.z as f64;
        p.heading = bay.heading as f64;

        let msg = ServerMessage::Car {
            c,
            kind,
            driver: Some(who.id.clone()),
            x: bay.x as f64,
            z: bay.z as f64,
            heading: bay.heading as f64,
            fade_at: None,
        };
        self.broadcast(msg, now, |_| true);
    }

    /// 上下車：
    /// `ride(Some(c))`：須在庭院、未騎乘、未撞飛、車存在且無人、距車 ≤ mountRadius，否則回 car_unavailable。
    /// 成功廣播 car（driver 設為玩家、fadeAt 為 null）。
    /// `ride(None)`：等同 dismount。
    pub(crate) fn ride(&mut self, who: &Who, car: Option<u8>, now: Instant) {
        let Some(c) = car else {
            self.dismount(&who.id, now);
            return;
        };

        let (px, pz) = {
            let Some(p) = self.live(who) else { return };
            if p.zone.id != world::COURTYARD.id
                || p.riding.is_some()
                || p.knocked_until.is_some_and(|t| now < t)
            {
                let error = ServerMessage::Error {
                    code: "car_unavailable".into(),
                    message: "無法上車".into(),
                };
                self.send_to(&who.id, error, now);
                return;
            }
            (p.x as f32, p.z as f32)
        };

        let p_params = params();

        let Some(car_meta) = self.cars.get(&c) else {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "車輛不存在".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        };

        if car_meta.driver.is_some() {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "車上已有人".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        };

        let Some(dist) = self.vehicles.distance_to_car(c, px, pz) else {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "無法上車".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        };

        if dist > p_params.ride.mount_radius {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "距離車輛過遠".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        }

        let Some(st) = self.vehicles.car(c) else {
            let error = ServerMessage::Error {
                code: "car_unavailable".into(),
                message: "車輛不存在".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        };

        self.vehicles.set_occupied(c, true);
        let kind = {
            let car_meta = self.cars.get_mut(&c).unwrap();
            car_meta.driver = Some(who.id.clone());
            car_meta.empty_since = None;
            car_meta.fade_at = None;
            car_meta.last_input_at = now;
            car_meta.kind
        };

        let p = self.players.get_mut(&who.id).unwrap();
        p.riding = Some(c);
        p.last_active_drive = now;
        p.drive_seq_init = false;
        p.moving = false;
        p.action = None;
        p.dirty = false;
        p.x = st.x as f64;
        p.z = st.z as f64;
        p.heading = st.heading as f64;

        let msg = ServerMessage::Car {
            c,
            kind,
            driver: Some(who.id.clone()),
            x: st.x as f64,
            z: st.z as f64,
            heading: st.heading as f64,
            fade_at: None,
        };
        self.broadcast(msg, now, |_| true);
    }

    /// 駕駛輸入：騎士專用。
    /// seq 以 u16 環繞比較，較舊的丟棄；mag > 0 時更新 last_active_drive。
    pub(crate) fn drive(&mut self, who: &Who, seq: u16, dir: u8, mag: u8, now: Instant) {
        let Some(p) = self.live(who) else { return };
        let Some(c) = p.riding else { return };

        if p.drive_seq_init {
            let diff = seq.wrapping_sub(p.last_drive_seq) as i16;
            if diff <= 0 {
                return;
            }
        }
        p.last_drive_seq = seq;
        p.drive_seq_init = true;

        if mag > 0 {
            p.last_active_drive = now;
        }

        let dir_rad = wrap_angle(dir as f32 * (2.0 * PI / 256.0));
        let mag_f32 = mag as f32 / 255.0;
        self.vehicles
            .set_input(c, DriveInput { dir: dir_rad, mag: mag_f32 });

        if let Some(car_meta) = self.cars.get_mut(&c) {
            car_meta.last_input_at = now;
        }
    }

    /// 下車：落點依序試車的左、右、後方 dismountOffset 公尺，取第一個在邊界內且不在加邊障礙物內的；
    /// 都不行就用車的位置。
    /// 玩家座標設為落點，對本人送一筆 sync；
    /// 車 set_occupied(false)、清除輸入、empty_since = now，廣播 car（fadeAt = 伺服器毫秒 + idleMs）。
    pub(crate) fn dismount(&mut self, id: &str, now: Instant) {
        let Some(p) = self.players.get_mut(id) else { return };
        let Some(c) = p.riding.take() else { return };

        let car_state = self.vehicles.car(c);
        let (cx, cz, ch) = car_state
            .map(|st| (st.x as f64, st.z as f64, st.heading as f64))
            .unwrap_or((p.x, p.z, p.heading));

        let p_params = params();
        let offset = p_params.ride.dismount_offset as f64;
        let candidates = [
            (cx - offset * ch.cos(), cz + offset * ch.sin()), // left
            (cx + offset * ch.cos(), cz - offset * ch.sin()), // right
            (cx - offset * ch.sin(), cz - offset * ch.cos()), // rear
        ];

        let mut landing = (cx, cz);
        for (cand_x, cand_z) in candidates {
            if p.zone.bounds.contains(cand_x, cand_z)
                && p.zone.obstacles.iter().all(|o| !o.contains(cand_x, cand_z))
            {
                landing = (cand_x, cand_z);
                break;
            }
        }

        p.x = landing.0;
        p.z = landing.1;
        p.heading = ch;
        p.moving = false;
        p.dirty = false;
        p.budget = BUDGET_START;
        p.last_at = now;
        p.last_pos_msg = now;

        let sync_msg = ServerMessage::Sync {
            m: vec![tuple(p)],
        };
        self.send_to(id, sync_msg, now);

        self.vehicles.set_occupied(c, false);
        self.vehicles.set_input(c, DriveInput { dir: 0.0, mag: 0.0 });
        let fade_at = now_ms() + p_params.fade.idle_ms as f64;
        let mut kind = 0;
        if let Some(car_meta) = self.cars.get_mut(&c) {
            car_meta.driver = None;
            car_meta.empty_since = Some(now);
            car_meta.fade_at = Some(fade_at);
            kind = car_meta.kind;
        }

        let car_msg = ServerMessage::Car {
            c,
            kind,
            driver: None,
            x: cx,
            z: cz,
            heading: ch,
            fade_at: Some(fade_at),
        };
        self.broadcast(car_msg, now, |_| true);
    }

    pub(crate) fn car_snapshot(&self, c: u8) -> Option<CarSnapshot> {
        let car_meta = self.cars.get(&c)?;
        let st = self.vehicles.car(c)?;
        Some(CarSnapshot {
            c,
            kind: car_meta.kind,
            driver: car_meta.driver.clone(),
            x: st.x as f64,
            z: st.z as f64,
            heading: st.heading as f64,
            fade_at: car_meta.fade_at,
        })
    }

    pub(crate) fn car_snapshots(&self) -> Vec<CarSnapshot> {
        self.cars.keys().filter_map(|&c| self.car_snapshot(c)).collect()
    }

    pub(crate) fn should_physics_step(&self) -> bool {
        if self.cars.is_empty() {
            return false;
        }
        let has_rider = self.cars.values().any(|c| c.driver.is_some());
        let has_knocked = self.players.values().any(|p| p.knocked_until.is_some());
        has_rider || has_knocked || self.vehicles.any_awake()
    }

    pub(crate) fn cleanup_expired_cars(&mut self, now: Instant) {
        let p_params = params();
        let max_empty = Duration::from_millis(p_params.fade.idle_ms + p_params.fade.fade_ms);
        let expired: Vec<u8> = self
            .cars
            .iter()
            .filter_map(|(&c, car)| {
                if car.driver.is_none()
                    && car
                        .empty_since
                        .is_some_and(|t| now.duration_since(t) >= max_empty)
                {
                    Some(c)
                } else {
                    None
                }
            })
            .collect();

        for c in expired {
            self.vehicles.remove(c);
            self.cars.remove(&c);
            self.broadcast(ServerMessage::CarGone { c }, now, |_| true);
        }
    }

    /// 物理步進：30Hz
    pub(crate) fn physics_step(&mut self, now: Instant) {
        let p_params = params();

        // 0. 到期的被撞玩家恢復並發送 sync
        let recovered: Vec<(String, ServerMessage)> = self
            .players
            .values_mut()
            .filter_map(|pl| {
                if let Some(t) = pl.knocked_until {
                    if now >= t {
                        pl.knocked_until = None;
                        return Some((
                            pl.id.clone(),
                            ServerMessage::Sync {
                                m: vec![tuple(pl)],
                            },
                        ));
                    }
                }
                None
            })
            .collect();
        for (id, msg) in recovered {
            self.send_to(&id, msg, now);
        }

        // 1. 超過 inputTimeoutMs 沒有 drive 的車輸入歸零
        let timeout = Duration::from_millis(p_params.physics.input_timeout_ms);
        for (&c, car) in &self.cars {
            if car.driver.is_some() && now.duration_since(car.last_input_at) > timeout {
                self.vehicles.set_input(c, DriveInput { dir: 0.0, mag: 0.0 });
            }
        }

        // 2. now - last_active_drive > idleDismountMs 的騎士自動下車
        let idle_dismount = Duration::from_millis(p_params.ride.idle_dismount_ms);
        let idle_riders: Vec<String> = self
            .players
            .values()
            .filter(|pl| {
                pl.riding.is_some() && now.duration_since(pl.last_active_drive) > idle_dismount
            })
            .map(|pl| pl.id.clone())
            .collect();
        for id in idle_riders {
            self.dismount(&id, now);
        }

        // 3. 騎士的 x, z, heading 設為車的狀態
        for pl in self.players.values_mut() {
            if let Some(c) = pl.riding {
                if let Some(st) = self.vehicles.car(c) {
                    pl.x = st.x as f64;
                    pl.z = st.z as f64;
                    pl.heading = st.heading as f64;
                    pl.moving = false;
                }
            }
        }

        // 4. 庭院步行者以 set_walker 同步位置（騎乘、殿內、斷線保留期、撞飛或無敵中為 None）
        for pl in self.players.values() {
            let is_walker = pl.link.is_some()
                && pl.zone.id == world::COURTYARD.id
                && pl.riding.is_none()
                && pl.grace_until.is_none()
                && pl.knocked_until.is_none_or(|t| now >= t)
                && pl.immune_until.is_none_or(|t| now >= t);
            if is_walker {
                self.vehicles
                    .set_walker(pl.n, Some((pl.x as f32, pl.z as f32)));
            } else {
                self.vehicles.set_walker(pl.n, None);
            }
        }

        // 5. 物理模擬步進
        self.vehicles.step();
        self.physics_steps += 1;

        // 5.5. 撞飛判定：
        // 每個物理步，對每台有人開且速率 ≥ minSpeed 的車、每位庭院在線且未騎乘、
        // now ≥ knocked_until、now ≥ immune_until 的玩家：distance_to_car ≤ hitRadius 即撞飛。
        let flight_dur = Duration::from_millis(p_params.knock.flight_ms);
        let recover_dur = Duration::from_millis(p_params.knock.recover_ms);
        let immune_dur = Duration::from_millis(p_params.knock.immune_ms);

        let mut knocks = Vec::new();

        for (&c, car) in &self.cars {
            if car.driver.is_none() {
                continue;
            }
            let Some(st) = self.vehicles.car(c) else {
                continue;
            };
            let speed = st.vx.hypot(st.vz);
            if speed < p_params.knock.min_speed {
                continue;
            }
            let dx = (st.vx / speed) as f64;
            let dz = (st.vz / speed) as f64;

            for pl in self.players.values_mut() {
                if pl.zone.id != world::COURTYARD.id
                    || pl.link.is_none()
                    || pl.grace_until.is_some()
                    || pl.riding.is_some()
                    || pl.knocked_until.is_some_and(|t| now < t)
                    || pl.immune_until.is_some_and(|t| now < t)
                {
                    continue;
                }

                if self
                    .vehicles
                    .distance_to_car(c, pl.x as f32, pl.z as f32)
                    .is_some_and(|d| d <= p_params.knock.hit_radius)
                {
                    let dist = crate::vehicles::knock_distance(speed, &p_params.knock);
                    let to = crate::vehicles::knock_landing(
                        &world::COURTYARD,
                        pl.x,
                        pl.z,
                        dx,
                        dz,
                        dist as f64,
                    );
                    let knocked_until = now + flight_dur + recover_dur;
                    let immune_until = knocked_until + immune_dur;
                    let msg = ServerMessage::Knock {
                        id: pl.id.clone(),
                        x: pl.x,
                        z: pl.z,
                        to_x: to.0,
                        to_z: to.1,
                        at: now_ms(),
                    };
                    pl.knocked_until = Some(knocked_until);
                    pl.immune_until = Some(immune_until);
                    pl.x = to.0;
                    pl.z = to.1;
                    pl.action = None;
                    pl.moving = false;
                    pl.dirty = false;
                    knocks.push(msg);
                }
            }
        }

        for msg in knocks {
            self.broadcast(msg, now, |_| true);
        }

        // 6. 空車清理
        self.cleanup_expired_cars(now);

        // 7. 每 broadcastEverySteps 步廣播 cars
        if self.physics_steps % (p_params.physics.broadcast_every_steps as u64) == 0 {
            self.broadcast_cars(now);
        }
    }

    /// 碰碰車廣播：
    /// 對每位庭院在線玩家 try_send 一則 cars（只含未休眠的車；ack 是該玩家的 last_drive_seq，非騎士為 0）。
    /// 佇列滿時比照 moves 設 needs_sync。needs_sync 或剛進入庭院的玩家下一則改送含全部車輛的 cars。
    pub(crate) fn broadcast_cars(&mut self, now: Instant) {
        let awake_cars: Vec<WireCarState> = self
            .vehicles
            .cars()
            .filter(|st| self.vehicles.is_awake(st.c))
            .map(Into::into)
            .collect();
        let all_cars: Vec<WireCarState> = self.vehicles.cars().map(Into::into).collect();

        let recipients: Vec<(String, u16, bool)> = self
            .players
            .values()
            .filter(|pl| pl.link.is_some() && pl.zone.id == world::COURTYARD.id)
            .map(|pl| {
                (
                    pl.id.clone(),
                    if pl.riding.is_some() {
                        pl.last_drive_seq
                    } else {
                        0
                    },
                    pl.needs_cars_sync,
                )
            })
            .collect();

        for (id, ack, needs_sync) in recipients {
            let cars = if needs_sync { &all_cars } else { &awake_cars };
            let msg = ServerMessage::Cars {
                ack,
                cars: cars.clone(),
            };
            let Some(pl) = self.players.get_mut(&id) else { continue };
            let Some(link) = &pl.link else { continue };
            match link.tx.try_send(msg) {
                Ok(()) => {
                    if needs_sync {
                        pl.needs_cars_sync = false;
                    }
                }
                Err(TrySendError::Full(_)) => {
                    pl.needs_cars_sync = true;
                    self.metrics.batch_dropped(false);
                }
                Err(TrySendError::Closed(_)) => {
                    self.detach(&id, now);
                }
            }
        }
    }
}
