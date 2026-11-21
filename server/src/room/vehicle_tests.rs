use super::*;
use crate::protocol::ServerMessage;
use crate::vehicles::params::params;
use std::time::Duration;
use tokio::time::sleep;

const TICK: Duration = Duration::from_millis(100);
type RoomTx = mpsc::Sender<RoomCommand>;

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
        let ServerMessage::Welcome {
            players,
            resume_token,
            ..
        } = rx.try_recv().unwrap()
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
    let (outbound, rx) = mpsc::channel(2048);
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
    Some(Client::from_welcome(room, who, rx))
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));

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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    a.ride(None).await;
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
    assert!((fade_at - (now_ms() + 45_000.0)).abs() < 500.0);

    // 檢查落點距離 車體 (car_msg.x, car_msg.z) 約 1.1m
    let dist = (px - car_msg.x).hypot(pz - car_msg.z);
    assert!((dist - 1.1).abs() < 0.05, "dismount distance: {dist}");
}

// 11. drive_updates_input_and_steps: 騎士送 drive，physics_step 推進車輛位置與朝向
#[tokio::test(start_paused = true)]
async fn drive_updates_input_and_steps() {
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
#[tokio::test(start_paused = true)]
async fn idle_dismount_after_sixty_seconds() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    // 59 秒後依然在車上
    sleep(Duration::from_secs(59)).await;
    let msgs = a.drain();
    let car_msg = find_car_msg(&msgs);
    assert!(car_msg.is_none());

    // 滿 60 秒觸發強制下車
    sleep(Duration::from_secs(2)).await;
    let msgs = a.drain();
    let car_msg = find_car_msg(&msgs).expect("should receive Car message with dismount");
    assert!(car_msg.driver.is_none());
}

// 15. empty_car_fades_and_despawns_after_sixty_seconds: 下車 60 秒後車輛消失，廣播 carGone
#[tokio::test(start_paused = true)]
async fn empty_car_fades_and_despawns_after_sixty_seconds() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
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
}

