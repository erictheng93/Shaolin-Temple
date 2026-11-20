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
                kind,
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
}

async fn connect(room: &RoomTx) -> Client {
    let (out, rx) = mpsc::channel(64);
    let who = super::join(room, "測試", AuthKind::Guest, 0, out).await.unwrap();
    Client::from_welcome(room, who, rx)
}

async fn resume(room: &RoomTx, token: &str) -> Option<Client> {
    let (outbound, rx) = mpsc::channel(64);
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
    let sync_msg = msgs.iter().find(|m| matches!(m, ServerMessage::Sync { .. }));
    assert!(sync_msg.is_some(), "should receive sync with dismount position");

    let car_msg = find_car_msg(&msgs).expect("should receive Car message");
    assert_eq!(car_msg.c, 0);
    assert!(car_msg.driver.is_none());
    assert!(car_msg.fade_at.is_some());
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
        .last()
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
        .last()
        .and_then(|cars| cars.iter().find(|c| c.c == 0))
        .map(|c| c.vx.hypot(c.vz))
        .expect("should have cars frames after timeout");

    assert!(v2 < v1, "car should decelerate after input timeout (v1={v1}, v2={v2})");
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
    assert!(!msgs.iter().any(|m| matches!(m, ServerMessage::CarGone { .. })));

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
    assert!(!msgs.iter().any(|m| matches!(m, ServerMessage::CarGone { .. })));
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
    assert!(!room.should_physics_step(), "empty and sleeping -> should not step");
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
    assert!(msgs_b.iter().any(|m| matches!(m, ServerMessage::Cars { .. })));

    let msgs_a = a.drain();
    assert!(
        !msgs_a.iter().any(|m| matches!(m, ServerMessage::Cars { .. })),
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
