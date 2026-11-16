//! 負載測試工具：模擬多位玩家連線到伺服器，依前端行為送出 `hello`、10 Hz `move`、偶發 `action`
//! 與 20 秒一次的 `ping`，量測每連線的接收／送出流量與 `moves` 的到達間隔。
//!
//! 協定版本 3：`moves`／`sync`／`action` 是二進位幀（每則都以 `decode_batch`／`decode_action` 驗證，
//! 解不開的計入 `invalid_frames`），其餘是 JSON 文字。動作從伺服器的允許清單 `world::ACTIONS` 隨機挑選。bytes 計的是 WebSocket 酬載長度；`recv_ws_bytes_per_conn_s` 另外加上
//! 伺服器到客戶端的 WebSocket 框架標頭（2～4 bytes／則），仍不含 TCP／IP 與 TLS。
//!
//! 用法：
//!   loadtest [--url ws://127.0.0.1:8080/ws] [--origin http://localhost:5173]
//!            [--connections 50] [--moving-ratio 0.5] [--seconds 60]
//!            [--ramp-ms 5] [--settle-ms 2000]
//!
//! 全部連線建立後先等 `settle-ms`（讓加入時的 welcome／join 突波過去），再量測 `seconds` 秒。
//! 最後一行輸出是機器可讀的 JSON；其餘是給人看的摘要（stdout）。

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering::Relaxed},
    },
    time::{Duration, Instant},
};
use temple_server::{
    protocol::{BatchKind, FRAME_ACTION, PROTOCOL_VERSION, decode_action, decode_batch},
    world::ACTIONS,
};
use tokio::{
    sync::watch,
    time::{MissedTickBehavior, interval, interval_at, sleep, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest},
};

/// 與伺服器 `world.rs` 的庭院邊界一致，向內縮 1 公尺。
const MIN_X: f64 = -18.0;
const MAX_X: f64 = 18.0;
const MIN_Z: f64 = -18.0;
const MAX_Z: f64 = 17.0;
/// 低於伺服器容許速度（3.2 m/s × 1.5）與前端移動速度 3.2 m/s。
const SPEED: f64 = 2.5;
const SEND_HZ: f64 = 10.0;
const PING_EVERY: Duration = Duration::from_secs(20);

struct Args {
    url: String,
    origin: String,
    connections: usize,
    moving_ratio: f64,
    seconds: u64,
    ramp_ms: u64,
    settle_ms: u64,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        url: "ws://127.0.0.1:8080/ws".into(),
        origin: "http://localhost:5173".into(),
        connections: 50,
        moving_ratio: 0.5,
        seconds: 60,
        ramp_ms: 5,
        settle_ms: 2000,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let value = it.next().ok_or(format!("{flag} 需要一個值"))?;
        let num = |v: &str| {
            v.parse::<f64>()
                .map_err(|_| format!("{flag} 的值無效：{v}"))
        };
        match flag.as_str() {
            "--url" => args.url = value,
            "--origin" => args.origin = value,
            "--connections" => args.connections = num(&value)? as _,
            "--moving-ratio" => args.moving_ratio = num(&value)? as _,
            "--seconds" => args.seconds = num(&value)? as _,
            "--ramp-ms" => args.ramp_ms = num(&value)? as _,
            "--settle-ms" => args.settle_ms = num(&value)? as _,
            _ => return Err(format!("不認得的參數 {flag}")),
        }
    }
    if args.connections == 0 || args.seconds == 0 || !(0.0..=1.0).contains(&args.moving_ratio) {
        return Err("connections、seconds 須大於 0，moving-ratio 須在 0～1".into());
    }
    Ok(args)
}

