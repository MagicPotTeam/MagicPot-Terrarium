import { defineConfig } from 'vite'
import { resolve } from 'path'
import packageJson from '../package.json'

export default defineConfig({
  envDir: resolve('config/env'),
  resolve: {
    alias: {
      '@shared': resolve('./packages/app/src/shared')
    }
  },
  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(packageJson.version),
    'import.meta.env.VITE_MAGICPOT_UPDATE_OWNER': JSON.stringify(
      process.env.VITE_MAGICPOT_UPDATE_OWNER || process.env.MAGICPOT_UPDATE_OWNER || ''
    ),
    'import.meta.env.VITE_MAGICPOT_UPDATE_REPO': JSON.stringify(
      process.env.VITE_MAGICPOT_UPDATE_REPO || process.env.MAGICPOT_UPDATE_REPO || ''
    ),
    'import.meta.env.VITE_MAGICPOT_UPDATE_CHANNEL': JSON.stringify(
      process.env.VITE_MAGICPOT_UPDATE_CHANNEL || process.env.MAGICPOT_UPDATE_CHANNEL || ''
    )
  }
})
