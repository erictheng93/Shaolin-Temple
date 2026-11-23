// 開發用 mock 遊戲伺服器：實作 src/game/net/protocol.ts 的協定草案，供 Rust 後端完成前測試前端。
// 不是正式伺服器，不做權限、持久化或容量設計。
// 與正式伺服器相同的行為：房內短編號 n、moves／sync／action 只送同場景（例外：庭院的 bell 送全房）、zone／join／leave 送全房、
// 衣裝 outfit（hello 可帶、執行中以 outfit 訊息更換、斷線保留期內以 resumeToken 恢復並保留）、
// 切換場景後先廣播 zone 再對切換者送 sync、移動中超過 1 秒沒有位置就視為停止、
// 協定版本 4：moves／sync／action 以二進位幀送出（與前端共用 src/game/net/binaryFrame.ts 的編碼器），hello.v 不符時回 unsupported_version；
// hello.session → welcome.auth、rename → 對同房所有人（含本人、不分場景）廣播 name，名字清理規則與正式伺服器相同。
//
// 開發用假登入（同一個埠的 HTTP，讓沒有真實 Google／LINE 憑證時也能在瀏覽器走完登入流程）——沒有任何安全性，不可用於正式環境：
//   GET /auth/providers            → {"providers":["google","line"]}（含 CORS）
//   GET /auth/<provider>/start?origin=<origin> → 302 回 <origin>/#session=mock.<provider>&provider=<provider>
//                                     （origin 只接受 http://localhost:* 與 http://127.0.0.1:*；?fail=cancelled|failed 模擬失敗）
//   hello.session 是 mock.google／mock.line 時 welcome.auth 回對應值，其他一律 guest（模擬權杖失效）。
//
// 用法：node scripts/mock-server.mjs [機器人數量=6] [埠=8080]（需 Node 22.18 以上，直接載入 .ts 的型別移除）
// 前端：在 web/.env.local 設定 VITE_WS_URL=ws://localhost:8080/ws
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import RAPIER from '@dimforge/rapier3d-compat'
import { createSimWorld } from '../src/game/vehicles/simCore.ts'
import { dequantizeDrive } from '../src/game/vehicles/drive.ts'
import { MIN_DIST, TOLERANCE, resolveMove, separate } from '../src/game/world/collide.ts'
import { OBSTACLES } from '../src/game/world/layout.ts'
import { VEHICLES, sessionState } from '../src/game/world/vehicles.ts'
import { BELL_PAVILION, PLAYER_RADIUS, SOLIDS, TREE_SOLIDS, WORLD_BOUNDS } from '../src/game/world/layout.ts'
import { randomTempleName } from '../src/game/core/names.ts'
import { ACTION_CODES, MAX_CARS, MAX_MOVES_PER_MESSAGE, MAX_SHORT_ID, encodeAction, encodeBatch, encodeCars } from '../src/game/net/binaryFrame.ts'

const PROTOCOL_VERSION = 6 // 與 src/game/net/protocol.ts 一致
const PROVIDERS = ['google', 'line']
/** 改名頻率上限：與正式伺服器相同，約每 2 秒 1 次（超過的直接忽略）。 */
const RENAME_MIN_INTERVAL_MS = 2000

const BOTS = Number(process.argv[2] ?? 6)
const PORT = Number(process.argv[3] ?? 8080)
if (!(BOTS >= 0 && BOTS <= MAX_SHORT_ID)) {
  // 二進位幀的短編號只有 0～127，mock 只有一個房間，機器人與真人共用。
  console.error(`機器人數量須在 0～${MAX_SHORT_ID}`)
  process.exit(1)
}
// 動作允許清單＝二進位幀的動作編號對照表（binaryFrame.ts 的 ACTION_CODES，測試保證與 server/src/world.rs 的 ACTIONS 相同）
// chant_end：誦經中提前起身（客戶端送出，轉送給同場景的人）
const ACTIONS = ACTION_CODES
// 機器人只做該場景能做的動作（跪拜、誦經限殿內，敲鐘限庭院）；敲鐘會走到鐘亭站位，不會走到蒲團或香爐前，上香不會在香爐插香
const BOT_ACTIONS = { courtyard: ['bow', 'bell'], hall: ['bow', 'prostrate', 'chant'] }
// 機器人做這些動作時停留到動作結束再走（客戶端在動作期間不顯示走路）；誦經 24 秒、跪拜 8 秒
const BOT_HOLD_S = { chant: 25, prostrate: 9, bell: 4 }
// 機器人敲鐘時遵守與客戶端相同的「鐘聲未歇」：任何人敲鐘後 7 秒內不再敲（合力的一組算一聲，見 startBellCrew）
const BOT_BELL_GAP_MS = 7000
let lastBellAt = 0
const ZONES = ['courtyard', 'hall']
// 機器人隨機走動的範圍（未避開障礙物，僅供測試）
const ROAM = {
  courtyard: { x: [-12, 12], z: [-3, 11] },
  hall: { x: [-6, 6], z: [-2.5, 7.5] },
}
const pick = ([a, b]) => a + Math.random() * (b - a)
// 聊天（與正式伺服器相同的規則）：清理（空白壓縮、移除控制與雙向覆寫字元、截到 80 字元）、突發 3 則每 2 秒補 1 則、全房廣播含發話者。
// 這裡刻意不 import protocol.ts（它的相對匯入沒有副檔名，Node 直接載入會失敗），規則重寫一份，兩邊由測試與正式伺服器的固定資料對照。
const CHAT_MAX_CHARS = 80
const sanitizeChat = (text) =>
  Array.from(String(text).replace(/[​-‏‪-‮⁦-⁩﻿]/gu, '').replace(/\s+/gu, ' ').replace(/\p{Cc}/gu, '').trim())
    .slice(0, CHAT_MAX_CHARS)
    .join('')
    .trim()
