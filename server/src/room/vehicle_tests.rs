use super::*;
use crate::protocol::{CarSnapshot, ServerMessage};
use crate::vehicles::params::params;
use std::time::Duration;
use tokio::time::{sleep, sleep_until};

const TICK: Duration = Duration::from_millis(100);
/// `drive` 的方向編號：64 × 2π/256 = π/2，朝東（+x），也就是停車位的車頭方向。
const DIR_EAST: u8 = 64;
/// 遊戲區外、bay 0 (-10.5, 7.0) 正東方的步行者位置：車頭（x = -9.6）前方 1.2 公尺。
const EAST_OF_BAY0: (f64, f64) = (-8.4, 7.0);

/// `t0` 之後經過的毫秒；`SessionClock::Fixed { base_ms: 0.0 }` 的房間在 `t0` 建立時即為 session_ms。
fn elapsed_ms(t0: Instant) -> f64 {
    (Instant::now() - t0).as_secs_f64() * 1000.0
}
type RoomTx = mpsc::Sender<RoomCommand>;

/// 車輛測試一律用固定的廟會時鐘（房間建立時為開場時刻 0），不受真實時間影響。
fn cfg() -> RoomConfig {
    RoomConfig {
        session_clock: SessionClock::Fixed { base_ms: 0.0 },
        ..RoomConfig::new(50)
    }
}

fn spawn_room(config: RoomConfig) -> RoomTx {
    let (tx, rx) = mpsc::channel(128);
    tokio::spawn(run_room(1, config, rx, Default::default()));
    tx
}

struct Client {
    room: RoomTx,
    who: Who,
    rx: Outbound,
    n: u8,
    token: String,
    x: f64,
    z: f64,
}

impl Client {
    fn from_welcome(room: &RoomTx, who: Who, mut rx: Outbound) -> Self {
        let welcome = rx.try_recv().unwrap();
        Self::from_message(room, who, welcome, rx)
    }

    fn from_message(room: &RoomTx, who: Who, welcome: ServerMessage, rx: Outbound) -> Self {
        let ServerMessage::Welcome {
            players,
            resume_token,
            ..
        } = welcome
        else {
            panic!("first message must be welcome");
        };
        let me = players.iter().find(|p| p.id == who.id).unwrap();
        Self {
            room: room.clone(),
            x: me.x,
            z: me.z,
            n: me.n,
            token: resume_token,
            who,
            rx,
        }
    }

    fn drain(&mut self) -> Vec<ServerMessage> {
        std::iter::from_fn(|| self.rx.try_recv().ok()).collect()
    }

    async fn claim(&self, kind: u8) {
        self.room
            .send(RoomCommand::Claim {
                who: self.who.clone(),
                kind: Some(kind),
            })
            .await
            .unwrap();
    }

    async fn ride(&self, car: Option<u8>) {
        self.room
            .send(RoomCommand::Ride {
                who: self.who.clone(),
                car,
            })
            .await
            .unwrap();
    }

    async fn drive(&self, seq: u16, dir: u8, mag: u8) {
        self.room
            .send(RoomCommand::Drive {
                who: self.who.clone(),
                seq,
                dir,
                mag,
            })
            .await
            .unwrap();
    }

    async fn action(&self, req_id: &str, action: &str, data_ok: bool) {
        self.room
            .send(RoomCommand::Action {
                who: self.who.clone(),
                req_id: req_id.into(),
                action: action.into(),
                data_ok,
            })
            .await
            .unwrap();
    }

    async fn position(&mut self, x: f64, z: f64) {
        self.x = x;
        self.z = z;
        self.room
            .send(RoomCommand::Position {
                who: self.who.clone(),
                x,
                z,
                heading: 0.0,
                moving: false,
                at: Instant::now(),
            })
            .await
            .unwrap();
    }

    async fn walk_to_counter(&mut self) {
        for (x, z) in [(-4.0, 11.0), (-8.0, 11.0), (-11.0, 11.5)] {
            sleep(Duration::from_secs(2)).await;
            self.position(x, z).await;
        }
        sleep(TICK).await;
    }

    async fn walk_to_bay0(&mut self) {
        self.walk_to_counter().await;
        for (x, z) in [(-10.5, 9.25), (-10.5, 7.5)] {
            sleep(Duration::from_secs(2)).await;
            self.position(x, z).await;
        }
        sleep(TICK).await;
    }

    /// 走到遊戲區外、bay 0 正東方（`EAST_OF_BAY0`）。
    async fn walk_east_of_bay0(&mut self) {
        self.walk_to_counter().await;
        sleep(Duration::from_secs(2)).await;
        self.position(EAST_OF_BAY0.0, EAST_OF_BAY0.1).await;
        sleep(TICK).await;
    }

    async fn walk_to_door(&mut self) {
        for (x, z) in [(2.0, 5.0), (2.0, -4.0), (0.0, -5.6)] {
            sleep(Duration::from_secs(2)).await;
            self.position(x, z).await;
        }
        sleep(TICK).await;
    }

    async fn enter_hall(&mut self) {
        self.walk_to_door().await;
        self.room
            .send(RoomCommand::Zone {
                who: self.who.clone(),
                zone: "hall".into(),
            })
            .await
            .unwrap();
        sleep(TICK).await;
        self.drain();
    }

    async fn disconnect(&self) {
        self.room
            .send(RoomCommand::Disconnect(self.who.clone()))
            .await
            .unwrap();
    }

    async fn send_zone(&self, zone: &str) {
        self.room
            .send(RoomCommand::Zone {
                who: self.who.clone(),
                zone: zone.into(),
            })
            .await
            .unwrap();
    }

    async fn send_move(&self, x: f64, z: f64, heading: f64, moving: bool) {
        self.room
            .send(RoomCommand::Position {
                who: self.who.clone(),
                x,
                z,
                heading,
                moving,
                at: Instant::now(),
            })
            .await
            .unwrap();
    }
}

async fn connect(room: &RoomTx) -> Client {
    let (out, rx) = mpsc::channel(2048);
    let who = super::join(room, "測試", AuthKind::Guest, 0, out)
        .await
        .unwrap();
    Client::from_welcome(room, who, rx)
}

async fn resume(room: &RoomTx, token: &str) -> Option<Client> {
    resume_with_cars(room, token)
        .await
        .map(|(client, _)| client)
}

/// 恢復連線，並回傳恢復的 welcome 帶的 cars。
async fn resume_with_cars(room: &RoomTx, token: &str) -> Option<(Client, Vec<CarSnapshot>)> {
    let (outbound, mut rx) = mpsc::channel(2048);
    let (reply, received) = oneshot::channel();
    room.send(RoomCommand::Resume {
        token: token.into(),
        name: "測試".into(),
        auth: AuthKind::Guest,
        outfit: None,
        outbound,
        reply,
    })
    .await
    .unwrap();
    let who = received.await.unwrap()?;
    let welcome = rx.try_recv().unwrap();
    let ServerMessage::Welcome { cars, .. } = &welcome else {
        panic!("first message must be welcome");
    };
    let cars = cars.clone();
    Some((Client::from_message(room, who, welcome, rx), cars))
}

#[derive(Debug, Clone)]
struct CarMsg {
    c: u8,
    kind: u8,
    driver: Option<String>,
    x: f64,
    z: f64,
    #[allow(dead_code)]
    heading: f64,
    fade_at: Option<f64>,
}

fn find_car_msg(msgs: &[ServerMessage]) -> Option<CarMsg> {
    msgs.iter().find_map(|m| match m {
        ServerMessage::Car {
            c,
            kind,
            driver,
            x,
            z,
            heading,
            fade_at,
        } => Some(CarMsg {
            c: *c,
            kind: *kind,
            driver: driver.clone(),
            x: *x,
            z: *z,
            heading: *heading,
            fade_at: *fade_at,
        }),
        _ => None,
    })
}

async fn connect_with_welcome(room: &RoomTx) -> (Client, Vec<PlayerSnapshot>) {
    let (out, mut rx) = mpsc::channel(2048);
    let who = super::join(room, "測試", AuthKind::Guest, 0, out)
        .await
        .unwrap();
    let ServerMessage::Welcome {
        players,
        resume_token,
        ..
    } = rx.try_recv().unwrap()
    else {
        panic!("first message must be welcome");
    };
    let me = players.iter().find(|p| p.id == who.id).unwrap();
    let client = Client {
        room: room.clone(),
        x: me.x,
        z: me.z,
        n: me.n,
        token: resume_token,
        who,
        rx,
    };
    (client, players)
}

fn find_knock_msg(msgs: &[ServerMessage]) -> Option<(String, f64, f64, f64, f64, f64)> {
    for msg in msgs {
        if let ServerMessage::Knock {
            id,
            x,
            z,
            to_x,
            to_z,
            at,
        } = msg
        {
            return Some((id.clone(), *x, *z, *to_x, *to_z, *at));
        }
    }
    None
}

