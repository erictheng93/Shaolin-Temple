use super::*;
use crate::protocol::MAX_MESSAGE_BYTES;
use std::f64::consts::PI;
use tokio::time::sleep;

#[test]
fn full_room_welcome_fits_message_limit() {
    // 最壞情況：16 個 4-byte 字元的名稱、未四捨五入的 f64、最大的短編號。zone 與動作 id 限於
    // 已知場景與允許清單（取其中最長者）；若改為任意 32 bytes 字串，50 人快照會超過 16 KB。
    let n = -1.234_567_890_123_456_7e-300;
    let longest = |names: &[&'static str]| {
        names
            .iter()
            .max_by_key(|s| s.len())
            .map(|s| s.to_string())
            .unwrap()
    };
    let zone_ids: Vec<_> = world::ZONES.iter().map(|z| z.id).collect();
    let player = PlayerSnapshot {
        zone: Some(longest(&zone_ids)),
        id: format!("p-{:032x}", u128::MAX),
        n: u16::MAX,
        name: "😀".repeat(16),
        x: n,
        z: n,
        heading: n,
        action: Some(PlayerAction {
            id: longest(&world::ACTIONS),
            started_at: n,
        }),
    };
    let welcome = ServerMessage::Welcome {
        self_id: player.id.clone(),
        room: format!("room-{}", u64::MAX),
        resume_token: format!("{:x}.{:032x}", u64::MAX, u128::MAX),
        server_time: n,
        players: vec![player; MAX_ROOM_CAPACITY],
    };
    let bytes = serde_json::to_string(&welcome).unwrap().len();
    assert!(bytes <= MAX_MESSAGE_BYTES, "{bytes} > {MAX_MESSAGE_BYTES}");
}

// ---- 測試輔助 ----

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
    n: u16,
    token: String,
    zone: String,
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
            n: me.n,
            x: me.x,
            z: me.z,
            zone: me.zone.clone().unwrap(),
            token: resume_token,
            who,
            rx,
        }
    }
    fn drain(&mut self) -> Vec<ServerMessage> {
        std::iter::from_fn(|| self.rx.try_recv().ok()).collect()
    }
    /// 一直收（丟棄途中的其他訊息），直到收到短編號 `n` 位於 (x, z) 的 `moves`。
    /// 以事件而非時間判斷「該位置已廣播」：測試的 sleep 常與房間 tick 落在同一個虛擬瞬間，
    /// 誰先執行不固定，只 sleep 一個 tick 不保證那個 tick 已經送出。
    /// 位置被伺服器拒絕時永遠等不到，1 秒（虛擬時間）後失敗。
    async fn recv_move_of(&mut self, n: u16, x: f64, z: f64) {
        let target = (n, round2(x), round2(z));
        let wait = async {
            loop {
                match self.rx.recv().await.expect("room closed") {
                    ServerMessage::Moves { m } if m.iter().any(|t| (t.0, t.1, t.2) == target) => {
                        return;
                    }
                    _ => {}
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .unwrap_or_else(|_| panic!("no moves with {target:?}"));
    }
    async fn position(&self, x: f64, z: f64, heading: f64, moving: bool) {
        let command = RoomCommand::Position {
            who: self.who.clone(),
            x,
            z,
            heading,
            moving,
            at: Instant::now(),
        };
        self.room.send(command).await.unwrap();
    }
    async fn action(&self, req_id: &str, action: &str, data_ok: bool) {
        let command = RoomCommand::Action {
            who: self.who.clone(),
            req_id: req_id.into(),
            action: action.into(),
            data_ok,
        };
        self.room.send(command).await.unwrap();
    }
    async fn zone(&self, zone: &str) {
        let command = RoomCommand::Zone {
            who: self.who.clone(),
            zone: zone.into(),
        };
        self.room.send(command).await.unwrap();
    }
    async fn disconnect(&self) {
        self.room
            .send(RoomCommand::Disconnect(self.who.clone()))
            .await
            .unwrap();
    }
    /// 走到殿門口並進殿（以虛擬時間等待，讓速度驗證放行），回到清空訊息的狀態。
    /// 從出生點走到殿門：繞過香爐，每段都在移動額度內。
    async fn walk_to_door(&self) {
        for (x, z) in [(2.0, 5.0), (2.0, -4.0), (0.0, -5.6)] {
            sleep(Duration::from_secs(2)).await;
            self.position(x, z, PI, false).await;
        }
        sleep(TICK).await;
    }
    async fn enter_hall(&mut self) {
        self.walk_to_door().await;
        self.zone("hall").await;
        sleep(TICK).await;
        self.drain();
    }
}
async fn connect_with(room: &RoomTx, capacity: usize) -> Client {
    let (out, rx) = mpsc::channel(capacity);
    let who = join(room, "測試", out).await.unwrap();
    Client::from_welcome(room, who, rx)
}
async fn connect(room: &RoomTx) -> Client {
    connect_with(room, 64).await
}
async fn resume(room: &RoomTx, token: &str) -> Option<Client> {
    let (outbound, rx) = mpsc::channel(64);
    let (reply, received) = oneshot::channel();
    room.send(RoomCommand::Resume {
        token: token.into(),
        outbound,
        reply,
    })
    .await
    .unwrap();
    let who = received.await.unwrap()?;
    Some(Client::from_welcome(room, who, rx))
}

fn kind(m: &ServerMessage) -> &'static str {
    match m {
        ServerMessage::Welcome { .. } => "welcome",
        ServerMessage::Join { .. } => "join",
        ServerMessage::Leave { .. } => "leave",
        ServerMessage::Move { .. } => "move",
        ServerMessage::Moves { .. } => "moves",
        ServerMessage::Sync { .. } => "sync",
        ServerMessage::Action { .. } => "action",
        ServerMessage::Ack { .. } => "ack",
        ServerMessage::Zone { .. } => "zone",
        ServerMessage::Pong { .. } => "pong",
        ServerMessage::Error { .. } => "error",
    }
}
fn kinds(messages: &[ServerMessage]) -> Vec<&'static str> {
    messages.iter().map(kind).collect()
}
fn count(messages: &[ServerMessage], wanted: &str) -> usize {
    messages.iter().filter(|m| kind(m) == wanted).count()
}
fn move_tuples(messages: &[ServerMessage]) -> Vec<MoveTuple> {
    messages
        .iter()
        .flat_map(|m| match m {
            ServerMessage::Moves { m } => m.clone(),
            _ => vec![],
        })
        .collect()
}
fn acks(messages: &[ServerMessage]) -> Vec<(String, bool, Option<String>)> {
    messages
        .iter()
        .filter_map(|m| match m {
            ServerMessage::Ack { req_id, ok, reason } => {
                Some((req_id.clone(), *ok, reason.clone()))
            }
            _ => None,
        })
        .collect()
}
fn ack(req_id: &str, ok: bool, reason: Option<&str>) -> (String, bool, Option<String>) {
    (req_id.into(), ok, reason.map(Into::into))
}

