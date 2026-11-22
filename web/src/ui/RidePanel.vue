<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { RideUi } from '../game/vehicles/Vehicles'
import { CAR_KINDS, formatCountdown, sessionBlocks } from '../game/world/vehicles'
import { t, type MessageKey } from '../i18n'

const props = defineProps<{ ride: RideUi; touch?: boolean; landscape?: boolean }>()
const emit = defineEmits<{ toggle: []; claim: []; close: []; fair: [] }>()

const RARITY_KEYS: Record<'common' | 'rare' | 'mythic', MessageKey> = {
  common: 'ride.rarity.common',
  rare: 'ride.rarity.rare',
  mythic: 'ride.rarity.mythic',
}

const claim = computed(() => props.ride.claim ?? { open: false, pending: false, result: null, error: null })
const won = computed(() => (claim.value.result === null ? null : (CAR_KINDS[claim.value.result] ?? null)))
/** 右側按鈕：騎乘中是下車，旁邊有空車是上車，在領車 NPC 前是「領車」。 */
const mode = computed(() => (props.ride.riding ? 'dismount' : props.ride.nearCar ? 'mount' : props.ride.booth ? 'talk' : null))
/** 時段關閉：上車與領車按鈕變暗（按下由 GameCore 以提示說明），下車不受影響。 */
const blocked = computed(() => sessionBlocks(mode.value, props.ride.session))
const sessionText = computed(() => {
  const s = props.ride.session
  if (!s) return null
  if (s.manual) return t(s.open ? 'ride.session.manualOpen' : 'ride.session.manualClosed')
  return t(s.open ? 'ride.session.open' : 'ride.session.closed', { time: formatCountdown(s.secs) })
})
const LABEL = { dismount: 'ride.dismount', mount: 'ride.mount', talk: 'ride.talk' } as const
const ICON = { dismount: '🚪', mount: '🏎️', talk: '🎟️' } as const

// 直向開車的提示：每次上車重新出現，關掉後這一趟不再顯示
const hintDismissed = ref(false)
watch(
  () => props.ride.riding,
  () => (hintDismissed.value = false),
)
const rotateHint = computed(() => props.ride.riding && props.touch && !props.landscape && !hintDismissed.value && !claim.value.open)

// 抽到車之後視窗自己收起來，玩家已經坐在車上了。
let timer: ReturnType<typeof setTimeout> | null = null
watch(
  () => claim.value.result,
  (r) => {
    if (timer) clearTimeout(timer)
    timer = r === null ? null : setTimeout(() => emit('close'), 2600)
  },
)
onBeforeUnmount(() => timer && clearTimeout(timer))
</script>

