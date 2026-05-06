import { defineConfig } from 'vitest/config'
import viteConfig from '../vite.config.shared.mjs'

export default defineConfig({
  ...viteConfig,
  test: {
    passWithNoTests: true,
    projects: ['config/vitest/vitest.web.config.mjs', 'config/vitest/vitest.node.config.mjs']
  }
})