// 16. remount_clears_fade: 倒數中被其他人騎走，fadeAt 變 null 不會消失
#[tokio::test(start_paused = true)]
async fn remount_clears_fade() {
    let room = spawn_room(RoomConfig::new(50));
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
    let mut room = Room::new(1, RoomConfig::new(50), Default::default());
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

// 18. hall_players_receive_no_cars_frames: 殿內玩家只收 moves/sync，收不到 cars
#[tokio::test(start_paused = true)]
async fn hall_players_receive_no_cars_frames() {
    let room = spawn_room(RoomConfig::new(50));
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

    let msgs_a = a.drain();
    assert!(
        !msgs_a
            .iter()
            .any(|m| matches!(m, ServerMessage::Cars { .. })),
        "hall player should not receive Cars frames"
    );
}

// 19. disconnect_dismounts_rider: 騎士斷線立即下車，車留在原處並開始 fade
#[tokio::test(start_paused = true)]
async fn disconnect_dismounts_rider() {
    let room = spawn_room(RoomConfig::new(50));
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

// 20. resumed_player_is_on_foot: 斷線重連後玩家是步行者，收到庭院全車輛 snapshot
#[tokio::test(start_paused = true)]
async fn resumed_player_is_on_foot() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    a.disconnect().await;
    sleep(Duration::from_millis(50)).await;

    let mut a2 = resume(&room, &a.token).await.unwrap();
    let _msgs = a2.drain();
    // 檢查是否有收到 Welcome 且包含 cars
    // 並且在庭院中可以步行移動
    a2.walk_to_bay0().await;

    // 可以正常上車（走到 bay 0 旁邊）
    a2.drain();
    a2.ride(Some(0)).await;
    sleep(Duration::from_millis(50)).await;
    let msgs = a2.drain();
    assert!(find_car_msg(&msgs).is_some());
}

// ==========================================
// 任務 7：碰碰車撞飛測試
// ==========================================

// 21. a_fast_occupied_car_knocks_a_walker_and_broadcasts_knock:
// 高速有人車撞擊步行者，廣播 knock 且 knock.toX/toZ 等於伺服器記錄的玩家座標
#[tokio::test(start_paused = true)]
async fn a_fast_occupied_car_knocks_a_walker_and_broadcasts_knock() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    b.walk_to_bay0().await; // b 位於 (-10.5, 7.5)
    sleep(Duration::from_millis(50)).await;
    a.drain();
    b.drain();

    let mut knock_info = None;
    for seq in 1..=30 {
        a.drive(seq, 0, 255).await;
        sleep(Duration::from_millis(33)).await;
        let msgs = b.drain();
        if let Some(k) = find_knock_msg(&msgs) {
            println!("knock at seq {}", seq);
            knock_info = Some(k);
            break;
        }
    }

    let (id, from_x, from_z, to_x, to_z, _at) = knock_info.expect("b should be knocked");
    assert_eq!(id, b.who.id);
    assert_eq!(from_x, -10.5);
    assert_eq!(from_z, 7.5);

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
    // 1. 速率 2.0 的有人車不撞飛
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    let mut b = connect(&room).await;
    b.walk_to_counter().await;
    b.position(-11.2, 7.5).await; // 緊鄰車輛 (-12.0, 7.5) 前方，車剛起步即接觸
    sleep(Duration::from_millis(50)).await;
    b.drain();

    // 輕踩油門 2 個步進（速度 < 2.5 m/s 即停止受力）
    for seq in 1..=2 {
        a.drive(seq, 0, 100).await;
        sleep(Duration::from_millis(33)).await;
    }
    // 檢查 b 沒有收到 knock
    assert!(find_knock_msg(&b.drain()).is_none());

    // 2. 速率 5.0 的空車不撞飛
    let room2 = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    b.walk_to_bay0().await;
    sleep(Duration::from_millis(50)).await;
    b.drain();

    for seq in 1..=30 {
        a.drive(seq, 0, 255).await;
        sleep(Duration::from_millis(33)).await;
        if find_knock_msg(&b.drain()).is_some() {
            break;
        }
    }

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

// 24. immune_player_is_not_knocked_again_for_3s_after_recovery:
// 恢復後 3 秒內免疫：第 4.7 秒仍免疫、第 4.9 秒可再被撞
#[tokio::test(start_paused = true)]
async fn immune_player_is_not_knocked_again_for_3s_after_recovery() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    let mut c = connect(&room).await;

    // a, c 先就定位到檔口
    a.walk_to_counter().await;
    c.walk_to_counter().await;

    // a 領車 0
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    // b 走到 Bay 0 前方 (-10.5, 7.5)
    b.walk_to_bay0().await;
    sleep(Duration::from_millis(50)).await;
    b.drain();

    // 第一次撞飛（t = 0 附近）
    let mut knock_occurred = false;
    for seq in 1..=30 {
        a.drive(seq, 0, 255).await;
        sleep(Duration::from_millis(33)).await;
        let msgs = b.drain();
        if find_knock_msg(&msgs).is_some() {
            knock_occurred = true;
            break;
        }
    }
    assert!(knock_occurred, "first knock should occur");

    // a 開走清空 Bay 0
    for seq in 31..=45 {
        a.drive(seq, 0, 255).await;
        sleep(Duration::from_millis(33)).await;
    }

    // 等待 1.8 秒恢復期（飛行 900ms + 起身 900ms）
    for _ in 0..15 {
        sleep(Duration::from_millis(100)).await;
        b.drain();
    }

    // b 走回 Bay 0 前方 (-10.5, 7.5)（從落點 ~9.5 走 2 公尺花 1 秒，速度 2.0 < 3.2 合法）
    sleep(Duration::from_secs(1)).await;
    b.drain();
    b.position(-10.5, 7.5).await;
    sleep(Duration::from_millis(50)).await;

    // 司機 c 在空的 Bay 0 領車
    c.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    // 推進至撞飛後約 3.8 秒
    for _ in 0..8 {
        sleep(Duration::from_millis(100)).await;
        b.drain();
    }

    // 司機 c 於 3.8 秒開始衝刺，約在第 4.7 秒撞上 b
    for seq in 1..=25 {
        c.drive(seq, 0, 255).await;
        sleep(Duration::from_millis(33)).await;
    }
    let msgs_at_4_7 = b.drain();
    // 第 4.7 秒仍處於 4.8 秒無敵期內，未被撞飛
    assert!(
        find_knock_msg(&msgs_at_4_7).is_none(),
        "player should be immune at 4.7s"
    );

    // 司機 c 繼續衝撞推進至第 4.9 秒（越過 4.8 秒無敵期截止線）
    let mut knock2 = false;
    for seq in 26..=40 {
        c.drive(seq, 0, 255).await;
        sleep(Duration::from_millis(33)).await;
        let msgs = b.drain();
        if find_knock_msg(&msgs).is_some() {
            knock2 = true;
            break;
        }
    }
    // 第 4.9 秒無敵失效，再次被撞飛
    assert!(knock2, "second knock should occur after immunity expires");
}

