use crate::metrics::Metrics;
use crate::{
    protocol::{
        MAX_MOVES_PER_MESSAGE, MAX_SHORT_ID, MoveTuple, Moving, PlayerAction, PlayerSnapshot,
        ServerMessage,
    },
    world::{self, PORTAL_TOLERANCE, Zone},
};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{
        mpsc::{self, error::TrySendError},
        oneshot,
    },
    time::{Instant, MissedTickBehavior, interval},
};

/// 單一房間人數上限的上限。welcome 以單則訊息帶整房快照，必須放得進
/// MAX_MESSAGE_BYTES（見 `full_room_welcome_fits_message_limit`）。
/// ponytail: 要開放更多人須先改成分段快照，並同步調整前端 decode() 與寫入緩衝上限。
pub const MAX_ROOM_CAPACITY: usize = 50;
// sync 以單則訊息帶整個場景的其他玩家，所以房間上限不能超過單則筆數上限。
const _: () = assert!(MAX_ROOM_CAPACITY <= MAX_MOVES_PER_MESSAGE);
// 短編號在二進位幀中只有 7 位元（0～127）。
const _: () = assert!(MAX_ROOM_CAPACITY <= MAX_SHORT_ID as usize + 1);
const ROOM_IDLE: Duration = Duration::from_secs(60);
/// 位置驗證：每位玩家有一份「移動額度」（公尺），以 MOVE_SPEED × 1.5 的速度累積、移動時依距離扣除。
/// 網路卡頓後訊息一次湧到時，卡頓期間累積的額度足以涵蓋實際走過的路；額度有上限，所以不能存起來瞬移。
const SPEED_MARGIN: f64 = 1.5;
/// 額度上限：2 秒份（9.6 公尺），相當於正常速度走 3 秒。卡頓超過這個長度的玩家會被拉回伺服器上的位置。
const BUDGET_CAP: f64 = world::MOVE_SPEED * SPEED_MARGIN * 2.0;
/// 加入、切換場景、恢復連線後的起始額度（公尺）。
const BUDGET_START: f64 = 1.0;
/// 位置被拒時把伺服器上的位置回傳給本人，兩次之間至少相隔這段時間。
const CORRECTION_GAP: Duration = Duration::from_millis(300);
/// 每位玩家快取的 reqId 結果筆數。
const ACK_CACHE: usize = 64;

#[derive(Clone, Copy, Debug)]
pub struct RoomConfig {
    pub capacity: usize,
    /// 廣播 tick 間隔（`TICK_HZ`）。
    pub tick: Duration,
    /// 斷線後保留玩家的時間（`RESUME_GRACE_SECONDS`）。
    pub resume_grace: Duration,
    /// 每條連線的發送佇列上限。
    pub outbound_capacity: usize,
    /// 移動中的玩家超過這段時間沒有新的位置訊息，視為停止（伺服器端停止看門狗）。
    pub stale_move: Duration,
}
impl RoomConfig {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            tick: Duration::from_millis(100),
            resume_grace: Duration::from_secs(30),
            outbound_capacity: 64,
            stale_move: Duration::from_secs(1),
        }
    }
}

pub type Outbound = mpsc::Receiver<ServerMessage>;

/// 一條連線在房內的身分。`conn` 區分同一玩家的新舊連線，舊連線的指令一律忽略。
#[derive(Clone, Debug)]
struct Who {
    id: String,
    conn: u64,
}
type Reply = oneshot::Sender<Option<Who>>;
enum RoomCommand {
    Join {
        name: String,
        outfit: u8,
        outbound: mpsc::Sender<ServerMessage>,
        reply: Reply,
    },
    Resume {
        token: String,
        /// `hello` 帶的名字（已清理）；與保存的不同就改名並對其他人重送 `join`。
        name: Option<String>,
        /// `hello` 帶的有效衣裝；沒有或無效為 `None`（沿用保存的衣裝）。
        outfit: Option<u8>,
        outbound: mpsc::Sender<ServerMessage>,
        reply: Reply,
    },
    Disconnect(Who),
    Position {
        who: Who,
        x: f64,
        z: f64,
        heading: f64,
        moving: bool,
        at: Instant,
    },
    Action {
        who: Who,
        req_id: String,
        action: String,
        data_ok: bool,
    },
    Zone {
        who: Who,
        zone: String,
    },
    Chat {
        who: Who,
        text: String,
    },
    Outfit {
        who: Who,
        outfit: u8,
    },
}

