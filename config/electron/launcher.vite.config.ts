import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/launcher',
      rollupOptions: {
        input: resolve(__dirname, '../../packages/launcher/src/electronMain.ts')
      }
    }
  }
})
