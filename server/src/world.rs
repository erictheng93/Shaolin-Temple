//! 場景與動作的伺服器端定義。
//!
//! 數值必須與前端一致：
//! - 庭院邊界、出生點：`web/src/game/world/layout.ts`（`WORLD_BOUNDS` 第 13 行、`SPAWN` 第 15 行）
//! - 殿內邊界、出入口與落點：`web/src/game/world/zones.ts`
//!   （`COURTYARD_DOOR` 第 77 行、`HALL_DOOR` 第 84 行、`ZONES` 第 86～112 行）
//! - 移動速度 3.2 m/s：`web/src/game/GameCore.ts` 的 `MOVE_SPEED`（第 57 行）
//! - 動作允許清單：`web/scripts/mock-server.mjs` 的 `ACTIONS`（前端示範模組 `gameplay/modules/demo.ts`）
//!
//! 伺服器目前只驗證邊界與出入口，不模擬障礙物（BACKEND_TASKS T4 未要求）。

use std::f64::consts::PI;

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub min_x: f64,
    pub max_x: f64,
    pub min_z: f64,
    pub max_z: f64,
}
impl Rect {
    pub fn contains(&self, x: f64, z: f64) -> bool {
        (self.min_x..=self.max_x).contains(&x) && (self.min_z..=self.max_z).contains(&z)
    }
    pub fn grow(&self, m: f64) -> Rect {
        Rect {
            min_x: self.min_x - m,
            max_x: self.max_x + m,
            min_z: self.min_z - m,
            max_z: self.max_z + m,
        }
    }
    pub fn clamp(&self, x: f64, z: f64) -> (f64, f64) {
        (
            x.clamp(self.min_x, self.max_x),
            z.clamp(self.min_z, self.max_z),
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Pose {
    pub x: f64,
    pub z: f64,
    pub heading: f64,
}

/// 出入口：玩家站在 `rect`（容許 `PORTAL_TOLERANCE`）時可切到 `to`，並出現在 `spawn`。
#[derive(Debug)]
pub struct Portal {
    pub rect: Rect,
    pub to: &'static str,
    pub spawn: Pose,
}

#[derive(Debug)]
pub struct Zone {
    pub id: &'static str,
    pub bounds: Rect,
    pub spawn: Pose,
    pub portals: &'static [Portal],
}

/// 出入口範圍的容許誤差（公尺）。
pub const PORTAL_TOLERANCE: f64 = 0.5;

pub static COURTYARD: Zone = Zone {
    id: "courtyard",
    bounds: Rect {
        min_x: -19.0,
        max_x: 19.0,
        min_z: -19.0,
        max_z: 18.0,
    },
    spawn: Pose {
        x: 0.0,
        z: 11.0,
        heading: PI,
    },
    portals: &[Portal {
        rect: Rect {
            min_x: -1.6,
            max_x: 1.6,
            min_z: -6.2,
            max_z: -5.0,
        },
        to: "hall",
        spawn: Pose {
            x: 0.0,
            z: 7.4,
            heading: PI,
        },
    }],
};

pub static HALL: Zone = Zone {
    id: "hall",
    bounds: Rect {
        min_x: -7.4,
        max_x: 7.4,
        min_z: -5.2,
        max_z: 8.6,
    },
    spawn: Pose {
        x: 0.0,
        z: 7.4,
        heading: PI,
    },
    portals: &[Portal {
        rect: Rect {
            min_x: -1.4,
            max_x: 1.4,
            min_z: 8.15,
            max_z: 9.0,
        },
        to: "courtyard",
        spawn: Pose {
            x: 0.0,
            z: -3.6,
            heading: 0.0,
        },
    }],
};

pub static ZONES: [&Zone; 2] = [&COURTYARD, &HALL];

pub fn zone(id: &str) -> Option<&'static Zone> {
    ZONES.iter().copied().find(|z| z.id == id)
}

/// 動作允許清單（示範用）。快照與廣播中的動作 id 只會來自這份清單。
pub const ACTIONS: [&str; 3] = ["bow", "bowl", "bell"];

/// 回傳清單中的同名動作；不在清單內為 `None`。
pub fn action(id: &str) -> Option<&'static str> {
    ACTIONS.iter().copied().find(|a| *a == id)
}

/// 移動速度（公尺／秒），與前端 `MOVE_SPEED` 相同。
pub const MOVE_SPEED: f64 = 3.2;

/// `heading` 正規化到 (−π, π]。
pub fn normalize_heading(heading: f64) -> f64 {
    let wrapped = (heading + PI).rem_euclid(2.0 * PI) - PI;
    if wrapped <= -PI { PI } else { wrapped }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawns_are_inside_bounds_and_do_not_retrigger_portals() {
        for z in ZONES {
            assert!(z.bounds.contains(z.spawn.x, z.spawn.z), "{}", z.id);
            for portal in z.portals {
                let target = zone(portal.to).unwrap();
                assert!(target.bounds.contains(portal.spawn.x, portal.spawn.z));
                // 落點不能落在目標場景任何出入口的容許範圍內，否則一進場就能立刻切回。
                for back in target.portals {
                    assert!(
                        !back
                            .rect
                            .grow(PORTAL_TOLERANCE)
                            .contains(portal.spawn.x, portal.spawn.z)
                    );
                }
            }
        }
    }

    #[test]
    fn heading_wraps_into_half_open_range() {
        assert_eq!(normalize_heading(0.5), 0.5);
        assert!((normalize_heading(7.0) - (7.0 - 2.0 * PI)).abs() < 1e-12);
        assert!((normalize_heading(-7.0) - (-7.0 + 2.0 * PI)).abs() < 1e-12);
        assert_eq!(normalize_heading(PI), PI);
        assert_eq!(normalize_heading(-PI), PI);
        assert!(normalize_heading(1e300).abs() <= PI);
    }
}
