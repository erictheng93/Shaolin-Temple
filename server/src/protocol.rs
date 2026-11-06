use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
pub const PROTOCOL_VERSION: f64 = 1.0;
/// 客戶端字串欄位上限（UTF-8 bytes）。超過時整則視為無效訊息。
/// reqId 會被快取做去重（T4），沒有上限時每條連線最壞可佔約 1 MB。
pub const MAX_REQ_ID_BYTES: usize = 128;
pub const MAX_RESUME_TOKEN_BYTES: usize = 128;
pub const MAX_ACTION_ID_BYTES: usize = 32;
pub const MAX_ZONE_BYTES: usize = 32;
/// 名稱原始字串上限；清理後仍只保留 16 個字元。
pub const MAX_RAW_NAME_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    Hello {
        v: f64,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume_token: Option<String>,
    },
    Move {
        x: f64,
        z: f64,
        heading: f64,
        seq: f64,
    },
    Stop {
        x: f64,
        z: f64,
        heading: f64,
        seq: f64,
    },
    Action {
        req_id: String,
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Map<String, Value>>,
    },
    Zone {
        zone: String,
        x: f64,
        z: f64,
        heading: f64,
    },
    Ping {
        ts: f64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerAction {
    pub id: String,
    pub started_at: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    pub id: String,
    pub name: String,
    pub x: f64,
    pub z: f64,
    pub heading: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<PlayerAction>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
#[derive(Copy)]
pub enum Moving {
    Stopped,
    Moving,
}
impl TryFrom<u8> for Moving {
    type Error = &'static str;
    fn try_from(v: u8) -> Result<Self, Self::Error> {
        match v {
            0 => Ok(Self::Stopped),
            1 => Ok(Self::Moving),
            _ => Err("moving must be 0 or 1"),
        }
    }
}
impl From<Moving> for u8 {
    fn from(v: Moving) -> Self {
        match v {
            Moving::Stopped => 0,
            Moving::Moving => 1,
        }
    }
}
pub type MoveTuple = (String, f64, f64, f64, Moving);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    Welcome {
        self_id: String,
        room: String,
        resume_token: String,
        server_time: f64,
        players: Vec<PlayerSnapshot>,
    },
    Join {
        player: PlayerSnapshot,
    },
    Leave {
        id: String,
    },
    Move {
        id: String,
        x: f64,
        z: f64,
        heading: f64,
        moving: bool,
    },
    Moves {
        m: Vec<MoveTuple>,
    },
    Action {
        player_id: String,
        id: String,
        started_at: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Map<String, Value>>,
    },
    Ack {
        req_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Zone {
        id: String,
        zone: String,
        x: f64,
        z: f64,
        heading: f64,
    },
    Pong {
        ts: f64,
        server_time: f64,
    },
    Error {
        code: String,
        message: String,
    },
}

impl ClientMessage {
    /// 字串欄位是否在長度上限內（識別字不可為空）。
    pub fn within_limits(&self) -> bool {
        let id = |v: &str, max: usize| !v.is_empty() && v.len() <= max;
        match self {
            Self::Hello {
                name, resume_token, ..
            } => {
                name.len() <= MAX_RAW_NAME_BYTES
                    && resume_token
                        .as_deref()
                        .is_none_or(|t| id(t, MAX_RESUME_TOKEN_BYTES))
            }
            Self::Action {
                req_id, id: action, ..
            } => id(req_id, MAX_REQ_ID_BYTES) && id(action, MAX_ACTION_ID_BYTES),
            Self::Zone { zone, .. } => id(zone, MAX_ZONE_BYTES),
            Self::Move { .. } | Self::Stop { .. } | Self::Ping { .. } => true,
        }
    }
}

pub fn clean_name(name: &str) -> String {
    let filtered: String = name.chars().filter(|c| !c.is_control()).collect();
    let name: String = filtered.trim().chars().take(16).collect();
    if name.is_empty() {
        "訪客".into()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_names() {
        for (input, expected) in [
            ("　小明　", "小明"),
            ("\n a\nb\t", "ab"),
            ("　\n", "訪客"),
            ("😀😀", "😀😀"),
            ("12345678901234567", "1234567890123456"),
        ] {
            assert_eq!(clean_name(input), expected);
        }
        assert_eq!(clean_name(&"😀".repeat(17)).chars().count(), 16);
    }

    #[test]
    fn string_limits() {
        let parse = |raw: String| serde_json::from_str::<ClientMessage>(&raw).unwrap();
        let action = |req: usize, id: usize| {
            parse(format!(
                r#"{{"t":"action","reqId":"{}","id":"{}"}}"#,
                "r".repeat(req),
                "a".repeat(id)
            ))
        };
        assert!(action(MAX_REQ_ID_BYTES, MAX_ACTION_ID_BYTES).within_limits());
        assert!(!action(MAX_REQ_ID_BYTES + 1, 3).within_limits());
        assert!(!action(15_000, 3).within_limits());
        assert!(!action(8, MAX_ACTION_ID_BYTES + 1).within_limits());
        assert!(!action(0, 3).within_limits());
        let zone = |z: &str| {
            parse(format!(
                r#"{{"t":"zone","zone":"{z}","x":0,"z":0,"heading":0}}"#
            ))
        };
        assert!(zone("hall").within_limits());
        assert!(!zone(&"h".repeat(MAX_ZONE_BYTES + 1)).within_limits());
        assert!(!zone("").within_limits());
        let hello = |name: usize, token: Option<usize>| {
            let token = token
                .map(|n| format!(r#","resumeToken":"{}""#, "t".repeat(n)))
                .unwrap_or_default();
            parse(format!(
                r#"{{"t":"hello","v":1,"name":"{}"{token}}}"#,
                "n".repeat(name)
            ))
        };
        assert!(hello(16, Some(MAX_RESUME_TOKEN_BYTES)).within_limits());
        assert!(!hello(16, Some(MAX_RESUME_TOKEN_BYTES + 1)).within_limits());
        assert!(!hello(MAX_RAW_NAME_BYTES + 1, None).within_limits());
    }
}
