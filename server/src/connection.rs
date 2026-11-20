use crate::{
    metrics::Metrics,
    protocol::{
        AuthKind, ClientMessage, Frame, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ServerMessage,
        clean_chat, clean_name, parse_outfit,
    },
    rate_limit::{RateLimiter, Verdict},
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
        .on_upgrade(move |ws| session(ws, state)))
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
/// 送出一則伺服器訊息：`moves`／`sync`／`action` 為二進位幀，其餘為 JSON 文字。
async fn deliver(ws: &mut WebSocket, metrics: &Metrics, msg: ServerMessage) -> bool {
    let Some(frame) = msg.to_frame() else {
        tracing::error!(?msg, "server message could not be encoded");
        return false;
    };
    let bytes = frame.len();
    let message = match frame {
        Frame::Text(raw) => Message::Text(raw.into()),
        Frame::Binary(raw) => Message::Binary(raw.into()),
    };
    let sent = send(ws, message).await;
    if sent {
        metrics.message_out(&msg, bytes);
    }
    sent
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
async fn session(mut ws: WebSocket, state: crate::AppState) {
    let _open = state.metrics.connection_opened();
    let mut membership = None;
    session_inner(&mut ws, &state, &mut membership).await;
    if let Some(member) = membership {
        member.disconnect().await;
    }
}
/// 補送被丟棄的最新位置前等待的時間：位置額度每秒 15 則，約 67 ms 補回一則。
const HELD_RETRY: Duration = Duration::from_millis(70);
async fn session_inner(
    ws: &mut WebSocket,
    state: &crate::AppState,
    membership: &mut Option<crate::room::Membership>,
) {
    let idle_timeout = state.idle_timeout;
    let mut limiter = RateLimiter::new(Instant::now(), state.rate_close_after);
    let deadline = Instant::now() + Duration::from_secs(5);
    // 握手後最後一次收到任何資料（含控制幀）的時間；超過 idle_timeout 沒有任何輸入即關閉，
    // 避免對方斷電／斷網而沒有關閉握手時，連線與房間名額永遠被佔用。
    let mut last_inbound = Instant::now();
    let mut name = None;
    let mut invalid = InvalidMessages::default();
    // 被速率限制丟棄的最新一則位置：位置是可取代的，該丟的是舊的而不是最新的，
    // 所以留著最後一則，等有額度時補送（否則卡頓後停下的玩家會一直停在舊位置）。
    let mut held: Option<(Instant, f64, f64, f64, bool)> = None;
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
                _ = tokio::time::sleep_until(held.map_or(last_inbound, |h| h.0) + HELD_RETRY), if held.is_some() => {
                    let now = Instant::now();
                    if let Some((_, x, z, heading, moving)) = held.take() {
                        if limiter.admit_held(now) {
                            member.position(x, z, heading, moving, now);
                        } else {
                            held = Some((now, x, z, heading, moving));
                        }
                    }
                    continue;
                }
                outbound = member.outbound.recv() => {
                    match outbound {
                        Some(message) => { if !deliver(ws, &state.metrics, message).await { return; } }
                        None => { close(ws, 1013, "room disconnected").await; return; }
                    }
                    continue;
                }
            }
        };
        last_inbound = Instant::now();
        if let Some(Ok(Message::Text(raw))) = &received {
            state.metrics.message_in(raw.len());
        }
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
                v,
                name: requested,
                resume_token,
                outfit,
                session,
            }) if name.is_none() => {
                if v != PROTOCOL_VERSION {
                    deliver(
                        ws,
                        &state.metrics,
                        ServerMessage::Error {
                            code: "unsupported_version".into(),
                            message: format!("Protocol version {PROTOCOL_VERSION} required"),
                        },
                    )
                    .await;
                    close(ws, 1008, "unsupported version").await;
                    return;
                }
                let cleaned = clean_name(&requested);
                // session 缺少、過期、簽章不符或伺服器沒設定 SESSION_SECRET：當訪客，不拒絕連線。
                // 恢復連線（resumeToken）時同樣重新驗證，welcome.auth 反映這次的結果。
                let auth = session
                    .as_deref()
                    .zip(state.auth.as_deref())
                    .and_then(|(token, auth)| {
                        auth.signer.verify_session(token, crate::auth::now_secs())
                    })
                    .map_or(AuthKind::Guest, |identity| identity.provider.auth_kind());
                *membership = state
                    .lobby
                    .join(
                        cleaned.clone(),
                        auth,
                        resume_token,
                        outfit.as_ref().and_then(parse_outfit),
                    )
                    .await;
                if membership.is_none() {
                    close(ws, 1013, "server busy").await;
                    return;
                }
                name = Some(cleaned);
                tracing::debug!("hello accepted");
            }
            Some(message) if name.is_some() && !matches!(message, ClientMessage::Hello { .. }) => {
                let now = Instant::now();
                match limiter.admit(&message, now) {
                    Verdict::Pass => {
                        if matches!(
                            message,
                            ClientMessage::Move { .. } | ClientMessage::Stop { .. }
                        ) {
                            held = None;
                        }
                    }
                    Verdict::Drop => {
                        state.metrics.rate_limited();
                        match message {
                            ClientMessage::Move { x, z, heading, .. } => {
                                held = Some((now, x, z, heading, true))
                            }
                            ClientMessage::Stop { x, z, heading, .. } => {
                                held = Some((now, x, z, heading, false))
                            }
                            _ => {}
                        }
                        continue;
                    }
                    Verdict::Close => {
                        tracing::info!(dropped = limiter.dropped, "rate limit exceeded");
                        close(ws, 1008, "rate limit exceeded").await;
                        return;
                    }
                }
                let Some(member) = membership.as_ref() else {
                    return;
                };
                match message {
                    ClientMessage::Ping { ts } => {
                        let server_time = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as f64;
                        if !deliver(ws, &state.metrics, ServerMessage::Pong { ts, server_time })
                            .await
                        {
                            return;
                        }
                    }
                    ClientMessage::Move { x, z, heading, .. } => {
                        member.position(x, z, heading, true, now)
                    }
                    ClientMessage::Stop { x, z, heading, .. } => {
                        member.position(x, z, heading, false, now)
                    }
                    ClientMessage::Action {
                        req_id, id, data, ..
                    } => {
                        let data_ok = data.is_none_or(|d| d.is_empty());
                        member.action(req_id, id, data_ok).await
                    }
                    ClientMessage::Zone { zone, .. } => member.zone(zone).await,
                    ClientMessage::Chat { text } => {
                        let text = clean_chat(&text);
                        if !text.is_empty() {
                            member.chat(text);
                        }
                    }
                    ClientMessage::Outfit { outfit } => {
                        // 無效值直接丟棄；與目前相同的值由房間判斷、不廣播。
                        if let Some(outfit) = parse_outfit(&outfit) {
                            member.outfit(outfit).await;
                        }
                    }
                    ClientMessage::Rename { name } => member.rename(clean_name(&name)).await,
                    ClientMessage::Claim { kind } => member.claim(kind).await,
                    ClientMessage::Ride { car } => member.ride(car).await,
                    ClientMessage::Drive { seq, dir, mag } => member.drive(seq, dir, mag),
                    ClientMessage::Hello { .. } => {}
                }
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
