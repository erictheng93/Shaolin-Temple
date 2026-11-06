use crate::protocol::{
    ClientMessage, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ServerMessage, clean_name,
};
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::Response,
};
use std::{
    collections::VecDeque,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::{Instant, timeout, timeout_at};

pub async fn upgrade(
    State(state): State<crate::AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, StatusCode> {
    let mut values = headers.get_all("origin").iter();
    let origin = values
        .next()
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    if values.next().is_some() || !state.origins.iter().any(|v| v == origin) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(ws
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .read_buffer_size(4096)
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_MESSAGE_BYTES * 2)
        .on_upgrade(move |ws| session(ws, state.lobby, state.idle_timeout)))
}
async fn send(ws: &mut WebSocket, msg: Message) -> bool {
    matches!(
        timeout(Duration::from_secs(1), ws.send(msg)).await,
        Ok(Ok(()))
    )
}
async fn close(ws: &mut WebSocket, code: u16, reason: &'static str) {
    send(
        ws,
        Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Allow the peer to read the close frame before dropping the TCP socket.
    let _ = timeout(Duration::from_millis(200), async {
        while let Some(Ok(message)) = ws.recv().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
    })
    .await;
}
async fn json(ws: &mut WebSocket, msg: ServerMessage) -> bool {
    match serde_json::to_string(&msg) {
        Ok(raw) => send(ws, Message::Text(raw.into())).await,
        Err(_) => false,
    }
}
#[derive(Default)]
struct InvalidMessages(VecDeque<Instant>);
impl InvalidMessages {
    fn record(&mut self, now: Instant) -> bool {
        while self
            .0
            .front()
            .is_some_and(|time| now.duration_since(*time) >= Duration::from_secs(10))
        {
            self.0.pop_front();
        }
        self.0.push_back(now);
        self.0.len() > 20
    }
}
async fn session(mut ws: WebSocket, lobby: crate::room::Lobby, idle_timeout: Duration) {
    let mut membership = None;
    session_inner(&mut ws, &lobby, &mut membership, idle_timeout).await;
    if let Some(member) = membership {
        member.leave().await;
    }
}
async fn session_inner(
    ws: &mut WebSocket,
    lobby: &crate::room::Lobby,
    membership: &mut Option<crate::room::Membership>,
    idle_timeout: Duration,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    // 握手後最後一次收到任何資料（含控制幀）的時間；超過 idle_timeout 沒有任何輸入即關閉，
    // 避免對方斷電／斷網而沒有關閉握手時，連線與房間名額永遠被佔用。
    let mut last_inbound = Instant::now();
    let mut name = None;
    let mut invalid = InvalidMessages::default();
    loop {
        let received = if name.is_none() {
            match timeout_at(deadline, ws.recv()).await {
                Ok(value) => value,
                Err(_) => {
                    close(ws, 1008, "hello timeout").await;
                    return;
                }
            }
        } else {
            let Some(member) = membership.as_mut() else {
                return;
            };
            tokio::select! {
                inbound = ws.recv() => inbound,
                _ = tokio::time::sleep_until(last_inbound + idle_timeout) => {
                    close(ws, 1001, "idle timeout").await;
                    return;
                }
                outbound = member.outbound.recv() => {
                    match outbound {
                        Some(message) => { if !json(ws, message).await { return; } }
                        None => { close(ws, 1013, "room disconnected").await; return; }
                    }
                    continue;
                }
            }
        };
        last_inbound = Instant::now();
        let raw = match received {
            Some(Ok(Message::Text(raw))) => raw,
            Some(Ok(Message::Binary(_))) => {
                close(ws, 1003, "text messages required").await;
                return;
            }
            Some(Ok(Message::Close(_))) | None => return,
            Some(Ok(_)) => continue,
            Some(Err(error)) => {
                let code = if error
                    .into_inner()
                    .downcast_ref::<tokio_tungstenite::tungstenite::Error>()
                    .is_some_and(|e| {
                        matches!(e, tokio_tungstenite::tungstenite::Error::Capacity(_))
                    }) {
                    1009
                } else {
                    1002
                };
                close(ws, code, "invalid WebSocket frame").await;
                return;
            }
        };
        // 格式錯誤或字串超過長度上限，都視為無效訊息
        let parsed = serde_json::from_str::<ClientMessage>(&raw)
            .ok()
            .filter(ClientMessage::within_limits);
        match parsed {
            Some(ClientMessage::Hello {
                v, name: requested, ..
            }) if name.is_none() => {
                if v != PROTOCOL_VERSION {
                    json(
                        ws,
                        ServerMessage::Error {
                            code: "unsupported_version".into(),
                            message: "Protocol version 1 required".into(),
                        },
                    )
                    .await;
                    close(ws, 1008, "unsupported version").await;
                    return;
                }
                let cleaned = clean_name(&requested);
                *membership = lobby.join(cleaned.clone()).await;
                if membership.is_none() {
                    close(ws, 1013, "server busy").await;
                    return;
                }
                name = Some(cleaned);
                tracing::debug!("hello accepted");
            }
            Some(ClientMessage::Ping { ts }) if name.is_some() => {
                let server_time = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as f64;
                if !json(ws, ServerMessage::Pong { ts, server_time }).await {
                    return;
                }
            }
            Some(
                ClientMessage::Move { .. }
                | ClientMessage::Stop { .. }
                | ClientMessage::Action { .. }
                | ClientMessage::Zone { .. },
            ) if name.is_some() => {
                // T3 connects this validated protocol boundary to room commands.
            }
            _ => {
                if invalid.record(Instant::now()) {
                    close(ws, 1008, "too many invalid messages").await;
                    return;
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_window_expires() {
        let now = Instant::now();
        let mut invalid = InvalidMessages::default();
        for _ in 0..20 {
            assert!(!invalid.record(now));
        }
        assert!(!invalid.record(now + Duration::from_secs(10)));
        for _ in 0..19 {
            assert!(!invalid.record(now + Duration::from_secs(10)));
        }
        assert!(invalid.record(now + Duration::from_secs(10)));
    }
}
