//! 執行期指標（Prometheus 文字格式）。全部是 atomic 計數器，熱路徑（房間 actor、連線 task）
//! 只做 `fetch_add`，不加鎖、不配置記憶體；只有 `GET /metrics` 讀取時才組字串。

use crate::protocol::ServerMessage;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use std::{
    fmt::Write,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering::Relaxed},
    },
    time::Duration,
};

/// 伺服器訊息種類，順序對應 `kind_index`。
const KINDS: [&str; 13] = [
    "welcome", "join", "leave", "move", "moves", "sync", "action", "ack", "zone", "pong", "error",
    "chat", "outfit",
];
fn kind_index(message: &ServerMessage) -> usize {
    match message {
        ServerMessage::Welcome { .. } => 0,
        ServerMessage::Join { .. } => 1,
        ServerMessage::Leave { .. } => 2,
        ServerMessage::Move { .. } => 3,
        ServerMessage::Moves { .. } => 4,
        ServerMessage::Sync { .. } => 5,
        ServerMessage::Action { .. } => 6,
        ServerMessage::Ack { .. } => 7,
        ServerMessage::Zone { .. } => 8,
        ServerMessage::Pong { .. } => 9,
        ServerMessage::Error { .. } => 10,
        ServerMessage::Chat { .. } => 11,
        ServerMessage::Outfit { .. } => 12,
    }
}

/// 房間人數分布的區間（含上限）。
const OCCUPANCY: [(&str, usize); 6] = [
    ("0", 0),
    ("1-10", 10),
    ("11-20", 20),
    ("21-30", 30),
    ("31-40", 40),
    ("41-50", usize::MAX),
];
fn occupancy_bucket(players: usize) -> usize {
    OCCUPANCY
        .iter()
        .position(|(_, max)| players <= *max)
        .unwrap_or(OCCUPANCY.len() - 1)
}

/// tick 處理時間直方圖的上界（微秒）；超過最後一個上界的落在 `+Inf`。
const TICK_BUCKETS_US: [u64; 10] = [
    50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 100_000,
];

#[derive(Default)]
pub struct Metrics {
    connections: AtomicU64,
    connections_total: AtomicU64,
    messages_in: AtomicU64,
    bytes_in: AtomicU64,
    rate_limited: AtomicU64,
    out_messages: [AtomicU64; KINDS.len()],
    out_bytes: [AtomicU64; KINDS.len()],
    dropped_moves: AtomicU64,
    dropped_sync: AtomicU64,
    slow_receiver_closed: AtomicU64,
    players: AtomicU64,
    rooms_by_occupancy: [AtomicU64; OCCUPANCY.len()],
    /// 非累積計數，最後一格是 `+Inf`。
    tick_buckets: [AtomicU64; TICK_BUCKETS_US.len() + 1],
    tick_sum_us: AtomicU64,
    tick_max_us: AtomicU64,
}

/// 連線存活期間持有；離開時自動減少連線數。
pub struct ConnectionGuard(Arc<Metrics>);
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Relaxed);
    }
}

fn header_lines(out: &mut String, name: &str, kind: &str, help: &str) {
    let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} {kind}");
}

impl Metrics {
    pub fn connection_opened(self: &Arc<Self>) -> ConnectionGuard {
        self.connections.fetch_add(1, Relaxed);
        self.connections_total.fetch_add(1, Relaxed);
        ConnectionGuard(self.clone())
    }
    pub fn message_in(&self, bytes: usize) {
        self.messages_in.fetch_add(1, Relaxed);
        self.bytes_in.fetch_add(bytes as u64, Relaxed);
    }
    pub fn rate_limited(&self) {
        self.rate_limited.fetch_add(1, Relaxed);
    }
    /// 一則已實際寫到 WebSocket 的伺服器訊息（`bytes` 為酬載長度：JSON 文字或 moves／sync 的二進位幀）。
    pub fn message_out(&self, message: &ServerMessage, bytes: usize) {
        let kind = kind_index(message);
        self.out_messages[kind].fetch_add(1, Relaxed);
        self.out_bytes[kind].fetch_add(bytes as u64, Relaxed);
    }
    /// 可丟棄的 `moves`／`sync` 因發送佇列已滿被丟棄。
    pub fn batch_dropped(&self, sync: bool) {
        let counter = if sync {
            &self.dropped_sync
        } else {
            &self.dropped_moves
        };
        counter.fetch_add(1, Relaxed);
    }
    pub fn slow_receiver_closed(&self) {
        self.slow_receiver_closed.fetch_add(1, Relaxed);
    }
    /// 房間名單人數變動；`old`／`new` 為 `None` 表示房間尚未登記或已結束。
    pub fn room_occupancy(&self, old: Option<usize>, new: Option<usize>) {
        if let Some(n) = old {
            self.rooms_by_occupancy[occupancy_bucket(n)].fetch_sub(1, Relaxed);
            self.players.fetch_sub(n as u64, Relaxed);
        }
        if let Some(n) = new {
            self.rooms_by_occupancy[occupancy_bucket(n)].fetch_add(1, Relaxed);
            self.players.fetch_add(n as u64, Relaxed);
        }
    }
    pub fn tick_done(&self, took: Duration) {
        let us = took.as_micros().min(u128::from(u64::MAX)) as u64;
        let slot = TICK_BUCKETS_US
            .iter()
            .position(|b| us <= *b)
            .unwrap_or(TICK_BUCKETS_US.len());
        self.tick_buckets[slot].fetch_add(1, Relaxed);
        self.tick_sum_us.fetch_add(us, Relaxed);
        self.tick_max_us.fetch_max(us, Relaxed);
    }

