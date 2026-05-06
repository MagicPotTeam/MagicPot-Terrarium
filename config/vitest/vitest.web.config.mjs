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
    setupFiles: ['packages/app/src/renderer/src/tests/setup.ts']
  }
})