// 限速的 token bucket（突發 3 則、每 2 秒補 1 則）；聊天與更換衣裝各自獨立計數。
const takeToken = (p, key) => {
  const t = now()
  const buckets = (p.buckets ??= {})
  const b = (buckets[key] ??= { tokens: 3, at: t })
  b.tokens = Math.min(3, b.tokens + (t - b.at) / 2000)
  b.at = t
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}
const takeChatToken = (p) => takeToken(p, 'chat')
// 衣裝：編號 0..OUTFIT_COUNT-1（與 src/game/net/protocol.ts 的 OUTFIT_COUNT 相同；這裡不能 import protocol.ts，見上）。
// 缺少或無效一律當作 0（hello），或丟棄（outfit 訊息）；與目前相同不廣播。
const OUTFIT_COUNT = 8
const validOutfit = (v) => Number.isInteger(v) && v >= 0 && v < OUTFIT_COUNT
const RESUME_GRACE_MS = 30_000
const broadcastChat = (from, raw) => {
  const text = sanitizeChat(raw)
  if (text) broadcast({ t: 'chat', id: from.id, text, at: now() })
}
const BOT_LINES = ['阿彌陀佛', '早安', '這裡好安靜', '鐘聲真好聽', '南無觀世音菩薩', '今天天氣真好', '來上炷香吧', '心靜自然涼']
/** 名字清理（與正式伺服器相同）：去控制字元、trim、最多 16 個 Unicode 字元，空白變「訪客」。 */
const cleanName = (raw) => {
  const s = [...String(typeof raw === 'string' ? raw : '').replace(/\p{Cc}/gu, '').trim()].slice(0, 16).join('').trim()
  return s || '訪客'
}
const authOf = (session) => (session === 'mock.google' ? 'google' : session === 'mock.line' ? 'line' : 'guest')
const isDevOrigin = (origin) => {
  try {
    const u = new URL(origin)
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.origin === origin
  } catch {
    return false
  }
}

// 開發用假登入的 HTTP 端點（與 WebSocket 共用同一個埠）
const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const cors = { 'Access-Control-Allow-Origin': '*' }
  if (req.method === 'GET' && url.pathname === '/auth/providers') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ providers: PROVIDERS }))
    return
  }
  const m = /^\/auth\/([a-z]+)\/start$/.exec(url.pathname)
  if (req.method === 'GET' && m && PROVIDERS.includes(m[1])) {
    const origin = url.searchParams.get('origin') ?? ''
    if (!isDevOrigin(origin)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('origin 只接受 http://localhost:* 或 http://127.0.0.1:*')
      return
    }
    const fail = url.searchParams.get('fail')
    const fragment = fail ? `auth_error=${fail === 'cancelled' ? 'cancelled' : 'failed'}` : `session=mock.${m[1]}&provider=${m[1]}`
    res.writeHead(302, { Location: `${origin}/#${fragment}`, 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  res.writeHead(404, cors)
  res.end()
})
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 })
http.listen(PORT)
const STOP_WATCHDOG_MS = 1000
const players = new Map() // id -> { id, n, name, x, z, heading, zone, moving, lastPosAt, riding?, lastDriveSeq?, lastActiveDrive?, claimAt?, ws?, bot? }
const seenReq = new Map() // reqId -> ack（模擬伺服器去重）
const dirty = new Set() // 本 tick 有變動的玩家，tick 內合併成 moves
const r2 = (v) => Math.round(v * 100) / 100
const queueMove = (p, moving) => {
  p.moving = moving
  dirty.add(p)
}

// ---- 玩家之間的硬碰撞（與正式伺服器同一套規則，world/collide.ts）----
/** 驗證時取對方幾個 tick 之前的位置（補償插值與延遲）。 */
const VIEW_DELAY_TICKS = 2
/** 定點動作的大約長度（毫秒）：期間推不動。mock 用的近似值，正式伺服器以動作表為準。 */
const ROOT_MS = { prostrate: 6000, chant: 24000, incense: 6000, bell: 4000 }
const collides = (p) => !p.riding && p.riding !== 0 && players.get(p.id) === p
const rooted = (p) => (p.rootedUntil ?? 0) > Date.now()
/** 庭院檢查邊界與障礙物；殿內只有 mock 不知道的擺設，這裡一律放行。 */
const validAt = (zone) => (x, z) =>
  zone !== 'courtyard' ||
  (x >= WORLD_BOUNDS.minX && x <= WORLD_BOUNDS.maxX && z >= WORLD_BOUNDS.minZ && z <= WORLD_BOUNDS.maxZ &&
    !OBSTACLES.some((o) => x > o.minX && x < o.maxX && z > o.minZ && z < o.maxZ))
const syncSelf = (p) => {
  if (p.ws) sendTuples(p.ws, 'sync', [tuple(p)])
}
/** 把 p 放到想去的位置並處理碰撞。past 為 true 時對方的位置取幾個 tick 之前的（驗證真人送來的位置）。 */
const moveWithCollision = (p, x, z, tolerance, past) => {
  const others = [...players.values()]
    .filter((o) => o !== p && o.zone === p.zone && collides(o))
    .map((o) => {
      const at = past && o.trail?.length ? o.trail[Math.min(VIEW_DELAY_TICKS, o.trail.length) - 1] : o
      return { n: o.n, x: at.x, z: at.z, rooted: rooted(o), ref: o, fromX: at.x, fromZ: at.z }
    })
  const r = resolveMove({ x, z }, { x: p.x, z: p.z }, others, tolerance, validAt(p.zone))
  const corrected = Math.hypot(r.x - x, r.z - z) > 0.05
  p.x = corrected ? r.x : x
  p.z = corrected ? r.z : z
  if (corrected) syncSelf(p)
  for (const m of r.moved) {
    const o = others.find((b) => b.n === m.n)
    // 推的是對方「現在」的位置：把位移量加上去，不合法就不動。位移是對歷史位置算的、會被好幾則訊息重複使用，
    // 所以只推到與 p 這次的位置分開（MIN_DIST）為止（與正式伺服器相同）
    const dx = m.x - o.fromX
    const dz = m.z - o.fromZ
    const need = MIN_DIST - Math.hypot(o.ref.x - p.x, o.ref.z - p.z)
    const len = Math.hypot(dx, dz)
    if (need <= 0 || len < 1e-9) continue
    const k = Math.min(1, need / len)
    const nx = o.ref.x + dx * k
    const nz = o.ref.z + dz * k
    if (!validAt(p.zone)(nx, nz)) continue
    o.ref.x = nx
    o.ref.z = nz
    dirty.add(o.ref)
    syncSelf(o.ref)
  }
}
const tuple = (p) => [p.n, r2(p.x), r2(p.z), r2(p.heading), p.moving ? 1 : 0]
let nextId = 1