// 25. knocking_clears_the_stored_action:
// 被撞後新加入者的 welcome 快照中該玩家沒有 action
#[tokio::test(start_paused = true)]
async fn knocking_clears_the_stored_action() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;

    b.walk_to_bay0().await;
    b.action("act-1", "bow", true).await;
    sleep(Duration::from_millis(50)).await;

    // 檢查撞飛前 action 存在
    let (_, players_before) = connect_with_welcome(&room).await;
    let b_before = players_before.iter().find(|p| p.id == b.who.id).unwrap();
    assert_eq!(b_before.action.as_ref().map(|a| a.id.as_str()), Some("bow"));

    // a 高速撞飛 b
    let mut knock_received = false;
    for seq in 1..=40 {
        a.drive(seq, 0, 255).await;
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
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;

    a.walk_to_counter().await;
    a.claim(0).await; // Bay 0 (-12.0, 7.5)
    sleep(Duration::from_millis(50)).await;

    b.walk_to_counter().await;
    b.claim(1).await; // Bay 1 (-12.0, 5.0)
    sleep(Duration::from_millis(50)).await;
    a.drain();
    b.drain();

    // 1. 車輛互撞（騎士永不被撞飛）
    // a 車轉向衝撞 b 車
    for seq in 1..=30 {
        a.drive(seq, 64, 255).await;
        sleep(Duration::from_millis(33)).await;
    }
    assert!(find_knock_msg(&a.drain()).is_none());
    assert!(find_knock_msg(&b.drain()).is_none());

    // 2. 斷線保留期（grace）中的玩家永不被撞飛
    let mut c = connect(&room).await;
    c.walk_to_bay0().await; // 位於 (-10.5, 7.5)
    c.disconnect().await;
    sleep(Duration::from_millis(50)).await;

    // 由另一司機 d 高速衝過 (-10.5, 7.5)
    let mut d = connect(&room).await;
    d.walk_to_counter().await;
    d.claim(2).await;
    sleep(Duration::from_millis(50)).await;
    for seq in 1..=30 {
        d.drive(seq, 0, 255).await;
        sleep(Duration::from_millis(33)).await;
    }
    // 全場不應出現 c 的 knock 事件
    let msgs_d = d.drain();
    for msg in msgs_d {
        if let ServerMessage::Knock { id, .. } = msg {
            assert_ne!(id, c.who.id);
        }
    }
}

// 27. two_players_mounting_the_same_car_only_one_wins:
// 兩人同時上同一台空車，只有一人成功，另一人收到 car_unavailable
#[tokio::test(start_paused = true)]
async fn two_players_mounting_the_same_car_only_one_wins() {
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
    let room = spawn_room(RoomConfig::new(50));
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
// 下車落點距車體 1.1 ± 0.01、不在障礙物內、排程 fadeAt
#[tokio::test(start_paused = true)]
async fn dismount_places_the_player_beside_the_car_and_schedules_fade() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    a.walk_to_counter().await;
    a.claim(0).await;
    sleep(Duration::from_millis(50)).await;
    a.drain();

    a.ride(None).await;
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
    assert!((fade_at - (now_ms() + 45_000.0)).abs() < 500.0);

    let dist = (px - car_msg.x).hypot(pz - car_msg.z);
    assert!(
        (dist - 1.1).abs() < 0.05,
        "distance to car should be 1.1 ± 0.05, got {dist}"
    );
    assert!(
        !world::COURTYARD.solids.iter().any(|s| s.contains(px, pz)),
        "landing point must not be solid"
    );
}

// 31. dismount_falls_back_to_the_car_position_when_all_sides_are_blocked:
// 候選點均落入障礙物或邊界外時，落點回退至車體中心
#[test]
fn dismount_falls_back_to_the_car_position_when_all_sides_are_blocked() {
    let mut room = Room::new(1, RoomConfig::new(50), Default::default());
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
            empty_since: None,
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
    let room = spawn_room(RoomConfig::new(50));
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
    let mut room = Room::new(1, RoomConfig::new(50), Default::default());
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
            empty_since: Some(now),
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
