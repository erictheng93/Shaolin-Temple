<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 浮動式虛擬搖桿（僅觸控裝置）：手指按下處成為底座中心，拖曳時推桿跟隨，鬆開回到預設位置。
 * 高頻的向量不進 Vue 響應式：直接呼叫 setStick，推桿以 style transform 更新 DOM。
 */
const props = defineProps<{ setStick: (x: number, y: number) => void }>()

const BASE = 120
const KNOB = 52
const RADIUS = BASE / 2
const DEAD_ZONE = 0.12

const coarse = window.matchMedia('(any-pointer: coarse)')
const show = ref(coarse.matches)
const zone = ref<HTMLElement | null>(null)
const base = ref<HTMLElement | null>(null)
const knob = ref<HTMLElement | null>(null)
const idle = ref(true)

let pointerId = -1
let cx = 0
let cy = 0

const onCoarseChange = (e: MediaQueryListEvent) => {
  show.value = e.matches
  if (!e.matches) reset()
}

onMounted(() => {
  coarse.addEventListener('change', onCoarseChange)
  window.addEventListener('blur', reset)
  document.addEventListener('visibilitychange', onHidden)
})

onBeforeUnmount(() => {
  coarse.removeEventListener('change', onCoarseChange)
  window.removeEventListener('blur', reset)
  document.removeEventListener('visibilitychange', onHidden)
  reset()
})

function onHidden() {
  if (document.hidden) reset()
}

function place(x: number, y: number) {
  if (base.value) base.value.style.transform = `translate(${x - RADIUS}px, ${y - RADIUS}px)`
}

function moveKnob(dx: number, dy: number) {
  if (knob.value) knob.value.style.transform = `translate(${dx}px, ${dy}px)`
}

function reset() {
  const was = pointerId !== -1
  pointerId = -1
  idle.value = true
  moveKnob(0, 0)
  if (was) props.setStick(0, 0)
}

function onDown(e: PointerEvent) {
  if (pointerId !== -1 || !zone.value) return
  pointerId = e.pointerId
  zone.value.setPointerCapture(e.pointerId)
  const r = zone.value.getBoundingClientRect()
  // 底座中心限制在觸控區內，避免貼邊時底座被切掉
  cx = Math.min(r.width - RADIUS, Math.max(RADIUS, e.clientX - r.left))
  cy = Math.min(r.height - RADIUS, Math.max(RADIUS, e.clientY - r.top))
  idle.value = false
  place(cx, cy)
  moveKnob(0, 0)
  onMoveEvent(e)
}

function onMoveEvent(e: PointerEvent) {
  if (e.pointerId !== pointerId || !zone.value) return
  const r = zone.value.getBoundingClientRect()
  let dx = e.clientX - r.left - cx
  let dy = e.clientY - r.top - cy
  const len = Math.hypot(dx, dy)
  if (len > RADIUS) {
    dx = (dx / len) * RADIUS
    dy = (dy / len) * RADIUS
  }
  moveKnob(dx, dy)
  // 類比輸出：死區內為 0，死區外重新映射到 0～1
  const m = Math.min(1, len / RADIUS)
  if (m < DEAD_ZONE) {
    props.setStick(0, 0)
  } else {
    const s = (m - DEAD_ZONE) / (1 - DEAD_ZONE)
    props.setStick((dx / Math.min(len, RADIUS)) * s, (dy / Math.min(len, RADIUS)) * s)
  }
}

function onEnd(e: PointerEvent) {
  if (e.pointerId === pointerId) reset()
}
</script>

<template>
  <div
    v-if="show"
    ref="zone"
    class="zone"
    @pointerdown.prevent="onDown"
    @pointermove="onMoveEvent"
    @pointerup="onEnd"
    @pointercancel="onEnd"
    @lostpointercapture="onEnd"
  >
    <div
      ref="base"
      class="base"
      :class="{ idle }"
      :style="{ width: BASE + 'px', height: BASE + 'px' }"
      aria-hidden="true"
    >
      <div ref="knob" class="knob" :style="{ width: KNOB + 'px', height: KNOB + 'px' }" />
    </div>
  </div>
</template>

<style scoped>
/* 觸控區：左下約 45% × 45%。ActionBar 在它之後繪製，疊在上方，按鈕不受影響。 */
.zone {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 45%;
  height: 45%;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.base {
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.1);
  pointer-events: none;
}

/* 閒置：在 ActionBar 上方的左下角顯示提示 */
.base.idle {
  top: auto;
  bottom: calc(max(16px, env(safe-area-inset-bottom)) + 84px);
  left: 20px;
  transform: none !important;
  opacity: 0.55;
}

.knob {
  position: absolute;
  left: 50%;
  top: 50%;
  margin: -26px 0 0 -26px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.55);
}
</style>
