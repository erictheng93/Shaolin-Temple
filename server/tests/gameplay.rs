//! T4～T6 與協定增修的端對端測試（真實 WebSocket）。涉及時間的值（tick、保留期、
//! 連續超速）透過 `ServerOptions` 縮短；速度驗證本身使用真實時間，所以走到殿門需要約 3.6 秒。

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use temple_server::{
    ServerOptions, app_with_options,
    protocol::{BatchKind, decode_batch},
    room::RoomConfig,
};
use tokio::time::{Duration, Instant, sleep, timeout};
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
fn options() -> ServerOptions {
    ServerOptions::new(vec!["http://localhost:5173".into()])
}
async fn server_with(options: ServerOptions) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app_with_options(options))
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
async fn send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
/// 讀下一則訊息；`wait` 內沒有訊息或連線已關閉則回 `None`。二進位的 moves／sync 幀
/// 解碼後轉成與 v1 JSON 相同的形狀（`{"t":"moves","m":[[n,x,z,heading,moving],…]}`），測試沿用同一套斷言。
async fn recv(ws: &mut Ws, wait: Duration) -> Option<Value> {
    loop {
        match timeout(wait, ws.next()).await {
            Ok(Some(Ok(Message::Text(raw)))) => return serde_json::from_str(&raw).ok(),
            Ok(Some(Ok(Message::Binary(raw)))) => return Some(batch_json(&raw)),
            Ok(Some(Ok(Message::Close(_)))) | Ok(Some(Err(_))) | Ok(None) | Err(_) => return None,
            Ok(Some(Ok(_))) => continue,
        }
    }
}
fn batch_json(raw: &[u8]) -> Value {
    let (kind, m) = decode_batch(raw).expect("valid binary frame");
    let t = match kind {
        BatchKind::Moves => "moves",
        BatchKind::Sync => "sync",
    };
    let m: Vec<Value> = m
        .into_iter()
        .map(|(n, x, z, heading, moving)| json!([n, x, z, heading, u8::from(moving)]))
        .collect();
    json!({ "t": t, "m": m })
}
/// 讀到第一則 `t` 為 `kind` 的訊息（途中的 join 等訊息略過）。
async fn recv_kind(ws: &mut Ws, kind: &str) -> Value {
    loop {
        let message = recv(ws, Duration::from_secs(5)).await.expect(kind);
        if message["t"] == kind {
            return message;
        }
    }
}
/// 收集 `span` 內的所有訊息。
async fn collect(ws: &mut Ws, span: Duration) -> Vec<Value> {
    let end = Instant::now() + span;
    let mut out = Vec::new();
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match recv(ws, left).await {
            Some(v) => out.push(v),
            None => break,
        }
    }
    out
}
/// 讀到關閉幀並回傳 close code（途中的文字訊息略過）。
async fn close_code<S>(ws: &mut S) -> u16
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match timeout(Duration::from_secs(7), ws.next()).await.unwrap() {
            Some(Ok(Message::Close(Some(frame)))) => return u16::from(frame.code),
            Some(Ok(Message::Text(_) | Message::Binary(_))) => continue,
            other => panic!("expected close frame, got {other:?}"),
        }
    }
}

struct Me {
    id: String,
    room: String,
    n: u64,
    token: String,
    zone: String,
    x: f64,
    z: f64,
    welcome: Value,
}
async fn hello(ws: &mut Ws, resume: Option<&str>) -> Me {
    let mut message = json!({ "t": "hello", "v": 2, "name": "測試" });
    if let Some(token) = resume {
        message["resumeToken"] = json!(token);
    }
    send(ws, message).await;
    let welcome = recv(ws, Duration::from_secs(5)).await.expect("welcome");
    assert_eq!(welcome["t"], "welcome");
    let id = welcome["selfId"].as_str().unwrap().to_owned();
    let me = welcome["players"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id.as_str())
        .unwrap()
        .clone();
    Me {
        room: welcome["room"].as_str().unwrap().into(),
        n: me["n"].as_u64().expect("snapshot carries n"),
        token: welcome["resumeToken"].as_str().unwrap().into(),
        zone: me["zone"].as_str().unwrap().into(),
        x: me["x"].as_f64().unwrap(),
        z: me["z"].as_f64().unwrap(),
        id,
        welcome,
    }
}
fn position(t: &str, x: f64, z: f64) -> Value {
    json!({ "t": t, "x": x, "z": z, "heading": 0, "seq": 1 })
}
/// 訊息中屬於短編號 `n` 的 moves／sync 筆數據：(x, z, moving)。
fn tuples_of(messages: &[Value], kind: &str, n: u64) -> Vec<(f64, f64, u64)> {
    messages
        .iter()
        .filter(|m| m["t"] == kind)
        .flat_map(|m| m["m"].as_array().unwrap().clone())
        .filter(|t| t[0] == n)
        .map(|t| {
            (
                t[1].as_f64().unwrap(),
                t[2].as_f64().unwrap(),
                t[4].as_u64().unwrap(),
            )
        })
        .collect()
}

