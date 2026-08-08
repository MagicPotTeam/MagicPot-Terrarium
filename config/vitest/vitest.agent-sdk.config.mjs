import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/agent-sdk-typescript/test/**/*.test.ts']
  }
})
