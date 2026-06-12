import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const crateDir = join(
  repoRoot,
  'packages/app/src/renderer/src/pages/ProjectCanvasPage/wasm/canvas_spatial_index'
)
const outDir = join(repoRoot, 'packages/app/src/renderer/public/wasm/canvas_spatial_index')
const pkgDir = join(crateDir, 'pkg')

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

if (!existsSync(crateDir)) {
  console.error(`[canvas-spatial-index-wasm] crate dir not found: ${crateDir}`)
  process.exit(1)
}

rmSync(pkgDir, { recursive: true, force: true })
run(
  'wasm-pack',
  [
    'build',
    '--target',
    'web',
    '--release',
    '--out-dir',
    'pkg',
    '--out-name',
    'canvas_spatial_index'
  ],
  { cwd: crateDir }
)

mkdirSync(outDir, { recursive: true })
for (const fileName of readdirSync(pkgDir)) {
  if (
    fileName === 'canvas_spatial_index.js' ||
    fileName === 'canvas_spatial_index_bg.wasm' ||
    fileName === 'canvas_spatial_index.d.ts'
  ) {
    copyFileSync(join(pkgDir, fileName), join(outDir, fileName))
  }
}

console.log(`[canvas-spatial-index-wasm] wrote ${outDir}`)