    pub fn render(&self) -> String {
        let get = |v: &AtomicU64| v.load(Relaxed);
        let mut o = String::with_capacity(4096);
        let rooms: u64 = self.rooms_by_occupancy.iter().map(get).sum();
        let simple: [(&str, &str, &str, u64); 8] = [
            (
                "temple_connections",
                "gauge",
                "Open WebSocket connections.",
                get(&self.connections),
            ),
            (
                "temple_connections_total",
                "counter",
                "Accepted WebSocket connections.",
                get(&self.connections_total),
            ),
            ("temple_rooms", "gauge", "Active rooms.", rooms),
            (
                "temple_players",
                "gauge",
                "Players on room rosters, including the resume grace period.",
                get(&self.players),
            ),
            (
                "temple_messages_in_total",
                "counter",
                "Text messages received from clients.",
                get(&self.messages_in),
            ),
            (
                "temple_bytes_in_total",
                "counter",
                "Bytes of client text messages received.",
                get(&self.bytes_in),
            ),
            (
                "temple_rate_limited_total",
                "counter",
                "Client messages dropped by the rate limiter.",
                get(&self.rate_limited),
            ),
            (
                "temple_slow_receiver_closed_total",
                "counter",
                "Connections closed because a non-droppable message did not fit the send queue.",
                get(&self.slow_receiver_closed),
            ),
        ];
        for (name, kind, help, value) in simple {
            header_lines(&mut o, name, kind, help);
            let _ = writeln!(o, "{name} {value}");
        }
        header_lines(
            &mut o,
            "temple_rooms_by_players",
            "gauge",
            "Rooms grouped by roster size.",
        );
        for ((label, _), count) in OCCUPANCY.iter().zip(&self.rooms_by_occupancy) {
            let _ = writeln!(
                o,
                "temple_rooms_by_players{{players=\"{label}\"}} {}",
                get(count)
            );
        }
        for (name, help, counters) in [
            (
                "temple_messages_out_total",
                "Messages written to WebSockets, by type.",
                &self.out_messages,
            ),
            (
                "temple_bytes_out_total",
                "Payload bytes (JSON text or binary frame) written to WebSockets, by type.",
                &self.out_bytes,
            ),
        ] {
            header_lines(&mut o, name, "counter", help);
            for (kind, count) in KINDS.iter().zip(counters) {
                let _ = writeln!(o, "{name}{{t=\"{kind}\"}} {}", get(count));
            }
        }
        header_lines(
            &mut o,
            "temple_dropped_total",
            "counter",
            "Droppable batches discarded because the send queue was full.",
        );
        let _ = writeln!(
            o,
            "temple_dropped_total{{t=\"moves\"}} {}",
            get(&self.dropped_moves)
        );
        let _ = writeln!(
            o,
            "temple_dropped_total{{t=\"sync\"}} {}",
            get(&self.dropped_sync)
        );
        header_lines(
            &mut o,
            "temple_tick_seconds",
            "histogram",
            "Room tick processing time.",
        );
        let mut cumulative = 0;
        for (bound, count) in TICK_BUCKETS_US.iter().zip(&self.tick_buckets) {
            cumulative += get(count);
            let _ = writeln!(
                o,
                "temple_tick_seconds_bucket{{le=\"{}\"}} {cumulative}",
                *bound as f64 / 1e6
            );
        }
        cumulative += get(&self.tick_buckets[TICK_BUCKETS_US.len()]);
        let _ = writeln!(o, "temple_tick_seconds_bucket{{le=\"+Inf\"}} {cumulative}");
        let _ = writeln!(
            o,
            "temple_tick_seconds_sum {}",
            get(&self.tick_sum_us) as f64 / 1e6
        );
        let _ = writeln!(o, "temple_tick_seconds_count {cumulative}");
        header_lines(
            &mut o,
            "temple_tick_seconds_max",
            "gauge",
            "Longest room tick processing time since start.",
        );
        let _ = writeln!(
            o,
            "temple_tick_seconds_max {}",
            get(&self.tick_max_us) as f64 / 1e6
        );
        o
    }
}

/// 比較權杖時不因第一個不同字元就提早返回。
fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    let mut diff = a.len() ^ b.len();
    for (i, x) in a.iter().enumerate() {
        diff |= usize::from(x ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

pub async fn handler(State(state): State<crate::AppState>, headers: HeaderMap) -> Response {
    if let Some(expected) = &state.metrics_token {
        let given = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        if !given.is_some_and(|g| token_matches(expected, g)) {
            return (
                StatusCode::UNAUTHORIZED,
                [(header::WWW_AUTHENTICATE, "Bearer")],
            )
                .into_response();
        }
    }
    (
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        state.metrics.render(),
    )
        .into_response()
}
