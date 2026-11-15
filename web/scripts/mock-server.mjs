// 開發用 mock 遊戲伺服器：實作 src/game/net/protocol.ts 的協定草案，供 Rust 後端完成前測試前端。
// 不是正式伺服器，不做權限、持久化或容量設計。
// 與正式伺服器相同的行為：房內短編號 n、moves／sync／action 只送同場景、zone／join／leave 送全房、
// 切換場景後先廣播 zone 再對切換者送 sync、移動中超過 1 秒沒有位置就視為停止。
//
// 用法：node scripts/mock-server.mjs [機器人數量=6] [埠=8080]
// 前端：在 web/.env.local 設定 VITE_WS_URL=ws://localhost:8080/ws
import { WebSocketServer } from 'ws'

const BOTS = Number(process.argv[2] ?? 6)
const PORT = Number(process.argv[3] ?? 8080)
// 動作允許清單，與 server/src/world.rs 的 ACTIONS 一致（前端玩法模組 src/game/gameplay/modules/worship.ts）
const ACTIONS = ['bow', 'prostrate', 'incense', 'bell']
// 機器人只做該場景能做的動作（跪拜限殿內、敲鐘限庭院）；不會走到蒲團或香爐前，上香不會在香爐插香
const BOT_ACTIONS = { courtyard: ['bow', 'bell'], hall: ['bow', 'prostrate'] }
const ZONES = ['courtyard', 'hall']
// 機器人隨機走動的範圍（未避開障礙物，僅供測試）
const ROAM = {
  courtyard: { x: [-12, 12], z: [-3, 11] },
  hall: { x: [-6, 6], z: [-2.5, 7.5] },
}
const pick = ([a, b]) => a + Math.random() * (b - a)
const NAMES = ['靜心', '晨鐘', '松風', '雲水', '明月', '竹影', '清泉', '山嵐']

const wss = new WebSocketServer({ port: PORT, path: '/ws', maxPayload: 16 * 1024 })
const MAX_MOVES = 200 // 與 protocol.ts 的 MAX_MOVES_PER_MESSAGE 一致
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
/** 房內短編號：取目前未使用的最小值，玩家離開後回收。 */
const allocN = () => {
  const used = new Set([...players.values()].map((p) => p.n))
  let n = 0
  while (used.has(n)) n++
  return n
}

const now = () => Date.now()
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
/** 送給同房所有人（zone／join／leave）。 */
const broadcast = (msg, exceptId) => {
  for (const p of players.values()) if (p.ws && p.id !== exceptId) send(p.ws, msg)
}
/** 只送給指定場景的玩家（action）。 */
const broadcastZone = (zone, msg, exceptId) => {
  for (const p of players.values()) if (p.ws && p.zone === zone && p.id !== exceptId) send(p.ws, msg)
}
/** 把 tuple 陣列依上限拆成多則送出。 */
const sendTuples = (ws, t, list) => {
  for (let i = 0; i < list.length; i += MAX_MOVES) send(ws, { t, m: list.slice(i, i + MAX_MOVES) })
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
        broadcastZone(p.zone, { t: 'action', playerId: p.id, id: BOT_ACTIONS[p.zone][Math.floor(Math.random() * BOT_ACTIONS[p.zone].length)], startedAt: now() })
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
      const id = `p-${nextId++}`
      me = {
        id,
        n: allocN(),
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
        if (ack.ok) broadcastZone(me.zone, { t: 'action', playerId: me.id, id: m.id, startedAt: now() }, me.id)
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