await RAPIER.init()
const sim = createSimWorld(RAPIER, SOLIDS, WORLD_BOUNDS, VEHICLES, TREE_SOLIDS)
const pendingBump = new Map() // c -> { bump, force }，自上次廣播以來力最大的碰撞
const cars = new Map() // c -> { c, kind, driver, emptySince, fadeAt, lastInputAt, lastActiveDrive }

const carSnapshot = (c) => {
  const car = cars.get(c)
  if (!car) return null
  const st = sim.state(c)
  if (!st) return null
  return {
    c,
    kind: car.kind,
    driver: car.driver,
    x: r2(st.x),
    z: r2(st.z),
    heading: r2(st.heading),
    fadeAt: car.fadeAt,
  }
}

const carSnapshots = () => {
  const list = []
  for (const c of cars.keys()) {
    const s = carSnapshot(c)
    if (s) list.push(s)
  }
  return list
}

const bayIsFree = (bx, bz) => {
  for (const c of cars.keys()) {
    const st = sim.state(c)
    if (st && Math.hypot(st.x - bx, st.z - bz) < 1.2) {
      return false
    }
  }
  return true
}

// 廟會時段（與正式伺服器同規則）：關閉時拒絕領車與上車；MOCK_SESSION=always 強制一律開放。
// fair 訊息（暫時的功能）：任何玩家都能手動開關，之後不再依時鐘，直到重啟。
let fairOverride = null
const sessionOpen = () => fairOverride ?? (process.env.MOCK_SESSION === 'always' || sessionState(Date.now()).open)
const SESSION_CLOSED = { t: 'error', code: 'session_closed', message: 'The temple fair is closed' }

const claimCar = (p, kind) => {
  if (!sessionOpen()) return null
  if (p.zone !== 'courtyard' || (p.riding !== undefined && p.riding !== null)) return null
  const dx = p.x - VEHICLES.booth.counter.x
  const dz = p.z - VEHICLES.booth.counter.z
  if (Math.hypot(dx, dz) > VEHICLES.ride.boothRadius) return null
  if (p.claimAt && now() - p.claimAt < VEHICLES.ride.claimCooldownMs) return null
  // 車種由伺服器依權重隨機分配（玩家不能挑）；已達數量上限的車種不參與抽選。
  if (kind === undefined || kind === null) {
    const stock = VEHICLES.kinds.map((k, i) => {
      let n = 0
      for (const car of cars.values()) if (car.kind === i) n++
      return n < k.count ? (k.weight ?? 1) : 0
    })
    let roll = Math.random() * stock.reduce((a, b) => a + b, 0)
    kind = stock.findIndex((w) => w > 0 && (roll -= w) < 0)
  }
  if (kind < 0 || kind >= VEHICLES.kinds.length) return null
  let count = 0
  for (const car of cars.values()) if (car.kind === kind) count++
  if (count >= VEHICLES.kinds[kind].count) return null

  const bay = VEHICLES.booth.bays.find((b) => bayIsFree(b.x, b.z))
  if (!bay) return null

  let c = -1
  for (let i = 0; i < MAX_CARS; i++) {
    if (!cars.has(i)) {
      c = i
      break
    }
  }
  if (c < 0) return null

  sim.spawn(c, bay.x, bay.z, bay.heading)
  sim.setOccupied(c, true)
  cars.set(c, {
    c,
    kind,
    driver: p.id,
    emptySince: null,
    fadeAt: null,
    lastInputAt: now(),
    lastActiveDrive: now(),
  })

  p.riding = c
  p.claimAt = now()
  p.lastDriveSeq = 0
  p.lastActiveDrive = now()
  p.moving = false
  dirty.delete(p)
  p.x = bay.x
  p.z = bay.z
  p.heading = bay.heading

  broadcast({
    t: 'car',
    c,
    kind,
    driver: p.id,
    x: bay.x,
    z: bay.z,
    heading: bay.heading,
    fadeAt: null,
  })
  return c
}

function distanceToCar(car, px, pz) {
  const dx = px - car.x
  const dz = pz - car.z
  const cos = Math.cos(car.heading)
  const sin = Math.sin(car.heading)
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
  const hw = VEHICLES.car.halfWidth
  const hl = VEHICLES.car.halfLength
  const qx = Math.max(0, Math.abs(lx) - hw)
  const qz = Math.max(0, Math.abs(lz) - hl)
  return Math.hypot(qx, qz)
}

function knockLanding(fromX, fromZ, dirX, dirZ, dist) {
  let targetX = fromX + dirX * dist
  let targetZ = fromZ + dirZ * dist
  targetX = Math.max(WORLD_BOUNDS.minX, Math.min(WORLD_BOUNDS.maxX, targetX))
  targetZ = Math.max(WORLD_BOUNDS.minZ, Math.min(WORLD_BOUNDS.maxZ, targetZ))
  return { x: targetX, z: targetZ }
}

