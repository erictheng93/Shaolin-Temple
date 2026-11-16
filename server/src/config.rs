use crate::auth::{AuthConfig, MIN_SECRET_BYTES, ProviderConfig, ProviderEndpoints, ProviderKind};
use crate::room::{MAX_ROOM_CAPACITY, RoomConfig};
use std::time::Duration;
use tracing_subscriber::EnvFilter;

pub struct Config {
    pub port: u16,
    pub allowed_origins: Vec<String>,
    pub room_capacity: usize,
    /// 房間廣播 tick 頻率（`TICK_HZ`，1～60，預設 10）。
    pub tick_hz: u32,
    /// 斷線保留秒數（`RESUME_GRACE_SECONDS`，1～600，預設 30）。
    pub resume_grace_seconds: u64,
    /// `METRICS_TOKEN`：設定後 `/metrics` 須帶 Bearer 權杖；未設定（或空字串）為開放。
    pub metrics_token: Option<String>,
    /// 登入設定；`SESSION_SECRET` 沒設定時為 `None`（純訪客，與協定版本 3 之前相同）。
    pub auth: Option<AuthConfig>,
    pub log_filter: EnvFilter,
}

impl Config {
    pub fn room_config(&self) -> RoomConfig {
        RoomConfig {
            tick: Duration::from_micros(1_000_000 / u64::from(self.tick_hz)),
            resume_grace: Duration::from_secs(self.resume_grace_seconds),
            ..RoomConfig::new(self.room_capacity)
        }
    }

    pub fn from_env() -> Result<Self, String> {
        Self::parse(|key| match std::env::var(key) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(_) => Err(format!("{key} must be valid Unicode")),
        })
    }

    fn parse(get: impl Fn(&str) -> Result<Option<String>, String>) -> Result<Self, String> {
        let port = get("PORT")?
            .unwrap_or_else(|| "8080".into())
            .parse::<u16>()
            .map_err(|_| "PORT must be an integer in 1..=65535")?;
        if port == 0 {
            return Err("PORT must be in 1..=65535".into());
        }
        let room_capacity = get("ROOM_CAPACITY")?
            .unwrap_or_else(|| "50".into())
            .parse::<usize>()
            .map_err(|_| format!("ROOM_CAPACITY must be an integer in 1..={MAX_ROOM_CAPACITY}"))?;
        if !(1..=MAX_ROOM_CAPACITY).contains(&room_capacity) {
            return Err(format!("ROOM_CAPACITY must be in 1..={MAX_ROOM_CAPACITY}"));
        }
        let tick_hz = get("TICK_HZ")?
            .unwrap_or_else(|| "10".into())
            .parse::<u32>()
            .ok()
            .filter(|v| (1..=60).contains(v))
            .ok_or("TICK_HZ must be an integer in 1..=60")?;
        let resume_grace_seconds = get("RESUME_GRACE_SECONDS")?
            .unwrap_or_else(|| "30".into())
            .parse::<u64>()
            .ok()
            .filter(|v| (1..=600).contains(v))
            .ok_or("RESUME_GRACE_SECONDS must be an integer in 1..=600")?;
        let origins = get("ALLOWED_ORIGINS")?.unwrap_or_else(|| "http://localhost:5173".into());
        let allowed_origins = origins
            .split(',')
            .map(|v| normalize_origin(v.trim()))
            .collect::<Result<Vec<_>, _>>()?;
        let log_filter = EnvFilter::try_new(get("RUST_LOG")?.unwrap_or_else(|| "info".into()))
            .map_err(|e| format!("RUST_LOG: {e}"))?;
        Ok(Self {
            port,
            allowed_origins,
            room_capacity,
            tick_hz,
            resume_grace_seconds,
            metrics_token: get("METRICS_TOKEN")?.filter(|v| !v.is_empty()),
            auth: parse_auth(&get)?,
            log_filter,
        })
    }
}