struct Link {
    conn: u64,
    tx: mpsc::Sender<ServerMessage>,
}
struct Player {
    id: String,
    n: u8,
    name: String,
    /// 衣裝編號（0..OUTFIT_COUNT），斷線保留期間與恢復連線時都保留。
    outfit: u8,
    token: String,
    zone: &'static Zone,
    x: f64,
    z: f64,
    heading: f64,
    moving: bool,
    action: Option<PlayerAction>,
    /// `None` 表示斷線保留中。
    link: Option<Link>,
    grace_until: Option<Instant>,
    /// 最後一次接受位置的時間，速度驗證以它為基準。
    last_at: Instant,
    /// 最後一則被接受的位置訊息時間，停止看門狗以它為基準。
    last_pos_msg: Instant,
    /// 移動額度（公尺），算到 `last_at` 為止。
    budget: f64,
    /// 最近一次把位置校正回傳給本人的時間。
    corrected_at: Option<Instant>,
    /// 下個 tick 要廣播這位玩家的位置。
    dirty: bool,
    /// 這位收件人的 moves 曾被丟棄，下個放得進佇列的 tick 改送 sync。
    needs_sync: bool,
    acks: VecDeque<(String, ServerMessage)>,
}

struct Admission {
    name: String,
    outfit: Option<u8>,
    resume_token: Option<String>,
    reply: oneshot::Sender<Membership>,
}
#[derive(Clone)]
pub struct Lobby {
    tx: mpsc::Sender<Admission>,
}
pub struct Membership {
    who: Who,
    room: mpsc::Sender<RoomCommand>,
    pub outbound: Outbound,
}
impl Membership {
    /// 位置是可取代的狀態：房間指令佇列滿時直接丟棄，不讓連線 task 等待。
    pub fn position(&self, x: f64, z: f64, heading: f64, moving: bool, at: Instant) {
        let _ = self.room.try_send(RoomCommand::Position {
            who: self.who.clone(),
            x,
            z,
            heading,
            moving,
            at,
        });
    }
    pub async fn action(&self, req_id: String, action: String, data_ok: bool) {
        let _ = self
            .room
            .send(RoomCommand::Action {
                who: self.who.clone(),
                req_id,
                action,
                data_ok,
            })
            .await;
    }
    /// 聊天可丟棄：房間指令佇列滿時直接丟棄。
    pub fn chat(&self, text: String) {
        let _ = self.room.try_send(RoomCommand::Chat {
            who: self.who.clone(),
            text,
        });
    }
    /// 更換衣裝（值已驗證）。是狀態而不是可丟棄的資料，所以等房間指令佇列有空位。
    pub async fn outfit(&self, outfit: u8) {
        let _ = self
            .room
            .send(RoomCommand::Outfit {
                who: self.who.clone(),
                outfit,
            })
            .await;
    }
    pub async fn zone(&self, zone: String) {
        let _ = self
            .room
            .send(RoomCommand::Zone {
                who: self.who.clone(),
                zone,
            })
            .await;
    }
    /// 連線結束：玩家進入斷線保留期（保留期滿才廣播 leave）。
    pub async fn disconnect(self) {
        let _ = self.room.send(RoomCommand::Disconnect(self.who)).await;
    }
}
impl Lobby {
    pub fn new(config: RoomConfig, metrics: Arc<Metrics>) -> Self {
        assert!((1..=MAX_ROOM_CAPACITY).contains(&config.capacity));
        let (tx, mut rx) = mpsc::channel::<Admission>(128);
        tokio::spawn(async move {
            let mut rooms: BTreeMap<u64, mpsc::Sender<RoomCommand>> = BTreeMap::new();
            let mut next_room = 0u64;
            let mut cleanup = interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    request = rx.recv() => {
                        let Some(request) = request else { break };
                        if request.reply.is_closed() { continue; }
                        rooms.retain(|_, room| !room.is_closed());
                        let (outbound, receiver) = mpsc::channel(config.outbound_capacity);
                        let mut assigned = None;
                        // resumeToken 以「房間編號.隨機值」編碼，直接找到原房間。
                        if let Some(token) = &request.resume_token
                            && let Some(room) = token
                                .split_once('.')
                                .and_then(|(no, _)| u64::from_str_radix(no, 16).ok())
                                .and_then(|no| rooms.get(&no))
                        {
                            let (reply, received) = oneshot::channel();
                            let command = RoomCommand::Resume { token: token.clone(), name: Some(request.name.clone()), outfit: request.outfit, outbound: outbound.clone(), reply };
                            if room.send(command).await.is_ok() && let Ok(Some(who)) = received.await {
                                assigned = Some((who, room.clone()));
                            }
                        }
                        if assigned.is_none() {
                            for room in rooms.values() {
                                if let Some(who) = join(room, &request.name, request.outfit.unwrap_or(0), outbound.clone()).await {
                                    assigned = Some((who, room.clone())); break;
                                }
                            }
                        }
                        if assigned.is_none() {
                            next_room += 1;
                            let (tx, rx) = mpsc::channel(128);
                            tokio::spawn(run_room(next_room, config, rx, metrics.clone()));
                            if let Some(who) = join(&tx, &request.name, request.outfit.unwrap_or(0), outbound.clone()).await { assigned = Some((who, tx.clone())); }
                            rooms.insert(next_room, tx);
                        }
                        if let Some((who, room)) = assigned {
                            // If the connection disappeared, dropping the receiver lets the room reclaim it.
                            let _ = request.reply.send(Membership { who, room, outbound: receiver });
                        }
                    }
                    _ = cleanup.tick() => rooms.retain(|_, room| !room.is_closed()),
                }
            }
        });
        Self { tx }
    }
    /// 加入房間；帶有效的 `resume_token` 時恢復原本的玩家，否則視為新玩家。
    /// `outfit` 是 `hello` 帶的有效衣裝（缺少或無效為 `None`）：新玩家以它為準（沒有則 0），
    /// 恢復時只有與保存值不同才更換。
    pub async fn join(
        &self,
        name: String,
        resume_token: Option<String>,
        outfit: Option<u8>,
    ) -> Option<Membership> {
        let (reply, received) = oneshot::channel();
        self.tx
            .send(Admission {
                name,
                outfit,
                resume_token,
                reply,
            })
            .await
            .ok()?;
        received.await.ok()
    }
}
async fn join(
    room: &mpsc::Sender<RoomCommand>,
    name: &str,
    outfit: u8,
    outbound: mpsc::Sender<ServerMessage>,
) -> Option<Who> {
    let (reply, received) = oneshot::channel();
    room.send(RoomCommand::Join {
        name: name.into(),
        outfit,
        outbound,
        reply,
    })
    .await
    .ok()?;
    received.await.ok().flatten()
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
/// 四捨五入到 0.01；`+ 0.0` 把 -0.0 轉成 0.0。
fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0 + 0.0
}
fn tuple(p: &Player) -> MoveTuple {
    let moving = if p.moving {
        Moving::Moving
    } else {
        Moving::Stopped
    };
    (p.n, round2(p.x), round2(p.z), round2(p.heading), moving)
}