const mountCar = (p, c) => {
  if (!sessionOpen()) return false
  if (p.zone !== 'courtyard' || (p.riding !== undefined && p.riding !== null)) return false
  const car = cars.get(c)
  if (!car || car.driver) return false
  const st = sim.state(c)
  if (!st) return false
  const dist = distanceToCar(st, p.x, p.z)
  if (dist > VEHICLES.ride.mountRadius) return false

  sim.setOccupied(c, true)
  car.driver = p.id
  car.emptySince = null
  car.fadeAt = null
  car.lastInputAt = now()
  car.lastActiveDrive = now()

  p.riding = c
  p.lastActiveDrive = now()
  p.moving = false
  dirty.delete(p)
  p.x = st.x
  p.z = st.z
  p.heading = st.heading

  broadcast({
    t: 'car',
    c,
    kind: car.kind,
    driver: p.id,
    x: st.x,
    z: st.z,
    heading: st.heading,
    fadeAt: null,
  })
  return true
}

const dismountPlayer = (p) => {
  const c = p.riding
  if (c === null || c === undefined) return
  p.riding = null

  const st = sim.state(c)
  const cx = st ? st.x : p.x
  const cz = st ? st.z : p.z
  const ch = st ? st.heading : p.heading

  const offset = VEHICLES.ride.dismountOffset
  const candidates = [
    { x: cx - offset * Math.cos(ch), z: cz + offset * Math.sin(ch) },
    { x: cx + offset * Math.cos(ch), z: cz - offset * Math.sin(ch) },
    { x: cx - offset * Math.sin(ch), z: cz - offset * Math.cos(ch) },
  ]
  let landing = { x: cx, z: cz }
  for (const cand of candidates) {
    if (
      cand.x >= WORLD_BOUNDS.minX &&
      cand.x <= WORLD_BOUNDS.maxX &&
      cand.z >= WORLD_BOUNDS.minZ &&
      cand.z <= WORLD_BOUNDS.maxZ &&
      SOLIDS.every((s) => cand.x < s.minX || cand.x > s.maxX || cand.z < s.minZ || cand.z > s.maxZ)
    ) {
      landing = cand
      break
    }
  }

  p.x = landing.x
  p.z = landing.z
  p.heading = ch
  p.moving = false
  dirty.delete(p)

  if (p.ws && p.ws.readyState === 1) {
    sendTuples(p.ws, 'sync', [tuple(p)])
  }

  sim.setOccupied(c, false)
  sim.setInput(c, { dir: 0, mag: 0 })

  const car = cars.get(c)
  const fadeAt = now() + VEHICLES.fade.idleMs
  if (car) {
    car.driver = null
    car.emptySince = now()
    car.fadeAt = fadeAt
  }

  broadcast({
    t: 'car',
    c,
    kind: car ? car.kind : 0,
    driver: null,
    x: cx,
    z: cz,
    heading: ch,
    fadeAt,
  })
}

// 時段結束：所有騎士下車，所有車立刻開始淡出（fadeMs 後移除；emptySince 往前推，讓既有的移除邏輯剛好在那時生效）。
const closeSession = () => {
  for (const p of players.values()) dismountPlayer(p)
  const t = now()
  for (const car of cars.values()) {
    if (car.fadeAt === null || car.fadeAt > t) {
      car.fadeAt = t
      car.emptySince = t - VEHICLES.fade.idleMs
    }
    const st = sim.state(car.c)
    if (st) broadcast({ t: 'car', c: car.c, kind: car.kind, driver: null, x: st.x, z: st.z, heading: st.heading, fadeAt: car.fadeAt })
  }
}
let sessionWasOpen = sessionOpen()
const inBoothZone = (p) => {
  const z = VEHICLES.booth.zone
  return p.x >= z.minX && p.x <= z.maxX && p.z >= z.minZ && p.z <= z.maxZ
}

