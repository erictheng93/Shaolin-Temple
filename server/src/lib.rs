pub mod auth;
pub mod config;
pub mod connection;
pub mod metrics;
pub mod protocol;
pub mod rate_limit;
pub mod room;
pub mod shutdown;
pub mod vehicles;
pub mod world;

/// 握手後沒有任何輸入就關閉連線的時間。前端每 20 秒送心跳；但 Chrome 會把背景分頁的計時器
/// 節流到約每分鐘一次，所以取 90 秒，避免誤斷切到背景的玩家。
pub const DEFAULT_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Clone)]
pub struct AppState {
    pub origins: std::sync::Arc<Vec<String>>,
    pub lobby: room::Lobby,
    pub idle_timeout: std::time::Duration,
    pub rate_close_after: std::time::Duration,
    pub metrics: std::sync::Arc<metrics::Metrics>,
    /// 設定時 `GET /metrics` 須帶 `Authorization: Bearer <token>`；`None` 為開放。
    pub metrics_token: Option<std::sync::Arc<str>>,
    /// 登入（`SESSION_SECRET` 有設定時）；`None` 時 `/auth/*` 回 404、`/auth/providers` 回空清單、所有人都是訪客。
    pub auth: Option<std::sync::Arc<auth::Auth>>,
}

/// 組裝伺服器所需的選項；測試可縮短各種時間長度。
pub struct ServerOptions {
    pub allowed_origins: Vec<String>,
    pub room: room::RoomConfig,
    pub idle_timeout: std::time::Duration,
    /// 連續超出速率限制多久後關閉連線。
    pub rate_close_after: std::time::Duration,
    /// `METRICS_TOKEN`；`None` 表示 `/metrics` 不需授權。
    pub metrics_token: Option<String>,
    /// 登入元件；`None` 表示不支援登入（純訪客）。
    pub auth: Option<std::sync::Arc<auth::Auth>>,
}
impl ServerOptions {
    pub fn new(allowed_origins: Vec<String>) -> Self {
        Self {
            allowed_origins,
            room: room::RoomConfig::new(50),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            rate_close_after: rate_limit::DEFAULT_CLOSE_AFTER,
            metrics_token: None,
            auth: None,
        }
    }
}

pub fn app(allowed_origins: Vec<String>) -> axum::Router {
    app_with_options(ServerOptions::new(allowed_origins))
}
pub fn app_with_options(options: ServerOptions) -> axum::Router {
    let metrics = std::sync::Arc::new(metrics::Metrics::default());
    axum::Router::new()
        .route("/healthz", axum::routing::get(|| async { "ok" }))
        .route("/metrics", axum::routing::get(metrics::handler))
        .route("/ws", axum::routing::get(connection::upgrade))
        .route("/auth/providers", axum::routing::get(auth::providers))
        .route("/auth/{provider}/start", axum::routing::get(auth::start))
        .route(
            "/auth/{provider}/callback",
            axum::routing::get(auth::callback),
        )
        .with_state(AppState {
            origins: std::sync::Arc::new(options.allowed_origins),
            lobby: room::Lobby::new(options.room, metrics.clone()),
            idle_timeout: options.idle_timeout,
            rate_close_after: options.rate_close_after,
            metrics,
            metrics_token: options.metrics_token.map(Into::into),
            auth: options.auth,
        })
        // span 只記 method 與 path：預設的 span 在 DEBUG 等級記完整 URI，會把
        // `/auth/*/callback?code=…&state=…` 的授權碼與 state 寫進日誌。
        .layer(
            tower_http::trace::TraceLayer::new_for_http().make_span_with(
                |request: &axum::http::Request<axum::body::Body>| {
                    tracing::debug_span!(
                        "request",
                        method = %request.method(),
                        path = %request.uri().path(),
                    )
                },
            ),
        )
}
