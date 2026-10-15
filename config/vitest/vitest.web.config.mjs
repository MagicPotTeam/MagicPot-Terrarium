import viteConfig from '../vite.config.shared.mjs'
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  ...viteConfig,
  resolve: {
    ...viteConfig.resolve,
    alias: {
      ...viteConfig.resolve.alias,
      '@renderer': resolve('packages/app/src/renderer/src')
    }
  },
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
    include: [
      'packages/app/src/shared/**/*.test.{ts,js}',
      'packages/app/src/renderer/**/*.test.{ts,js,tsx,jsx}'
    ],
    // Node-native Response/streams and the owned TCP listener run in the node suite.
    // Keep them out of the jsdom setup (which requires HTMLCanvasElement).
    exclude: [
      'packages/app/src/shared/llm/openaiFileSearch.control.test.ts',
      'packages/app/src/shared/llm/openaiFileSearch.lifecycle.test.ts',
      'packages/app/src/shared/llm/openaiFileSearch.http.test.ts'
    ],
    setupFiles: ['packages/app/src/renderer/src/tests/setup.ts']
  }
})