// ---- 協定增修：短編號 ----

#[tokio::test(start_paused = true)]
async fn short_numbers_are_unique_recycled_and_kept_across_resume() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let b = connect(&room).await;
    let c = connect(&room).await;
    assert_eq!([a.n, b.n, c.n], [0, 1, 2]);
    // 其他人收到的 join 帶著同一個 n
    sleep(TICK).await;
    let joins: Vec<_> = a
        .drain()
        .into_iter()
        .filter_map(|m| match m {
            ServerMessage::Join { player } => Some((player.id, player.n)),
            _ => None,
        })
        .collect();
    assert_eq!(joins, [(b.who.id.clone(), 1), (c.who.id.clone(), 2)]);
    // 斷線保留期間仍佔著編號，新加入的人不會拿到 1
    b.disconnect().await;
    sleep(TICK).await;
    let d = connect(&room).await;
    assert_eq!(d.n, 3);
    // 保留期滿 b 離開，編號 1 回收
    sleep(Duration::from_secs(31)).await;
    let e = connect(&room).await;
    assert_eq!(e.n, 1);
    // 恢復沿用原編號
    c.disconnect().await;
    sleep(TICK).await;
    let c2 = resume(&room, &c.token).await.unwrap();
    assert_eq!((c2.who.id.as_str(), c2.n), (c.who.id.as_str(), 2));
}

// ---- T5：tick、批次、只送變動 ----

