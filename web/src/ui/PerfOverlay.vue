<script setup lang="ts">
import type { UiState } from '../game/GameCore'
import { t } from '../i18n'

defineProps<{ ui: UiState }>()
</script>

<template>
  <aside class="perf" :aria-label="t('perf.label')">
    <div>{{ ui.perf.fps }} FPS</div>
    <div>CPU {{ ui.perf.frameMs.toFixed(1) }} ms</div>
    <div>{{ ui.perf.calls }} draw · {{ (ui.perf.triangles / 1000).toFixed(1) }}k tri</div>
    <div>{{ t('perf.quality', { quality: ui.quality, level: ui.adaptive.level, max: ui.adaptive.max }) }}</div>
    <div v-if="ui.perf.rttMs !== null">RTT {{ Math.round(ui.perf.rttMs) }} ms</div>
  </aside>
</template>

<style scoped>
.perf {
  position: absolute;
  left: var(--gutter);
  top: calc(max(12px, env(safe-area-inset-top)) + 56px);
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: #cfe8cf;
  pointer-events: none;
}
</style>
