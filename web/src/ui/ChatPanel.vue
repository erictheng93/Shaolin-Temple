<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChatEntry, ChatSendResult } from '../game/GameCore'
import { CHAT_MAX_CHARS } from '../game/net/protocol'
import { t, type MessageKey } from '../i18n'

const props = defineProps<{ chat: ChatEntry[]; send: (text: string) => ChatSendResult }>()

const RECENT_COUNT = 5
const FADE_MS = 12_000
const HINTS: Record<Exclude<ChatSendResult, 'sent' | 'empty'>, MessageKey> = {
  rate: 'chat.rate',
  offline: 'chat.offline',
}

const open = ref(false)
const text = ref('')
/** 送出失敗的提示（存 key，顯示時才翻譯，提示期間切換語言也會跟著換）。 */
const hint = ref<MessageKey | null>(null)
const input = ref<HTMLInputElement | null>(null)
const logEl = ref<HTMLElement | null>(null)
const now = ref(performance.now())
const vvTop = ref(0)
let tickTimer: ReturnType<typeof setInterval> | null = null
let hintTimer: ReturnType<typeof setTimeout> | null = null

// 關閉時只顯示最近 5 則且 12 秒後淡出；開啟時顯示全部（最多 30 則）並可捲動。
const shown = computed(() => (open.value ? props.chat : props.chat.filter((c) => now.value - c.seen < FADE_MS).slice(-RECENT_COUNT)))
const faded = (c: ChatEntry) => !open.value && now.value - c.seen > FADE_MS - 1000

// 有還沒淡出的訊息時才每秒計時，平常不佔用 CPU。
function tick() {
  now.value = performance.now()
  if (!props.chat.some((c) => now.value - c.seen < FADE_MS) && tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

watch(
  () => props.chat,
  async () => {
    now.value = performance.now()
    if (!tickTimer) tickTimer = setInterval(tick, 1000)
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
)

function showHint(key: MessageKey) {
  hint.value = key
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => (hint.value = null), 2500)
}

async function openInput() {
  if (open.value) return
  open.value = true
  await nextTick()
  input.value?.focus()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
}

function closeInput() {
  open.value = false
  hint.value = null
  input.value?.blur()
}

function submit() {
  const res = props.send(text.value)
  if (res === 'sent') {
    text.value = ''
    hint.value = null
  } else if (res !== 'empty') {
    showHint(HINTS[res])
  }
  // 送出後保持開啟並維持焦點（手機上避免鍵盤收起）。
  input.value?.focus()
}

// 桌機：沒有焦點在輸入元件（含按鈕）時按 Enter 開啟輸入框。
function onWindowKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || open.value || e.isComposing) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
  e.preventDefault()
  void openInput()
}

// 手機：虛擬鍵盤開啟時 visual viewport 會捲動／縮小，面板跟著 visual viewport 的上緣，避免被推出畫面。
function onViewport() {
  vvTop.value = window.visualViewport?.offsetTop ?? 0
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKey)
  window.visualViewport?.addEventListener('resize', onViewport)
  window.visualViewport?.addEventListener('scroll', onViewport)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
  window.visualViewport?.removeEventListener('resize', onViewport)
  window.visualViewport?.removeEventListener('scroll', onViewport)
  if (tickTimer) clearInterval(tickTimer)
  if (hintTimer) clearTimeout(hintTimer)
})
</script>