#[tokio::test(start_paused = true)]
async fn only_the_mover_is_sent_once_per_tick_rounded_and_stop_is_sent_once() {
    let room = spawn_room(RoomConfig::new(50));
    let mut clients = Vec::new();
    for _ in 0..50 {
        clients.push(connect(&room).await);
    }
    sleep(TICK).await;
    clients.iter_mut().for_each(|c| _ = c.drain());
    let (x, z) = (clients[7].x + 0.123_456, 11.0 - 0.014_9);
    clients[7].position(x, z, 7.0, true).await;
    sleep(TICK * 2).await;
    let expected = (
        7,
        round2(x),
        round2(z),
        round2(7.0 - 2.0 * PI),
        Moving::Moving,
    );
    for (i, c) in clients.iter_mut().enumerate() {
        let got = c.drain();
        if i == 7 {
            assert!(got.is_empty(), "the mover does not receive itself");
        } else {
            assert_eq!(kinds(&got), ["moves"], "client {i}");
            assert_eq!(move_tuples(&got), [expected], "client {i}");
        }
    }
    // 靜止不再重送
    sleep(TICK * 5).await;
    assert!(clients.iter_mut().all(|c| c.drain().is_empty()));
    // 停下時送一次 moving: 0，之後不再重送（重複的 stop 沒有變化，也不送）
    clients[7].position(x, z, 7.0, false).await;
    clients[7].position(x, z, 7.0, false).await;
    sleep(TICK * 2).await;
    for (i, c) in clients.iter_mut().enumerate().filter(|(i, _)| *i != 7) {
        let got = move_tuples(&c.drain());
        assert_eq!(got.len(), 1, "client {i}");
        assert_eq!(got[0].4, Moving::Stopped);
    }
    sleep(TICK * 20).await;
    assert!(clients.iter_mut().all(|c| c.drain().is_empty()));
}