/// 本 tick 每位玩家的狀態；收件人依場景與是否變動從中篩選。
struct TickState {
    n: u8,
    zone: &'static str,
    tuple: MoveTuple,
    dirty: bool,
}

/// 房間 actor 擁有全部玩家狀態；只在自己的 task 內修改，對連線只用 `try_send`，不會被任何連線拖住。
struct Room {
    id: String,
    no: u64,
    config: RoomConfig,
    metrics: Arc<Metrics>,
    players: HashMap<String, Player>,
    next_conn: u64,
}

impl Room {
    fn new_token(&self) -> String {
        format!("{:x}.{:032x}", self.no, rand::random::<u128>())
    }
    /// 最小的未使用編號（含斷線保留中的玩家）；離開的玩家編號因此會被之後加入的人回收。
    fn free_number(&self) -> Option<u8> {
        (0..=MAX_SHORT_ID).find(|n| self.players.values().all(|p| p.n != *n))
    }
    fn snapshot(p: &Player) -> PlayerSnapshot {
        PlayerSnapshot {
            zone: Some(p.zone.id.into()),
            id: p.id.clone(),
            n: p.n,
            name: p.name.clone(),
            x: p.x,
            z: p.z,
            heading: p.heading,
            action: p.action.clone(),
            outfit: p.outfit,
        }
    }
    fn welcome(&self, p: &Player) -> ServerMessage {
        ServerMessage::Welcome {
            self_id: p.id.clone(),
            room: self.id.clone(),
            resume_token: p.token.clone(),
            server_time: now_ms(),
            players: self.players.values().map(Self::snapshot).collect(),
        }
    }
    /// 連線指令只在 conn 相符（目前這條連線）時生效。
    fn live(&mut self, who: &Who) -> Option<&mut Player> {
        self.players
            .get_mut(&who.id)
            .filter(|p| p.link.as_ref().is_some_and(|l| l.conn == who.conn))
    }

