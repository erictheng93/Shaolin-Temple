//! 登入（協定版本 4）：Google／LINE 的 OpenID Connect 授權碼流程，以及無狀態的 session 權杖。
//!
//! 流程（細節與理由見 docs/BACKEND_TASKS.md「協定版本 4：登入與改名」）：
//!
//! 1. `GET /auth/{provider}/start?origin=<前端 origin>`：origin 必須完全等於 `ALLOWED_ORIGINS` 之一。
//!    產生 PKCE verifier（S256）、nonce 與隨機值 `r`；verifier／nonce／`r` 放在簽章過的 HttpOnly cookie
//!    （只送回瀏覽器，不出現在任何網址），origin 與 `r` 放在簽章過的 `state`。302 到提供者的授權頁。
//! 2. `GET /auth/{provider}/callback?code&state`：`state` 簽章與期限 → 取回 origin（不合法就 400）；
//!    cookie 簽章、期限、提供者相符且 `r` 與 state 的相同（綁定同一個瀏覽器，防 login CSRF）；
//!    以 code＋verifier 向 token endpoint 換 ID token，檢查 `iss`／`aud`／`exp`／`nonce`；
//!    簽發 session 權杖，302 回 `<origin>/#session=…&provider=…`。失敗一律 302 回 `#auth_error=cancelled|failed`。
//!
//! 伺服器不存任何登入狀態：流程狀態在 cookie／state（10 分鐘過期），登入狀態在 session 權杖（30 天）。

use crate::protocol::AuthKind;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

/// session 權杖有效期間。沒有撤銷機制（已知限制）：要讓所有權杖失效只能輪替 `SESSION_SECRET`。
pub const SESSION_TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// 登入流程（cookie 與 state）的有效期間，與 cookie 的 `Max-Age` 相同。
pub const FLOW_TTL_SECS: u64 = 600;
/// `SESSION_SECRET` 最短長度（bytes）。
pub const MIN_SECRET_BYTES: usize = 32;
/// 接受的 `sub` 最大長度。Google 約 21 位數字、LINE 是 `U` 加 32 個十六進位字元；
/// 上限讓 session 權杖必定在 [`crate::protocol::MAX_SESSION_BYTES`] 內（見 `session_tokens_fit_the_hello_limit`）。
pub const MAX_SUB_BYTES: usize = 255;
/// 對外 HTTP 請求的逾時與回應大小上限。
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// callback 參數上限：`code`／`state` 太長直接視為失敗，不轉送給提供者。
const MAX_PARAM_BYTES: usize = 2048;
const FLOW_COOKIE: &str = "temple_auth";
/// 同時進行中的 token endpoint 請求上限（整台伺服器）。合法的 cookie＋state 在 10 分鐘內可以帶亂數 code
/// 重複打 callback，每次都會以我方憑證向提供者發請求；限制併發避免被拿來放大流量或耗盡連線。
/// 正常登入一次只佔一個名額約數百毫秒，8 個名額足夠同時有數十人登入；超過的立即以 `auth_error=failed` 結束。
/// 反向代理另應對 `/auth` 加頻率限制（docs/DEPLOY.md）。
pub const MAX_CONCURRENT_EXCHANGES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Google,
    Line,
}
impl ProviderKind {
    pub const ALL: [Self; 2] = [Self::Google, Self::Line];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Line => "line",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
    pub fn auth_kind(self) -> AuthKind {
        match self {
            Self::Google => AuthKind::Google,
            Self::Line => AuthKind::Line,
        }
    }
}