<template>
  <section class="chat" :style="{ '--vv-top': vvTop + 'px' }" :aria-label="t('chat.label')">
    <ul v-if="shown.length" ref="logEl" class="log" :class="{ scroll: open }" aria-live="polite">
      <li v-for="c in shown" :key="c.seq" :class="{ self: c.self, faded: faded(c) }">
        <span class="who">{{ t('chat.who', { name: c.name }) }}</span><span class="msg">{{ c.text }}</span>
      </li>
    </ul>

    <form v-if="open" class="composer panel" @submit.prevent="submit" @keydown.esc.stop.prevent="closeInput">
      <input
        ref="input"
        v-model="text"
        type="text"
        :maxlength="CHAT_MAX_CHARS"
        :placeholder="t('chat.placeholder')"
        :aria-label="t('chat.inputLabel')"
        enterkeyhint="send"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
      <button type="submit" class="send">{{ t('chat.send') }}</button>
      <button type="button" class="close" :aria-label="t('chat.close')" @click="closeInput">✕</button>
    </form>
    <p v-if="open && hint" class="hint" role="status">{{ t(hint) }}</p>
  </section>

  <button v-if="!open" type="button" class="talk" :aria-label="t('chat.talk')" @click="openInput">
    <span aria-hidden="true">💬</span><span class="talk-label">{{ t('chat.talk') }}</span>
  </button>
</template>

<style scoped>
.chat {
  position: absolute;
  top: calc(max(12px, env(safe-area-inset-top)) + 60px + var(--vv-top, 0px));
  left: var(--gutter);
  width: min(360px, calc(100% - 24px));
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}

.log {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 0.9rem;
  line-height: 1.45;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  /* 展開後的紀錄與輸入框不超過畫面上方約 45%，不進入左下角（之後放虛擬搖桿的區域） */
  max-height: min(34dvh, 320px);
}

.log.scroll {
  overflow-y: auto;
  pointer-events: auto;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--panel);
  border: 1px solid var(--line);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  overscroll-behavior: contain;
}

.log li {
  overflow-wrap: anywhere;
  transition: opacity 1s;
}

.log li.faded {
  opacity: 0;
}

.who {
  color: var(--ink-soft);
}

.self .who,
.self .msg {
  color: var(--accent);
}

.composer {
  display: flex;
  gap: 6px;
  padding: 6px;
  pointer-events: auto;
}

.composer input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  /* 16px 以上，iOS 聚焦時才不會自動放大畫面 */
  font-size: 16px;
  color: var(--ink);
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.composer button {
  height: 40px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.06);
  font-size: 0.9rem;
}

.composer .send {
  background: rgba(214, 180, 110, 0.22);
}

.composer .close {
  padding: 0 10px;
  color: var(--ink-soft);
}

.hint {
  margin: 0;
  padding: 0 4px;
  font-size: 0.85rem;
  color: var(--warn);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
}

/* 右側、動作列上方：不擋動作列，也避開左下角的虛擬搖桿 */
.talk {
  position: absolute;
  right: max(12px, env(safe-area-inset-right));
  bottom: calc(max(16px, env(safe-area-inset-bottom)) + 88px);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 44px;
  height: 44px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  font-size: 0.9rem;
  transition: background 0.2s;
}

.talk:hover {
  background: var(--panel-strong);
}

@media (max-width: 420px) {
  .talk-label {
    display: none;
  }
}

/*
 * 橫向矮畫面（手機橫拿、瀏覽器還有工具列）：右側欄改成從底部往上排（說話 → 上車 → 廟會），動作列縮小並讓出兩側，
 * 搖桿提示圈貼底；聊天紀錄的高度收到提示圈上方，收起時只留最新幾則（舊的從上緣裁掉）。
 */
@media (orientation: landscape) and (max-height: 500px) {
  .talk {
    bottom: max(12px, env(safe-area-inset-bottom));
  }

  .log {
    /* 紀錄上緣（頂部列下方）到搖桿提示圈上緣（下緣偏移 + 圈高 120px + 8px 間隔）之間 */
    max-height: min(34dvh, 320px, calc(100dvh - max(12px, env(safe-area-inset-top)) - 60px - max(12px, env(safe-area-inset-bottom)) - 128px));
  }

  .log:not(.scroll) {
    overflow: hidden;
    justify-content: flex-end;
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 1.2em);
    mask-image: linear-gradient(to bottom, transparent, #000 1.2em);
  }
}
</style>
