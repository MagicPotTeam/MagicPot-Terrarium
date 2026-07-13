import viteConfig from '../vite.config.shared.mjs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ...viteConfig,
  test: {
    name: 'node',
    environments: 'node',
    setupFiles: ['packages/app/src/main/tests/setup/memfs.setup.ts'],
    exclude: [
      'scripts/prepare-embedded-staging.test.js',
      'scripts/verify-packaged-runtime-dependencies.test.js'
    ],
    include: [
      'scripts/**/*.test.{ts,js}',
      'packages/app/src/main/**/*.test.{ts,js}',
      'packages/app/src/preload/**/*.test.{ts,js}',
      'packages/app/src/shared/**/*.test.{ts,js}'
    ],
    server: {
      deps: {
        /**
         * 当出现以下 Error 时:
         * SyntaxError: Named export 'BrowserWindow' not found. The requested module 'electron' is a CommonJS module, which may not support all module.exports as named exports.
         * 将引入 Error 的包加到以下列表中。
         * 如： 上面的 SyntaxError 为 @electron-toolkit/utils 引入 electron 时发生的，
         * 则将 @electron-toolkit/utils 加到以下列表中而不是 electron 。
         */
        inline: ['@electron-toolkit/utils']
      }
    }
  }
})
