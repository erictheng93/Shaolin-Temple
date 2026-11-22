use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::world;

pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
/// 協定版本。2（T8）：`moves`／`sync` 改為二進位幀（見 [`encode_batch`]）；
/// 3：下行的 `action` 也改為二進位幀（見 [`encode_action`]）；
/// 4：登入與改名（`hello.session`、`welcome.auth`、上行 `rename`、下行 `name`）；
/// 5：庭院碰碰車（上行 `claim`、`ride`、`drive`；下行 `car`、`carGone`、`knock` 與二進位 `cars` 幀 [`encode_cars`]）。
/// `hello.v` 不同時回 `unsupported_version` 並關閉，前端據此提示重新整理。
pub const PROTOCOL_VERSION: f64 = 5.0;
/// 客戶端字串欄位上限（UTF-8 bytes）。超過時整則視為無效訊息。
/// reqId 會被快取做去重（T4），沒有上限時每條連線最壞可佔約 1 MB。
pub const MAX_REQ_ID_BYTES: usize = 128;
pub const MAX_RESUME_TOKEN_BYTES: usize = 128;
pub const MAX_ACTION_ID_BYTES: usize = 32;
pub const MAX_ZONE_BYTES: usize = 32;
/// 名稱原始字串上限（`hello.name` 與 `rename.name`）；清理後仍只保留 16 個字元。
pub const MAX_RAW_NAME_BYTES: usize = 256;
/// 聊天原始字串上限（UTF-8 bytes）；清理後最多 [`CHAT_MAX_CHARS`] 個字元。
pub const MAX_CHAT_RAW_BYTES: usize = 512;
pub const CHAT_MAX_CHARS: usize = 80;
/// `hello.session`（登入權杖，[`crate::auth`]）上限。空字串不算無效訊息，只是驗證不過、當訪客。
pub const MAX_SESSION_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    Hello {
        v: f64,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume_token: Option<String>,
        /// 衣裝編號。缺少或無效（非整數、超出範圍）一律當作 0，見 [`parse_outfit`]。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outfit: Option<Value>,
        /// 登入後取得的 session 權杖；缺少或驗證不過都當訪客，不拒絕連線。
        #[serde(skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },
    /// 進場後改名（須在 `hello` 之後）。清理規則與 `hello.name` 相同（[`clean_name`]）。
    Rename {
        name: String,
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
    Chat {
        text: String,
    },
    /// 更換衣裝。值不在範圍內時伺服器直接丟棄（見 [`parse_outfit`]）。
    Outfit {
        outfit: Value,
    },
    /// 領車：車種由伺服器依權重隨機分配，訊息不帶欄位。
    Claim,
    /// 上下車：上車帶車輛編號（0..MAX_CARS-1），下車帶 null。
    Ride {
        #[serde(default)]
        car: Option<u8>,
    },
    /// 駕駛輸入：序號、方向（0..255）、力道（0..255）。
    Drive {
        seq: u16,
        dir: u8,
        mag: u8,
    },
}

/// 碰碰車種類數量（4 款）。由固定資料 `tests/protocol-v5.json` 的 `kindCount` 鎖住。
pub const KIND_COUNT: u8 = 4;
/// 房間內碰碰車數量上限（16 台）。
pub const MAX_CARS: usize = 16;
/// 幀型：`cars`（碰碰車狀態廣播）。
pub const FRAME_CARS: u8 = 0x04;
/// 每台車的二進位 bytes。
pub const CAR_ENTRY_BYTES: usize = 12;

/// 衣裝數量：編號 `0..OUTFIT_COUNT`，新增衣裝只能加在尾端。外觀由客戶端決定，伺服器只驗證範圍、保存、轉送。
/// 上行（`hello`、`outfit`）維持嚴格驗證；前端的下行驗證較寬鬆（0～255），舊分頁把不認得的編號顯示為預設衣裝。
/// 與前端 `protocol.ts` 的 `OUTFIT_COUNT` 相同，由固定資料 `tests/protocol-v5.json` 的 `outfitCount` 鎖住。
pub const OUTFIT_COUNT: u8 = 8;

/// 衣裝編號驗證：必須是 `0..OUTFIT_COUNT` 內的整數（JSON 數字），否則回 `None`。
pub fn parse_outfit(value: &Value) -> Option<u8> {
    value
        .as_u64()
        .filter(|v| *v < u64::from(OUTFIT_COUNT))
        .map(|v| v as u8)
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
    /// 衣裝編號（0～[`OUTFIT_COUNT`] − 1）。
    pub outfit: u8,
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

/// `welcome.auth`：這條連線的身分。`hello.session` 驗證通過時是提供者，否則是訪客。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Guest,
    Google,
    Line,
}
/// 單則 `moves`／`sync` 最多筆數，與前端 `MAX_MOVES_PER_MESSAGE` 相同。
pub const MAX_MOVES_PER_MESSAGE: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarSnapshot {
    pub c: u8,
    pub kind: u8,
    pub driver: Option<String>,
    pub x: f64,
    pub z: f64,
    pub heading: f64,
    pub fade_at: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CarState {
    pub c: u8,
    pub occupied: bool,
    pub bumped: bool,
    pub x: f64,
    pub z: f64,
    pub heading: f64,
    pub vx: f64,
    pub vz: f64,
    pub w: f64,
}

impl From<crate::vehicles::world::CarState> for CarState {
    fn from(s: crate::vehicles::world::CarState) -> Self {
        Self {
            c: s.c,
            occupied: s.occupied,
            bumped: s.bumped,
            x: s.x as f64,
            z: s.z as f64,
            heading: s.heading as f64,
            vx: s.vx as f64,
            vz: s.vz as f64,
            w: s.w as f64,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    Welcome {
        self_id: String,
        room: String,
        resume_token: String,
        server_time: f64,
        auth: AuthKind,
        players: Vec<PlayerSnapshot>,
        #[serde(default)]
        cars: Vec<CarSnapshot>,
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
    /// 文字聊天：`text` 已清理，`at` 是伺服器 Unix 毫秒。廣播給同房所有在線玩家（不分場景）。
    Chat {
        id: String,
        text: String,
        at: f64,
    },
    /// 某玩家更換衣裝。廣播給同房所有在線玩家（不分場景、含本人）。
    Outfit {
        id: String,
        outfit: u8,
    },
    /// 玩家改名（含斷線恢復時帶了新名字）：送給同房所有人（含本人、不分場景），`name` 是清理後的結果。
    Name {
        id: String,
        name: String,
    },
    /// 碰碰車生成或狀態變更（領車、上下車、淡出）。
    Car {
        c: u8,
        kind: u8,
        driver: Option<String>,
        x: f64,
        z: f64,
        heading: f64,
        fade_at: Option<f64>,
    },
    /// 碰碰車消失（淡出完成移出場景）。
    CarGone {
        c: u8,
    },
    /// 碰碰車撞擊行人（擊飛事件）。
    Knock {
        id: String,
        x: f64,
        z: f64,
        to_x: f64,
        to_z: f64,
        at: f64,
    },
    /// 碰碰車狀態（二進位幀）：只以二進位幀送出（[`encode_cars`]）。
    #[serde(skip)]
    Cars {
        ack: u16,
        cars: Vec<CarState>,
    },
}

impl From<CarSnapshot> for ServerMessage {
    fn from(s: CarSnapshot) -> Self {
        Self::Car {
            c: s.c,
            kind: s.kind,
            driver: s.driver,
            x: s.x,
            z: s.z,
            heading: s.heading,
            fade_at: s.fade_at,
        }
    }
}

impl From<&CarSnapshot> for ServerMessage {
    fn from(s: &CarSnapshot) -> Self {
        Self::Car {
            c: s.c,
            kind: s.kind,
            driver: s.driver.clone(),
            x: s.x,
            z: s.z,
            heading: s.heading,
            fade_at: s.fade_at,
        }
    }
}

impl ClientMessage {
    /// 字串欄位是否在長度上限內（識別字不可為空）。
    pub fn within_limits(&self) -> bool {
        let id = |v: &str, max: usize| !v.is_empty() && v.len() <= max;
        match self {
            Self::Hello {
                name,
                resume_token,
                session,
                ..
            } => {
                name.len() <= MAX_RAW_NAME_BYTES
                    && resume_token
                        .as_deref()
                        .is_none_or(|t| id(t, MAX_RESUME_TOKEN_BYTES))
                    && session
                        .as_deref()
                        .is_none_or(|s| s.len() <= MAX_SESSION_BYTES)
            }
            Self::Rename { name } => name.len() <= MAX_RAW_NAME_BYTES,
            Self::Action {
                req_id, id: action, ..
            } => id(req_id, MAX_REQ_ID_BYTES) && id(action, MAX_ACTION_ID_BYTES),
            Self::Zone { zone, .. } => id(zone, MAX_ZONE_BYTES),
            Self::Chat { text } => text.len() <= MAX_CHAT_RAW_BYTES,
            Self::Ride { car } => car.is_none_or(|c| (c as usize) < MAX_CARS),
            Self::Claim | Self::Drive { .. } => true,
            Self::Move { .. } | Self::Stop { .. } | Self::Ping { .. } | Self::Outfit { .. } => true,
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
    /// `moves`／`sync`／`action`／`cars` 編成二進位幀，其餘編成 JSON 文字。無法編碼時回 `None`（不應發生）。
    pub fn to_frame(&self) -> Option<Frame> {
        match self {
            Self::Moves { m } => encode_batch(BatchKind::Moves, m).map(Frame::Binary),
            Self::Sync { m } => encode_batch(BatchKind::Sync, m).map(Frame::Binary),
            Self::Action {
                n,
                code,
                started_at,
            } => encode_action(*n, *code, *started_at).map(Frame::Binary),
            Self::Cars { ack, cars } => encode_cars(*ack, cars).map(Frame::Binary),
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
// 前端實作在 web/src/game/net/binaryFrame.ts；兩邊以 server/tests/protocol-v5.json 的 binary 測試向量驗證一致。

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

// ---- cars 二進位幀（協定版本 5 起）----
//
// 幀 = 1 byte 幀型 (0x04) + 2 bytes ack (u16 little-endian) + N 筆 × 12 bytes，0 ≤ N ≤ MAX_CARS。
//
// | 位移 | 型別 | 內容 |
// | --- | --- | --- |
// | 0 | u8 | bit 0～3: 車輛編號 c (0..15); bit 4: occupied (1=有人); bit 5: bumped (1=剛碰撞); bits 6～7: 保留為 0 |
// | 1 | i16 | x，公分（四捨五入，.5 遠離零），限 ±MAX_COORD_CM |
// | 3 | i16 | z，公分，同上 |
// | 5 | i16 | heading，round(heading * 32768 / π) 轉為 signed i16（π -> -32768），解碼 q * π / 32768 ∈ [-π, π) |
// | 7 | i16 | vx，公分/秒（clamp ±3000） |
// | 9 | i16 | vz，公分/秒（clamp ±3000） |
// | 11 | i8 | w，單位 1/16 rad/s（clamp ±127） |

pub fn quantize_heading_i16(heading: f64) -> i16 {
    let q = (heading * (32768.0 / std::f64::consts::PI)).round();
    if !q.is_finite() {
        return 0;
    }
    let low16 = q.rem_euclid(65536.0) as u16;
    low16 as i16
}

pub fn dequantize_heading_i16(q: i16) -> f64 {
    f64::from(q) * (std::f64::consts::PI / 32768.0)
}

pub fn quantize_vel(v: f64) -> i16 {
    let cm = (v * 100.0).round();
    if !cm.is_finite() {
        return 0;
    }
    cm.clamp(-3000.0, 3000.0) as i16
}

pub fn quantize_angvel(w: f64) -> i8 {
    let val = (w * 16.0).round();
    if !val.is_finite() {
        return 0;
    }
    val.clamp(-127.0, 127.0) as i8
}

/// 編碼一則 `cars` 幀。車輛數超過 `MAX_CARS` 或車輛編號超過 15 時回 `None`。
pub fn encode_cars(ack: u16, cars: &[CarState]) -> Option<Vec<u8>> {
    if cars.len() > MAX_CARS {
        return None;
    }
    let mut out = Vec::with_capacity(3 + cars.len() * CAR_ENTRY_BYTES);
    out.push(FRAME_CARS);
    out.extend_from_slice(&ack.to_le_bytes());
    for car in cars {
        if car.c as usize >= MAX_CARS {
            return None;
        }
        let flags = (car.c & 0x0F)
            | (if car.occupied { 0x10 } else { 0 })
            | (if car.bumped { 0x20 } else { 0 });
        out.push(flags);
        out.extend_from_slice(&quantize_coord(car.x).to_le_bytes());
        out.extend_from_slice(&quantize_coord(car.z).to_le_bytes());
        out.extend_from_slice(&quantize_heading_i16(car.heading).to_le_bytes());
        out.extend_from_slice(&quantize_vel(car.vx).to_le_bytes());
        out.extend_from_slice(&quantize_vel(car.vz).to_le_bytes());
        out.push(quantize_angvel(car.w) as u8);
    }
    Some(out)
}

/// 解碼一則 `cars` 幀（測試與客戶端共用邏輯）。
pub fn decode_cars(bytes: &[u8]) -> Option<(u16, Vec<CarState>)> {
    if bytes.len() < 3 || bytes[0] != FRAME_CARS {
        return None;
    }
    let body = &bytes[3..];
    if !body.len().is_multiple_of(CAR_ENTRY_BYTES) {
        return None;
    }
    let count = body.len() / CAR_ENTRY_BYTES;
    if count > MAX_CARS {
        return None;
    }
    let ack = u16::from_le_bytes([bytes[1], bytes[2]]);
    let mut seen_c = 0u16;
    let mut cars = Vec::with_capacity(count);
    for chunk in body.chunks_exact(CAR_ENTRY_BYTES) {
        let flags = chunk[0];
        if (flags & 0xC0) != 0 {
            return None;
        }
        let c = flags & 0x0F;
        if (seen_c & (1 << c)) != 0 {
            return None;
        }
        seen_c |= 1 << c;
        let occupied = (flags & 0x10) != 0;
        let bumped = (flags & 0x20) != 0;
        let hx = i16::from_le_bytes([chunk[1], chunk[2]]);
        let hz = i16::from_le_bytes([chunk[3], chunk[4]]);
        if hx.unsigned_abs() > MAX_COORD_CM.unsigned_abs()
            || hz.unsigned_abs() > MAX_COORD_CM.unsigned_abs()
        {
            return None;
        }
        let q_h = i16::from_le_bytes([chunk[5], chunk[6]]);
        let q_vx = i16::from_le_bytes([chunk[7], chunk[8]]);
        let q_vz = i16::from_le_bytes([chunk[9], chunk[10]]);
        if q_vx.unsigned_abs() > 3000 || q_vz.unsigned_abs() > 3000 {
            return None;
        }
        let q_w = chunk[11] as i8;
        cars.push(CarState {
            c,
            occupied,
            bumped,
            x: f64::from(hx) / 100.0,
            z: f64::from(hz) / 100.0,
            heading: dequantize_heading_i16(q_h),
            vx: f64::from(q_vx) / 100.0,
            vz: f64::from(q_vz) / 100.0,
            w: f64::from(q_w) / 16.0,
        });
    }
    Some((ack, cars))
}

/// 名稱清理（`hello` 與 `rename` 共用）：去控制字元、去前後空白、最多 16 個 Unicode 字元，空白時為「訪客」。
pub fn clean_name(name: &str) -> String {
    let filtered: String = name.chars().filter(|c| !c.is_control()).collect();
    let name: String = filtered.trim().chars().take(16).collect();
    if name.is_empty() {
        "訪客".into()
    } else {
        name
    }
}

/// 聊天文字清理：移除控制字元與雙向覆寫／零寬字元，空白（含換行、tab）壓成單一空格，
/// trim，最多 [`CHAT_MAX_CHARS`] 個字元。結果為空表示應丟棄。
pub fn clean_chat(text: &str) -> String {
    let mut out = String::new();
    let mut count = 0;
    let mut pending_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            pending_space = count > 0;
        } else if !(c.is_control()
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
        {
            let needed = if pending_space { 2 } else { 1 };
            if count + needed > CHAT_MAX_CHARS {
                break;
            }
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
            count += needed;
        }
    }
    out
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
                r#"{{"t":"hello","v":5,"name":"{}"{token}}}"#,
                "n".repeat(name)
            ))
        };
        assert!(hello(16, Some(MAX_RESUME_TOKEN_BYTES)).within_limits());
        assert!(!hello(16, Some(MAX_RESUME_TOKEN_BYTES + 1)).within_limits());
        assert!(!hello(MAX_RAW_NAME_BYTES + 1, None).within_limits());
        let session = |n: usize| {
            parse(format!(
                r#"{{"t":"hello","v":5,"name":"a","session":"{}"}}"#,
                "s".repeat(n)
            ))
        };
        assert!(session(0).within_limits());
        assert!(session(MAX_SESSION_BYTES).within_limits());
        assert!(!session(MAX_SESSION_BYTES + 1).within_limits());
        let rename = |n: usize| parse(format!(r#"{{"t":"rename","name":"{}"}}"#, "n".repeat(n)));
        assert!(rename(MAX_RAW_NAME_BYTES).within_limits());
        assert!(rename(0).within_limits());
        assert!(!rename(MAX_RAW_NAME_BYTES + 1).within_limits());
        assert!(matches!(
            parse(r#"{"t":"claim"}"#.into()),
            ClientMessage::Claim
        ));
        // 舊客戶端多帶的 kind 會被忽略（車種一律由伺服器決定）
        assert!(matches!(
            parse(r#"{"t":"claim","kind":3}"#.into()),
            ClientMessage::Claim
        ));
        let ride = |c: Option<u8>| ClientMessage::Ride { car: c };
        assert!(ride(None).within_limits());
        assert!(ride(Some(0)).within_limits());
        assert!(ride(Some(MAX_CARS as u8 - 1)).within_limits());
        assert!(!ride(Some(MAX_CARS as u8)).within_limits());
        let drive = ClientMessage::Drive {
            seq: 1,
            dir: 128,
            mag: 255,
        };
        assert!(drive.within_limits());
    }

    #[test]
    fn chat_cleaning() {
        assert_eq!(clean_chat("阿彌陀佛"), "阿彌陀佛");
        assert_eq!(clean_chat("a\u{0}b\u{7}c\u{85}d\u{7f}e"), "abc de");
        assert_eq!(
            clean_chat("\u{202E}evil\u{200B}\u{FEFF}\u{2066}x\u{2069}"),
            "evilx"
        );
        assert_eq!(clean_chat("  a \n\t b   c\r\n "), "a b c");
        assert_eq!(clean_chat(" \n\u{200B}\u{1}\t "), "");
        let cjk = "佛".repeat(100);
        assert_eq!(clean_chat(&cjk).chars().count(), CHAT_MAX_CHARS);
        assert_eq!(clean_chat(&"🙏".repeat(100)), "🙏".repeat(CHAT_MAX_CHARS));
        // 截斷後不留尾端空白
        let text = format!("{} b", "a".repeat(CHAT_MAX_CHARS - 1));
        assert_eq!(clean_chat(&text), "a".repeat(CHAT_MAX_CHARS - 1));
    }

    #[test]
    fn outfit_validation() {
        use serde_json::json;
        for ok in 0..OUTFIT_COUNT {
            assert_eq!(parse_outfit(&json!(ok)), Some(ok));
        }
        for bad in [
            json!(OUTFIT_COUNT),
            json!(-1),
            json!(1.5),
            json!(2.0),
            json!("1"),
            json!(null),
            json!(true),
            json!([1]),
            json!(1e30),
        ] {
            assert_eq!(parse_outfit(&bad), None, "{bad}");
        }
    }

    #[test]
    fn chat_raw_limit() {
        let chat = |n: usize| ClientMessage::Chat {
            text: "a".repeat(n),
        };
        assert!(chat(MAX_CHAT_RAW_BYTES).within_limits());
        assert!(!chat(MAX_CHAT_RAW_BYTES + 1).within_limits());
    }
}