/// 提供者的端點。正式環境用 [`ProviderEndpoints::google`]／[`ProviderEndpoints::line`]；
/// 整合測試注入本機的假提供者。
#[derive(Debug, Clone)]
pub struct ProviderEndpoints {
    pub authorize: String,
    pub token: String,
    /// ID token 的 `iss` 必須是其中之一。
    pub issuers: Vec<String>,
}
impl ProviderEndpoints {
    /// Google OpenID Connect（https://developers.google.com/identity/openid-connect/openid-connect ，
    /// 端點同 https://accounts.google.com/.well-known/openid-configuration ）。
    /// 官方文件：`iss` 是 `https://accounts.google.com` 或 `accounts.google.com`。
    pub fn google() -> Self {
        Self {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            issuers: vec![
                "https://accounts.google.com".into(),
                "accounts.google.com".into(),
            ],
        }
    }
    /// LINE Login v2.1（https://developers.line.biz/en/docs/line-login/integrate-line-login/ ）。
    /// `iss` 是 `https://access.line.me`（https://developers.line.biz/en/docs/line-login/verify-id-token/ ）。
    pub fn line() -> Self {
        Self {
            authorize: "https://access.line.me/oauth2/v2.1/authorize".into(),
            token: "https://api.line.me/oauth2/v2.1/token".into(),
            issuers: vec!["https://access.line.me".into()],
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    /// Google 的 client ID／LINE 的 channel ID；也是 ID token 的 `aud`。
    pub client_id: String,
    pub client_secret: String,
    pub endpoints: ProviderEndpoints,
}

/// 登入設定（`config.rs` 從環境變數組出）。`SESSION_SECRET` 有設定時才存在。
#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub session_secret: Vec<u8>,
    /// 伺服器對外的 scheme＋主機（`AUTH_PUBLIC_URL`，已正規化、無結尾斜線）；有提供者時必填。
    pub public_url: Option<String>,
    pub providers: Vec<ProviderConfig>,
}

/// HMAC-SHA256 簽章。每種用途（session 權杖、流程 cookie、state）在 MAC 輸入前加上不同的前綴，
/// 一種用途的值不能拿去冒充另一種。權杖格式：`base64url(payload).base64url(mac)`。
#[derive(Clone)]
pub struct Signer {
    key: Vec<u8>,
}
impl Signer {
    pub fn new(key: Vec<u8>) -> Self {
        Self { key }
    }
    fn mac(&self, purpose: &[u8], payload: &[u8]) -> HmacSha256 {
        // HMAC 接受任意長度的金鑰，new_from_slice 不會失敗。
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(purpose);
        mac.update(&[0]);
        mac.update(payload);
        mac
    }
    fn sign(&self, purpose: &[u8], payload: &[u8]) -> String {
        let tag = self.mac(purpose, payload).finalize().into_bytes();
        format!("{}.{}", B64.encode(payload), B64.encode(tag))
    }
    /// 驗證簽章並取回 payload。比對用 `verify_slice`（常數時間）。
    fn open(&self, purpose: &[u8], token: &str) -> Option<Vec<u8>> {
        let (payload, tag) = token.split_once('.')?;
        let payload = B64.decode(payload).ok()?;
        let tag = B64.decode(tag).ok()?;
        self.mac(purpose, &payload).verify_slice(&tag).ok()?;
        Some(payload)
    }

