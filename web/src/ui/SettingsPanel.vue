<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { assetPresetFor, needsReload, saveSettings, type QualityLevel, type QualityPreset, type Settings } from '../game/core/settings'

// settings 是父層的 reactive 物件，直接修改即可（由父層 watch 儲存並套用）。
const props = defineProps<{ settings: Settings; activeQuality: QualityLevel; loadedPreset: QualityPreset }>()
const emit = defineEmits<{ close: [] }>()

const dialog = ref<HTMLElement | null>(null)
const qualityLabels: Record<QualityLevel, string> = { low: '省電', medium: '標準', high: '高畫質' }

/** 需要署名的素材（CC BY 4.0）；來源與授權的完整紀錄在 docs/ASSETS.md。 */
const credits = [
  {
    use: '觀世音菩薩像',
    title: '中国白瓷菩萨像 Chinese bodhisattva statue',
    author: 'efyilin',
    url: 'https://sketchfab.com/3d-models/chinese-bodhisattva-statue-3aa3accdebb0454a9eee5fd4fced0d19',
  },
  {
    use: '媽祖像',
    title: '9.拜殿神像 媽祖',
    author: 'cadyunlin2021',
    url: 'https://sketchfab.com/3d-models/9-2d5c1af855934957928e4e09bdde72e6',
  },
] as const
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/deed.zh-hant'

const volumeFields = [
  { key: 'masterVolume', label: '總音量' },
  { key: 'musicVolume', label: '環境與音樂' },
  { key: 'sfxVolume', label: '音效' },
] as const

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  dialog.value?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const s = props.settings

// 貼圖、陰影與神像在載入時決定；選到的畫質與本次載入的內容不同時，提示重新載入。
const reloadNeeded = computed(() => needsReload(props.loadedPreset, assetPresetFor(s.quality)))

function reloadNow() {
  saveSettings(s) // 父層 watch 是非同步儲存，重新載入前先確實寫入
  location.reload()
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <section ref="dialog" class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1">
      <header>
        <h2 id="settings-title">設定</h2>
        <button class="icon-btn" type="button" aria-label="關閉設定" @click="emit('close')">✕</button>
      </header>

      <fieldset>
        <legend>畫質</legend>
        <div class="segmented" role="radiogroup" aria-label="畫質">
          <label v-for="q in (['auto', 'low', 'medium', 'high'] as const)" :key="q">
            <input v-model="s.quality" type="radio" name="quality" :value="q" />
            <span>{{ q === 'auto' ? `自動（${qualityLabels[activeQuality]}）` : qualityLabels[q] }}</span>
          </label>
        </div>
        <p class="note">畫面變慢時會自動降低解析度與遠處角色的細節，順暢後再恢復。</p>
        <div role="status" aria-live="polite">
          <template v-if="reloadNeeded">
            <p class="note">貼圖、陰影與神像要重新載入後才會套用。</p>
            <button class="reload-btn" type="button" @click="reloadNow">重新載入並套用</button>
          </template>
        </div>
      </fieldset>

      <fieldset>
        <legend>聲音</legend>
        <label v-for="f in volumeFields" :key="f.key" class="slider">
          <span>{{ f.label }}</span>
          <input v-model.number="s[f.key]" type="range" min="0" max="1" step="0.05" />
          <output>{{ Math.round(s[f.key] * 100) }}</output>
        </label>
        <label class="toggle">
          <input v-model="s.muted" type="checkbox" />
          <span>靜音</span>
        </label>
      </fieldset>

      <fieldset>
        <legend>其他</legend>
        <label class="toggle">
          <input v-model="s.showStats" type="checkbox" />
          <span>顯示效能資訊</span>
        </label>
      </fieldset>

      <fieldset class="credits">
        <legend>素材來源</legend>
        <ul>
          <li v-for="c in credits" :key="c.url">
            <span class="use">{{ c.use }}</span>
            <a :href="c.url" target="_blank" rel="noopener noreferrer">{{ c.title }}</a>
            <span class="meta">
              作者 {{ c.author }} ·
              <a :href="CC_BY" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>
              · 已減面並重新烘焙貼圖
            </span>
          </li>
        </ul>
        <p class="note">
          致謝：釋迦牟尼佛像取自
          <a href="https://sketchfab.com/3d-models/197385-seated-buddha-d86bda08fa92458397596d2a42b30f46" target="_blank" rel="noopener noreferrer">Cleveland Museum of Art「1973.85 Seated Buddha」</a>（CC0）；場景貼圖取自
          <a href="https://polyhaven.com/" target="_blank" rel="noopener noreferrer">Poly Haven</a>（CC0）。
        </p>
      </fieldset>
    </section>
  </div>
</template>

<style scoped>
.credits ul {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.credits li {
  display: grid;
  gap: 2px;
  font-size: 0.86rem;
  line-height: 1.5;
}

.credits .use {
  font-size: 0.78rem;
  color: var(--ink-faint);
}

.credits .meta {
  font-size: 0.78rem;
  color: var(--ink-soft);
}

.credits a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}

.credits li > a {
  color: var(--accent);
}

.backdrop {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(10, 11, 14, 0.4);
}

.sheet {
  width: min(420px, 100%);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  padding: 20px;
  background: var(--panel-strong);
  border: 1px solid var(--line);
  border-radius: 18px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  outline: none;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

h2 {
  margin: 0;
  font-family: var(--font-title);
  font-weight: 600;
  letter-spacing: 0.2em;
}

fieldset {
  margin: 0;
  padding: 14px 0;
  border: 0;
  border-top: 1px solid var(--line);
}

legend {
  padding: 0 0 10px;
  font-size: 0.8rem;
  letter-spacing: 0.2em;
  color: var(--accent);
}

.segmented {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.segmented label {
  position: relative;
}

.segmented input {
  position: absolute;
  opacity: 0;
}

.segmented span {
  display: grid;
  place-items: center;
  min-height: 44px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--line);
  font-size: 0.88rem;
  text-align: center;
  cursor: pointer;
}

.segmented input:checked + span {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.segmented input:focus-visible + span {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.note {
  margin: 10px 0 0;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--ink-faint);
}

.reload-btn {
  min-height: 44px;
  margin-top: 8px;
  padding: 6px 16px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-ink);
  font: inherit;
  font-size: 0.88rem;
  cursor: pointer;
}

.reload-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.slider {
  display: grid;
  grid-template-columns: 5.5em 1fr 2.5em;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  font-size: 0.9rem;
}

.slider input {
  width: 100%;
  accent-color: var(--accent);
}

.slider output {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  font-size: 0.9rem;
  cursor: pointer;
}

.toggle input {
  width: 20px;
  height: 20px;
  accent-color: var(--accent);
}
</style>
