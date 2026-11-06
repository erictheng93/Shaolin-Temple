use std::{future::IntoFuture, time::Duration};
use temple_server::{app_with_capacity, config::Config, shutdown};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = Config::from_env()?;
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(config.log_filter)
        .try_init()?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(port = config.port, room_capacity = config.room_capacity, origins = ?config.allowed_origins, "server started");
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = axum::serve(
        listener,
        app_with_capacity(config.allowed_origins, config.room_capacity),
    )
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