    /// 簽發 session 權杖：payload 只有提供者、到期時間（Unix 秒）與 `sub`：`<g|l>:<exp>:<sub>`。
    /// `sub` 未加密（權杖只交給本人），日誌不得印出權杖或 `sub`。
    pub fn issue_session(&self, provider: ProviderKind, sub: &str, now_secs: u64) -> String {
        let code = match provider {
            ProviderKind::Google => 'g',
            ProviderKind::Line => 'l',
        };
        let payload = format!("{code}:{}:{sub}", now_secs + SESSION_TTL_SECS);
        self.sign(b"session", payload.as_bytes())
    }
    /// 驗證 session 權杖：簽章正確且未過期才回傳身分。
    pub fn verify_session(&self, token: &str, now_secs: u64) -> Option<Identity> {
        let payload = String::from_utf8(self.open(b"session", token)?).ok()?;
        let mut parts = payload.splitn(3, ':');
        let provider = match parts.next()? {
            "g" => ProviderKind::Google,
            "l" => ProviderKind::Line,
            _ => return None,
        };
        let exp: u64 = parts.next()?.parse().ok()?;
        let sub = parts.next()?;
        (exp > now_secs && !sub.is_empty()).then(|| Identity {
            provider,
            sub: sub.into(),
        })
    }
}

/// 驗證通過的登入身分。目前只用來決定 `welcome.auth`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub provider: ProviderKind,
    pub sub: String,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// 執行期的登入元件（`AppState` 持有）。
pub struct Auth {
    pub signer: Signer,
    public_url: Option<String>,
    providers: Vec<ProviderConfig>,
    http: reqwest::Client,
    /// `AUTH_PUBLIC_URL` 是 https 時 cookie 加 `Secure`。
    secure_cookie: bool,
    /// token endpoint 請求的併發名額（[`MAX_CONCURRENT_EXCHANGES`]）。
    exchange_slots: tokio::sync::Semaphore,
}
impl Auth {
    pub fn new(config: AuthConfig) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .connect_timeout(HTTP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;
        let secure_cookie = config
            .public_url
            .as_deref()
            .is_some_and(|u| u.starts_with("https://"));
        Ok(Self {
            signer: Signer::new(config.session_secret),
            public_url: config.public_url,
            providers: config.providers,
            http,
            secure_cookie,
            exchange_slots: tokio::sync::Semaphore::new(MAX_CONCURRENT_EXCHANGES),
        })
    }
    fn provider(&self, name: &str) -> Option<&ProviderConfig> {
        let kind = ProviderKind::parse(name)?;
        self.providers.iter().find(|p| p.kind == kind)
    }
    fn redirect_uri(&self, p: &ProviderConfig) -> Option<String> {
        Some(format!(
            "{}/auth/{}/callback",
            self.public_url.as_deref()?,
            p.kind.as_str()
        ))
    }
}

// ---- 流程狀態 ----

/// 簽章過的 HttpOnly cookie：只會回到發起登入的瀏覽器。
#[derive(Serialize, Deserialize)]
struct FlowCookie {
    /// 提供者
    p: String,
    /// 與 state 共用的隨機值（綁定瀏覽器）
    r: String,
    /// PKCE code_verifier
    v: String,
    /// nonce
    n: String,
    /// 到期（Unix 秒）
    e: u64,
}
/// 簽章過的 `state`：只帶 origin（讓失敗時也能導回前端）與隨機值。
#[derive(Serialize, Deserialize)]
struct FlowState {
    o: String,
    r: String,
    e: u64,
}

fn random_token() -> String {
    B64.encode(rand::random::<[u8; 32]>())
}

fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
fn redirect(location: &str, cookie: Option<String>) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    if let Some(value) = cookie.and_then(|c| HeaderValue::from_str(&c).ok()) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    no_store(response)
}
fn plain(status: StatusCode, text: &'static str) -> Response {
    no_store((status, text).into_response())
}

// ---- HTTP 端點 ----

/// `GET /auth/providers`：列出已完整設定的提供者。允許清單內的 Origin 可跨來源讀取。
pub async fn providers(State(state): State<crate::AppState>, headers: HeaderMap) -> Response {
    let list: Vec<&str> = state
        .auth
        .as_ref()
        .map(|a| a.providers.iter().map(|p| p.kind.as_str()).collect())
        .unwrap_or_default();
    let mut response = axum::Json(serde_json::json!({ "providers": list })).into_response();
    let h = response.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = headers.get(header::ORIGIN)
        && origin
            .to_str()
            .is_ok_and(|o| state.origins.iter().any(|v| v == o))
    {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    }
    response
}

#[derive(Deserialize)]
pub struct StartQuery {
    origin: Option<String>,
}

