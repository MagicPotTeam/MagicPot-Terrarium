import viteConfig from '../vite.config.shared.mjs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ...viteConfig,
  test: {
    name: 'launcher-archive',
    environment: 'node',
    include: [
      'packages/app/src/main/appUpdate/safeZipExtractor.test.ts',
      'packages/app/src/main/appUpdate/artifactPreparer.test.ts'
    ]
  }
})
