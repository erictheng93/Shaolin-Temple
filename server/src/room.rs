use crate::protocol::{PlayerSnapshot, ServerMessage};
use std::{
    collections::HashMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, MissedTickBehavior, interval},
};

const OUTBOUND_CAPACITY: usize = 64;
/// 單一房間人數上限的上限。預設 50；放寬是為了日後依實測調整而不必改程式，
/// 但仍設上限，避免誤設極大值讓單房廣播成本（人數平方）失控。
pub const MAX_ROOM_CAPACITY: usize = 500;
const ROOM_IDLE: Duration = Duration::from_secs(60);
pub type Outbound = mpsc::Receiver<ServerMessage>;
struct Player {
    snapshot: PlayerSnapshot,
    outbound: mpsc::Sender<ServerMessage>,
}
struct Join {
    name: String,
    outbound: mpsc::Sender<ServerMessage>,
    reply: oneshot::Sender<Option<String>>,
}
enum RoomCommand {
    Join(Join),
    Leave(String),
}
struct Admission {
    name: String,
    reply: oneshot::Sender<Membership>,
}
#[derive(Clone)]
pub struct Lobby {
    tx: mpsc::Sender<Admission>,
}
pub struct Membership {
    id: String,
    room: mpsc::Sender<RoomCommand>,
    pub outbound: Outbound,
}
impl Membership {
    pub async fn leave(self) {
        let _ = self.room.send(RoomCommand::Leave(self.id)).await;
    }
}
impl Lobby {
    pub fn new(capacity: usize) -> Self {
        assert!((1..=MAX_ROOM_CAPACITY).contains(&capacity));
        let (tx, mut rx) = mpsc::channel::<Admission>(128);
        tokio::spawn(async move {
            let mut rooms: Vec<mpsc::Sender<RoomCommand>> = Vec::new();
            let mut next_room = 0u64;
            let mut cleanup = interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    request = rx.recv() => {
                        let Some(request) = request else { break };
                        if request.reply.is_closed() { continue; }
                        rooms.retain(|room| !room.is_closed());
                        let (outbound, receiver) = mpsc::channel(OUTBOUND_CAPACITY);
                        let mut assigned = None;
                        for room in &rooms {
                            if let Some(id) = join(room, &request.name, outbound.clone()).await {
                                assigned = Some((id, room.clone())); break;
                            }
                        }
                        if assigned.is_none() {
                            next_room += 1;
                            let (tx, rx) = mpsc::channel(128);
                            tokio::spawn(run_room(format!("room-{next_room}"), capacity, rx));
                            if let Some(id) = join(&tx, &request.name, outbound.clone()).await { assigned = Some((id, tx.clone())); }
                            rooms.push(tx);
                        }
                        if let Some((id, room)) = assigned {
                            // If the connection disappeared, dropping the receiver lets the room reclaim it.
                            let _ = request.reply.send(Membership { id, room, outbound: receiver });
                        }
                    }
                    _ = cleanup.tick() => rooms.retain(|room| !room.is_closed()),
                }
            }
        });
        Self { tx }
    }
    pub async fn join(&self, name: String) -> Option<Membership> {
        let (reply, received) = oneshot::channel();
        self.tx.send(Admission { name, reply }).await.ok()?;
        received.await.ok()
    }
}
async fn join(
    room: &mpsc::Sender<RoomCommand>,
    name: &str,
    outbound: mpsc::Sender<ServerMessage>,
) -> Option<String> {
    let (reply, received) = oneshot::channel();
    room.send(RoomCommand::Join(Join {
        name: name.into(),
        outbound,
        reply,
    }))
    .await
    .ok()?;
    received.await.ok().flatten()
}
fn broadcast(players: &mut HashMap<String, Player>, message: ServerMessage, except: Option<&str>) {
    let mut failed = Vec::new();
    for (id, player) in players.iter() {
        if Some(id.as_str()) != except && player.outbound.try_send(message.clone()).is_err() {
            failed.push(id.clone());
        }
    }
    // A slow or disconnected receiver never stalls the room; propagate every removal.
    while let Some(id) = failed.pop() {
        if players.remove(&id).is_none() {
            continue;
        }
        for (other_id, player) in players.iter() {
            if player
                .outbound
                .try_send(ServerMessage::Leave { id: id.clone() })
                .is_err()
            {
                failed.push(other_id.clone());
            }
        }
    }
}
async fn run_room(room_id: String, capacity: usize, mut rx: mpsc::Receiver<RoomCommand>) {
    let mut players: HashMap<String, Player> = HashMap::new();
    let mut empty_since = Some(Instant::now());
    let mut tick = interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            command = rx.recv() => match command {
                Some(RoomCommand::Join(request)) => {
                    if players.len() >= capacity || request.reply.is_closed() || request.outbound.is_closed() {
                        let _ = request.reply.send(None); continue;
                    }
                    let id = format!("p-{:032x}", rand::random::<u128>());
                    let snapshot = PlayerSnapshot { id: id.clone(), name: request.name, x: rand::random::<f64>() * 4.0 - 2.0, z: 11.0, heading: std::f64::consts::PI, action: None, zone: Some("courtyard".into()) };
                    let mut snapshots: Vec<_> = players.values().map(|p| p.snapshot.clone()).collect();
                    snapshots.push(snapshot.clone());
                    let welcome = ServerMessage::Welcome { self_id: id.clone(), room: room_id.clone(), resume_token: format!("{:032x}", rand::random::<u128>()), server_time: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as f64, players: snapshots };
                    if request.outbound.try_send(welcome).is_err() { let _ = request.reply.send(None); continue; }
                    if request.reply.send(Some(id.clone())).is_err() { continue; }
                    players.insert(id.clone(), Player { snapshot: snapshot.clone(), outbound: request.outbound });
                    broadcast(&mut players, ServerMessage::Join { player: snapshot }, Some(&id));
                }
                Some(RoomCommand::Leave(id)) => {
                    if players.remove(&id).is_some() { broadcast(&mut players, ServerMessage::Leave { id }, None); }
                }
                None => break,
            },
            _ = tick.tick() => {
                let gone: Vec<_> = players.iter().filter(|(_, p)| p.outbound.is_closed()).map(|(id,_)| id.clone()).collect();
                for id in gone { if players.remove(&id).is_some() { broadcast(&mut players, ServerMessage::Leave { id }, None); } }
            }
        }
        if players.is_empty() {
            let since = empty_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= ROOM_IDLE {
                break;
            }
        } else {
            empty_since = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn empty_room_stops_after_sixty_seconds() {
        let (tx, rx) = mpsc::channel(8);
        let task = tokio::spawn(run_room("test".into(), 50, rx));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(59)).await;
        tokio::task::yield_now().await;
        assert!(!tx.is_closed());
        tokio::time::advance(Duration::from_secs(1)).await;
        task.await.unwrap();
        assert!(tx.is_closed());
    }
    #[tokio::test(start_paused = true)]
    async fn disconnect_releases_capacity_and_restarts_idle_deadline() {
        let (tx, rx) = mpsc::channel(8);
        let task = tokio::spawn(run_room("test".into(), 1, rx));
        let (out, mut inbox) = mpsc::channel(64);
        let id = join(&tx, "one", out).await.unwrap();
        assert!(matches!(
            inbox.recv().await,
            Some(ServerMessage::Welcome { .. })
        ));
        let (out, _inbox2) = mpsc::channel(64);
        assert!(join(&tx, "full", out).await.is_none());
        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        assert!(!tx.is_closed());
        tx.send(RoomCommand::Leave(id)).await.unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(59)).await;
        tokio::task::yield_now().await;
        assert!(!tx.is_closed());
        tokio::time::advance(Duration::from_secs(1)).await;
        task.await.unwrap();
        assert!(tx.is_closed());
    }
}