/// `GET /auth/{provider}/start?origin=`：302 到提供者的授權頁。
pub async fn start(
    State(state): State<crate::AppState>,
    Path(provider): Path<String>,
    Query(query): Query<StartQuery>,
) -> Response {
    let Some(auth) = state.auth.as_deref() else {
        return plain(StatusCode::NOT_FOUND, "unknown provider");
    };
    let Some(p) = auth.provider(&provider) else {
        return plain(StatusCode::NOT_FOUND, "unknown provider");
    };
    // 正規化後必須完全等於允許清單之一，否則不導向（不可成為 open redirect）。
    let origin = query
        .origin
        .as_deref()
        .and_then(|o| crate::config::normalize_origin(o).ok())
        .filter(|o| state.origins.iter().any(|v| v == o));
    let Some(origin) = origin else {
        return plain(StatusCode::BAD_REQUEST, "origin not allowed");
    };
    let Some(redirect_uri) = auth.redirect_uri(p) else {
        return plain(StatusCode::NOT_FOUND, "unknown provider");
    };
    let exp = now_secs() + FLOW_TTL_SECS;
    let r = random_token();
    let verifier = random_token(); // 32 bytes → 43 個 base64url 字元（PKCE 要求 43～128）
    let nonce = random_token();
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
    let flow_state = FlowState {
        o: origin,
        r: r.clone(),
        e: exp,
    };
    let cookie = FlowCookie {
        p: p.kind.as_str().into(),
        r,
        v: verifier,
        n: nonce.clone(),
        e: exp,
    };
    let (Ok(flow_state), Ok(cookie)) =
        (serde_json::to_vec(&flow_state), serde_json::to_vec(&cookie))
    else {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    };
    let flow_state = auth.signer.sign(b"oauth-state", &flow_state);
    let cookie = auth.signer.sign(b"oauth-cookie", &cookie);
    // 只要 openid：我們只用 `sub`，不要求也不儲存姓名、頭像、email。
    let Ok(url) = reqwest::Url::parse_with_params(
        &p.endpoints.authorize,
        [
            ("response_type", "code"),
            ("client_id", p.client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", "openid"),
            ("state", flow_state.as_str()),
            ("nonce", nonce.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ],
    ) else {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    };
    let secure = if auth.secure_cookie { "; Secure" } else { "" };
    let set_cookie = format!(
        "{FLOW_COOKIE}={cookie}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age={FLOW_TTL_SECS}{secure}"
    );
    redirect(url.as_str(), Some(set_cookie))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// `GET /auth/{provider}/callback?code&state`：換權杖、驗證 ID token，302 回前端並以 fragment 帶 session。
pub async fn callback(
    State(state): State<crate::AppState>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let Some(auth) = state.auth.as_deref() else {
        return plain(StatusCode::NOT_FOUND, "unknown provider");
    };
    let Some(p) = auth.provider(&provider) else {
        return plain(StatusCode::NOT_FOUND, "unknown provider");
    };
    let now = now_secs();
    // state 還原不出仍在允許清單內的 origin：不知道該導回哪裡，回 400。
    let flow_state = query
        .state
        .as_deref()
        .filter(|s| s.len() <= MAX_PARAM_BYTES)
        .and_then(|s| auth.signer.open(b"oauth-state", s))
        .and_then(|raw| serde_json::from_slice::<FlowState>(&raw).ok())
        .filter(|s| s.e > now && state.origins.contains(&s.o));
    let Some(flow_state) = flow_state else {
        return plain(StatusCode::BAD_REQUEST, "invalid login state");
    };
    let secure = if auth.secure_cookie { "; Secure" } else { "" };
    let clear = format!("{FLOW_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0{secure}");
    let fail = |code: &'static str, reason: &'static str| {
        // 日誌只記固定的原因，不記 code、權杖、sub 或提供者的錯誤訊息。
        tracing::info!(provider = p.kind.as_str(), reason, "login failed");
        redirect(
            &format!("{}/#auth_error={code}", flow_state.o),
            Some(clear.clone()),
        )
    };
    // 使用者在提供者頁面取消：Google 回 `access_denied`，LINE 文件寫 `ACCESS_DENIED`。
    if let Some(error) = &query.error {
        return if error.eq_ignore_ascii_case("access_denied") {
            fail("cancelled", "cancelled by user")
        } else {
            fail("failed", "provider returned an error")
        };
    }
    let cookie = flow_cookie(&headers)
        .and_then(|c| auth.signer.open(b"oauth-cookie", c))
        .and_then(|raw| serde_json::from_slice::<FlowCookie>(&raw).ok())
        .filter(|c| c.e > now && c.p == p.kind.as_str());
    let Some(cookie) = cookie else {
        return fail("failed", "missing or invalid flow cookie");
    };
    // 隨機值相同才代表 callback 回到的是發起登入的同一個瀏覽器（防 login CSRF）。
    // 兩者都是簽章驗證過的值，比對不涉及秘密。
    if cookie.r != flow_state.r {
        return fail("failed", "state does not match cookie");
    }
    let Some(code) = query
        .code
        .as_deref()
        .filter(|c| !c.is_empty() && c.len() <= MAX_PARAM_BYTES)
    else {
        return fail("failed", "missing code");
    };
    let Some(redirect_uri) = auth.redirect_uri(p) else {
        return fail("failed", "AUTH_PUBLIC_URL missing");
    };
    // 拿不到名額就不等待、直接失敗（等待會讓大量請求堆在伺服器上）。名額在換完權杖後釋放。
    let Ok(slot) = auth.exchange_slots.try_acquire() else {
        return fail("failed", "too many concurrent token exchanges");
    };
    let exchanged = exchange(&auth.http, p, &redirect_uri, code, &cookie.v).await;
    drop(slot);
    let id_token = match exchanged {
        Ok(token) => token,
        Err(reason) => return fail("failed", reason),
    };
    let sub = match validate_id_token(&id_token, p, &cookie.n, now) {
        Ok(sub) => sub,
        Err(reason) => return fail("failed", reason),
    };
    let session = auth.signer.issue_session(p.kind, &sub, now);
    tracing::info!(provider = p.kind.as_str(), "login succeeded");
    redirect(
        &format!(
            "{}/#session={session}&provider={}",
            flow_state.o,
            p.kind.as_str()
        ),
        Some(clear),
    )
}

fn flow_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == FLOW_COOKIE).then_some(value)
        })
}

