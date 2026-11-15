//! 場景與動作的伺服器端定義。
//!
//! 數值必須與前端一致：
//! - 庭院邊界、出生點：`web/src/game/world/layout.ts`（`WORLD_BOUNDS` 第 13 行、`SPAWN` 第 15 行）
//! - 殿內邊界、出入口與落點：`web/src/game/world/zones.ts`
//!   （`COURTYARD_DOOR` 第 77 行、`HALL_DOOR` 第 84 行、`ZONES` 第 86～112 行）
//! - 移動速度 3.2 m/s：`web/src/game/GameCore.ts` 的 `MOVE_SPEED`（第 57 行）
//! - 動作允許清單：`web/scripts/mock-server.mjs` 的 `ACTIONS`（前端玩法模組 `gameplay/modules/worship.ts`）
//!
//! - 障礙物：`layout.ts` 的 `OBSTACLES`（主殿、鐘亭、香爐、石燈籠、樹）與 `zones.ts` 殿內的神龕、供桌、柱子，
//!   同樣已含角色半徑 `PLAYER_RADIUS` 的餘量。

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
    /// 線段 (x0,z0)→(x1,z1) 是否穿過這個矩形的內部（Liang–Barsky）。
    pub fn crosses(&self, x0: f64, z0: f64, x1: f64, z1: f64) -> bool {
        let (dx, dz) = (x1 - x0, z1 - z0);
        let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
        for (d, lo, hi) in [
            (dx, self.min_x - x0, self.max_x - x0),
            (dz, self.min_z - z0, self.max_z - z0),
        ] {
            if d == 0.0 {
                if lo >= 0.0 || hi <= 0.0 {
                    return false;
                }
            } else {
                let (a, b) = if d > 0.0 {
                    (lo / d, hi / d)
                } else {
                    (hi / d, lo / d)
                };
                t0 = t0.max(a);
                t1 = t1.min(b);
            }
        }
        t0 < t1
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
    /// 不可走的矩形（已含角色半徑）。
    pub obstacles: &'static [Rect],
}
impl Zone {
    /// 從 (x0,z0) 直線走到 (x1,z1) 是否會穿過障礙物。障礙物先內縮 `OBSTACLE_TOLERANCE`，
    /// 貼著邊走、座標取到 0.01 的正常玩家不會被誤判。起點已在障礙物內時不擋（讓玩家走得出來）。
    pub fn blocked(&self, x0: f64, z0: f64, x1: f64, z1: f64) -> bool {
        self.obstacles.iter().any(|o| {
            let o = o.grow(-OBSTACLE_TOLERANCE);
            !o.contains(x0, z0) && o.crosses(x0, z0, x1, z1)
        })
    }
}

/// 角色半徑，與前端 `PLAYER_RADIUS` 相同。
const PLAYER_RADIUS: f64 = 0.35;
/// 障礙物檢查的容許誤差（公尺）。
pub const OBSTACLE_TOLERANCE: f64 = 0.1;

const fn solid(min_x: f64, max_x: f64, min_z: f64, max_z: f64) -> Rect {
    Rect {
        min_x: min_x - PLAYER_RADIUS,
        max_x: max_x + PLAYER_RADIUS,
        min_z: min_z - PLAYER_RADIUS,
        max_z: max_z + PLAYER_RADIUS,
    }
}
const fn square(x: f64, z: f64, half: f64) -> Rect {
    solid(x - half, x + half, z - half, z + half)
}
const fn tree(x: f64, z: f64, scale: f64) -> Rect {
    square(x, z, 0.5 * scale)
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
    obstacles: &[
        solid(-7.5, 7.5, -18.0, -6.2), // 主殿
        solid(10.0, 14.0, -6.0, -2.0), // 鐘亭
        square(0.0, -1.5, 0.9),        // 香爐
        square(-4.0, 3.0, 0.35),       // 石燈籠
        square(4.0, 3.0, 0.35),
        square(-4.0, -4.0, 0.35),
        square(4.0, -4.0, 0.35),
        tree(-16.0, -14.0, 1.3),
        tree(-15.0, -4.0, 1.0),
        tree(-17.0, 6.0, 1.2),
        tree(-14.0, 14.0, 0.9),
        tree(16.0, -14.0, 1.2),
        tree(17.0, 5.0, 1.1),
        tree(14.0, 14.0, 1.0),
        tree(-9.0, 16.0, 0.8),
        tree(9.0, 16.5, 0.9),
    ],
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
    obstacles: &[
        solid(-7.6, 7.6, -9.0, -5.2), // 神龕台基
        solid(-4.6, 4.6, -4.8, -4.0), // 供桌
        square(-5.2, 5.0, 0.32),      // 柱子
        square(-5.2, 1.0, 0.32),
        square(-5.2, -3.0, 0.32),
        square(5.2, 5.0, 0.32),
        square(5.2, 1.0, 0.32),
        square(5.2, -3.0, 0.32),
    ],
};

pub static ZONES: [&Zone; 2] = [&COURTYARD, &HALL];

pub fn zone(id: &str) -> Option<&'static Zone> {
    ZONES.iter().copied().find(|z| z.id == id)
}

/// 動作允許清單（參拜玩法：合十、跪拜、上香、敲鐘）。快照與廣播中的動作 id 只會來自這份清單。
pub const ACTIONS: [&str; 4] = ["bow", "prostrate", "incense", "bell"];

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
    fn spawns_are_clear_and_obstacles_block_straight_lines_only_through_them() {
        for z in ZONES {
            assert!(!z.obstacles.iter().any(|o| o.contains(z.spawn.x, z.spawn.z)));
            for portal in z.portals {
                let target = zone(portal.to).unwrap();
                let s = portal.spawn;
                assert!(!target.obstacles.iter().any(|o| o.contains(s.x, s.z)));
            }
        }
        // 穿過香爐（中心 0,-1.5，含餘量半寬 1.25）
        assert!(COURTYARD.blocked(0.0, 1.0, 0.0, -4.0));
        // 從旁邊繞過、貼著邊走都不算
        assert!(!COURTYARD.blocked(2.0, 1.0, 2.0, -4.0));
        assert!(!COURTYARD.blocked(1.25, 1.0, 1.25, -4.0));
        // 直接落在障礙物裡
        assert!(COURTYARD.blocked(0.0, 1.0, 0.0, -1.5));
        // 已經在裡面時可以走出來
        assert!(!COURTYARD.blocked(0.0, -1.5, 0.0, 1.0));
        // 殿內穿過柱子
        assert!(HALL.blocked(-6.5, 5.0, -4.0, 5.0));
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