// 物理世界模擬循環：30Hz。計時器的實際間隔不準（Windows 上常是 40 多毫秒），所以依經過的時間補步，
// 否則模擬會比真實時間慢，前端預測就一直被拉回來。每 2 步廣播一次 cars（15 Hz）。
const STEP_MS = 1000 / VEHICLES.physics.hz
let physicsAt = Date.now()
let physicsSteps = 0
const physicsStep = () => {
  const t = now()
  const open = sessionOpen()
  if (sessionWasOpen && !open) closeSession()
  sessionWasOpen = open
  for (const car of cars.values()) {
    if (car.driver && t - car.lastInputAt > VEHICLES.physics.inputTimeoutMs) {
      sim.setInput(car.c, { dir: 0, mag: 0 })
    }
  }
  for (const p of players.values()) {
    if (p.riding !== null && p.riding !== undefined) {
      const car = cars.get(p.riding)
      if (car && t - car.lastActiveDrive > VEHICLES.ride.idleDismountMs) {
        dismountPlayer(p)
      }
    }
  }
  for (const p of players.values()) {
    if (p.riding !== null && p.riding !== undefined) {
      const st = sim.state(p.riding)
      if (st) {
        p.x = st.x
        p.z = st.z
        p.heading = st.heading
        p.moving = false
      }
    }
  }
  // 廣播（15 Hz）比物理步（30 Hz）稀疏：把每步的碰撞累積成「這個廣播間隔內力最大者」，廣播後清除
  for (const b of sim.step()) {
    const prev = pendingBump.get(b.c)
    if (!prev || b.force > prev.force) pendingBump.set(b.c, { bump: b.bump, force: b.force })
  }

  // 撞飛檢測：在庭院且未騎乘的玩家若被高速車輛撞擊
  for (const car of cars.values()) {
    const st = sim.state(car.c)
    if (!st) continue
    const speed = Math.hypot(st.vx ?? 0, st.vz ?? 0)
    if (speed < VEHICLES.knock.minSpeed) continue
    const dirX = (st.vx ?? 0) / speed
    const dirZ = (st.vz ?? 0) / speed

    for (const pl of players.values()) {
      if (pl.zone !== 'courtyard' || (pl.riding !== null && pl.riding !== undefined)) continue
      if (pl.immuneUntil && t < pl.immuneUntil) continue
      if (inBoothZone(pl)) continue
      if (distanceToCar(st, pl.x, pl.z) <= VEHICLES.knock.hitRadius) {
        const dist = Math.min(
          VEHICLES.knock.maxDistance,
          Math.max(VEHICLES.knock.minDistance, speed * VEHICLES.knock.distancePerSpeed),
        )
        const landing = knockLanding(pl.x, pl.z, dirX, dirZ, dist)
        const flightDur = VEHICLES.knock.flightMs
        const recoverDur = VEHICLES.knock.recoverMs
        const immuneDur = VEHICLES.knock.immuneMs

        pl.knockedUntil = t + flightDur + recoverDur
        pl.immuneUntil = pl.knockedUntil + immuneDur
        const toX = Math.round(landing.x * 100) / 100
        const toZ = Math.round(landing.z * 100) / 100

        const msg = {
          t: 'knock',
          id: pl.id,
          x: Math.round(pl.x * 100) / 100,
          z: Math.round(pl.z * 100) / 100,
          toX,
          toZ,
          at: t,
        }
        pl.x = toX
        pl.z = toZ
        pl.moving = false
        dirty.delete(pl)

        broadcast(msg)
      }
    }
  }

  const maxEmpty = VEHICLES.fade.idleMs + VEHICLES.fade.fadeMs
  for (const [c, car] of cars.entries()) {
    if (!car.driver && car.emptySince && t - car.emptySince >= maxEmpty) {
      sim.remove(c)
      cars.delete(c)
      broadcast({ t: 'carGone', c })
    }
  }
  if (++physicsSteps % VEHICLES.physics.broadcastEverySteps === 0) broadcastCars()
}
const broadcastCars = () => {
  const allCars = sim.cars()
  const wireCars = allCars.map((s) => ({ ...s, bump: pendingBump.get(s.c)?.bump ?? 0 }))
  pendingBump.clear()
  if (!allCars.length) return
  for (const to of players.values()) {
    if (to.ws && to.ws.readyState === 1 && to.zone === 'courtyard') {
      const frame = encodeCars(to.lastDriveSeq ?? 0, wireCars)
      if (frame) to.ws.send(frame)
    }
  }
}
setInterval(() => {
  const t = now()
  let steps = Math.floor((t - physicsAt) / STEP_MS)
  if (steps > VEHICLES.physics.maxCatchUpSteps) {
    steps = VEHICLES.physics.maxCatchUpSteps
    physicsAt = t
  } else {
    physicsAt += steps * STEP_MS
  }
  for (let i = 0; i < steps; i++) physicsStep()
}, 10)
/** 房內短編號：取目前未使用的最小值，玩家離開後回收。超過 MAX_SHORT_ID（二進位幀只有 7 位元）時回傳 null。 */
const allocN = () => {
  const used = new Set([...players.values()].map((p) => p.n))
  let n = 0
  while (used.has(n)) n++
  return n <= MAX_SHORT_ID ? n : null
}

const now = () => Date.now()
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
/** 送給同房所有人（zone／join／leave）。 */
const broadcast = (msg, exceptId) => {
  for (const p of players.values()) if (p.ws && p.id !== exceptId) send(p.ws, msg)
}
/** 動作廣播（二進位幀）：只送給同場景的其他玩家；例外是庭院的敲鐘（bell），全寺都聽得見，送給同房所有其他玩家。 */
const broadcastAction = (from, id) => {
  const frame = encodeAction({ n: from.n, id, startedAt: now() })
  if (!frame) return
  const wholeRoom = id === 'bell' && from.zone === 'courtyard'
  for (const p of players.values()) {
    if (p.ws && (wholeRoom || p.zone === from.zone) && p !== from && p.ws.readyState === 1) p.ws.send(frame)
  }
}
/** 把 tuple 陣列依上限拆成多則二進位幀送出（sync 即使是空的也要送）。 */
const sendTuples = (ws, t, list) => {
  for (let i = 0; i === 0 || i < list.length; i += MAX_MOVES_PER_MESSAGE) {
    const frame = encodeBatch({ t, m: list.slice(i, i + MAX_MOVES_PER_MESSAGE) })
    if (frame && ws.readyState === 1) ws.send(frame)
  }
}
const snapshot = (p) => ({ id: p.id, n: p.n, name: p.name, x: p.x, z: p.z, heading: p.heading, zone: p.zone, outfit: p.outfit })

// 機器人：在廣場上隨機走動，偶爾做動作；每 4 個庭院機器人有 1 個會去檔口領車。
for (let i = 0; i < BOTS; i++) {
  const id = `bot-${i}`
  const zone = i % 3 === 2 ? 'hall' : 'courtyard'
  players.set(id, {
    id,
    n: allocN(),
    moving: false,
    lastPosAt: 0,
    name: randomTempleName(),
    x: pick(ROAM[zone].x),
    z: pick(ROAM[zone].z),
    heading: 0,
    zone,
    outfit: Math.floor(Math.random() * OUTFIT_COUNT),
    riding: null,
    bot: {
      tx: 0,
      tz: 0,
      wait: Math.random() * 3,
      chatIn: 5 + Math.random() * 40,
      canDrive: zone === 'courtyard' && i % 4 === 0,
      driveTime: 0,
      driveDir: 0,
      steerIn: 0,
      nextClaimAt: now() + 2000 + Math.random() * 6000,
    },
  })
}

