/**
 * 場地配置：場景建模與移動碰撞共用同一份資料，避免畫面與可走範圍不一致。
 * 單位為公尺，y 軸朝上，玩家在 xz 平面移動。
 */

export interface Rect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export const WORLD_BOUNDS: Rect = { minX: -19, maxX: 19, minZ: -19, maxZ: 18 }

export const SPAWN = { x: 0, z: 11, heading: Math.PI }

/** 主殿（含台基與階梯）。 */
export const HALL: Rect = { minX: -7.5, maxX: 7.5, minZ: -18, maxZ: -6.2 }
/** 香爐。 */
export const CENSER = { x: 0, z: -1.5, radius: 0.9 }
/** 鐘亭。 */
export const BELL_PAVILION: Rect = { minX: 10, maxX: 14, minZ: -6, maxZ: -2 }
/** 碰碰車檔口建築（原始尺寸）。 */
export const BOOTH: Rect = { minX: -15.5, maxX: -12.5, minZ: 8.0, maxZ: 10.5 }
/** 石燈籠位置。 */
export const LANTERNS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -4, z: 3 },
  { x: 4, z: 3 },
  { x: -4, z: -4 },
  { x: 4, z: -4 },
]
/** 樹的位置（場地外圍）。 */
export const TREES: ReadonlyArray<{ x: number; z: number; scale: number }> = [
  { x: -16, z: -14, scale: 1.3 },
  { x: -15, z: -4, scale: 1 },
  { x: -17, z: 6, scale: 1.2 },
  { x: -14, z: 14, scale: 0.9 },
  { x: 16, z: -14, scale: 1.2 },
  { x: 17, z: 5, scale: 1.1 },
  { x: 14, z: 14, scale: 1 },
  { x: -9, z: 16, scale: 0.8 },
  { x: 9, z: 16.5, scale: 0.9 },
]

const pad = (r: Rect, p: number): Rect => ({
  minX: r.minX - p,
  maxX: r.maxX + p,
  minZ: r.minZ - p,
  maxZ: r.maxZ + p,
})

const square = (x: number, z: number, half: number): Rect => ({
  minX: x - half,
  maxX: x + half,
  minZ: z - half,
  maxZ: z + half,
})

/** 樹的碰撞方塊（SOLIDS 內的同一批物件；車輛模擬以參照辨識哪些是樹）。 */
export const TREE_SOLIDS: ReadonlyArray<Rect> = TREES.map((t) => square(t.x, t.z, 0.5 * t.scale))

/** 庭院建築與障礙物的原始邊界（未加上角色半徑）。 */
export const SOLIDS: ReadonlyArray<Rect> = [
  HALL,
  BELL_PAVILION,
  BOOTH,
  square(CENSER.x, CENSER.z, CENSER.radius),
  ...LANTERNS.map((l) => square(l.x, l.z, 0.35)),
  ...TREE_SOLIDS,
]

/** 碰撞用的障礙物（已含角色半徑的餘量）。 */
export const PLAYER_RADIUS = 0.35
export const OBSTACLES: ReadonlyArray<Rect> = SOLIDS.map((r) => pad(r, PLAYER_RADIUS))

/** 鐘的中心（鐘亭正中，TempleScene 的 bellPivot）。 */
export const BELL_CENTER = {
  x: (BELL_PAVILION.minX + BELL_PAVILION.maxX) / 2,
  z: (BELL_PAVILION.minZ + BELL_PAVILION.maxZ) / 2,
}

/**
 * 敲鐘站位：鐘亭面向庭院（+z）的一側，站在鐘亭障礙物（含角色半徑）外 0.15 公尺，左右各一、間距 0.8 公尺
 * （大於兩個角色半徑 0.7，也大於視為有人的 0.6），三人可同時站著不重疊。面向鐘。
 * 撞木從這一側伸向鐘，三條拉繩從撞木尾端垂到三個站位的手前。
 * 定義在這裡（layout.ts 沒有任何 import）是為了讓 Node 的 mock 伺服器能直接載入；world/bell.ts 照原名轉出口。
 */
export const BELL_STATION_GAP = 0.8
const BELL_STATION_Z = BELL_PAVILION.maxZ + PLAYER_RADIUS + 0.15
export const BELL_STATIONS: ReadonlyArray<{ x: number; z: number; heading: number }> = [-1, 0, 1].map((i) => {
  const x = BELL_CENTER.x + i * BELL_STATION_GAP
  return { x, z: BELL_STATION_Z, heading: Math.atan2(BELL_CENTER.x - x, BELL_CENTER.z - BELL_STATION_Z) }
})
