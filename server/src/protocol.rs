use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::world;

pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
/// 協定版本。2（T8）：`moves`／`sync` 改為二進位幀（見 [`encode_batch`]）；
/// 3：下行的 `action` 也改為二進位幀（見 [`encode_action`]）。其餘訊息與所有上行仍是 JSON。
/// `hello.v` 不同時回 `unsupported_version` 並關閉，前端據此提示重新整理。
pub const PROTOCOL_VERSION: f64 = 3.0;
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
    /// 房內短編號（0～[`MAX_SHORT_ID`]），`moves`／`sync` 以它代替字串 id。
    pub n: u8,
    pub name: String,
    pub x: f64,
    pub z: f64,
    pub heading: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<PlayerAction>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
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
/// `[n, x, z, heading, moving]`，`n` 為房內短編號。
pub type MoveTuple = (u8, f64, f64, f64, Moving);
/// 單則 `moves`／`sync` 最多筆數，與前端 `MAX_MOVES_PER_MESSAGE` 相同。
pub const MAX_MOVES_PER_MESSAGE: usize = 200;

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
    /// 批次位置。只以二進位幀送出（[`encode_batch`]）；`serde(skip)` 讓誤以 JSON 序列化時直接失敗。
    #[serde(skip)]
    Moves {
        m: Vec<MoveTuple>,
    },
    /// 整批位置校正：客戶端直接套用，不做插值。同樣只以二進位幀送出。
    #[serde(skip)]
    Sync {
        m: Vec<MoveTuple>,
    },
    /// 其他玩家開始一個動作。只以二進位幀送出（[`encode_action`]）：`n` 是執行者的房內短編號，
    /// `code` 是動作在 [`world::ACTIONS`] 中的索引（[`world::action_code`]），`started_at` 是 Unix 毫秒。
    #[serde(skip)]
    Action {
        n: u8,
        code: u8,
        started_at: f64,
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

/// 寫到 WebSocket 的一則伺服器訊息。
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}
impl Frame {
    /// 酬載長度（bytes），不含 WebSocket 框架。
    pub fn len(&self) -> usize {
        match self {
            Self::Text(s) => s.len(),
            Self::Binary(b) => b.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
impl ServerMessage {
    /// `moves`／`sync`／`action` 編成二進位幀，其餘編成 JSON 文字。無法編碼時回 `None`（不應發生）。
    pub fn to_frame(&self) -> Option<Frame> {
        match self {
            Self::Moves { m } => encode_batch(BatchKind::Moves, m).map(Frame::Binary),
            Self::Sync { m } => encode_batch(BatchKind::Sync, m).map(Frame::Binary),
            Self::Action {
                n,
                code,
                started_at,
            } => encode_action(*n, *code, *started_at).map(Frame::Binary),
            other => serde_json::to_string(other).ok().map(Frame::Text),
        }
    }
}

// ---- moves／sync 二進位幀（協定版本 2 起）----
//
// 幀 = 1 byte 幀型 + N 筆 × 6 bytes，N = (長度 − 1) / 6，0 ≤ N ≤ MAX_MOVES_PER_MESSAGE。多位元組整數為 little-endian。
//
// | 位移 | 型別 | 內容 |
// | --- | --- | --- |
// | 0 | u8 | bit 7：moving（1 = 移動中）；bit 0～6：房內短編號 n（0～127） |
// | 1 | i16 | x，公分（四捨五入，.5 遠離零），限 ±MAX_COORD_CM |
// | 3 | i16 | z，公分，同上 |
// | 5 | u8 | heading，q = round(heading × 128 / π) mod 256；解碼 (q ≤ 128 ? q : q − 256) × π / 128，範圍 (−π, π] |
//
// 前端實作在 web/src/game/net/binaryFrame.ts；兩邊以 server/tests/protocol-v3.json 的 binary 測試向量驗證一致。

/// 幀型：`moves`（增量）。
pub const FRAME_MOVES: u8 = 0x01;
/// 幀型：`sync`（整批校正）。
pub const FRAME_SYNC: u8 = 0x02;
/// 每筆位置的 bytes。
pub const MOVE_ENTRY_BYTES: usize = 6;
/// 房內短編號上限（7 位元）。房間人數上限必須不超過 `MAX_SHORT_ID + 1`。
pub const MAX_SHORT_ID: u8 = 127;
/// 座標上限（公分）。兩個場景都在 ±19 公尺內；超出視為壞資料，解碼端拒絕。
pub const MAX_COORD_CM: i16 = 10_000;
const MOVING_BIT: u8 = 0x80;
/// 一則二進位幀的最大長度（200 筆時 1,201 bytes）。
pub const MAX_BATCH_FRAME_BYTES: usize = 1 + MAX_MOVES_PER_MESSAGE * MOVE_ENTRY_BYTES;
const _: () = assert!(MAX_BATCH_FRAME_BYTES <= MAX_MESSAGE_BYTES);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchKind {
    Moves,
    Sync,
}

/// 座標（公尺）→ 公分整數，夾在 ±MAX_COORD_CM。`f64::round` 的 .5 遠離零，與前端一致。
pub fn quantize_coord(v: f64) -> i16 {
    let cm = (v * 100.0).round();
    cm.clamp(-f64::from(MAX_COORD_CM), f64::from(MAX_COORD_CM)) as i16
}
/// heading（弧度）→ 1 byte，一格 2π/256（約 1.41°）。
pub fn quantize_heading(heading: f64) -> u8 {
    let q = (heading * 128.0 / std::f64::consts::PI).round();
    if !q.is_finite() {
        return 0;
    }
    (q.rem_euclid(256.0)) as u8
}
pub fn dequantize_heading(q: u8) -> f64 {
    let signed = if q <= 128 {
        f64::from(q)
    } else {
        f64::from(q) - 256.0
    };
    signed * (std::f64::consts::PI / 128.0)
}

/// 編碼一則 `moves`／`sync` 幀。筆數超過上限或短編號超過 `MAX_SHORT_ID` 時回 `None`。
pub fn encode_batch(kind: BatchKind, m: &[MoveTuple]) -> Option<Vec<u8>> {
    if m.len() > MAX_MOVES_PER_MESSAGE {
        return None;
    }
    let mut out = Vec::with_capacity(1 + m.len() * MOVE_ENTRY_BYTES);
    out.push(match kind {
        BatchKind::Moves => FRAME_MOVES,
        BatchKind::Sync => FRAME_SYNC,
    });
    for &(n, x, z, heading, moving) in m {
        if n > MAX_SHORT_ID {
            return None;
        }
        out.push(
            n | if moving == Moving::Moving {
                MOVING_BIT
            } else {
                0
            },
        );
        out.extend_from_slice(&quantize_coord(x).to_le_bytes());
        out.extend_from_slice(&quantize_coord(z).to_le_bytes());
        out.push(quantize_heading(heading));
    }
    Some(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchError {
    Empty,
    UnknownKind(u8),
    Length(usize),
    TooMany(usize),
    CoordOutOfRange,
}

/// 解碼一則 `moves`／`sync` 幀（負載工具與測試用；伺服器本身只編碼）。
pub fn decode_batch(bytes: &[u8]) -> Result<(BatchKind, Vec<MoveTuple>), BatchError> {
    let (&kind, body) = bytes.split_first().ok_or(BatchError::Empty)?;
    let kind = match kind {
        FRAME_MOVES => BatchKind::Moves,
        FRAME_SYNC => BatchKind::Sync,
        other => return Err(BatchError::UnknownKind(other)),
    };
    if body.len() % MOVE_ENTRY_BYTES != 0 {
        return Err(BatchError::Length(bytes.len()));
    }
    let count = body.len() / MOVE_ENTRY_BYTES;
    if count > MAX_MOVES_PER_MESSAGE {
        return Err(BatchError::TooMany(count));
    }
    let coord = |lo: u8, hi: u8| {
        let cm = i16::from_le_bytes([lo, hi]);
        if cm.unsigned_abs() > MAX_COORD_CM.unsigned_abs() {
            Err(BatchError::CoordOutOfRange)
        } else {
            Ok(f64::from(cm) / 100.0)
        }
    };
    let m = body
        .chunks_exact(MOVE_ENTRY_BYTES)
        .map(|e| {
            let moving = if e[0] & MOVING_BIT != 0 {
                Moving::Moving
            } else {
                Moving::Stopped
            };
            Ok((
                e[0] & !MOVING_BIT,
                coord(e[1], e[2])?,
                coord(e[3], e[4])?,
                dequantize_heading(e[5]),
                moving,
            ))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((kind, m))
}

// ---- action 二進位幀（協定版本 3）----
//
// 固定 7 bytes：
//
// | 位移 | 型別 | 內容 |
// | --- | --- | --- |
// | 0 | u8 | 幀型 0x03 |
// | 1 | u8 | 執行者的房內短編號 n（0～127；bit 7 保留，須為 0） |
// | 2 | u8 | 動作編號：`world::ACTIONS` 的索引（與前端 `ACTION_CODES`、固定資料 `binary.action.codes` 相同） |
// | 3 | u32 | started_at（Unix 毫秒）mod 2^32，little-endian；客戶端以 [`unwrap_started_at`] 還原 |

/// 幀型：`action`。
pub const FRAME_ACTION: u8 = 0x03;
/// 動作幀的固定長度。
pub const ACTION_FRAME_BYTES: usize = 7;

/// 編碼一則動作幀。短編號超過 `MAX_SHORT_ID`、動作編號不在對照表內、`started_at` 不是有限的非負數時回 `None`。
pub fn encode_action(n: u8, code: u8, started_at: f64) -> Option<Vec<u8>> {
    if n > MAX_SHORT_ID
        || usize::from(code) >= world::ACTIONS.len()
        || !started_at.is_finite()
        || started_at < 0.0
    {
        return None;
    }
    // Unix 毫秒遠小於 2^53，`as u64` 對非負的有限值是 floor；只送低 32 位元。
    let low = (started_at as u64 & 0xFFFF_FFFF) as u32;
    let mut out = Vec::with_capacity(ACTION_FRAME_BYTES);
    out.extend_from_slice(&[FRAME_ACTION, n, code]);
    out.extend_from_slice(&low.to_le_bytes());
    Some(out)
}

/// 動作幀解碼後、還原絕對時間之前的內容。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionFrame {
    pub n: u8,
    pub id: &'static str,
    /// started_at mod 2^32。
    pub started_at_low: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionFrameError {
    Kind,
    Length(usize),
    ShortId(u8),
    UnknownAction(u8),
}

/// 解碼一則動作幀（負載工具與測試用）。幀型不符、長度不是 7、n 超過 127、動作編號不在對照表內都拒絕。
pub fn decode_action(bytes: &[u8]) -> Result<ActionFrame, ActionFrameError> {
    if bytes.first() != Some(&FRAME_ACTION) {
        return Err(ActionFrameError::Kind);
    }
    let &[_, n, code, a, b, c, d] = bytes else {
        return Err(ActionFrameError::Length(bytes.len()));
    };
    if n > MAX_SHORT_ID {
        return Err(ActionFrameError::ShortId(n));
    }
    let id = *world::ACTIONS
        .get(usize::from(code))
        .ok_or(ActionFrameError::UnknownAction(code))?;
    Ok(ActionFrame {
        n,
        id,
        started_at_low: u32::from_le_bytes([a, b, c, d]),
    })
}

/// 由 started_at 的低 32 位元還原絕對毫秒：取 mod 2^32 相同、且離 `reference`（收件人估計的伺服器現在時間）
/// 最近的值。`started_at − reference` 在 [−2^31, 2^31) 毫秒（約 ±24.8 天）內都正確。與前端 `unwrapStartedAt` 相同。
pub fn unwrap_started_at(low: u32, reference: f64) -> f64 {
    let reference = reference.floor() as i64;
    // 差值取 [−2^31, 2^31)：u32 減法回繞後當成 i32。
    let delta = low.wrapping_sub(reference as u32) as i32;
    (reference + i64::from(delta)) as f64
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
                r#"{{"t":"hello","v":3,"name":"{}"{token}}}"#,
                "n".repeat(name)
            ))
        };
        assert!(hello(16, Some(MAX_RESUME_TOKEN_BYTES)).within_limits());
        assert!(!hello(16, Some(MAX_RESUME_TOKEN_BYTES + 1)).within_limits());
        assert!(!hello(MAX_RAW_NAME_BYTES + 1, None).within_limits());
    }
}
