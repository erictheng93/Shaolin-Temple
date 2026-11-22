use std::{future::IntoFuture, time::Duration};
use temple_server::{ServerOptions, app_with_options, auth::Auth, config::Config, shutdown};

/// `temple-server --healthcheck`：供容器 HEALTHCHECK 使用（distroless 映像沒有 curl／shell）。
/// 對本機 `PORT` 的 `/healthz` 發 HTTP/1.0 請求，回應狀態碼 200 才成功。
fn healthcheck() -> bool {
    use std::io::{Read, Write};
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let Ok(addr) = format!("127.0.0.1:{port}").parse() else {
        return false;
    };
    let timeout = Duration::from_secs(2);
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let mut head = String::new();
    stream
        .write_all(b"GET /healthz HTTP/1.0\r\n\r\n")
        .and_then(|()| stream.take(64).read_to_string(&mut head))
        .is_ok()
        && head.get(8..12) == Some(" 200")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        std::process::exit(if healthcheck() { 0 } else { 1 });
    }
    let config = Config::from_env()?;
    let room = config.room_config();
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(config.log_filter)
        .try_init()?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await?;
    // 只記錄啟用了哪些提供者；不印 client secret 與 SESSION_SECRET。
    let providers: Vec<&str> = config
        .auth
        .iter()
        .flat_map(|a| a.providers.iter().map(|p| p.kind.as_str()))
        .collect();
    let auth = config
        .auth
        .map(Auth::new)
        .transpose()?
        .map(std::sync::Arc::new);
    tracing::info!(port = config.port, room_capacity = config.room_capacity, tick_hz = config.tick_hz, resume_grace_seconds = config.resume_grace_seconds, vehicle_session = ?config.session_clock, origins = ?config.allowed_origins, sessions = auth.is_some(), login_providers = ?providers, "server started");
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let options = ServerOptions {
        room,
        metrics_token: config.metrics_token,
        auth,
        ..ServerOptions::new(config.allowed_origins)
    };
    let server = axum::serve(listener, app_with_options(options))
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => result?,
        result = shutdown::signal() => {
            result?;
            tracing::info!("shutdown started");
            let _ = stop.send(());
            if tokio::time::timeout(Duration::from_secs(4), &mut server).await.is_err() {
                tracing::warn!("shutdown drain deadline reached");
            }
        }
    }
    tracing::info!("server stopped");
    Ok(())
}
