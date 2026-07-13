import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/verify-packaged-runtime-dependencies.test.js']
  }
})