    fn join(
        &mut self,
        name: String,
        outfit: u8,
        outbound: mpsc::Sender<ServerMessage>,
        now: Instant,
    ) -> Option<Who> {
        if self.players.len() >= self.config.capacity {
            return None;
        }
        let n = self.free_number()?;
        let id = format!("p-{:032x}", rand::random::<u128>());
        self.next_conn += 1;
        let conn = self.next_conn;
        let spawn = world::COURTYARD.spawn;
        let player = Player {
            id: id.clone(),
            n,
            name,
            outfit,
            token: self.new_token(),
            zone: &world::COURTYARD,
            x: spawn.x + rand::random_range(-2.0..=2.0),
            z: spawn.z,
            heading: spawn.heading,
            moving: false,
            action: None,
            link: Some(Link { conn, tx: outbound }),
            grace_until: None,
            last_at: now,
            last_pos_msg: now,
            budget: BUDGET_START,
            corrected_at: None,
            dirty: false,
            needs_sync: false,
            acks: VecDeque::new(),
        };
        self.players.insert(id.clone(), player);
        if !self.send_welcome(&id) {
            self.players.remove(&id);
            return None;
        }
        Some(Who { id, conn })
    }

    /// 以有效、未過期、尚未使用過的 token 恢復玩家；token 立即換新，舊連線若還在會被取代。
    fn resume(
        &mut self,
        token: &str,
        name: Option<String>,
        outfit: Option<u8>,
        outbound: mpsc::Sender<ServerMessage>,
        now: Instant,
    ) -> Option<Who> {
        let id = self
            .players
            .values()
            .find(|p| p.token == token && p.grace_until.is_none_or(|t| t > now))?
            .id
            .clone();
        self.next_conn += 1;
        let conn = self.next_conn;
        let token = self.new_token();
        let p = self.players.get_mut(&id)?;
        p.token = token;
        // 取代舊連線：舊的 Sender 被丟棄，舊連線的 session 送完佇列後以 1013 關閉。
        p.link = Some(Link { conn, tx: outbound });
        p.grace_until = None;
        p.needs_sync = false;
        p.last_at = now;
        p.budget = BUDGET_START;
        if p.moving {
            p.moving = false;
            p.dirty = true;
        }
        // hello 帶了有效且不同的衣裝以它為準（welcome 已含新值）；其他人要另外得知。
        let changed = outfit.filter(|o| *o != p.outfit);
        if let Some(o) = changed {
            p.outfit = o;
        }
        // 重新整理後換了名字：沒有改名訊息，對其他人重送同一個 id 的 join（前端會更新既有玩家）。
        let renamed = name.filter(|n| *n != p.name);
        if let Some(n) = &renamed {
            p.name = n.clone();
        }
        if !self.send_welcome(&id) {
            self.detach(&id, now);
            return None;
        }
        if renamed.is_some()
            && let Some(p) = self.players.get(&id)
        {
            let join = ServerMessage::Join {
                player: Self::snapshot(p),
            };
            self.broadcast(join, now, |q| q.id != id);
        } else if let Some(outfit) = changed {
            let message = ServerMessage::Outfit {
                id: id.clone(),
                outfit,
            };
            self.broadcast(message, now, |q| q.id != id);
        }
        Some(Who { id, conn })
    }

