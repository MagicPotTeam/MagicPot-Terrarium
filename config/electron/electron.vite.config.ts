import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { relative, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import viteConfig from '../vite.config.shared.mjs'

const htmlBootstrapManifest = (): Plugin => ({
  name: 'magicpot-html-bootstrap-manifest',
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).filter((item) => item.type === 'chunk')
    const entry = chunks.find((item) => item.isEntry && item.name === 'index')
    if (!entry || Object.keys(entry.modules).some((id) => id.replaceAll('\\', '/').endsWith('/main/index.ts'))) throw new Error('HTML bootstrap must not eagerly include normal app initialization.')
    this.emitFile({ type: 'asset', fileName: 'html-bootstrap-manifest.json', source: JSON.stringify({
      protocol: 'magicpot-isolated-html-bootstrap/v1', entry: entry.fileName,
      files: chunks.map((item) => ({ path: item.fileName, bytes: Buffer.byteLength(item.code), sha256: createHash('sha256').update(item.code).digest('hex') }))
    }) })
  }
})

const shouldAnalyzeBundle = process.env.ANALYZE_BUNDLE === 'true'

const createBundleAnalyzer = (name: string): Plugin[] => {
  if (!shouldAnalyzeBundle) {
    return []
  }

  const outDir = resolve('out/bundle-analysis')

  return [
    {
      name: `magicpot-bundle-analyzer:${name}`,
      apply: 'build',
      writeBundle(_options, bundle) {
        mkdirSync(outDir, { recursive: true })

        const chunks = Object.values(bundle)
          .filter((item) => item.type === 'chunk')
          .map((chunk) => {
            const moduleSizes = Object.entries(chunk.modules)
              .map(([id, moduleInfo]) => ({
                id: relative(process.cwd(), id) || id,
                renderedLength: moduleInfo.renderedLength,
                originalLength: moduleInfo.originalLength
              }))
              .sort((left, right) => right.renderedLength - left.renderedLength)

            return {
              fileName: chunk.fileName,
              codeLength: chunk.code.length,
              moduleCount: moduleSizes.length,
              modules: moduleSizes
            }
          })
          .sort((left, right) => right.codeLength - left.codeLength)

        const assets = Object.values(bundle)
          .filter((item) => item.type === 'asset')
          .map((asset) => ({
            fileName: asset.fileName,
            sourceLength:
              typeof asset.source === 'string' ? asset.source.length : asset.source.byteLength
          }))
          .sort((left, right) => right.sourceLength - left.sourceLength)

        const report = {
          generatedAt: new Date().toISOString(),
          name,
          chunks,
          assets
        }

        writeFileSync(resolve(outDir, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`)
      }
    }
  ]
}

const generatedRuntimeWatchIgnores = [
  '**/.cache/**',
  '**/.codex-tmp/**',
  '**/.staging/**',
  '**/.eslintcache',
  '**/aiengineelectron-dev/**',
  '**/.aiengineelectron-dev/**',
  '**/Codex-Junk/**',
  '**/.Codex-Junk/**',
  '**/AutoSave/**',
  '**/.AutoSave/**',
  '**/chat_media/**',
  '**/.chat_media/**',
  '**/report_bundles/**',
  '**/.report_bundles/**',
  '**/canvas-target-failures/**',
  '**/.canvas-target-failures/**',
  '**/*__tab-project-*/**',
  '**/.*__tab-project-*/**',
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
    plugins: [externalizeDepsPlugin(), htmlBootstrapManifest(), ...createBundleAnalyzer('main')],
    build: {
      watch: {
        exclude: generatedRuntimeWatchIgnores
      },
      rollupOptions: {
        input: { index: resolve('packages/app/src/main/bootstrap.ts') },
        output: {
          // Keep normal application side effects behind the conditional bootstrap import.
          // Rollup inlining would eagerly evaluate otherwise lazy modules in the helper.
          inlineDynamicImports: false,
          // Existing main modules resolve assets/preload relative to out/main.
          chunkFileNames: '[name]-[hash].js'
        }
      }
    }
  },
  preload: {
    ...viteConfig,
    plugins: [externalizeDepsPlugin(), ...createBundleAnalyzer('preload')],
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
      strictPort: false,
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
    plugins: [react(), ...createBundleAnalyzer('renderer')],
    build: {
      rollupOptions: {
        input: resolve('packages/app/src/renderer/index.html')
      }
    }
  }
})
