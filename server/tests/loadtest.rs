//! 負載工具的 smoke 測試：對本機伺服器跑幾秒，確認工具能連線、送出與統計，且伺服器沒有關閉任何連線。

use temple_server::{ServerOptions, app_with_options, room::SessionClock};

#[tokio::test]
async fn loadtest_smoke_against_local_server() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        // 與正式壓測相同（VEHICLE_SESSION=always）：司機領車不受真實時間的廟會時段影響。
        let mut options = ServerOptions::new(vec!["http://localhost:5173".into()]);
        options.room.session_clock = SessionClock::AlwaysOpen;
        axum::serve(listener, app_with_options(options))
            .await
            .unwrap();
    });
    let url = format!("ws://{addr}/ws");
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(env!("CARGO_BIN_EXE_loadtest"))
            .args([
                "--url",
                &url,
                "--connections",
                "6",
                "--drivers",
                "2",
                "--moving-ratio",
                "0.5",
                "--seconds",
                "3",
                "--ramp-ms",
                "5",
                "--settle-ms",
                "4500",
            ])
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    task.abort();
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let last = stdout.lines().last().unwrap();
    let result: serde_json::Value = serde_json::from_str(last).unwrap();
    assert_eq!(result["connected"], 6);
    assert_eq!(result["drivers"], 2);
    assert_eq!(result["moving_players"], 3);
    assert_eq!(result["connect_failed"], 0);
    assert_eq!(result["closed_by_server"], 0);
    assert_eq!(result["session_closed"], 0);
    assert!(result["recv_bytes_per_conn_s"].as_f64().unwrap() > 100.0);
    // moves 與 cars 是二進位幀，負載工具能逐則解碼，且歸類在 moves 與 cars 而不是 other。
    assert_eq!(result["invalid_frames"], 0);
    assert!(
        result["recv_by_kind"]["moves"]["bytes_per_conn_s"]
            .as_f64()
            .unwrap()
            > 50.0
    );
    assert!(
        result["recv_by_kind"]["cars"]["bytes_per_conn_s"]
            .as_f64()
            .unwrap()
            > 0.0
    );
    assert!(result["recv_by_kind"].get("other").is_none(), "{result}");
    let ws_bytes = result["recv_ws_bytes_per_conn_s"].as_f64().unwrap();
    assert!(ws_bytes > result["recv_bytes_per_conn_s"].as_f64().unwrap());
    assert!(result["sent_bytes_per_conn_s"].as_f64().unwrap() > 50.0);
    assert!(result["moves_interval_ms"]["samples"].as_u64().unwrap() > 20);
    let p50 = result["moves_interval_ms"]["p50"].as_f64().unwrap();
    assert!((50.0..200.0).contains(&p50), "p50 = {p50}");
    assert!(result["cars_interval_ms"]["samples"].as_u64().unwrap() > 20);
    let cars_p50 = result["cars_interval_ms"]["p50"].as_f64().unwrap();
    assert!((20.0..100.0).contains(&cars_p50), "cars_p50 = {cars_p50}");
}
