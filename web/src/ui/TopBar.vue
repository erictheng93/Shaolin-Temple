<script setup lang="ts">
import { computed } from 'vue'
import type { UiState } from '../game/GameCore'
import { t } from '../i18n'

const props = defineProps<{ ui: UiState; muted: boolean }>()
defineEmits<{ toggleMute: []; openSettings: [] }>()

const status = computed(() => {
  if (!props.ui.networkEnabled) return { text: t('top.solo'), tone: 'idle' }
  switch (props.ui.status) {
    case 'online':
      return { text: t('top.online'), tone: 'ok' }
    case 'connecting':
      return { text: t('top.connecting'), tone: 'warn' }
    case 'reconnecting':
      return { text: t('top.reconnecting'), tone: 'warn' }
    default:
      return { text: t('top.offline'), tone: 'bad' }
  }
})
</script>

<template>
  <header class="top">
    <div class="info panel" role="status" aria-live="polite">
      <span class="dot" :data-tone="status.tone" aria-hidden="true" />
      <span>{{ status.text }}</span>
      <template v-if="ui.networkEnabled && ui.status === 'online'">
        <span class="sep" aria-hidden="true">·</span>
        <span>{{ t('top.inTemple', { count: ui.online }) }}</span>
      </template>
      <template v-for="s in ui.stats" :key="s.key">
        <span class="sep" aria-hidden="true">·</span>
        <span>{{ s.label }} {{ s.value }}</span>
      </template>
    </div>

    <div class="tools">
      <button class="icon-btn" type="button" :aria-pressed="muted" :aria-label="muted ? t('top.unmute') : t('top.mute')" @click="$emit('toggleMute')">
        <svg v-if="!muted" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></svg>
        <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="m17 9 5 6M22 9l-5 6" /></svg>
      </button>
      <button class="icon-btn" type="button" :aria-label="t('top.settings')" @click="$emit('openSettings')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.top {
  position: absolute;
  top: max(12px, env(safe-area-inset-top));
  left: var(--gutter);
  right: max(12px, env(safe-area-inset-right));
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  pointer-events: none;
}

.top > * {
  pointer-events: auto;
}

.info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 10px 16px;
  border-radius: 999px;
  font-size: 0.88rem;
  color: var(--ink-soft);
}

.sep {
  color: var(--ink-faint);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-faint);
}

.dot[data-tone='ok'] {
  background: var(--ok);
}

.dot[data-tone='warn'] {
  background: var(--warn);
  animation: pulse 1.4s ease-in-out infinite;
}

.dot[data-tone='bad'] {
  background: var(--bad);
}

.tools {
  display: flex;
  gap: 8px;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
