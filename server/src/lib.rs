pub mod config;
pub mod connection;
pub mod protocol;
pub mod rate_limit;
pub mod room;
pub mod shutdown;
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
}

/// 組裝伺服器所需的選項；測試可縮短各種時間長度。
pub struct ServerOptions {
    pub allowed_origins: Vec<String>,
    pub room: room::RoomConfig,
    pub idle_timeout: std::time::Duration,
    /// 連續超出速率限制多久後關閉連線。
    pub rate_close_after: std::time::Duration,
}
impl ServerOptions {
    pub fn new(allowed_origins: Vec<String>) -> Self {
        Self {
            allowed_origins,
            room: room::RoomConfig::new(50),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            rate_close_after: rate_limit::DEFAULT_CLOSE_AFTER,
        }
    }
}

pub fn app(allowed_origins: Vec<String>) -> axum::Router {
    app_with_options(ServerOptions::new(allowed_origins))
}
pub fn app_with_options(options: ServerOptions) -> axum::Router {
    axum::Router::new()
        .route("/healthz", axum::routing::get(|| async { "ok" }))
        .route("/ws", axum::routing::get(connection::upgrade))
        .with_state(AppState {
            origins: std::sync::Arc::new(options.allowed_origins),
            lobby: room::Lobby::new(options.room),
            idle_timeout: options.idle_timeout,
            rate_close_after: options.rate_close_after,
        })
        .layer(tower_http::trace::TraceLayer::new_for_http())
}
