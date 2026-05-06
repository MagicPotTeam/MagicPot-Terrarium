import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import viteConfig from '../vite.config.shared.mjs'

const generatedRuntimeWatchIgnores = [
  '**/.cache/**',
  '**/.codex-tmp/**',
  '**/.staging/**',
  '**/.eslintcache',
  '**/aiengineelectron-dev/**',
  '**/.magicpot-trash/**',
  '**/vendor/comfyui/**',
  '**/benchmark-results/**',
  '**/node-tests/**',
  '**/playwright-report/**',
  '**/screenshots/**',
  '**/out/**',
  '**/dist/**',
  '**/packages/runtime-assets/build/**'
]

export default defineConfig({
  main: {
    ...viteConfig,
    plugins: [externalizeDepsPlugin()],
    build: {
      watch: {
        exclude: generatedRuntimeWatchIgnores
      },
      rollupOptions: {
        input: resolve('packages/app/src/main/index.ts'),
        output: {
          inlineDynamicImports: true
        }
      }
    }
  },
  preload: {
    ...viteConfig,
    plugins: [externalizeDepsPlugin()],
    build: {
      watch: {
        exclude: generatedRuntimeWatchIgnores
      },
      rollupOptions: {
        input: resolve('packages/app/src/preload/index.ts'),
        output: {
          inlineDynamicImports: true
        }
      }
    }
  },
  renderer: {
    ...viteConfig,
    root: resolve('packages/app/src/renderer'),
    publicDir: resolve('packages/app/src/renderer/public'),
    server: {
      port: 5173,
      strictPort: true,
      watch: {
        ignored: generatedRuntimeWatchIgnores
      }
    },
    resolve: {
      ...viteConfig.resolve,
      alias: {
        ...viteConfig.resolve.alias,
        '@renderer': resolve('packages/app/src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('packages/app/src/renderer/index.html')
      }
    }
  }
})
