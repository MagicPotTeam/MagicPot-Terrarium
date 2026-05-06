// Values normally come from config/env/.env.<mode>. Open candidates exclude
// private .env files, so pure builds must still have stable defaults.
export const BUILD_MODE = import.meta.env.VITE_BUILD_MODE || 'pure'
export const PACKAGE_MODE = import.meta.env.VITE_PACKAGE_MODE || BUILD_MODE
export const BUILD_MODE_NAME =
  import.meta.env.VITE_BUILD_MODE_NAME || (BUILD_MODE === 'embedded' ? 'Embedded' : 'Pure')

// Values set through Vite define.
export const PACKAGE_VERSION = import.meta.env.PACKAGE_VERSION
