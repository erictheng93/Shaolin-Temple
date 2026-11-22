//! 車輛共用參數：讀取 `shared/vehicles.json`。

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kind {
    pub id: String,
    pub rarity: String,
    pub count: u8,
    /// 抽車的權重。
    pub weight: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarParams {
    pub half_width: f32,
    pub half_height: f32,
    pub half_length: f32,
    pub mass: f32,
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub restitution: f32,
    pub friction: f32,
    pub max_speed: f32,
    pub reverse_max_speed: f32,
    pub drive_force: f32,
    pub turn_rate: f32,
    pub steer_gain: f32,
    pub steer_blend: f32,
    pub lateral_grip: f32,
    pub reverse_angle: f32,
    pub reverse_below_speed: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Physics {
    pub hz: u32,
    pub max_catch_up_steps: u32,
    pub broadcast_every_steps: u32,
    pub input_timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ride {
    pub mount_radius: f32,
    pub booth_radius: f32,
    pub claim_cooldown_ms: u64,
    pub idle_dismount_ms: u64,
    pub dismount_offset: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fade {
    pub idle_ms: u64,
    pub fade_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Knock {
    pub min_speed: f32,
    pub hit_radius: f32,
    pub distance_per_speed: f32,
    pub min_distance: f32,
    pub max_distance: f32,
    pub flight_ms: u64,
    pub recover_ms: u64,
    pub immune_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoothRect {
    pub min_x: f32,
    pub max_x: f32,
    pub min_z: f32,
    pub max_z: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoothCounter {
    pub x: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bay {
    pub x: f32,
    pub z: f32,
    pub heading: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Booth {
    pub rect: BoothRect,
    pub counter: BoothCounter,
    pub bays: Vec<Bay>,
    /// 遊戲區（西南角的鋪面範圍）：區內的步行者不會被撞飛。
    pub zone: BoothRect,
}

impl BoothRect {
    /// 含邊界。
    pub fn contains(&self, x: f64, z: f64) -> bool {
        (self.min_x as f64..=self.max_x as f64).contains(&x)
            && (self.min_z as f64..=self.max_z as f64).contains(&z)
    }
}

/// 廟會時段：以伺服器毫秒計，每 `period_ms` 一輪，每輪開頭的 `open_ms` 開放領車與上車。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub period_ms: u64,
    pub open_ms: u64,
    pub offset_ms: u64,
}

/// `(server_ms - offset) mod period < open`（以 rem_euclid 取非負餘數）。
pub fn session_open(server_ms: f64, s: &Session) -> bool {
    (server_ms - s.offset_ms as f64).rem_euclid(s.period_ms as f64) < s.open_ms as f64
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub kinds: Vec<Kind>,
    pub car: CarParams,
    pub physics: Physics,
    pub ride: Ride,
    pub fade: Fade,
    pub knock: Knock,
    pub booth: Booth,
    pub session: Session,
}

static PARAMS: OnceLock<Params> = OnceLock::new();

pub fn params() -> &'static Params {
    PARAMS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/vehicles.json"))
            .expect("shared/vehicles.json must be valid")
    })
}

#[cfg(test)]
impl Bay {
    fn y_as_z(&self) -> f64 {
        self.z as f64
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::world::COURTYARD;

    #[test]
    fn kinds_total_ten_and_counts_differ() {
        let p = params();
        let total: u32 = p.kinds.iter().map(|k| k.count as u32).sum();
        assert_eq!(total, 10, "count 總和必須為 10");

        let mut counts: Vec<u8> = p.kinds.iter().map(|k| k.count).collect();
        counts.sort_unstable();
        counts.dedup();
        assert_eq!(counts.len(), 4, "四個車種的 count 必須互不相同");

        let ids: Vec<&str> = p.kinds.iter().map(|k| k.id.as_str()).collect();
        assert_eq!(ids, vec!["classic", "woodfish", "racer", "firewheel"]);
    }

    #[test]
    fn bays_are_inside_courtyard_and_clear_of_solids() {
        let p = params();
        let r = (p.car.half_width as f64).hypot(p.car.half_length as f64);
        let b = &COURTYARD.bounds;

        // 檔口實體矩形（未加角色半徑）
        let booth_r = &p.booth.rect;
        let booth_rect = crate::world::Rect {
            min_x: booth_r.min_x as f64,
            max_x: booth_r.max_x as f64,
            min_z: booth_r.min_z as f64,
            max_z: booth_r.max_z as f64,
        };

        for bay in &p.booth.bays {
            let bx = bay.x as f64;
            let bz = bay.y_as_z();

            // 邊界內（以 r 為半徑的包圍圓都在邊界內）
            assert!(
                bx - r >= b.min_x && bx + r <= b.max_x && bz - r >= b.min_z && bz + r <= b.max_z,
                "bay ({}, {}) 超出庭院邊界",
                bx,
                bz
            );

            // 不與檔口 rect 重疊
            let (cx, cz) = booth_rect.clamp(bx, bz);
            let dist_sq = (bx - cx) * (bx - cx) + (bz - cz) * (bz - cz);
            assert!(
                dist_sq >= r * r,
                "bay ({}, {}) 與檔口矩形重疊（距離 {:.3} < {:.3}）",
                bx,
                bz,
                dist_sq.sqrt(),
                r
            );

            // 不與庭院任何 solids 重疊
            for solid in COURTYARD.solids {
                let (cx, cz) = solid.clamp(bx, bz);
                let dist_sq = (bx - cx) * (bx - cx) + (bz - cz) * (bz - cz);
                assert!(
                    dist_sq >= r * r,
                    "bay ({}, {}) 與 solid {:?} 重疊（距離 {:.3} < {:.3}）",
                    bx,
                    bz,
                    solid,
                    dist_sq.sqrt(),
                    r
                );
            }
        }
    }

    #[test]
    fn session_open_follows_period_and_open_window() {
        let s = &params().session;
        assert!(session_open(0.0, s));
        assert!(session_open(1_799_999.0, s));
        assert!(!session_open(1_800_000.0, s));
        assert!(!session_open(3_599_999.0, s));
        assert!(session_open(3_600_000.0, s));
        // offset 之前（負數）同樣以非負餘數計算。
        let shifted = Session {
            offset_ms: 1_000,
            ..s.clone()
        };
        assert!(!session_open(999.0, &shifted));
        assert!(session_open(1_000.0, &shifted));
    }

    #[test]
    fn zone_contains_booth_counter_and_bays() {
        let p = params();
        let zone = &p.booth.zone;
        let r = &p.booth.rect;
        for (x, z) in [
            (r.min_x, r.min_z),
            (r.min_x, r.max_z),
            (r.max_x, r.min_z),
            (r.max_x, r.max_z),
        ] {
            assert!(zone.contains(x as f64, z as f64), "rect corner ({x}, {z})");
        }
        assert!(zone.contains(p.booth.counter.x as f64, p.booth.counter.z as f64));
        for bay in &p.booth.bays {
            assert!(
                zone.contains(bay.x as f64, bay.z as f64),
                "bay ({}, {})",
                bay.x,
                bay.z
            );
        }
    }
}
