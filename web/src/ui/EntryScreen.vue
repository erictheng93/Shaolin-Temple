<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PROVIDER_LABELS, fetchProviders, type AuthProvider } from '../game/core/auth'
import { NAME_MAX_CHARS, normalizeName, randomTempleName } from '../game/core/names'
import { t, type Locale } from '../i18n'
import IconShuffle from './IconShuffle.vue'
import LocaleSelect from './LocaleSelect.vue'
import OutfitPicker from './OutfitPicker.vue'

const props = defineProps<{
  initialName: string
  busy: boolean
  ready: boolean
  outfit: number
  /** 伺服器的 HTTP 基底；離線模式為 null（不顯示登入選項）。 */
  authBase: string | null
  /** 目前登入的提供者；未登入為 null。 */
  loggedIn: AuthProvider | null
}>()
const emit = defineEmits<{ enter: [name: string]; outfit: [outfit: number]; login: [provider: AuthProvider, name: string]; logout: [] }>()

// 第一次來（沒有存過名字）預填一個隨機法號；使用者可以自由改。
const name = ref(props.initialName || randomTempleName())
/** 進寺前就能換語言；與設定面板是同一個設定欄位。 */
const locale = defineModel<Locale>('locale', { required: true })
const providers = ref<AuthProvider[]>([])
let alive = true

onMounted(() => {
  // 掛載時抓一次；失敗、逾時或離線模式都當作沒有登入選項，不顯示錯誤。
  void fetchProviders(props.authBase).then((list) => {
    if (alive) providers.value = list
  })
})
onBeforeUnmount(() => (alive = false))

const showLogin = computed(() => !props.loggedIn && providers.value.length > 0)

function shuffle() {
  name.value = randomTempleName()
}

function submit() {
  // 進場按鈕同時是解鎖音訊的使用者操作，必須在這個事件中同步觸發。清空時用當下隨機的法號。
  emit('enter', normalizeName(name.value))
}

function login(provider: AuthProvider) {
  emit('login', provider, normalizeName(name.value))
}
</script>

<template>
  <section class="entry" aria-labelledby="entry-title">
    <form class="card" :class="{ wide: showLogin }" @submit.prevent="submit">
      <!-- 放在最上方：看不懂目前語言的玩家第一眼就找得到 -->
      <LocaleSelect v-model="locale" compact class="lang" />
      <div class="intro">
        <p class="eyebrow">{{ t('entry.eyebrow') }}</p>
        <h1 id="entry-title">{{ t('app.title') }}</h1>
        <p class="lead">{{ t('entry.lead') }}<br />{{ t('entry.headphones') }}</p>
      </div>

      <div class="form">
        <p v-if="loggedIn" class="status">
          <span>{{ t('auth.loggedInWith', { provider: PROVIDER_LABELS[loggedIn] }) }}</span>
          <button class="text-btn" type="button" @click="emit('logout')">{{ t('auth.logout') }}</button>
        </p>

        <label class="field" for="entry-name">{{ t('entry.nameLabel') }}</label>
        <div class="name-row">
          <input
            id="entry-name"
            v-model="name"
            :maxlength="NAME_MAX_CHARS"
            autocomplete="nickname"
            enterkeyhint="go"
            spellcheck="false"
            :placeholder="t('entry.namePlaceholder')"
          />
          <button class="shuffle" type="button" :aria-label="t('entry.shuffleName')" :title="t('entry.shuffleName')" @click="shuffle">
            <IconShuffle />
          </button>
        </div>

        <div class="field outfit">
          <span>{{ t('outfit.label') }}</span>
          <OutfitPicker :model-value="outfit" @update:model-value="(o) => emit('outfit', o)" />
        </div>

        <button class="enter" :class="{ long: showLogin }" type="submit" :disabled="busy || !ready">
          {{ busy ? t('entry.entering') : !ready ? t('entry.preparing') : showLogin ? t('entry.enterAsGuest') : t('entry.enter') }}
        </button>

        <template v-if="showLogin">
          <p class="divider" role="separator"><span>{{ t('entry.orLogin') }}</span></p>
          <div class="providers">
            <button v-if="providers.includes('google')" class="provider google" type="button" :disabled="busy" @click="login('google')">
              <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              <span>{{ t('auth.loginWith', { provider: PROVIDER_LABELS.google }) }}</span>
            </button>
            <button v-if="providers.includes('line')" class="provider line" type="button" :disabled="busy" @click="login('line')">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                <path
                  fill="#fff"
                  d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"
                />
              </svg>
              <span>{{ t('auth.loginWith', { provider: PROVIDER_LABELS.line }) }}</span>
            </button>
          </div>
          <p class="privacy">{{ t('auth.privacy') }}</p>
        </template>
      </div>

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