// 鐘亭的三個敲鐘站位，抄自 world/bell.ts 的 BELL_STATIONS（那個檔案 import 了 i18n 目錄，Node 直接載入會失敗，所以這裡重算；改站位時兩邊一起改）
const BELL_STATIONS = [-1, 0, 1].map((i) => {
  const cx = (BELL_PAVILION.minX + BELL_PAVILION.maxX) / 2
  const cz = (BELL_PAVILION.minZ + BELL_PAVILION.maxZ) / 2
  const x = cx + i * 0.8
  const z = BELL_PAVILION.maxZ + PLAYER_RADIUS + 0.15
  return { x, z, heading: Math.atan2(cx - x, cz - z) }
})
/** 合力敲鐘的小隊：{ members, deadline }，同時只有一組。 */
let bellCrew = null
const BELL_CREW_WAIT_MS = 30_000
const BELL_STATION_FREE_M = 0.6
/** 以 leader 為首組隊：隨機 1／2／3 人（40／35／25%），受閒著的庭院機器人與沒人佔的站位限制，各分到不同站位後走過去。 */
const startBellCrew = (leader) => {
  const taken = (st) => [...players.values()].some((o) => o !== leader && o.zone === 'courtyard' && Math.hypot(o.x - st.x, o.z - st.z) < BELL_STATION_FREE_M)
  const stations = BELL_STATIONS.filter((st) => !taken(st)).sort(() => Math.random() - 0.5)
  const idle = [...players.values()].filter(
    (o) => o !== leader && o.bot && o.zone === 'courtyard' && !o.bot.bell && !(o.riding != null) && !rooted(o) && !(o.bot.canDrive && now() > (o.bot.nextClaimAt ?? 0)),
  ).sort(() => Math.random() - 0.5)
  const r = Math.random()
  const want = r < 0.4 ? 1 : r < 0.75 ? 2 : 3
  const members = [leader, ...idle].slice(0, Math.min(want, stations.length))
  if (!members.length) return
  members.forEach((m, i) => {
    m.bot.bell = stations[i]
    m.bot.bellArrived = false
    m.bot.tx = stations[i].x
    m.bot.tz = stations[i].z
    m.bot.wait = 0
  })
  bellCrew = { members, deadline: now() + BELL_CREW_WAIT_MS }
  console.log(`[mock] 合力敲鐘：${members.length} 人前往鐘亭`)
}
/** 全員到位（或逾時）就各自在 0～400 毫秒內送出 bell；沒到的放回閒晃。 */
const tickBellCrew = () => {
  if (!bellCrew) return
  const here = bellCrew.members.filter((m) => m.bot.bellArrived)
  if (here.length < bellCrew.members.length && now() < bellCrew.deadline) return
  const release = (m, wait) => {
    m.bot.bell = null
    m.bot.bellArrived = false
    m.bot.wait = wait
  }
  const crew = bellCrew
  bellCrew = null
  // 等待期間若有真人敲過鐘（lastBellAt 更新），這一聲取消，遵守鐘聲未歇
  if (!here.length || now() - lastBellAt < BOT_BELL_GAP_MS) {
    crew.members.forEach((m) => release(m, 0.5))
    return
  }
  lastBellAt = now()
  for (const m of crew.members) {
    if (!here.includes(m)) {
      release(m, 0.5)
      continue
    }
    m.rootedUntil = now() + ROOT_MS.bell + 400
    release(m, BOT_HOLD_S.bell + 0.4)
    setTimeout(() => players.get(m.id) === m && broadcastAction(m, 'bell'), Math.random() * 400)
  }
}

