/**
 * 玩家可自選的衣裝。所有衣裝共用同一個模型（monk.glb），模型裡同時有鐘形的袍與短褂兩種輪廓、念珠與斗笠，
 * 由 AvatarFactory 在著色器裡依衣裝編號上色並收合用不到的部分，不增加 draw call。
 *
 * 陣列索引就是衣裝編號（存檔與網路都用編號），日後只能加在尾端，不可改順序或刪除。
 * 顏色是 sRGB 十六進位。
 */
import type { MessageKey } from '../../i18n'

export interface Outfit {
  /** 程式內的鍵（英文）。 */
  key: string
  /** 顯示名稱的字典 key（i18n），顯示當下才翻譯。 */
  label: MessageKey
  /** 袍色（袖口與鞋由模型的頂點色壓暗）。 */
  robe: string
  /** 袈裟披帶的顏色；沒有披帶時省略。披在左肩、斜到右腰（偏袒右肩）。 */
  sash?: string
  /** 頸間念珠的顏色；沒有念珠時省略。 */
  beads?: string
  /** 竹編斗笠的顏色（明暗由模型的頂點色決定）；不戴斗笠時省略。名牌與對話泡泡會升高一點。 */
  hat?: string
  /**
   * 武僧短褂：有值時輪廓換成及臀的短褂（上衣用 robe 色、袖口紮起）加長褲與綁腿，不穿鐘形的袍。
   * belt 也用在袖口的束帶。
   */
  tunic?: { trousers: string; leggings: string; belt: string }
}

export const OUTFITS: readonly Outfit[] = [
  { key: 'orange', label: 'outfit.orange', robe: '#c9853a' },
  { key: 'grey', label: 'outfit.grey', robe: '#86837d' },
  { key: 'brown', label: 'outfit.brown', robe: '#6e4f3a' },
  { key: 'black', label: 'outfit.black', robe: '#363333' },
  { key: 'kasaya', label: 'outfit.kasaya', robe: '#c99a3e', sash: '#9c2f23' },
  { key: 'beads', label: 'outfit.beads', robe: '#56687f', beads: '#4a2e1c' },
  { key: 'pilgrim', label: 'outfit.pilgrim', robe: '#7a6a55', hat: '#c8a765' },
  {
    key: 'warrior',
    label: 'outfit.warrior',
    robe: '#d48a2a',
    tunic: { trousers: '#3a4250', leggings: '#e6dcc4', belt: '#2f2b28' },
  },
]

export const DEFAULT_OUTFIT = 0

/** 非整數或超出範圍時回傳預設衣裝（0）。比這個版本新的衣裝編號（舊分頁收到）也顯示為預設衣裝。 */
export function normalizeOutfit(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < OUTFITS.length ? v : DEFAULT_OUTFIT
}

/** 隨機挑一套（第一次造訪時用，讓場上自然有多樣性）。 */
export function randomOutfit(random: () => number = Math.random): number {
  return Math.min(OUTFITS.length - 1, Math.floor(random() * OUTFITS.length))
}
