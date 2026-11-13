import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

/** Explicit build only; no install, listener, app boot or selected database access. */
export async function buildSqlitePreviewWorker({ repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  const output = path.join(repoRoot, 'out/sqlite-preview-worker')
  await build({ root: repoRoot, configFile: false, logLevel: 'warn',
    resolve: { alias: { '@shared': path.join(repoRoot, 'packages/app/src/shared') } },
    build: { target: 'node24', outDir: output, emptyOutDir: false, minify: false, sourcemap: false,
      lib: { entry: path.join(repoRoot, 'packages/app/src/main/agentLocalFiles/sqlitePreviewEntry.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
      rollupOptions: { external: [/^node:/] }
    }
  })
  const relative = 'out/sqlite-preview-worker/index.cjs'
  const sha256 = createHash('sha256').update(fs.readFileSync(path.join(repoRoot, relative))).digest('hex')
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ protocol: 'magicpot-sqlite-preview-assets/v1', files: [{ path: relative, sha256 }] }, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await buildSqlitePreviewWorker()