#[tokio::test(start_paused = true)]
async fn tick_rate_follows_config() {
    for period in [TICK, TICK / 2] {
        let room = spawn_room(RoomConfig {
            tick: period,
            ..RoomConfig::new(50)
        });
        let mover = connect(&room).await;
        let mut watcher = connect(&room).await;
        watcher.drain();
        let mut batches = 0;
        // 每 10 ms 一則位置，每個 tick 都有變動；10 秒內收到的 moves 則數 = tick 數
        for i in 0..1000 {
            let wiggle = f64::from(i % 2) * 0.02;
            mover.position(mover.x + wiggle, mover.z, 0.0, true).await;
            sleep(Duration::from_millis(10)).await;
            for m in watcher.drain() {
                assert_eq!(kind(&m), "moves");
                batches += 1;
            }
        }
        let expected = 10_000 / period.as_millis() as i64;
        assert!(
            (expected - 1..=expected + 1).contains(&batches),
            "{period:?}: {batches}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn moves_and_actions_stay_in_zone_but_zone_join_leave_reach_everyone() {
    let room = spawn_room(RoomConfig::new(50));
    let mut yard = connect(&room).await;
    let mut yard_mover = connect(&room).await;
    let mut hall_a = connect(&room).await;
    let mut hall_b = connect(&room).await;
    hall_a.enter_hall().await;
    hall_b.enter_hall().await;
    // 換場景的 zone 廣播，所有場景的人都收到（各兩則）
    assert_eq!(count(&yard.drain(), "zone"), 2);
    yard_mover.drain();
    hall_a.drain();
    // 殿內玩家移動、做動作：庭院玩家完全收不到，殿內另一人收到
    hall_a.position(0.3, 7.4, 0.0, true).await;
    hall_a.action("r1", "bow", true).await;
    sleep(TICK * 2).await;
    assert!(yard.drain().is_empty());
    assert!(yard_mover.drain().is_empty());
    let mut got = kinds(&hall_b.drain());
    got.sort(); // action 即時送出，moves 在 tick 送出，先後取決於 tick 落點
    assert_eq!(got, ["action", "moves"]);
    assert_eq!(kinds(&hall_a.drain()), ["ack"]);
    // 庭院玩家移動：殿內收不到
    let (x, z) = (yard_mover.x + 0.1, yard_mover.z);
    yard_mover.position(x, z, 0.0, true).await;
    sleep(TICK * 2).await;
    assert!(hall_a.drain().is_empty());
    assert!(hall_b.drain().is_empty());
    assert_eq!(kinds(&yard.drain()), ["moves"]);
    // join / leave 送給所有場景的人
    let late = connect(&room).await;
    sleep(TICK).await;
    for c in [&mut yard, &mut hall_a, &mut hall_b] {
        assert_eq!(count(&c.drain(), "join"), 1);
    }
    late.disconnect().await;
    sleep(Duration::from_secs(31)).await;
    for c in [&mut yard, &mut hall_a, &mut hall_b] {
        assert_eq!(count(&c.drain(), "leave"), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn zone_change_broadcasts_zone_then_syncs_the_switcher() {
    let room = spawn_room(RoomConfig::new(50));
    let mut yard = connect(&room).await;
    let mut hall = connect(&room).await;
    let mut mover = connect(&room).await;
    hall.enter_hall().await;
    sleep(TICK).await;
    yard.drain();
    mover.drain();
    // 離殿門太遠（伺服器依速度上限拒絕該位置）時，位置仍在庭院中央
    mover.position(0.0, -5.6, PI, false).await;
    mover.walk_to_door().await;
    // 走到門口的最後一個位置是庭院內的正常更新，庭院的人會在某個 tick 收到；先等它送達再清空，
    // 之後 mover 沒有未廣播的變動，切換場景前後 yard 不該再收到 moves。
    yard.recv_move_of(mover.n, 0.0, -5.6).await;
    yard.drain();
    mover.drain();
    mover.zone("hall").await;
    sleep(TICK * 2).await;
    // 切換者：先 zone（含伺服器落點），再 sync（殿內的另一位玩家，不含自己）
    let got = mover.drain();
    assert_eq!(kinds(&got), ["zone", "sync"]);
    let ServerMessage::Zone {
        id,
        zone,
        x,
        z,
        heading,
    } = &got[0]
    else {
        panic!()
    };
    assert_eq!(
        (id.as_str(), zone.as_str(), *x, *z, *heading),
        (mover.who.id.as_str(), "hall", 0.0, 7.4, PI)
    );
    let ServerMessage::Sync { m } = &got[1] else {
        panic!()
    };
    assert_eq!(m.len(), 1);
    assert_eq!((m[0].0, m[0].4), (hall.n, Moving::Stopped));
    // 其他人只收到 zone
    assert_eq!(kinds(&hall.drain()), ["zone"]);
    assert_eq!(kinds(&yard.drain()), ["zone"]);
}

#[tokio::test(start_paused = true)]
async fn only_portal_positions_may_change_zone() {
    let room = spawn_room(RoomConfig::new(50));
    let mut p = connect(&room).await;
    // 庭院中央、未知場景、同一場景：invalid_zone，維持原場景
    for zone in ["hall", "nowhere", "courtyard"] {
        p.zone(zone).await;
        sleep(TICK).await;
        let got = p.drain();
        assert!(
            matches!(&got[..], [ServerMessage::Error { code, .. }] if code == "invalid_zone"),
            "{zone}: {got:?}"
        );
    }
    // 出入口外 0.6 公尺（容許 0.5）仍是 invalid_zone
    p.walk_to_door().await;
    p.position(0.0, -4.4, PI, false).await;
    p.zone("hall").await;
    sleep(TICK).await;
    assert_eq!(count(&p.drain(), "error"), 1);
    // 容許誤差內成功，且位置是伺服器的落點
    p.position(0.0, -4.6, PI, false).await;
    p.zone("hall").await;
    sleep(TICK).await;
    let got = p.drain();
    assert!(
        matches!(got[0], ServerMessage::Zone { x, z, .. } if (x, z) == (0.0, 7.4)),
        "{got:?}"
    );
    // 殿內中央不能出殿；站在門口可以，落點為庭院的殿前
    p.zone("courtyard").await;
    sleep(TICK).await;
    assert_eq!(count(&p.drain(), "error"), 1);
    p.position(0.0, 8.5, 0.0, false).await;
    p.zone("courtyard").await;
    sleep(TICK).await;
    let got = p.drain();
    assert!(
        matches!(got[0], ServerMessage::Zone { x, z, heading, .. } if (x, z, heading) == (0.0, -3.6, 0.0)),
        "{got:?}"
    );
}

// ---- T4：位置驗證 ----

#[tokio::test(start_paused = true)]
async fn positions_are_clamped_rejected_and_use_each_zones_bounds() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    let mut watcher = connect(&room).await;
    sleep(TICK).await;
    watcher.drain();
    // 越界但距離合理：夾回邊界（庭院 z 最大 18）
    sleep(Duration::from_secs(3)).await;
    a.position(a.x, 18.4, 0.0, false).await;
    sleep(TICK * 2).await;
    let got = move_tuples(&watcher.drain());
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].1, got[0].2), (round2(a.x), 18.0));
    // 一次跳 10 公尺：被拒，改為重送一次伺服器上的位置
    a.position(a.x, 8.0, 0.0, false).await;
    sleep(TICK * 2).await;
    let got = move_tuples(&watcher.drain());
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].1, got[0].2), (round2(a.x), 18.0));
    // 離邊界很遠的越界座標同樣是被拒（不會被夾進場內）
    a.position(100.0, 18.0, 0.0, false).await;
    sleep(TICK * 2).await;
    let got = move_tuples(&watcher.drain());
    assert!(got.iter().all(|t| t.1 == round2(a.x)));
    // heading 正規化到 −π～π
    sleep(Duration::from_secs(1)).await;
    watcher.drain();
    a.position(a.x, 18.0, 7.0, true).await;
    sleep(TICK * 2).await;
    assert_eq!(move_tuples(&watcher.drain())[0].3, round2(7.0 - 2.0 * PI));
    // 殿內改用殿內的邊界：x 最大 7.4、z 最大 8.6
    let mut b = connect(&room).await;
    let mut hall_watcher = connect(&room).await;
    b.enter_hall().await;
    hall_watcher.enter_hall().await;
    sleep(Duration::from_secs(3)).await;
    b.position(9.0, 8.9, 0.0, false).await;
    sleep(TICK * 2).await;
    let got = move_tuples(&hall_watcher.drain());
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].1, got[0].2), (7.4, 8.6));
}

