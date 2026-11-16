//! 每連線的速率限制（token bucket）。BACKEND_TASKS T4：`move`／`stop` 每秒 15 則、
//! `action` 每秒 2 則、全部訊息每秒 30 則；超出的訊息丟棄並計數，連續超出達設定時間即關閉連線。

use crate::protocol::ClientMessage;
use std::time::Duration;
use tokio::time::Instant;

const ALL_PER_SEC: f64 = 30.0;
const POSITION_PER_SEC: f64 = 15.0;
const ACTION_PER_SEC: f64 = 2.0;
/// 位置訊息只容許很小的突發量，持續每秒 30 則時才會被壓到約 15 則。
const POSITION_BURST: f64 = 3.0;
/// action 的突發量：正常操作最多連續 3 則（誦經剛開始就按別的動作＝chant → chant_end → 新動作），
/// 各動作的冷卻讓第 4 則不會緊接著出現。每秒補充仍是 ACTION_PER_SEC。
const ACTION_BURST: f64 = 3.0;
/// 聊天：突發 3 則，每秒補充 0.5 則。
const CHAT_BURST: f64 = 3.0;
const CHAT_PER_SEC: f64 = 0.5;
/// 更換衣裝：與聊天相同的規則（突發 3 則，每 2 秒補 1 則），計數各自獨立。
const OUTFIT_BURST: f64 = 3.0;
const OUTFIT_PER_SEC: f64 = 0.5;
/// 兩次丟棄相隔不超過這段時間，才算「連續」超出。
const STREAK_GAP: Duration = Duration::from_secs(1);
/// 連續超出多久就關閉連線。
pub const DEFAULT_CLOSE_AFTER: Duration = Duration::from_secs(5);

struct Bucket {
    tokens: f64,
    capacity: f64,
    per_sec: f64,
    at: Instant,
}
impl Bucket {
    fn new(capacity: f64, per_sec: f64, now: Instant) -> Self {
        Self {
            tokens: capacity,
            capacity,
            per_sec,
            at: now,
        }
    }
    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.per_sec).min(self.capacity);
        self.at = now;
    }
    fn has_token(&mut self, now: Instant) -> bool {
        self.refill(now);
        self.tokens >= 1.0
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Drop,
    /// 連續超出達上限：關閉連線（1008）。
    Close,
}

pub struct RateLimiter {
    all: Bucket,
    position: Bucket,
    action: Bucket,
    chat: Bucket,
    outfit: Bucket,
    close_after: Duration,
    /// 目前這一段連續超出的起點與最近一次丟棄的時間。
    streak: Option<(Instant, Instant)>,
    pub dropped: u64,
}

impl RateLimiter {
    pub fn new(now: Instant, close_after: Duration) -> Self {
        Self {
            all: Bucket::new(ALL_PER_SEC, ALL_PER_SEC, now),
            position: Bucket::new(POSITION_BURST, POSITION_PER_SEC, now),
            action: Bucket::new(ACTION_BURST, ACTION_PER_SEC, now),
            chat: Bucket::new(CHAT_BURST, CHAT_PER_SEC, now),
            outfit: Bucket::new(OUTFIT_BURST, OUTFIT_PER_SEC, now),
            close_after,
            streak: None,
            dropped: 0,
        }
    }

    pub fn admit(&mut self, message: &ClientMessage, now: Instant) -> Verdict {
        let mut specific = match message {
            ClientMessage::Move { .. } | ClientMessage::Stop { .. } => Some(&mut self.position),
            ClientMessage::Action { .. } => Some(&mut self.action),
            ClientMessage::Chat { .. } => Some(&mut self.chat),
            ClientMessage::Outfit { .. } => Some(&mut self.outfit),
            _ => None,
        };
        let allowed = self.all.has_token(now) && specific.as_mut().is_none_or(|b| b.has_token(now));
        if !allowed {
            return self.drop_message(now);
        }
        self.all.tokens -= 1.0;
        if let Some(bucket) = specific {
            bucket.tokens -= 1.0;
        }
        Verdict::Pass
    }

    /// 補送先前被丟棄的最新位置：有額度才扣；沒有額度不算一次丟棄。
    pub fn admit_held(&mut self, now: Instant) -> bool {
        let allowed = self.all.has_token(now) && self.position.has_token(now);
        if allowed {
            self.all.tokens -= 1.0;
            self.position.tokens -= 1.0;
        }
        allowed
    }

