import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APPROACH_CANCELS } from './approachFlow'

/**
 * GameCore 需要 WebGL，無法在 vitest 建立；這裡以原始碼文字做粗檢查，抓「GameCore 漏掉某個呼叫」：
 * 規則本身由 approachFlow.test.ts 與 retime.test.ts 測，這裡只確認 GameCore 有接上。
 */
const source = readFileSync(new URL('../GameCore.ts', import.meta.url), 'utf8')
/** 去掉註解，註解掉的呼叫不算數。 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

describe('GameCore 的接線（原始碼檢查）', () => {
  it('每一種取消原因 GameCore 都至少有一處 this.approach.cancel(...)', () => {
    const missing = APPROACH_CANCELS.filter((cause) => !code.includes(`this.approach.cancel('${cause}')`))
    expect(missing).toEqual([])
  })

  it('approach.cancel 只用清單裡的原因（字串常值）', () => {
    // GameCore 裡所有的 .cancel( 呼叫都要是 this.approach.cancel('<清單裡的原因>')（寫法不同或用變數也算失敗；
    // 之後若有別的物件也有 cancel，再把這條收窄）
    const allCalls = [...code.matchAll(/\.cancel\(/g)].length
    const listed = [...code.matchAll(/this\.approach\.cancel\('(\w+)'\)/g)].map((m) => m[1]!)
    expect(listed.length).toBeGreaterThanOrEqual(APPROACH_CANCELS.length)
    expect(listed.filter((c) => !(APPROACH_CANCELS as readonly string[]).includes(c))).toEqual([])
    expect(allCalls).toBe(listed.length)
  })

  it('welcome 把快照裡的動作套到遠端玩家時一併收集，並送出 snapshotActions', () => {
    const welcome = code.slice(code.indexOf("case 'welcome':"), code.indexOf("case 'join':"))
    expect(welcome).toMatch(/snapshotActions\.push\(/)
    expect(welcome).toMatch(/this\.events\.emit\('snapshotActions',\s*\{\s*actions:\s*snapshotActions\s*\}\)/)
  })

  it('玩法 API 的 retimeAction 委派給 core/retime 的 retimePlayerAction', () => {
    expect(code).toMatch(/import\s*\{\s*retimePlayerAction\s*\}\s*from\s*'\.\/core\/retime'/)
    // installGameplay 裡的 api 物件：retimeAction 屬性的本體要呼叫 retimePlayerAction，並把參數原樣傳下去
    const api = code.slice(code.indexOf('private installGameplay()'), code.indexOf('for (const mod of gameplayModules)'))
    expect(api).toMatch(
      /retimeAction:\s*\(id, actionId, startedAt\)\s*=>\s*\{(?:(?!\n {6}\w+:)[\s\S])*?\bretimePlayerAction\(\s*\w+,\s*id,\s*actionId,\s*startedAt,\s*performance\.now\(\)\s*\)/,
    )
  })
})
