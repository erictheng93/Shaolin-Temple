use serde::{Deserialize, Serialize};

pub const BODY_RADIUS: f64 = 0.3;
pub const MIN_DIST: f64 = 0.6;
pub const TOLERANCE: f64 = 0.15;
pub const SEPARATE_PER_TICK: f64 = 0.1;
pub const VIEW_DELAY_TICKS: usize = 2;
pub const HISTORY_TICKS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Body {
    pub n: u8,
    pub x: f64,
    pub z: f64,
    pub rooted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Moved {
    pub n: u8,
    pub x: f64,
    pub z: f64,
}

/// 回傳 mover 的新位置與被推動的人。others 在這裡依 n 由小到大排序（與前端相同），呼叫端不必先排。
pub fn resolve_move(
    mover: (f64, f64),
    prev: (f64, f64),
    others: &[Body],
    tolerance: f64,
    valid: impl Fn(f64, f64) -> bool,
) -> ((f64, f64), Vec<Moved>) {
    let mut current_mover = mover;
    let mut others = others.to_vec();
    others.sort_by_key(|b| b.n);
    let mut current_others = others.clone();

    for _ in 0..2 {
        for o in &mut current_others {
            let dx = current_mover.0 - o.x;
            let dz = current_mover.1 - o.z;
            let d = (dx * dx + dz * dz).sqrt();
            let pen = MIN_DIST - d;
            if pen <= tolerance {
                continue;
            }

            let (ux, uz) = if d < 1e-9 {
                let pdx = prev.0 - o.x;
                let pdz = prev.1 - o.z;
                let pd = (pdx * pdx + pdz * pdz).sqrt();
                if pd < 1e-9 {
                    (1.0, 0.0)
                } else {
                    (pdx / pd, pdz / pd)
                }
            } else {
                (dx / d, dz / d)
            };

            let mut share = if o.rooted { 0.0 } else { 0.5 };
            if share > 0.0 {
                let bx = o.x - ux * pen * share;
                let bz = o.z - uz * pen * share;
                if valid(bx, bz) {
                    o.x = bx;
                    o.z = bz;
                } else {
                    share = 0.0;
                }
            }
            current_mover.0 += ux * pen * (1.0 - share);
            current_mover.1 += uz * pen * (1.0 - share);
        }
    }

    if !valid(current_mover.0, current_mover.1) {
        current_mover = prev;
    }

    let moved: Vec<Moved> = current_others
        .iter()
        .zip(others.iter())
        .filter_map(|(cur, orig)| {
            if (cur.x - orig.x).abs() > 1e-9 || (cur.z - orig.z).abs() > 1e-9 {
                Some(Moved {
                    n: cur.n,
                    x: cur.x,
                    z: cur.z,
                })
            } else {
                None
            }
        })
        .collect();

    (current_mover, moved)
}

pub fn separate(bodies: &[Body], valid: impl Fn(f64, f64) -> bool) -> Vec<Moved> {
    let mut local = bodies.to_vec();
    local.sort_by_key(|b| b.n);

    let len = local.len();
    let mut deltas = vec![(0.0f64, 0.0f64); len];

    for i in 0..len {
        for j in (i + 1)..len {
            let dx = local[i].x - local[j].x;
            let dz = local[i].z - local[j].z;
            let d = (dx * dx + dz * dz).sqrt();
            let pen = MIN_DIST - d;
            if pen <= 1e-3 {
                continue;
            }
            if local[i].rooted && local[j].rooted {
                continue;
            }

            // 方向由 j 指向 i；d < 1e-9 時取 (-1, 0)，即 n 小的往 −x
            let (ux, uz) = if d < 1e-9 {
                (-1.0, 0.0)
            } else {
                (dx / d, dz / d)
            };

            let (shift_i, shift_j) = if local[i].rooted {
                (0.0, pen)
            } else if local[j].rooted {
                (pen, 0.0)
            } else {
                (pen / 2.0, pen / 2.0)
            };

            deltas[i].0 += ux * shift_i;
            deltas[i].1 += uz * shift_i;
            deltas[j].0 -= ux * shift_j;
            deltas[j].1 -= uz * shift_j;
        }
    }

    for i in 0..len {
        if local[i].rooted {
            continue;
        }
        let (dx, dz) = deltas[i];
        let mag = (dx * dx + dz * dz).sqrt();
        if mag > 1e-9 {
            let scale = if mag > SEPARATE_PER_TICK {
                SEPARATE_PER_TICK / mag
            } else {
                1.0
            };
            let new_x = local[i].x + dx * scale;
            let new_z = local[i].z + dz * scale;
            if valid(new_x, new_z) {
                local[i].x = new_x;
                local[i].z = new_z;
            }
        }
    }

    let mut moved = Vec::new();
    for b in &local {
        let is_moved = bodies
            .iter()
            .find(|orig| orig.n == b.n)
            .is_some_and(|orig| (b.x - orig.x).abs() > 1e-9 || (b.z - orig.z).abs() > 1e-9);
        if is_moved {
            moved.push(Moved {
                n: b.n,
                x: b.x,
                z: b.z,
            });
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_on_overlap_is_split_evenly() {
        let mover = (0.2, 0.0);
        let prev = (-1.0, 0.0);
        let others = [Body {
            n: 2,
            x: 0.5,
            z: 0.0,
            rooted: false,
        }];
        let (new_mover, pushed) = resolve_move(mover, prev, &others, 0.0, |_, _| true);
        assert!(
            (new_mover.0 - 0.05).abs() < 1e-9,
            "mover x: {}",
            new_mover.0
        );
        assert!((new_mover.1 - 0.0).abs() < 1e-9, "mover z: {}", new_mover.1);
        assert_eq!(pushed.len(), 1);
        assert_eq!(pushed[0].n, 2);
        assert!(
            (pushed[0].x - 0.65).abs() < 1e-9,
            "pushed x: {}",
            pushed[0].x
        );
        assert!(
            (pushed[0].z - 0.0).abs() < 1e-9,
            "pushed z: {}",
            pushed[0].z
        );
    }

    #[test]
    fn rooted_body_does_not_move_and_mover_takes_all() {
        let mover = (0.2, 0.0);
        let prev = (-1.0, 0.0);
        let others = [Body {
            n: 2,
            x: 0.5,
            z: 0.0,
            rooted: true,
        }];
        let (new_mover, pushed) = resolve_move(mover, prev, &others, 0.0, |_, _| true);
        assert!(
            (new_mover.0 - (-0.1)).abs() < 1e-9,
            "mover x: {}",
            new_mover.0
        );
        assert!((new_mover.1 - 0.0).abs() < 1e-9, "mover z: {}", new_mover.1);
        assert!(
            pushed.is_empty(),
            "pushed should be empty, got {:?}",
            pushed
        );
    }

    #[test]
    fn pushed_body_blocked_by_a_wall_makes_the_mover_stop() {
        let mover = (0.2, 0.0);
        let prev = (-1.0, 0.0);
        let others = [Body {
            n: 2,
            x: 0.5,
            z: 0.0,
            rooted: false,
        }];
        let valid = |x: f64, _z: f64| x <= 0.6;
        let (new_mover, pushed) = resolve_move(mover, prev, &others, 0.0, valid);
        assert!(
            (new_mover.0 - (-0.1)).abs() < 1e-9,
            "mover x: {}",
            new_mover.0
        );
        assert!((new_mover.1 - 0.0).abs() < 1e-9, "mover z: {}", new_mover.1);
        assert!(
            pushed.is_empty(),
            "pushed should be empty, got {:?}",
            pushed
        );
    }

    #[test]
    fn overlap_within_tolerance_is_left_alone() {
        // mover at (0.0, 0.0), other at (0.5, 0.0) -> distance = 0.5, pen = 0.6 - 0.5 = 0.1 <= tolerance (0.15)
        let mover = (0.0, 0.0);
        let prev = (-1.0, 0.0);
        let others = [Body {
            n: 2,
            x: 0.5,
            z: 0.0,
            rooted: false,
        }];
        let (new_mover, pushed) = resolve_move(mover, prev, &others, TOLERANCE, |_, _| true);
        assert!((new_mover.0 - 0.0).abs() < 1e-9, "mover x: {}", new_mover.0);
        assert!((new_mover.1 - 0.0).abs() < 1e-9, "mover z: {}", new_mover.1);
        assert!(
            pushed.is_empty(),
            "pushed should be empty, got {:?}",
            pushed
        );
    }

    #[test]
    fn coincident_bodies_separate_deterministically() {
        let mover = (0.0, 0.0);
        let prev = (0.0, 0.0);
        let others = [Body {
            n: 2,
            x: 0.0,
            z: 0.0,
            rooted: false,
        }];
        let (new_mover, pushed) = resolve_move(mover, prev, &others, 0.0, |_, _| true);
        assert!(!new_mover.0.is_nan());
        assert!(!new_mover.1.is_nan());
        assert!(
            new_mover.0 > 0.0,
            "mover x should be > 0, got {}",
            new_mover.0
        );
        assert_eq!(pushed.len(), 1);
        assert!(!pushed[0].x.is_nan());
        assert!(!pushed[0].z.is_nan());
        assert!(
            pushed[0].x < 0.0,
            "pushed x should be < 0, got {}",
            pushed[0].x
        );
    }

    #[test]
    fn mover_returns_to_prev_when_resolved_position_is_invalid() {
        let mover = (0.2, 0.0);
        let prev = (-0.5, 0.0);
        let others = [Body {
            n: 2,
            x: 0.5,
            z: 0.0,
            rooted: true,
        }];
        // mover would resolve to -0.1, but valid only allows x <= -0.2, so mover must fall back to prev (-0.5)
        let valid = |x: f64, _z: f64| x <= -0.2;
        let (new_mover, _pushed) = resolve_move(mover, prev, &others, 0.0, valid);
        assert_eq!(new_mover, prev);
    }

    #[test]
    fn separate_moves_each_at_most_the_per_tick_limit() {
        // bodies at (0.0, 0.0) and (0.2, 0.0) -> distance = 0.2, pen = 0.4.
        // pen / 2 = 0.2 > SEPARATE_PER_TICK (0.1). Each should move exactly 0.1.
        let bodies = [
            Body {
                n: 1,
                x: 0.0,
                z: 0.0,
                rooted: false,
            },
            Body {
                n: 2,
                x: 0.2,
                z: 0.0,
                rooted: false,
            },
        ];
        let moved = separate(&bodies, |_, _| true);
        assert_eq!(moved.len(), 2);
        // n: 1 moves toward -x by 0.1 -> -0.1
        assert_eq!(moved[0].n, 1);
        assert!((moved[0].x - (-0.1)).abs() < 1e-9, "n=1 x: {}", moved[0].x);
        // n: 2 moves toward +x by 0.1 -> 0.3
        assert_eq!(moved[1].n, 2);
        assert!((moved[1].x - 0.3).abs() < 1e-9, "n=2 x: {}", moved[1].x);
    }

    #[test]
    fn separate_leaves_two_rooted_bodies_alone() {
        let bodies = [
            Body {
                n: 1,
                x: 0.0,
                z: 0.0,
                rooted: true,
            },
            Body {
                n: 2,
                x: 0.2,
                z: 0.0,
                rooted: true,
            },
        ];
        let moved = separate(&bodies, |_, _| true);
        assert!(moved.is_empty(), "rooted bodies should not move");
    }

    // 共用固定資料：前端 `web/src/game/world/collide.test.ts` 讀同一個檔並負責產生 expected，
    // 這裡只讀取並比對（相差須小於 1e-9）。valid(x, z)：有 maxX 時是 x <= maxX，否則一律為真。
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureFile {
        move_cases: Vec<MoveCase>,
        separate_cases: Vec<SeparateCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MoveCase {
        name: String,
        mover: (f64, f64),
        prev: (f64, f64),
        others: Vec<Body>,
        tolerance: f64,
        max_x: Option<f64>,
        expected: MoveExpected,
    }

    #[derive(Deserialize)]
    struct MoveExpected {
        x: f64,
        z: f64,
        moved: Vec<Moved>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SeparateCase {
        name: String,
        bodies: Vec<Body>,
        max_x: Option<f64>,
        expected: Vec<Moved>,
    }

    fn assert_moved_near(name: &str, expected: &[Moved], actual: &[Moved]) {
        assert_eq!(
            expected.iter().map(|m| m.n).collect::<Vec<_>>(),
            actual.iter().map(|m| m.n).collect::<Vec<_>>(),
            "{name}: 被移動的人不同"
        );
        for (e, a) in expected.iter().zip(actual) {
            assert!(
                (e.x - a.x).abs() < 1e-9 && (e.z - a.z).abs() < 1e-9,
                "{name}: n={} 預期 ({}, {})，得到 ({}, {})",
                e.n,
                e.x,
                e.z,
                a.x,
                a.z
            );
        }
    }

    #[test]
    fn collide_script_matches_fixture() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/collide-script.json");
        let file: FixtureFile =
            serde_json::from_str(&std::fs::read_to_string(path).expect("read collide-script.json"))
                .expect("invalid collide-script.json");
        assert!(file.move_cases.len() >= 8 && file.separate_cases.len() >= 4);
        let valid_of = |max_x: Option<f64>| move |x: f64, _z: f64| max_x.is_none_or(|m| x <= m);

        for c in &file.move_cases {
            let (pos, moved) =
                resolve_move(c.mover, c.prev, &c.others, c.tolerance, valid_of(c.max_x));
            assert!(
                (pos.0 - c.expected.x).abs() < 1e-9 && (pos.1 - c.expected.z).abs() < 1e-9,
                "{}: mover 預期 ({}, {})，得到 {pos:?}",
                c.name,
                c.expected.x,
                c.expected.z
            );
            assert_moved_near(&c.name, &c.expected.moved, &moved);
        }
        for c in &file.separate_cases {
            let moved = separate(&c.bodies, valid_of(c.max_x));
            assert_moved_near(&c.name, &c.expected, &moved);
        }
    }

    #[test]
    fn glancing_collision_deflects_both_players_in_two_dimensions() {
        // A 走斜角方向：由 (0.0, 0.0) 走向 (0.3, 0.4)
        // B 位於 (0.5, 0.5)（非對頭，斜向推擠）
        let mover = (0.3, 0.4);
        let prev = (0.0, 0.0);
        let others = [Body {
            n: 2,
            x: 0.5,
            z: 0.5,
            rooted: false,
        }];
        let (new_mover, pushed) = resolve_move(mover, prev, &others, 0.0, |_, _| true);
        assert_eq!(pushed.len(), 1);
        let b = pushed[0];
        // B 應被推向 (+x, +z) 方向，mover 被反推向 (-x, -z) 方向
        assert!(b.x > 0.5, "b.x 應增加：{}", b.x);
        assert!(b.z > 0.5, "b.z 應增加：{}", b.z);
        assert!(new_mover.0 < 0.3, "mover x 應減少：{}", new_mover.0);
        assert!(new_mover.1 < 0.4, "mover z 應減少：{}", new_mover.1);
        let dist = (new_mover.0 - b.x).hypot(new_mover.1 - b.z);
        assert!(
            dist >= MIN_DIST - 1e-4,
            "最終距離應達到 MIN_DIST (0.6)，實際為 {dist}"
        );
    }

    #[test]
    fn player_cornered_by_walls_cannot_be_pushed_and_blocks_mover() {
        // B 緊貼在角落邊界 (15.0, 12.0)
        // 邊界為 x <= 15.0 && z <= 12.0
        let valid = |x: f64, z: f64| x <= 15.0 && z <= 12.0;
        let mover = (14.8, 11.8);
        let prev = (14.4, 11.4);
        let others = [Body {
            n: 2,
            x: 15.0,
            z: 12.0,
            rooted: false,
        }];
        let (new_mover, pushed) = resolve_move(mover, prev, &others, 0.0, valid);
        // B 無法往 (+x, +z) 移動，所以 share = 0，B 不動
        assert!(
            pushed.is_empty(),
            "受困角落的 B 不應移動，實際為: {pushed:?}"
        );
        // mover 承擔所有重疊，被推離
        let dist = (new_mover.0 - 15.0).hypot(new_mover.1 - 12.0);
        assert!(
            dist >= MIN_DIST - 1e-4,
            "mover 應被推至距角落 B 至少 MIN_DIST 處，實際為 {dist}"
        );
    }
}
