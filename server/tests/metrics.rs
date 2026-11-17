//! T7：`GET /metrics` 的授權、指標名稱，以及計數會隨連線與訊息增加。

use futures_util::{SinkExt, StreamExt};
use temple_server::{ServerOptions, app_with_options};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::{Duration, sleep, timeout},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

struct Server {
    addr: std::net::SocketAddr,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(token: Option<&str>) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let options = ServerOptions {
        metrics_token: token.map(Into::into),
        ..ServerOptions::new(vec!["http://localhost:5173".into()])
    };
    let task = tokio::spawn(async move {
        axum::serve(listener, app_with_options(options))
            .await
            .unwrap();
    });
    Server { addr, task }
}
/// 最小的 HTTP/1.1 GET，回傳（狀態碼, 內文）。
async fn get(server: &Server, authorization: Option<&str>) -> (u16, String) {
    let mut stream = tokio::net::TcpStream::connect(server.addr).await.unwrap();
    let auth = authorization
        .map(|v| format!("Authorization: {v}\r\n"))
        .unwrap_or_default();
    let request = format!("GET /metrics HTTP/1.1\r\nHost: x\r\n{auth}Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.unwrap();
    let status = raw.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .unwrap_or_default();
    (status, body.to_owned())
}
fn value(body: &str, series: &str) -> f64 {
    body.lines()
        .find_map(|l| l.strip_prefix(series)?.strip_prefix(' '))
        .unwrap_or_else(|| panic!("missing {series}"))
        .parse()
        .unwrap()
}

#[tokio::test]
async fn token_protects_metrics() {
    let server = server(Some("secret")).await;
    assert_eq!(get(&server, None).await.0, 401);
    assert_eq!(get(&server, Some("Bearer wrong")).await.0, 401);
    assert_eq!(get(&server, Some("Bearer secre")).await.0, 401);
    assert_eq!(get(&server, Some("Basic secret")).await.0, 401);
    assert_eq!(get(&server, Some("Bearer secret")).await.0, 200);
}

#[tokio::test]
async fn open_without_token_and_names_present() {
    let server = server(None).await;
    let (status, body) = get(&server, None).await;
    assert_eq!(status, 200);
    for name in [
        "temple_connections ",
        "temple_rooms ",
        "temple_rooms_by_players{players=\"1-10\"}",
        "temple_messages_in_total ",
        "temple_messages_out_total{t=\"moves\"}",
        "temple_bytes_out_total{t=\"moves\"}",
        "temple_dropped_total{t=\"moves\"}",
        "temple_dropped_total{t=\"sync\"}",
        "temple_slow_receiver_closed_total ",
        "temple_tick_seconds_bucket{le=\"+Inf\"}",
        "temple_tick_seconds_sum ",
        "temple_tick_seconds_count ",
        "temple_tick_seconds_max ",
    ] {
        assert!(body.contains(name), "missing {name}\n{body}");
    }
}

#[tokio::test]
async fn counters_follow_connections_and_messages() {
    let server = server(None).await;
    let mut sockets = Vec::new();
    let mut texts = Vec::new();
    for i in 0..2 {
        let mut request = format!("ws://{}/ws", server.addr)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", "http://localhost:5173".parse().unwrap());
        let (mut ws, _) = connect_async(request).await.unwrap();
        let hello = format!(r#"{{"t":"hello","v":4,"name":"m{i}"}}"#);
        ws.send(Message::Text(hello.into())).await.unwrap();
        let welcome = timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        texts.push(welcome.to_text().unwrap().len());
        sockets.push(ws);
    }
    let move_raw = r#"{"t":"move","x":0.5,"z":11,"heading":3.14,"seq":1}"#;
    sockets[0]
        .send(Message::Text(move_raw.into()))
        .await
        .unwrap();
    // 第二位玩家應收到含第一位玩家位置的 moves（計入出站訊息）。
    let moves = loop {
        let message = timeout(Duration::from_secs(5), sockets[1].next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        // moves 是二進位幀，第一個 byte 是幀型 0x01。
        if let Message::Binary(raw) = &message
            && raw.first() == Some(&temple_server::protocol::FRAME_MOVES)
        {
            break message;
        }
    };
    let moves_len = moves.into_data().len() as f64;
    sleep(Duration::from_millis(100)).await;
    let (_, body) = get(&server, None).await;
    assert_eq!(value(&body, "temple_connections"), 2.0);
    assert_eq!(value(&body, "temple_rooms"), 1.0);
    assert_eq!(value(&body, "temple_players"), 2.0);
    assert_eq!(
        value(&body, "temple_rooms_by_players{players=\"1-10\"}"),
        1.0
    );
    // hello ×2 + move ×1
    assert_eq!(value(&body, "temple_messages_in_total"), 3.0);
    assert_eq!(
        value(&body, "temple_messages_out_total{t=\"welcome\"}"),
        2.0
    );
    assert!(value(&body, "temple_messages_out_total{t=\"moves\"}") >= 1.0);
    assert!(value(&body, "temple_bytes_out_total{t=\"moves\"}") >= moves_len);
    assert!(value(&body, "temple_tick_seconds_count") >= 1.0);

    drop(sockets);
    sleep(Duration::from_millis(500)).await;
    let (_, body) = get(&server, None).await;
    assert_eq!(value(&body, "temple_connections"), 0.0);
    assert_eq!(value(&body, "temple_connections_total"), 2.0);
}
