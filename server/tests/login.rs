//! 協定版本 4：登入（對本機的假提供者跑完整 OIDC 流程）、`hello.session`、`welcome.auth` 與改名。
//! 假提供者實作 token endpoint：檢查 PKCE（S256）、client 認證與 redirect_uri，回傳可設定內容的 ID token。

use axum::{
    Form, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use temple_server::{
    ServerOptions, app_with_options,
    auth::{
        Auth, AuthConfig, ProviderConfig, ProviderEndpoints, ProviderKind, SESSION_TTL_SECS,
        Signer, now_secs,
    },
    protocol::PROTOCOL_VERSION,
};
use tokio::time::{Duration, Instant, sleep, timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const ORIGIN: &str = "http://localhost:5173";
const SECRET: &[u8] = b"test-session-secret-test-session-secret";
const ISSUER: &str = "https://fake-issuer.example";

// ---- 假提供者 ----

/// 下一次換權杖時回傳的 ID token 內容；`nonce` 為 `None` 時沿用授權請求帶的 nonce。
#[derive(Clone)]
struct Plan {
    iss: String,
    aud: Value,
    exp: i64,
    nonce: Option<String>,
    sub: String,
    status: StatusCode,
}
impl Plan {
    fn good(sub: &str) -> Self {
        Self {
            iss: ISSUER.into(),
            aud: json!("client-id"),
            exp: now_secs() as i64 + 300,
            nonce: None,
            sub: sub.into(),
            status: StatusCode::OK,
        }
    }
}
#[derive(Default)]
struct Fake {
    /// 授權請求中的 code_challenge 與 nonce（測試從 302 的網址讀出後填入，以 code 對照）。
    pending: HashMap<String, (String, String)>,
    plan: Option<Plan>,
    /// 最近一次 token 請求的 form（檢查 client 認證與 redirect_uri）。
    last_form: Option<HashMap<String, String>>,
    /// 收到的 token 請求數與每次回應前的延遲（測試併發上限用）。
    requests: usize,
    delay: Duration,
    /// 同時進行中的 token 請求數與它的最大值。
    in_flight: usize,
    max_in_flight: usize,
}
type FakeState = Arc<Mutex<Fake>>;

async fn token_endpoint(
    State(fake): State<FakeState>,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let delay = {
        let mut fake = fake.lock().unwrap();
        fake.requests += 1;
        fake.in_flight += 1;
        fake.max_in_flight = fake.max_in_flight.max(fake.in_flight);
        fake.delay
    };
    sleep(delay).await;
    let mut fake = fake.lock().unwrap();
    fake.in_flight -= 1;
    fake.last_form = Some(form.clone());
    let Some((challenge, nonce)) = form.get("code").and_then(|c| fake.pending.remove(c)) else {
        return (StatusCode::BAD_REQUEST, r#"{"error":"invalid_grant"}"#).into_response();
    };
    let verifier = form.get("code_verifier").cloned().unwrap_or_default();
    if B64.encode(Sha256::digest(verifier.as_bytes())) != challenge
        || form.get("grant_type").map(String::as_str) != Some("authorization_code")
    {
        return (StatusCode::BAD_REQUEST, r#"{"error":"invalid_grant"}"#).into_response();
    }
    let plan = fake.plan.clone().unwrap_or_else(|| Plan::good("sub-1"));
    if plan.status != StatusCode::OK {
        return (plan.status, "{}").into_response();
    }
    let claims = json!({
        "iss": plan.iss, "aud": plan.aud, "exp": plan.exp, "iat": now_secs(),
        "sub": plan.sub, "nonce": plan.nonce.unwrap_or(nonce),
    });
    let id_token = format!(
        "{}.{}.{}",
        B64.encode(br#"{"alg":"HS256","typ":"JWT"}"#),
        B64.encode(claims.to_string()),
        B64.encode(b"not-checked")
    );
    axum::Json(json!({ "access_token": "at", "token_type": "Bearer", "id_token": id_token }))
        .into_response()
}

struct Running {
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn serve(listener: tokio::net::TcpListener, router: Router) -> Running {
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Running { base, task }
}

struct World {
    server: Running,
    _provider: Running,
    fake: FakeState,
    http: reqwest::Client,
}

/// 啟動假提供者與遊戲伺服器。`kinds` 是要啟用的提供者。
async fn world(kinds: &[ProviderKind]) -> World {
    world_with(kinds, None).await
}
async fn world_with(kinds: &[ProviderKind], client_ip_header: Option<&str>) -> World {
    let fake = FakeState::default();
    let provider = serve(
        tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(),
        Router::new()
            .route("/token", post(token_endpoint))
            .with_state(fake.clone()),
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public_url = format!("http://{}", listener.local_addr().unwrap());
    let providers = kinds
        .iter()
        .map(|&kind| ProviderConfig {
            kind,
            client_id: "client-id".into(),
            client_secret: "client-secret".into(),
            endpoints: ProviderEndpoints {
                authorize: format!("https://{}.example/authorize", kind.as_str()),
                token: format!("{}/token", provider.base),
                issuers: vec![ISSUER.into()],
            },
        })
        .collect();
    let auth = Auth::new(AuthConfig {
        session_secret: SECRET.to_vec(),
        public_url: Some(public_url),
        providers,
        client_ip_header: client_ip_header
            .map(|h| axum::http::HeaderName::from_bytes(h.as_bytes()).unwrap()),
    })
    .unwrap();
    let options = ServerOptions {
        auth: Some(Arc::new(auth)),
        ..ServerOptions::new(vec![ORIGIN.into(), "https://game.example".into()])
    };
    let server = serve(listener, app_with_options(options)).await;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    World {
        server,
        _provider: provider,
        fake,
        http,
    }
}

fn header(response: &reqwest::Response, name: &str) -> String {
    response
        .headers()
        .get(name)
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default()
}
fn query(url: &str) -> HashMap<String, String> {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

/// `start` 的結果：授權頁網址的參數與要帶回 callback 的 cookie。
struct Started {
    params: HashMap<String, String>,
    cookie: String,
}
impl World {
    async fn get(&self, path: &str, cookie: Option<&str>) -> reqwest::Response {
        let mut request = self.http.get(format!("{}{path}", self.server.base));
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        request.send().await.unwrap()
    }
    async fn start(&self, provider: &str) -> Started {
        let response = self
            .get(&format!("/auth/{provider}/start?origin={ORIGIN}"), None)
            .await;
        assert_eq!(response.status(), 302);
        assert_eq!(header(&response, "cache-control"), "no-store");
        assert_eq!(header(&response, "referrer-policy"), "no-referrer");
        let set_cookie = header(&response, "set-cookie");
        for attr in ["HttpOnly", "SameSite=Lax", "Path=/auth", "Max-Age=600"] {
            assert!(set_cookie.contains(attr), "{set_cookie}");
        }
        assert!(!set_cookie.contains("Secure"), "http public url: no Secure");
        let location = header(&response, "location");
        assert!(
            location.starts_with(&format!("https://{provider}.example/authorize?")),
            "{location}"
        );
        Started {
            params: query(&location),
            cookie: set_cookie.split(';').next().unwrap().to_owned(),
        }
    }
    /// 模擬使用者在提供者頁面同意：記下 challenge／nonce 並發給一個 code。
    fn approve(&self, started: &Started, code: &str) {
        self.fake.lock().unwrap().pending.insert(
            code.into(),
            (
                started.params["code_challenge"].clone(),
                started.params["nonce"].clone(),
            ),
        );
    }
    async fn callback(
        &self,
        provider: &str,
        params: &str,
        cookie: Option<&str>,
    ) -> reqwest::Response {
        self.get(&format!("/auth/{provider}/callback?{params}"), cookie)
            .await
    }
    /// 完整流程，回傳 callback 302 的 Location。
    async fn login(&self, provider: &str, plan: Plan) -> String {
        let started = self.start(provider).await;
        self.fake.lock().unwrap().plan = Some(plan);
        self.approve(&started, "the-code");
        let state = &started.params["state"];
        let response = self
            .callback(
                provider,
                &format!("code=the-code&state={state}"),
                Some(&started.cookie),
            )
            .await;
        assert_eq!(response.status(), 302);
        assert_eq!(header(&response, "cache-control"), "no-store");
        assert_eq!(header(&response, "referrer-policy"), "no-referrer");
        assert!(
            header(&response, "set-cookie").contains("Max-Age=0"),
            "flow cookie cleared"
        );
        header(&response, "location")
    }
    fn ws_url(&self) -> String {
        format!("{}/ws", self.server.base.replace("http://", "ws://"))
    }
}

fn session_of(location: &str) -> String {
    let prefix = format!("{ORIGIN}/#session=");
    let rest = location
        .strip_prefix(&prefix)
        .unwrap_or_else(|| panic!("{location}"));
    let (session, provider) = rest.split_once("&provider=").unwrap();
    assert!(["google", "line"].contains(&provider));
    session.to_owned()
}

// ---- WebSocket 輔助 ----

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn connect(url: &str) -> Ws {
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", ORIGIN.parse().unwrap());
    connect_async(request).await.unwrap().0
}
async fn send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
/// 下一則 JSON 訊息（略過二進位幀）；`wait` 內沒有則 `None`。
async fn recv(ws: &mut Ws, wait: Duration) -> Option<Value> {
    let end = Instant::now() + wait;
    loop {
        let left = end.checked_duration_since(Instant::now())?;
        match timeout(left, ws.next()).await {
            Ok(Some(Ok(Message::Text(raw)))) => return serde_json::from_str(&raw).ok(),
            Ok(Some(Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => return None,
        }
    }
}
async fn recv_kind(ws: &mut Ws, kind: &str) -> Value {
    loop {
        let message = recv(ws, Duration::from_secs(5)).await.expect(kind);
        if message["t"] == kind {
            return message;
        }
    }
}
/// `span` 內收到的所有 `name` 訊息：(id, name)。
async fn names(ws: &mut Ws, span: Duration) -> Vec<(String, String)> {
    let end = Instant::now() + span;
    let mut out = Vec::new();
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match recv(ws, left).await {
            Some(m) if m["t"] == "name" => out.push((
                m["id"].as_str().unwrap().into(),
                m["name"].as_str().unwrap().into(),
            )),
            Some(_) => {}
            None => break,
        }
    }
    out
}
async fn hello(ws: &mut Ws, extra: Value) -> Value {
    let mut message = json!({ "t": "hello", "v": PROTOCOL_VERSION, "name": "測試" });
    for (k, v) in extra.as_object().unwrap() {
        message[k] = v.clone();
    }
    send(ws, message).await;
    recv_kind(ws, "welcome").await
}

// ---- 登入流程 ----

#[tokio::test]
async fn google_and_line_login_end_to_end_then_websocket_reports_the_provider() {
    let world = world(&[ProviderKind::Google, ProviderKind::Line]).await;
    let response = world
        .http
        .get(format!("{}/auth/providers", world.server.base))
        .header("origin", ORIGIN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(header(&response, "access-control-allow-origin"), ORIGIN);
    assert_eq!(header(&response, "vary"), "Origin");
    assert_eq!(header(&response, "cache-control"), "no-store");
    let body: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(body, json!({ "providers": ["google", "line"] }));

    for (provider, sub) in [("google", "110169484474386276334"), ("line", "U4af4980629")] {
        let started = world.start(provider).await;
        let p = &started.params;
        assert_eq!(p["response_type"], "code");
        assert_eq!(p["client_id"], "client-id");
        assert_eq!(p["scope"], "openid");
        assert_eq!(p["code_challenge_method"], "S256");
        assert_eq!(
            p["redirect_uri"],
            format!("{}/auth/{provider}/callback", world.server.base)
        );
        assert!(p["nonce"].len() >= 32 && p["state"].len() > 40);
        // PKCE verifier 不出現在網址或 state 裡（state 只有 origin 與隨機值）
        assert!(!started.cookie.contains(&p["state"]));

        let location = world.login(provider, Plan::good(sub)).await;
        let session = session_of(&location);
        assert!(location.ends_with(&format!("&provider={provider}")));
        assert!(session.len() <= 512);
        // token endpoint 收到的 client 認證與 redirect_uri
        let form = world.fake.lock().unwrap().last_form.clone().unwrap();
        assert_eq!(form["client_id"], "client-id");
        assert_eq!(form["client_secret"], "client-secret");
        assert_eq!(
            form["redirect_uri"],
            format!("{}/auth/{provider}/callback", world.server.base)
        );
        // 權杖內容正是這位使用者
        let identity = Signer::new(SECRET.to_vec())
            .verify_session(&session, now_secs())
            .unwrap();
        assert_eq!(
            (identity.provider.as_str(), identity.sub.as_str()),
            (provider, sub)
        );

        let mut ws = connect(&world.ws_url()).await;
        let welcome = hello(&mut ws, json!({ "session": session })).await;
        assert_eq!(welcome["auth"], provider);
    }
}

#[tokio::test]
async fn failed_logins_redirect_with_a_fixed_error_code() {
    let world = world(&[ProviderKind::Google]).await;
    let failed = format!("{ORIGIN}/#auth_error=failed");
    for (name, plan) in [
        (
            "nonce",
            Plan {
                nonce: Some("other-nonce".into()),
                ..Plan::good("s")
            },
        ),
        (
            "aud",
            Plan {
                aud: json!("someone-else"),
                ..Plan::good("s")
            },
        ),
        (
            "expired",
            Plan {
                exp: now_secs() as i64 - 10,
                ..Plan::good("s")
            },
        ),
        (
            "iss",
            Plan {
                iss: "https://evil.example".into(),
                ..Plan::good("s")
            },
        ),
        (
            "token endpoint error",
            Plan {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                ..Plan::good("s")
            },
        ),
    ] {
        assert_eq!(world.login("google", plan).await, failed, "{name}");
    }

    // state 與 cookie 不是同一次登入（login CSRF：攻擊者的 state 配受害者的 cookie）
    let first = world.start("google").await;
    let second = world.start("google").await;
    world.approve(&first, "c1");
    let response = world
        .callback(
            "google",
            &format!("code=c1&state={}", first.params["state"]),
            Some(&second.cookie),
        )
        .await;
    assert_eq!(header(&response, "location"), failed);
    // 沒有 cookie
    world.approve(&first, "c2");
    let response = world
        .callback(
            "google",
            &format!("code=c2&state={}", first.params["state"]),
            None,
        )
        .await;
    assert_eq!(header(&response, "location"), failed);
    // 使用者取消（Google 的 access_denied、LINE 文件的 ACCESS_DENIED），提供者的說明不出現在網址
    for error in ["access_denied", "ACCESS_DENIED"] {
        let started = world.start("google").await;
        let response = world
            .callback(
                "google",
                &format!(
                    "error={error}&error_description=secret+details&state={}",
                    started.params["state"]
                ),
                Some(&started.cookie),
            )
            .await;
        assert_eq!(response.status(), 302);
        assert_eq!(
            header(&response, "location"),
            format!("{ORIGIN}/#auth_error=cancelled")
        );
    }
    // 其他錯誤
    let started = world.start("google").await;
    let response = world
        .callback(
            "google",
            &format!("error=server_error&state={}", started.params["state"]),
            Some(&started.cookie),
        )
        .await;
    assert_eq!(header(&response, "location"), failed);
    // 錯誤的 code（假提供者不認得）
    let started = world.start("google").await;
    let response = world
        .callback(
            "google",
            &format!("code=unknown&state={}", started.params["state"]),
            Some(&started.cookie),
        )
        .await;
    assert_eq!(header(&response, "location"), failed);
}

#[tokio::test]
async fn bad_origins_states_and_unknown_providers_are_rejected() {
    let world = world(&[ProviderKind::Google]).await;
    for origin in [
        "https://evil.example",
        "http://localhost:5173.evil.example",
        "http://localhost:5174",
        "http://localhost:5173/path",
        "javascript:alert(1)",
        "",
    ] {
        let response = world
            .get(
                &format!("/auth/google/start?origin={}", urlencode(origin)),
                None,
            )
            .await;
        assert_eq!(response.status(), 400, "{origin}");
        assert!(header(&response, "location").is_empty());
    }
    let response = world.get("/auth/google/start", None).await;
    assert_eq!(response.status(), 400);
    // 正規化後相同的寫法可以（結尾斜線、大小寫）
    let response = world
        .get("/auth/google/start?origin=HTTP://LOCALHOST:5173/", None)
        .await;
    assert_eq!(response.status(), 302);
    // 未設定的提供者、未知的提供者
    for path in [
        "/auth/line/start?origin=http://localhost:5173",
        "/auth/github/start?origin=http://localhost:5173",
        "/auth/line/callback?code=a&state=b",
    ] {
        assert_eq!(world.get(path, None).await.status(), 404, "{path}");
    }
    // state 無法還原出合法 origin：400 純文字
    let started = world.start("google").await;
    let state = &started.params["state"];
    let mut tampered = state.clone().into_bytes();
    tampered[3] ^= 1;
    let tampered = String::from_utf8(tampered).unwrap();
    for params in [
        "code=a".to_string(),
        "code=a&state=garbage".to_string(),
        format!("code=a&state={tampered}"),
        format!("error=access_denied&state={tampered}"),
    ] {
        let response = world
            .callback("google", &params, Some(&started.cookie))
            .await;
        assert_eq!(response.status(), 400, "{params}");
        assert!(header(&response, "location").is_empty());
    }
    // 換到其他提供者的 callback 也不行（cookie 綁定提供者）——此處 line 未設定，直接 404
    assert_eq!(
        world
            .callback(
                "line",
                &format!("code=a&state={state}"),
                Some(&started.cookie)
            )
            .await
            .status(),
        404
    );
}

#[tokio::test]
async fn without_session_secret_auth_endpoints_are_off_and_everyone_is_a_guest() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = serve(
        listener,
        app_with_options(ServerOptions::new(vec![ORIGIN.into()])),
    )
    .await;
    let http = reqwest::Client::new();
    let response = http
        .get(format!("{}/auth/providers", server.base))
        .header("origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert!(header(&response, "access-control-allow-origin").is_empty());
    let body: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(body, json!({ "providers": [] }));
    let response = http
        .get(format!("{}/auth/google/start?origin={ORIGIN}", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    // 別台伺服器簽發的權杖：當訪客
    let token = Signer::new(SECRET.to_vec()).issue_session(ProviderKind::Google, "1", now_secs());
    let mut ws = connect(&format!("{}/ws", server.base.replace("http://", "ws://"))).await;
    assert_eq!(
        hello(&mut ws, json!({ "session": token })).await["auth"],
        "guest"
    );
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---- hello.session ----

#[tokio::test]
async fn invalid_or_expired_sessions_still_join_as_guests_and_resume_rechecks() {
    let world = world(&[ProviderKind::Line]).await;
    let signer = Signer::new(SECRET.to_vec());
    let expired = signer.issue_session(ProviderKind::Line, "U1", now_secs() - SESSION_TTL_SECS - 5);
    let foreign = Signer::new(b"another-secret-another-secret-another".to_vec()).issue_session(
        ProviderKind::Line,
        "U1",
        now_secs(),
    );
    let valid = signer.issue_session(ProviderKind::Line, "U1", now_secs());
    for (name, extra) in [
        ("no session", json!({})),
        ("empty", json!({ "session": "" })),
        ("garbage", json!({ "session": "not-a-token" })),
        ("expired", json!({ "session": expired })),
        ("other secret", json!({ "session": foreign })),
    ] {
        let mut ws = connect(&world.ws_url()).await;
        assert_eq!(hello(&mut ws, extra).await["auth"], "guest", "{name}");
    }
    // 超過 512 bytes：無效訊息（不進場），之後正常的 hello 仍可進場
    let mut ws = connect(&world.ws_url()).await;
    send(
        &mut ws,
        json!({ "t": "hello", "v": PROTOCOL_VERSION, "name": "a", "session": "s".repeat(513) }),
    )
    .await;
    assert!(recv(&mut ws, Duration::from_millis(300)).await.is_none());
    assert_eq!(
        hello(&mut ws, json!({ "session": valid })).await["auth"],
        "line"
    );

    // 恢復連線時重新驗證：登入的人帶過期權杖恢復 → guest；訪客帶有效權杖恢復 → line
    let mut a = connect(&world.ws_url()).await;
    let first = hello(&mut a, json!({ "session": valid })).await;
    assert_eq!(first["auth"], "line");
    drop(a);
    sleep(Duration::from_millis(200)).await;
    let mut a = connect(&world.ws_url()).await;
    let second = hello(
        &mut a,
        json!({ "resumeToken": first["resumeToken"], "session": expired }),
    )
    .await;
    assert_eq!(second["selfId"], first["selfId"]);
    assert_eq!(second["auth"], "guest");
    drop(a);
    sleep(Duration::from_millis(200)).await;
    let mut a = connect(&world.ws_url()).await;
    let third = hello(
        &mut a,
        json!({ "resumeToken": second["resumeToken"], "session": valid }),
    )
    .await;
    assert_eq!(third["selfId"], first["selfId"]);
    assert_eq!(third["auth"], "line");
}

// ---- rename ----

fn rename(name: &str) -> Value {
    json!({ "t": "rename", "name": name })
}

#[tokio::test]
async fn rename_reaches_everyone_including_other_zones_and_self_and_new_joiners_see_it() {
    let world = world(&[]).await;
    let mut a = connect(&world.ws_url()).await;
    let me = hello(&mut a, json!({})).await;
    let id = me["selfId"].as_str().unwrap().to_owned();
    let mut hall = connect(&world.ws_url()).await;
    hello(&mut hall, json!({})).await;
    let mut yard = connect(&world.ws_url()).await;
    hello(&mut yard, json!({})).await;
    // hall 走到殿門並進殿（同 gameplay.rs：繞過香爐分三段走）
    for (x, z, wait) in [(2.0, 5.0, 1500), (2.0, -4.0, 2000), (0.0, -5.6, 600)] {
        sleep(Duration::from_millis(wait)).await;
        send(
            &mut hall,
            json!({ "t": "stop", "x": x, "z": z, "heading": 0, "seq": 1 }),
        )
        .await;
    }
    send(
        &mut hall,
        json!({ "t": "zone", "zone": "hall", "x": 0, "z": 0, "heading": 0 }),
    )
    .await;
    let zone = recv_kind(&mut a, "zone").await;
    assert_eq!(zone["zone"], "hall");

    // 清理規則：控制字元去掉、前後空白去掉、截到 16 個字元
    send(
        &mut a,
        rename("\u{3000}新\n名字😀1234567890123456789\u{3000}"),
    )
    .await;
    let expected = vec![(id.clone(), "新名字😀123456789012".to_string())];
    for ws in [&mut a, &mut hall, &mut yard] {
        assert_eq!(names(ws, Duration::from_millis(400)).await, expected);
    }
    // 同名（清理後相同）不廣播
    sleep(Duration::from_millis(2100)).await;
    send(&mut a, rename(" 新名字😀123456789012 ")).await;
    assert!(
        names(&mut yard, Duration::from_millis(400))
            .await
            .is_empty()
    );
    // 空白改名為「訪客」
    sleep(Duration::from_millis(2100)).await;
    send(&mut a, rename("\u{3000} \t")).await;
    assert_eq!(
        names(&mut yard, Duration::from_millis(400)).await,
        vec![(id.clone(), "訪客".to_string())]
    );
    sleep(Duration::from_millis(2100)).await;
    send(&mut a, rename("小明")).await;
    assert_eq!(
        names(&mut yard, Duration::from_millis(400)).await,
        vec![(id.clone(), "小明".to_string())]
    );

    // 之後加入的人在 welcome 看到新名字；原本的人收到的 join 不影響
    let mut late = connect(&world.ws_url()).await;
    let welcome = hello(&mut late, json!({})).await;
    let snapshot = welcome["players"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id.as_str())
        .unwrap()
        .clone();
    assert_eq!(snapshot["name"], "小明");
}

#[tokio::test]
async fn rename_is_rate_limited_ignored_before_hello_and_over_limit_is_invalid() {
    let world = world(&[]).await;
    // hello 之前的 rename 是無效訊息：不改名、不回應；之後 hello 的名字照常
    let mut a = connect(&world.ws_url()).await;
    send(&mut a, rename("偷跑")).await;
    assert!(recv(&mut a, Duration::from_millis(200)).await.is_none());
    let me = hello(&mut a, json!({})).await;
    let id = me["selfId"].as_str().unwrap().to_owned();
    let mine = me["players"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id.as_str())
        .unwrap()
        .clone();
    assert_eq!(mine["name"], "測試");
    let mut b = connect(&world.ws_url()).await;
    hello(&mut b, json!({})).await;
    // 超過 256 bytes：無效訊息
    send(&mut a, rename(&"長".repeat(86))).await; // 258 bytes
    assert!(names(&mut b, Duration::from_millis(300)).await.is_empty());
    // 突發 2 次後被丟棄；連續送也不會斷線
    for i in 0..10 {
        send(&mut a, rename(&format!("名{i}"))).await;
    }
    let got = names(&mut b, Duration::from_millis(500)).await;
    assert_eq!(
        got,
        vec![
            (id.clone(), "名0".to_string()),
            (id.clone(), "名1".to_string())
        ]
    );
    // 約 2 秒後又可以改
    sleep(Duration::from_millis(2100)).await;
    send(&mut a, rename("再改")).await;
    assert_eq!(
        names(&mut b, Duration::from_millis(400)).await,
        vec![(id.clone(), "再改".to_string())]
    );
    send(&mut a, json!({ "t": "ping", "ts": 1 })).await;
    assert_eq!(recv_kind(&mut a, "pong").await["ts"].as_f64(), Some(1.0));
}

#[tokio::test]
async fn resuming_with_a_new_name_adopts_and_broadcasts_it() {
    let world = world(&[]).await;
    let mut b = connect(&world.ws_url()).await;
    hello(&mut b, json!({})).await;
    let mut a = connect(&world.ws_url()).await;
    let first = hello(&mut a, json!({})).await;
    let id = first["selfId"].as_str().unwrap().to_owned();
    drop(a);
    sleep(Duration::from_millis(200)).await;
    // 同名恢復：不廣播
    let mut a = connect(&world.ws_url()).await;
    let second = hello(&mut a, json!({ "resumeToken": first["resumeToken"] })).await;
    assert_eq!(second["selfId"], id.as_str());
    assert!(names(&mut b, Duration::from_millis(300)).await.is_empty());
    drop(a);
    sleep(Duration::from_millis(200)).await;
    // 前端改名後斷線重連：hello.name 是新名字 → 採用並廣播（含本人），welcome 快照也是新名字
    let mut a = connect(&world.ws_url()).await;
    send(&mut a, json!({ "t": "hello", "v": PROTOCOL_VERSION, "name": " 新名 ", "resumeToken": second["resumeToken"] })).await;
    let third = recv_kind(&mut a, "welcome").await;
    assert_eq!(third["selfId"], id.as_str());
    let mine = third["players"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id.as_str())
        .unwrap()
        .clone();
    assert_eq!(mine["name"], "新名");
    let expected = vec![(id.clone(), "新名".to_string())];
    assert_eq!(names(&mut a, Duration::from_millis(300)).await, expected);
    assert_eq!(names(&mut b, Duration::from_millis(300)).await, expected);
}

// ---- 稽核後修正 ----

#[tokio::test]
async fn a_login_flow_exchanges_only_once_and_replays_fail_without_the_provider() {
    let world = world(&[ProviderKind::Google]).await;
    world.fake.lock().unwrap().delay = Duration::from_millis(800);
    // 同一組合法的 cookie＋state 帶 20 個不同的 code 同時打 callback（issue #31 的重放）
    let started = world.start("google").await;
    let total = 20;
    for i in 0..total {
        world.approve(&started, &format!("c{i}"));
    }
    let state = started.params["state"].clone();
    let begin = Instant::now();
    let calls = (0..total).map(|i| {
        let params = format!("code=c{i}&state={state}");
        let cookie = started.cookie.clone();
        let world = &world;
        async move {
            let response = world.callback("google", &params, Some(&cookie)).await;
            (header(&response, "location"), begin.elapsed())
        }
    });
    let results = futures_util::future::join_all(calls).await;
    let failed = format!("{ORIGIN}/#auth_error=failed");
    let ok = results
        .iter()
        .filter(|(l, _)| l.contains("#session="))
        .count();
    let rejected: Vec<_> = results.iter().filter(|(l, _)| *l == failed).collect();
    assert_eq!((ok, rejected.len()), (1, total - 1));
    assert_eq!(
        world.fake.lock().unwrap().requests,
        1,
        "replays never reach the provider"
    );
    // 重放的不佔名額也不等待提供者（遠少於 800 ms 的延遲）
    assert!(
        rejected
            .iter()
            .all(|(_, t)| *t < Duration::from_millis(600)),
        "{rejected:?}"
    );
}

#[tokio::test]
async fn token_exchanges_are_capped_and_queued_briefly() {
    use temple_server::auth::{EXCHANGE_WAIT, MAX_CONCURRENT_EXCHANGES};
    let world = world(&[ProviderKind::Google]).await;
    // 20 個各自獨立的流程同時回來：同時進行的交換不超過上限，其餘排隊，在等待時間內都換得到。
    world.fake.lock().unwrap().delay = Duration::from_millis(500);
    let total = 20;
    let mut flows = Vec::new();
    for i in 0..total {
        let started = world.start("google").await;
        world.approve(&started, &format!("q{i}"));
        flows.push((
            format!("code=q{i}&state={}", started.params["state"]),
            started.cookie,
        ));
    }
    let calls = flows.iter().map(|(params, cookie)| async {
        let response = world.callback("google", params, Some(cookie)).await;
        header(&response, "location")
    });
    let results = futures_util::future::join_all(calls).await;
    assert!(
        results.iter().all(|l| l.contains("#session=")),
        "{results:?}"
    );
    let max = world.fake.lock().unwrap().max_in_flight;
    assert!(
        max <= MAX_CONCURRENT_EXCHANGES,
        "{max} concurrent token requests"
    );

    // 名額被慢的請求佔滿超過等待時間：多出來的那一個約在 EXCHANGE_WAIT 後失敗，不無限等。
    world.fake.lock().unwrap().delay = EXCHANGE_WAIT + Duration::from_secs(1);
    let mut flows = Vec::new();
    for i in 0..=MAX_CONCURRENT_EXCHANGES {
        let started = world.start("google").await;
        world.approve(&started, &format!("s{i}"));
        flows.push((
            format!("code=s{i}&state={}", started.params["state"]),
            started.cookie,
        ));
    }
    let begin = Instant::now();
    let calls = flows.iter().map(|(params, cookie)| async {
        let response = world.callback("google", params, Some(cookie)).await;
        (header(&response, "location"), begin.elapsed())
    });
    let results = futures_util::future::join_all(calls).await;
    let failed = format!("{ORIGIN}/#auth_error=failed");
    let rejected: Vec<_> = results.iter().filter(|(l, _)| *l == failed).collect();
    assert_eq!(rejected.len(), 1, "{results:?}");
    let waited = rejected[0].1;
    assert!(
        waited >= EXCHANGE_WAIT && waited < EXCHANGE_WAIT + Duration::from_millis(800),
        "{waited:?}"
    );

    // 名額釋放後又可以登入
    world.fake.lock().unwrap().delay = Duration::ZERO;
    let location = world.login("google", Plan::good("after")).await;
    assert!(location.contains("#session="), "{location}");
}

#[tokio::test]
async fn repeated_resumes_with_new_names_cannot_bypass_the_rename_limit() {
    let world = world(&[]).await;
    let mut b = connect(&world.ws_url()).await;
    hello(&mut b, json!({})).await;
    let mut a = connect(&world.ws_url()).await;
    let mut welcome = hello(&mut a, json!({})).await;
    let id = welcome["selfId"].as_str().unwrap().to_owned();
    let mut adopted = Vec::new();
    // 用腳本反覆「斷線→帶新名字恢復」：只有額度內的（突發 2 次）生效
    for i in 0..6 {
        drop(a);
        a = connect(&world.ws_url()).await;
        send(
            &mut a,
            json!({ "t": "hello", "v": PROTOCOL_VERSION, "name": format!("洗{i}"), "resumeToken": welcome["resumeToken"] }),
        )
        .await;
        welcome = recv_kind(&mut a, "welcome").await;
        assert_eq!(welcome["selfId"], id.as_str());
        let mine = welcome["players"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id.as_str())
            .unwrap()["name"]
            .as_str()
            .unwrap()
            .to_owned();
        adopted.push(mine);
    }
    // 額度用完後保留舊名，welcome 快照回的是舊名
    assert_eq!(adopted, ["洗0", "洗1", "洗1", "洗1", "洗1", "洗1"]);
    let seen = names(&mut b, Duration::from_millis(400)).await;
    assert_eq!(
        seen,
        vec![
            (id.clone(), "洗0".to_string()),
            (id.clone(), "洗1".to_string())
        ]
    );
    // rename 與恢復共用額度：此時 rename 也被擋
    send(&mut a, rename("再洗")).await;
    assert!(names(&mut b, Duration::from_millis(300)).await.is_empty());
}

#[tokio::test]
async fn auth_requests_are_rate_limited_per_client_ip_when_the_header_is_configured() {
    use temple_server::auth::AUTH_IP_BURST;
    let world = world_with(&[ProviderKind::Google], Some("x-real-ip")).await;
    let start = |ip: &'static str| {
        let request = world
            .http
            .get(format!(
                "{}/auth/google/start?origin={ORIGIN}",
                world.server.base
            ))
            .header("x-real-ip", ip);
        async move { request.send().await.unwrap().status() }
    };
    for _ in 0..AUTH_IP_BURST as usize {
        assert_eq!(start("198.51.100.1").await, 302);
    }
    assert_eq!(start("198.51.100.1").await, 429);
    // callback 同一份額度
    let callback = world
        .http
        .get(format!(
            "{}/auth/google/callback?code=x&state=y",
            world.server.base
        ))
        .header("x-real-ip", "198.51.100.1")
        .send()
        .await
        .unwrap();
    assert_eq!(callback.status(), 429);
    assert_eq!(start("198.51.100.2").await, 302, "other clients unaffected");

    // 沒設定 CLIENT_IP_HEADER：不限速（交給反向代理）
    let open = world_with(&[ProviderKind::Google], None).await;
    for _ in 0..AUTH_IP_BURST as usize + 5 {
        let status = open
            .get(&format!("/auth/google/start?origin={ORIGIN}"), None)
            .await
            .status();
        assert_eq!(status, 302);
    }
}
