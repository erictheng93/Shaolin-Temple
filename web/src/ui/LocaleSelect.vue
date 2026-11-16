<script setup lang="ts">
import { LOCALES, t, type Locale } from '../i18n'

/**
 * 語言選單（原生 select）：進場畫面與設定面板共用。選項是各語言的自稱，不翻譯。
 * compact：靠右的小型選單，只顯示地球圖示，「語言」文字只給螢幕閱讀器（進場卡片頂端用）。
 */
const locale = defineModel<Locale>({ required: true })
defineProps<{ compact?: boolean }>()
</script>

<template>
  <label class="locale" :class="{ compact }">
    <span class="label">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></svg>
      <span :class="{ 'sr-only': compact }">{{ t('locale.label') }}</span>
    </span>
    <select v-model="locale">
      <option v-for="l in LOCALES" :key="l.id" :value="l.id" :lang="l.id">{{ l.name }}</option>
    </select>
  </label>
</template>

<style scoped>
.locale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 44px;
  font-size: 0.9rem;
}

.label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-soft);
}

select {
  min-height: 44px;
  min-width: 9em;
  padding: 0 10px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.25);
  font-size: 0.95rem;
  cursor: pointer;
}

.compact {
  justify-content: flex-end;
  gap: 6px;
  font-size: 0.85rem;
}

.compact select {
  min-width: 0;
  padding: 0 8px;
  font-size: 0.85rem;
  background: transparent;
}

/* 原生下拉清單的選項背景（深色主題下部分瀏覽器預設為白底） */
option {
  background: #24262d;
  color: var(--ink);
}
</style>