<template>
  <!-- 右側欄、說話按鈕上方：上車／下車／領車，鍵盤是 E -->
  <div v-if="sessionText" class="session-box">
    <!-- 暫時的功能：任何玩家都能手動開關廟會 -->
    <button type="button" class="fair-btn" @click="emit('fair')">{{ t(ride.session?.open ? 'ride.session.turnOff' : 'ride.session.turnOn') }}</button>
    <p class="session-pill" :class="{ closed: !ride.session?.open }" role="status">{{ sessionText }}</p>
  </div>
  <button v-if="mode" type="button" class="ride-btn" :class="[`mode-${mode}`, { blocked }]" :aria-disabled="blocked" :aria-label="t(LABEL[mode])" @click="emit('toggle')">
    <span class="ride-icon" aria-hidden="true">{{ ICON[mode] }}</span>
    <span class="ride-label">{{ t(LABEL[mode]) }}</span>
    <span class="key-hint" aria-hidden="true">E</span>
  </button>

  <!-- 觸控裝置直向開車：建議轉成橫向（畫面比較寬，看得到前面的路）。每次上車出現一次，可以關掉。 -->
  <div v-if="rotateHint" class="rotate-hint" role="status">
    <span class="rotate-icon" aria-hidden="true">📱</span>
    <span>{{ t('ride.rotateHint') }}</span>
    <button type="button" :aria-label="t('ride.modal.close')" @click="hintDismissed = true">×</button>
  </div>

  <!-- 領車視窗：Q 版的紙卡，小沙彌從卡片上緣探頭 -->
  <div v-if="claim.open" class="claim-veil" @click.self="emit('close')">
    <section class="claim-card" role="dialog" aria-modal="true" :aria-label="t('ride.boothTitle')">
      <div class="monk" aria-hidden="true">
        <span class="ear left"></span><span class="ear right"></span>
        <span class="face"><i class="eye l"></i><i class="eye r"></i><i class="blush l"></i><i class="blush r"></i><i class="mouth"></i></span>
        <span class="hands"></span>
      </div>
      <button type="button" class="x" :aria-label="t('ride.modal.close')" @click="emit('close')">×</button>

      <h2 class="title">{{ t('ride.boothTitle') }}</h2>

      <template v-if="won">
        <p class="bubble">{{ t('ride.modal.result') }}</p>
        <div class="prize" :class="won.rarity">
          <span class="ribbon">{{ t(RARITY_KEYS[won.rarity]) }}</span>
          <span class="prize-name">{{ t(won.label) }}</span>
        </div>
        <button type="button" class="go" @click="emit('close')">{{ t('ride.modal.go') }}</button>
      </template>

      <template v-else>
        <p v-if="ride.session && !ride.session.open" class="session-note">{{ sessionText }}</p>
        <p class="bubble" :class="{ warn: claim.error }">{{ claim.error ? t(claim.error as MessageKey) : t('ride.modal.greet') }}</p>
        <ul class="odds">
          <li v-for="(kind, i) in CAR_KINDS" :key="kind.id" :class="[kind.rarity, { out: (ride.booth?.left[i] ?? 0) <= 0 }]">
            <span class="dot"></span>
            <span class="odds-name">{{ t(kind.label) }}</span>
            <span class="odds-rarity">{{ t(RARITY_KEYS[kind.rarity]) }}</span>
          </li>
        </ul>
        <button type="button" class="go" :class="{ blocked }" :disabled="claim.pending" :aria-disabled="blocked" @click="emit('claim')">
          {{ t(claim.pending ? 'ride.modal.drawing' : 'ride.modal.draw') }}
        </button>
        <p class="hint">{{ t('ride.modal.hint') }}</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* 右側欄、說話按鈕上方：不擋動作列，也避開左下角的虛擬搖桿 */
