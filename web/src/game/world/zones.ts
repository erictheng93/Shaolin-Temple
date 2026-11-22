import type { MessageKey } from '../../i18n'
import { CENSER, HALL, OBSTACLES, PLAYER_RADIUS, SPAWN, WORLD_BOUNDS, type Rect } from './layout'

/**
 * 場景（zone）定義：每個場景有自己的可走範圍、障礙物、出生點、鏡頭範圍與出入口。
 * 場景建模與移動碰撞都讀這份資料，伺服器驗證場景切換時也以此為準。
 */

export type ZoneId = 'courtyard' | 'hall'
export const ZONE_IDS: readonly ZoneId[] = ['courtyard', 'hall']

export interface Pose {
  x: number
  z: number
  heading: number
}

/** 出入口：玩家走進 rect 時切換到 to 場景，並出現在 spawn。 */
export interface Portal {
  rect: Rect
  to: ZoneId
  spawn: Pose
  /** 點擊落在此範圍（例如整棟主殿）時，改為走向出入口。 */
  tapArea?: Rect
}

export interface ZoneDef {
  id: ZoneId
  /** 顯示名稱的字典 key（進入時提示，顯示當下才翻譯）。 */
  name: MessageKey
  bounds: Rect
  obstacles: ReadonlyArray<Rect>
  spawn: Pose
  portals: ReadonlyArray<Portal>
  /** 鏡頭位置限制（室內避免鏡頭穿牆）；null 表示不限制。 */
  cameraBounds: { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number } | null
  /**
   * 鏡頭預設距離與允許範圍。yaw 有值時，進入場景一律用這個水平角度（庭院固定從外面看向主殿）；
   * 沒有時放在角色背後。
   */
  camera: { distance: number; min: number; max: number; yaw?: number }
  /** 離開後再回來時，是否還原離開前的鏡頭（出殿後回到進殿前的視角）。 */
  restoreCamera: boolean
}

const pad = (r: Rect, p: number): Rect => ({ minX: r.minX - p, maxX: r.maxX + p, minZ: r.minZ - p, maxZ: r.maxZ + p })
const square = (x: number, z: number, half: number): Rect => ({ minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half })

// ---------- 殿內配置（單位公尺；殿門在 +z，神龕在 -z） ----------

/** 殿內牆體範圍。 */
export const HALL_ROOM = { minX: -8, maxX: 8, minZ: -9, maxZ: 9, height: 7 }
/** 柱子位置。 */
export const HALL_PILLARS: ReadonlyArray<{ x: number; z: number }> = [-5.2, 5.2].flatMap((x) =>
  [5, 1, -3].map((z) => ({ x, z })),
)
/** 神龕台基（不可走）。 */
export const HALL_ALTAR: Rect = { minX: -7.6, maxX: 7.6, minZ: -9, maxZ: -5.2 }
/** 供桌。 */
export const HALL_TABLE: Rect = { minX: -4.6, maxX: 4.6, minZ: -4.8, maxZ: -4.0 }
/**
 * 三尊神像的位置（神像面向 +z，也就是面向參拜者）。
 * 依傳統以神明為主體：主佛左手邊（龍邊，+x）為觀世音菩薩，右手邊（虎邊，-x）為媽祖。
 */
export const HALL_STATUES = {
  buddha: { x: 0, z: -7.3 },
  guanyin: { x: 4.3, z: -6.9 },
  mazu: { x: -4.3, z: -6.9 },
} as const
/** 神像插槽的鍵（依 HALL_STATUES 迭代，不寫死名稱）。 */
export type HallStatueId = keyof typeof HALL_STATUES
export const HALL_STATUE_IDS = Object.keys(HALL_STATUES) as HallStatueId[]

/** 面向神龕（-z）的朝向。 */
const FACE_ALTAR = Math.PI