/// 依訊息種類分開統計接收量，順序對應 `kind_of`。
const KINDS: [&str; 11] = [
    "moves", "sync", "action", "ack", "pong", "join", "leave", "zone", "welcome", "error", "other",
];
const OTHER: usize = KINDS.len() - 1;
fn kind_of(message: &Message) -> usize {
    match message {
        Message::Binary(raw) if raw.first() == Some(&FRAME_ACTION) => {
            decode_action(raw).map_or(OTHER, |_| 2)
        }
        Message::Binary(raw) => match decode_batch(raw) {
            Ok((BatchKind::Moves, _)) => 0,
            Ok((BatchKind::Sync, _)) => 1,
            Err(_) => OTHER,
        },
        // serde 以內部標籤序列化，`t` 一定是第一個欄位：{"t":"action",…
        Message::Text(raw) => raw
            .strip_prefix(r#"{"t":""#)
            .and_then(|rest| rest.split('"').next())
            .and_then(|t| KINDS[2..OTHER].iter().position(|k| *k == t))
            .map_or(OTHER, |i| i + 2),
        _ => OTHER,
    }
}
/// 伺服器送給客戶端的 WebSocket 幀標頭長度（不遮罩）。
fn ws_header(len: usize) -> u64 {
    match len {
        0..126 => 2,
        126..65536 => 4,
        _ => 10,
    }
}

#[derive(Default)]
struct Stats {
    recv_bytes: AtomicU64,
    recv_ws_bytes: AtomicU64,
    by_kind_bytes: [AtomicU64; KINDS.len()],
    by_kind_msgs: [AtomicU64; KINDS.len()],
    /// 解不開的二進位幀（格式錯誤）。
    invalid_frames: AtomicU64,
    recv_msgs: AtomicU64,
    moves_bytes: AtomicU64,
    moves_msgs: AtomicU64,
    sent_bytes: AtomicU64,
    sent_msgs: AtomicU64,
    /// 在我們主動結束之前就被伺服器關閉（或中斷）的連線數（含暖機期間）。
    closed_by_server: AtomicU64,
    /// 是否在量測視窗內（暖機期間的流量不計）。
    measuring: AtomicBool,
}
#[derive(Clone, Copy, Default)]
struct Snapshot {
    recv_bytes: u64,
    recv_ws_bytes: u64,
    by_kind_bytes: [u64; KINDS.len()],
    by_kind_msgs: [u64; KINDS.len()],
    recv_msgs: u64,
    moves_bytes: u64,
    moves_msgs: u64,
    sent_bytes: u64,
    sent_msgs: u64,
}
impl Stats {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            recv_bytes: self.recv_bytes.load(Relaxed),
            recv_ws_bytes: self.recv_ws_bytes.load(Relaxed),
            by_kind_bytes: std::array::from_fn(|i| self.by_kind_bytes[i].load(Relaxed)),
            by_kind_msgs: std::array::from_fn(|i| self.by_kind_msgs[i].load(Relaxed)),
            recv_msgs: self.recv_msgs.load(Relaxed),
            moves_bytes: self.moves_bytes.load(Relaxed),
            moves_msgs: self.moves_msgs.load(Relaxed),
            sent_bytes: self.sent_bytes.load(Relaxed),
            sent_msgs: self.sent_msgs.load(Relaxed),
        }
    }
}

enum Joined {
    Failed(String),
    /// 回傳量測期間收到的 `moves` 間隔（微秒）。
    Done(Vec<u32>),
}

/// 隨機走動：以固定速度前進，碰到邊界就轉向，偶爾隨機轉彎。
struct Walker {
    x: f64,
    z: f64,
    heading: f64,
    seq: u64,
}
impl Walker {
    fn step(&mut self) -> (f64, f64, f64) {
        if rand::random::<f64>() < 0.03 {
            self.heading += rand::random_range(-1.2..1.2);
        }
        let dist = SPEED / SEND_HZ;
        let (mut nx, mut nz) = (
            self.x + self.heading.sin() * dist,
            self.z + self.heading.cos() * dist,
        );
        if !(MIN_X..=MAX_X).contains(&nx) || !(MIN_Z..=MAX_Z).contains(&nz) {
            // 朝場地中心轉向，下一步再走。
            self.heading = (-self.x).atan2(-self.z) + rand::random_range(-0.5..0.5);
            (nx, nz) = (self.x, self.z);
        }
        (self.x, self.z) = (nx, nz);
        self.seq += 1;
        (round2(self.x), round2(self.z), round2(self.heading))
    }
}
fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0 + 0.0
}