    fn send_welcome(&self, id: &str) -> bool {
        let Some(p) = self.players.get(id) else {
            return false;
        };
        let Some(link) = &p.link else { return false };
        link.tx.try_send(self.welcome(p)).is_ok()
    }

    /// 通知同房（連線中、符合 `to`）的玩家。不可丟棄的訊息放不進佇列代表慢速接收者，
    /// 該連線被中斷（session 以 1013 關閉），玩家進入斷線保留期。
    fn broadcast(&mut self, message: ServerMessage, now: Instant, to: impl Fn(&Player) -> bool) {
        let failed: Vec<(String, bool)> = self
            .players
            .values()
            .filter(|p| to(p))
            .filter_map(|p| {
                let error = p.link.as_ref()?.tx.try_send(message.clone()).err()?;
                Some((p.id.clone(), matches!(error, TrySendError::Full(_))))
            })
            .collect();
        for (id, full) in failed {
            // 對方連線已結束（佇列關閉）不算慢速接收者，只有佇列塞滿才計入指標。
            if full {
                tracing::warn!(player = %id, "slow receiver, closing connection");
                self.metrics.slow_receiver_closed();
            }
            self.detach(&id, now);
        }
    }
    fn send_to(&mut self, id: &str, message: ServerMessage, now: Instant) {
        self.broadcast(message, now, |p| p.id == id);
    }

    /// 連線中斷：保留玩家 `resume_grace`，立即視為停止（下個 tick 廣播一次），不廣播 leave。
    fn detach(&mut self, id: &str, now: Instant) {
        let Some(p) = self.players.get_mut(id) else {
            return;
        };
        if p.link.take().is_some() {
            p.grace_until = Some(now + self.config.resume_grace);
            if p.moving {
                p.moving = false;
                p.dirty = true;
            }
        }
    }

    fn position(&mut self, who: &Who, x: f64, z: f64, heading: f64, moving: bool, at: Instant) {
        let Some(p) = self.live(who) else { return };
        if !(x.is_finite() && z.is_finite() && heading.is_finite()) {
            return;
        }
        let (cx, cz) = p.zone.bounds.clamp(x, z);
        let elapsed = at.saturating_duration_since(p.last_at).as_secs_f64();
        let budget = (p.budget + world::MOVE_SPEED * SPEED_MARGIN * elapsed).min(BUDGET_CAP);
        let distance = (cx - p.x).hypot(cz - p.z);
        if distance > budget || p.zone.blocked(p.x, p.z, cx, cz) {
            // 拒絕（太遠，或直線穿過障礙物）：維持原位置，下個 tick 重送給其他人，
            // 並以只含本人的 sync 把伺服器上的位置回傳給本人，讓他的畫面回到同一個位置。
            p.dirty = true;
            if p.corrected_at
                .is_some_and(|t| at.saturating_duration_since(t) < CORRECTION_GAP)
            {
                return;
            }
            p.corrected_at = Some(at);
            let correction = ServerMessage::Sync { m: vec![tuple(p)] };
            let id = p.id.clone();
            self.send_to(&id, correction, at);
            return;
        }
        let heading = world::normalize_heading(heading);
        if (cx, cz, heading, moving) != (p.x, p.z, p.heading, p.moving) {
            p.dirty = true;
        }
        (p.x, p.z, p.heading, p.moving) = (cx, cz, heading, moving);
        p.budget = budget - distance;
        p.last_at = at;
        p.last_pos_msg = at;
    }

