# Security Audit Report: Shaolin-Temple (`erictheng93/Shaolin-Temple`)

**Target Repository:** `erictheng93/Shaolin-Temple`  
**Audit Date:** 2026-11-20  
**Auditor:** Antigravity Security Agent  
**Classification:** Defensive Security Assessment  

---

## Executive Summary

A comprehensive, defense-in-depth security audit of the `Shaolin-Temple` codebase was conducted, covering:
1. **Authentication & Identity Flow (`server/src/auth.rs`)**: OAuth 2.0 / OpenID Connect (Google, LINE), PKCE S256 verifiers, HMAC-SHA256 session token generation and verification, ID token validation.
2. **Networking & Wire Protocol v4 (`server/src/ws.rs`, `server/src/protocol.rs`)**: Axum WebSocket upgrade, Origin header validation, binary and JSON frame decoders, message size caps, rate limiting (`RateLimiter`), and idle timeouts.
3. **Room Actor & Gameplay Validation (`server/src/room.rs`, `server/src/world.rs`)**: Spatial boundary clamping, movement budget enforcement (`world::MOVE_SPEED * SPEED_MARGIN`), obstacle collision checking (`blocked`), session resumption (`resumeToken`), and disconnect grace periods.
4. **Metrics & Observability (`server/src/metrics.rs`)**: Prometheus endpoint, Bearer token authorization verification.
5. **Deployment & Static Web Delivery (`web/deploy/nginx.conf`, `web/public/_headers`)**: Nginx static server configuration, Cloudflare Pages headers, Dockerfiles, and container hardening.

