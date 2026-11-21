<script setup lang="ts">
import type { RideUi } from '../game/vehicles/Vehicles'
import { CAR_KINDS } from '../game/world/vehicles'
import { t, type MessageKey } from '../i18n'

const props = defineProps<{
  ride: RideUi
  onToggle?: () => void
  onClaim?: (kind: number) => void
}>()

const emit = defineEmits<{
  toggle: []
  claim: [kind: number]
}>()

const RARITY_KEYS: Record<'common' | 'rare' | 'mythic', MessageKey> = {
  common: 'ride.rarity.common',
  rare: 'ride.rarity.rare',
  mythic: 'ride.rarity.mythic',
}

function leftCount(i: number): number {
  return props.ride.booth?.left[i] ?? 0
}

function handleToggle() {
  props.onToggle?.()
  emit('toggle')
}

function handleClaim(kind: number) {
  props.onClaim?.(kind)
  emit('claim', kind)
}
</script>

<template>
  <!-- 右側欄、說話按鈕上方：上車／下車按鈕 -->
  <button
    v-if="ride.riding || ride.nearCar"
    type="button"
    class="ride-btn"
    :class="{ riding: ride.riding }"
    :aria-label="t(ride.riding ? 'ride.dismount' : 'ride.mount')"
    @click="handleToggle"
  >
    <span class="ride-icon" aria-hidden="true">{{ ride.riding ? '🚪' : '🏎️' }}</span>
    <span class="ride-label">{{ t(ride.riding ? 'ride.dismount' : 'ride.mount') }}</span>
    <span class="key-hint" aria-hidden="true">E</span>
  </button>

  <!-- 檔口前且未騎乘：四格領車面板（不可蓋住左下 45% 搖桿區與底端動作列） -->
  <section
    v-if="ride.booth && !ride.riding"
    class="booth-panel panel"
    :aria-label="t('ride.boothTitle')"
  >
    <div class="booth-header">
      <span class="booth-title">{{ t('ride.boothTitle') }}</span>
    </div>

    <div class="booth-grid">
      <button
        v-for="(kind, i) in CAR_KINDS"
        :key="kind.id"
        type="button"
        class="booth-card"
        :class="kind.rarity"
        :disabled="leftCount(i) <= 0"
        @click="handleClaim(i)"
      >
        <div class="card-head">
          <span class="kind-name">{{ t(kind.label) }}</span>
          <span class="rarity" :class="kind.rarity">{{ t(RARITY_KEYS[kind.rarity]) }}</span>
        </div>
        <div class="card-meta">
          <span class="count" :class="{ empty: leftCount(i) <= 0 }">
            {{ leftCount(i) > 0 ? t('ride.left', { n: leftCount(i) }) : t('ride.soldOut') }}
          </span>
        </div>
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 右側欄、說話按鈕上方：不擋動作列，也避開左下角的虛擬搖桿 */
.ride-btn {
  position: absolute;
  right: max(12px, env(safe-area-inset-right));
  bottom: calc(max(16px, env(safe-area-inset-bottom)) + 140px);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 44px;
  height: 44px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  font-size: 0.9rem;
  color: var(--ink);
  cursor: pointer;
  transition: background 0.2s, transform 0.12s, border-color 0.2s;
  z-index: 10;
}

.ride-btn:hover {
  background: var(--panel-strong);
}

.ride-btn:active {
  transform: scale(0.96);
}

.ride-btn.riding {
  border-color: var(--accent);
  color: var(--accent);
}

.key-hint {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  font-size: 0.72rem;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.12);
  color: var(--ink-soft);
  margin-left: 2px;
}

@media (pointer: coarse) {
  .key-hint {
    display: none;
  }
}

/* 檔口面板：置於右上區域（TopBar 下方），避開左下 45%×45% 搖桿區與底端動作列 */
.booth-panel {
  position: absolute;
  top: calc(max(12px, env(safe-area-inset-top)) + 56px);
  right: max(12px, env(safe-area-inset-right));
  width: min(320px, calc(100% - 24px));
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 15;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.booth-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.booth-title {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--ink);
  letter-spacing: 0.5px;
}

.booth-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.booth-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 10px;
  min-height: 58px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.05);
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
}

.booth-card:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--accent);
}

.booth-card:active:not(:disabled) {
  transform: scale(0.97);
}

.booth-card:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  filter: grayscale(0.6);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.kind-name {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rarity {
  font-size: 0.68rem;
  padding: 1px 4px;
  border-radius: 4px;
  white-space: nowrap;
  font-weight: 600;
}

.rarity.common {
  background: rgba(255, 255, 255, 0.1);
  color: var(--ink-soft);
}

.rarity.rare {
  background: rgba(70, 140, 240, 0.2);
  color: #72b0f4;
  border: 1px solid rgba(70, 140, 240, 0.4);
}

.rarity.mythic {
  background: rgba(227, 184, 102, 0.25);
  color: var(--accent);
  border: 1px solid rgba(227, 184, 102, 0.6);
}

.card-meta {
  display: flex;
  align-items: center;
}

.count {
  font-size: 0.75rem;
  color: var(--ink-soft);
}

.count.empty {
  color: var(--bad);
}
</style>