/// 本人收到的位置校正：只含自己短編號的 sync。
fn corrections(c: &mut Client) -> Vec<MoveTuple> {
    let n = c.n;
    c.drain()
        .into_iter()
        .filter_map(|m| match m {
            ServerMessage::Sync { m } if m.len() == 1 && m[0].0 == n => Some(m[0]),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn stall_burst_is_accepted_but_teleports_and_wall_passes_are_corrected() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut watcher = connect(&room).await;
    sleep(TICK).await;
    watcher.drain();
    a.drain();
    // 網路卡 2 秒後訊息一次湧到：同一瞬間收到沿路的三個位置，總長 6 公尺（3 m/s）——全部採用
    sleep(Duration::from_secs(2)).await;
    for step in 1..=3 {
        a.position(a.x, a.z - 2.0 * f64::from(step), 0.0, step < 3)
            .await;
    }
    sleep(TICK * 2).await;
    assert_eq!(
        move_tuples(&watcher.drain()).last().map(|t| t.2),
        Some(round2(a.z - 6.0))
    );
    assert!(corrections(&mut a).is_empty());
    // 額度用完後立刻再跳 5 公尺：被拒，本人收到伺服器上的位置；不會因為等待而自動採用
    a.position(a.x, a.z - 1.0, 0.0, false).await;
    sleep(Duration::from_secs(5)).await;
    assert!(
        move_tuples(&watcher.drain())
            .iter()
            .all(|t| t.2 == round2(a.z - 6.0))
    );
    let got = corrections(&mut a);
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].1, got[0].2), (round2(a.x), round2(a.z - 6.0)));
    // 額度足夠但直線穿過香爐（中心 0,-1.5）：被拒並校正
    a.position(0.0, -3.5, 0.0, false).await;
    sleep(TICK * 2).await;
    assert_eq!(corrections(&mut a).len(), 1);
    assert!(
        move_tuples(&watcher.drain())
            .iter()
            .all(|t| t.2 == round2(a.z - 6.0))
    );
    // 連續被拒時，校正最多每 300 ms 一則
    sleep(Duration::from_millis(300)).await;
    for _ in 0..5 {
        a.position(0.0, -3.5, 0.0, false).await;
    }
    sleep(TICK * 2).await;
    assert_eq!(corrections(&mut a).len(), 1);
}

// ---- T4：動作 ----

#[tokio::test(start_paused = true)]
async fn actions_are_acked_idempotently_and_only_known_ones_broadcast() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(TICK).await;
    a.drain();
    b.drain();
    // 同一 reqId 兩次：兩次都收到同一個 ack，只廣播一次
    a.action("r1", "bow", true).await;
    a.action("r1", "bow", true).await;
    sleep(TICK).await;
    assert_eq!(
        acks(&a.drain()),
        [ack("r1", true, None), ack("r1", true, None)]
    );
    let seen = b.drain();
    assert_eq!(kinds(&seen), ["action"]);
    assert!(
        matches!(&seen[0], ServerMessage::Action { player_id, id, .. } if *player_id == a.who.id && id == "bow")
    );
    // 未知動作與不支援的 data
    a.action("r2", "dance", true).await;
    a.action("r3", "bell", false).await;
    sleep(TICK).await;
    assert_eq!(
        acks(&a.drain()),
        [
            ack("r2", false, Some("unknown_action")),
            ack("r3", false, Some("unsupported_data"))
        ]
    );
    assert!(b.drain().is_empty());
    // 失敗的結果同樣被快取：重送不會變成成功
    a.action("r2", "bow", true).await;
    sleep(TICK).await;
    assert_eq!(acks(&a.drain()), [ack("r2", false, Some("unknown_action"))]);
    // 只快取最近 64 個：r1 被擠出後重送會重新執行並再廣播一次，最新的仍在快取內
    for i in 0..64 {
        a.action(&format!("f{i}"), "incense", true).await;
    }
    sleep(TICK).await;
    a.drain();
    b.drain();
    a.action("r1", "bow", true).await;
    sleep(TICK).await;
    assert_eq!(count(&b.drain(), "action"), 1);
    a.action("f63", "incense", true).await;
    sleep(TICK).await;
    assert!(b.drain().is_empty());
}

