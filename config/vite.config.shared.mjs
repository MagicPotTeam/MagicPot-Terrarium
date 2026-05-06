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
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(packageJson.version)
  }
})