fn find_ack_msg(msgs: &[ServerMessage], req_id: &str) -> Option<(bool, Option<String>)> {
    for msg in msgs {
        if let ServerMessage::Ack {
            req_id: r,
            ok,
            reason,
        } = msg
            && r == req_id
        {
            return Some((*ok, reason.clone()));
        }
    }
    None
}

fn find_sync_msg(msgs: &[ServerMessage]) -> Option<Vec<MoveTuple>> {
    for msg in msgs {
        if let ServerMessage::Sync { m } = msg {
            return Some(m.clone());
        }
    }
    None
}

// 1. claim_spawns_at_free_bay_and_mounts: 領車成功，生在 bay 0、玩家 riding=Some(c)、廣播 car
#[tokio::test(start_paused = true)]
async fn claim_spawns_at_free_bay_and_mounts() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.drain();
    a.walk_to_counter().await;
    a.drain();

    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let car_msg = find_car_msg(&msgs).expect("should receive Car message");

    assert_eq!(car_msg.c, 0);
    assert_eq!(car_msg.kind, 0);
    assert_eq!(car_msg.driver.as_deref(), Some(a.who.id.as_str()));
    assert!(car_msg.fade_at.is_none());

    let p_params = params();
    assert!((car_msg.x - p_params.booth.bays[0].x as f64).abs() < 0.1);
    assert!((car_msg.z - p_params.booth.bays[0].z as f64).abs() < 0.1);
}

// 2. claim_outside_courtyard_fails: 殿內領車回 car_unavailable
#[tokio::test(start_paused = true)]
async fn claim_outside_courtyard_fails() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.enter_hall().await;

    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let err = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Error { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .expect("should receive Error message");
    assert_eq!(err, "car_unavailable");
}

// 3. claim_too_far_from_counter_fails: 遠離櫃台領車回 car_unavailable
#[tokio::test(start_paused = true)]
async fn claim_too_far_from_counter_fails() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.drain();
    // At spawn (0, 11), counter is at (-12, 11.5), dist ~12m > 3.0m

    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let err = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Error { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .expect("should receive Error message");
    assert_eq!(err, "car_unavailable");
}

// 4. claim_under_cooldown_fails: 20 秒內重複領回 claim_cooldown
#[tokio::test(start_paused = true)]
async fn claim_under_cooldown_fails() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.drain();

    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 下車
    a.ride(None).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 立即再領
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let err = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Error { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .expect("should receive Error message");
    assert_eq!(err, "claim_cooldown");

    // 等待 20 秒冷卻過後
    sleep(Duration::from_millis(20100)).await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let car_msg = find_car_msg(&msgs);
    assert!(car_msg.is_some(), "should succeed after cooldown");
}

// 5. claim_when_kind_at_limit_fails: 該車種已滿回 car_unavailable
#[tokio::test(start_paused = true)]
async fn claim_when_kind_at_limit_fails() {
    let room = spawn_room(cfg());

    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.drain();
    a.claim(3).await; // kind 3 limit is 1
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 下車讓其他人也能在櫃台操作，但車種庫存仍然是 1（已滿）
    a.ride(None).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    let mut b = connect(&room).await;
    b.walk_to_counter().await;
    b.drain();
    b.claim(3).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = b.drain();
    let err = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Error { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .expect("should receive Error message");
    assert_eq!(err, "car_unavailable");
}

// 抽車種：額滿的車種抽不到，全部額滿回 None，每個 roll 都落在對應權重的區間
#[test]
fn pick_kind_skips_full_kinds_and_follows_weights() {
    use super::vehicles::pick_kind;
    let stock = [45, 0, 15, 5];
    let drawn: Vec<u8> = (0..65).map(|r| pick_kind(&stock, r).unwrap()).collect();
    assert!(drawn.iter().all(|&k| k != 1));
    assert_eq!(drawn.iter().filter(|&&k| k == 0).count(), 45);
    assert_eq!(drawn.iter().filter(|&&k| k == 2).count(), 15);
    assert_eq!(drawn.iter().filter(|&&k| k == 3).count(), 5);
    assert_eq!(pick_kind(&[0, 0, 0, 0], 0), None);
}

// 不帶車種的領車（正式路徑）：伺服器抽一種並發車
#[tokio::test(start_paused = true)]
async fn claim_without_kind_draws_a_car() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.drain();
    a.room
        .send(RoomCommand::Claim {
            who: a.who.clone(),
            kind: None,
        })
        .await
        .unwrap();
    sleep(Duration::from_millis(50)).await;
    let car = find_car_msg(&a.drain()).expect("claim without kind spawns a car");
    assert!((car.kind as usize) < params().kinds.len());
    assert_eq!(car.driver.as_deref(), Some(a.who.id.as_str()));
}

// 6. claim_when_all_bays_blocked_fails: 6 車位都有障礙回 booth_crowded
#[tokio::test(start_paused = true)]
async fn claim_when_all_bays_blocked_fails() {
    let room = spawn_room(cfg());
    // 生 3 輛車佔滿 3 個 bay（2 輛 kind 0，1 輛 kind 1）。
    for _ in 0..2 {
        let mut c = connect(&room).await;
        c.walk_to_counter().await;
        c.claim(0).await;
        sleep(Duration::from_millis(50)).await;
        c.ride(None).await;
        sleep(Duration::from_millis(50)).await;
    }
    {
        let mut c = connect(&room).await;
        c.walk_to_counter().await;
        c.claim(1).await;
        sleep(Duration::from_millis(50)).await;
        c.ride(None).await;
        sleep(Duration::from_millis(50)).await;
    }

    // 第 4 位玩家領車（kind 0 還有庫存 4 - 2 = 2，但 3 個車位全被佔用）
    let mut x = connect(&room).await;
    x.walk_to_counter().await;
    x.drain();
    x.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = x.drain();
    let err = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Error { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .expect("should receive Error message");
    assert_eq!(err, "booth_crowded");
}

// 7. ride_mounts_empty_nearby_car: 步行者在 2.5m 內 ride 成功上車，廣播 car
#[tokio::test(start_paused = true)]
async fn ride_mounts_empty_nearby_car() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.ride(None).await; // dismount at bay 0 (-10.5, 7.0)
    sleep(Duration::from_millis(50)).await;

    let mut b = connect(&room).await;
    b.walk_to_bay0().await; // bay 0 is (-10.5, 7.0)
    b.drain();

    b.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = b.drain();
    let car_msg = find_car_msg(&msgs).expect("should receive Car message");
    assert_eq!(car_msg.c, 0);
    assert_eq!(car_msg.driver.as_deref(), Some(b.who.id.as_str()));
    assert!(car_msg.fade_at.is_none());
}

// 8. ride_occupied_car_fails: 別人已在車上回 car_unavailable
#[tokio::test(start_paused = true)]
async fn ride_occupied_car_fails() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let mut b = connect(&room).await;
    b.walk_to_bay0().await;
    b.drain();

    b.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = b.drain();
    let err = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Error { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .expect("should receive Error message");
    assert_eq!(err, "car_unavailable");
}

// 9. ride_too_far_fails: >2.5m 回 car_unavailable
#[tokio::test(start_paused = true)]
async fn ride_too_far_fails() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.ride(None).await;
    sleep(Duration::from_millis(50)).await;

    let mut b = connect(&room).await;
    // B stays at spawn (0, 11), dist > 2.5m
    b.drain();

    b.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = b.drain();
    let err = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Error { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .expect("should receive Error message");
    assert_eq!(err, "car_unavailable");
}

// 10. ride_none_dismounts: ride(None) 下車，落在安全位置，廣播 car(fadeAt)
#[tokio::test(start_paused = true)]
async fn ride_none_dismounts() {
    let t0 = Instant::now();
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    a.ride(None).await;
    let session_ms = elapsed_ms(t0);
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let sync_msg = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Sync { m } => Some(m.clone()),
            _ => None,
        })
        .expect("should receive sync with dismount position");
    assert_eq!(sync_msg.len(), 1);
    let (_n, px, pz, _heading, _moving) = sync_msg[0];
    let car_msg = find_car_msg(&msgs).expect("should receive Car message");
    assert_eq!(car_msg.c, 0);
    assert!(car_msg.driver.is_none());
    assert!(car_msg.fade_at.is_some());
    let fade_at = car_msg.fade_at.unwrap();
    // Fixed 時鐘：fadeAt 與 session_ms 同一條時間軸（房間建立時為 0）。
    assert!((fade_at - (session_ms + 45_000.0)).abs() < 500.0);

    // 檢查落點距離 車體 (car_msg.x, car_msg.z) 約 1.1m
    let dist = (px - car_msg.x).hypot(pz - car_msg.z);
    assert!((dist - 1.1).abs() < 0.05, "dismount distance: {dist}");
}

