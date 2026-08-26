import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
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
const generatedFileNames = [
  'canvas_spatial_index.js',
  'canvas_spatial_index_bg.wasm',
  'canvas_spatial_index.d.ts'
]

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

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
for (const fileName of generatedFileNames) {
  const sourcePath = join(pkgDir, fileName)
  if (!existsSync(sourcePath)) {
    console.error(`[canvas-spatial-index-wasm] expected generated file not found: ${sourcePath}`)
    process.exit(1)
  }

  copyFileSync(sourcePath, join(outDir, fileName))
}

console.log(`[canvas-spatial-index-wasm] wrote ${outDir}`)
