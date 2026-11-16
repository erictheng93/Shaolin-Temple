<script setup lang="ts">
import { ref } from 'vue'
import { t, type Locale } from '../i18n'
import LocaleSelect from './LocaleSelect.vue'
import OutfitPicker from './OutfitPicker.vue'

const props = defineProps<{ initialName: string; busy: boolean; ready: boolean; outfit: number }>()
const emit = defineEmits<{ enter: [name: string]; outfit: [outfit: number] }>()

const name = ref(props.initialName)
/** 進寺前就能換語言；與設定面板是同一個設定欄位。 */
const locale = defineModel<Locale>('locale', { required: true })

function submit() {
  // 進場按鈕同時是解鎖音訊的使用者操作，必須在這個事件中同步觸發。
  emit('enter', name.value.trim().slice(0, 16))
}
</script>

<template>
  <section class="entry" aria-labelledby="entry-title">
    <form class="card" @submit.prevent="submit">
      <!-- 放在最上方：看不懂目前語言的玩家第一眼就找得到 -->
      <LocaleSelect v-model="locale" compact class="lang" />
      <p class="eyebrow">{{ t('entry.eyebrow') }}</p>
      <h1 id="entry-title">{{ t('app.title') }}</h1>
      <p class="lead">{{ t('entry.lead') }}<br />{{ t('entry.headphones') }}</p>

      <label class="field">
        <span>{{ t('entry.nameLabel') }}</span>
        <input v-model="name" maxlength="16" autocomplete="nickname" :placeholder="t('player.visitor')" enterkeyhint="go" />
      </label>

      <div class="field">
        <span>{{ t('outfit.label') }}</span>
        <OutfitPicker :model-value="outfit" @update:model-value="(o) => emit('outfit', o)" />
      </div>

      <button class="enter" type="submit" :disabled="busy || !ready">
        {{ busy ? t('entry.entering') : ready ? t('entry.enter') : t('entry.preparing') }}
      </button>

      <p class="hint">{{ t('entry.hintPointer') }}<br />{{ t('entry.hintKeys') }}</p>
    </form>
  </section>
</template>

<style scoped>
/* 用 flex + margin:auto 置中：卡片比畫面高時（橫向手機）可以捲動，頂端不會被切掉。 */
.entry {
  position: absolute;
  inset: 0;
  display: flex;
  overflow-y: auto;
  padding: 16px;
  background: radial-gradient(ellipse at center, rgba(27, 29, 36, 0.35), rgba(27, 29, 36, 0.85));
}

.card {
  margin: auto;
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

/* 拉丁文字（英文、越南文）：中文用的寬字距在拉丁字母下顯得鬆散，改小；寺名較長，允許換行 */
.eyebrow:is(:lang(en), :lang(vi)) {
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-size: 0.72rem;
}

h1:is(:lang(en), :lang(vi)) {
  letter-spacing: 0.02em;
  text-indent: 0;
  white-space: normal;
  font-size: clamp(1.7rem, 8vw, 2.2rem);
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

.field + .field {
  margin-top: 14px;
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

.enter:not(:lang(zh)) {
  letter-spacing: 0.06em;
  text-indent: 0;
}

.enter:lang(ja) {
  letter-spacing: 0.2em;
  text-indent: 0.2em;
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

.lang {
  /* 疊進卡片上方的留白，不增加卡片高度 */
  margin: -22px -14px -6px 0;
}

/* 橫向手機：壓縮間距，讓按鈕盡量不用捲動就看得到。 */
@media (max-height: 480px) {
  .card {
    padding: 16px 24px 14px;
  }

  .lang {
    margin-top: -10px;
  }

  h1 {
    margin: 4px 0 6px;
    font-size: 1.8rem;
  }

  .lead {
    margin-bottom: 12px;
    line-height: 1.5;
  }

  .enter {
    margin-top: 12px;
  }

  .hint {
    margin-top: 10px;
  }
}
</style>
