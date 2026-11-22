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

        // 速率 2.5 → 2.0 (2.5 * 0.6 = 1.5 < 2.0)
        assert_eq!(knock_distance(2.5, k), 2.0);
        // 速率 5.0 → 3.0 (5.0 * 0.6 = 3.0)
        assert_eq!(knock_distance(5.0, k), 3.0);
        // 速率 20.0 → 5.0 (20.0 * 0.6 = 12.0 > 5.0)
        assert_eq!(knock_distance(20.0, k), 5.0);
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
        // 由 (18, 0) 朝 +x 飛 5 公尺 → x <= 19
        let (lx, _lz) = knock_landing(&world::COURTYARD, 18.0, 0.0, 1.0, 0.0, 5.0);
        assert!(lx <= 19.0, "lx was {lx}");
    }
}