/// 以授權碼換 ID token（token endpoint，`application/x-www-form-urlencoded`）。
/// Google 與 LINE 都接受在 body 帶 `client_id`／`client_secret` 與 PKCE 的 `code_verifier`。
async fn exchange(
    http: &reqwest::Client,
    p: &ProviderConfig,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> Result<String, &'static str> {
    let mut response = http
        .post(&p.endpoints.token)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", p.client_id.as_str()),
            ("client_secret", p.client_secret.as_str()),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|_| "token request failed")?;
    if !response.status().is_success() {
        return Err("token endpoint rejected the code");
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
    {
        return Err("token response too large");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "token response read failed")?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("token response too large");
        }
        body.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct TokenResponse {
        id_token: String,
    }
    serde_json::from_slice::<TokenResponse>(&body)
        .map(|r| r.id_token)
        .map_err(|_| "token response without id_token")
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}
#[derive(Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    aud: Audience,
    exp: f64,
    nonce: Option<String>,
    azp: Option<String>,
}

/// 檢查 ID token 的 `iss`、`aud`、`exp`、`nonce`，回傳 `sub`。
///
/// **不驗證 JWT 簽章**，依據：ID token 是伺服器自己經 TLS 直接從提供者的 token endpoint 取得的，
/// 不經過瀏覽器或其他中介。
/// - OpenID Connect Core 1.0 §3.1.3.7 第 6 點：ID token 由 client 與 token endpoint 直接通訊取得時，
///   「可以用 TLS 伺服器驗證取代檢查 token 簽章」來驗證發行者。
/// - Google（https://developers.google.com/identity/openid-connect/openid-connect ）：從 token endpoint
///   經無中介的 HTTPS 通道取得時，可以確信 token 來自 Google 且有效；只有從其他來源得到時才必須驗證。
/// - LINE（https://developers.line.biz/en/docs/line-login/verify-id-token/ ）：「除非 ID token 是直接從
///   LINE Platform 取得，否則要在伺服器驗證」。
///
/// 所以 token endpoint 網址必須是 https（正式設定固定是，見 [`ProviderEndpoints`]；只有測試注入本機 http）。
fn validate_id_token(
    token: &str,
    p: &ProviderConfig,
    nonce: &str,
    now_secs: u64,
) -> Result<String, &'static str> {
    let mut parts = token.split('.');
    let (Some(_header), Some(payload), Some(_signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("id_token is not a JWT");
    };
    let payload = B64
        .decode(payload.trim_end_matches('='))
        .map_err(|_| "id_token payload is not base64url")?;
    let claims: Claims =
        serde_json::from_slice(&payload).map_err(|_| "id_token payload missing claims")?;
    if !p.endpoints.issuers.contains(&claims.iss) {
        return Err("id_token iss mismatch");
    }
    let aud_ok = match &claims.aud {
        Audience::One(aud) => *aud == p.client_id,
        // 多個 audience 時 OIDC 要求 azp 是我方 client id。
        Audience::Many(list) => {
            list.contains(&p.client_id)
                && (list.len() == 1 || claims.azp.as_deref() == Some(&p.client_id))
        }
    };
    if !aud_ok {
        return Err("id_token aud mismatch");
    }
    if !(claims.exp.is_finite() && claims.exp > now_secs as f64) {
        return Err("id_token expired");
    }
    if claims.nonce.as_deref() != Some(nonce) {
        return Err("id_token nonce mismatch");
    }
    if claims.sub.is_empty() || claims.sub.len() > MAX_SUB_BYTES {
        return Err("id_token sub invalid");
    }
    Ok(claims.sub)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::MAX_SESSION_BYTES;

    const NOW: u64 = 1_794_787_200;
    fn signer() -> Signer {
        Signer::new(b"0123456789abcdef0123456789abcdef".to_vec())
    }

    #[test]
    fn session_round_trip() {
        let s = signer();
        for (provider, sub) in [
            (ProviderKind::Google, "110169484474386276334"),
            (ProviderKind::Line, "U4af4980629a1b2c3d4e5f6a7b8c9d0e1"),
            (ProviderKind::Google, "with:colons:inside"),
        ] {
            let token = s.issue_session(provider, sub, NOW);
            assert_eq!(
                s.verify_session(&token, NOW + 1),
                Some(Identity {
                    provider,
                    sub: sub.into()
                })
            );
        }
    }

    #[test]
    fn tampering_any_bit_fails() {
        let s = signer();
        let token = s.issue_session(ProviderKind::Google, "12345", NOW);
        let bytes = token.as_bytes();
        for i in 0..bytes.len() {
            for bit in 0..8 {
                let mut changed = bytes.to_vec();
                changed[i] ^= 1 << bit;
                let Ok(changed) = String::from_utf8(changed) else {
                    continue;
                };
                assert_eq!(s.verify_session(&changed, NOW), None, "byte {i} bit {bit}");
            }
        }
        // 換掉提供者（payload 重新編碼但沿用原簽章）也不行
        let (_, tag) = token.split_once('.').unwrap();
        let forged = format!(
            "{}.{tag}",
            B64.encode(format!("l:{}:12345", NOW + SESSION_TTL_SECS))
        );
        assert_eq!(s.verify_session(&forged, NOW), None);
        for garbage in ["", ".", "abc", "a.b", "..", &format!("{token}.x")] {
            assert_eq!(s.verify_session(garbage, NOW), None, "{garbage}");
        }
    }

    #[test]
    fn expired_session_fails() {
        let s = signer();
        let token = s.issue_session(ProviderKind::Line, "U1", NOW);
        assert!(
            s.verify_session(&token, NOW + SESSION_TTL_SECS - 1)
                .is_some()
        );
        assert_eq!(s.verify_session(&token, NOW + SESSION_TTL_SECS), None);
    }

    #[test]
    fn different_secret_fails() {
        let token = signer().issue_session(ProviderKind::Google, "1", NOW);
        let other = Signer::new(b"another-secret-another-secret-123".to_vec());
        assert_eq!(other.verify_session(&token, NOW), None);
    }

    #[test]
    fn purposes_are_separated() {
        // 用流程 cookie 的簽章冒充 session 權杖不行。
        let s = signer();
        let payload = format!("g:{}:1", NOW + 100);
        let as_cookie = s.sign(b"oauth-cookie", payload.as_bytes());
        assert_eq!(s.verify_session(&as_cookie, NOW), None);
    }

    #[test]
    fn session_tokens_fit_the_hello_limit() {
        let token = signer().issue_session(
            ProviderKind::Google,
            &"9".repeat(MAX_SUB_BYTES),
            u64::MAX / 2,
        );
        assert!(token.len() <= MAX_SESSION_BYTES, "{}", token.len());
        // 一般長度（LINE 的 sub）約 100 bytes
        let typical =
            signer().issue_session(ProviderKind::Line, &format!("U{}", "a".repeat(32)), NOW);
        assert!(typical.len() < 120, "{}", typical.len());
    }

    fn line() -> ProviderConfig {
        ProviderConfig {
            kind: ProviderKind::Line,
            client_id: "1234567890".into(),
            client_secret: "secret".into(),
            endpoints: ProviderEndpoints::line(),
        }
    }
    fn jwt(claims: serde_json::Value) -> String {
        format!(
            "{}.{}.sig",
            B64.encode(br#"{"alg":"HS256"}"#),
            B64.encode(claims.to_string())
        )
    }

    #[test]
    fn id_token_claims_are_checked() {
        let p = line();
        let good = serde_json::json!({
            "iss": "https://access.line.me", "sub": "U1", "aud": "1234567890",
            "exp": NOW + 60, "iat": NOW, "nonce": "n1",
        });
        assert_eq!(
            validate_id_token(&jwt(good.clone()), &p, "n1", NOW),
            Ok("U1".into())
        );
        let with = |key: &str, value: serde_json::Value| {
            let mut c = good.clone();
            c[key] = value;
            jwt(c)
        };
        for (name, token) in [
            ("iss", with("iss", "https://evil.example".into())),
            ("aud", with("aud", "999".into())),
            ("aud list", with("aud", serde_json::json!(["999"]))),
            (
                "aud list without azp",
                with("aud", serde_json::json!(["1234567890", "999"])),
            ),
            ("exp", with("exp", (NOW - 1).into())),
            ("exp now", with("exp", NOW.into())),
            ("nonce", with("nonce", "other".into())),
            ("nonce missing", with("nonce", serde_json::Value::Null)),
            ("sub empty", with("sub", "".into())),
            (
                "sub too long",
                with("sub", "x".repeat(MAX_SUB_BYTES + 1).into()),
            ),
            ("not a jwt", "abc".into()),
            ("four parts", format!("{}.x", jwt(good.clone()))),
        ] {
            assert!(validate_id_token(&token, &p, "n1", NOW).is_err(), "{name}");
        }
        let mut google = line();
        google.kind = ProviderKind::Google;
        google.endpoints = ProviderEndpoints::google();
        for iss in ["https://accounts.google.com", "accounts.google.com"] {
            let token = with("iss", iss.into());
            assert!(
                validate_id_token(&token, &google, "n1", NOW).is_ok(),
                "{iss}"
            );
        }
        let token = with("aud", serde_json::json!(["1234567890", "999"]));
        let mut c: serde_json::Value =
            serde_json::from_slice(&B64.decode(token.split('.').nth(1).unwrap()).unwrap()).unwrap();
        c["azp"] = "1234567890".into();
        assert!(validate_id_token(&jwt(c), &p, "n1", NOW).is_ok());
    }

    #[test]
    fn flow_cookie_is_found_among_others() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; temple_auth=xyz; b=2"),
        );
        assert_eq!(flow_cookie(&headers), Some("xyz"));
        headers.insert(header::COOKIE, HeaderValue::from_static("temple_authx=1"));
        assert_eq!(flow_cookie(&headers), None);
    }
}
