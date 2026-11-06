use futures_util::{SinkExt, StreamExt};
use temple_server::app;
use tokio::time::{Duration, timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
struct Server {
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server() -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app(vec!["http://localhost:5173".into()]))
            .await
            .unwrap();
    });
    Server { url, task }
}
async fn connect(server: &Server) -> Ws {
    let mut request = server.url.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", "http://localhost:5173".parse().unwrap());
    connect_async(request).await.unwrap().0
}
async fn text(ws: &mut Ws, raw: &str) {
    ws.send(Message::Text(raw.to_owned().into())).await.unwrap();
    if raw == HELLO {
        assert!(next(ws).await.to_text().unwrap().contains("welcome"));
    }
}
async fn next(ws: &mut Ws) -> Message {
    timeout(Duration::from_secs(7), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}
async fn closed(ws: &mut Ws, code: u16) {
    match next(ws).await {
        Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), code),
        other => panic!("expected close, got {other:?}"),
    }
}
const HELLO: &str = r#"{"t":"hello","v":1,"name":"測試"}"#;
#[tokio::test]
async fn origin_rejected_missing_and_foreign() {
    let server = server().await;
    for origin in [None, Some("https://evil.example")] {
        let mut request = server.url.clone().into_client_request().unwrap();
        if let Some(value) = origin {
            request
                .headers_mut()
                .insert("origin", value.parse().unwrap());
        }
        match connect_async(request).await.unwrap_err() {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), 403)
            }
            error => panic!("{error}"),
        }
    }
}
#[tokio::test]
async fn hello_timeout() {
    let server = server().await;
    let mut ws = connect(&server).await;
    let start = tokio::time::Instant::now();
    closed(&mut ws, 1008).await;
    assert!(start.elapsed() >= Duration::from_secs(5));
}
#[tokio::test]
async fn unsupported_version_then_close() {
    let server = server().await;
    let mut ws = connect(&server).await;
    text(&mut ws, r#"{"t":"hello","v":2,"name":"a"}"#).await;
    let message = next(&mut ws).await;
    let value: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(value["code"], "unsupported_version");
    closed(&mut ws, 1008).await;
}
#[tokio::test]
async fn oversized_and_binary_close_codes() {
    let server = server().await;
    for (message, code) in [
        (Message::Text("x".repeat(17 * 1024).into()), 1009),
        (Message::Binary(vec![1].into()), 1003),
    ] {
        let mut ws = connect(&server).await;
        ws.send(message).await.unwrap();
        closed(&mut ws, code).await;
    }
}
#[tokio::test]
async fn invalid_messages_ignored_until_twenty_one_and_ping_echoed() {
    let server = server().await;
    let mut ws = connect(&server).await;
    text(&mut ws, HELLO).await;
    for _ in 0..20 {
        text(&mut ws, "invalid").await;
    }
    text(&mut ws, r#"{"t":"ping","ts":123.25}"#).await;
    let message = next(&mut ws).await;
    let value: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(value["ts"], 123.25);
    assert!(value["serverTime"].as_f64().unwrap() > 1_700_000_000_000.0);
    text(&mut ws, "invalid").await;
    closed(&mut ws, 1008).await;
}
#[tokio::test]
async fn fragmented_message_limit() {
    use tokio_tungstenite::tungstenite::protocol::frame::{
        Frame,
        coding::{Data, OpCode},
    };
    let server = server().await;
    let mut ws = connect(&server).await;
    ws.send(Message::Frame(Frame::message(
        vec![b'x'; 9000],
        OpCode::Data(Data::Text),
        false,
    )))
    .await
    .unwrap();
    ws.send(Message::Frame(Frame::message(
        vec![b'x'; 9000],
        OpCode::Data(Data::Continue),
        true,
    )))
    .await
    .unwrap();
    closed(&mut ws, 1009).await;
}

#[tokio::test]
async fn exact_byte_limit_and_invalid_schema_do_not_break_session() {
    let server = server().await;
    let mut ws = connect(&server).await;
    text(&mut ws, HELLO).await;
    text(&mut ws, r#"{"t":"ping","ts":"wrong"}"#).await;
    let base = r#"{"t":"ping","ts":42,"padding":""}"#;
    let raw = base.replace(
        "\"padding\":\"\"",
        &format!("\"padding\":\"{}\"", "x".repeat(16384 - base.len())),
    );
    assert_eq!(raw.len(), 16384);
    text(&mut ws, &raw).await;
    assert!(next(&mut ws).await.to_text().unwrap().contains("pong"));
    text(&mut ws, &"\u{1f600}".repeat(5000)).await;
    closed(&mut ws, 1009).await;
}

#[tokio::test]
async fn fifty_one_players_split_and_leave_is_room_local() {
    let server = server().await;
    let mut clients = Vec::new();
    let mut ids = std::collections::HashSet::new();
    let mut room_a = String::new();
    for i in 0..51 {
        let mut ws = connect(&server).await;
        ws.send(Message::Text(HELLO.into())).await.unwrap();
        let welcome: serde_json::Value =
            serde_json::from_str(next(&mut ws).await.to_text().unwrap()).unwrap();
        assert_eq!(welcome["t"], "welcome");
        assert_eq!(
            welcome["players"].as_array().unwrap().len(),
            if i < 50 { i + 1 } else { 1 }
        );
        if i == 0 {
            room_a = welcome["room"].as_str().unwrap().into();
        }
        assert_eq!(welcome["room"] == room_a, i < 50);
        assert!(ids.insert(welcome["selfId"].as_str().unwrap().to_owned()));
        for p in welcome["players"].as_array().unwrap() {
            assert_eq!(p["zone"], "courtyard");
            assert_eq!(p["z"], 11.0);
            assert!((-2.0..=2.0).contains(&p["x"].as_f64().unwrap()));
            assert_eq!(p["heading"], std::f64::consts::PI);
        }
        // Drain joins so the test measures room separation rather than receiver backlog.
        if i < 50 {
            for previous in &mut clients {
                assert!(next(previous).await.to_text().unwrap().contains("join"));
            }
        }
        clients.push(ws);
    }
    let leaving = clients.remove(0);
    drop(leaving);
    for client in &mut clients[..49] {
        let event: serde_json::Value =
            serde_json::from_str(next(client).await.to_text().unwrap()).unwrap();
        assert_eq!(event["t"], "leave");
    }
    assert!(
        timeout(Duration::from_millis(250), clients[49].next())
            .await
            .is_err()
    );
    let mut replacement = connect(&server).await;
    replacement.send(Message::Text(HELLO.into())).await.unwrap();
    let welcome: serde_json::Value =
        serde_json::from_str(next(&mut replacement).await.to_text().unwrap()).unwrap();
    assert_eq!(welcome["room"], room_a);
    assert_eq!(welcome["players"].as_array().unwrap().len(), 50);
}

// ---- 稽核後修正（zone、字串上限、閒置逾時、Origin 正規化） ----

async fn server_with(options: temple_server::ServerOptions) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, temple_server::app_with_options(options))
            .await
            .unwrap();
    });
    Server { url, task }
}