    fn action(&mut self, who: &Who, req_id: String, action: String, data_ok: bool, now: Instant) {
        let Some(p) = self.live(who) else { return };
        let mut started = None;
        let ack = match p.acks.iter().find(|(r, _)| *r == req_id) {
            Some((_, ack)) => ack.clone(),
            None => {
                let known = world::action(&action);
                let reason = match (data_ok, known) {
                    (false, _) => Some("unsupported_data"),
                    (true, None) => Some("unknown_action"),
                    (true, Some(_)) => None,
                };
                let ack = ServerMessage::Ack {
                    req_id: req_id.clone(),
                    ok: reason.is_none(),
                    reason: reason.map(Into::into),
                };
                if p.acks.len() >= ACK_CACHE {
                    p.acks.pop_front();
                }
                p.acks.push_back((req_id, ack.clone()));
                if let (None, Some(id), Some(code)) = (reason, known, world::action_code(&action)) {
                    let started_at = now_ms();
                    p.action = Some(PlayerAction {
                        id: id.into(),
                        started_at,
                    });
                    started = Some((p.n, code, started_at, p.zone.id));
                }
                ack
            }
        };
        self.send_to(&who.id, ack, now);
        if let Some((n, code, started_at, zone)) = started {
            let message = ServerMessage::Action {
                n,
                code,
                started_at,
            };
            self.broadcast(message, now, |q| q.zone.id == zone && q.id != who.id);
        }
    }

    fn chat(&mut self, who: &Who, text: String, now: Instant) {
        if self.live(who).is_none() {
            return;
        }
        let message = ServerMessage::Chat {
            id: who.id.clone(),
            text,
            at: now_ms(),
        };
        self.broadcast(message, now, |_| true);
    }

    /// 更換衣裝：與目前相同不廣播；否則保存並廣播給同房所有在線玩家（不分場景、含本人）。
    fn set_outfit(&mut self, who: &Who, outfit: u8, now: Instant) {
        let Some(p) = self.live(who) else { return };
        if p.outfit == outfit {
            return;
        }
        p.outfit = outfit;
        let message = ServerMessage::Outfit {
            id: who.id.clone(),
            outfit,
        };
        self.broadcast(message, now, |_| true);
    }

    fn switch_zone(&mut self, who: &Who, target: &str, now: Instant) {
        let Some(p) = self.live(who) else { return };
        let allowed = world::zone(target).and_then(|zone| {
            p.zone
                .portals
                .iter()
                .find(|portal| {
                    portal.to == zone.id && portal.rect.grow(PORTAL_TOLERANCE).contains(p.x, p.z)
                })
                .map(|portal| (zone, portal.spawn))
        });
        let Some((zone, spawn)) = allowed else {
            let error = ServerMessage::Error {
                code: "invalid_zone".into(),
                message: "Zone change not allowed here".into(),
            };
            self.send_to(&who.id, error, now);
            return;
        };
        // 位置改為伺服器端的出入口落點，不採用客戶端送來的座標。
        (p.zone, p.x, p.z, p.heading) = (zone, spawn.x, spawn.z, spawn.heading);
        p.budget = BUDGET_START;
        p.moving = false;
        p.dirty = false;
        p.last_at = now;
        p.last_pos_msg = now;
        let message = ServerMessage::Zone {
            id: who.id.clone(),
            zone: zone.id.into(),
            x: spawn.x,
            z: spawn.z,
            heading: spawn.heading,
        };
        // 先讓所有人知道換場景，再把新場景裡的其他玩家位置整批校正給切換者。
        self.broadcast(message, now, |_| true);
        let states = self.states();
        self.send_batch(&who.id, &states, true, now);
    }

    /// 送一則 `sync`（整個場景的其他玩家）或 `moves`（本 tick 有變動的其他玩家）給收件人。
    /// 放不進佇列時（可丟棄）標記之後改送 sync；對方已斷線則進入保留期。
    fn send_batch(&mut self, id: &str, states: &[TickState], sync: bool, now: Instant) {
        let Some(r) = self.players.get_mut(id) else {
            return;
        };
        let Some(link) = &r.link else { return };
        let others = states.iter().filter(|s| s.zone == r.zone.id && s.n != r.n);
        let message = if sync {
            ServerMessage::Sync {
                m: others.map(|s| s.tuple).collect(),
            }
        } else {
            let m: Vec<_> = others.filter(|s| s.dirty).map(|s| s.tuple).collect();
            if m.is_empty() {
                return;
            }
            ServerMessage::Moves { m }
        };
        match link.tx.try_send(message) {
            Ok(()) => {
                if sync {
                    r.needs_sync = false;
                }
            }
            Err(TrySendError::Full(_)) => {
                r.needs_sync = true;
                self.metrics.batch_dropped(sync);
            }
            Err(TrySendError::Closed(_)) => self.detach(id, now),
        }
    }