// 11. drive_updates_input_and_steps: 騎士送 drive，physics_step 推進車輛位置與朝向
#[tokio::test(start_paused = true)]
async fn drive_updates_input_and_steps() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 送出全速向前的 drive 指令
    a.drive(1, 128, 255).await;
    sleep(Duration::from_millis(200)).await;

    let msgs = a.drain();
    let cars_frames: Vec<_> = msgs
        .iter()
        .filter_map(|m| match m {
            ServerMessage::Cars { ack, cars } => Some((*ack, cars.clone())),
            _ => None,
        })
        .collect();

    assert!(!cars_frames.is_empty(), "should receive Cars frames");
    let (last_ack, last_cars) = cars_frames.last().unwrap();
    assert_eq!(*last_ack, 1);
    let my_car = last_cars.iter().find(|c| c.c == 0).expect("car 0 in frame");
    assert!(my_car.vx.hypot(my_car.vz) > 0.05);
}

// 12. drive_seq_wrapping: seq 65535 後接 0 正常接受，反向較舊 seq 丟棄
#[tokio::test(start_paused = true)]
async fn drive_seq_wrapping() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 1. 送 65535
    a.drive(65535, 128, 255).await;
    sleep(Duration::from_millis(70)).await;
    let msgs = a.drain();
    let ack_65535 = msgs.iter().find_map(|m| match m {
        ServerMessage::Cars { ack, .. } => Some(*ack),
        _ => None,
    });
    assert_eq!(ack_65535, Some(65535));

    // 2. 送 0（環繞為新）
    a.drive(0, 128, 255).await;
    sleep(Duration::from_millis(70)).await;
    let msgs = a.drain();
    let ack_0 = msgs.iter().find_map(|m| match m {
        ServerMessage::Cars { ack, .. } => Some(*ack),
        _ => None,
    });
    assert_eq!(ack_0, Some(0));

    // 3. 送 65530（比 0 舊，應丟棄）
    a.drive(65530, 128, 255).await;
    sleep(Duration::from_millis(70)).await;
    let msgs = a.drain();
    let ack_old = msgs.iter().find_map(|m| match m {
        ServerMessage::Cars { ack, .. } => Some(*ack),
        _ => None,
    });
    // ack 依然是 0
    assert_eq!(ack_old, Some(0));
}

// 13. drive_timeout_zeroes_stick: 500ms 無 drive，車輛輸入歸零自然滑行（推進 600ms 後速度小於逾時前）
#[tokio::test(start_paused = true)]
async fn drive_timeout_zeroes_stick() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 驅動車輛 500ms 達到速度 v1
    a.drive(1, 128, 255).await;
    sleep(Duration::from_millis(500)).await;
    let msgs1 = a.drain();
    let v1 = msgs1
        .iter()
        .filter_map(|m| match m {
            ServerMessage::Cars { cars, .. } => Some(cars),
            _ => None,
        })
        .next_back()
        .and_then(|cars| cars.iter().find(|c| c.c == 0))
        .map(|c| c.vx.hypot(c.vz))
        .expect("should have cars frames while driving");

    // 停止送 drive，推進 600ms（超過 500ms 逾時，輸入歸零車輛減速）
    for _ in 0..6 {
        sleep(Duration::from_millis(100)).await;
    }
    let msgs2 = a.drain();
    let v2 = msgs2
        .iter()
        .filter_map(|m| match m {
            ServerMessage::Cars { cars, .. } => Some(cars),
            _ => None,
        })
        .next_back()
        .and_then(|cars| cars.iter().find(|c| c.c == 0))
        .map(|c| c.vx.hypot(c.vz))
        .expect("should have cars frames after timeout");

    assert!(
        v2 < v1,
        "car should decelerate after input timeout (v1={v1}, v2={v2})"
    );
}

// 14. idle_dismount_after_sixty_seconds: 60 秒只有零 stick 則強制下車
// 期間持續送 mag = 0 的 drive：伺服器照收（cars 幀的 ack 跟上最新 seq），
// 但不算活躍駕駛（不延後自動下車），車也不會被推動（速度維持 0）。
#[tokio::test(start_paused = true)]
async fn idle_dismount_after_sixty_seconds() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 59 秒內每 0.5 秒送一則 mag = 0 的 drive，依然在車上
    let mut seq = 0u16;
    let mut last_ack = None;
    for _ in 0..118 {
        seq += 1;
        a.drive(seq, 64, 0).await;
        sleep(Duration::from_millis(500)).await;
        let msgs = a.drain();
        assert!(
            find_car_msg(&msgs).is_none(),
            "still riding while only zero drive is sent"
        );
        for m in &msgs {
            if let ServerMessage::Cars { ack, cars } = m {
                last_ack = Some(*ack);
                for car in cars {
                    assert!(
                        car.vx.hypot(car.vz) < 0.01,
                        "zero drive must not move the car"
                    );
                }
            }
        }
    }
    // 有騎士時物理持續步進並廣播 cars，ack 是騎士最新的 seq（零輸入的 drive 也被接受）。
    assert_eq!(last_ack, Some(seq));

    // 滿 60 秒觸發強制下車（零輸入的 drive 不會延後）
    a.drive(seq + 1, 64, 0).await;
    sleep(Duration::from_secs(2)).await;
    let msgs = a.drain();
    let car_msg = find_car_msg(&msgs).expect("should receive Car message with dismount");
    assert!(car_msg.driver.is_none());
}

// 15. empty_car_fades_and_despawns_after_sixty_seconds: 下車 60 秒後車輛消失，廣播 carGone；
// 之後同一車種的庫存歸還，可以再領。
#[tokio::test(start_paused = true)]
async fn empty_car_fades_and_despawns_after_sixty_seconds() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(3).await; // firewheel 只有 1 台
    sleep(Duration::from_millis(50)).await;
    a.ride(None).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 59 秒後未過期
    sleep(Duration::from_secs(59)).await;
    let msgs = a.drain();
    assert!(
        !msgs
            .iter()
            .any(|m| matches!(m, ServerMessage::CarGone { .. }))
    );

    // 滿 60 秒過期被移除（idle 45s + fade 15s = 60s）
    sleep(Duration::from_secs(2)).await;
    sleep(TICK).await;
    let msgs = a.drain();
    let gone = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::CarGone { c } => Some(*c),
            _ => None,
        })
        .expect("should receive CarGone");
    assert_eq!(gone, 0);

    // 庫存歸還：同一車種（count = 1）可以再領（下車落點仍在檔口半徑內、冷卻早已過）。
    a.claim(3).await;
    sleep(Duration::from_millis(50)).await;
    let car = find_car_msg(&a.drain()).expect("the same kind can be claimed again");
    assert_eq!(car.kind, 3);
    assert_eq!(car.driver.as_deref(), Some(a.who.id.as_str()));
}

// 16. remount_clears_fade: 倒數中被其他人騎走，fadeAt 變 null 不會消失
#[tokio::test(start_paused = true)]
async fn remount_clears_fade() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.ride(None).await;
    sleep(Duration::from_millis(50)).await;

    // 倒數 30 秒後重新上車
    sleep(Duration::from_secs(30)).await;
    a.drain();
    a.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let car_msg = find_car_msg(&msgs).expect("should receive Car message");
    assert_eq!(car_msg.driver.as_deref(), Some(a.who.id.as_str()));
    assert!(car_msg.fade_at.is_none());

    // 再過 40 秒（總計 70 秒），車輛依然存在
    sleep(Duration::from_secs(40)).await;
    let msgs = a.drain();
    assert!(
        !msgs
            .iter()
            .any(|m| matches!(m, ServerMessage::CarGone { .. }))
    );
}

// 17. dormant_room_does_not_tick_physics: 全部車休眠且無騎士時，should_physics_step 回 false
#[tokio::test(start_paused = true)]
async fn dormant_room_does_not_tick_physics() {
    let mut room = Room::new(1, cfg(), Default::default());
    assert!(!room.should_physics_step(), "no cars -> no step");

    // 生車並騎乘
    let now = Instant::now();
    let (tx, _rx) = mpsc::channel(64);
    let who = room.join("p1".into(), AuthKind::Guest, 0, tx, now).unwrap();
    let p = room.players.get_mut(&who.id).unwrap();
    p.x = -11.0;
    p.z = 11.5;
    room.claim(&who, 0, now);
    assert!(room.should_physics_step(), "has rider -> should step");

    // 下車
    room.dismount(&who.id, now);
    // 車剛下車還在 awake，步進直到休眠
    for _ in 0..100 {
        room.physics_step(now);
    }
    assert!(
        !room.should_physics_step(),
        "empty and sleeping -> should not step"
    );
}