// ---- T4：速率限制 ----

#[tokio::test]
async fn thirty_moves_per_second_yield_about_fifteen() {
    let server = server_with(ServerOptions {
        room: RoomConfig {
            tick: Duration::from_millis(10),
            ..RoomConfig::new(50)
        },
        ..options()
    })
    .await;
    let mut watcher = connect(&server).await;
    hello(&mut watcher, None).await;
    let mut a = connect(&server).await;
    let me = hello(&mut a, None).await;
    let start = Instant::now();
    let mut every = tokio::time::interval(Duration::from_millis(33));
    for k in 0..45 {
        every.tick().await;
        send(&mut a, position("move", me.x + 0.02 * f64::from(k), me.z)).await;
    }
    let elapsed = start.elapsed().as_secs_f64();
    let seen = collect(&mut watcher, Duration::from_millis(500)).await;
    // 每個被接受的訊息 x 都不同，tick 比送出間隔短，所以不同的 x 數 = 被接受的則數
    let mut xs: Vec<_> = tuples_of(&seen, "moves", me.n)
        .iter()
        .map(|t| (t.0 * 100.0).round() as i64)
        .collect();
    xs.dedup();
    let accepted = xs.len() as f64;
    let budget = 3.0 + 15.0 * elapsed;
    assert!(accepted < 45.0 * 0.8, "{accepted} of 45 accepted");
    assert!(accepted <= budget + 2.0, "{accepted} > {budget}");
    assert!(accepted >= 15.0 * elapsed * 0.5, "{accepted} too few");
}

