import viteConfig from '../vite.config.shared.mjs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ...viteConfig,
  test: {
    name: 'node-smoke',
    environment: 'node',
    include: ['packages/app/src/main/startup.smoke.test.ts'],
    server: {
      deps: {
        inline: ['@electron-toolkit/utils']
      }
    }
  }
})