// 18. cars_frames_only_reach_courtyard_players_but_car_events_reach_the_hall:
// 殿內玩家收不到 cars 幀，但 car／carGone 事件（JSON）照樣收到（全房廣播，前端據此維護車輛清單）。
#[tokio::test(start_paused = true)]
async fn cars_frames_only_reach_courtyard_players_but_car_events_reach_the_hall() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.enter_hall().await;

    let mut b = connect(&room).await;
    b.walk_to_counter().await;
    b.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    // B 駕駛中產生 cars 幀
    b.drive(1, 128, 255).await;
    sleep(Duration::from_millis(200)).await;

    let msgs_b = b.drain();
    assert!(
        msgs_b
            .iter()
            .any(|m| matches!(m, ServerMessage::Cars { .. }))
    );

    // B 下車，空車 60 秒後移除
    b.ride(None).await;
    sleep(Duration::from_secs(61)).await;

    let msgs_a = a.drain();
    assert!(
        !msgs_a
            .iter()
            .any(|m| matches!(m, ServerMessage::Cars { .. })),
        "hall player should not receive Cars frames"
    );
    let car_events: Vec<Option<&String>> = msgs_a
        .iter()
        .filter_map(|m| match m {
            ServerMessage::Car { c: 0, driver, .. } => Some(driver.as_ref()),
            _ => None,
        })
        .collect();
    assert_eq!(
        car_events,
        [Some(&b.who.id), None],
        "hall player receives the claim and the dismount as car events"
    );
    assert!(
        msgs_a
            .iter()
            .any(|m| matches!(m, ServerMessage::CarGone { c: 0 })),
        "hall player receives carGone"
    );
}

// 19. disconnect_dismounts_rider: 騎士斷線立即下車，車留在原處並開始 fade
#[tokio::test(start_paused = true)]
async fn disconnect_dismounts_rider() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    b.drain();

    a.disconnect().await;
    sleep(Duration::from_millis(50)).await;

    let msgs = b.drain();
    let car_msg = find_car_msg(&msgs).expect("should receive Car message showing driver left");
    assert!(car_msg.driver.is_none());
    assert!(car_msg.fade_at.is_some());
}

// 20. resumed_player_is_on_foot: 斷線重連後玩家是步行者，恢復的 welcome 帶庭院全車輛
#[tokio::test(start_paused = true)]
async fn resumed_player_is_on_foot() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    a.disconnect().await;
    sleep(Duration::from_millis(50)).await;

    let (mut a2, cars) = resume_with_cars(&room, &a.token).await.unwrap();
    // 恢復的 welcome 帶 cars：斷線時已下車，車 0 無人騎乘並開始淡出倒數。
    assert_eq!(cars.len(), 1, "resume welcome must carry the cars");
    assert_eq!(cars[0].c, 0);
    assert_eq!(cars[0].kind, 0);
    assert_eq!(cars[0].driver, None);
    assert!(cars[0].fade_at.is_some());
    let _msgs = a2.drain();
    // 在庭院中可以步行移動
    a2.walk_to_bay0().await;

    // 可以正常上車（走到 bay 0 旁邊）
    a2.drain();
    a2.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;
    let msgs = a2.drain();
    assert!(find_car_msg(&msgs).is_some());
}

// 新連線先到（舊連線還沒斷，例如重新整理）的恢復：同樣回到步行狀態，可以再上車
#[tokio::test(start_paused = true)]
async fn resume_before_disconnect_leaves_player_on_foot() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    let mut a2 = resume(&room, &a.token).await.unwrap();
    sleep(Duration::from_millis(50)).await;
    let released = find_car_msg(&a.drain()).expect("resume must broadcast the emptied car");
    assert_eq!(released.driver, None);

    a2.walk_to_bay0().await;
    a2.drain();
    a2.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;
    let car = find_car_msg(&a2.drain()).expect("resumed player can mount again");
    assert_eq!(car.driver.as_deref(), Some(a2.who.id.as_str()));
}

// ==========================================
// 任務 7：碰碰車撞飛測試
// ==========================================

// 21. a_fast_occupied_car_knocks_a_walker_and_broadcasts_knock:
// 高速有人車撞擊步行者，廣播 knock 且 knock.toX/toZ 等於伺服器記錄的玩家座標
// （步行者站在遊戲區外、bay 0 正東方；遊戲區內的人不會被撞，見 players_inside_the_game_zone_are_not_knocked）
#[tokio::test(start_paused = true)]
async fn a_fast_occupied_car_knocks_a_walker_and_broadcasts_knock() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    b.walk_east_of_bay0().await;
    sleep(Duration::from_millis(50)).await;
    a.drain();
    b.drain();

    let mut knock_info = None;
    for seq in 1..=30 {
        a.drive(seq, DIR_EAST, 255).await;
        sleep(Duration::from_millis(33)).await;
        let msgs = b.drain();
        if let Some(k) = find_knock_msg(&msgs) {
            knock_info = Some(k);
            break;
        }
    }

    let (id, from_x, from_z, to_x, to_z, _at) = knock_info.expect("b should be knocked");
    assert_eq!(id, b.who.id);
    assert_eq!(from_x, EAST_OF_BAY0.0);
    assert_eq!(from_z, EAST_OF_BAY0.1);

    // a 也應收到 knock 廣播
    let msgs_a = a.drain();
    assert!(find_knock_msg(&msgs_a).is_some());

    // knock.toX/toZ 等於伺服器記錄的玩家座標
    let (_, players) = connect_with_welcome(&room).await;
    let b_rec = players.iter().find(|p| p.id == b.who.id).unwrap();
    assert_eq!(b_rec.x, to_x);
    assert_eq!(b_rec.z, to_z);
}

// 22. slow_empty_or_unoccupied_cars_do_not_knock: 速率 2.0 的有人車、速率 5 的空車各一皆不撞飛
#[tokio::test(start_paused = true)]
async fn slow_empty_or_unoccupied_cars_do_not_knock() {
    // 1. 低速的有人車不撞飛（b 在遊戲區外、緊貼車頭 0.4 公尺，在 hitRadius 內）
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let mut b = connect(&room).await;
    b.walk_to_counter().await;
    sleep(Duration::from_secs(2)).await;
    b.position(-9.2, 7.0).await; // 車頭在 x = -9.6
    sleep(Duration::from_millis(50)).await;
    b.drain();

    // 輕踩油門 2 個步進（速度 < 2.5 m/s 即停止受力）
    for seq in 1..=2 {
        a.drive(seq, DIR_EAST, 100).await;
        sleep(Duration::from_millis(33)).await;
    }
    // 檢查 b 沒有收到 knock
    assert!(find_knock_msg(&b.drain()).is_none());

    // 2. 速率 5.0 的空車不撞飛
    let room2 = spawn_room(cfg());
    let mut a2 = connect(&room2).await;
    a2.walk_to_counter().await;
    a2.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let mut b2 = connect(&room2).await;
    b2.walk_to_counter().await;
    b2.position(-7.0, 7.5).await;
    sleep(Duration::from_millis(50)).await;
    b2.drain();

    // a2 加速至高速 (~5 m/s) 後下車
    for seq in 1..=12 {
        a2.drive(seq, 0, 255).await;
        sleep(Duration::from_millis(33)).await;
    }
    a2.ride(None).await;
    sleep(Duration::from_millis(10)).await;

    // 空車滑行穿過 b2 所在位置
    for _ in 0..15 {
        sleep(Duration::from_millis(33)).await;
    }
    assert!(find_knock_msg(&b2.drain()).is_none());
}

// 23. knocked_player_cannot_move_or_act_until_recovered_then_gets_a_sync:
// 撞飛期間無法移動或動作，恢復時本人收到 sync
#[tokio::test(start_paused = true)]
async fn knocked_player_cannot_move_or_act_until_recovered_then_gets_a_sync() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    b.walk_east_of_bay0().await;
    sleep(Duration::from_millis(50)).await;
    b.drain();

    let mut knocked = false;
    for seq in 1..=30 {
        a.drive(seq, DIR_EAST, 255).await;
        sleep(Duration::from_millis(33)).await;
        if find_knock_msg(&b.drain()).is_some() {
            knocked = true;
            break;
        }
    }
    assert!(knocked, "b should be knocked");

    // 撞飛期間：發送 move 與 action 皆被拒絕或忽略
    b.position(-5.0, 7.5).await;
    b.action("req-1", "bow", true).await;
    sleep(Duration::from_millis(50)).await;

    let msgs = b.drain();
    let (ok, reason) = find_ack_msg(&msgs, "req-1").expect("should receive ack");
    assert!(!ok);
    assert_eq!(reason.as_deref(), Some("knocked"));

    // 等待 1.8 秒（flightMs 900 + recoverMs 900）到期
    let mut sync_received = false;
    for _ in 0..25 {
        sleep(Duration::from_millis(100)).await;
        let msgs = b.drain();
        if let Some(m) = find_sync_msg(&msgs) {
            assert!(!m.is_empty());
            assert_eq!(m[0].4, Moving::Stopped);
            sync_received = true;
            break;
        }
    }
    assert!(
        sync_received,
        "knocked_until 到期的那個物理步應對本人送一筆 sync"
    );

    // 恢復後可正常 action
    b.action("req-2", "bow", true).await;
    sleep(Duration::from_millis(50)).await;
    let msgs = b.drain();
    let (ok, reason) = find_ack_msg(&msgs, "req-2").expect("should receive ack");
    assert!(ok);
    assert!(reason.is_none());
}

