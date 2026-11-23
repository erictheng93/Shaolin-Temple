use super::*;
use crate::protocol::{CarSnapshot, MAX_MESSAGE_BYTES};
use std::f64::consts::PI;
use tokio::time::sleep;

#[test]
fn full_room_welcome_fits_message_limit() {
    // 最壞情況：16 個 4-byte 字元的名稱、公分精度的 f64、最大的短編號。zone 與動作 id 限於
    // 已知場景與允許清單（取其中最長者）；加上滿額 10 台車的快照。
    let n = -19.99;
    let heading = -3.12;
    let ts = 1_700_000_000_000.0;
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
        n: crate::protocol::MAX_SHORT_ID,
        name: "😀".repeat(16),
        x: n,
        z: n,
        heading,
        action: Some(PlayerAction {
            id: longest(&world::ACTIONS),
            started_at: ts,
        }),
        outfit: crate::protocol::OUTFIT_COUNT - 1,
    };
    let car = CarSnapshot {
        c: 15,
        kind: 3,
        driver: Some(format!("p-{:032x}", u128::MAX)),
        x: n,
        z: n,
        heading,
        fade_at: Some(ts),
    };
    let welcome = ServerMessage::Welcome {
        self_id: player.id.clone(),
        room: format!("room-{}", u64::MAX),
        resume_token: format!("{:x}.{:032x}", u64::MAX, u128::MAX),
        server_time: ts,
        auth: AuthKind::Google,
        players: vec![player; MAX_ROOM_CAPACITY],
        cars: vec![car; 10],
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
    n: u8,
    token: String,
    zone: String,
    outfit: u8,
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
            outfit: me.outfit,
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
    async fn recv_move_of(&mut self, n: u8, x: f64, z: f64) {
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
    async fn outfit(&self, outfit: u8) {
        let command = RoomCommand::Outfit {
            who: self.who.clone(),
            outfit,
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
/// 以預設衣裝（0）加入。
async fn join(
    room: &RoomTx,
    name: &str,
    auth: AuthKind,
    out: mpsc::Sender<ServerMessage>,
) -> Option<Who> {
    super::join(room, name, auth, 0, out).await
}
async fn join_with(
    room: &RoomTx,
    name: &str,
    outfit: u8,
    out: mpsc::Sender<ServerMessage>,
) -> Option<Who> {
    super::join(room, name, AuthKind::Guest, outfit, out).await
}
async fn connect_with(room: &RoomTx, capacity: usize) -> Client {
    let (out, rx) = mpsc::channel(capacity);
    let who = join(room, "測試", AuthKind::Guest, out).await.unwrap();
    Client::from_welcome(room, who, rx)
}
async fn connect(room: &RoomTx) -> Client {
    connect_with(room, 64).await
}
async fn resume(room: &RoomTx, token: &str) -> Option<Client> {
    resume_full(room, token, "測試", AuthKind::Guest, None).await
}
async fn resume_with(room: &RoomTx, token: &str, outfit: Option<u8>) -> Option<Client> {
    resume_full(room, token, "測試", AuthKind::Guest, outfit).await
}
async fn resume_as(room: &RoomTx, token: &str, name: &str, auth: AuthKind) -> Option<Client> {
    resume_full(room, token, name, auth, None).await
}
async fn resume_full(
    room: &RoomTx,
    token: &str,
    name: &str,
    auth: AuthKind,
    outfit: Option<u8>,
) -> Option<Client> {
    let (outbound, rx) = mpsc::channel(64);
    let (reply, received) = oneshot::channel();
    room.send(RoomCommand::Resume {
        token: token.into(),
        name: name.into(),
        auth,
        outfit,
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
        ServerMessage::Chat { .. } => "chat",
        ServerMessage::Outfit { .. } => "outfit",
        ServerMessage::Name { .. } => "name",
        ServerMessage::Car { .. } => "car",
        ServerMessage::CarGone { .. } => "carGone",
        ServerMessage::Knock { .. } => "knock",
        ServerMessage::Cars { .. } => "cars",
        ServerMessage::Fair { .. } => "fair",
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
        clients.push(connect_with(&room, 512).await);
    }
    let ns: Vec<u8> = clients.iter().map(|c| c.n).collect();
    let mut positions: Vec<f64> = clients.iter().map(|c| c.x).collect();
    loop {
        let mut any_moves = false;
        for _ in 0..50 {
            sleep(TICK).await;
            for c in &mut clients {
                for msg in c.drain() {
                    any_moves = true;
                    if let ServerMessage::Moves { m } = msg {
                        for entry in m {
                            if let Some(idx) = ns.iter().position(|&n| n == entry.0) {
                                positions[idx] = entry.1;
                            }
                        }
                    }
                }
            }
        }
        if !any_moves {
            break;
        }
    }
    sleep(Duration::from_secs(1)).await;
    clients.iter_mut().for_each(|c| _ = c.drain());
    let (mover_idx, &mover_x) = positions
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .unwrap();
    let mover_n = clients[mover_idx].n;
    let (x, z) = (mover_x + 0.123_456, 11.0 - 0.014_9);
    clients[mover_idx].position(x, z, 7.0, true).await;
    sleep(TICK * 2).await;
    let expected = (
        mover_n,
        round2(x),
        round2(z),
        round2(7.0 - 2.0 * PI),
        Moving::Moving,
    );
    for (i, c) in clients.iter_mut().enumerate() {
        let got = c.drain();
        if i == mover_idx {
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
    clients[mover_idx].position(x, z, 7.0, false).await;
    clients[mover_idx].position(x, z, 7.0, false).await;
    sleep(TICK * 2).await;
    for (i, c) in clients
        .iter_mut()
        .enumerate()
        .filter(|(i, _)| *i != mover_idx)
    {
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
        watcher.position(watcher.x, 10.3, 0.0, false).await;
        sleep(TICK * 2).await;
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
    sleep(Duration::from_secs(2)).await;
    yard.position(0.0, 8.0, 0.0, false).await;
    hall_b.position(1.5, 6.0, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    // 換場景的 zone 廣播，所有場景的人都收到（各兩則）
    assert_eq!(count(&yard.drain(), "zone"), 2);
    yard_mover.drain();
    hall_a.drain();
    hall_b.drain();
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
async fn courtyard_bell_reaches_every_zone_but_other_actions_stay_in_zone() {
    let room = spawn_room(RoomConfig::new(50));
    let mut ringer = connect(&room).await;
    let mut yard = connect(&room).await;
    let mut hall = connect(&room).await;
    hall.enter_hall().await;
    ringer.drain();
    yard.drain();
    // 庭院敲鐘：殿內與庭院的其他人都收到 action 幀，本人只收到 ack
    ringer.action("r1", "bell", true).await;
    sleep(TICK).await;
    let bell = world::action_code("bell").unwrap();
    for c in [&mut hall, &mut yard] {
        let got = c.drain();
        assert_eq!(kinds(&got), ["action"]);
        assert!(matches!(
            got[0],
            ServerMessage::Action { n, code, .. } if n == ringer.n && code == bell
        ));
    }
    assert_eq!(kinds(&ringer.drain()), ["ack"]);
    // 庭院合十：殿內收不到，庭院的人照常收到
    ringer.action("r2", "bow", true).await;
    sleep(TICK).await;
    assert!(hall.drain().is_empty());
    assert_eq!(kinds(&yard.drain()), ["action"]);
    assert_eq!(kinds(&ringer.drain()), ["ack"]);
    // 殿內送出 bell（不合法的位置）：不全房廣播，庭院收不到
    hall.action("r1", "bell", true).await;
    sleep(TICK).await;
    assert!(ringer.drain().is_empty());
    assert!(yard.drain().is_empty());
    assert_eq!(kinds(&hall.drain()), ["ack"]);
}

#[tokio::test(start_paused = true)]
async fn zone_change_broadcasts_zone_then_syncs_the_switcher() {
    let room = spawn_room(RoomConfig::new(50));
    let mut yard = connect(&room).await;
    let mut hall = connect(&room).await;
    let mut mover = connect(&room).await;
    hall.enter_hall().await;
    sleep(Duration::from_secs(1)).await;
    hall.position(1.5, 7.4, PI, false).await;
    sleep(TICK).await;
    yard.drain();
    hall.drain();
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
    // 超出殿門邊界 0.60 公尺，超過伺服器容許範圍
    p.walk_to_door().await;
    p.position(0.0, -4.05, PI, false).await;
    p.zone("hall").await;
    sleep(TICK).await;
    assert_eq!(count(&p.drain(), "error"), 1);
    // 容許誤差內成功，且位置是伺服器的落點
    p.position(0.0, -4.25, PI, false).await;
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
    hall_watcher.drain();
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
        matches!(&seen[0], ServerMessage::Action { n, code, .. } if *n == a.n && world::ACTIONS[usize::from(*code)] == "bow")
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
    join(&room, "觀察", AuthKind::Guest, out).await.unwrap();
    let ServerMessage::Welcome { players, .. } = rx.try_recv().unwrap() else {
        panic!()
    };
    assert!(players.iter().all(|p| p.action.is_none()));
    a.action("r2", "bell", true).await;
    sleep(TICK).await;
    let (out, mut rx) = mpsc::channel(64);
    join(&room, "觀察", AuthKind::Guest, out).await.unwrap();
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
    let ids: Vec<&str> = b
        .drain()
        .into_iter()
        .filter_map(|m| match m {
            ServerMessage::Action { code, .. } => Some(world::ACTIONS[usize::from(code)]),
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["chant", "chant_end"]);
    // 之後才進房的人在快照裡看到的是起身，不會以為他還在誦經
    let (out, mut rx) = mpsc::channel(64);
    join(&room, "觀察", AuthKind::Guest, out).await.unwrap();
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
    // 出生點只在 x 方向隨機、z 都相同，重抽 10 次仍可能和別人重疊；之後進房的 late 若疊到
    // mover 或 fast，每 tick 的分離會多送 moves。先把兩人移離出生的那一排（相距都超過 MIN_DIST），
    // 誰都不會被推動，收到幾則 moves 才是確定的。
    let mover_z = 11.7;
    mover.position(mover.x, mover_z, 0.0, false).await;
    fast.position(fast.x, 10.3, 0.0, false).await;
    sleep(TICK * 2).await;
    fast.drain();
    slow.drain();
    let mut batches = 0;
    // 錯開半個 tick，位置才不會和 tick 落在同一個瞬間而被合併
    sleep(TICK / 2).await;
    // 10 秒、每個 tick 都有 moves：慢速接收者的佇列長度永遠不超過上限 64，快的人每 tick 照收
    for i in 0..100 {
        let wiggle = f64::from(i % 2) * 0.02;
        mover.position(mover.x + wiggle, mover_z, 0.0, true).await;
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
    mover.position(mover.x + 0.3, mover_z, 0.0, true).await;
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
    still.position(still.x, 11.7, 0.0, false).await;
    slow.position(slow.x, 10.3, 0.0, false).await;
    sleep(TICK * 2).await;
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

// ---- 衣裝 ----

fn outfit_of(messages: &[ServerMessage]) -> Vec<(String, u8)> {
    messages
        .iter()
        .filter_map(|m| match m {
            ServerMessage::Outfit { id, outfit } => Some((id.clone(), *outfit)),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn outfit_change_is_stored_and_broadcast_to_everyone_across_zones() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    b.enter_hall().await;
    sleep(TICK).await;
    a.drain();
    a.outfit(3).await;
    sleep(TICK).await;
    let want = vec![(a.who.id.clone(), 3)];
    assert_eq!(outfit_of(&a.drain()), want, "the sender gets the echo");
    assert_eq!(outfit_of(&b.drain()), want, "other zones too");
    // 與目前相同：不廣播
    a.outfit(3).await;
    sleep(TICK).await;
    assert!(outfit_of(&a.drain()).is_empty());
    assert!(outfit_of(&b.drain()).is_empty());
    // 之後加入的人在 welcome 與 join 都看得到
    let (out, mut rx) = mpsc::channel(64);
    let who = join_with(&room, "新", 5, out).await.unwrap();
    let first = rx.try_recv().unwrap();
    let ServerMessage::Welcome { players, .. } = &first else {
        panic!("welcome first")
    };
    assert_eq!(players.iter().find(|p| p.id == a.who.id).unwrap().outfit, 3);
    assert_eq!(players.iter().find(|p| p.id == who.id).unwrap().outfit, 5);
    sleep(TICK).await;
    let joins: Vec<_> = a
        .drain()
        .into_iter()
        .filter_map(|m| match m {
            ServerMessage::Join { player } => Some((player.id, player.outfit)),
            _ => None,
        })
        .collect();
    assert_eq!(joins, vec![(who.id, 5)]);
}

#[tokio::test(start_paused = true)]
async fn resume_keeps_the_outfit_and_a_different_hello_outfit_wins_and_is_announced() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    let mut b = connect(&room).await;
    a.outfit(4).await;
    sleep(TICK).await;
    b.drain();
    a.disconnect().await;
    sleep(Duration::from_secs(2)).await;
    // 沒帶衣裝：保留 4，其他人不會收到任何衣裝訊息
    let a2 = resume(&room, &a.token).await.unwrap();
    assert_eq!(a2.outfit, 4);
    sleep(TICK).await;
    assert!(outfit_of(&b.drain()).is_empty());
    // 帶相同衣裝：不廣播
    a2.disconnect().await;
    sleep(Duration::from_secs(1)).await;
    let a3 = resume_with(&room, &a2.token, Some(4)).await.unwrap();
    assert_eq!(a3.outfit, 4);
    sleep(TICK).await;
    assert!(outfit_of(&b.drain()).is_empty());
    // 帶不同的有效衣裝：以 hello 為準，welcome 已含新值，其他人收到廣播
    a3.disconnect().await;
    sleep(Duration::from_secs(1)).await;
    let a4 = resume_with(&room, &a3.token, Some(1)).await.unwrap();
    assert_eq!(a4.outfit, 1);
    sleep(TICK).await;
    assert_eq!(outfit_of(&b.drain()), vec![(a.who.id.clone(), 1)]);
}

#[tokio::test(start_paused = true)]
async fn resume_with_a_different_name_and_outfit_broadcasts_name_then_outfit() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(TICK).await;
    b.drain();
    a.disconnect().await;
    sleep(Duration::from_secs(1)).await;
    let a2 = resume_full(&room, &a.token, "新名字", AuthKind::Guest, Some(3))
        .await
        .unwrap();
    sleep(TICK).await;
    // v4 有改名訊息：不重送 join，name 與 outfit 各一則
    let got = b.drain();
    assert_eq!(names(&got), [(a.who.id.clone(), "新名字".to_string())]);
    assert_eq!(outfit_of(&got), vec![(a.who.id.clone(), 3)]);
    assert_eq!(got.len(), 2);
    // 名字相同：不重送
    a2.disconnect().await;
    sleep(Duration::from_secs(1)).await;
    resume_as(&room, &a2.token, "新名字", AuthKind::Guest)
        .await
        .unwrap();
    sleep(TICK).await;
    assert!(b.drain().is_empty());
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
    let fresh = join(&room, "新", AuthKind::Guest, out).await.unwrap();
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
    assert!(join(&tx, "full", AuthKind::Guest, out).await.is_none());
    one.disconnect().await;
    sleep(Duration::from_secs(29)).await;
    let (out, _inbox) = mpsc::channel(64);
    assert!(
        join(&tx, "still full", AuthKind::Guest, out)
            .await
            .is_none()
    );
    sleep(Duration::from_secs(2)).await;
    let (out, _inbox) = mpsc::channel(64);
    assert!(join(&tx, "free", AuthKind::Guest, out).await.is_some());
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

// ---- 協定版本 4：改名與 welcome.auth ----

fn names(messages: &[ServerMessage]) -> Vec<(String, String)> {
    messages
        .iter()
        .filter_map(|m| match m {
            ServerMessage::Name { id, name } => Some((id.clone(), name.clone())),
            _ => None,
        })
        .collect()
}
async fn rename(c: &Client, name: &str) {
    let command = RoomCommand::Rename {
        who: c.who.clone(),
        name: name.into(),
    };
    c.room.send(command).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn rename_reaches_everyone_in_every_zone_once_and_later_snapshots_follow() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut hall = connect(&room).await;
    hall.enter_hall().await;
    let mut yard = connect(&room).await;
    sleep(TICK).await;
    a.drain();
    hall.drain();
    rename(&a, "新名字").await;
    rename(&a, "新名字").await; // 同名：不再廣播
    sleep(TICK).await;
    let expected = vec![(a.who.id.clone(), "新名字".to_string())];
    for c in [&mut a, &mut hall, &mut yard] {
        assert_eq!(names(&c.drain()), expected);
    }
    // 之後加入的人在 welcome 看到新名字，原本的人收到的 join 也是
    let (out, mut rx) = mpsc::channel(64);
    join(&room, "後來", AuthKind::Guest, out).await.unwrap();
    let ServerMessage::Welcome { players, auth, .. } = rx.try_recv().unwrap() else {
        panic!("welcome");
    };
    assert_eq!(auth, AuthKind::Guest);
    let me = players.iter().find(|p| p.id == a.who.id).unwrap();
    assert_eq!(me.name, "新名字");
}

#[tokio::test(start_paused = true)]
async fn resume_adopts_a_new_name_broadcasts_it_and_reports_the_new_auth() {
    let room = spawn_room(RoomConfig::new(50));
    let (out, rx) = mpsc::channel(64);
    let who = join(&room, "測試", AuthKind::Google, out).await.unwrap();
    let mut first = rx;
    let ServerMessage::Welcome {
        auth, resume_token, ..
    } = first.try_recv().unwrap()
    else {
        panic!("welcome");
    };
    assert_eq!(auth, AuthKind::Google);
    let mut b = connect(&room).await;
    sleep(TICK).await;
    b.drain();
    room.send(RoomCommand::Disconnect(who.clone()))
        .await
        .unwrap();
    // 同名恢復不廣播；名字不同則採用並廣播（含本人）
    let same = resume_as(&room, &resume_token, "測試", AuthKind::Guest)
        .await
        .unwrap();
    sleep(TICK).await;
    assert!(names(&b.drain()).is_empty());
    same.disconnect().await;
    let (out, mut rx) = mpsc::channel(64);
    let (reply, received) = oneshot::channel();
    room.send(RoomCommand::Resume {
        token: same.token.clone(),
        name: "改過".into(),
        auth: AuthKind::Line,
        outfit: None,
        outbound: out,
        reply,
    })
    .await
    .unwrap();
    assert_eq!(received.await.unwrap().unwrap().id, who.id);
    let ServerMessage::Welcome { auth, players, .. } = rx.try_recv().unwrap() else {
        panic!("welcome");
    };
    assert_eq!(auth, AuthKind::Line);
    assert_eq!(
        players.iter().find(|p| p.id == who.id).unwrap().name,
        "改過"
    );
    sleep(TICK).await;
    let expected = vec![(who.id.clone(), "改過".to_string())];
    assert_eq!(
        names(&std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>()),
        expected
    );
    assert_eq!(names(&b.drain()), expected);
}

/// 斷線恢復帶新名字與 `rename` 共用同一份每位玩家的改名額度：反覆恢復不能繞過頻率限制。
#[tokio::test(start_paused = true)]
async fn resume_renames_share_the_per_player_rename_budget() {
    let room = spawn_room(RoomConfig::new(50));
    let a = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(TICK).await;
    b.drain();
    let id = a.who.id.clone();
    // 額度 2：第一次 rename、第二次以恢復改名都生效；第三次（恢復）額度用完 → 保留舊名、不廣播
    rename(&a, "一").await;
    a.disconnect().await;
    let a2 = resume_as(&room, &a.token, "二", AuthKind::Guest)
        .await
        .unwrap();
    a2.disconnect().await;
    let (out, mut rx) = mpsc::channel(64);
    let (reply, received) = oneshot::channel();
    room.send(RoomCommand::Resume {
        token: a2.token.clone(),
        name: "三".into(),
        auth: AuthKind::Guest,
        outfit: None,
        outbound: out,
        reply,
    })
    .await
    .unwrap();
    let who = received.await.unwrap().unwrap();
    let ServerMessage::Welcome {
        players,
        resume_token,
        ..
    } = rx.try_recv().unwrap()
    else {
        panic!("welcome");
    };
    assert_eq!(
        players.iter().find(|p| p.id == id).unwrap().name,
        "二",
        "over budget: the old name stays and the snapshot says so"
    );
    sleep(TICK).await;
    assert_eq!(
        names(&b.drain()),
        [
            (id.clone(), "一".to_string()),
            (id.clone(), "二".to_string())
        ]
    );
    assert!(names(&std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>()).is_empty());
    // rename 也被同一份額度擋下
    let a3 = Client {
        room: room.clone(),
        who,
        rx,
        n: a.n,
        token: resume_token,
        zone: a.zone.clone(),
        outfit: a.outfit,
        x: a.x,
        z: a.z,
    };
    rename(&a3, "四").await;
    sleep(TICK).await;
    assert!(names(&b.drain()).is_empty());
    // 約 2 秒後回復一次額度
    sleep(Duration::from_millis(2100)).await;
    rename(&a3, "五").await;
    sleep(TICK).await;
    assert_eq!(names(&b.drain()), [(id.clone(), "五".to_string())]);
}

// ---- 玩家碰撞（Task 2） ----

#[tokio::test(start_paused = true)]
async fn walking_into_a_standing_player_pushes_them_and_slows_the_walker() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    let mut watcher = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    watcher.position(0.0, 6.0, 0.0, false).await;
    b.position(0.0, 8.0, 0.0, false).await;
    a.position(-1.0, 8.0, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();
    b.drain();
    watcher.drain();

    // A 朝 B (x 方向) 走向 (-0.2, 8.0)，試圖與 B 重疊 (0.2 < 0.6)
    a.position(-0.2, 8.0, 0.0, true).await;
    sleep(TICK * 2).await;

    let moves = move_tuples(&watcher.drain());
    let a_move = moves.iter().find(|m| m.0 == a.n).copied();
    let b_move = moves.iter().find(|m| m.0 == b.n).copied();

    assert!(a_move.is_some(), "A 應該有移動");
    assert!(b_move.is_some(), "B 應該被推動");
    let a_pos = a_move.unwrap();
    let b_pos = b_move.unwrap();

    assert!(b_pos.1 > 0.0, "B 的 x 應被推往前，實際為 {}", b_pos.1);
    assert!(a_pos.1 < -0.2, "A 的 x 應被推回，實際為 {}", a_pos.1);
    let dist = (b_pos.1 - a_pos.1).hypot(b_pos.2 - a_pos.2);
    assert!(
        dist >= 0.6 - 0.15 - 1e-4,
        "兩人距離應 >= 0.45，實際為 {dist}"
    );
}

#[tokio::test(start_paused = true)]
async fn pushed_player_receives_a_sync_and_appears_in_moves() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    let mut watcher = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    watcher.position(0.0, 6.0, 0.0, false).await;
    b.position(0.0, 8.0, 0.0, false).await;
    a.position(-1.0, 8.0, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();
    b.drain();
    watcher.drain();

    a.position(-0.1, 8.0, 0.0, true).await;
    sleep(TICK * 2).await;

    let b_syncs = corrections(&mut b);
    assert!(!b_syncs.is_empty(), "B 被推動時應收到 sync 校正");
    assert!(b_syncs[0].1 > 0.0, "B 的 sync x 應大於 0.0");

    let w_moves = move_tuples(&watcher.drain());
    assert!(
        w_moves.iter().any(|m| m.0 == b.n),
        "watcher 的 moves 應包含被推動的 B"
    );
}

#[tokio::test(start_paused = true)]
async fn player_in_a_station_action_cannot_be_pushed() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    let mut watcher = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    watcher.position(0.0, 6.0, 0.0, false).await;
    b.position(0.0, 8.0, 0.0, false).await;
    a.position(-1.0, 8.0, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();
    b.drain();
    watcher.drain();

    b.action("req-1", "incense", true).await;
    sleep(TICK).await;
    b.drain();
    a.drain();
    watcher.drain();

    a.position(-0.1, 8.0, 0.0, true).await;
    sleep(TICK * 2).await;

    let a_syncs = corrections(&mut a);
    assert!(!a_syncs.is_empty(), "A 被定點動作阻擋應收到 sync 校正");
    assert!(
        a_syncs[0].1 <= -0.1,
        "A 的位置應被推回 <= -0.1，實際為 {}",
        a_syncs[0].1
    );

    let w_moves = move_tuples(&watcher.drain());
    assert!(
        !w_moves.iter().any(|m| m.0 == b.n),
        "跪拜中的 B 不能被推動出現在 moves 中"
    );
    assert!(
        corrections(&mut b).is_empty(),
        "跪拜中的 B 不能收到位置變更 sync"
    );
}

#[test]
fn collision_corrections_coalesce_and_flush_after_the_last_push() {
    let now = Instant::now();
    let mut room = Room::new(1, RoomConfig::new(50), Arc::new(Metrics::default()));
    let (a_tx, mut a_rx) = mpsc::channel(16);
    let (b_tx, mut b_rx) = mpsc::channel(16);
    let a = room
        .join("A".into(), AuthKind::Guest, 0, a_tx, now)
        .unwrap();
    let b = room
        .join("B".into(), AuthKind::Guest, 0, b_tx, now)
        .unwrap();
    for (who, x) in [(&a, -1.0), (&b, 0.0)] {
        let p = room.live(who).unwrap();
        (p.x, p.z) = (x, 8.0);
        p.trail = [(x, 8.0); 4];
    }
    a_rx.try_recv().unwrap();
    b_rx.try_recv().unwrap();

    room.position(&a, -0.2, 8.0, 0.0, true, now);
    for (who, rx) in [(&a, &mut a_rx), (&b, &mut b_rx)] {
        assert!(matches!(
            rx.try_recv().unwrap(),
            ServerMessage::Sync { m } if m == [tuple(room.live(who).unwrap())]
        ));
    }
    let first_push_x = room.live(&b).unwrap().x;
    let second = now + Duration::from_millis(100);
    room.position(&a, 0.0, 8.0, 0.0, false, second);
    let last_push_x = room.live(&b).unwrap().x;
    assert!(last_push_x > first_push_x);

    room.tick(second);
    room.tick(now + CORRECTION_GAP - Duration::from_millis(1));
    for rx in [&mut a_rx, &mut b_rx] {
        assert!(std::iter::from_fn(|| rx.try_recv().ok()).all(|m| kind(&m) != "sync"));
    }

    room.tick(now + CORRECTION_GAP);
    assert_eq!(room.live(&b).unwrap().x, last_push_x);
    for (who, rx) in [(&a, &mut a_rx), (&b, &mut b_rx)] {
        assert!(matches!(
            rx.try_recv().unwrap(),
            ServerMessage::Sync { m } if m == [tuple(room.live(who).unwrap())]
        ));
    }
    room.tick(now + CORRECTION_GAP * 2);
    for rx in [&mut a_rx, &mut b_rx] {
        assert!(std::iter::from_fn(|| rx.try_recv().ok()).all(|m| kind(&m) != "sync"));
    }
}

#[test]
fn moving_away_from_a_station_action_or_changing_zones_clears_rooting() {
    let now = Instant::now();
    let mut room = Room::new(1, RoomConfig::new(50), Arc::new(Metrics::default()));
    let (b_tx, _b_rx) = mpsc::channel(16);
    let b = room
        .join("B".into(), AuthKind::Guest, 0, b_tx, now)
        .unwrap();
    let p = room.live(&b).unwrap();
    (p.x, p.z) = (0.0, 8.0);
    p.trail = [(0.0, 8.0); 4];
    room.action(&b, "incense".into(), "incense".into(), true, now);
    assert!(Room::rooted(room.live(&b).unwrap(), now));

    room.position(&b, 0.03, 8.0, 0.0, false, now);
    assert!(Room::rooted(room.live(&b).unwrap(), now));
    // 移動中的位置不吃到位寬限，離開站位超過 0.05 就解除
    room.position(&b, 0.06, 8.0, 0.0, true, now);
    assert!(!Room::rooted(room.live(&b).unwrap(), now));
    room.position(&b, 1.0, 8.0, 0.0, false, now);
    assert_eq!(room.live(&b).unwrap().x, 1.0);

    let (a_tx, _a_rx) = mpsc::channel(16);
    let a = room
        .join("A".into(), AuthKind::Guest, 0, a_tx, now)
        .unwrap();
    let p = room.live(&a).unwrap();
    (p.x, p.z) = (0.8, 8.0);
    room.tick(now);
    assert!(room.live(&b).unwrap().x > 1.0);

    let p = room.live(&b).unwrap();
    (p.x, p.z) = (0.0, -4.65);
    // 距離上次授予超過冷卻時間，才會再授予
    let later = now + ROOTED_GRANT_GAP;
    room.action(&b, "bell".into(), "bell".into(), true, later);
    assert!(Room::rooted(room.live(&b).unwrap(), later));
    room.switch_zone(&b, "hall", later);
    let p = room.live(&b).unwrap();
    assert_eq!(p.zone.id, "hall");
    assert!(!Room::rooted(p, later));
}

/// 單人房：玩家站在庭院 (0, 8)。
fn rooted_fixture(now: Instant) -> (Room, Who, mpsc::Receiver<ServerMessage>) {
    let mut room = Room::new(1, RoomConfig::new(50), Arc::new(Metrics::default()));
    let (tx, rx) = mpsc::channel(64);
    let who = room.join("B".into(), AuthKind::Guest, 0, tx, now).unwrap();
    let p = room.live(&who).unwrap();
    (p.x, p.z) = (0.0, 8.0);
    p.trail = [(0.0, 8.0); 4];
    (room, who, rx)
}

#[test]
fn late_stop_after_a_station_action_re_anchors_once() {
    let now = Instant::now();
    let (mut room, b, _rx) = rooted_fixture(now);
    let ms = Duration::from_millis;
    room.action(&b, "r1".into(), "incense".into(), true, now);
    assert!(Room::rooted(room.live(&b).unwrap(), now));

    // 最後的 stop 晚到、離原位 0.2 公尺：寬限內重新錨定，仍然免推
    room.position(&b, 0.2, 8.0, 0.0, false, now + ms(100));
    assert!(Room::rooted(room.live(&b).unwrap(), now + ms(100)));
    // 只能重新錨定一次
    room.position(&b, 0.4, 8.0, 0.0, false, now + ms(200));
    assert!(!Room::rooted(room.live(&b).unwrap(), now + ms(200)));
}

#[test]
fn settle_grace_expires_and_does_not_apply_to_moving_positions() {
    let now = Instant::now();
    let ms = Duration::from_millis;
    let (mut room, b, _rx) = rooted_fixture(now);
    room.action(&b, "r1".into(), "incense".into(), true, now);
    room.position(&b, 0.2, 8.0, 0.0, false, now + ms(600));
    assert!(!Room::rooted(room.live(&b).unwrap(), now + ms(600)));

    let (mut room, b, _rx) = rooted_fixture(now);
    room.action(&b, "r1".into(), "incense".into(), true, now);
    room.position(&b, 0.2, 8.0, 0.0, true, now + ms(100));
    assert!(!Room::rooted(room.live(&b).unwrap(), now + ms(100)));
}

#[test]
fn station_actions_only_grant_rooting_after_the_grant_gap() {
    let now = Instant::now();
    let (mut room, b, _rx) = rooted_fixture(now);
    room.action(&b, "r1".into(), "incense".into(), true, now);
    assert!(Room::rooted(room.live(&b).unwrap(), now));
    // 1 秒後再送：動作照常接受，但不授予免推
    let t1 = now + Duration::from_secs(1);
    room.action(&b, "r2".into(), "incense".into(), true, t1);
    assert_eq!(
        room.live(&b).unwrap().action.as_ref().unwrap().id,
        "incense"
    );
    assert!(!Room::rooted(room.live(&b).unwrap(), t1));

    // 距離上次授予滿 2 秒才再授予
    let t2 = now + ROOTED_GRANT_GAP;
    room.action(&b, "r3".into(), "incense".into(), true, t2);
    assert!(Room::rooted(room.live(&b).unwrap(), t2));
}

#[test]
fn rooting_is_only_granted_for_actions_of_the_current_zone() {
    let now = Instant::now();
    let (mut room, b, _rx) = rooted_fixture(now);
    // 庭院：誦經不授予、上香授予
    room.action(&b, "r1".into(), "chant".into(), true, now);
    assert_eq!(room.live(&b).unwrap().action.as_ref().unwrap().id, "chant");
    assert!(!Room::rooted(room.live(&b).unwrap(), now));
    room.action(&b, "r2".into(), "incense".into(), true, now);
    assert!(Room::rooted(room.live(&b).unwrap(), now));

    // 殿內：敲鐘不授予、上香授予
    let t = now + Duration::from_secs(3);
    let p = room.live(&b).unwrap();
    (p.x, p.z) = (0.0, -4.65);
    room.switch_zone(&b, "hall", t);
    assert_eq!(room.live(&b).unwrap().zone.id, "hall");
    room.action(&b, "r3".into(), "bell".into(), true, t);
    assert_eq!(room.live(&b).unwrap().action.as_ref().unwrap().id, "bell");
    assert!(!Room::rooted(room.live(&b).unwrap(), t));
    room.action(&b, "r4".into(), "incense".into(), true, t);
    assert!(Room::rooted(room.live(&b).unwrap(), t));
}

#[test]
fn pushed_player_whose_own_position_is_accepted_gets_no_stale_sync() {
    let now = Instant::now();
    let mut room = Room::new(1, RoomConfig::new(50), Arc::new(Metrics::default()));
    let (a_tx, mut a_rx) = mpsc::channel(32);
    let (b_tx, mut b_rx) = mpsc::channel(32);
    let a = room
        .join("A".into(), AuthKind::Guest, 0, a_tx, now)
        .unwrap();
    let b = room
        .join("B".into(), AuthKind::Guest, 0, b_tx, now)
        .unwrap();
    for (who, x) in [(&a, -1.0), (&b, 0.0)] {
        let p = room.live(who).unwrap();
        (p.x, p.z) = (x, 8.0);
        p.trail = [(x, 8.0); 4];
    }
    a_rx.try_recv().unwrap();
    b_rx.try_recv().unwrap();

    room.position(&a, -0.2, 8.0, 0.0, true, now);
    let ms = Duration::from_millis;
    room.position(&a, 0.0, 8.0, 0.0, false, now + ms(100));
    let pushed_x = room.live(&b).unwrap().x;
    assert!(room.live(&b).unwrap().correction_pending);
    while b_rx.try_recv().is_ok() {}

    // B 自己的下一個位置被接受（離開 A 遠一點，不需校正）
    room.position(&b, pushed_x + 0.8, 8.0, 0.0, true, now + ms(150));
    assert!(!room.live(&b).unwrap().correction_pending);
    while a_rx.try_recv().is_ok() {}

    room.tick(now + CORRECTION_GAP);
    room.tick(now + CORRECTION_GAP * 2);
    assert!(std::iter::from_fn(|| b_rx.try_recv().ok()).all(|m| kind(&m) != "sync"));
}

#[tokio::test(start_paused = true)]
async fn bowing_player_can_be_pushed() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    let mut watcher = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    watcher.position(0.0, 6.0, 0.0, false).await;
    b.position(0.0, 8.0, 0.0, false).await;
    a.position(-1.0, 8.0, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();
    b.drain();
    watcher.drain();

    b.action("req-1", "bow", true).await;
    sleep(TICK).await;
    b.drain();
    a.drain();
    watcher.drain();

    a.position(-0.1, 8.0, 0.0, true).await;
    sleep(TICK * 2).await;

    let b_syncs = corrections(&mut b);
    assert!(!b_syncs.is_empty(), "合十中的 B 可以被推動並收到 sync");
    let w_moves = move_tuples(&watcher.drain());
    assert!(
        w_moves.iter().any(|m| m.0 == b.n),
        "合十中的 B 應被推動出現在 moves 中"
    );
}

#[tokio::test(start_paused = true)]
async fn player_is_not_pushed_through_an_obstacle() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    let mut watcher = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    // B 站在香爐右側 (1.2, 1.5)，背靠香爐障礙物 (邊界在 1.15)
    // A 站在 (2.2, 1.5)
    b.position(1.2, 1.5, 0.0, false).await;
    a.position(2.2, 1.5, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();
    b.drain();
    watcher.drain();

    // A 朝 -x 走向 B (1.4, 1.5)，推動 B 向 -x
    a.position(1.4, 1.5, 0.0, true).await;
    sleep(TICK).await;

    let w_moves = move_tuples(&watcher.drain());
    if let Some(b_move) = w_moves.iter().find(|m| m.0 == b.n) {
        assert!(
            world::COURTYARD.is_valid(b_move.1, b_move.2),
            "B 不能被推入障礙物"
        );
    }
    for s in corrections(&mut b) {
        assert!(
            world::COURTYARD.is_valid(s.1, s.2),
            "B 的 sync 不能在障礙物內"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn moving_into_a_spot_the_other_player_left_200ms_ago_is_not_corrected() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    let p0 = (0.0, 8.0);
    b.position(p0.0, p0.1, 0.0, false).await;
    a.position(-1.5, 8.0, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();
    b.drain();

    // B 走開到 (1.0, 8.0)
    b.position(1.0, 8.0, 0.0, true).await;
    sleep(TICK * 2 + Duration::from_millis(10)).await;
    a.drain();
    b.drain();

    // A 走到 B 原本的位置 p0
    a.position(p0.0, p0.1, 0.0, false).await;
    sleep(TICK * 2).await;

    let a_syncs = corrections(&mut a);
    assert!(
        a_syncs.is_empty(),
        "A 走到 B 200ms 前離開的位置不應被糾正，收到: {a_syncs:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn riders_knocked_and_grace_players_do_not_collide() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let b = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    b.position(0.0, 8.0, 0.0, false).await;
    a.position(-1.0, 8.0, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;

    // B 斷線進入保留期
    b.disconnect().await;
    sleep(TICK).await;
    a.drain();

    // A 走到 B 的位置 (0.0, 8.0)
    a.position(0.0, 8.0, 0.0, false).await;
    sleep(TICK).await;

    let a_syncs = corrections(&mut a);
    assert!(
        a_syncs.is_empty(),
        "A 走入斷線保留玩家的位置不應發生玩家碰撞糾正"
    );
}

#[tokio::test(start_paused = true)]
async fn two_players_pressing_against_each_other_get_at_most_one_sync_per_correction_gap() {
    let room = spawn_room(RoomConfig::new(50));
    let mut a = connect(&room).await;
    let mut b = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    b.position(0.2, 8.0, 0.0, false).await;
    a.position(-0.2, 8.0, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();
    b.drain();

    let mut a_sync_count = 0;
    for _ in 0..20 {
        a.position(0.1, 8.0, 0.0, true).await;
        b.position(-0.1, 8.0, 0.0, true).await;
        sleep(Duration::from_millis(50)).await;
        a_sync_count += corrections(&mut a).len();
    }

    assert!(
        a_sync_count <= 5,
        "1 秒內 sync 次數應受 CORRECTION_GAP 節流限制，實際收到 {a_sync_count} 次"
    );
    assert!(a_sync_count >= 1, "互相推擠應至少收到 1 次 sync");
}

// ---- 玩家碰撞：每 tick 分離與殿門範圍（Task 3） ----

#[tokio::test(start_paused = true)]
async fn players_spawned_on_the_same_point_drift_apart() {
    let room = spawn_room(RoomConfig::new(50));
    let mut watcher = connect(&room).await;
    watcher.enter_hall().await;
    sleep(Duration::from_secs(2)).await;
    watcher.position(2.0, 7.4, 0.0, false).await;
    sleep(TICK * 2).await;
    watcher.drain();

    // A 與 B 走到門口，同時送出 zone("hall") 進殿，伺服器進殿落點都在 (0.0, 7.4)
    let a = connect(&room).await;
    let b = connect(&room).await;
    a.walk_to_door().await;
    b.walk_to_door().await;
    a.zone("hall").await;
    b.zone("hall").await;
    watcher.drain();

    let mut last_a = (0.0, 7.4);
    let mut last_b = (0.0, 7.4);
    let mut ticks = 0;
    for _ in 0..10 {
        sleep(TICK).await;
        ticks += 1;
        let moves = move_tuples(&watcher.drain());
        if let Some(m) = moves.iter().find(|m| m.0 == a.n) {
            let step = (m.1 - last_a.0).hypot(m.2 - last_a.1);
            assert!(
                step <= crate::collide::SEPARATE_PER_TICK + 1e-4,
                "A 每個 tick 位移應 <= 0.1，實際為 {step}"
            );
            last_a = (m.1, m.2);
        }
        if let Some(m) = moves.iter().find(|m| m.0 == b.n) {
            let step = (m.1 - last_b.0).hypot(m.2 - last_b.1);
            assert!(
                step <= crate::collide::SEPARATE_PER_TICK + 1e-4,
                "B 每個 tick 位移應 <= 0.1，實際為 {step}"
            );
            last_b = (m.1, m.2);
        }
        let dist = (last_a.0 - last_b.0).hypot(last_a.1 - last_b.1);
        if dist >= crate::collide::MIN_DIST - 1e-4 {
            break;
        }
    }
    let final_dist = (last_a.0 - last_b.0).hypot(last_a.1 - last_b.1);
    assert!(
        final_dist >= crate::collide::MIN_DIST - 1e-4,
        "10 個 tick 內兩人距離應 >= 0.6，實際為 {final_dist}"
    );
    assert!(ticks <= 10, "應在 10 個 tick 內分開");
}

#[tokio::test(start_paused = true)]
async fn a_crowd_standing_in_front_of_the_hall_door_does_not_stop_entry() {
    let room = spawn_room(RoomConfig::new(50));
    // 4 人並排站在殿門前 (z = -5.0)
    let mut c1 = connect_with(&room, 256).await;
    let mut c2 = connect_with(&room, 256).await;
    let mut c3 = connect_with(&room, 256).await;
    let mut c4 = connect_with(&room, 256).await;
    let mut p5 = connect_with(&room, 256).await;

    // 依移動額度將所有人繞過香爐走到殿門口附近
    for (wx, wz) in [(2.0, 5.0), (2.0, -4.0)] {
        sleep(Duration::from_secs(6)).await;
        c1.drain();
        c2.drain();
        c3.drain();
        c4.drain();
        p5.drain();
        c1.position(wx, wz, 0.0, false).await;
        c2.position(wx, wz, 0.0, false).await;
        c3.position(wx, wz, 0.0, false).await;
        c4.position(wx, wz, 0.0, false).await;
        p5.position(wx, wz, 0.0, false).await;
    }
    sleep(Duration::from_secs(3)).await;
    c1.drain();
    c2.drain();
    c3.drain();
    c4.drain();
    p5.drain();
    c1.position(-0.9, -5.0, 0.0, false).await;
    c2.position(-0.3, -5.0, 0.0, false).await;
    c3.position(0.3, -5.0, 0.0, false).await;
    c4.position(0.9, -5.0, 0.0, false).await;
    sleep(Duration::from_secs(3)).await;
    p5.drain();

    // 第 5 人走到前端殿門觸發線
    p5.position(0.0, -4.65, 0.0, false).await;
    sleep(Duration::from_secs(1)).await;
    p5.drain();

    // 送出切換場景
    p5.zone("hall").await;
    sleep(TICK * 2).await;

    let got = p5.drain();
    assert!(
        got.iter().any(|m| match m {
            ServerMessage::Zone { zone, .. } => zone == "hall",
            _ => false,
        }),
        "第 5 人在門前 1 公尺內應成功切換進殿，收到: {got:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_player_can_push_through_a_line_of_idle_players() {
    let room = spawn_room(RoomConfig::new(50));
    let b1 = connect(&room).await;
    let b2 = connect(&room).await;
    let b3 = connect(&room).await;
    let mut a = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    // 3 人橫排擋路站在 z = 8.0
    b1.position(-0.6, 8.0, 0.0, false).await;
    b2.position(0.0, 8.0, 0.0, false).await;
    b3.position(0.6, 8.0, 0.0, false).await;
    // A 站在橫排後方 z = 8.8
    a.position(0.0, 8.8, PI, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();

    // A 持續往前走 5 秒（朝 -z 方向前進）
    let mut cur_z = 8.8;
    for _ in 0..50 {
        cur_z -= 0.05;
        a.position(0.0, cur_z, PI, true).await;
        sleep(Duration::from_millis(100)).await;
    }

    // 取得最新 sync 或最新狀態，驗證 A 通過那條線 (z < 8.0)
    let syncs = corrections(&mut a);
    let final_z = syncs.last().map(|s| s.2).unwrap_or(cur_z);
    assert!(
        final_z < 8.0,
        "A 持續往前走 5 秒應能通過人牆 (z 應 < 8.0)，實際為 {final_z}"
    );
}

#[tokio::test(start_paused = true)]
async fn separation_never_moves_a_rooted_player() {
    let room = spawn_room(RoomConfig::new(50));
    let mut b = connect(&room).await;
    let a = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    b.position(0.0, 8.0, 0.0, false).await;
    // B 在庭院執行定點動作（上香）
    b.action("r1", "incense", true).await;
    sleep(TICK).await;
    b.drain();

    // A 走到與 B 重疊的位置 (0.1, 8.0)（距離 0.1 < 0.6）
    a.position(0.1, 8.0, 0.0, false).await;
    b.drain();

    // 經歷 5 個 tick 的分離
    sleep(TICK * 5).await;

    let b_syncs = corrections(&mut b);
    assert!(
        b_syncs.is_empty(),
        "定點動作中的 B 絕不能被分離機制移動或收到 sync，收到: {b_syncs:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn player_pushed_against_incense_burner_stops_and_pusher_is_blocked() {
    let room = spawn_room(RoomConfig::new(50));
    let mut b = connect(&room).await;
    let mut a = connect(&room).await;
    sleep(Duration::from_secs(2)).await;

    // 將 B 移至香爐南側外緣 (0.0, -0.85)（香爐障礙物邊界為 z <= -0.90）
    b.position(2.0, 5.0, 0.0, false).await;
    sleep(Duration::from_secs(4)).await;
    b.position(2.0, -0.85, 0.0, false).await;
    sleep(Duration::from_secs(4)).await;
    b.position(0.0, -0.85, 0.0, false).await;
    sleep(Duration::from_secs(2)).await;
    b.drain();

    // A 移動到 B 後方 (0.0, -0.2)
    a.position(2.0, 5.0, 0.0, false).await;
    sleep(Duration::from_secs(4)).await;
    a.position(2.0, -0.2, 0.0, false).await;
    sleep(Duration::from_secs(4)).await;
    a.position(0.0, -0.2, PI, false).await;
    sleep(Duration::from_secs(2)).await;
    a.drain();
    b.drain();

    // A 嘗試往前推擠 B：向 -z 移動，目標 (0.0, -0.70)
    a.position(0.0, -0.70, PI, true).await;
    sleep(TICK * 2).await;

    // 驗證 B 沒有被推進香爐 (z 必須 > -0.90)
    let b_syncs = corrections(&mut b);
    if let Some(sync) = b_syncs.last() {
        assert!(
            sync.2 >= -0.90,
            "B 絕不可被推進香爐障礙物內部 (z 應 >= -0.90)，實際為 {}",
            sync.2
        );
    }

    // 驗證 A 收到糾正，且 A 也絕不在香爐障礙物內部
    let a_syncs = corrections(&mut a);
    assert!(!a_syncs.is_empty(), "A 被香爐後的 B 阻擋應收到 sync 糾正");
    let a_last = a_syncs.last().unwrap();
    assert!(
        a_last.2 >= -0.90,
        "A 絕不可穿透至香爐障礙物內部 (z 應 >= -0.90)，實際為 {}",
        a_last.2
    );
}

// 出生避讓：有空位取第一個空位（含最後一個候選）；全都擠時取離最近的人最遠的，不是最後抽到的。
#[test]
fn spawn_picks_the_first_free_candidate_or_the_least_crowded_one() {
    // 只有一個人站在 x = 0：到最近的人的距離就是 |x|
    let nearest = |x: f64| x.abs();
    let pick = |xs: &[f64]| least_crowded(xs.iter().copied(), nearest);
    assert_eq!(pick(&[0.1, 0.7, 1.5]), 0.7);
    assert_eq!(pick(&[0.1, 0.2, 0.6]), 0.6);
    assert_eq!(pick(&[0.1, 0.5, 0.3]), 0.5);
    assert_eq!(pick(&[0.4]), 0.4);
}

#[test]
fn repeated_moves_against_the_same_history_do_not_keep_pushing() {
    // B 的歷史位置在 (0, 8)；A 從 (-0.6, 8) 在同一個 tick 內連送三次 (-0.1, 8)。
    // 第一次把 B 推到 0.25、A 留在 -0.35；之後兩人已經分開，B 不可再被推走。
    let now = Instant::now();
    let mut room = Room::new(1, RoomConfig::new(50), Arc::new(Metrics::default()));
    let (a_tx, _a_rx) = mpsc::channel(32);
    let (b_tx, _b_rx) = mpsc::channel(32);
    let a = room
        .join("A".into(), AuthKind::Guest, 0, a_tx, now)
        .unwrap();
    let b = room
        .join("B".into(), AuthKind::Guest, 0, b_tx, now)
        .unwrap();
    for (who, x) in [(&a, -0.6), (&b, 0.0)] {
        let p = room.live(who).unwrap();
        (p.x, p.z) = (x, 8.0);
        p.trail = [(x, 8.0); 4];
    }
    let ms = Duration::from_millis;
    room.position(&a, -0.1, 8.0, 0.0, true, now);
    let first = room.live(&b).unwrap().x;
    assert!((first - 0.25).abs() < 1e-6, "第一次推到 0.25，實際 {first}");
    room.position(&a, -0.1, 8.0, 0.0, true, now + ms(30));
    room.position(&a, -0.1, 8.0, 0.0, true, now + ms(60));
    let b_x = room.live(&b).unwrap().x;
    let a_x = room.live(&a).unwrap().x;
    assert!((b_x - first).abs() < 1e-6, "B 不應再被推，實際 {b_x}");
    assert!(
        (b_x - a_x - crate::collide::MIN_DIST).abs() < 1e-6,
        "A {a_x}、B {b_x}"
    );
}

#[test]
fn sliding_along_an_obstacle_edge_is_not_corrected() {
    // 前端把貼著香爐的人推到障礙物邊界上沿邊滑動：邊界上的座標要算合法，不可退回原位。
    let now = Instant::now();
    let mut room = Room::new(1, RoomConfig::new(50), Arc::new(Metrics::default()));
    let (a_tx, mut a_rx) = mpsc::channel(32);
    let a = room
        .join("A".into(), AuthKind::Guest, 0, a_tx, now)
        .unwrap();
    let p = room.live(&a).unwrap();
    (p.x, p.z) = (1.3, -1.5);
    p.trail = [(1.3, -1.5); 4];
    while a_rx.try_recv().is_ok() {}
    room.position(&a, 1.25, -1.3, 0.0, true, now + Duration::from_millis(100));
    let p = room.live(&a).unwrap();
    assert_eq!((p.x, p.z), (1.25, -1.3));
    assert!(std::iter::from_fn(|| a_rx.try_recv().ok()).all(|m| kind(&m) != "sync"));
}