#[tokio::test(start_paused = true)]
async fn snapshots_only_contain_known_zones_and_allowlisted_actions() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    a.action("r1", &"x".repeat(32), true).await;
    sleep(TICK).await;
    let (out, mut rx) = mpsc::channel(64);
    join(&room, "觀察", out).await.unwrap();
    let ServerMessage::Welcome { players, .. } = rx.try_recv().unwrap() else {
        panic!()
    };
    assert!(players.iter().all(|p| p.action.is_none()));
    a.action("r2", "bell", true).await;
    sleep(TICK).await;
    let (out, mut rx) = mpsc::channel(64);
    join(&room, "觀察", out).await.unwrap();
    let ServerMessage::Welcome { players, .. } = rx.try_recv().unwrap() else {
        panic!()
    };
    for p in &players {
        assert!(world::zone(p.zone.as_deref().unwrap()).is_some());
        assert!(
            p.action
                .as_ref()
                .is_none_or(|a| world::ACTIONS.contains(&a.id.as_str()))
        );
    }
    assert!(players.iter().any(|p| p.action.is_some()));
}

#[tokio::test(start_paused = true)]
async fn chant_and_early_end_are_relayed_in_order_and_snapshot_keeps_the_end() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    a.enter_hall().await;
    b.enter_hall().await;
    sleep(TICK).await;
    a.drain();
    b.drain();
    // 誦經後提前起身：同場景的人依序收到 chant、chant_end（與一般動作相同的允許清單與確認）
    a.action("r1", "chant", true).await;
    a.action("r2", "chant_end", true).await;
    sleep(TICK).await;
    assert_eq!(
        acks(&a.drain()),
        [ack("r1", true, None), ack("r2", true, None)]
    );
    let ids: Vec<String> = b
        .drain()
        .into_iter()
        .filter_map(|m| match m {
            ServerMessage::Action { id, .. } => Some(id),
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["chant", "chant_end"]);
    // 之後才進房的人在快照裡看到的是起身，不會以為他還在誦經
    let (out, mut rx) = mpsc::channel(64);
    join(&room, "觀察", out).await.unwrap();
    let ServerMessage::Welcome { players, .. } = rx.try_recv().unwrap() else {
        panic!()
    };
    let me = players.iter().find(|p| p.id == a.who.id).unwrap();
    assert_eq!(me.action.as_ref().unwrap().id, "chant_end");
}

// ---- 伺服器端停止看門狗與斷線保留 ----

#[tokio::test(start_paused = true)]
async fn watchdog_stops_a_stale_mover_exactly_once() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(TICK).await;
    b.drain();
    a.position(a.x + 0.1, a.z, 0.0, true).await;
    sleep(Duration::from_millis(900)).await;
    // 1 秒內仍是移動中
    let got = move_tuples(&b.drain());
    assert_eq!(
        got.iter().map(|t| t.4).collect::<Vec<_>>(),
        [Moving::Moving]
    );
    sleep(Duration::from_millis(400)).await;
    let got = move_tuples(&b.drain());
    assert_eq!(
        got.iter().map(|t| t.4).collect::<Vec<_>>(),
        [Moving::Stopped]
    );
    sleep(Duration::from_secs(5)).await;
    assert!(b.drain().is_empty());
}

#[tokio::test(start_paused = true)]
async fn disconnect_stops_player_once_and_hides_leave_until_grace_ends() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(TICK).await;
    a.position(a.x + 0.1, a.z, 0.0, true).await;
    sleep(TICK * 2).await;
    b.drain();
    a.disconnect().await;
    sleep(TICK * 2).await;
    let got = b.drain();
    assert_eq!(kinds(&got), ["moves"]);
    assert_eq!(move_tuples(&got)[0].4, Moving::Stopped);
    // 保留期間（29.5 秒）沒有 leave、位置不再更新；第 30 秒才廣播 leave
    a.position(a.x + 0.2, a.z, 0.0, true).await;
    sleep(Duration::from_millis(29_500)).await;
    assert!(b.drain().is_empty());
    sleep(Duration::from_millis(600)).await;
    let got = b.drain();
    assert!(
        matches!(&got[..], [ServerMessage::Leave { id }] if *id == a.who.id),
        "{got:?}"
    );
}

// ---- T5：背壓與慢速接收者 ----

