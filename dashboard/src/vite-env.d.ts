/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OAUTH_KEYS_DRIVE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
