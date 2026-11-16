<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { assetPresetFor, needsReload, saveSettings, type QualityLevel, type QualityPreset, type QualitySetting, type Settings } from '../game/core/settings'
import { LOCALES, t, type MessageKey } from '../i18n'
import LocaleSelect from './LocaleSelect.vue'

// settings 是父層的 reactive 物件，直接修改即可（由父層 watch 儲存並套用）。
const props = defineProps<{ settings: Settings; activeQuality: QualityLevel; loadedPreset: QualityPreset }>()
const emit = defineEmits<{ close: [] }>()

const dialog = ref<HTMLElement | null>(null)
const qualityLabel = (q: QualityLevel) => t(`quality.${q}`)
const qualityText = (q: QualitySetting) => (q === 'auto' ? t('quality.auto', { level: qualityLabel(props.activeQuality) }) : qualityLabel(q))

/** 需要署名的素材（CC BY 4.0）；來源與授權的完整紀錄在 docs/ASSETS.md。title 是原作品標題，不翻譯。 */
const credits: ReadonlyArray<{ use: MessageKey; title: string; author: string; url: string }> = [
  {
    use: 'credits.guanyin',
    title: '中国白瓷菩萨像 Chinese bodhisattva statue',
    author: 'efyilin',
    url: 'https://sketchfab.com/3d-models/chinese-bodhisattva-statue-3aa3accdebb0454a9eee5fd4fced0d19',
  },
  {
    use: 'credits.mazu',
    title: '9.拜殿神像 媽祖',
    author: 'cadyunlin2021',
    url: 'https://sketchfab.com/3d-models/9-2d5c1af855934957928e4e09bdde72e6',
  },
]
/** CC BY 授權頁面依目前語言指向對應的 deed。 */
const ccBy = computed(() => `https://creativecommons.org/licenses/by/4.0/deed.${LOCALES.find((l) => l.id === s.locale)?.ccDeed ?? 'en'}`)

/** 致謝句：字典裡以 {buddha}、{polyhaven} 標出連結的位置（各語言語序不同），拆成文字與連結依序繪製。 */
const thanksParts = computed(() => t('credits.thanks').split(/(\{buddha\}|\{polyhaven\})/).filter(Boolean))

const volumeFields = [
  { key: 'masterVolume', label: 'volume.master' },
  { key: 'musicVolume', label: 'volume.music' },
  { key: 'sfxVolume', label: 'volume.sfx' },
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
        <h2 id="settings-title">{{ t('settings.title') }}</h2>
        <button class="icon-btn" type="button" :aria-label="t('settings.close')" @click="emit('close')">✕</button>
      </header>

      <fieldset>
        <legend class="sr-only">{{ t('locale.label') }}</legend>
        <LocaleSelect v-model="s.locale" />
      </fieldset>

      <fieldset>
        <legend>{{ t('settings.quality') }}</legend>
        <div class="segmented" role="radiogroup" :aria-label="t('settings.quality')">
          <label v-for="q in (['auto', 'low', 'medium', 'high'] as const)" :key="q">
            <input v-model="s.quality" type="radio" name="quality" :value="q" />
            <span>{{ qualityText(q) }}</span>
          </label>
        </div>
        <p class="note">{{ t('settings.adaptiveNote') }}</p>
        <div role="status" aria-live="polite">
          <template v-if="reloadNeeded">
            <p class="note">{{ t('settings.reloadNote') }}</p>
            <button class="reload-btn" type="button" @click="reloadNow">{{ t('settings.reloadNow') }}</button>
          </template>
        </div>
      </fieldset>

      <fieldset>
        <legend>{{ t('settings.sound') }}</legend>
        <label v-for="f in volumeFields" :key="f.key" class="slider">
          <span>{{ t(f.label) }}</span>
          <input v-model.number="s[f.key]" type="range" min="0" max="1" step="0.05" />
          <output>{{ Math.round(s[f.key] * 100) }}</output>
        </label>
        <label class="toggle">
          <input v-model="s.muted" type="checkbox" />
          <span>{{ t('settings.mute') }}</span>
        </label>
      </fieldset>

      <fieldset>
        <legend>{{ t('settings.other') }}</legend>
        <label class="toggle">
          <input v-model="s.showStats" type="checkbox" />
          <span>{{ t('settings.showStats') }}</span>
        </label>
      </fieldset>

      <fieldset class="credits">
        <legend>{{ t('settings.credits') }}</legend>
        <ul>
          <li v-for="c in credits" :key="c.url">
            <span class="use">{{ t(c.use) }}</span>
            <a :href="c.url" target="_blank" rel="noopener noreferrer" lang="zh">{{ c.title }}</a>
            <span class="meta">
              {{ t('credits.author', { author: c.author }) }} ·
              <a :href="ccBy" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>
              · {{ t('credits.processed') }}
            </span>
          </li>
        </ul>
        <p class="note">
          <template v-for="(part, i) in thanksParts" :key="i">
            <a v-if="part === '{buddha}'" href="https://sketchfab.com/3d-models/197385-seated-buddha-d86bda08fa92458397596d2a42b30f46" target="_blank" rel="noopener noreferrer">{{ t('credits.buddhaTitle') }}</a>
            <a v-else-if="part === '{polyhaven}'" href="https://polyhaven.com/" target="_blank" rel="noopener noreferrer">Poly Haven</a>
            <template v-else>{{ part }}</template>
          </template>
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

/* 拉丁文字（英文、越南文）：中文用的寬字距改小 */
h2:is(:lang(en), :lang(vi)) {
  letter-spacing: 0.02em;
}

legend:is(:lang(en), :lang(vi)) {
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.74rem;
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

/* 越南文的「Âm lượng chung」較長，標籤欄放寬（360px 寬的手機上滑桿仍有約 90px） */
.slider:lang(vi) {
  grid-template-columns: 8.5em 1fr 2.5em;
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
