import { afterEach, describe, expect, it, vi } from 'vitest'
import { PIVOT_HEIGHT, PROP_INCENSE, PROP_NONE } from '../../render/AvatarFactory'
import { t } from '../../../i18n'
import { HALL_CENSERS } from '../../world/zones'
import { pose, setup } from './testHarness'
import { INCENSE_MS, PLANT_AT, PROSTRATE_BOWS, PROSTRATE_MS } from './worship'

afterEach(() => {
  vi.useRealTimers()
})

describe('worship 模組', () => {
  it('註冊合十、跪拜、誦經（與不顯示的起身）、上香、敲鐘；uninstall 清除全部註冊', () => {
    const { anim, actions, sfx, uninstall } = setup()
    expect(actions.list().map((a) => a.id)).toEqual(['bow', 'prostrate', 'chant', 'chant_end', 'incense', 'bell'])
    expect(actions.list().filter((a) => !a.hidden).map((a) => t(a.label))).toEqual(['合十', '跪拜', '誦經', '上香', '敲鐘'])
    expect(actions.get('chant')!.endAction).toBe('chant_end')
    const clips = ['prostrate', 'incense', 'chant', 'chantEnd', 'bellStrike']
    expect(clips.every((c) => anim.hasClip(c))).toBe(true)
    expect(sfx.size).toBeGreaterThan(0)
    uninstall()
    expect(actions.list()).toEqual([])
    expect(clips.some((c) => anim.hasClip(c))).toBe(false)
    expect(sfx.size).toBe(0)
  })

  it('跪拜、誦經只在殿內，敲鐘只在庭院；不能用時有原因', () => {
    const { actions } = setup()
    expect(actions.get('chant')!.unavailableReason!('courtyard')).toContain('殿內')
    expect(actions.get('chant')!.unavailableReason!('hall')).toBeNull()
    expect(actions.get('prostrate')!.unavailableReason!('courtyard')).toBeTruthy()
    expect(actions.get('prostrate')!.unavailableReason!('hall')).toBeNull()
    expect(actions.get('bell')!.unavailableReason!('hall')).toBeTruthy()
    expect(actions.get('bell')!.unavailableReason!('courtyard')).toBeNull()
    expect(actions.get('incense')!.unavailableReason).toBeUndefined()
  })

  it('跪拜動畫：跪下、三次叩拜到底（引磬對齊）、起身回到原姿勢', () => {
    const { anim } = setup()
    expect(pose(anim, 'prostrate', PROSTRATE_MS, 0).pivot.rotation.x).toBeCloseTo(0)
    expect(pose(anim, 'prostrate', PROSTRATE_MS, 0.999).pivot.position.y).toBeCloseTo(PIVOT_HEIGHT, 2)
    expect(PROSTRATE_BOWS).toHaveLength(3)
    for (const b of PROSTRATE_BOWS) {
      // 壓磬（起身的號令）那一刻還叩在底
      const low = pose(anim, 'prostrate', PROSTRATE_MS, (b.up * 1000) / PROSTRATE_MS)
      expect(low.pivot.rotation.x).toBeCloseTo(1.0, 1)
      expect(low.pivot.position.y).toBeCloseTo(PIVOT_HEIGHT - 0.3)
      // 引磬（拜下的號令）那一刻是跪姿（前傾小、仍跪著），兩次叩拜之間會回到這裡
      const kneeling = pose(anim, 'prostrate', PROSTRATE_MS, (b.down * 1000) / PROSTRATE_MS)
      expect(kneeling.pivot.rotation.x).toBeLessThan(0.3)
      expect(kneeling.pivot.position.y).toBeCloseTo(PIVOT_HEIGHT - 0.3)
    }
  })

  it('上香動畫：插香前手上有香，插香後沒有', () => {
    const { anim } = setup()
    expect(pose(anim, 'incense', INCENSE_MS, 0.3).prop).toBe(PROP_INCENSE)
    expect(pose(anim, 'incense', INCENSE_MS, PLANT_AT + 0.02).prop).toBe(PROP_NONE)
  })

  it('任一玩家上香：插香時依他當時的位置找香爐並插一支香；uninstall 後不再插', () => {
    vi.useFakeTimers()
    const { events, offered, positions, uninstall } = setup()
    const censer = HALL_CENSERS[1]!
    const spot = censer.spots[0]!
    // 收到動作時遠端位置還沒到（仍在走道上），插香時才到站位
    positions.set('p-remote', { x: 0, z: 2, zone: 'hall' })
    const startedAt = performance.now()
    events.emit('actionPerformed', { playerId: 'p-remote', actionId: 'incense', local: false, zone: 'hall', startedAt, x: 0, z: 2 })
    positions.set('p-remote', { x: spot.x + 0.3, z: spot.z + 0.2, zone: 'hall' })
    vi.advanceTimersByTime(INCENSE_MS)
    expect(offered).toEqual([censer.id])

    events.emit('actionPerformed', { playerId: 'p-remote', actionId: 'incense', local: false, zone: 'hall', startedAt: performance.now(), x: 0, z: 2 })
    uninstall()
    vi.advanceTimersByTime(INCENSE_MS)
    expect(offered).toHaveLength(1)
  })
})