    fn drop_message(&mut self, now: Instant) -> Verdict {
        self.dropped += 1;
        let start = match self.streak {
            Some((start, last)) if now.saturating_duration_since(last) < STREAK_GAP => start,
            _ => now,
        };
        self.streak = Some((start, now));
        if now.saturating_duration_since(start) >= self.close_after {
            Verdict::Close
        } else {
            Verdict::Drop
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mv() -> ClientMessage {
        ClientMessage::Move {
            x: 0.0,
            z: 0.0,
            heading: 0.0,
            seq: 0.0,
        }
    }
    fn act() -> ClientMessage {
        ClientMessage::Action {
            req_id: "r".into(),
            id: "bow".into(),
            data: None,
        }
    }
    fn ping() -> ClientMessage {
        ClientMessage::Ping { ts: 0.0 }
    }

    #[tokio::test(start_paused = true)]
    async fn thirty_moves_per_second_yield_about_fifteen() {
        let t0 = Instant::now();
        let mut limiter = RateLimiter::new(t0, DEFAULT_CLOSE_AFTER);
        let passed = (0..30)
            .filter(|i| {
                limiter.admit(&mv(), t0 + Duration::from_micros(i * 1_000_000 / 30))
                    == Verdict::Pass
            })
            .count();
        assert!((15..=18).contains(&passed), "{passed}");
        assert_eq!(limiter.dropped, 30 - passed as u64);
    }

    #[tokio::test(start_paused = true)]
    async fn held_position_passes_once_a_token_is_back_without_counting_as_drop() {
        let t0 = Instant::now();
        let mut limiter = RateLimiter::new(t0, DEFAULT_CLOSE_AFTER);
        for _ in 0..3 {
            assert_eq!(limiter.admit(&mv(), t0), Verdict::Pass);
        }
        assert!(!limiter.admit_held(t0));
        assert_eq!(limiter.dropped, 0);
        assert!(limiter.admit_held(t0 + Duration::from_millis(70)));
    }

    #[tokio::test(start_paused = true)]
    async fn action_and_total_limits() {
        let t0 = Instant::now();
        let mut limiter = RateLimiter::new(t0, DEFAULT_CLOSE_AFTER);
        let verdicts: Vec<_> = (0..5).map(|_| limiter.admit(&act(), t0)).collect();
        assert_eq!(
            verdicts,
            [
                Verdict::Pass,
                Verdict::Pass,
                Verdict::Pass,
                Verdict::Drop,
                Verdict::Drop
            ]
        );
        // 全部訊息：30 則通過，第 31 則被丟棄
        let mut limiter = RateLimiter::new(t0, DEFAULT_CLOSE_AFTER);
        let passed = (0..31)
            .filter(|_| limiter.admit(&ping(), t0) == Verdict::Pass)
            .count();
        assert_eq!(passed, 30);
        // 一秒後補滿
        assert_eq!(
            limiter.admit(&ping(), t0 + Duration::from_secs(1)),
            Verdict::Pass
        );
    }

    #[tokio::test(start_paused = true)]
    async fn outfit_has_its_own_burst_of_three_independent_of_chat() {
        let t0 = Instant::now();
        let mut limiter = RateLimiter::new(t0, DEFAULT_CLOSE_AFTER);
        let outfit = ClientMessage::Outfit {
            outfit: serde_json::json!(1),
        };
        let chat = ClientMessage::Chat { text: "a".into() };
        let passed = (0..5)
            .filter(|_| limiter.admit(&outfit, t0) == Verdict::Pass)
            .count();
        assert_eq!(passed, 3);
        assert_eq!(limiter.admit(&chat, t0), Verdict::Pass);
        assert_eq!(
            limiter.admit(&outfit, t0 + Duration::from_secs(1)),
            Verdict::Drop
        );
        assert_eq!(
            limiter.admit(&outfit, t0 + Duration::from_secs(2)),
            Verdict::Pass
        );
    }

    #[tokio::test(start_paused = true)]
    async fn chat_burst_three_then_one_per_two_seconds() {
        let t0 = Instant::now();
        let mut limiter = RateLimiter::new(t0, DEFAULT_CLOSE_AFTER);
        let chat = ClientMessage::Chat { text: "a".into() };
        let passed = (0..5)
            .filter(|_| limiter.admit(&chat, t0) == Verdict::Pass)
            .count();
        assert_eq!(passed, 3);
        assert_eq!(
            limiter.admit(&chat, t0 + Duration::from_secs(1)),
            Verdict::Drop
        );
        assert_eq!(
            limiter.admit(&chat, t0 + Duration::from_secs(2)),
            Verdict::Pass
        );
    }

    #[tokio::test(start_paused = true)]
    async fn closes_only_after_continuous_overage() {
        let t0 = Instant::now();
        let mut limiter = RateLimiter::new(t0, Duration::from_secs(5));
        // 每 100 ms 一則 action（10/s，遠高於 2/s）：連續超出滿 5 秒才關閉
        let mut closed_at = None;
        for i in 0..80u64 {
            let at = t0 + Duration::from_millis(i * 100);
            if limiter.admit(&act(), at) == Verdict::Close {
                closed_at = Some(i * 100);
                break;
            }
        }
        let closed_at = closed_at.unwrap();
        assert!((5000..=5600).contains(&closed_at), "{closed_at}");
        // 中間停手超過 1 秒就重新計算
        let mut limiter = RateLimiter::new(t0, Duration::from_secs(5));
        for burst in 0..3u64 {
            let start = t0 + Duration::from_secs(burst * 4);
            for i in 0..30u64 {
                let at = start + Duration::from_millis(i * 100);
                assert_ne!(limiter.admit(&act(), at), Verdict::Close, "burst {burst}");
            }
        }
    }
}
