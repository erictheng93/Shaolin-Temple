/**
 * 玩家可自選的衣裝。所有衣裝共用同一個輪廓（monk.glb），差別只在配色與配件（袈裟披帶、念珠），
 * 由 AvatarFactory 在著色器裡依衣裝編號上色，不增加 draw call。
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
}

export const OUTFITS: readonly Outfit[] = [
  { key: 'orange', label: 'outfit.orange', robe: '#c9853a' },
  { key: 'grey', label: 'outfit.grey', robe: '#86837d' },
  { key: 'brown', label: 'outfit.brown', robe: '#6e4f3a' },
  { key: 'black', label: 'outfit.black', robe: '#363333' },
  { key: 'kasaya', label: 'outfit.kasaya', robe: '#c99a3e', sash: '#9c2f23' },
  { key: 'beads', label: 'outfit.beads', robe: '#56687f', beads: '#4a2e1c' },
]

export const DEFAULT_OUTFIT = 0

/** 非整數或超出範圍時回傳預設衣裝（0）。 */
export function normalizeOutfit(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < OUTFITS.length ? v : DEFAULT_OUTFIT
}

/** 隨機挑一套（第一次造訪時用，讓場上自然有多樣性）。 */
export function randomOutfit(random: () => number = Math.random): number {
  return Math.min(OUTFITS.length - 1, Math.floor(random() * OUTFITS.length))
}
