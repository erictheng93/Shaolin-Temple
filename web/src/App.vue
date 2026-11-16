<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { GameCore, type UiState } from './game/GameCore'
import { loadSettings, resolveQuality, saveSettings } from './game/core/settings'
import EntryScreen from './ui/EntryScreen.vue'
import TopBar from './ui/TopBar.vue'
import ActionBar from './ui/ActionBar.vue'
import SettingsPanel from './ui/SettingsPanel.vue'
import PerfOverlay from './ui/PerfOverlay.vue'
import ToastHost from './ui/ToastHost.vue'

const canvas = ref<HTMLCanvasElement | null>(null)
const settings = reactive(loadSettings())
// 本次載入時實際採用的資產預設（含自動畫質的網路降級，與 GameCore 建構時相同）；之後切換畫質，部分項目要重新載入才生效。
const loadedPreset = assetPresetFor(settings.quality)
// UI 狀態整包替換，用 shallowRef 避免深層響應式追蹤。
const ui = shallowRef<UiState | null>(null)
const entered = ref(false)
const entering = ref(false)
const settingsOpen = ref(false)
const fatal = ref<string | null>(null)
const toasts = ref<Array<{ id: number; text: string }>>([])
let toastId = 0

// 遊戲核心不放進響應式系統：Three.js 物件與高頻狀態由核心自己管理。
let core: GameCore | null = null

function toast(text: string) {
  const id = ++toastId
  toasts.value = [...toasts.value.slice(-2), { id, text }]
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 3500)
}

onMounted(() => {
  if (!canvas.value) return
  try {
    core = new GameCore({
      canvas: canvas.value,
      settings: { ...settings },
      wsUrl: import.meta.env.VITE_WS_URL || undefined,
      onUi: (s) => (ui.value = s),
      onToast: toast,
    })
    core.start()
    // 開發模式除錯用：瀏覽器主控台可用 window.__game 檢查狀態（正式建置會移除）。
    if (import.meta.env.DEV) (window as unknown as { __game: GameCore }).__game = core
  } catch (err) {
    console.error(err)
    fatal.value = '此裝置或瀏覽器無法啟用 WebGL，請更新瀏覽器或改用其他裝置。'
  }
})

onBeforeUnmount(() => {
  core?.dispose()
  core = null
})

watch(
  settings,
  (s) => {
    saveSettings(s)
    core?.applySettings({ ...s })
  },
  { deep: true },
)

async function enter(name: string) {
  if (!core || entering.value) return
  entering.value = true
  settings.playerName = name
  try {
    await core.enter(name || '訪客')
    entered.value = true
  } finally {
    entering.value = false
  }
}

function toggleMute() {
  settings.muted = !settings.muted
}
</script>

<template>
  <main class="stage">
    <canvas ref="canvas" class="scene" aria-label="寺院場景，點擊地面移動，拖曳旋轉視角" tabindex="0" />
    <!-- 場景切換黑幕；淡出時間需與 GameCore 的 FADE_MS 一致 -->
    <div class="fade" :class="{ on: ui?.fading }" aria-hidden="true" />

    <template v-if="entered && ui">
      <TopBar
        :ui="ui"
        :muted="settings.muted"
        @toggle-mute="toggleMute"
        @open-settings="settingsOpen = true"
      />
      <ActionBar :actions="ui.actions" @perform="(id) => core?.performAction(id)" />
      <PerfOverlay v-if="settings.showStats" :ui="ui" />
    </template>

    <SettingsPanel v-if="settingsOpen" :settings="settings" :active-quality="ui?.quality ?? 'medium'" :loaded-preset="loadedPreset" @close="settingsOpen = false" />

    <Transition name="fade">
      <EntryScreen
        v-if="!entered && !fatal"
        :initial-name="settings.playerName"
        :busy="entering"
        :ready="!!ui"
        @enter="enter"
      />
    </Transition>

    <div v-if="ui?.contextLost" class="notice panel" role="status">畫面暫時中斷，正在恢復…</div>
    <div v-if="fatal" class="notice panel" role="alert">{{ fatal }}</div>

    <ToastHost :toasts="toasts" />
  </main>
</template>

<style scoped>
.stage {
  position: relative;
  width: 100%;
  height: 100%;
  height: 100dvh;
}

.scene {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  outline: none;
}

.fade {
  position: absolute;
  inset: 0;
  background: #0b0806;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.4s ease;
}

.fade.on {
  opacity: 1;
}

.notice {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: min(420px, calc(100% - 32px));
  padding: 16px 20px;
  text-align: center;
  line-height: 1.6;
}

.fade-leave-active {
  transition: opacity 0.8s ease;
}

.fade-leave-to {
  opacity: 0;
}
</style>