/// 登入相關設定，全部選填（空字串視為未設定）：
/// - `SESSION_SECRET`：簽章 session 權杖與登入流程的金鑰，至少 32 bytes；設了但太短啟動失敗。
/// - `AUTH_PUBLIC_URL`：伺服器對外的 scheme＋主機，`redirect_uri` = `<AUTH_PUBLIC_URL>/auth/<provider>/callback`。
/// - `GOOGLE_CLIENT_ID`／`GOOGLE_CLIENT_SECRET`、`LINE_CHANNEL_ID`／`LINE_CHANNEL_SECRET`。
///
/// 提供者只設了 id 或 secret 其中一個、或設了提供者卻缺 `SESSION_SECRET`／`AUTH_PUBLIC_URL`，都啟動失敗並說明缺什麼。
fn parse_auth(
    get: &impl Fn(&str) -> Result<Option<String>, String>,
) -> Result<Option<AuthConfig>, String> {
    let get = |key: &str| get(key).map(|v| v.filter(|v| !v.is_empty()));
    let secret = get("SESSION_SECRET")?;
    if let Some(secret) = &secret
        && secret.len() < MIN_SECRET_BYTES
    {
        return Err(format!(
            "SESSION_SECRET must be at least {MIN_SECRET_BYTES} bytes (for example: openssl rand -base64 48)"
        ));
    }
    let public_url = get("AUTH_PUBLIC_URL")?
        .map(|v| {
            normalize_origin(v.trim()).map_err(|_| {
                "AUTH_PUBLIC_URL must be an HTTP(S) origin without path, query or credentials, e.g. https://api.example.com".to_string()
            })
        })
        .transpose()?;
    let mut providers = Vec::new();
    for (kind, id_key, secret_key, endpoints) in [
        (
            ProviderKind::Google,
            "GOOGLE_CLIENT_ID",
            "GOOGLE_CLIENT_SECRET",
            ProviderEndpoints::google(),
        ),
        (
            ProviderKind::Line,
            "LINE_CHANNEL_ID",
            "LINE_CHANNEL_SECRET",
            ProviderEndpoints::line(),
        ),
    ] {
        let (client_id, client_secret) = match (get(id_key)?, get(secret_key)?) {
            (None, None) => continue,
            (Some(id), Some(secret)) => (id, secret),
            (Some(_), None) => return Err(format!("{id_key} is set but {secret_key} is missing")),
            (None, Some(_)) => return Err(format!("{secret_key} is set but {id_key} is missing")),
        };
        let mut missing = Vec::new();
        if secret.is_none() {
            missing.push("SESSION_SECRET");
        }
        if public_url.is_none() {
            missing.push("AUTH_PUBLIC_URL");
        }
        if !missing.is_empty() {
            return Err(format!(
                "{id_key}/{secret_key} are set but {} missing (both are required to enable {} login)",
                missing.join(" and ") + if missing.len() > 1 { " are" } else { " is" },
                kind.as_str()
            ));
        }
        providers.push(ProviderConfig {
            kind,
            client_id,
            client_secret,
            endpoints,
        });
    }
    Ok(secret.map(|secret| AuthConfig {
        session_secret: secret.into_bytes(),
        public_url,
        providers,
    }))
}

