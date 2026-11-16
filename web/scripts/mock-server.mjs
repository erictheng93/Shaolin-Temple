// 開發用 mock 遊戲伺服器：實作 src/game/net/protocol.ts 的協定草案，供 Rust 後端完成前測試前端。
// 不是正式伺服器，不做權限、持久化或容量設計。
// 與正式伺服器相同的行為：房內短編號 n、moves／sync／action 只送同場景、zone／join／leave 送全房、
// 切換場景後先廣播 zone 再對切換者送 sync、移動中超過 1 秒沒有位置就視為停止、
// 協定版本 3：moves／sync／action 以二進位幀送出（與前端共用 src/game/net/binaryFrame.ts 的編碼器），hello.v 不符時回 unsupported_version。
//
// 用法：node scripts/mock-server.mjs [機器人數量=6] [埠=8080]（需 Node 22.18 以上，直接載入 .ts 的型別移除）
// 前端：在 web/.env.local 設定 VITE_WS_URL=ws://localhost:8080/ws
import { WebSocketServer } from 'ws'
import { ACTION_CODES, MAX_MOVES_PER_MESSAGE, MAX_SHORT_ID, encodeAction, encodeBatch } from '../src/game/net/binaryFrame.ts'

const PROTOCOL_VERSION = 3 // 與 src/game/net/protocol.ts 一致

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
// 機器人只做該場景能做的動作（跪拜、誦經限殿內，敲鐘限庭院）；不會走到蒲團、香爐或鐘亭前，上香不會在香爐插香
const BOT_ACTIONS = { courtyard: ['bow', 'bell'], hall: ['bow', 'prostrate', 'chant'] }
// 機器人做這些動作時停留到動作結束再走（客戶端在動作期間不顯示走路）；誦經 24 秒、跪拜 8 秒
const BOT_HOLD_S = { chant: 25, prostrate: 9 }
// 機器人敲鐘時遵守與客戶端相同的「鐘聲未歇」：任何人敲鐘後 7 秒內不再敲
const BOT_BELL_GAP_MS = 7000
let lastBellAt = 0
const ZONES = ['courtyard', 'hall']
// 機器人隨機走動的範圍（未避開障礙物，僅供測試）
const ROAM = {
  courtyard: { x: [-12, 12], z: [-3, 11] },
  hall: { x: [-6, 6], z: [-2.5, 7.5] },
}
const pick = ([a, b]) => a + Math.random() * (b - a)
const NAMES = ['靜心', '晨鐘', '松風', '雲水', '明月', '竹影', '清泉', '山嵐']

const wss = new WebSocketServer({ port: PORT, path: '/ws', maxPayload: 16 * 1024 })
const STOP_WATCHDOG_MS = 1000
const players = new Map() // id -> { id, n, name, x, z, heading, zone, moving, lastPosAt, ws?, bot? }
const seenReq = new Map() // reqId -> ack（模擬伺服器去重）
const dirty = new Set() // 本 tick 有變動的玩家，tick 內合併成 moves
const r2 = (v) => Math.round(v * 100) / 100
const queueMove = (p, moving) => {
  p.moving = moving
  dirty.add(p)
}
const tuple = (p) => [p.n, r2(p.x), r2(p.z), r2(p.heading), p.moving ? 1 : 0]
let nextId = 1
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
/** 動作廣播（二進位幀）：只送給同場景的其他玩家。 */
const broadcastAction = (from, id) => {
  const frame = encodeAction({ n: from.n, id, startedAt: now() })
  if (!frame) return
  for (const p of players.values()) if (p.ws && p.zone === from.zone && p !== from && p.ws.readyState === 1) p.ws.send(frame)
}
/** 把 tuple 陣列依上限拆成多則二進位幀送出（sync 即使是空的也要送）。 */
const sendTuples = (ws, t, list) => {
  for (let i = 0; i === 0 || i < list.length; i += MAX_MOVES_PER_MESSAGE) {
    const frame = encodeBatch({ t, m: list.slice(i, i + MAX_MOVES_PER_MESSAGE) })
    if (frame && ws.readyState === 1) ws.send(frame)
  }
}
const snapshot = (p) => ({ id: p.id, n: p.n, name: p.name, x: p.x, z: p.z, heading: p.heading, zone: p.zone })

