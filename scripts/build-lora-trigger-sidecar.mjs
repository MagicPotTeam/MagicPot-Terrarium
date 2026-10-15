import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getNativeBuildOptions } from './native-build-options.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(repoRoot, 'packages', 'lora-trigger-sidecar', 'Cargo.toml')
let build
try {
  // Opt-in preflight is shared with command-job; normal flags remain unchanged.
  build = getNativeBuildOptions({ repoRoot, manifestPath, offlineFromEnv: true })
} catch (error) {
  console.error(`Native build preflight failed: ${error.message}`)
  process.exit(1)
}

const result = spawnSync(build.cargo, build.args, {
  cwd: build.cwd,
  env: build.env,
  shell: false,
  stdio: 'inherit'
})
if (result.error) {
  console.error(`Failed to run cargo: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const exeName = process.platform === 'win32' ? 'lora-trigger-sidecar.exe' : 'lora-trigger-sidecar'
const source = path.join(build.releaseDir, exeName)
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