async fn player(
    index: usize,
    args: Arc<Args>,
    moving: bool,
    stats: Arc<Stats>,
    mut stop: watch::Receiver<bool>,
) -> Joined {
    let request = match args.url.as_str().into_client_request() {
        Ok(mut request) => {
            if let Ok(origin) = args.origin.parse() {
                request.headers_mut().insert("origin", origin);
            }
            request
        }
        Err(error) => return Joined::Failed(format!("url: {error}")),
    };
    let connect = connect_async_with_config(request, None, true);
    let mut ws = match timeout(Duration::from_secs(10), connect).await {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(error)) => return Joined::Failed(format!("connect: {error}")),
        Err(_) => return Joined::Failed("connect: timeout".into()),
    };
    let hello =
        json!({"t": "hello", "v": PROTOCOL_VERSION, "name": format!("bot{index}")}).to_string();
    if ws.send(Message::Text(hello.into())).await.is_err() {
        return Joined::Failed("hello: send".into());
    }
    // 等 welcome 並取得自己的出生位置。
    let welcome = timeout(Duration::from_secs(10), async {
        while let Some(Ok(message)) = ws.next().await {
            match message {
                Message::Text(raw) => return serde_json::from_str::<Value>(&raw).ok(),
                Message::Close(_) => return None,
                _ => {}
            }
        }
        None
    })
    .await;
    let Ok(Some(welcome)) = welcome else {
        return Joined::Failed("welcome: missing".into());
    };
    if welcome["t"] != "welcome" {
        return Joined::Failed(format!("welcome: got {}", welcome["t"]));
    }
    let me = welcome["players"]
        .as_array()
        .and_then(|list| list.iter().find(|p| p["id"] == welcome["selfId"]));
    let mut walker = Walker {
        x: me.and_then(|p| p["x"].as_f64()).unwrap_or(0.0),
        z: me.and_then(|p| p["z"].as_f64()).unwrap_or(11.0),
        heading: me.and_then(|p| p["heading"].as_f64()).unwrap_or(0.0),
        seq: 0,
    };
    let count_sent = |bytes: usize| {
        if stats.measuring.load(Relaxed) {
            stats.sent_bytes.fetch_add(bytes as u64, Relaxed);
            stats.sent_msgs.fetch_add(1, Relaxed);
        }
    };

    let period = Duration::from_secs_f64(1.0 / SEND_HZ);
    let start = tokio::time::Instant::now();
    let mut move_timer = interval_at(
        start + Duration::from_millis(rand::random_range(0..100)),
        period,
    );
    move_timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut ping_timer = interval_at(start + PING_EVERY.mul_f64(rand::random()), PING_EVERY);
    let mut action_timer = interval(Duration::from_millis(500));
    let mut next_action = Instant::now() + Duration::from_secs_f64(rand::random_range(5.0..25.0));
    let mut req = 0u64;
    let mut intervals = Vec::new();
    let mut last_moves: Option<Instant> = None;
    loop {
        let outgoing = tokio::select! {
            _ = stop.changed() => break,
            _ = move_timer.tick(), if moving => {
                let (x, z, heading) = walker.step();
                Some(json!({"t": "move", "x": x, "z": z, "heading": heading, "seq": walker.seq}).to_string())
            }
            _ = ping_timer.tick() => {
                Some(json!({"t": "ping", "ts": start.elapsed().as_secs_f64() * 1000.0}).to_string())
            }
            _ = action_timer.tick() => {
                if Instant::now() >= next_action {
                    next_action = Instant::now() + Duration::from_secs_f64(rand::random_range(10.0..25.0));
                    req += 1;
                    let id = ACTIONS[rand::random_range(0..ACTIONS.len())];
                    Some(json!({"t": "action", "reqId": format!("b{index}-{req}"), "id": id}).to_string())
                } else {
                    None
                }
            }
            received = ws.next() => {
                match received {
                    Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                        let len = message.len();
                        let kind = kind_of(&message);
                        let is_moves = kind == 0;
                        if matches!(message, Message::Binary(_)) && kind == OTHER {
                            stats.invalid_frames.fetch_add(1, Relaxed);
                        }
                        if stats.measuring.load(Relaxed) {
                            stats.recv_bytes.fetch_add(len as u64, Relaxed);
                            stats.recv_ws_bytes.fetch_add(len as u64 + ws_header(len), Relaxed);
                            stats.by_kind_bytes[kind].fetch_add(len as u64, Relaxed);
                            stats.by_kind_msgs[kind].fetch_add(1, Relaxed);
                            stats.recv_msgs.fetch_add(1, Relaxed);
                            if is_moves {
                                stats.moves_bytes.fetch_add(len as u64, Relaxed);
                                stats.moves_msgs.fetch_add(1, Relaxed);
                                let now = Instant::now();
                                if let Some(previous) = last_moves {
                                    intervals.push(now.duration_since(previous).as_micros().min(u128::from(u32::MAX)) as u32);
                                }
                                last_moves = Some(now);
                            }
                        }
                        None
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                        stats.closed_by_server.fetch_add(1, Relaxed);
                        return Joined::Done(intervals);
                    }
                    Some(Ok(_)) => None,
                }
            }
        };
        if let Some(raw) = outgoing {
            let bytes = raw.len();
            if ws.send(Message::Text(raw.into())).await.is_err() {
                stats.closed_by_server.fetch_add(1, Relaxed);
                break;
            }
            count_sent(bytes);
        }
    }
    let _ = ws.close(None).await;
    Joined::Done(intervals)
}

