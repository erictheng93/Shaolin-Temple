<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { GameCore, type UiState } from './game/GameCore'
import { clearAuth, consumeAuthRedirect, httpBaseFromWs, loadAuth, loginUrl, markLoginPending, type AuthProvider } from './game/core/auth'
import { assetPresetFor, loadSettings, saveSettings } from './game/core/settings'
import { setLocale, t } from './i18n'
import EntryScreen from './ui/EntryScreen.vue'
import TopBar from './ui/TopBar.vue'
import ActionBar from './ui/ActionBar.vue'
import Joystick from './ui/Joystick.vue'
import SettingsPanel from './ui/SettingsPanel.vue'
import PerfOverlay from './ui/PerfOverlay.vue'
import ChatPanel from './ui/ChatPanel.vue'
import RidePanel from './ui/RidePanel.vue'
import ToastHost from './ui/ToastHost.vue'

const WS_URL: string | undefined = import.meta.env.VITE_WS_URL || undefined
/** 登入用的伺服器 HTTP 基底；離線模式為 null（入寺畫面不顯示登入選項）。 */
const AUTH_BASE = httpBaseFromWs(WS_URL)

// 登入完成導回時網址帶著權杖：先存下並立刻清掉 fragment。導回後不自動進場（音訊需要使用者手勢）。
const authRedirect = consumeAuthRedirect()
const canvas = ref<HTMLCanvasElement | null>(null)
const settings = reactive(loadSettings())
setLocale(settings.locale)
// 本次載入時實際採用的資產預設（含自動畫質的網路降級，與 GameCore 建構時相同）；之後切換畫質，部分項目要重新載入才生效。
const loadedPreset = assetPresetFor(settings.quality)
/** 本機存的登入狀態（只在入寺畫面用；進場後的身份以 GameCore 的 ui.auth 為準）。 */
const auth = shallowRef(authRedirect?.kind === 'session' ? authRedirect.auth : loadAuth())
// UI 狀態整包替換，用 shallowRef 避免深層響應式追蹤。
const ui = shallowRef<UiState | null>(null)
const entered = ref(false)
const entering = ref(false)
const settingsOpen = ref(false)

// 觸控裝置與螢幕方向：直向開車時提示轉成橫向。移動輪盤一律在左下角（左手移動、右手按鈕）。
const coarseMq = window.matchMedia('(any-pointer: coarse)')
const landscapeMq = window.matchMedia('(orientation: landscape)')
const touch = ref(coarseMq.matches)
const landscape = ref(landscapeMq.matches)
const onMq = () => {
  touch.value = coarseMq.matches
  landscape.value = landscapeMq.matches
}
coarseMq.addEventListener('change', onMq)
landscapeMq.addEventListener('change', onMq)
onBeforeUnmount(() => {
  coarseMq.removeEventListener('change', onMq)
  landscapeMq.removeEventListener('change', onMq)
})
const fatal = ref(false)
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
      wsUrl: WS_URL,
      onUi: (s) => (ui.value = s),
      onToast: toast,
      onNameChanged: (name) => (settings.playerName = name),
    })
    core.start()
    // 開發模式除錯用：瀏覽器主控台可用 window.__game 檢查狀態（正式建置會移除）。
    if (import.meta.env.DEV) (window as unknown as { __game: GameCore }).__game = core
  } catch (err) {
    console.error(err)
    fatal.value = true
  }
  if (authRedirect?.kind === 'error') {
    toast(t(authRedirect.error === 'cancelled' ? 'auth.cancelled' : 'auth.failed'))
  }
})

onBeforeUnmount(() => {
  core?.dispose()
  core = null
})

// 衣裝以 GameCore 為準（也可能從主控台或之後的網路校正改變），同步回設定以便儲存與面板顯示。
watch(
  () => ui.value?.outfit,
  (o) => {
    if (o !== undefined && o !== settings.outfit) settings.outfit = o
  },
)

watch(
  settings,
  (s) => {
    saveSettings(s)
    // 先切換語言再套用：applySettings 會強制推送 UiState，動作列與 HUD 的字串在推送當下以新語言解析。
    setLocale(s.locale)
    core?.applySettings({ ...s })
  },
  { deep: true },
)

async function enter(name: string) {
  if (!core || entering.value) return
  entering.value = true
  settings.playerName = name
  try {
    await core.enter(name, auth.value)
    entered.value = true
  } finally {
    entering.value = false
  }
}

/** 整頁導向登入。先把名字存起來，導回後入寺畫面仍是同一個名字。 */
function login(provider: AuthProvider, name: string) {
  if (!AUTH_BASE) return
  settings.playerName = name
  saveSettings({ ...settings })
  // 回來時只採用這個分頁自己發起的登入（防 login CSRF）；旗標寫不進去就無法完成登入，不導向
  if (!markLoginPending()) {
    toast(t('auth.unsupported'))
    return
  }
  location.assign(loginUrl(AUTH_BASE, provider, location.origin))
}

/** 入寺畫面的登出：只清本機權杖，不需要打伺服器。 */
function logoutBeforeEnter() {
  clearAuth()
  auth.value = null
}

/** 進場後的登出：清權杖後重新整理，回到入寺畫面（連線以訪客身份重新建立，簡單可靠）。 */
function logoutAndReload() {
  clearAuth()
  location.reload()
}

function toggleMute() {
  settings.muted = !settings.muted
}
</script>

<template>
  <main class="stage">
    <canvas ref="canvas" class="scene" :aria-label="t('app.sceneLabel')" tabindex="0" />
    <!-- 場景切換黑幕；淡出時間需與 GameCore 的 FADE_MS 一致 -->
    <div class="fade" :class="{ on: ui?.fading }" aria-hidden="true" />

    <template v-if="entered && ui">
      <TopBar
        :ui="ui"
        :muted="settings.muted"
        @toggle-mute="toggleMute"
        @open-settings="settingsOpen = true"
      />
      <Joystick :set-stick="(x, y) => core?.setMoveStick(x, y)" :suspended="ui.fading" />
      <ActionBar :actions="ui.actions" @perform="(id) => core?.performAction(id)" />
      <RidePanel
        v-if="ui.ride"
        :ride="ui.ride"
        :touch="touch"
        :landscape="landscape"
        @toggle="() => core?.toggleRide()"
        @claim="() => core?.claimCar()"
        @close="() => core?.setClaimOpen(false)"
      />
      <ChatPanel :chat="ui.chat" :send="(t) => core?.sendChat(t) ?? 'offline'" />
      <PerfOverlay v-if="settings.showStats" :ui="ui" />
    </template>

    <SettingsPanel
      v-if="settingsOpen"
      :settings="settings"
      :active-quality="ui?.quality ?? 'medium'"
      :loaded-preset="loadedPreset"
      :auth="ui?.auth ?? 'guest'"
      @rename="(name) => core?.rename(name)"
      @logout="logoutAndReload"
      @close="settingsOpen = false"
    />

    <Transition name="fade">
      <EntryScreen
        v-if="!entered && !fatal"
        v-model:locale="settings.locale"
        :initial-name="settings.playerName"
        :outfit="settings.outfit"
        :busy="entering"
        :ready="!!ui"
        :auth-base="AUTH_BASE"
        :logged-in="auth?.provider ?? null"
        @enter="enter"
        @outfit="(o) => (settings.outfit = o)"
        @login="login"
        @logout="logoutBeforeEnter"
      />
    </Transition>

    <div v-if="ui?.contextLost" class="notice panel" role="status">{{ t('app.contextLost') }}</div>
    <div v-if="fatal" class="notice panel" role="alert">{{ t('app.webglFailed') }}</div>

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