/// 房間層的撞飛測試場景：騎士在 bay 0 領到車（車頭朝東），回傳 (房間, 騎士, 車, 起始時刻, 收件匣)。
fn room_with_rider_at_bay0() -> (Room, Who, u8, Instant, Outbound) {
    let mut room = Room::new(1, cfg(), Default::default());
    let now = Instant::now();
    let (tx, rx) = mpsc::channel(4096);
    let rider = room
        .join("rider".into(), AuthKind::Guest, 0, tx, now)
        .unwrap();
    let p = room.players.get_mut(&rider.id).unwrap();
    (p.x, p.z) = (-11.0, 11.5);
    room.claim(&rider, 0, now);
    let c = room.players[&rider.id].riding.expect("rider mounted");
    (room, rider, c, now, rx)
}

/// 房間層加入一位步行者並放在 (x, z)。
fn add_walker(room: &mut Room, x: f64, z: f64, now: Instant) -> (Who, Outbound) {
    let (tx, rx) = mpsc::channel(4096);
    let who = room
        .join("walker".into(), AuthKind::Guest, 0, tx, now)
        .unwrap();
    let p = room.players.get_mut(&who.id).unwrap();
    (p.x, p.z) = (x, z);
    (who, rx)
}

/// 把步行者放到車頭正前方 1.3 公尺（距車頭 0.4 公尺，在 hitRadius 內）。
fn place_ahead_of(room: &mut Room, id: &str, c: u8) {
    let st = room.vehicles.car(c).unwrap();
    let (sx, sz) = (st.heading.sin() as f64, st.heading.cos() as f64);
    let p = room.players.get_mut(id).unwrap();
    p.x = st.x as f64 + 1.3 * sx;
    p.z = st.z as f64 + 1.3 * sz;
}

/// 全速向東開 `steps` 步，時刻固定為 `now`；回傳 (是否撞飛 `id`, 期間是否曾以 ≥ minSpeed 的速率進入 hitRadius)。
fn drive_pass(
    room: &mut Room,
    rider: &Who,
    seq: &mut u16,
    c: u8,
    id: &str,
    now: Instant,
    steps: usize,
) -> (bool, bool) {
    let k = &params().knock;
    let mut exposed = false;
    for _ in 0..steps {
        *seq += 1;
        room.drive(rider, *seq, DIR_EAST, 255, now);
        room.physics_step(now);
        if room.players[id].knocked_until.is_some_and(|t| now < t) {
            return (true, exposed);
        }
        // 與撞飛判定相同的條件：步進後的車速與距離
        let p = &room.players[id];
        let st = room.vehicles.car(c).unwrap();
        let close = room
            .vehicles
            .distance_to_car(c, p.x as f32, p.z as f32)
            .is_some_and(|d| d <= k.hit_radius);
        if close && st.vx.hypot(st.vz) >= k.min_speed {
            exposed = true;
        }
    }
    (false, exposed)
}

// 24. immune_player_is_not_knocked_again_for_3s_after_recovery:
// 恢復後 3 秒內免疫：第 4.7 秒仍免疫、第 4.9 秒可再被撞。
// 房間層直接指定物理步的時刻（撞飛與免疫只比較 `now`），不依賴車要剛好在那一刻經過的時序。
#[test]
fn immune_player_is_not_knocked_again_for_3s_after_recovery() {
    let k = &params().knock;
    let (mut room, rider, c, t0, _rider_rx) = room_with_rider_at_bay0();
    let (b, _b_rx) = add_walker(&mut room, EAST_OF_BAY0.0, EAST_OF_BAY0.1, t0);

    // 第一次撞飛
    let mut seq = 0u16;
    let mut knocked_at = None;
    for i in 1..=30u64 {
        let now = t0 + Duration::from_millis(33 * i);
        if drive_pass(&mut room, &rider, &mut seq, c, &b.id, now, 1).0 {
            knocked_at = Some(now);
            break;
        }
    }
    let tk = knocked_at.expect("first knock should occur");
    let immune_until = tk + Duration::from_millis(k.flight_ms + k.recover_ms + k.immune_ms);
    assert_eq!(room.players[&b.id].immune_until, Some(immune_until));
    assert_eq!(immune_until - tk, Duration::from_millis(4800));

    // 第 4.7 秒：車以高速穿過 b，b 仍免疫
    let at_4_7 = tk + Duration::from_millis(4700);
    place_ahead_of(&mut room, &b.id, c);
    let (hit, exposed) = drive_pass(&mut room, &rider, &mut seq, c, &b.id, at_4_7, 15);
    assert!(exposed, "the car must pass b at knock speed at 4.7 s");
    assert!(!hit, "player should be immune at 4.7s");

    // 第 4.9 秒：無敵失效，再次被撞飛
    let at_4_9 = tk + Duration::from_millis(4900);
    place_ahead_of(&mut room, &b.id, c);
    let (hit, _) = drive_pass(&mut room, &rider, &mut seq, c, &b.id, at_4_9, 15);
    assert!(hit, "second knock should occur after immunity expires");
}

// 25. knocking_clears_the_stored_action:
// 被撞後新加入者的 welcome 快照中該玩家沒有 action
#[tokio::test(start_paused = true)]
async fn knocking_clears_the_stored_action() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    b.walk_east_of_bay0().await;
    b.action("act-1", "bow", true).await;
    sleep(Duration::from_millis(50)).await;

    // 檢查撞飛前 action 存在
    let (_, players_before) = connect_with_welcome(&room).await;
    let b_before = players_before.iter().find(|p| p.id == b.who.id).unwrap();
    assert_eq!(b_before.action.as_ref().map(|a| a.id.as_str()), Some("bow"));

    // a 高速撞飛 b
    let mut knock_received = false;
    for seq in 1..=40 {
        a.drive(seq, DIR_EAST, 255).await;
        sleep(Duration::from_millis(33)).await;
        let msgs = b.drain();
        if find_knock_msg(&msgs).is_some() {
            knock_received = true;
            break;
        }
    }
    assert!(knock_received, "knock should have occurred!");

    // 檢查撞飛後新加入者的 welcome 快照中該玩家沒有 action
    let (_, players_after) = connect_with_welcome(&room).await;
    let b_after = players_after.iter().find(|p| p.id == b.who.id).unwrap();
    assert!(b_after.action.is_none());
}

// 26. riders_and_grace_players_are_never_knocked:
// 騎士與斷線保留期中的玩家永不被撞飛
#[tokio::test(start_paused = true)]
async fn riders_and_grace_players_are_never_knocked() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    a.walk_to_counter().await;
    a.claim(0).await; // bay 0 (-10.5, 7.0)
    sleep(Duration::from_millis(50)).await;

    b.walk_to_counter().await;
    b.claim(1).await; // bay 1 (-10.5, 9.25)
    sleep(Duration::from_millis(50)).await;
    a.drain();
    b.drain();

    // 1. 騎士永不被撞飛：a 全速開走（清出 bay 0），b 留在車上
    for seq in 1..=30 {
        a.drive(seq, DIR_EAST, 255).await;
        sleep(Duration::from_millis(33)).await;
    }
    assert!(find_knock_msg(&a.drain()).is_none());
    assert!(find_knock_msg(&b.drain()).is_none());

    // 2. 斷線保留期（grace）中的玩家永不被撞飛：c 站在遊戲區外 bay 0 正東方後斷線
    let mut c = connect(&room).await;
    c.walk_east_of_bay0().await;
    c.disconnect().await;
    sleep(Duration::from_millis(50)).await;

    // 由另一司機 d 從 bay 0 高速向東衝過 c 的位置
    let mut d = connect(&room).await;
    d.walk_to_counter().await;
    d.drain();
    d.claim(2).await;
    sleep(Duration::from_millis(50)).await;
    let d_car = find_car_msg(&d.drain()).expect("d claims a car");
    assert_eq!(
        (d_car.x, d_car.z),
        (-10.5, 7.0),
        "bay 0 is free again so d's car starts west of c"
    );
    let mut passed_c = false;
    for seq in 1..=30 {
        d.drive(seq, DIR_EAST, 255).await;
        sleep(Duration::from_millis(33)).await;
        for msg in d.drain() {
            match msg {
                ServerMessage::Knock { id, .. } => assert_ne!(id, c.who.id),
                ServerMessage::Cars { cars, .. } => {
                    passed_c |= cars
                        .iter()
                        .any(|s| s.c == d_car.c && s.x > EAST_OF_BAY0.0 + 0.5);
                }
                _ => {}
            }
        }
    }
    assert!(passed_c, "d's car must actually drive through c's position");
}

