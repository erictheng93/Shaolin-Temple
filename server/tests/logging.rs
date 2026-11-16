//! 日誌不可含授權碼、state、session 權杖或 secret（稽核後修正：TraceLayer 的 span 只記 method 與 path）。
//! 獨立成一個測試檔（一個行程只有這個測試），才能裝全域的 DEBUG subscriber 收下伺服器所有 task 的日誌。

use std::sync::{Arc, Mutex};
use temple_server::{
    ServerOptions, app_with_options,
    auth::{Auth, AuthConfig, ProviderConfig, ProviderEndpoints, ProviderKind},
};

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn debug_logs_never_contain_the_query_string_or_secrets() {
    let capture = Capture::default();
    let writer = capture.clone();
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .init();

    // token endpoint 指向沒有人在聽的埠：換權杖失敗，走 `login failed` 的日誌路徑。
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_url = format!("http://{}/token", dead.local_addr().unwrap());
    drop(dead);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let auth = Auth::new(AuthConfig {
        session_secret: b"test-session-secret-test-session-secret".to_vec(),
        public_url: Some(base.clone()),
        providers: vec![ProviderConfig {
            kind: ProviderKind::Google,
            client_id: "client-id".into(),
            client_secret: "client-secret-value".into(),
            endpoints: ProviderEndpoints {
                authorize: "https://google.example/authorize".into(),
                token: dead_url,
                issuers: vec!["https://issuer.example".into()],
            },
        }],
    })
    .unwrap();
    let options = ServerOptions {
        auth: Some(Arc::new(auth)),
        ..ServerOptions::new(vec!["http://localhost:5173".into()])
    };
    let task = tokio::spawn(async move {
        axum::serve(listener, app_with_options(options))
            .await
            .unwrap()
    });
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let start = http
        .get(format!(
            "{base}/auth/google/start?origin=http://localhost:5173"
        ))
        .send()
        .await
        .unwrap();
    let location = start.headers()["location"].to_str().unwrap().to_owned();
    let cookie = start.headers()["set-cookie"].to_str().unwrap();
    let cookie = cookie.split(';').next().unwrap().to_owned();
    let params: std::collections::HashMap<String, String> = reqwest::Url::parse(&location)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    let state = &params["state"];
    let response = http
        .get(format!(
            "{base}/auth/google/callback?code=secret-code-123&state={state}"
        ))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()["location"],
        "http://localhost:5173/#auth_error=failed"
    );
    // state 不合法的 400 路徑
    http.get(format!(
        "{base}/auth/google/callback?code=other-code-456&state=garbage"
    ))
    .send()
    .await
    .unwrap();
    task.abort();

    let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    let cookie_value = cookie.split_once('=').unwrap().1;
    for secret in [
        "secret-code-123",
        "other-code-456",
        state.as_str(),
        params["nonce"].as_str(),
        cookie_value,
        "client-secret-value",
        "test-session-secret",
        "code=",
        "state=",
    ] {
        assert!(!logs.contains(secret), "{secret} leaked into logs:\n{logs}");
    }
    assert!(
        logs.contains("path=/auth/google/callback"),
        "the path is logged: {logs}"
    );
    assert!(logs.contains("login failed"), "{logs}");
}
