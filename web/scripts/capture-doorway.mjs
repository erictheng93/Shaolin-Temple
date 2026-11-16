// 擷取殿門外景：以遊戲自己的庭院場景，從殿門朝外拍一張半景全景圖 → assets/backdrops/hall_doorway.png。
// 之後執行 `node scripts/build-textures.mjs backdrops` 編碼成 public/backdrops/hall_doorway.ktx2，
// 並把 src/game/render/doorwayView.ts 的 DOORWAY_VIEW_VERSION 加一。
//
// 用法：node scripts/capture-doorway.mjs
// 需要 Chrome／Chromium（環境變數 CHROME 指定路徑，否則找常見安裝位置）。腳本自己啟動 Vite 開發伺服器與無頭瀏覽器，
// 以高畫質載入庭院、等貼圖與烘焙光照到齊，再呼叫 render/doorwayView.ts 的 captureDoorwayView()。
// 改了庭院的樣子、太陽方向或 DOORWAY_VIEW 的參數都要重新擷取。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'assets', 'backdrops', 'hall_doorway.png')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('找不到 Chrome，請以環境變數 CHROME 指定執行檔路徑')
  return found
}

const server = await createServer({ root, logLevel: 'warn', server: { host: '127.0.0.1', port: 4792, strictPort: false } })
await server.listen()
const url = server.resolvedUrls.local[0]
const port = 9400 + Math.floor(Math.random() * 400)
const profile = mkdtempSync(join(tmpdir(), 'capture-doorway-'))
const chrome = spawn(findChrome(), [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,800', '--no-first-run', '--mute-audio', 'about:blank',
], { stdio: 'ignore' })

let ws
try {
  let target
  for (let i = 0; i < 150 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      // 瀏覽器還沒起來
    }
    if (!target) await sleep(200)
  }
  if (!target) throw new Error('無法連上無頭瀏覽器')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text)
    return res.result?.result?.value
  }

  await send('Runtime.enable')
  await send('Page.enable')
  // 高畫質（1024 貼圖）、靜音
  const settings = { quality: 'high', masterVolume: 0, musicVolume: 0, sfxVolume: 0, muted: true, playerName: '', showStats: false }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('shaolin-temple:settings:v1', ${JSON.stringify(JSON.stringify(settings))})` })
  await send('Page.navigate', { url })
  await evaluate(`(async () => {
    for (let i = 0; i < 200; i++) {
      const b = document.querySelector('button.enter')
      if (window.__game && b && !b.disabled) { b.click(); return }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error('遊戲沒有載入完成')
  })()`)
  // 等場景貼圖與烘焙光照下載、轉碼完成：貼圖數量連續 3 秒不變
  await evaluate(`(async () => {
    const info = window.__game.renderer.renderer.info.memory
    let last = -1, stable = 0
    for (let i = 0; i < 120 && stable < 6; i++) {
      await new Promise((r) => setTimeout(r, 500))
      stable = info.textures === last ? stable + 1 : 0
      last = info.textures
    }
  })()`)
  await sleep(1000)
  const dataUrl = await evaluate(`(async () => {
    const g = window.__game
    const r = g.renderer
    const { captureDoorwayView } = await import('/src/game/render/doorwayView.ts')
    // 瓦頂材質（TempleScene 的 roof：雙面、底色 #c8ccd6）
    const roofs = new Set()
    g.temple.root.traverse((o) => { if (o.isMesh && o.material.side === 2 && o.material.color?.getHexString() === 'c8ccd6') roofs.add(o.material) })
    if (roofs.size !== 1) throw new Error('找不到瓦頂材質（' + roofs.size + '）')
    const canvas = captureDoorwayView(r.renderer, r.scene, [g.temple.root, r.hemi, r.sun, r.sun.target], r.sky, [...roofs])
    return canvas.toDataURL('image/png')
  })()`)
  mkdirSync(join(root, 'assets', 'backdrops'), { recursive: true })
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('已輸出', out)
} finally {
  ws?.close()
  chrome.kill()
  await server.close()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