setInterval(() => {
  const dt = 0.1
  for (const p of players.values()) {
    if (!p.bot) continue
    const b = p.bot
    // 每 40～90 秒說一句（首句較早，方便測試）
    if ((b.chatIn -= dt) <= 0) {
      b.chatIn = 40 + Math.random() * 50
      broadcastChat(p, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)])
    }
    // 機器人開車邏輯
    if (p.riding !== null && p.riding !== undefined) {
      b.driveTime = (b.driveTime ?? 0) - dt
      b.steerIn = (b.steerIn ?? 0) - dt
      if (b.steerIn <= 0) {
        b.steerIn = 1 + Math.random() * 2
        b.driveDir = (Math.random() - 0.5) * Math.PI
      }
      sim.setInput(p.riding, { dir: b.driveDir, mag: 1.0 })
      const car = cars.get(p.riding)
      if (car) {
        car.lastInputAt = now()
        car.lastActiveDrive = now()
      }
      if (b.driveTime <= 0) {
        console.log(`[mock] 機器人 ${p.name} (${p.id}) 開車結束下車`)
        dismountPlayer(p)
        b.wait = 5 + Math.random() * 10
        b.nextClaimAt = now() + 25_000
      }
      continue
    }
    // 機器人領車邏輯：每 4 個庭院機器人有 1 個會去檔口領車
    if (p.zone === 'courtyard' && b.canDrive && !b.bell && now() > (b.nextClaimAt ?? 0)) {
      const dx = VEHICLES.booth.counter.x - p.x
      const dz = (VEHICLES.booth.counter.z + 1.5) - p.z
      const dist = Math.hypot(dx, dz)
      if (dist > VEHICLES.ride.boothRadius * 0.7) {
        b.tx = VEHICLES.booth.counter.x + (Math.random() - 0.5) * 1.5
        b.tz = VEHICLES.booth.counter.z + 1.2 + Math.random() * 0.8
        b.wait = 0
      } else {
        const kind = Math.floor(Math.random() * VEHICLES.kinds.length)
        const c = claimCar(p, kind)
        if (c !== null) {
          b.driveTime = 20 + Math.random() * 20
          b.driveDir = 0
          b.steerIn = 1.5
          console.log(`[mock] 機器人 ${p.name} (${p.id}) 於檔口領車 ${c} (車種 ${kind})，預計行駛 ${b.driveTime.toFixed(0)} 秒`)
        } else {
          b.nextClaimAt = now() + 10_000
        }
      }
    }
    if (b.wait > 0) {
      b.wait -= dt
      if (b.wait <= 0) {
        b.tx = pick(ROAM[p.zone].x)
        b.tz = pick(ROAM[p.zone].z)
      }
      continue
    }
    const dx = b.tx - p.x
    const dz = b.tz - p.z
    const d = Math.hypot(dx, dz)
    if (d < 0.2 && b.bell) {
      // 到站位：貼齊座標、面向鐘，站著等同伴（rootedUntil 讓全體分離不推開它）
      p.x = b.bell.x
      p.z = b.bell.z
      p.heading = b.bell.heading
      p.rootedUntil = bellCrew ? bellCrew.deadline : 0
      b.bellArrived = true
      b.wait = 0
      queueMove(p, false)
      continue
    }
    if (d < 0.2) {
      b.wait = 2 + Math.random() * 6
      queueMove(p, false)
      if (Math.random() < 0.6) {
        const id = BOT_ACTIONS[p.zone][Math.floor(Math.random() * BOT_ACTIONS[p.zone].length)]
        if (id === 'bell') {
          // 敲鐘改成「合力」：不原地敲，由這個機器人帶 0～2 個閒著的機器人一起走到鐘亭站位，到齊後才一起敲
          if (!bellCrew && now() - lastBellAt >= BOT_BELL_GAP_MS) startBellCrew(p)
          continue
        }
        b.wait = Math.max(b.wait, BOT_HOLD_S[id] ?? 0)
        if (ROOT_MS[id]) p.rootedUntil = now() + (BOT_HOLD_S[id] ?? 0) * 1000
        broadcastAction(p, id)
      }
      continue
    }
    const step = Math.min(d, 2.2 * dt)
    p.heading = Math.atan2(dx, dz)
    const fromX = p.x
    const fromZ = p.z
    moveWithCollision(p, p.x + (dx / d) * step, p.z + (dz / d) * step, 0, false)
    // 被擋住幾乎走不動：換一個目的地，免得機器人一直頂著人
    if (!b.bell && Math.hypot(p.x - fromX, p.z - fromZ) < step * 0.2 && Math.random() < 0.1) b.wait = 0.5
    queueMove(p, true)
  }
  tickBellCrew()
  // 每個 tick 的全體分離（剛進場、剛換場景時重疊的人慢慢分開），並記下這個 tick 的位置
  for (const zone of ZONES) {
    const here = [...players.values()].filter((p) => p.zone === zone && collides(p))
    for (const m of separate(here.map((p) => ({ n: p.n, x: p.x, z: p.z, rooted: rooted(p) })), validAt(zone))) {
      const p = here.find((q) => q.n === m.n)
      p.x = m.x
      p.z = m.z
      dirty.add(p)
      syncSelf(p)
    }
  }
  for (const p of players.values()) {
    p.trail = [{ x: p.x, z: p.z }, ...(p.trail ?? [])].slice(0, 4)
  }
  // 停止看門狗：真人最後一則位置是 move 且超過 1 秒沒有新位置，視為停止。
  const t = now()
  for (const p of players.values()) if (p.ws && p.moving && t - p.lastPosAt > STOP_WATCHDOG_MS) queueMove(p, false)
  // 每個 tick 對每位真人送一則批次位置：只含有變動、且與收件人同場景的其他未騎乘玩家。
  if (dirty.size) {
    for (const to of players.values()) {
      if (!to.ws) continue
      const list = [...dirty].filter((p) => p !== to && p.zone === to.zone && players.get(p.id) === p && !p.riding).map(tuple)
      if (list.length) sendTuples(to.ws, 'moves', list)
    }
    dirty.clear()
  }
}, 100)

