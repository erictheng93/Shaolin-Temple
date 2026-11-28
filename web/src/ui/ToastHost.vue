<script setup lang="ts">
defineProps<{ toasts: Array<{ id: number; text: string }> }>()
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast panel">{{ t.text }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: absolute;
  left: 50%;
  bottom: calc(max(16px, env(safe-area-inset-bottom)) + 100px);
  transform: translateX(-50%);
  display: grid;
  gap: 8px;
  justify-items: center;
  width: min(420px, calc(100% - 32px));
  pointer-events: none;
  /* 最上層（層級見 App.vue 的 .notice） */
  z-index: 70;
}

.toast {
  padding: 10px 16px;
  font-size: 0.9rem;
  text-align: center;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
