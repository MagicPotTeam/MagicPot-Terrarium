import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(repoRoot, 'packages', 'lora-trigger-sidecar', 'Cargo.toml')
const cargo = process.env.CARGO || 'cargo'

const result = spawnSync(cargo, ['build', '--release', '--offline', '--manifest-path', manifestPath], {
  cwd: repoRoot,
  stdio: 'inherit'
})
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const exeName = process.platform === 'win32' ? 'lora-trigger-sidecar.exe' : 'lora-trigger-sidecar'
const source = path.join(repoRoot, 'packages', 'lora-trigger-sidecar', 'target', 'release', exeName)
const outputDir = path.join(
  repoRoot,
  'packages',
  'runtime-assets',
  'resources',
  'bin',
  'lora-trigger-sidecar'
)
mkdirSync(outputDir, { recursive: true })
copyFileSync(source, path.join(outputDir, exeName))
console.log(`Copied ${exeName} to ${path.relative(repoRoot, outputDir)}`)