/** 中軸紅地毯（走道）的半寬，HallScene 依此鋪地毯。 */
export const HALL_AISLE_HALF_WIDTH = 1.1
/**
 * 蒲團陣列：以中軸紅地毯為走道，左右各 3 欄 × 4 排，面向神龕，不阻擋行走。
 *
 * 間距依角色實際尺寸（scripts/build-avatar.mjs）定出：跪下時身體壓扁、兩側略寬，袍寬約 0.5 公尺（含耳朵約 0.6）；
 * 叩拜時整尊繞腳底前傾約 1 弧度，頭頂最遠到腳前約 0.8 公尺，背後約 0.22 公尺，前後共佔約 1.0 公尺。
 * - 欄距 1.25：相鄰兩人跪拜時袍與袍之間留約 0.75 公尺（站著的角色寬約 0.43），中間還能走人。
 * - 排距 1.6：前一排叩拜的頭與後一排的背之間留約 0.6 公尺。
 * - 最內欄 |x| = 1.8：蒲團邊緣離地毯走道 0.34 公尺；最外欄 |x| = 4.3（與兩側神像對齊），蒲團邊緣離柱礎約 0.12 公尺。
 * - 第一排 z = -1.7：叩拜的頭到 -2.5，與供桌前上香的人（站在 -3.35、背後到 -3.1）之間留約 0.6 公尺。
 * - 最後一排 z = 3.1：離殿門出入口（z ≥ 8.15）與進殿落點（z 7.4）都很遠。
 */
export const HALL_CUSHION_COLUMNS_X: readonly number[] = [1.8, 3.05, 4.3]
export const HALL_CUSHION_ROWS_Z: readonly number[] = [-1.7, -0.1, 1.5, 3.1]
/** 蒲團半徑（公尺）。 */
export const CUSHION_RADIUS = 0.36
export const HALL_CUSHIONS: ReadonlyArray<Pose> = HALL_CUSHION_ROWS_Z.flatMap((z) =>
  HALL_CUSHION_COLUMNS_X.flatMap((x) => [-x, x]).map((x) => ({ x, z, heading: FACE_ALTAR })),
)

/**
 * 香爐：每尊神像正前方的供桌上一個，加上庭院中央的大香爐。上香時站在 spots 其中一點、面向香爐。
 * ashY 是爐內香灰面的高度，sticks 是插香的範圍（以爐心為圓心的環，內徑避開常駐的香）、香的長度與粗細，cap 是同時顯示的上限。
 * 高度取自 HallScene（供桌面 1.0、爐內灰面在爐底上 0.22）與 TempleScene（爐座 0.3、灰面在爐底上 0.6）。
 */
export interface CenserDef {
  id: string
  zone: ZoneId
  x: number
  z: number
  ashY: number
  sticks: { innerRadius: number; outerRadius: number; length: number; radius: number; cap: number }
  /** 常駐的香（不會燒完，不計入上限），只有主佛前那一爐有。 */
  permanent: number
  spots: ReadonlyArray<Pose>
}

const HALL_TABLE_Z = (HALL_TABLE.minZ + HALL_TABLE.maxZ) / 2
/** 上香站位：供桌（含角色半徑）前方 0.3 公尺。 */
const HALL_CENSER_SPOT_Z = HALL_TABLE.maxZ + PLAYER_RADIUS + 0.3
/** 站位左右間距；兩側香爐靠柱子，只往內側多一個站位。 */
const CENSER_SPOT_GAP = 0.65

export const HALL_CENSERS: ReadonlyArray<CenserDef> = HALL_STATUE_IDS.map((id) => {
  const { x } = HALL_STATUES[id]
  const offsets = x === 0 ? [-CENSER_SPOT_GAP, 0, CENSER_SPOT_GAP] : [0, -Math.sign(x) * CENSER_SPOT_GAP]
  return {
    id: `hall:${id}`,
    zone: 'hall' as const,
    x,
    z: HALL_TABLE_Z,
    ashY: 1.22,
    sticks: { innerRadius: x === 0 ? 0.09 : 0, outerRadius: 0.17, length: 0.42, radius: 0.006, cap: 8 },
    permanent: x === 0 ? 3 : 0,
    spots: offsets.map((dx) => ({ x: x + dx, z: HALL_CENSER_SPOT_Z, heading: FACE_ALTAR })),
  }
})

/** 庭院大香爐：站在面向主殿的一側（+z），香爐障礙物（含角色半徑）前 0.1 公尺。 */
export const COURTYARD_CENSER: CenserDef = {
  id: 'courtyard',
  zone: 'courtyard',
  x: CENSER.x,
  z: CENSER.z,
  ashY: 0.9,
  // 中央三支常駐的大香（TempleScene 靜態幾何）佔 |dx| ≤ 0.15，玩家的香插在外圈
  sticks: { innerRadius: 0.24, outerRadius: 0.5, length: 0.62, radius: 0.011, cap: 16 },
  permanent: 0,
  spots: [-0.9, 0, 0.9].map((dx) => ({ x: CENSER.x + dx, z: CENSER.z + CENSER.radius + PLAYER_RADIUS + 0.1, heading: FACE_ALTAR })),
}