// 27. two_players_mounting_the_same_car_only_one_wins:
// 兩人同時上同一台空車，只有一人成功，另一人收到 car_unavailable
#[tokio::test(start_paused = true)]
async fn two_players_mounting_the_same_car_only_one_wins() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.ride(None).await;
    sleep(Duration::from_millis(50)).await;

    a.walk_to_bay0().await;
    b.walk_to_bay0().await;
    a.drain();
    b.drain();

    a.ride(Some(0)).await;
    b.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;

    let msgs_a = a.drain();
    let msgs_b = b.drain();

    let car_a = find_car_msg(&msgs_a);
    let car_b = find_car_msg(&msgs_b);
    let err_a = msgs_a.iter().find_map(|m| match m {
        ServerMessage::Error { code, .. } => Some(code.as_str()),
        _ => None,
    });
    let err_b = msgs_b.iter().find_map(|m| match m {
        ServerMessage::Error { code, .. } => Some(code.as_str()),
        _ => None,
    });

    let a_won = car_a
        .as_ref()
        .is_some_and(|c| c.driver.as_deref() == Some(&a.who.id));
    let b_won = car_b
        .as_ref()
        .is_some_and(|c| c.driver.as_deref() == Some(&b.who.id));
    assert!(a_won ^ b_won, "exactly one player should win the mount");
    if a_won {
        assert_eq!(err_b, Some("car_unavailable"));
    } else {
        assert_eq!(err_a, Some("car_unavailable"));
    }
}

// 28. zone_change_while_riding_is_refused_with_dismount_first:
// 騎乘中切換場景被拒，收到 dismount_first
#[tokio::test(start_paused = true)]
async fn zone_change_while_riding_is_refused_with_dismount_first() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    a.send_zone("hall").await;
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let err = msgs.iter().find_map(|m| match m {
        ServerMessage::Error { code, .. } => Some(code.as_str()),
        _ => None,
    });
    assert_eq!(err, Some("dismount_first"));
}

// 29. rider_is_absent_from_moves_and_their_move_messages_are_ignored:
// 騎乘中的玩家不會出現在 moves，且送出的 move 被忽略
#[tokio::test(start_paused = true)]
async fn rider_is_absent_from_moves_and_their_move_messages_are_ignored() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    b.drain();
    a.drain();

    a.send_move(0.0, 5.0, 0.0, true).await;
    sleep(Duration::from_millis(150)).await;

    let msgs_b = b.drain();
    for msg in msgs_b {
        if let ServerMessage::Moves { m } = msg {
            assert!(
                m.iter().all(|tuple| tuple.0 != a.n),
                "rider should not be present in moves"
            );
        }
    }
}

// 30. dismount_places_the_player_beside_the_car_and_schedules_fade:
// 下車落點距車體 1.1 ± 0.01、不在障礙物內、fadeAt == 下車時的 session_ms + 45000（±一個 tick）
#[tokio::test(start_paused = true)]
async fn dismount_places_the_player_beside_the_car_and_schedules_fade() {
    let t0 = Instant::now();
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    a.ride(None).await;
    let session_ms = elapsed_ms(t0);
    sleep(Duration::from_millis(50)).await;

    let msgs = a.drain();
    let sync_msg = msgs
        .iter()
        .find_map(|m| match m {
            ServerMessage::Sync { m } => Some(m.clone()),
            _ => None,
        })
        .expect("sync message on dismount");
    let (_n, px, pz, _heading, _moving) = sync_msg[0];

    let car_msg = find_car_msg(&msgs).expect("car message");
    let fade_at = car_msg.fade_at.expect("fade_at must be scheduled");
    let expected = session_ms + params().fade.idle_ms as f64;
    assert!(
        (fade_at - expected).abs() <= TICK.as_millis() as f64,
        "fadeAt {fade_at} should be {expected}"
    );

    // sync 的座標取到公分（誤差 ≤ 0.005·√2 ≈ 0.007），所以 ±0.01 仍然穩定。
    let dist = (px - car_msg.x).hypot(pz - car_msg.z);
    assert!(
        (dist - 1.1).abs() <= 0.01,
        "distance to car should be 1.1 ± 0.01, got {dist}"
    );
    assert!(
        !world::COURTYARD
            .obstacles
            .iter()
            .any(|s| s.contains(px, pz)),
        "landing point must not be inside a padded obstacle"
    );
}

// 31. dismount_falls_back_to_the_car_position_when_all_sides_are_blocked:
// 候選點均落入障礙物或邊界外時，落點回退至車體中心
#[test]
fn dismount_falls_back_to_the_car_position_when_all_sides_are_blocked() {
    let mut room = Room::new(1, cfg(), Default::default());
    let (tx, _rx) = mpsc::channel(2048);
    let now = Instant::now();
    let who = room
        .join("blocked".into(), AuthKind::Guest, 0, tx, now)
        .expect("join");

    let c = room.vehicles.spawn(100.0, 100.0, 0.0).expect("spawn car");
    room.cars.insert(
        c,
        Car {
            kind: 0,
            driver: Some(who.id.clone()),
            remove_at: None,
            last_input_at: now,
            fade_at: None,
        },
    );
    let p = room.players.get_mut(&who.id).unwrap();
    p.riding = Some(c);

    room.dismount(&who.id, now);

    let p = room.players.get(&who.id).unwrap();
    assert_eq!(p.x, 100.0);
    assert_eq!(p.z, 100.0);
    assert!(p.riding.is_none());
}

// 32. entering_the_courtyard_receives_every_car_including_sleeping_ones:
// 進入庭院收到完整車輛快照，包含休眠車輛
#[tokio::test(start_paused = true)]
async fn entering_the_courtyard_receives_every_car_including_sleeping_ones() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.ride(None).await;
    sleep(Duration::from_millis(2000)).await;

    let mut b = connect(&room).await;
    b.enter_hall().await;
    b.drain();

    // 走到殿內通往庭院的門口範圍 (0.0, 8.4)
    b.position(0.0, 8.4).await;
    sleep(Duration::from_millis(50)).await;

    b.send_zone("courtyard").await;
    sleep(Duration::from_millis(50)).await;

    let msgs_b = b.drain();
    let cars_msg = msgs_b
        .iter()
        .find_map(|m| match m {
            ServerMessage::Cars { cars, .. } => Some(cars.clone()),
            _ => None,
        })
        .expect("entering courtyard must receive Cars message");

    assert!(
        cars_msg.iter().any(|c| c.c == 0),
        "Cars frame must include car 0 even when sleeping"
    );
}

// 33. walker_can_push_a_sleeping_empty_car:
// 步行者靠近休眠空車能維持物理步進並以動力學碰撞推動車輛，離開後車輛再次入睡
#[test]
fn walker_can_push_a_sleeping_empty_car() {
    let mut room = Room::new(1, cfg(), Default::default());
    let (tx, _rx) = mpsc::channel(2048);
    let now = Instant::now();
    let who = room
        .join("walker".into(), AuthKind::Guest, 0, tx, now)
        .expect("join");

    let c = room.vehicles.spawn(-12.0, 7.5, 0.0).expect("spawn car");
    room.cars.insert(
        c,
        Car {
            kind: 0,
            driver: None,
            remove_at: Some(now + Duration::from_secs(60)),
            last_input_at: now,
            fade_at: None,
        },
    );

    // 步進讓車靜止入睡
    for _ in 0..100 {
        room.physics_step(now);
    }
    assert!(!room.vehicles.any_awake(), "car should be sleeping");
    assert!(
        !room.should_physics_step(),
        "should not step when walker is far"
    );

    // 步行者移動靠近車輛 (x: -11.2, z: 7.5，距離車身約 0.8m <= 1.0m)
    let p = room.players.get_mut(&who.id).unwrap();
    p.x = -11.2;
    p.z = 7.5;
    p.moving = true;
    assert!(
        room.should_physics_step(),
        "should step because walker is moving near sleeping car"
    );

    let init_x = room.vehicles.car(c).unwrap().x;

    // 步行者推動車輛
    for i in 1..=30 {
        let p = room.players.get_mut(&who.id).unwrap();
        p.x = -11.2 - (i as f64) * 0.03;
        p.moving = true;
        room.physics_step(now + Duration::from_millis(i * 33));
    }

    let pushed_x = room.vehicles.car(c).unwrap().x;
    assert!(
        pushed_x < init_x - 0.2,
        "car should have been pushed by walker: init {init_x}, now {pushed_x}"
    );

    // 步行者平順退開車輛 (> 1.0m)
    for i in 1..=20 {
        let p = room.players.get_mut(&who.id).unwrap();
        p.x = -12.1 + (i as f64) * 0.1;
        p.moving = true;
        room.physics_step(now + Duration::from_millis((30 + i) * 33));
    }
    let p = room.players.get_mut(&who.id).unwrap();
    p.moving = false;

    // 車輛經過一段時間再度入睡
    for i in 1..=250 {
        room.physics_step(now + Duration::from_millis((50 + i) * 33));
    }
    assert!(!room.vehicles.any_awake());
    assert!(!room.should_physics_step());
}

