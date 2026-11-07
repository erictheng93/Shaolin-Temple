<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ initialName: string; busy: boolean; ready: boolean }>()
const emit = defineEmits<{ enter: [name: string] }>()

const name = ref(props.initialName)

function submit() {
  // 進場按鈕同時是解鎖音訊的使用者操作，必須在這個事件中同步觸發。
  emit('enter', name.value.trim().slice(0, 16))
}
</script>

<template>
  <section class="entry" aria-labelledby="entry-title">
    <form class="card" @submit.prevent="submit">
      <p class="eyebrow">線上靜心空間</p>
      <h1 id="entry-title">少林寺</h1>
      <p class="lead">放慢腳步，與其他人安靜地共處片刻。<br />建議戴上耳機。</p>

      <label class="field">
        <span>你的名字（選填）</span>
        <input v-model="name" maxlength="16" autocomplete="nickname" placeholder="訪客" enterkeyhint="go" />
      </label>

      <button class="enter" type="submit" :disabled="busy || !ready">
        {{ busy ? '進入中…' : ready ? '入寺' : '準備場景…' }}
      </button>

      <p class="hint">點擊地面行走・拖曳轉動視角・雙指或滾輪縮放<br />鍵盤可用 WASD／方向鍵</p>
    </form>
  </section>
</template>

<style scoped>
.entry {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: radial-gradient(ellipse at center, rgba(27, 29, 36, 0.35), rgba(27, 29, 36, 0.85));
}

.card {
  width: min(380px, 100%);
  padding: 32px 28px 24px;
  text-align: center;
  background: var(--panel-strong);
  border: 1px solid var(--line);
  border-radius: 20px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.eyebrow {
  margin: 0;
  font-size: 0.8rem;
  letter-spacing: 0.3em;
  color: var(--accent);
}

h1 {
  margin: 8px 0 12px;
  font-family: var(--font-title);
  font-weight: 600;
  /* 五個字在 320px 寬的手機上也不溢出 */
  font-size: clamp(1.8rem, 9vw, 2.4rem);
  letter-spacing: 0.15em;
  text-indent: 0.15em;
  white-space: nowrap;
}

.lead {
  margin: 0 0 24px;
  color: var(--ink-soft);
  line-height: 1.8;
}

.field {
  display: grid;
  gap: 6px;
  text-align: left;
  font-size: 0.85rem;
  color: var(--ink-soft);
}

.field input {
  height: 46px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.25);
  font-size: 1rem;
}

.enter {
  width: 100%;
  height: 50px;
  margin-top: 18px;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 0.4em;
  text-indent: 0.4em;
  transition: filter 0.2s, opacity 0.2s;
}

.enter:hover:not(:disabled) {
  filter: brightness(1.08);
}

.enter:disabled {
  opacity: 0.6;
  cursor: progress;
}

.hint {
  margin: 18px 0 0;
  font-size: 0.78rem;
  line-height: 1.7;
  color: var(--ink-faint);
}
</style>