#[tokio::test]
async fn sustained_overage_closes_with_1008() {
    let server = server_with(ServerOptions {
        rate_close_after: Duration::from_millis(300),
        ..options()
    })
    .await;
    let mut a = connect(&server).await;
    let me = hello(&mut a, None).await;
    let (mut tx, mut rx) = a.split();
    // 讀取端獨立運作，才收得到伺服器送出的關閉幀
    let reader = tokio::spawn(async move { close_code(&mut rx).await });
    for _ in 0..200 {
        // 每秒約 100 則 move：遠高於 15／秒
        let raw = position("move", me.x, me.z).to_string();
        if tx.send(Message::Text(raw.into())).await.is_err() {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(reader.await.unwrap(), 1008);
}

// ---- T4：動作 ----

#[tokio::test]
async fn duplicate_req_id_is_acked_twice_but_broadcast_once() {
    let server = server_with(options()).await;
    let mut b = connect(&server).await;
    hello(&mut b, None).await;
    let mut a = connect(&server).await;
    let me = hello(&mut a, None).await;
    let action = json!({ "t": "action", "reqId": "r1", "id": "bow" });
    send(&mut a, action.clone()).await;
    send(&mut a, action).await;
    // action 每秒最多 2 則：等一下再送後面的
    sleep(Duration::from_millis(1100)).await;
    send(
        &mut a,
        json!({ "t": "action", "reqId": "r2", "id": "dance" }),
    )
    .await;
    send(
        &mut a,
        json!({ "t": "action", "reqId": "r3", "id": "bell", "data": { "x": 1 } }),
    )
    .await;
    let mine = collect(&mut a, Duration::from_millis(500)).await;
    let acks: Vec<_> = mine.iter().filter(|m| m["t"] == "ack").collect();
    assert_eq!(acks.len(), 4);
    assert_eq!(acks[0], acks[1]);
    assert_eq!(
        (acks[0]["reqId"].as_str(), acks[0]["ok"].as_bool()),
        (Some("r1"), Some(true))
    );
    assert_eq!(
        (acks[2]["ok"].as_bool(), acks[2]["reason"].as_str()),
        (Some(false), Some("unknown_action"))
    );
    assert_eq!(
        (acks[3]["ok"].as_bool(), acks[3]["reason"].as_str()),
        (Some(false), Some("unsupported_data"))
    );
    let theirs = collect(&mut b, Duration::from_millis(300)).await;
    let actions: Vec<_> = theirs.iter().filter(|m| m["t"] == "action").collect();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["playerId"], me.id.as_str());
    assert_eq!(actions[0]["id"], "bow");
    // 空 data 物件與省略 data 一樣可接受
    sleep(Duration::from_millis(1100)).await;
    send(
        &mut a,
        json!({ "t": "action", "reqId": "r4", "id": "bell", "data": {} }),
    )
    .await;
    let mine = collect(&mut a, Duration::from_millis(300)).await;
    assert_eq!(mine.iter().find(|m| m["t"] == "ack").unwrap()["ok"], true);
}

// ---- T4 / T5：場景切換 ----

#[tokio::test]
async fn zone_switch_requires_the_portal_and_uses_server_landing_point() {
    let server = server_with(options()).await;
    let mut yard = connect(&server).await;
    hello(&mut yard, None).await;
    let mut a = connect(&server).await;
    let me = hello(&mut a, None).await;
    let mut hall = connect(&server).await;
    hello(&mut hall, None).await;
    // 庭院中央：invalid_zone，場景不變
    send(
        &mut a,
        json!({ "t": "zone", "zone": "hall", "x": 0, "z": 7.4, "heading": 3.0 }),
    )
    .await;
    let reply = recv_kind(&mut a, "error").await;
    assert_eq!(reply["code"], "invalid_zone");
    // 走到殿門（速度上限允許後才能一次到位），再送 zone；客戶端送來的座標被忽略
    // 繞過香爐分三段走，每段都等移動額度累積夠了再送
    for (x, z, wait) in [(2.0, 5.0, 1500), (2.0, -4.0, 2000), (0.0, -5.6, 600)] {
        sleep(Duration::from_millis(wait)).await;
        send(&mut a, position("stop", x, z)).await;
    }
    send(
        &mut a,
        json!({ "t": "zone", "zone": "hall", "x": 99, "z": 99, "heading": 1 }),
    )
    .await;
    let mine = collect(&mut a, Duration::from_millis(500)).await;
    let kinds: Vec<_> = mine.iter().map(|m| m["t"].as_str().unwrap()).collect();
    let zone_at = kinds
        .iter()
        .position(|k| *k == "zone")
        .expect("zone broadcast");
    let sync_at = kinds
        .iter()
        .position(|k| *k == "sync")
        .expect("sync for the switcher");
    assert!(zone_at < sync_at, "{kinds:?}");
    let zone = &mine[zone_at];
    assert_eq!(
        (zone["id"].as_str(), zone["zone"].as_str()),
        (Some(me.id.as_str()), Some("hall"))
    );
    assert_eq!(
        (zone["x"].as_f64(), zone["z"].as_f64()),
        (Some(0.0), Some(7.4))
    );
    // sync 只含殿內的其他玩家（hall 那位仍在庭院，所以是空的），不含自己、也不含庭院的人
    assert!(mine[sync_at]["m"].as_array().unwrap().is_empty());
    // 庭院的人收到 zone，之後看不到殿內的人移動
    let seen = collect(&mut yard, Duration::from_millis(200)).await;
    assert!(
        seen.iter()
            .any(|m| m["t"] == "zone" && m["id"] == me.id.as_str())
    );
    send(&mut a, position("move", 0.2, 7.4)).await;
    assert!(
        tuples_of(
            &collect(&mut yard, Duration::from_millis(400)).await,
            "moves",
            me.n
        )
        .is_empty(),
        "courtyard players do not see hall movement"
    );
}

// ---- T5：停止 ----

#[tokio::test]
async fn stopping_sends_a_single_moving_zero_within_one_second() {
    let server = server_with(options()).await;
    let mut b = connect(&server).await;
    hello(&mut b, None).await;
    let mut a = connect(&server).await;
    let me = hello(&mut a, None).await;
    for k in 1..=3 {
        send(&mut a, position("move", me.x + 0.05 * f64::from(k), me.z)).await;
        sleep(Duration::from_millis(100)).await;
    }
    let stopped_at = Instant::now();
    send(&mut a, position("stop", me.x + 0.15, me.z)).await;
    let mut zeros = Vec::new();
    let end = stopped_at + Duration::from_millis(1500);
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        let Some(m) = recv(&mut b, left).await else {
            break;
        };
        for (_, _, moving) in tuples_of(&[m], "moves", me.n) {
            if moving == 0 {
                zeros.push(stopped_at.elapsed());
            }
        }
    }
    assert_eq!(zeros.len(), 1);
    assert!(zeros[0] < Duration::from_secs(1), "{:?}", zeros[0]);
}

