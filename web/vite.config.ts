import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    target: 'es2022',
    // three 核心約 585 kB（gzip 約 146 kB，2026-11-06 加入殿內場景後），已獨立快取；超過 600 kB 再檢查是否誤引入額外模組。
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // three 核心單獨成塊：遊戲程式碼更新時，使用者可沿用快取的 three。
        // examples（GLTFLoader 等）不併進核心，維持動態 import 各自按需載入。
        manualChunks: (id) => (id.includes('node_modules/three/build/') ? 'three' : undefined),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