.ride-btn {
  position: absolute;
  right: max(12px, env(safe-area-inset-right));
  bottom: calc(max(16px, env(safe-area-inset-bottom)) + 140px);
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
  color: var(--ink);
  cursor: pointer;
  transition: background 0.2s, transform 0.12s, border-color 0.2s;
  z-index: 10;
}
.ride-btn:active { transform: scale(0.96); }
/* 直向開車時的提示：橫向比較好開 */
.rotate-hint {
  position: absolute;
  top: calc(max(12px, env(safe-area-inset-top)) + 56px);
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 24px);
  padding: 8px 8px 8px 14px;
  border-radius: 999px;
  border: 3px solid #5a3b25;
  background: #f7efdc;
  box-shadow: 0 4px 0 #5a3b25;
  color: #5a3b25;
  font-size: 0.9rem;
  font-weight: 700;
  z-index: 20;
}
.rotate-icon {
  display: inline-block;
  animation: tilt 1.6s ease-in-out infinite;
}
@keyframes tilt {
  50% { transform: rotate(-90deg); }
}
.rotate-hint button {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: inherit;
  font-size: 1.2rem;
  cursor: pointer;
}
.ride-btn.mode-dismount, .ride-btn.mode-talk { border-color: var(--accent); }
.key-hint {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--line);
  color: var(--ink-soft);
}
.ride-btn.blocked, .go.blocked { opacity: 0.5; filter: grayscale(0.6); }
/* 廟會倒數：右側欄、上車按鈕正上方的紙卡小標籤（不碰頂部列、左上聊天紀錄與左下搖桿） */
.session-box {
  position: absolute;
  right: max(12px, env(safe-area-inset-right));
  bottom: calc(max(16px, env(safe-area-inset-bottom)) + 192px);
  max-width: min(260px, calc(100% - 24px));
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none;
  z-index: 10;
}
.fair-btn {
  min-height: 36px;
  padding: 0 12px;
  border-radius: 999px;
  border: 2px solid #5a3b25;
  background: #f2a03d;
  color: #3a2313;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  pointer-events: auto;
}
.session-pill {
  margin: 0;
  padding: 5px 12px;
  border-radius: 999px;
  border: 2px solid #5a3b25;
  background: #f7efdc;
  color: #5a3b25;
  font-size: 0.8rem;
  font-weight: 700;
  text-align: center;
}
.session-pill.closed { background: #ffe9df; }
.session-note { margin: 0 0 6px; font-size: 0.85rem; font-weight: 700; }
@media (pointer: coarse) {
  .key-hint { display: none; }
}

/* ---- 領車視窗 ---- */
.claim-veil {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(20, 16, 12, 0.38);
}
.claim-card {
  --paper: #f7efdc;
  --brown: #5a3b25;
  position: relative;
  width: min(340px, 100%);
  margin-top: 46px;
  padding: 54px 20px 18px;
  border-radius: 28px;
  border: 4px solid var(--brown);
  background: var(--paper);
  box-shadow: 0 8px 0 var(--brown), 0 18px 30px rgba(0, 0, 0, 0.35);
  color: var(--brown);
  text-align: center;
  animation: pop 0.28s cubic-bezier(0.2, 1.5, 0.4, 1);
}
@keyframes pop {
  from { transform: scale(0.7); opacity: 0; }
}
.title { margin: 0 0 8px; font-size: 1.25rem; letter-spacing: 0.12em; }
.x {
  position: absolute;
  top: 8px;
  right: 10px;
  width: 44px;
  height: 44px;
  border: 0;
  background: none;
  color: var(--brown);
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
}

/* 小沙彌：圓頭、豆豆眼、腮紅、合十的手，探出卡片上緣 */
.monk {
  position: absolute;
  top: -58px;
  left: 50%;
  width: 104px;
  height: 104px;
  transform: translateX(-50%);
  animation: bob 2.4s ease-in-out infinite;
}
@keyframes bob {
  50% { transform: translateX(-50%) translateY(-4px); }
}
.monk .face, .monk .ear {
  position: absolute;
  background: #f1cfae;
  border: 4px solid var(--brown);
}
.monk .face { inset: 0; border-radius: 50%; }
.monk .ear { top: 44px; width: 20px; height: 26px; border-radius: 50%; }
.monk .ear.left { left: -12px; }
.monk .ear.right { right: -12px; }
.monk i { position: absolute; display: block; }
.monk .eye { top: 50px; width: 10px; height: 12px; border-radius: 50%; background: #2b1d14; }
.monk .eye.l { left: 26px; }
.monk .eye.r { right: 26px; }
.monk .blush { top: 62px; width: 16px; height: 9px; border-radius: 50%; background: #f09a8a; opacity: 0.8; }
.monk .blush.l { left: 12px; }
.monk .blush.r { right: 12px; }
.monk .mouth { top: 66px; left: 50%; width: 14px; height: 7px; margin-left: -7px; border: 3px solid #2b1d14; border-top: 0; border-radius: 0 0 14px 14px; }
.monk .hands {
  position: absolute;
  left: 50%;
  bottom: -10px;
  width: 26px;
  height: 30px;
  margin-left: -13px;
  border-radius: 14px 14px 8px 8px;
  background: #f1cfae;
  border: 4px solid var(--brown);
}

.bubble {
  position: relative;
  margin: 10px 0 14px;
  padding: 10px 14px;
  border-radius: 18px;
  border: 3px solid var(--brown);
  background: #fff;
  font-size: 0.95rem;
  line-height: 1.5;
}
.bubble::before {
  content: '';
  position: absolute;
  top: -11px;
  left: 50%;
  width: 16px;
  height: 16px;
  margin-left: -8px;
  transform: rotate(45deg);
  background: #fff;
  border-left: 3px solid var(--brown);
  border-top: 3px solid var(--brown);
}
.bubble.warn { background: #ffe9df; }

.odds { list-style: none; margin: 0 0 14px; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.odds li {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  column-gap: 8px;
  padding: 8px 10px;
  border-radius: 14px;
  border: 3px solid var(--brown);
  background: #fff8e8;
  text-align: left;
}
.odds .dot { grid-row: span 2; width: 18px; height: 18px; border-radius: 50%; border: 3px solid var(--brown); background: #c9853a; }
.odds .rare .dot { background: #2f6fb5; }
.odds .mythic .dot { background: #f0691c; }
.odds-name { font-size: 0.9rem; font-weight: 700; }
.odds-rarity { font-size: 0.72rem; opacity: 0.75; }
.odds li.out { opacity: 0.4; }

.go {
  width: 100%;
  min-height: 52px;
  border-radius: 999px;
  border: 4px solid var(--brown);
  background: #f2a03d;
  box-shadow: 0 5px 0 var(--brown);
  color: #3a2313;
  font-size: 1.1rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  cursor: pointer;
  transition: transform 0.08s, box-shadow 0.08s;
}
.go:active:not(:disabled) { transform: translateY(4px); box-shadow: 0 1px 0 var(--brown); }
.go:disabled { opacity: 0.6; cursor: default; }
.hint { margin: 12px 0 0; font-size: 0.78rem; opacity: 0.75; }

.prize {
  position: relative;
  margin: 6px 0 16px;
  padding: 26px 12px 18px;
  border-radius: 20px;
  border: 4px solid var(--brown);
  background: #fff8e8;
  animation: pop 0.4s cubic-bezier(0.2, 1.7, 0.4, 1);
}
.prize.rare { background: #dcebfb; }
.prize.mythic { background: linear-gradient(160deg, #ffe08a, #ffb26b); }
.prize-name { font-size: 1.5rem; font-weight: 800; letter-spacing: 0.08em; }
.ribbon {
  position: absolute;
  top: -14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 14px;
  border-radius: 999px;
  border: 3px solid var(--brown);
  background: #c9853a;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 700;
}
.prize.rare .ribbon { background: #2f6fb5; }
.prize.mythic .ribbon { background: #c2281f; }

/* 矮的畫面（橫向手機）：卡片加寬、四種車排成一列、小沙彌縮小，整張卡要放得進畫面 */
@media (max-height: 520px) {
  .claim-card {
    width: min(540px, 100%);
    margin-top: 30px;
    padding: 44px 16px 12px;
    box-shadow: 0 5px 0 var(--brown), 0 12px 20px rgba(0, 0, 0, 0.35);
  }
  .monk { top: -40px; width: 72px; height: 72px; }
  .monk .ear { top: 30px; width: 14px; height: 18px; }
  .monk .ear.left { left: -9px; }
  .monk .ear.right { right: -9px; }
  .monk .eye { top: 34px; width: 7px; height: 9px; }
  .monk .eye.l { left: 18px; }
  .monk .eye.r { right: 18px; }
  .monk .blush { top: 43px; width: 11px; height: 6px; }
  .monk .blush.l { left: 8px; }
  .monk .blush.r { right: 8px; }
  .monk .mouth { top: 45px; width: 10px; height: 5px; margin-left: -5px; }
  .monk .hands { width: 18px; height: 20px; margin-left: -9px; bottom: -8px; }
  .title { margin-bottom: 4px; font-size: 1.05rem; }
  .bubble { margin: 8px 0 10px; padding: 6px 12px; font-size: 0.88rem; }
  .odds { grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 10px; }
  .odds li { padding: 6px 8px; column-gap: 6px; }
  .odds .dot { width: 14px; height: 14px; }
  .odds-name { font-size: 0.8rem; }
  .go { min-height: 44px; font-size: 1rem; }
  .hint { display: none; }
  .prize { margin: 4px 0 10px; padding: 18px 12px 10px; }
  .prize-name { font-size: 1.25rem; }
}

@media (prefers-reduced-motion: reduce) {
  .claim-card, .prize, .monk { animation: none; }
}
</style>