.status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin: 0 0 14px;
  font-size: 0.85rem;
  color: var(--ink-soft);
}

.text-btn {
  min-height: 32px;
  padding: 0 8px;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 0.85rem;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.field {
  display: block;
  margin-bottom: 6px;
  text-align: left;
  font-size: 0.85rem;
  color: var(--ink-soft);
}

/* 衣裝：標題在上、選單在下，與名字欄隔開 */
.field.outfit {
  display: grid;
  gap: 6px;
  margin: 14px 0 0;
}

.name-row {
  display: flex;
  gap: 8px;
}

.name-row input {
  flex: 1;
  min-width: 0;
  height: 46px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.25);
  font-size: 1rem;
  letter-spacing: 0.08em;
}

.shuffle {
  display: grid;
  place-items: center;
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.25);
  color: var(--ink-soft);
  transition: color 0.2s, border-color 0.2s;
}

.shuffle:hover {
  color: var(--accent);
  border-color: rgba(214, 180, 110, 0.5);
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

/* 「以訪客身份入寺」字多，字距收一點 */
.enter.long {
  letter-spacing: 0.16em;
  text-indent: 0.16em;
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

.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 14px;
  font-size: 0.78rem;
  letter-spacing: 0.15em;
  color: var(--ink-faint);
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--line);
}

.providers {
  display: grid;
  gap: 10px;
}

/* 品牌按鈕：等寬、等高（≥ 46px 觸控高度），圖示在左、文字置中 */
.provider {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 46px;
  padding: 0 48px;
  border-radius: 10px;
  font-size: 0.95rem;
  font-weight: 500;
  transition: filter 0.2s, opacity 0.2s;
}

.provider svg {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
}

.provider:disabled {
  opacity: 0.6;
}

/* Google 品牌規範的深色款：#131314 底、#8E918F 邊、#E3E3E3 字，配官方多色 G */
.provider.google {
  background: #131314;
  border: 1px solid #8e918f;
  color: #e3e3e3;
}

.provider.google:hover:not(:disabled) {
  background: #1d1d1f;
}

/* LINE 品牌規範：#06C755 底、白字、白色 LINE 標誌，標誌與文字之間一條分隔線 */
.provider.line {
  background: #06c755;
  border: 1px solid #06c755;
  color: #fff;
}

.provider.line::after {
  content: '';
  position: absolute;
  left: 46px;
  top: 0;
  bottom: 0;
  border-left: 1px solid rgba(0, 0, 0, 0.08);
}

.provider.line:hover:not(:disabled) {
  filter: brightness(0.95);
}

.provider.line:active:not(:disabled) {
  filter: brightness(0.85);
}

.privacy {
  margin: 12px 0 0;
  font-size: 0.72rem;
  line-height: 1.6;
  color: var(--ink-faint);
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

  .divider {
    margin: 12px 0 10px;
  }

  .providers {
    gap: 8px;
  }

  .privacy {
    margin-top: 8px;
  }

  .hint {
    margin-top: 10px;
  }
}

/* 橫向手機且有登入選項：左右兩欄（左邊標題與說明，右邊名字與按鈕），主要按鈕不必捲動。 */
@media (max-height: 480px) and (min-width: 600px) {
  .card.wide {
    display: grid;
    grid-template-columns: 1fr 1.15fr;
    grid-template-areas:
      'lang lang'
      'intro form'
      'hint form';
    column-gap: 28px;
    align-items: center;
    width: min(700px, 100%);
  }

  .card.wide .lang {
    grid-area: lang;
  }

  .card.wide .intro {
    grid-area: intro;
    align-self: end;
  }

  .card.wide .form {
    grid-area: form;
  }

  .card.wide .hint {
    grid-area: hint;
    align-self: start;
    margin-top: 0;
  }

  .card.wide .lead {
    margin-bottom: 10px;
  }

  .card.wide .enter {
    margin-top: 10px;
  }
}
</style>