#[tokio::test(start_paused = true)]
async fn slow_receiver_never_delays_others_and_is_closed_on_undroppable_overflow() {
    let room = spawn_room(RoomConfig::new(50));
    let mover = connect(&room).await;
    let mut fast = connect(&room).await;
    let mut slow = connect(&room).await; // 完全不讀取
    sleep(TICK).await;
    fast.drain();
    slow.drain();
    let mut batches = 0;
    // 錯開半個 tick，位置才不會和 tick 落在同一個瞬間而被合併
    sleep(TICK / 2).await;
    // 10 秒、每個 tick 都有 moves：慢速接收者的佇列長度永遠不超過上限 64，快的人每 tick 照收
    for i in 0..100 {
        let wiggle = f64::from(i % 2) * 0.02;
        mover.position(mover.x + wiggle, mover.z, 0.0, true).await;
        sleep(TICK).await;
        assert!(slow.rx.len() <= 64);
        batches += fast.drain().len();
    }
    assert!((99..=101).contains(&batches), "fast receiver got {batches}");
    assert_eq!(slow.rx.len(), 64, "queue is full, extra moves were dropped");
    // 不可丟棄的訊息（join）放不進去 → 慢速接收者，連線被中斷（送完佇列後 channel 關閉）
    let late = connect(&room).await;
    sleep(TICK).await;
    let mut backlog = 0;
    while slow.rx.try_recv().is_ok() {
        backlog += 1;
    }
    assert_eq!(backlog, 64);
    assert!(matches!(
        slow.rx.try_recv(),
        Err(mpsc::error::TryRecvError::Disconnected)
    ));
    // 房間與其他人不受影響：照常 tick，也沒有為此廣播 leave
    mover.position(mover.x + 0.3, mover.z, 0.0, true).await;
    sleep(TICK * 2).await;
    let got = fast.drain();
    assert_eq!(count(&got, "leave"), 0);
    assert_eq!(count(&got, "moves"), 1);
    drop(late);
}

#[tokio::test(start_paused = true)]
async fn dropped_moves_are_replaced_by_one_sync_when_the_queue_has_room() {
    let room = spawn_room(RoomConfig::new(50));
    let mover = connect(&room).await;
    let still = connect(&room).await;
    let mut slow = connect_with(&room, 4).await;
    sleep(TICK).await;
    slow.drain();
    // 佇列只有 4 格：8 個 tick 的 moves 前 4 則入列，其餘被丟棄
    let mut last = (0.0, 0.0);
    sleep(TICK / 2).await;
    for i in 0..8 {
        last = (mover.x + 0.01 * f64::from(i + 1), mover.z);
        mover.position(last.0, last.1, 0.0, true).await;
        sleep(TICK).await;
    }
    mover.position(last.0, last.1, 0.0, false).await;
    // 仍然滿的時候不會多出訊息（sync 也被丟棄，下個 tick 再試）
    sleep(TICK * 3).await;
    assert_eq!(slow.rx.len(), 4);
    assert_eq!(count(&slow.drain(), "moves"), 4);
    // 佇列有空間後的第一個 tick：取代該 tick 的 moves，送一則 sync，內容是場景內所有其他玩家
    sleep(TICK * 2).await;
    let got = slow.drain();
    assert_eq!(kinds(&got), ["sync"]);
    let ServerMessage::Sync { m } = &got[0] else {
        panic!()
    };
    assert_eq!(m.len(), 2);
    let moved = m.iter().find(|t| t.0 == mover.n).unwrap();
    assert_eq!((moved.1, moved.2), (round2(last.0), round2(last.1)));
    assert_eq!(moved.4, Moving::Stopped);
    assert!(m.iter().any(|t| t.0 == still.n));
    // 成功之後恢復增量的 moves，不再重送 sync
    sleep(TICK * 3).await;
    assert!(slow.drain().is_empty());
    mover.position(last.0 + 0.05, last.1, 0.0, true).await;
    sleep(TICK * 2).await;
    assert_eq!(kinds(&slow.drain()), ["moves"]);
}

// ---- T6：斷線恢復 ----

#[tokio::test(start_paused = true)]
async fn resume_restores_identity_zone_and_position_without_leave_or_join() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    a.enter_hall().await;
    a.position(0.4, 7.0, 1.0, false).await;
    sleep(TICK * 2).await;
    b.drain();
    a.disconnect().await;
    sleep(Duration::from_secs(5)).await;
    let a2 = resume(&room, &a.token).await.unwrap();
    assert_eq!(a2.who.id, a.who.id);
    assert_eq!(
        (a2.n, a2.zone.as_str(), a2.x, a2.z),
        (a.n, "hall", 0.4, 7.0)
    );
    assert_ne!(a2.token, a.token, "the token is rotated");
    sleep(Duration::from_secs(40)).await;
    assert!(
        b.drain().is_empty(),
        "no leave, no join, no position change"
    );
    // 恢復後舊 token 不能再用；新 token 可用一次
    assert!(resume(&room, &a.token).await.is_none());
    let a3 = resume(&room, &a2.token).await.unwrap();
    assert_eq!(a3.who.id, a.who.id);
    assert!(resume(&room, &a2.token).await.is_none());
}

