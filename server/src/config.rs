use crate::room::MAX_ROOM_CAPACITY;
use tracing_subscriber::EnvFilter;

pub struct Config {
    pub port: u16,
    pub allowed_origins: Vec<String>,
    pub room_capacity: usize,
    pub log_filter: EnvFilter,
}

impl Config {
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
            log_filter,
        })
    }
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
        for (key, value) in [
            ("PORT", "abc"),
            ("PORT", "0"),
            ("ROOM_CAPACITY", "501"),
            ("ROOM_CAPACITY", "0"),
            ("ALLOWED_ORIGINS", "*"),
            ("ALLOWED_ORIGINS", "https://example.com/path"),
            ("RUST_LOG", "[broken"),
        ] {
            assert!(
                Config::parse(|k| Ok((k == key).then(|| value.into()))).is_err(),
                "{key}={value}"
            );
        }
        // 上限放寬到 MAX_ROOM_CAPACITY，預設仍為 50
        let config = Config::parse(|k| Ok((k == "ROOM_CAPACITY").then(|| "500".into()))).unwrap();
        assert_eq!(config.room_capacity, 500);
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