// ==========================================
// 任務 18：廟會時段、遊戲區免撞與稽核修正
// ==========================================

fn error_code(msgs: &[ServerMessage]) -> Option<&str> {
    msgs.iter().find_map(|m| match m {
        ServerMessage::Error { code, .. } => Some(code.as_str()),
        _ => None,
    })
}

// 時段外 claim 與 ride(Some) 回 session_closed（優先於其他條件，車不存在也一樣）；
// ride(None) 不受影響；時段一開始就能領車。
#[tokio::test(start_paused = true)]
async fn claim_and_ride_are_refused_with_session_closed_outside_the_window() {
    let t0 = Instant::now();
    // 房間建立時是 3_590_000 毫秒：關閉中，10 秒後（3_600_000）開放。
    let room = spawn_room(RoomConfig {
        session_clock: SessionClock::Fixed {
            base_ms: 3_590_000.0,
        },
        ..RoomConfig::new(50)
    });
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.drain();

    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    let msgs = a.drain();
    assert_eq!(error_code(&msgs), Some("session_closed"));
    assert!(find_car_msg(&msgs).is_none());

    a.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;
    assert_eq!(error_code(&a.drain()), Some("session_closed"));

    // 下車指令（沒有在騎乘）不回任何錯誤
    a.ride(None).await;
    sleep(Duration::from_millis(50)).await;
    assert_eq!(error_code(&a.drain()), None);

    // 開放的前一刻仍拒絕，開放之後領車成功
    sleep_until(t0 + Duration::from_millis(9_950)).await;
    a.drain();
    a.claim(0).await;
    sleep(Duration::from_millis(10)).await;
    assert_eq!(error_code(&a.drain()), Some("session_closed"));
    sleep_until(t0 + Duration::from_millis(10_000)).await;
    a.claim(0).await;
    sleep(Duration::from_millis(10)).await;
    let car = find_car_msg(&a.drain()).expect("claim succeeds once the session opens");
    assert_eq!(car.driver.as_deref(), Some(a.who.id.as_str()));
}

// 時段結束：騎士下車，每台車（含原本就空著的）立即開始淡出（fadeAt = 結束時刻），15 秒後 carGone；
// 之後 claim 回 session_closed。房間建立時是 1_780_000 毫秒（結束前 20 秒），
// 讓騎士在 60 秒閒置下車之前就遇到時段結束。
#[tokio::test(start_paused = true)]
async fn closing_the_session_dismounts_riders_and_fades_every_car() {
    const BASE: f64 = 1_780_000.0;
    const CLOSE: f64 = 1_800_000.0;
    let t0 = Instant::now();
    let close_at = t0 + Duration::from_secs_f64((CLOSE - BASE) / 1000.0);
    let fade = Duration::from_millis(params().fade.fade_ms);
    let room = spawn_room(RoomConfig {
        session_clock: SessionClock::Fixed { base_ms: BASE },
        ..RoomConfig::new(50)
    });
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    // a 騎著車 0；b 領車 1 後下車（空車，原本 60 秒後才移除）
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    b.walk_to_counter().await;
    b.claim(1).await;
    sleep(Duration::from_millis(50)).await;
    b.ride(None).await;
    sleep(Duration::from_millis(50)).await;
    assert!(Instant::now() < close_at - Duration::from_secs(5));
    a.drain();

    sleep_until(close_at - Duration::from_millis(50)).await;
    let before = a.drain();
    assert!(
        find_car_msg(&before).is_none(),
        "nothing happens before close"
    );

    sleep_until(close_at + Duration::from_millis(50)).await;
    let msgs = a.drain();
    // 每台車最後一則 car：無人騎乘、fadeAt == 結束時刻（±一個 tick）
    for c in [0u8, 1] {
        let last = msgs
            .iter()
            .filter_map(|m| match m {
                ServerMessage::Car {
                    c: car,
                    driver,
                    fade_at,
                    ..
                } if *car == c => Some((driver.clone(), *fade_at)),
                _ => None,
            })
            .next_back()
            .unwrap_or_else(|| panic!("car {c} must be broadcast at close"));
        assert_eq!(last.0, None, "car {c} has no driver after close");
        let fade_at = last.1.expect("fadeAt is set");
        assert!(
            (CLOSE..=CLOSE + TICK.as_millis() as f64).contains(&fade_at),
            "car {c}: fadeAt {fade_at} should be {CLOSE}"
        );
    }
    // 騎士本人收到下車的 sync
    assert!(find_sync_msg(&msgs).is_some(), "rider gets a dismount sync");

    // 結束後 15 秒才移除：之前沒有 carGone，之後兩台都 carGone
    sleep_until(close_at + fade - Duration::from_millis(100)).await;
    assert!(
        !a.drain()
            .iter()
            .any(|m| matches!(m, ServerMessage::CarGone { .. })),
        "cars are not removed before fadeMs"
    );
    sleep_until(close_at + fade + Duration::from_millis(100)).await;
    let mut gone: Vec<u8> = a
        .drain()
        .iter()
        .filter_map(|m| match m {
            ServerMessage::CarGone { c } => Some(*c),
            _ => None,
        })
        .collect();
    gone.sort_unstable();
    assert_eq!(gone, [0, 1]);

    // 時段外再領車
    sleep(Duration::from_secs(21)).await; // b 的 20 秒冷卻也已過
    b.drain();
    b.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    assert_eq!(error_code(&b.drain()), Some("session_closed"));
}

// 遊戲區（booth.zone，含邊界）內的步行者不會被撞飛；同一台快車撞到區外的人。
#[test]
fn players_inside_the_game_zone_are_not_knocked() {
    let zone = &params().booth.zone;
    let (mut room, rider, c, t0, _rider_rx) = room_with_rider_at_bay0();
    // 區內：緊貼遊戲區東緣、在車頭 0.25 公尺處；區外：bay 0 正東方
    let inside = (zone.max_x as f64 - 0.05, 7.0);
    assert!(zone.contains(inside.0, inside.1));
    assert!(!zone.contains(EAST_OF_BAY0.0, EAST_OF_BAY0.1));
    let (inner, _inner_rx) = add_walker(&mut room, inside.0, inside.1, t0);
    let (outer, _outer_rx) = add_walker(&mut room, EAST_OF_BAY0.0, EAST_OF_BAY0.1, t0);

    let k = &params().knock;
    let mut seq = 0u16;
    let mut inner_exposed = false;
    let mut outer_knocked = false;
    for i in 1..=30u64 {
        let now = t0 + Duration::from_millis(33 * i);
        let (hit, exposed) = drive_pass(&mut room, &rider, &mut seq, c, &inner.id, now, 1);
        assert!(!hit, "a player inside the game zone must not be knocked");
        inner_exposed |= exposed;
        if room.players[&outer.id].knocked_until.is_some() {
            outer_knocked = true;
            break;
        }
    }
    assert!(
        inner_exposed,
        "the car must reach the inner player within {} m at ≥ {} m/s",
        k.hit_radius, k.min_speed
    );
    assert!(
        outer_knocked,
        "the same car knocks the player outside the zone"
    );
    assert!(room.players[&inner.id].knocked_until.is_none());
}