// ---- T6：斷線恢復 ----

#[tokio::test]
async fn resume_within_grace_keeps_identity_and_others_see_nothing() {
    let server = server_with(options()).await;
    let mut b = connect(&server).await;
    hello(&mut b, None).await;
    let mut a = connect(&server).await;
    let first = hello(&mut a, None).await;
    collect(&mut b, Duration::from_millis(200)).await; // 清掉 a 的 join
    drop(a); // 不經關閉握手的斷線
    sleep(Duration::from_millis(300)).await;
    let mut a2 = connect(&server).await;
    let second = hello(&mut a2, Some(&first.token)).await;
    assert_eq!(second.id, first.id);
    assert_eq!(second.room, first.room);
    assert_eq!((second.n, second.zone.as_str()), (first.n, "courtyard"));
    assert_eq!((second.x, second.z), (first.x, first.z));
    assert_ne!(second.token, first.token);
    assert_eq!(second.welcome["players"].as_array().unwrap().len(), 2);
    let seen = collect(&mut b, Duration::from_secs(1)).await;
    assert!(
        seen.iter().all(|m| m["t"] != "leave" && m["t"] != "join"),
        "{seen:?}"
    );
    // 恢復後舊 token 失效（第二次使用失敗，視為新玩家）；新 token 也只能用一次
    let mut c = connect(&server).await;
    let third = hello(&mut c, Some(&first.token)).await;
    assert_ne!(third.id, first.id);
    drop(a2);
    sleep(Duration::from_millis(200)).await;
    let mut d = connect(&server).await;
    assert_eq!(hello(&mut d, Some(&second.token)).await.id, first.id);
    let mut e = connect(&server).await;
    assert_ne!(hello(&mut e, Some(&second.token)).await.id, first.id);
}

#[tokio::test]
async fn resume_after_grace_is_a_new_player_and_leave_comes_at_expiry() {
    let server = server_with(ServerOptions {
        room: RoomConfig {
            resume_grace: Duration::from_millis(600),
            ..RoomConfig::new(50)
        },
        ..options()
    })
    .await;
    let mut b = connect(&server).await;
    hello(&mut b, None).await;
    let mut a = connect(&server).await;
    let first = hello(&mut a, None).await;
    collect(&mut b, Duration::from_millis(200)).await;
    let dropped_at = Instant::now();
    drop(a);
    // 保留期間（0.6 秒）沒有 leave
    assert!(collect(&mut b, Duration::from_millis(400)).await.is_empty());
    let leave = loop {
        let m = recv(&mut b, Duration::from_secs(3)).await.expect("leave");
        if m["t"] == "leave" {
            break m;
        }
    };
    assert_eq!(leave["id"], first.id.as_str());
    assert!(dropped_at.elapsed() >= Duration::from_millis(550));
    let mut a2 = connect(&server).await;
    let second = hello(&mut a2, Some(&first.token)).await;
    assert_ne!(second.id, first.id);
}

#[tokio::test]
async fn resume_replaces_the_old_connection_and_closes_it() {
    let server = server_with(options()).await;
    let mut b = connect(&server).await;
    hello(&mut b, None).await;
    let mut old = connect(&server).await;
    let first = hello(&mut old, None).await;
    collect(&mut b, Duration::from_millis(200)).await;
    let mut new = connect(&server).await;
    let second = hello(&mut new, Some(&first.token)).await;
    assert_eq!(second.id, first.id);
    assert_eq!(close_code(&mut old).await, 1013);
    // 舊連線的關閉不會讓玩家離開；其他人什麼都沒看到
    let seen = collect(&mut b, Duration::from_millis(800)).await;
    assert!(
        seen.iter().all(|m| m["t"] != "leave" && m["t"] != "join"),
        "{seen:?}"
    );
    send(&mut new, json!({ "t": "ping", "ts": 1 })).await;
    assert_eq!(
        recv(&mut new, Duration::from_secs(2)).await.unwrap()["t"],
        "pong"
    );
}