fn percentile(sorted: &[u32], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * p).round() as usize;
    f64::from(sorted[index]) / 1000.0
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(args) => Arc::new(args),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let stats = Arc::new(Stats::default());
    let (stop_tx, stop_rx) = watch::channel(false);
    let movers = (args.connections as f64 * args.moving_ratio).round() as usize;
    let mut tasks = Vec::new();
    for index in 0..args.connections {
        // 讓移動中的玩家均勻分散在各房間，而不是集中在前幾個房間。
        let moving =
            (index * movers / args.connections) != ((index + 1) * movers / args.connections);
        tasks.push(tokio::spawn(player(
            index,
            args.clone(),
            moving,
            stats.clone(),
            stop_rx.clone(),
        )));
        sleep(Duration::from_millis(args.ramp_ms)).await;
    }
    sleep(Duration::from_millis(args.settle_ms)).await;
    let before = stats.snapshot();
    stats.measuring.store(true, Relaxed);
    let started = Instant::now();
    println!("量測開始");
    sleep(Duration::from_secs(args.seconds)).await;
    let elapsed = started.elapsed().as_secs_f64();
    stats.measuring.store(false, Relaxed);
    println!("量測結束");
    let after = stats.snapshot();
    let _ = stop_tx.send(true);

    let mut failures: Vec<String> = Vec::new();
    let mut intervals: Vec<u32> = Vec::new();
    let mut connected = 0usize;
    for task in tasks {
        match task.await {
            Ok(Joined::Done(list)) => {
                connected += 1;
                intervals.extend(list);
            }
            Ok(Joined::Failed(reason)) => failures.push(reason),
            Err(error) => failures.push(format!("task: {error}")),
        }
    }
    intervals.sort_unstable();
    // 連線失敗的原因只列出種類與次數，避免輸出過長。
    let mut reasons: std::collections::BTreeMap<String, usize> = Default::default();
    for reason in &failures {
        *reasons.entry(reason.clone()).or_default() += 1;
    }
    let per_conn = connected.max(1) as f64;
    let diff = |a: u64, b: u64| (a - b) as f64;
    let recv_bytes = diff(after.recv_bytes, before.recv_bytes);
    let recv_msgs = diff(after.recv_msgs, before.recv_msgs);
    let moves_bytes = diff(after.moves_bytes, before.moves_bytes);
    let moves_msgs = diff(after.moves_msgs, before.moves_msgs);
    let sent_bytes = diff(after.sent_bytes, before.sent_bytes);
    let sent_msgs = diff(after.sent_msgs, before.sent_msgs);
    let by_kind: serde_json::Map<String, Value> = KINDS
        .iter()
        .enumerate()
        .filter(|(i, _)| after.by_kind_msgs[*i] > before.by_kind_msgs[*i])
        .map(|(i, kind)| {
            let bytes = diff(after.by_kind_bytes[i], before.by_kind_bytes[i]);
            let msgs = diff(after.by_kind_msgs[i], before.by_kind_msgs[i]);
            (
                (*kind).to_string(),
                json!({
                    "bytes_per_conn_s": round2(bytes / elapsed / per_conn),
                    "msgs_per_conn_s": round2(msgs / elapsed / per_conn),
                }),
            )
        })
        .collect();
    let recv_ws_bytes = diff(after.recv_ws_bytes, before.recv_ws_bytes);
    let result = json!({
        "url": args.url,
        "connections": args.connections,
        "moving_ratio": args.moving_ratio,
        "moving_players": movers,
        "seconds": round2(elapsed),
        "connected": connected,
        "connect_failed": failures.len(),
        "closed_by_server": stats.closed_by_server.load(Relaxed),
        "recv_bytes_per_conn_s": round2(recv_bytes / elapsed / per_conn),
        "recv_msgs_per_conn_s": round2(recv_msgs / elapsed / per_conn),
        "recv_ws_bytes_per_conn_s": round2(recv_ws_bytes / elapsed / per_conn),
        "recv_by_kind": by_kind,
        "invalid_frames": stats.invalid_frames.load(Relaxed),
        "recv_moves_bytes_per_conn_s": round2(moves_bytes / elapsed / per_conn),
        "recv_moves_msgs_per_conn_s": round2(moves_msgs / elapsed / per_conn),
        "sent_bytes_per_conn_s": round2(sent_bytes / elapsed / per_conn),
        "sent_msgs_per_conn_s": round2(sent_msgs / elapsed / per_conn),
        "total_recv_bytes_s": round2(recv_bytes / elapsed),
        "moves_interval_ms": {
            "samples": intervals.len(),
            "p50": round2(percentile(&intervals, 0.5)),
            "p99": round2(percentile(&intervals, 0.99)),
            "max": round2(percentile(&intervals, 1.0)),
        },
        "failure_reasons": reasons,
    });
    println!(
        "連線 {connected}/{}（移動中 {movers}），量測 {elapsed:.1} 秒",
        args.connections
    );
    println!(
        "每連線接收：{:.0} bytes/s、{:.1} 則/s（其中 moves {:.0} bytes/s、{:.1} 則/s）",
        recv_bytes / elapsed / per_conn,
        recv_msgs / elapsed / per_conn,
        moves_bytes / elapsed / per_conn,
        moves_msgs / elapsed / per_conn
    );
    println!(
        "每連線送出：{:.0} bytes/s、{:.1} 則/s",
        sent_bytes / elapsed / per_conn,
        sent_msgs / elapsed / per_conn
    );
    println!(
        "moves 間隔：p50 {:.1} ms、p99 {:.1} ms、max {:.1} ms（{} 筆）",
        percentile(&intervals, 0.5),
        percentile(&intervals, 0.99),
        percentile(&intervals, 1.0),
        intervals.len()
    );
    println!(
        "連線失敗 {}、被伺服器關閉 {}",
        failures.len(),
        stats.closed_by_server.load(Relaxed)
    );
    println!("{result}");
}