// 撞擊發生在不廣播的物理步（奇數步）時，下一則 cars 幀仍帶 bumped，廣播後清除。
#[test]
fn a_bump_on_a_non_broadcast_step_still_reaches_the_next_cars_frame() {
    let every = u64::from(params().physics.broadcast_every_steps);
    assert_eq!(every, 2);
    let (mut room, rider, c, t0, mut rider_rx) = room_with_rider_at_bay0();
    // 東方 3 公尺處放一台空車，讓騎士全速撞上去
    let target = room.vehicles.spawn(-7.0, 7.0, 0.0).unwrap();
    room.cars.insert(
        target,
        Car {
            kind: 1,
            driver: None,
            remove_at: Some(t0 + Duration::from_secs(60)),
            last_input_at: t0,
            fade_at: None,
        },
    );

    let mut seq = 0u16;
    let mut bump_step = None;
    for i in 1..=60u64 {
        let now = t0 + Duration::from_millis(33 * i);
        seq += 1;
        room.drive(&rider, seq, DIR_EAST, 255, now);
        room.physics_step(now);
        // 廣播步會清除 bumped，所以非廣播步之後看到的 bumped 一定來自這一步。
        if !room.physics_steps.is_multiple_of(every) && room.vehicles.car(c).unwrap().bumped {
            bump_step = Some(i);
            break;
        }
    }
    let i = bump_step.expect("the rider must bump the parked car on a non-broadcast step");

    // 拿掉被撞的車，下一步（廣播步）不可能再有新的撞擊
    room.vehicles.remove(target);
    room.cars.remove(&target);
    while rider_rx.try_recv().is_ok() {}
    let now = t0 + Duration::from_millis(33 * (i + 1));
    room.physics_step(now);
    assert!(room.physics_steps.is_multiple_of(every));
    let frame = std::iter::from_fn(|| rider_rx.try_recv().ok())
        .find_map(|m| match m {
            ServerMessage::Cars { cars, .. } => Some(cars),
            _ => None,
        })
        .expect("broadcast step sends a cars frame");
    let state = frame.iter().find(|s| s.c == c).expect("rider's car");
    assert!(
        state.bumped,
        "the bump from the previous step must be reported"
    );

    // 已廣播過就清除：再兩步後的幀不帶 bumped
    for j in 2..=3 {
        room.physics_step(t0 + Duration::from_millis(33 * (i + j)));
    }
    let frame = std::iter::from_fn(|| rider_rx.try_recv().ok())
        .filter_map(|m| match m {
            ServerMessage::Cars { cars, .. } => Some(cars),
            _ => None,
        })
        .last()
        .expect("next cars frame");
    assert!(!frame.iter().find(|s| s.c == c).unwrap().bumped);
}

fn physics_step_count(metrics: &Metrics) -> u64 {
    metrics
        .render()
        .lines()
        .find_map(|l| l.strip_prefix("temple_physics_step_seconds_count "))
        .expect("physics count metric")
        .parse()
        .unwrap()
}

// 補步上限：房間 task 落後約 1 秒後醒來，只補 maxCatchUpSteps（3）步，之後回到原本的節拍。
#[test]
fn catch_up_steps_counts_the_due_step_plus_missed_ones_up_to_the_cap() {
    let step = Duration::from_nanos(1_000_000_000 / 30);
    assert_eq!(catch_up_steps(Duration::ZERO, step, 3), 1);
    assert_eq!(catch_up_steps(Duration::from_millis(20), step, 3), 1);
    assert_eq!(catch_up_steps(Duration::from_millis(40), step, 3), 2);
    assert_eq!(catch_up_steps(Duration::from_millis(70), step, 3), 3);
    assert_eq!(catch_up_steps(Duration::from_secs(1), step, 3), 3);
    assert_eq!(catch_up_steps(Duration::from_secs(1), step, 0), 1);
}

#[tokio::test(start_paused = true)]
async fn catch_up_is_capped_at_three_steps_after_a_long_stall() {
    let p = params();
    assert_eq!(p.physics.max_catch_up_steps, 3);
    let step = Duration::from_nanos(1_000_000_000 / u64::from(p.physics.hz));
    let metrics = Arc::new(Metrics::default());
    let t0 = Instant::now();
    let (tx, rx) = mpsc::channel(128);
    tokio::spawn(run_room(1, cfg(), rx, metrics.clone()));
    let mut a = connect(&tx).await;
    a.walk_to_counter().await;
    a.claim(0).await; // 有騎士：每個物理 tick 都會步進
    sleep(Duration::from_millis(50)).await;

    // 對齊到兩個物理 tick 的正中間，房間 task 正在等下一個 tick
    let k = (Instant::now() - t0).as_nanos() / step.as_nanos() + 2;
    sleep_until(t0 + step * k as u32 + step / 2).await;
    let before = physics_step_count(&metrics);

    // 時間一次跳 1 秒（房間 task 這段期間沒有機會執行），醒來後只補 3 步
    tokio::time::advance(Duration::from_secs(1)).await;
    sleep(Duration::from_millis(1)).await;
    let after_stall = physics_step_count(&metrics);
    assert_eq!(after_stall - before, 3, "catch-up after a 1 s stall");

    // 之後回到每秒 30 步的節拍
    sleep(Duration::from_secs(1)).await;
    let steady = physics_step_count(&metrics) - after_stall;
    assert!(
        (29..=31).contains(&steady),
        "steady steps per second: {steady}"
    );
}

// 不指定車種連續領車：每台都由伺服器依權重抽，各車種數量都不超過 count，領滿後回 car_unavailable。
#[test]
fn claim_assigns_a_random_kind_and_never_exceeds_stock() {
    let p = params();
    let total: usize = p.kinds.iter().map(|k| k.count as usize).sum();
    let mut room = Room::new(1, cfg(), Default::default());
    let mut now = Instant::now();
    let mut keep = Vec::new();
    let mut counts = vec![0u8; p.kinds.len()];
    for i in 0..=total {
        let (tx, mut rx) = mpsc::channel(8192);
        let who = room
            .join(format!("p{i}"), AuthKind::Guest, 0, tx, now)
            .unwrap();
        let pl = room.players.get_mut(&who.id).unwrap();
        (pl.x, pl.z) = (-11.0, 9.25);
        while rx.try_recv().is_ok() {}
        // 與 run_room 處理 `RoomCommand::Claim { kind: None }` 相同
        let kind = room.roll_kind();
        room.claim(&who, kind, now);
        let msgs: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        if i == total {
            assert_eq!(
                error_code(&msgs),
                Some("car_unavailable"),
                "every kind is at its count"
            );
            assert_eq!(room.cars.len(), total);
            break;
        }
        let car = find_car_msg(&msgs).unwrap_or_else(|| panic!("claim {i}: {msgs:?}"));
        counts[car.kind as usize] += 1;
        for (k, n) in counts.iter().enumerate() {
            assert!(*n <= p.kinds[k].count, "kind {k}: {n} > count");
        }
        // 開走清出停車位：沿停車位的方向（向東）全速 1 秒
        for s in 1..=30u16 {
            now += Duration::from_millis(33);
            room.drive(&who, s, DIR_EAST, 255, now);
            room.physics_step(now);
        }
        keep.push(rx);
    }
    let expected: Vec<u8> = p.kinds.iter().map(|k| k.count).collect();
    assert_eq!(counts, expected, "claims until full use up every kind");
}

// 手動開關廟會（fair）：時鐘在開放時段內，手動關閉 → 全房收到 fair、騎士下車、車開始淡出、claim 被拒；
// 新連線在 welcome 之後收到 fair；手動開啟後 claim 不再回 session_closed。
#[tokio::test(start_paused = true)]
async fn fair_override_closes_and_reopens_the_session_for_everyone() {
    let room = spawn_room(cfg());
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    assert!(find_car_msg(&a.drain()).is_some());
    b.drain();

    let fair = |open: bool, who: &Who| RoomCommand::Fair {
        who: who.clone(),
        open,
    };
    let is_fair = |msgs: &[ServerMessage], open: bool| {
        msgs.iter()
            .any(|m| matches!(m, ServerMessage::Fair { open: o } if *o == open))
    };
    room.send(fair(false, &b.who)).await.unwrap();
    sleep(Duration::from_millis(250)).await;
    let (ma, mb) = (a.drain(), b.drain());
    assert!(is_fair(&ma, false) && is_fair(&mb, false));
    let car = find_car_msg(&ma).expect("closing broadcasts the car");
    assert_eq!(car.driver, None);
    assert!(car.fade_at.is_some());
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    assert_eq!(error_code(&a.drain()), Some("session_closed"));

    let mut c = connect(&room).await;
    assert!(is_fair(&c.drain(), false));

    room.send(fair(true, &a.who)).await.unwrap();
    sleep(Duration::from_millis(50)).await;
    assert!(is_fair(&a.drain(), true));
    // 領車冷卻還沒過，所以只確認不再被時段擋下。
    a.claim(1).await;
    sleep(Duration::from_millis(50)).await;
    assert_ne!(error_code(&a.drain()), Some("session_closed"));
}
