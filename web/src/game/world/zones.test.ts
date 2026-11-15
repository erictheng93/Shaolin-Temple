import { describe, expect, it } from 'vitest'
import { resolveCollisions, stepMover, type MoveConfig } from './movement'
import { HALL } from './layout'
import { findPath } from './pathfind'
import {
  CENSERS,
  CUSHION_RADIUS,
  HALL_AISLE_HALF_WIDTH,
  HALL_CENSERS,
  HALL_CUSHIONS,
  HALL_PILLARS,
  HALL_STATUES,
  HALL_TABLE,
  ZONES,
  ZONE_IDS,
  entryCamera,
  isZoneId,
  portalApproach,
  portalAt,
  portalForTap,
} from './zones'

const cfgFor = (id: keyof typeof ZONES): MoveConfig => ({ speed: 3.2, bounds: ZONES[id].bounds, obstacles: ZONES[id].obstacles })

describe('zones', () => {
  it('出生點與出入口落點都在可走範圍、不在障礙物或出入口內（避免來回瞬移）', () => {
    for (const id of ZONE_IDS) {
      const zone = ZONES[id]
      const poses = [zone.spawn, ...ZONE_IDS.flatMap((other) => ZONES[other].portals.filter((p) => p.to === id).map((p) => p.spawn))]
      for (const pose of poses) {
        expect(resolveCollisions(pose.x, pose.z, cfgFor(id)), `${id} 落點被推出障礙物`).toEqual({ x: pose.x, z: pose.z })
        expect(portalAt(id, pose.x, pose.z), `${id} 落點在出入口內`).toBeNull()
      }
    }
  })

  it('從庭院出生點直走向殿門會進入殿內出入口；殿內走回門口會觸發回庭院', () => {
    for (const [id, target] of [['courtyard', { x: 0, z: -20 }], ['hall', { x: 0, z: 20 }]] as const) {
      const from = id === 'courtyard' ? ZONES.hall.portals[0]!.spawn : ZONES.hall.spawn
      const s = { x: from.x, z: from.z, heading: 0, target }
      let hit = null
      for (let i = 0; i < 200 && !hit; i++) {
        stepMover(s, { dirX: 0, dirZ: 0 }, 0.05, cfgFor(id))
        if (!s.target) s.target = target // 撞到障礙物會放棄目標，重新指定以模擬持續往前走
        hit = portalAt(id, s.x, s.z)
      }
      expect(hit?.to).toBe(id === 'courtyard' ? 'hall' : 'courtyard')
    }
  })

  it('神像方位：以神明為主體，觀音在主佛左手邊（+x，龍邊），媽祖在右手邊（-x，虎邊）', () => {
    expect(HALL_STATUES.buddha.x).toBe(0)
    expect(HALL_STATUES.guanyin.x).toBeGreaterThan(0)
    expect(HALL_STATUES.mazu.x).toBeLessThan(0)
  })

  it('點擊主殿建築會導向殿門，且殿門的走近點可抵達並觸發入口', () => {
    const portal = portalForTap('courtyard', 0, -12)
    expect(portal?.to).toBe('hall')
    const approach = resolveCollisions(portalApproach(portal!).x, portalApproach(portal!).z, cfgFor('courtyard'))
    expect(portalAt('courtyard', approach.x, approach.z)?.to).toBe('hall')
    expect(portalForTap('courtyard', 0.6, -63.7)?.to).toBe('hall') // 實測：點屋頂時射線落在很遠的後方
    expect(portalForTap('courtyard', 0, 5)).toBeNull()
  })

  it('出殿：還原進殿前的庭院鏡頭（距離限制在庭院範圍內）', () => {
    const exit = ZONES.hall.portals[0]!.spawn
    const saved = { yaw: 0.3, pitch: 0.5, distance: 99 }
    expect(entryCamera('courtyard', exit, saved, 0.4)).toEqual({ yaw: 0.3, pitch: 0.5, distance: ZONES.courtyard.camera.max })
  })

  it('出殿且沒有紀錄時，鏡頭在庭院一側看向主殿，不會被主殿擋住', () => {
    const exit = ZONES.hall.portals[0]!.spawn // 角色面朝庭院（heading 0）站在殿門前
    const { yaw, pitch, distance } = entryCamera('courtyard', exit, undefined, 0.4)
    const camZ = exit.z + Math.cos(yaw) * Math.cos(pitch) * distance
    expect(camZ).toBeGreaterThan(exit.z) // 鏡頭在庭院一側
    // 舊做法（鏡頭放在角色背後）會讓鏡頭落進主殿建築裡
    const oldCamZ = exit.z + Math.cos(exit.heading + Math.PI) * Math.cos(pitch) * distance
    expect(oldCamZ).toBeGreaterThan(HALL.minZ)
    expect(oldCamZ).toBeLessThan(HALL.maxZ)
  })

  it('進殿：一律放在角色背後看向神龕，不還原', () => {
    const enter = ZONES.courtyard.portals[0]!.spawn
    const cam = entryCamera('hall', enter, { yaw: 1, pitch: 1, distance: 1 }, 0.4)
    expect(cam.yaw).toBeCloseTo(enter.heading + Math.PI)
    expect(cam.distance).toBe(ZONES.hall.camera.distance)
  })

  it('出殿落點與殿門入口保持至少 1 公尺緩衝，避免立刻再次進殿', () => {
    const exit = ZONES.hall.portals[0]!.spawn
    const door = ZONES.courtyard.portals[0]!.rect
    expect(exit.z - door.maxZ).toBeGreaterThanOrEqual(1)
  })

  describe('參拜點（蒲團、香爐前站位）', () => {
    const spots = [
      ...HALL_CUSHIONS.map((p, i) => ({ zone: 'hall' as const, name: `蒲團 ${i}`, p })),
      ...CENSERS.flatMap((c) => c.spots.map((p, i) => ({ zone: c.zone, name: `${c.id} 站位 ${i}`, p }))),
    ]

    it('蒲團 24 個：左右各 3 欄 × 4 排，避開中軸走道，全部面向神龕', () => {
      expect(HALL_CUSHIONS).toHaveLength(24)
      expect(HALL_CUSHIONS.filter((c) => c.x < 0)).toHaveLength(12)
      for (const c of HALL_CUSHIONS) {
        expect(Math.abs(c.x) - CUSHION_RADIUS).toBeGreaterThan(HALL_AISLE_HALF_WIDTH)
        expect(c.heading).toBe(Math.PI)
      }
    })

    it('都在可走範圍內、不在障礙物或出入口裡', () => {
      for (const { zone, name, p } of spots) {
        expect(resolveCollisions(p.x, p.z, cfgFor(zone)), name).toEqual({ x: p.x, z: p.z })
        expect(portalAt(zone, p.x, p.z), name).toBeNull()
      }
    })

    it('從入口可經尋路走到，且照路徑走會停在站位上', () => {
      for (const { zone, name, p } of spots) {
        const starts = zone === 'hall' ? [ZONES.hall.spawn] : [ZONES.courtyard.spawn, ZONES.hall.portals[0]!.spawn]
        for (const start of starts) {
          const path = findPath(start, p, cfgFor(zone))
          expect(path, `${name} 從 (${start.x}, ${start.z})`).not.toBeNull()
          // 與 GameCore 相同的走法：一段一段走到轉折點
          const s = { x: start.x, z: start.z, heading: 0, target: path!.shift() ?? null }
          for (let i = 0; i < 2000 && s.target; i++) {
            const target = s.target
            stepMover(s, { dirX: 0, dirZ: 0 }, 0.05, cfgFor(zone))
            if (!s.target) s.target = Math.hypot(target.x - s.x, target.z - s.z) < 0.2 ? (path!.shift() ?? null) : null
          }
          expect(Math.hypot(s.x - p.x, s.z - p.z), name).toBeLessThan(0.3)
        }
      }
    })

    it('彼此不重疊：跪拜的角色互不碰到，香爐前的站位也不壓到蒲團', () => {
      // 跪拜的佔地（見 zones.ts 的說明）：左右半寬 0.3，前方 0.8、後方 0.22（面向 -z）
      const kneel = (c: { x: number; z: number }) => ({ minX: c.x - 0.3, maxX: c.x + 0.3, minZ: c.z - 0.8, maxZ: c.z + 0.22 })
      const overlap = (a: ReturnType<typeof kneel>, b: ReturnType<typeof kneel>) =>
        a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ
      HALL_CUSHIONS.forEach((a, i) =>
        HALL_CUSHIONS.forEach((b, j) => {
          if (i >= j) return
          expect(overlap(kneel(a), kneel(b)), `蒲團 ${i} 與 ${j}`).toBe(false)
          // 相鄰兩欄之間留得下一個人走過（角色寬約 0.43，碰撞直徑 0.7）
          if (a.z === b.z) expect(Math.abs(a.x - b.x) - 0.6).toBeGreaterThanOrEqual(0.6)
        }),
      )
      const all = [...HALL_CUSHIONS.map((c) => ({ ...c, r: CUSHION_RADIUS })), ...CENSERS.filter((c) => c.zone === 'hall').flatMap((c) => c.spots.map((s) => ({ ...s, r: 0.3 })))]
      all.forEach((a, i) => all.forEach((b, j) => i < j && expect(Math.hypot(a.x - b.x, a.z - b.z), `${i}-${j}`).toBeGreaterThan(a.r + b.r)))
      // 上香的人（前傾時頭約到前方 0.6）與第一排叩拜的頭之間留空
      const frontRow = Math.min(...HALL_CUSHIONS.map((c) => c.z))
      for (const c of HALL_CENSERS) for (const s of c.spots) expect(frontRow - 0.8 - (s.z + 0.22)).toBeGreaterThan(0.5)
    })

    it('蒲團不壓到柱子（柱礎半徑 0.42）', () => {
      for (const c of HALL_CUSHIONS) for (const p of HALL_PILLARS) expect(Math.hypot(c.x - p.x, c.z - p.z)).toBeGreaterThan(CUSHION_RADIUS + 0.42)
    })

    it('殿內香爐在供桌上、每尊神像正前方各一個（由 HALL_STATUES 導出）', () => {
      expect(HALL_CENSERS.map((c) => c.x).sort()).toEqual(Object.values(HALL_STATUES).map((s) => s.x).sort())
      for (const c of HALL_CENSERS) {
        expect(c.x - 0.27).toBeGreaterThan(HALL_TABLE.minX)
        expect(c.x + 0.27).toBeLessThan(HALL_TABLE.maxX)
        expect(c.z).toBeGreaterThan(HALL_TABLE.minZ)
        expect(c.z).toBeLessThan(HALL_TABLE.maxZ)
        for (const s of c.spots) expect(s.z).toBeGreaterThan(HALL_TABLE.maxZ)
      }
    })
  })

  it('isZoneId 只接受已知場景', () => {
    expect(isZoneId('hall')).toBe(true)
    expect(isZoneId('roof')).toBe(false)
    expect(isZoneId(undefined)).toBe(false)
  })
})