Four distinct security findings were identified and documented as tracked GitHub issue tickets on [`erictheng93/Shaolin-Temple`](https://github.com/erictheng93/Shaolin-Temple), complete with labels, root cause analysis, and concrete code remediation patches.

---

## Severity & Issue Tracking Summary

| Issue ID | Title | Severity | Labels | Affected Components | GitHub Issue |
|---|---|---|---|---|---|
| **SEC-01** | Denial of Service and login starvation via OAuth callback semaphore exhaustion | **Medium-High** | `security`, `bug` | `server/src/auth.rs` | [#31](https://github.com/erictheng93/Shaolin-Temple/issues/31) |
| **SEC-02** | Timing attack vulnerability in Prometheus bearer token comparison | **Low-Medium** | `security`, `bug` | `server/src/metrics.rs` | [#32](https://github.com/erictheng93/Shaolin-Temple/issues/32) |
| **SEC-03** | Unicode Bidirectional Override and zero-width characters in player names | **Low-Medium** | `security`, `bug` | `server/src/protocol.rs`, `web/src/game/core/names.ts` | [#33](https://github.com/erictheng93/Shaolin-Temple/issues/33) |
| **SEC-04** | Missing defense-in-depth HTTP security headers in Nginx and Cloudflare Pages configurations | **Low-Medium** | `security`, `enhancement` | `web/deploy/nginx.conf`, `web/public/_headers` | [#34](https://github.com/erictheng93/Shaolin-Temple/issues/34) |

---

## Detailed Findings & Solutions

### 1. SEC-01 (Issue #31): DoS / Login Starvation via OAuth Callback Semaphore Exhaustion

- **Severity**: Medium-High (Availability / Denial of Service)
- **Affected Components**: `server/src/auth.rs` (`MAX_CONCURRENT_EXCHANGES`, `callback`, `exchange`)
- **GitHub Issue**: [#31](https://github.com/erictheng93/Shaolin-Temple/issues/31)

#### Root Cause Analysis
In `server/src/auth.rs`:
1. The server limits concurrent outbound token requests across all providers using a `tokio::sync::Semaphore(MAX_CONCURRENT_EXCHANGES)` where `MAX_CONCURRENT_EXCHANGES = 8`.
2. When handling `/auth/{provider}/callback`:
   ```rust
   // 拿不到名額就不等待、直接失敗（等待會讓大量請求堆在伺服器上）。名額在換完權杖後釋放。
   let Ok(slot) = auth.exchange_slots.try_acquire() else {
       return fail("failed", "too many concurrent token exchanges");
   };
   let exchanged = exchange(&auth.http, p, &redirect_uri, code, &cookie.v).await;
   drop(slot);
   ```
3. A client can call `GET /auth/{provider}/start?origin=<allowed_origin>` to receive a valid HMAC-signed `FlowCookie` and `FlowState` with a 10-minute lifetime (`FLOW_TTL_SECS = 600`).
4. The server is completely stateless and does not track consumed flow states or nonces (`r`). An attacker can take a single valid cookie and state, and replay them concurrently with arbitrary dummy authorization codes (`code=dummy1`, `code=dummy2`, etc.).
5. Because signature verification passes, each request attempts to acquire an exchange permit. The permit is held while an outbound HTTPS POST request is made to the OAuth provider's token endpoint (`HTTP_TIMEOUT = Duration::from_secs(5)`).
6. By sending 8 concurrent requests with dummy codes, all semaphore slots become occupied. Because `try_acquire()` is non-blocking with zero wait time, any legitimate user returning from Google or LINE OAuth during this window will fail immediately with `too many concurrent token exchanges` and be redirected to `/#auth_error=failed`.
7. Because there is no in-process rate limiting on `/auth` endpoints, an attacker can continuously starve the login service with minimal bandwidth and trivial effort.

#### Suggested Solution
1. **Track Consumed Flow Nonces (Single-Use Defense)**:  
   Maintain a short-lived in-memory cache/LRU of recently consumed nonces (`r`) with TTL matching `FLOW_TTL_SECS` (10 minutes). When a callback request enters, check and mark `r` as consumed. Any replayed callback with the same flow state/cookie is rejected immediately *before* attempting to acquire a semaphore permit or querying the upstream provider:
   ```rust
   // In AppState or AuthState:
   if !auth.mark_flow_nonce_used(&cookie.r, now) {
       return fail("failed", "login flow already used or expired");
   }
   ```
2. **Permit Wait Queue with Timeout**:  
   Instead of non-blocking `try_acquire()`, allow incoming callbacks to wait briefly (e.g., 1–2 seconds) for a slot to free up, preventing burst rejections:
   ```rust
   let Ok(slot) = tokio::time::timeout(Duration::from_secs(2), auth.exchange_slots.acquire()).await else {
       return fail("failed", "token exchange busy");
   };
   ```
3. **In-process Rate Limiting**:  
   Add per-IP rate limiting (e.g. `tower_governor` or a token bucket) on `/auth/{provider}/start` and `/auth/{provider}/callback` endpoints to prevent single-source flooding.

---

### 2. SEC-02 (Issue #32): Timing Attack in Prometheus Bearer Token Comparison

- **Severity**: Low-Medium (Information Disclosure / Side-Channel Timing Leak)
- **Affected Components**: `server/src/metrics.rs` (`token_matches`, `handler`)
- **GitHub Issue**: [#32](https://github.com/erictheng93/Shaolin-Temple/issues/32)

#### Root Cause Analysis
In `server/src/metrics.rs`:
```rust
/// 比較權杖時不因第一個不同字元就提早返回。
fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    let mut diff = a.len() ^ b.len();
    for (i, x) in a.iter().enumerate() {
        diff |= usize::from(x ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}
```

While intended to prevent early returns, this custom comparison has multiple security flaws:
1. **Length Leak via Loop Bounds**: The loop explicitly iterates `a.len()` times (`expected.as_bytes()`). If an attacker provides strings of various lengths, the execution time or cache footprint is tied directly to the secret token length `a.len()`.
2. **Compiler Optimization Hazard**: LLVM optimizer does not treat `diff |= ...` as an opaque constant-time operation. Because `diff` is monotonically non-decreasing in bits set and cannot revert to `0` once `diff != 0`, compiler passes (such as loop vectorization, unrolling, or early-exit optimization) are permitted to short-circuit the loop or introduce non-constant timing branches.
3. **Standard Best Practices**: Standard cryptographic engineering avoids hand-rolled XOR loops in favor of hardware-level or compiler-fenced constant-time comparison crates (e.g. `subtle::ConstantTimeEq`, which is already in `Cargo.lock` transitively via `hmac`).

#### Suggested Solution
Compare fixed-length cryptographic hashes (such as SHA-256) of both tokens using `subtle::ConstantTimeEq`:
```rust
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

fn token_matches(expected: &str, given: &str) -> bool {
    let expected_hash = Sha256::digest(expected.as_bytes());
    let given_hash = Sha256::digest(given.as_bytes());
    expected_hash.ct_eq(&given_hash).into()
}
```
Hashing both inputs before comparison eliminates token length leakage, ensures fixed 32-byte comparison, and leverages `subtle::ConstantTimeEq` with compiler optimization barriers.

---

### 3. SEC-03 (Issue #33): Unicode Bidirectional Override and Zero-Width Characters in Player Names

- **Severity**: Low-Medium (Integrity / Spoofing / Impersonation)
- **Affected Components**: `server/src/protocol.rs` (`clean_name`), `web/src/game/core/names.ts` (`normalizeName`), `web/scripts/mock-server.mjs` (`cleanName`), `web/src/ui/ChatPanel.vue`
- **GitHub Issue**: [#33](https://github.com/erictheng93/Shaolin-Temple/issues/33)

#### Root Cause Analysis
In `server/src/protocol.rs`:
```rust
pub fn clean_name(name: &str) -> String {
    let filtered: String = name.chars().filter(|c| !c.is_control()).collect();
    let name: String = filtered.trim().chars().take(16).collect();
    if name.is_empty() {
        "訪客".into()
    } else {
        name
    }
}
```
And in `web/src/game/core/names.ts`:
```typescript
export function normalizeName(name: string, rng: () => number = Math.random): string {
  const s = [...name.replace(/\p{Cc}/gu, '').trim()].slice(0, NAME_MAX_CHARS).join('').trim()
  return s || randomTempleName(rng)
}
```

By comparison, `clean_chat` (server) and `sanitizeChat` (client) explicitly recognized and stripped these characters:
```rust
// In clean_chat:
!(c.is_control() || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
```

Because Unicode Category `Cf` (Format) characters are neither ISO control characters (`\p{Cc}`) nor standard whitespace:
1. **Invisible Names**: A name composed solely of zero-width spaces (`\u{200B}`) passes `.trim()` and `!is_empty()`. The server accepts it instead of defaulting to `"訪客"`. In the 3D scene, `Nameplate.ts` generates a blank 24px pill with no visible name, making the player anonymous or difficult to identify.
2. **Name Spoofing & Bidi Override**: Injecting Right-to-Left Override (`\u{202E}` RLO) allows malicious players to reverse rendered text. An attacker can craft names that mimic official temple titles or spoof another player's name.
3. **Chat Direction Leakage**: In `ChatPanel.vue`:
   ```vue
   <span class="who">{{ t('chat.who', { name: c.name }) }}</span><span class="msg">{{ c.text }}</span>
   ```
   If `c.name` contains unclosed Bidi overrides like RLO, the directional formatting can spill over into adjacent text elements (the colon and message text).

#### Suggested Solution
Align `clean_name` with `clean_chat` across both server and client implementations.

1. **In `server/src/protocol.rs` (`clean_name`)**:
```rust
pub fn clean_name(name: &str) -> String {
    let filtered: String = name
        .chars()
        .filter(|c| {
            !(c.is_control()
                || matches!(
                    c,
                    '\u{200B}'..='\u{200F}'
                        | '\u{202A}'..='\u{202E}'
                        | '\u{2066}'..='\u{2069}'
                        | '\u{FEFF}'
                ))
        })
        .collect();
    let name: String = filtered.trim().chars().take(16).collect();
    if name.is_empty() {
        "訪客".into()
    } else {
        name
    }
}
```

2. **In `web/src/game/core/names.ts` (`normalizeName`)**:
```typescript
export function normalizeName(name: string, rng: () => number = Math.random): string {
  const cleaned = name
    .replace(/[​-‏‪-‮⁦-⁩﻿]/gu, '')
    .replace(/\p{Cc}/gu, '')
    .trim()
  const s = Array.from(cleaned).slice(0, NAME_MAX_CHARS).join('').trim()
  return s || randomTempleName(rng)
}
```

---

### 4. SEC-04 (Issue #34): Missing Defense-in-Depth HTTP Security Headers

- **Severity**: Low-Medium (Hardening / Clickjacking / Cross-Origin Leaks)
- **Affected Components**: `web/deploy/nginx.conf`, `web/public/_headers`
- **GitHub Issue**: [#34](https://github.com/erictheng93/Shaolin-Temple/issues/34)

#### Root Cause Analysis
1. In `web/deploy/nginx.conf`, only `Cache-Control` headers are configured inside `location` blocks.
2. In `web/public/_headers`, only `Cache-Control` headers are configured for asset paths.
3. No defense-in-depth security headers are sent to the client:
   - **Clickjacking / Framing**: Without `X-Frame-Options: DENY` (or `Content-Security-Policy: frame-ancestors 'none';`), third-party websites can embed the game inside transparent iframes to trick users into unintentional interactions or UI redress attacks.
   - **MIME Confusion**: Without `X-Content-Type-Options: nosniff`, browsers may attempt to sniff MIME types of downloaded resources.
   - **Referrer Leakage**: Without `Referrer-Policy: strict-origin-when-cross-origin` (or `no-referrer`), URL paths/queries might be sent in referrers to external domains when loading external assets or following links (such as CC-BY sketchfab credits).
   - **Hardware Permissions**: Without `Permissions-Policy`, default browser permissions allow querying geolocation, camera, and microphone.
4. **Nginx Header Inheritance Pitfall**: In Nginx, if `add_header` is declared in an outer block (`server`), any `location` block containing its own `add_header` (such as `add_header Cache-Control ...`) will **suppress** all outer `add_header` directives unless repeated or structured properly.

#### Suggested Solution

1. **Update `web/deploy/nginx.conf`**:
Add standard security headers:
```nginx
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
add_header Content-Security-Policy "frame-ancestors 'none';" always;
```

2. **Update `web/public/_headers`**:
Add global security headers for all routes:
```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Content-Security-Policy: frame-ancestors 'none';
```
