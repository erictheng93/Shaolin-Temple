// 開發用：在瀏覽器與 mock 伺服器之間加上延遲與抖動的 WebSocket 代理，用來在本機重現真實網路下的手感。
// 用法：node scripts/lag-proxy.mjs [監聽埠=8081] [目標埠=8080] [單程延遲毫秒=50] [抖動毫秒=20]
// 前端把 VITE_WS_URL 指到 ws://localhost:<監聽埠>/ws。每個方向依序送達（和 TCP 一樣，晚到的會擋住後面的）。
import { WebSocket, WebSocketServer } from 'ws'

const [listen = 8081, target = 8080, oneWay = 50, jitter = 20] = process.argv.slice(2).map(Number)

/** 回傳一個延遲轉送的函式；送達時間不會早於前一則。 */
function delayed(send) {
  let last = 0
  return (data, isBinary) => {
    last = Math.max(last, Date.now() + oneWay + Math.random() * jitter)
    setTimeout(() => send(data, isBinary), last - Date.now())
  }
}

new WebSocketServer({ port: listen }).on('connection', (client, req) => {
  const upstream = new WebSocket(`ws://localhost:${target}${req.url}`)
  const early = []
  const toServer = delayed((d, b) => upstream.readyState === 1 && upstream.send(d, { binary: b }))
  const toClient = delayed((d, b) => client.readyState === 1 && client.send(d, { binary: b }))
  client.on('message', (d, b) => (upstream.readyState === 1 ? toServer(d, b) : early.push([d, b])))
  upstream.on('open', () => early.splice(0).forEach(([d, b]) => toServer(d, b)))
  upstream.on('message', toClient)
  client.on('close', () => upstream.close())
  upstream.on('close', () => client.close())
  upstream.on('error', () => client.close())
  client.on('error', () => upstream.close())
})
console.log(`lag proxy ws://localhost:${listen}/ws → ${target}，單程 ${oneWay}±${jitter} ms`)
