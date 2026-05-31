/// <reference types="vite/client" />

interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

// .env 中的环境变量
interface ImportMetaEnv {
  readonly VITE_BUILD_MODE: string
  readonly VITE_PACKAGE_MODE: string
  readonly VITE_BUILD_MODE_NAME: string
  readonly VITE_MAGICPOT_UPDATE_OWNER?: string
  readonly VITE_MAGICPOT_UPDATE_REPO?: string
  readonly VITE_MAGICPOT_UPDATE_CHANNEL?: string
  readonly PACKAGE_VERSION: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
