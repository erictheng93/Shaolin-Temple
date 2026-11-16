<script setup lang="ts">
import { OUTFITS, type Outfit } from '../game/world/outfits'
import { t } from '../i18n'

// 衣裝選擇：點了立即生效（由父層呼叫 GameCore.setOutfit）。設定面板與進場畫面共用。
defineProps<{ modelValue: number }>()
const emit = defineEmits<{ 'update:modelValue': [outfit: number] }>()

/**
 * 色塊：袍色為底；袈裟畫一條從角色左肩（畫面右上）斜到右腰（畫面左下）的帶子，念珠畫一圈點，
 * 斗笠畫在色塊頂上的一個三角，短褂由上到下是上衣、腰帶、褲（中間一道縫分出兩條腿）與綁腿。
 */
function swatchStyle(o: Outfit): Record<string, string> {
  const style: Record<string, string> = { '--robe': o.robe }
  if (o.sash) {
    style.backgroundImage = `linear-gradient(225deg, transparent 0 34%, ${o.sash} 34% 58%, transparent 58%)`
  }
  if (o.tunic) {
    const { trousers, leggings, belt } = o.tunic
    style.backgroundImage = [
      'linear-gradient(90deg, transparent 0 calc(50% - 1px), rgba(0, 0, 0, 0.45) calc(50% - 1px) calc(50% + 1px), transparent 0)',
      `linear-gradient(180deg, transparent 0 48%, ${belt} 48% 57%, transparent 57% 64%, ${trousers} 64% 82%, ${leggings} 82%)`,
    ].join(', ')
    style.backgroundSize = '100% 36%, 100% 100%'
    style.backgroundPosition = 'bottom, center'
    style.backgroundRepeat = 'no-repeat'
  }
  if (o.beads) style['--beads'] = o.beads
  if (o.hat) style['--hat'] = o.hat
  return style
}
</script>

<template>
  <div class="outfits" role="group" :aria-label="t('outfit.label')">
    <button
      v-for="(o, i) in OUTFITS"
      :key="o.key"
      type="button"
      class="outfit"
      :aria-pressed="modelValue === i"
      @click="emit('update:modelValue', i)"
    >
      <span class="swatch" :class="{ beads: !!o.beads, hat: !!o.hat }" :style="swatchStyle(o)" aria-hidden="true" />
      <span class="name">{{ t(o.label) }}</span>
    </button>
  </div>
</template>

<style scoped>
.outfits {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.outfit {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 6px;
  min-height: 72px;
  padding: 8px 4px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.outfit[aria-pressed='true'] {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
  background: rgba(255, 255, 255, 0.06);
}

.outfit:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.swatch {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background-color: var(--robe);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}

/* 斗笠：色塊頂上一頂寬沿的圓錐，帽沿比色塊略寬 */
.swatch.hat::before {
  content: '';
  position: absolute;
  left: -5px;
  right: -5px;
  top: -6px;
  height: 14px;
  background: var(--hat);
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
}

/* 念珠：色塊上半圈的一串珠子 */
.swatch.beads::after {
  content: '';
  position: absolute;
  inset: 5px;
  border: 3px dotted var(--beads);
  border-top-color: transparent;
  border-radius: 50%;
}

.name {
  font-size: 0.8rem;
  line-height: 1.3;
  text-align: center;
  /* 只在單字本身放不下時才斷字（anywhere 會把英文、越南文從字中間斷開；中日文本來就能逐字換行） */
  overflow-wrap: break-word;
  /* 四欄時較長的名稱會換行：平均分成兩行，不要只剩一個字在第二行 */
  text-wrap: balance;
}

.outfit[aria-pressed='true'] .name {
  color: var(--accent);
}
</style>
