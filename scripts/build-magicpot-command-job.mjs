import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNativeBuildOptions } from './native-build-options.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(repoRoot, 'packages', 'magicpot-command-job', 'Cargo.toml')
let build
try {
  // Normal non-Windows builds still skip; unsupported opt-in builds fail closed.
  build = getNativeBuildOptions({ repoRoot, manifestPath, windowsOnly: true })
} catch (error) {
  console.error(`Native build preflight failed: ${error.message}`)
  process.exit(1)
}
if (!build) {
  console.log('Skipping Windows command Job Object helper build on non-Windows host.')
  process.exit(0)
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
if (result.status !== 0) process.exit(result.status ?? 1)
const source = path.join(build.releaseDir, 'magicpot-command-job.exe')
const outputDir = path.join(
  repoRoot,
  'packages',
  'runtime-assets',
  'resources',
  'bin',
  'magicpot-command-job'
)
const output = path.join(outputDir, 'magicpot-command-job.exe')
mkdirSync(outputDir, { recursive: true })
copyFileSync(source, output)
const digest = createHash('sha256').update(readFileSync(output)).digest('hex')
writeFileSync(`${output}.sha256`, `${digest}\n`, { encoding: 'ascii' })
console.log(`Copied magicpot-command-job.exe (${digest}) to ${path.relative(repoRoot, outputDir)}`)
