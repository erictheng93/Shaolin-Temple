import { HALL, OBSTACLES, PLAYER_RADIUS, SPAWN, WORLD_BOUNDS, type Rect } from './layout'

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
  /** 顯示名稱（進入時提示）。 */
  name: string
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
 * 依傳統以神明為主體：主佛左手邊（龍邊，+x）為觀世音菩薩，右手邊（虎邊，-x）為關聖帝君。
 */
export const HALL_STATUES = {
  buddha: { x: 0, z: -7.3 },
  guanyin: { x: 4.3, z: -6.9 },
  guangong: { x: -4.3, z: -6.9 },
} as const
/** 拜墊（不阻擋行走）。 */
export const HALL_CUSHIONS: ReadonlyArray<{ x: number; z: number }> = [
  { x: HALL_STATUES.guangong.x, z: -3.3 },
  { x: 0, z: -3.3 },
  { x: HALL_STATUES.guanyin.x, z: -3.3 },
]

/** 庭院：殿門前的階梯即入口（主殿障礙物邊緣 z≈-5.85），往前延伸到階梯前方約 0.85 公尺。 */
const COURTYARD_DOOR: Rect = { minX: -1.6, maxX: 1.6, minZ: -6.2, maxZ: -5.0 }
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
    name: '庭院',
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
    name: '少林寺',
    bounds: { minX: -7.4, maxX: 7.4, minZ: -5.2, maxZ: 8.6 },
    obstacles: [
      HALL_ALTAR,
      HALL_TABLE,
      ...HALL_PILLARS.map((p) => square(p.x, p.z, 0.32)),
    ].map((r) => pad(r, PLAYER_RADIUS)),
    spawn: { x: 0, z: 7.4, heading: Math.PI },
    // 出殿落點離殿門入口（maxZ -5.0）約 1.4 公尺，避免一出殿又往前走就立刻再次進殿；仍在香爐（z ≥ -2.75）前方
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
