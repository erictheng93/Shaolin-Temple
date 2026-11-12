/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 遊戲伺服器 WebSocket 位址；未設定時為離線模式。 */
  readonly VITE_WS_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
