<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { UiAction } from '../game/GameCore'

const props = defineProps<{ actions: UiAction[] }>()
defineEmits<{ perform: [id: string] }>()

// 只有在有動作冷卻中時才計時，平常不佔用 CPU。
const now = ref(performance.now())
let timer: ReturnType<typeof setInterval> | null = null

function tick() {
  now.value = performance.now()
  if (!props.actions.some((a) => a.readyAt > now.value) && timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(
  () => props.actions,
  (list) => {
    now.value = performance.now()
    if (!timer && list.some((a) => a.readyAt > now.value)) timer = setInterval(tick, 100)
  },
  { immediate: true },
)

// 按鈕超出寬度（窄螢幕）時可橫向捲動：在還有按鈕的那一側邊緣淡出，提示可以滑動。
const nav = ref<HTMLElement | null>(null)
const fadeLeft = ref(false)
const fadeRight = ref(false)
function updateFade() {
  const el = nav.value
  if (!el) return
  fadeLeft.value = el.scrollLeft > 2
  fadeRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
}
const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateFade)
watch(nav, (el, old) => {
  if (old) resize?.unobserve(old)
  if (el) resize?.observe(el)
  updateFade()
})
watch(
  () => props.actions.length,
  () => void nextTick(updateFade),
)
onMounted(updateFade)

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  resize?.disconnect()
})

const progress = (a: UiAction) => (a.readyAt > now.value ? (a.readyAt - now.value) / a.cooldownMs : 0)
</script>

<template>
  <nav
    v-if="actions.length"
    ref="nav"
    class="bar"
    :class="{ 'fade-left': fadeLeft, 'fade-right': fadeRight }"
    aria-label="動作"
    @scroll.passive="updateFade"
  >
    <button
      v-for="a in actions"
      :key="a.id"
      type="button"
      class="action"
      :class="{ unavailable: a.unavailable }"
      :disabled="!a.unavailable && progress(a) > 0"
      :aria-disabled="a.unavailable ? 'true' : undefined"
      :title="a.unavailable"
      :style="{ '--p': a.unavailable ? 0 : progress(a) }"
      @click="$emit('perform', a.id)"
    >
      <span class="ring" aria-hidden="true" />
      <span v-if="a.glyph" class="glyph" aria-hidden="true">{{ a.glyph }}</span>
      <span class="label">{{ a.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.bar {
  position: absolute;
  left: 50%;
  bottom: max(16px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  padding: 8px;
  max-width: calc(100% - 24px);
  overflow-x: auto;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--line);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  scrollbar-width: none;
  overscroll-behavior-x: contain;
}

.bar::-webkit-scrollbar {
  display: none;
}

/* 還有按鈕在畫面外的一側淡出 */
.bar.fade-right {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 36px), transparent);
  mask-image: linear-gradient(to right, #000 calc(100% - 36px), transparent);
}

.bar.fade-left {
  -webkit-mask-image: linear-gradient(to left, #000 calc(100% - 36px), transparent);
  mask-image: linear-gradient(to left, #000 calc(100% - 36px), transparent);
}

.bar.fade-left.fade-right {
  -webkit-mask-image: linear-gradient(to right, transparent, #000 36px, #000 calc(100% - 36px), transparent);
  mask-image: linear-gradient(to right, transparent, #000 36px, #000 calc(100% - 36px), transparent);
}

.action {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 2px;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.06);
  transition: background 0.2s, transform 0.12s;
}

.action:hover:not(:disabled) {
  background: rgba(214, 180, 110, 0.22);
}

.action:active:not(:disabled) {
  transform: scale(0.95);
}

.action:disabled {
  cursor: default;
  color: var(--ink-faint);
}

/* 目前場景不能用：變暗但仍可按，按下時由遊戲核心提示原因（手機沒有滑鼠提示） */
.action.unavailable {
  color: var(--ink-faint);
  opacity: 0.55;
  border-style: dashed;
}

/* 冷卻遮罩：--p 從 1 降到 0 */
.ring {
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  background: conic-gradient(rgba(0, 0, 0, 0.45) calc(var(--p) * 360deg), transparent 0);
  pointer-events: none;
}

.glyph {
  font-size: 1.3rem;
  line-height: 1;
}

.label {
  font-size: 0.75rem;
  letter-spacing: 0.1em;
}

/* 手機直式：五個按鈕在 390 寬（含 360 寬）排得下；更窄時可橫向捲動 */
@media (max-width: 420px) {
  .bar {
    gap: 8px;
    padding: 7px;
  }

  .action {
    width: 60px;
    height: 60px;
  }
}

@media (max-width: 370px) {
  .bar {
    gap: 6px;
  }

  .action {
    width: 56px;
    height: 56px;
  }
}
</style>
