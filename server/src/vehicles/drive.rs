//! 碰碰車駕駛動力學純函式（與前端完全一致）。

use super::params::CarParams;
use std::f32::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DriveInput {
    pub dir: f32,
    pub mag: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CarMotion {
    pub heading: f32,
    pub vx: f32,
    pub vz: f32,
    pub w: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DriveOutput {
    pub force: f32,
    pub w: f32,
    pub lateral_keep: f32,
}

pub fn wrap_angle(a: f32) -> f32 {
    let wrapped = (a + PI).rem_euclid(2.0 * PI) - PI;
    if wrapped <= -PI { PI } else { wrapped }
}

pub fn drive(m: &CarMotion, input: &DriveInput, p: &CarParams) -> DriveOutput {
    let speed = m.vx * m.heading.sin() + m.vz * m.heading.cos();
    let lateral_keep = 1.0 - p.lateral_grip;
    if input.mag <= 0.0 {
        return DriveOutput {
            force: 0.0,
            w: m.w,
            lateral_keep,
        };
    }

    let diff = wrap_angle(input.dir - m.heading);
    let reversing = diff.abs() > p.reverse_angle && speed < p.reverse_below_speed;
    let (err, force) = if reversing {
        let err = wrap_angle(input.dir - (m.heading + PI));
        let force = if speed > -p.reverse_max_speed {
            -p.drive_force * input.mag
        } else {
            0.0
        };
        (err, force)
    } else {
        let err = diff;
        let force = if speed < p.max_speed {
            p.drive_force * input.mag * diff.cos().max(0.2)
        } else {
            0.0
        };
        (err, force)
    };

    let steer_scale = 0.3 + 0.7 * (speed.abs() / 2.0).min(1.0);
    let target_w = (err * p.steer_gain).clamp(-p.turn_rate, p.turn_rate) * steer_scale;
    let w = m.w + (target_w - m.w) * p.steer_blend;

    DriveOutput {
        force,
        w,
        lateral_keep,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vehicles::params::params;

    #[test]
    fn released_stick_applies_no_force_and_keeps_spin() {
        let p = &params().car;
        let m = CarMotion {
            heading: 0.0,
            vx: 0.0,
            vz: 0.0,
            w: 1.0,
        };
        let input = DriveInput { dir: 0.0, mag: 0.0 };
        let out = drive(&m, &input, p);
        assert_eq!(out.force, 0.0);
        assert_eq!(out.w, 1.0);
    }

    #[test]
    fn full_stick_ahead_pushes_forward() {
        let p = &params().car;
        let m = CarMotion {
            heading: 0.0,
            vx: 0.0,
            vz: 0.0,
            w: 0.0,
        };
        let input = DriveInput { dir: 0.0, mag: 1.0 };
        let out = drive(&m, &input, p);
        assert_eq!(out.force, 1400.0);
        assert!(out.w.abs() < 1e-6);
    }

    #[test]
    fn no_force_at_max_speed() {
        let p = &params().car;
        let m = CarMotion {
            heading: 0.0,
            vx: 0.0,
            vz: 8.0,
            w: 0.0,
        };
        let input = DriveInput { dir: 0.0, mag: 1.0 };
        let out = drive(&m, &input, p);
        assert_eq!(out.force, 0.0);
    }

    #[test]
    fn steers_toward_target_on_the_short_side() {
        let p = &params().car;
        let m = CarMotion {
            heading: 3.0,
            vx: 0.0,
            vz: 0.0,
            w: 0.0,
        };
        let input = DriveInput {
            dir: -3.0,
            mag: 1.0,
        };
        let out = drive(&m, &input, p);
        assert!(out.w > 0.0);
    }

    #[test]
    fn stick_behind_at_low_speed_reverses() {
        let p = &params().car;
        let m = CarMotion {
            heading: 0.0,
            vx: 0.0,
            vz: 0.0,
            w: 0.0,
        };
        let input = DriveInput { dir: PI, mag: 1.0 };
        let out = drive(&m, &input, p);
        assert_eq!(out.force, -1400.0);
        assert!(out.w.abs() < 1e-6);
    }

    #[test]
    fn stick_behind_at_high_speed_keeps_turning_forward() {
        let p = &params().car;
        let m = CarMotion {
            heading: 0.0,
            vx: 0.0,
            vz: 5.0,
            w: 0.0,
        };
        let input = DriveInput { dir: PI, mag: 1.0 };
        let out = drive(&m, &input, p);
        assert!(out.force >= 0.0);
        assert!(out.w != 0.0);
    }

    #[test]
    fn wrap_angle_maps_to_half_open_range() {
        assert_eq!(wrap_angle(PI), PI);
        assert_eq!(wrap_angle(-PI), PI);
        assert!((wrap_angle(3.0 * PI / 2.0) - (-PI / 2.0)).abs() < 1e-6);
    }
}
