/**
 * 預設法號：第一次入寺、或玩家清空名字時，以寺院風格的名字代替「訪客」。
 *
 * 兩字法號＝首字 × 次字的組合，扣掉 BLOCKED（逐一看過的不雅、不吉、可笑或撞到地名俗語的組合）
 * 與 EXCLUDED（真實知名僧人、宗教人物與家喻戶曉的小說僧名）；另混入少量三到四字的雅號。
 * 首字不用少林寺現行字輩（德、行、永、延、恒），避免看起來像真實的少林僧名。
 * 測試（names.test.ts）窮舉整份清單檢查長度、字元、排除清單與數量。
 */

/** 法號首字：莊重、平和的字，不含少林寺現行字輩。 */
export const NAME_FIRST = '慧淨悟明清妙覺澄禪圓定靜智了真普常照本'
/** 法號次字。 */
export const NAME_SECOND = '明塵遠心空然雲光山林泉月和安海源舟蓮'

/** 少林寺現行字輩，不可當首字。 */
export const LINEAGE_CHARS = '德行永延恒恆'

/** 真實知名僧人、宗教人物或家喻戶曉的小說僧名；任何產生的名字都不可等於或包含其中之一。 */
export const EXCLUDED_NAMES: readonly string[] = [
  // 指定的排除清單
  '玄奘', '慧能', '惠能', '神秀', '達摩', '鑑真', '法顯', '玄覺', '道信', '弘忍', '僧璨', '慧可', '智顗', '慧遠',
  '道安', '虛雲', '印光', '弘一', '太虛', '星雲', '聖嚴', '證嚴', '惟覺', '淨空', '一行', '濟公', '道濟', '悟空',
  '悟能', '悟淨', '法海',
  // 其他知名的祖師、高僧與宗教人物（法號與字表可能撞到的）
  '慧海', '慧安', '慧光', '慧思', '慧開', '明海', '覺遠', '圓光', '定光', '普光', '真光', '清海', '禪月', '妙善',
  '智者', '法藏', '澄觀', '宗密', '窺基', '義淨', '道宣', '懷讓', '懷海', '希遷', '義玄', '良价', '本寂', '文偃',
  '文益', '圓悟', '克勤', '宗杲', '憨山', '德清', '紫柏', '真可', '蓮池', '祩宏', '蕅益', '智旭', '寒山', '拾得',
  '永嘉', '曇宗', '福裕', '永信', '本煥', '夢參', '廣欽', '淨慧', '淨界', '印順', '空海', '最澄', '隱元', '唐僧',
  // 台灣、香港玩家熟悉的當代長老
  '悟明', '淨心', '妙蓮', '覺光',
  // 家喻戶曉的小說僧名
  '玄慈', '玄苦', '玄難', '方證', '虛竹', '一燈', '空見', '空聞', '渡厄', '掃地僧',
]

/**
 * 逐一檢查兩兩組合後擋下的：
 * 重字、俗語或日常詞（照明、真空、清空、定心、圓心、定然、本月、了光、照光）、
 * 不吉的聯想（清明：掃墓的節日；圓明：圓明園）、地名或人名（定海、定遠、定安、常山、本山、圓山、普林、靜安、清遠、澄海）。
 */
const BLOCKED = new Set([
  '明明', '照明', '真空', '清空', '定心', '圓心', '定然', '本月', '了光', '照光',
  '清明', '圓明',
  '定海', '定遠', '定安', '常山', '本山', '圓山', '普林', '靜安', '清遠', '澄海',
])

/** 三到四字的雅號（少量混入）。 */
export const STYLE_NAMES: readonly string[] = [
  '聽松客', '掃葉人', '雲水僧', '種蓮人', '聽雨客', '拾薪人', '看雲客', '守燈人',
  '煮茶人', '汲泉人', '掃雪人', '松下客', '竹林客', '聽鐘人', '林下僧', '山中客', '看雲閒客', '松間聽泉',
]

function buildNames(): string[] {
  const out: string[] = []
  for (const a of NAME_FIRST) {
    if (LINEAGE_CHARS.includes(a)) continue
    for (const b of NAME_SECOND) {
      const name = a + b
      if (a === b || BLOCKED.has(name) || EXCLUDED_NAMES.some((x) => name.includes(x))) continue
      out.push(name)
    }
  }
  for (const name of STYLE_NAMES) if (!EXCLUDED_NAMES.some((x) => name.includes(x))) out.push(name)
  return out
}

/** 所有可能產生的名字（固定順序）。 */
export const TEMPLE_NAMES: readonly string[] = buildNames()

/** 隨機一個法號或雅號。rng 回傳 [0, 1)，固定 rng 時結果固定。 */
export function randomTempleName(rng: () => number = Math.random): string {
  const i = Math.min(TEMPLE_NAMES.length - 1, Math.floor(rng() * TEMPLE_NAMES.length))
  return TEMPLE_NAMES[Math.max(0, i)]!
}

/** 名字上限（Unicode 字元），與伺服器的清理規則一致。 */
export const NAME_MAX_CHARS = 16

/**
 * 本機先整理玩家輸入的名字：去控制字元、看不見的格式字元（零寬、雙向覆寫與隔離、BOM；與伺服器 clean_name、
 * net/protocol.ts 的 sanitizeChat 同一組）與頭尾空白、最多 16 個字；空白時用隨機法號（不再顯示成「訪客」）。
 * 伺服器仍會再清理一次，結果以伺服器為準。（不 import protocol.ts：mock 伺服器以 Node 直接載入本檔。）
 */
export function normalizeName(name: string, rng: () => number = Math.random): string {
  const cleaned = name.replace(/[​-‏‪-‮⁦-⁩﻿]/gu, '').replace(/\p{Cc}/gu, '')
  const s = [...cleaned.trim()].slice(0, NAME_MAX_CHARS).join('').trim()
  return s || randomTempleName(rng)
}