wss.on('connection', (ws) => {
  let me = null

  ws.on('message', (raw) => {
    let m
    try {
      m = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (m.t === 'hello') {
      if (me) return
      if (m.v !== PROTOCOL_VERSION) {
        send(ws, { t: 'error', code: 'unsupported_version', message: `Protocol version ${PROTOCOL_VERSION} required` })
        ws.close(1008, 'unsupported version')
        return
      }
      const wanted = validOutfit(m.outfit) ? m.outfit : undefined
      const auth = authOf(typeof m.session === 'string' ? m.session : undefined)
      // 恢復連線：保留期內以 resumeToken 找回原玩家；hello 帶了有效且不同的衣裝以它為準，並通知其他人。
      const old = typeof m.resumeToken === 'string' && [...players.values()].find((p) => p.token === m.resumeToken && !p.ws)
      if (old) {
        clearTimeout(old.graceTimer)
        old.graceTimer = null
        old.ws = ws
        old.token = `t-${nextId++}`
        old.lastPosAt = now()
        me = old
        const changed = wanted !== undefined && wanted !== old.outfit
        if (changed) old.outfit = wanted
        // 與正式伺服器相同：恢復時採用 hello.name（清理後不同才改），welcome 已是新名字，再對全房廣播 name。
        const name = cleanName(m.name)
        const renamed = name !== old.name
        if (renamed) old.name = name
        send(ws, { t: 'welcome', selfId: old.id, room: 'mock-1', resumeToken: old.token, serverTime: now(), players: [...players.values()].map(snapshot), cars: carSnapshots(), auth })
        if (renamed) for (const p of players.values()) if (p.ws) send(p.ws, { t: 'name', id: old.id, name })
        if (changed) broadcast({ t: 'outfit', id: old.id, outfit: old.outfit }, old.id)
        if (fairOverride !== null) send(ws, { t: 'fair', open: fairOverride })
        return
      }
      const n = allocN()
      if (n === null) return ws.close(1013, 'server busy')
      const id = `p-${nextId++}`
      me = {
        token: `t-${nextId++}`,
        outfit: wanted ?? 0,
        id,
        n,
        name: cleanName(m.name),
        lastRenameAt: 0,
        x: (Math.random() - 0.5) * 4,
        z: 11,
        heading: Math.PI,
        zone: 'courtyard',
        moving: false,
        riding: null,
        lastPosAt: now(),
        ws,
      }
      players.set(id, me)
      send(ws, {
        t: 'welcome',
        selfId: id,
        room: 'mock-1',
        resumeToken: me.token,
        serverTime: now(),
        players: [...players.values()].map(snapshot),
        cars: carSnapshots(),
        auth,
      })
      if (fairOverride !== null) send(ws, { t: 'fair', open: fairOverride })
      broadcast({ t: 'join', player: snapshot(me) }, id)
      return
    }
    if (!me) return
    switch (m.t) {
      case 'move':
      case 'stop':
        if (me.riding !== null && me.riding !== undefined) break
        Object.assign(me, { heading: m.heading, lastPosAt: now() })
        moveWithCollision(me, m.x, m.z, TOLERANCE, true)
        queueMove(me, m.t === 'move')
        break
      case 'zone':
        if (me.riding !== null && me.riding !== undefined) {
          send(ws, { t: 'error', code: 'dismount_first', message: '請先下車再離開' })
          return
        }
        // 正式伺服器應驗證玩家確實站在出入口，並以伺服器端的落點為準。
        if (!ZONES.includes(m.zone)) return
        Object.assign(me, { zone: m.zone, x: m.x, z: m.z, heading: m.heading })
        me.moving = false
        dirty.delete(me)
        // 先對同房所有人廣播 zone，再把新場景所有其他玩家的目前位置整批送給切換者。
        broadcast({ t: 'zone', id: me.id, zone: m.zone, x: m.x, z: m.z, heading: m.heading })
        sendTuples(ws, 'sync', [...players.values()].filter((p) => p !== me && p.zone === me.zone && !p.riding).map(tuple))
        break
      case 'action': {
        const cached = seenReq.get(m.reqId)
        if (cached) return send(ws, cached)
        const ack = { t: 'ack', reqId: m.reqId, ok: ACTIONS.includes(m.id), reason: ACTIONS.includes(m.id) ? undefined : 'unknown_action' }
        seenReq.set(m.reqId, ack)
        send(ws, ack)
        if (ack.ok && m.id === 'bell') lastBellAt = now()
        if (ack.ok && ROOT_MS[m.id]) me.rootedUntil = now() + ROOT_MS[m.id]
        if (ack.ok && m.id === 'chant_end') me.rootedUntil = 0
        if (ack.ok) broadcastAction(me, m.id)
        break
      }
      case 'chat':
        if (typeof m.text === 'string' && m.text.length <= 512 && takeChatToken(me)) broadcastChat(me, m.text)
        break
      case 'fair':
        // 當下就做「開放 → 關閉」偵測：只靠 physicsStep 取樣會漏掉兩步之間的「開 → 領車 → 關」
        if (typeof m.open !== 'boolean' || !takeToken(me, 'fair')) break
        fairOverride = m.open
        broadcast({ t: 'fair', open: fairOverride })
        if (sessionWasOpen && !fairOverride) closeSession()
        sessionWasOpen = fairOverride
        break
      case 'outfit':
        if (!takeToken(me, 'outfit') || !validOutfit(m.outfit) || m.outfit === me.outfit) break
        me.outfit = m.outfit
        broadcast({ t: 'outfit', id: me.id, outfit: me.outfit })
        break
      case 'rename': {
        if (typeof m.name !== 'string') return
        const t = now()
        if (t - me.lastRenameAt < RENAME_MIN_INTERVAL_MS) return
        me.lastRenameAt = t
        me.name = cleanName(m.name)
        // 送給同房所有人（含本人、不分場景）
        for (const p of players.values()) if (p.ws) send(p.ws, { t: 'name', id: me.id, name: me.name })
        break
      }
      case 'ping':
        send(ws, { t: 'pong', ts: m.ts, serverTime: now() })
        break
      case 'claim':
      case 'ride_claim': {
        if (!sessionOpen()) {
          send(ws, SESSION_CLOSED)
          break
        }
        const c = claimCar(me, null)
        if (c === null) {
          send(ws, { t: 'error', code: 'car_unavailable', message: '目前無法領車' })
        }
        break
      }
      case 'ride':
      case 'ride_mount':
      case 'ride_dismount': {
        if (m.car === null || m.car === undefined || m.t === 'ride_dismount') {
          dismountPlayer(me)
        } else if (!sessionOpen()) {
          send(ws, SESSION_CLOSED)
        } else {
          const ok = mountCar(me, m.car)
          if (!ok) {
            send(ws, { t: 'error', code: 'car_unavailable', message: '無法上車' })
          }
        }
        break
      }
      case 'drive': {
        if (me.riding !== null && me.riding !== undefined) {
          me.lastDriveSeq = m.seq ?? 0
          // 線上值是量化過的整數（0..255），要換回弧度與 0..1 才能交給模擬。
          const { dir, mag } = dequantizeDrive(typeof m.dir === 'number' ? m.dir : 0, typeof m.mag === 'number' ? m.mag : 0)
          sim.setInput(me.riding, { dir, mag })
          const car = cars.get(me.riding)
          if (car) {
            car.lastInputAt = now()
            if (mag > 0) car.lastActiveDrive = now()
          }
        }
        break
      }
    }
  })

  ws.on('close', () => {
    if (!me || me.ws !== ws) return // 已被新連線取代
    const p = me
    if (p.riding !== null && p.riding !== undefined) {
      dismountPlayer(p)
    }
    // 斷線保留：保留期內可用 resumeToken 恢復，期滿才廣播 leave。
    p.ws = null
    if (p.moving) queueMove(p, false)
    p.graceTimer = setTimeout(() => {
      players.delete(p.id)
      dirty.delete(p)
      broadcast({ t: 'leave', id: p.id })
    }, RESUME_GRACE_MS)
  })
})

console.log(`mock server ws://localhost:${PORT}/ws，機器人 ${BOTS} 個；開發用假登入 http://localhost:${PORT}/auth/providers`)