/// 把設定的來源正規化成瀏覽器 `Origin` 標頭的格式：小寫的 scheme 與主機、省略預設埠、沒有結尾斜線。
/// 瀏覽器送出的 Origin 已是這種格式，比對時用字串相等即可；設定寫成 `https://Example.com:443/`
/// 這類常見寫法時不會讓所有連線都被拒絕。
pub fn normalize_origin(origin: &str) -> Result<String, String> {
    const ERR: &str =
        "ALLOWED_ORIGINS requires HTTP(S) origins without paths, queries or credentials";
    let uri = origin.parse::<axum::http::Uri>().map_err(|_| ERR)?;
    let scheme = uri.scheme_str().map(str::to_ascii_lowercase).ok_or(ERR)?;
    let authority = uri.authority().ok_or(ERR)?;
    if !matches!(scheme.as_str(), "http" | "https")
        || authority.as_str().contains('@')
        || uri.path_and_query().is_some_and(|v| v.as_str() != "/")
    {
        return Err(ERR.into());
    }
    let host = authority.host().to_ascii_lowercase();
    let default_port = if scheme == "https" { 443 } else { 80 };
    Ok(match authority.port_u16() {
        Some(port) if port != default_port => format!("{scheme}://{host}:{port}"),
        _ => format!("{scheme}://{host}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_invalid_settings() {
        let config = Config::parse(|_| Ok(None)).unwrap();
        assert_eq!(config.port, 8080);
        assert_eq!(config.room_capacity, 50);
        assert_eq!(config.tick_hz, 10);
        assert_eq!(config.resume_grace_seconds, 30);
        assert_eq!(config.metrics_token, None);
        let room = config.room_config();
        assert_eq!(room.tick, Duration::from_millis(100));
        assert_eq!(room.resume_grace, Duration::from_secs(30));
        assert_eq!(room.outbound_capacity, 64);
        for (key, value) in [
            ("PORT", "abc"),
            ("PORT", "0"),
            ("ROOM_CAPACITY", "51"),
            ("ROOM_CAPACITY", "0"),
            ("TICK_HZ", "0"),
            ("TICK_HZ", "61"),
            ("TICK_HZ", "fast"),
            ("RESUME_GRACE_SECONDS", "0"),
            ("RESUME_GRACE_SECONDS", "601"),
            ("ALLOWED_ORIGINS", "*"),
            ("ALLOWED_ORIGINS", "https://example.com/path"),
            ("RUST_LOG", "[broken"),
        ] {
            assert!(
                Config::parse(|k| Ok((k == key).then(|| value.into()))).is_err(),
                "{key}={value}"
            );
        }
        let config = Config::parse(|k| Ok((k == "ROOM_CAPACITY").then(|| "1".into()))).unwrap();
        assert_eq!(config.room_capacity, 1);
    }

    fn with(vars: &[(&str, &str)]) -> Result<Config, String> {
        let vars: Vec<(String, String)> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::parse(move |k| {
            Ok(vars
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone()))
        })
    }
    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn auth_is_optional_and_providers_need_every_setting() {
        assert!(Config::parse(|_| Ok(None)).unwrap().auth.is_none());
        assert!(with(&[("SESSION_SECRET", "")]).unwrap().auth.is_none());
        let only_secret = with(&[("SESSION_SECRET", SECRET)]).unwrap().auth.unwrap();
        assert!(only_secret.providers.is_empty());
        let err = with(&[("SESSION_SECRET", &SECRET[1..])]).err().unwrap();
        assert!(err.contains("SESSION_SECRET"), "{err}");
        let full = [
            ("SESSION_SECRET", SECRET),
            ("AUTH_PUBLIC_URL", "HTTPS://Api.Example.com/"),
            ("GOOGLE_CLIENT_ID", "gid"),
            ("GOOGLE_CLIENT_SECRET", "gsecret"),
            ("LINE_CHANNEL_ID", "lid"),
            ("LINE_CHANNEL_SECRET", "lsecret"),
        ];
        let auth = with(&full).unwrap().auth.unwrap();
        assert_eq!(auth.public_url.as_deref(), Some("https://api.example.com"));
        let kinds: Vec<_> = auth
            .providers
            .iter()
            .map(|p| (p.kind, p.client_id.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [(ProviderKind::Google, "gid"), (ProviderKind::Line, "lid")]
        );
        // 只設一半、或缺共用設定：啟動失敗，訊息指出缺的變數
        for (drop, expect) in [
            ("GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET is missing"),
            ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID is missing"),
            ("LINE_CHANNEL_SECRET", "LINE_CHANNEL_SECRET is missing"),
            ("SESSION_SECRET", "SESSION_SECRET is missing"),
            ("AUTH_PUBLIC_URL", "AUTH_PUBLIC_URL is missing"),
        ] {
            let vars: Vec<_> = full.iter().copied().filter(|(k, _)| *k != drop).collect();
            let err = with(&vars).err().unwrap_or_else(|| panic!("{drop}"));
            assert!(err.contains(expect), "{drop}: {err}");
        }
        let err = with(&[("GOOGLE_CLIENT_ID", "gid"), ("GOOGLE_CLIENT_SECRET", "s")])
            .err()
            .unwrap();
        assert!(
            err.contains("SESSION_SECRET and AUTH_PUBLIC_URL are missing"),
            "{err}"
        );
        let err = with(&[
            ("SESSION_SECRET", SECRET),
            ("AUTH_PUBLIC_URL", "https://a.example/path"),
        ])
        .err()
        .unwrap();
        assert!(err.contains("AUTH_PUBLIC_URL"), "{err}");
    }

    #[test]
    fn origins_are_normalized_like_browser_headers() {
        for (input, expected) in [
            ("http://localhost:5173/", "http://localhost:5173"),
            ("http://localhost:5173", "http://localhost:5173"),
            (
                "HTTPS://Temple.Example.com:443/",
                "https://temple.example.com",
            ),
            ("http://example.com:80", "http://example.com"),
            ("https://example.com:8443", "https://example.com:8443"),
        ] {
            assert_eq!(normalize_origin(input).unwrap(), expected, "{input}");
        }
        for bad in [
            "https://example.com/path",
            "https://example.com/?q=1",
            "https://user@example.com",
            "ftp://example.com",
            "example.com",
        ] {
            assert!(normalize_origin(bad).is_err(), "{bad}");
        }
        let config = Config::parse(|k| {
            Ok((k == "ALLOWED_ORIGINS")
                .then(|| "http://localhost:5173/, HTTPS://A.example ".into()))
        })
        .unwrap();
        assert_eq!(
            config.allowed_origins,
            ["http://localhost:5173", "https://a.example"]
        );
    }
}
