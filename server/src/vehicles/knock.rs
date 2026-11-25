//! 碰碰車撞飛計算模組。
//!
//! 包含擊飛距離計算與著陸點障礙物/邊界判定。

use crate::vehicles::params::Knock;
use crate::world::Zone;

/// 計算擊飛距離：clamp(speed * distance_per_speed, min_distance, max_distance)。
pub fn knock_distance(speed: f32, k: &Knock) -> f32 {
    (speed * k.distance_per_speed).clamp(k.min_distance, k.max_distance)
}

/// 從 (x, z) 沿 (dx, dz)（單位向量）飛 distance；以 0.25 公尺為一步前進，停在最後一個
/// 在邊界內且不在加邊障礙物內的點。起點本身一定合法。
pub fn knock_landing(zone: &Zone, x: f64, z: f64, dx: f64, dz: f64, distance: f64) -> (f64, f64) {
    let step_size = 0.25;
    let mut last_valid = (x, z);
    let mut traveled = 0.0;
    while traveled + step_size <= distance + 1e-6 {
        traveled += step_size;
        let px = x + dx * traveled;
        let pz = z + dz * traveled;
        if zone.bounds.contains(px, pz) && !zone.obstacles.iter().any(|o| o.contains(px, pz)) {
            last_valid = (px, pz);
        } else {
            return last_valid;
        }
    }
    if distance > traveled + 1e-6 {
        let px = x + dx * distance;
        let pz = z + dz * distance;
        if zone.bounds.contains(px, pz) && !zone.obstacles.iter().any(|o| o.contains(px, pz)) {
            last_valid = (px, pz);
        }
    }
    last_valid
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vehicles::params;
    use crate::world;

    #[test]
    fn knock_distance_clamps() {
        let p = params();
        let k = &p.knock;

        // 剛達門檻的速度：算出的距離不到下限，取下限
        assert_eq!(knock_distance(k.min_speed, k), k.min_distance);
        // 中間值：距離與速度成正比
        let mid = (k.min_distance + k.max_distance) / 2.0;
        let speed = mid / k.distance_per_speed;
        assert!((knock_distance(speed, k) - mid).abs() < 1e-5);
        // 極高速：取上限
        assert_eq!(knock_distance(1000.0, k), k.max_distance);
    }

    #[test]
    fn landing_stops_before_an_obstacle() {
        // 由 (0, 0) 朝 -z（大香爐在 (0, -1.5)）飛 5 公尺 → 落點不在任何加邊障礙物內且 z > -1.5
        let (lx, lz) = knock_landing(&world::COURTYARD, 0.0, 0.0, 0.0, -1.0, 5.0);
        assert!(
            !world::COURTYARD
                .obstacles
                .iter()
                .any(|o| o.contains(lx, lz))
        );
        assert!(lz > -1.5, "lz was {lz}");
    }

    #[test]
    fn landing_stops_inside_bounds() {
        // 由東側邊界內 1 公尺朝 +x 飛 5 公尺 → 不出邊界
        let max_x = world::COURTYARD.bounds.max_x;
        let (lx, _lz) = knock_landing(&world::COURTYARD, max_x - 1.0, 0.0, 1.0, 0.0, 5.0);
        assert!(lx <= max_x, "lx was {lx}");
    }
}