#[tokio::test(start_paused = true)]
async fn resume_fails_after_grace_and_the_player_is_gone() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(TICK).await;
    b.drain();
    a.disconnect().await;
    sleep(Duration::from_secs(31)).await;
    assert_eq!(
        kinds(&b.drain()),
        ["leave"],
        "leave is broadcast when the grace period ends"
    );
    assert!(resume(&room, &a.token).await.is_none());
    // 不存在的 token、格式錯誤的 token 一律失敗
    for token in ["", "garbage", "1.00000000000000000000000000000000"] {
        assert!(resume(&room, token).await.is_none());
    }
    let (out, _rx) = mpsc::channel(64);
    let fresh = join(&room, "新", out).await.unwrap();
    assert_ne!(fresh.id, a.who.id);
}

#[tokio::test(start_paused = true)]
async fn resume_replaces_a_still_connected_old_connection() {
    let room = spawn_room(RoomConfig::new(50));
    let mut old = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(TICK).await;
    b.drain();
    let new = resume(&room, &old.token).await.unwrap();
    assert_eq!(new.who.id, old.who.id);
    // 舊連線：送完佇列後 channel 關閉（session 以 1013 關閉）
    old.drain();
    assert!(matches!(
        old.rx.try_recv(),
        Err(mpsc::error::TryRecvError::Disconnected)
    ));
    // 舊連線的後續指令（位置、Disconnect）一律忽略，玩家不會因此進入保留期
    old.position(old.x + 0.1, old.z, 0.0, true).await;
    old.disconnect().await;
    sleep(Duration::from_secs(40)).await;
    assert!(b.drain().is_empty());
    drop(new);
}

#[tokio::test(start_paused = true)]
async fn resume_tokens_are_random_and_unrelated_to_player_ids() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    let b = connect(&room).await;
    for c in [&a, &b] {
        let (room_no, secret) = c.token.split_once('.').unwrap();
        assert_eq!(room_no, "1");
        assert_eq!(secret.len(), 32, "128 bits as hex");
        assert!(secret.chars().all(|ch| ch.is_ascii_hexdigit()));
        let id_secret = c.who.id.strip_prefix("p-").unwrap();
        assert_ne!(secret, id_secret);
        assert!(!c.token.contains(id_secret));
        assert!(c.token.len() <= crate::protocol::MAX_RESUME_TOKEN_BYTES);
    }
    assert_ne!(a.token, b.token);
}

// ---- T3 既有行為 ----

#[tokio::test(start_paused = true)]
async fn empty_room_stops_after_sixty_seconds() {
    let (tx, rx) = mpsc::channel(8);
    let task = tokio::spawn(run_room(1, RoomConfig::new(50), rx, Default::default()));
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(59)).await;
    tokio::task::yield_now().await;
    assert!(!tx.is_closed());
    tokio::time::advance(Duration::from_secs(1)).await;
    task.await.unwrap();
    assert!(tx.is_closed());
}

#[tokio::test(start_paused = true)]
async fn capacity_is_held_during_grace_and_released_after() {
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(run_room(1, RoomConfig::new(1), rx, Default::default()));
    let one = connect(&tx).await;
    let (out, _inbox) = mpsc::channel(64);
    assert!(join(&tx, "full", out).await.is_none());
    one.disconnect().await;
    sleep(Duration::from_secs(29)).await;
    let (out, _inbox) = mpsc::channel(64);
    assert!(join(&tx, "still full", out).await.is_none());
    sleep(Duration::from_secs(2)).await;
    let (out, _inbox) = mpsc::channel(64);
    assert!(join(&tx, "free", out).await.is_some());
}

#[tokio::test(start_paused = true)]
async fn idle_deadline_restarts_when_the_last_player_leaves() {
    let (tx, rx) = mpsc::channel(8);
    let task = tokio::spawn(run_room(1, RoomConfig::new(1), rx, Default::default()));
    let one = connect(&tx).await;
    sleep(Duration::from_secs(61)).await;
    assert!(!tx.is_closed(), "a connected player keeps the room open");
    one.disconnect().await;
    // 保留期（30 秒）內房間不算空；期滿後才開始 60 秒的閒置計時
    sleep(Duration::from_secs(31 + 57)).await;
    assert!(!tx.is_closed());
    sleep(Duration::from_secs(5)).await;
    task.await.unwrap();
    assert!(tx.is_closed());
}