async fn pong(ws: &mut Ws, ts: u32) {
    text(ws, &format!(r#"{{"t":"ping","ts":{ts}}}"#)).await;
    loop {
        let msg = next(ws).await;
        if let Message::Text(raw) = &msg
            && raw.contains(r#""t":"pong""#)
        {
            return;
        }
        assert!(
            !matches!(msg, Message::Close(_)),
            "closed instead of pong: {msg:?}"
        );
    }
}

#[tokio::test]
async fn zone_messages_are_accepted_not_counted_invalid() {
    let server = server().await;
    let mut ws = connect(&server).await;
    text(&mut ws, HELLO).await;
    // 目前前端進出殿會送 zone；T2 時代會被當成無效訊息，第 21 則就斷線。
    for _ in 0..25 {
        text(
            &mut ws,
            r#"{"t":"zone","zone":"hall","x":0,"z":7.4,"heading":3.14}"#,
        )
        .await;
    }
    pong(&mut ws, 1).await;
}

#[tokio::test]
async fn over_limit_strings_count_as_invalid() {
    let server = server().await;
    let mut ws = connect(&server).await;
    text(&mut ws, HELLO).await;
    let long = format!(
        r#"{{"t":"action","reqId":"{}","id":"bow"}}"#,
        "x".repeat(15_000)
    );
    for _ in 0..20 {
        text(&mut ws, &long).await;
    }
    pong(&mut ws, 2).await; // 20 則仍在容許範圍
    text(&mut ws, &long).await;
    loop {
        match next(&mut ws).await {
            Message::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 1008);
                break;
            }
            Message::Text(_) => continue, // 房間的 join 等訊息
            other => panic!("expected close, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn idle_timeout_closes_silent_connection_but_not_active_one() {
    let server = server_with(temple_server::ServerOptions {
        allowed_origins: vec!["http://localhost:5173".into()],
        room_capacity: 50,
        idle_timeout: Duration::from_millis(400),
    })
    .await;
    let mut active = connect(&server).await;
    text(&mut active, HELLO).await;
    let mut silent = connect(&server).await;
    text(&mut silent, HELLO).await;

    let start = tokio::time::Instant::now();
    // 活躍的連線每 150 ms 送一次心跳，持續超過逾時時間的兩倍
    for i in 0..7 {
        pong(&mut active, 10 + i).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert!(start.elapsed() > Duration::from_millis(800));
    // 沉默的連線早已被關閉（之前可能先收到 active 的 join）
    loop {
        match next(&mut silent).await {
            Message::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 1001);
                break;
            }
            Message::Text(_) => continue,
            other => panic!("expected close, got {other:?}"),
        }
    }
    pong(&mut active, 99).await;
}

#[tokio::test]
async fn trailing_slash_origin_setting_still_accepts_browser_origin() {
    let origin = temple_server::config::normalize_origin("http://localhost:5173/").unwrap();
    let server = server_with(temple_server::ServerOptions {
        allowed_origins: vec![origin],
        room_capacity: 50,
        idle_timeout: temple_server::DEFAULT_IDLE_TIMEOUT,
    })
    .await;
    let mut ws = connect(&server).await; // 瀏覽器送的是沒有結尾斜線的 Origin
    text(&mut ws, HELLO).await;
}