    fn states(&self) -> Vec<TickState> {
        self.players
            .values()
            .map(|p| TickState {
                n: p.n,
                zone: p.zone.id,
                tuple: tuple(p),
                dirty: p.dirty,
            })
            .collect()
    }

    fn tick(&mut self, now: Instant) {
        // 連線已消失但還沒收到 Disconnect（例如恢復失敗後的殘留）：同樣進入保留期。
        let closed: Vec<String> = self
            .players
            .values()
            .filter(|p| p.link.as_ref().is_some_and(|l| l.tx.is_closed()))
            .map(|p| p.id.clone())
            .collect();
        for id in closed {
            self.detach(&id, now);
        }
        let expired: Vec<String> = self
            .players
            .values()
            .filter(|p| p.grace_until.is_some_and(|t| t <= now))
            .map(|p| p.id.clone())
            .collect();
        for id in expired {
            self.players.remove(&id);
            self.broadcast(ServerMessage::Leave { id }, now, |_| true);
        }
        // 停止看門狗
        for p in self.players.values_mut() {
            if p.moving && now.saturating_duration_since(p.last_pos_msg) > self.config.stale_move {
                p.moving = false;
                p.dirty = true;
            }
        }
        let states = self.states();
        for p in self.players.values_mut() {
            p.dirty = false;
        }
        let recipients: Vec<(String, bool)> = self
            .players
            .values()
            .filter(|p| p.link.is_some())
            .map(|p| (p.id.clone(), p.needs_sync))
            .collect();
        for (id, sync) in recipients {
            self.send_batch(&id, &states, sync, now);
        }
    }
}

async fn run_room(
    no: u64,
    config: RoomConfig,
    mut rx: mpsc::Receiver<RoomCommand>,
    metrics: Arc<Metrics>,
) {
    let mut room = Room {
        id: format!("room-{no}"),
        no,
        config,
        metrics,
        players: HashMap::new(),
        next_conn: 0,
    };
    let mut counted = None;
    let mut empty_since = Some(Instant::now());
    let mut tick = interval(config.tick);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            command = rx.recv() => {
                let Some(command) = command else { break };
                let now = Instant::now();
                match command {
                    RoomCommand::Join { name, outfit, outbound, reply } => {
                        if reply.is_closed() || outbound.is_closed() { let _ = reply.send(None); continue; }
                        match room.join(name, outfit, outbound, now) {
                            Some(who) => {
                                let id = who.id.clone();
                                if reply.send(Some(who)).is_err() {
                                    room.players.remove(&id);
                                } else if let Some(p) = room.players.get(&id) {
                                    let join = ServerMessage::Join { player: Room::snapshot(p) };
                                    room.broadcast(join, now, |q| q.id != id);
                                }
                            }
                            None => { let _ = reply.send(None); }
                        }
                    }
                    RoomCommand::Resume { token, name, outfit, outbound, reply } => {
                        let _ = reply.send(room.resume(&token, name, outfit, outbound, now));
                    }
                    RoomCommand::Disconnect(who) => {
                        if room.live(&who).is_some() { room.detach(&who.id, now); }
                    }
                    RoomCommand::Position { who, x, z, heading, moving, at } => room.position(&who, x, z, heading, moving, at),
                    RoomCommand::Action { who, req_id, action, data_ok } => room.action(&who, req_id, action, data_ok, now),
                    RoomCommand::Zone { who, zone } => room.switch_zone(&who, &zone, now),
                    RoomCommand::Chat { who, text } => room.chat(&who, text, now),
                    RoomCommand::Outfit { who, outfit } => room.set_outfit(&who, outfit, now),
                }
            }
            _ = tick.tick() => {
                let started = std::time::Instant::now();
                room.tick(Instant::now());
                room.metrics.tick_done(started.elapsed());
            }
        }
        let roster = Some(room.players.len());
        if roster != counted {
            room.metrics.room_occupancy(counted, roster);
            counted = roster;
        }
        if room.players.is_empty() {
            let since = empty_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= ROOM_IDLE {
                break;
            }
        } else {
            empty_since = None;
        }
    }
    room.metrics.room_occupancy(counted, None);
}

#[cfg(test)]
mod tests;