// 機器人：在廣場上隨機走動，偶爾做動作。
for (let i = 0; i < BOTS; i++) {
  const id = `bot-${i}`
  const zone = i % 3 === 2 ? 'hall' : 'courtyard'
  players.set(id, {
    id,
    n: allocN(),
    moving: false,
    lastPosAt: 0,
    name: NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''),
    x: pick(ROAM[zone].x),
    z: pick(ROAM[zone].z),
    heading: 0,
    zone,
    bot: { tx: 0, tz: 0, wait: Math.random() * 3 },
  })
}

setInterval(() => {
  const dt = 0.1
  for (const p of players.values()) {
    if (!p.bot) continue
    const b = p.bot
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
    if (d < 0.2) {
      b.wait = 2 + Math.random() * 6
      queueMove(p, false)
      if (Math.random() < 0.6) {
        const id = BOT_ACTIONS[p.zone][Math.floor(Math.random() * BOT_ACTIONS[p.zone].length)]
        if (id === 'bell' && now() - lastBellAt < BOT_BELL_GAP_MS) continue
        if (id === 'bell') lastBellAt = now()
        b.wait = Math.max(b.wait, BOT_HOLD_S[id] ?? 0)
        broadcastAction(p, id)
      }
      continue
    }
    const step = Math.min(d, 2.2 * dt)
    p.x += (dx / d) * step
    p.z += (dz / d) * step
    p.heading = Math.atan2(dx, dz)
    queueMove(p, true)
  }
  // 停止看門狗：真人最後一則位置是 move 且超過 1 秒沒有新位置，視為停止。
  const t = now()
  for (const p of players.values()) if (p.ws && p.moving && t - p.lastPosAt > STOP_WATCHDOG_MS) queueMove(p, false)
  // 每個 tick 對每位真人送一則批次位置：只含有變動、且與收件人同場景的其他玩家。
  if (dirty.size) {
    for (const to of players.values()) {
      if (!to.ws) continue
      const list = [...dirty].filter((p) => p !== to && p.zone === to.zone && players.get(p.id) === p).map(tuple)
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
      const n = allocN()
      if (n === null) return ws.close(1013, 'server busy')
      const id = `p-${nextId++}`
      me = {
        id,
        n,
        name: String(m.name || '訪客').slice(0, 16),
        x: (Math.random() - 0.5) * 4,
        z: 11,
        heading: Math.PI,
        zone: 'courtyard',
        moving: false,
        lastPosAt: now(),
        ws,
      }
      players.set(id, me)
      send(ws, {
        t: 'welcome',
        selfId: id,
        room: 'mock-1',
        resumeToken: id,
        serverTime: now(),
        players: [...players.values()].map(snapshot),
      })
      broadcast({ t: 'join', player: snapshot(me) }, id)
      return
    }
    if (!me) return
    switch (m.t) {
      case 'move':
      case 'stop':
        Object.assign(me, { x: m.x, z: m.z, heading: m.heading, lastPosAt: now() })
        queueMove(me, m.t === 'move')
        break
      case 'zone':
        // 正式伺服器應驗證玩家確實站在出入口，並以伺服器端的落點為準。
        if (!ZONES.includes(m.zone)) return
        Object.assign(me, { zone: m.zone, x: m.x, z: m.z, heading: m.heading })
        me.moving = false
        dirty.delete(me)
        // 先對同房所有人廣播 zone，再把新場景所有其他玩家的目前位置整批送給切換者。
        broadcast({ t: 'zone', id: me.id, zone: m.zone, x: m.x, z: m.z, heading: m.heading })
        sendTuples(ws, 'sync', [...players.values()].filter((p) => p !== me && p.zone === me.zone).map(tuple))
        break
      case 'action': {
        const cached = seenReq.get(m.reqId)
        if (cached) return send(ws, cached)
        const ack = { t: 'ack', reqId: m.reqId, ok: ACTIONS.includes(m.id), reason: ACTIONS.includes(m.id) ? undefined : 'unknown_action' }
        seenReq.set(m.reqId, ack)
        send(ws, ack)
        if (ack.ok && m.id === 'bell') lastBellAt = now()
        if (ack.ok) broadcastAction(me, m.id)
        break
      }
      case 'ping':
        send(ws, { t: 'pong', ts: m.ts, serverTime: now() })
        break
    }
  })

  ws.on('close', () => {
    if (!me) return
    players.delete(me.id)
    dirty.delete(me)
    broadcast({ t: 'leave', id: me.id })
  })
})

console.log(`mock server ws://localhost:${PORT}/ws，機器人 ${BOTS} 個`)