export const CENSERS: ReadonlyArray<CenserDef> = [COURTYARD_CENSER, ...HALL_CENSERS]

/** 庭院：殿門入口包含階梯及其前方空間，與伺服器的庭院入口一致。 */
const COURTYARD_DOOR: Rect = { minX: -1.6, maxX: 1.6, minZ: -6.2, maxZ: -4.65 }
/**
 * 點擊導向殿門的範圍：主殿本體加上其後方。點在屋頂或牆上時，射線會穿過建築打到後方地面，
 * 從庭院看不到主殿後方，點到那裡一定是點在建築上。
 */
const HALL_TAP_AREA: Rect = { minX: HALL.minX, maxX: HALL.maxX, minZ: -1000, maxZ: HALL.maxZ }
/** 殿內：門口內側。 */
const HALL_DOOR: Rect = { minX: -1.4, maxX: 1.4, minZ: 8.15, maxZ: 9 }

export const ZONES: Record<ZoneId, ZoneDef> = {
  courtyard: {
    id: 'courtyard',
    name: 'zone.courtyard',
    bounds: WORLD_BOUNDS,
    obstacles: OBSTACLES,
    spawn: SPAWN,
    portals: [{ rect: COURTYARD_DOOR, to: 'hall', spawn: { x: 0, z: 7.4, heading: Math.PI }, tapArea: HALL_TAP_AREA }],
    cameraBounds: null,
    // yaw 0：鏡頭在 +z（庭院）一側看向主殿；出殿時若鏡頭放在角色背後，會卡在角色與主殿之間被建築擋住
    camera: { distance: 10, min: 5, max: 20, yaw: 0 },
    restoreCamera: true,
  },
  hall: {
    id: 'hall',
    name: 'zone.hall',
    bounds: { minX: -7.4, maxX: 7.4, minZ: -5.2, maxZ: 8.6 },
    obstacles: [
      HALL_ALTAR,
      HALL_TABLE,
      ...HALL_PILLARS.map((p) => square(p.x, p.z, 0.32)),
    ].map((r) => pad(r, PLAYER_RADIUS)),
    spawn: { x: 0, z: 7.4, heading: Math.PI },
    // 出殿落點離殿門入口約 1.05 公尺，避免一出殿又往前走就立刻再次進殿；仍在香爐（z ≥ -2.75）前方
    portals: [{ rect: HALL_DOOR, to: 'courtyard', spawn: { x: 0, z: -3.6, heading: 0 } }],
    cameraBounds: { minX: -7.6, maxX: 7.6, minZ: -8.6, maxZ: 8.7, maxY: 6.4 },
    camera: { distance: 7, min: 3.5, max: 9 },
    restoreCamera: false,
  },
}

const inside = (r: Rect, x: number, z: number) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ

export interface CameraPose {
  yaw: number
  pitch: number
  distance: number
}

/**
 * 進入場景時的鏡頭：可還原的場景若有離開前的紀錄就原樣還原（距離限制在該場景範圍內），
 * 否則用場景的預設水平角度，沒有預設就放在角色背後。
 */
export function entryCamera(zone: ZoneId, pose: Pose, saved: CameraPose | undefined, currentPitch: number): CameraPose {
  const def = ZONES[zone]
  if (def.restoreCamera && saved) {
    return { ...saved, distance: Math.min(def.camera.max, Math.max(def.camera.min, saved.distance)) }
  }
  return { yaw: def.camera.yaw ?? pose.heading + Math.PI, pitch: currentPitch, distance: def.camera.distance }
}

/** 出入口範圍中最靠近可走區的點（玩家走向這裡即可觸發）。 */
export function portalApproach(p: Portal): { x: number; z: number } {
  return { x: (p.rect.minX + p.rect.maxX) / 2, z: (p.rect.minZ + p.rect.maxZ) / 2 }
}

/** 點擊位置若落在某出入口的 tapArea，回傳該出入口。 */
export function portalForTap(zone: ZoneId, x: number, z: number): Portal | null {
  return ZONES[zone].portals.find((p) => p.tapArea && inside(p.tapArea, x, z)) ?? null
}

/** 位置所在的出入口，沒有則 null。 */
export function portalAt(zone: ZoneId, x: number, z: number): Portal | null {
  return ZONES[zone].portals.find((p) => inside(p.rect, x, z)) ?? null
}

export const isZoneId = (v: unknown): v is ZoneId => typeof v === 'string' && (ZONE_IDS as readonly string[]).includes(v)
