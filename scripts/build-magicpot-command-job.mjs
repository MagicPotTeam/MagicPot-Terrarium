import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32') {
  console.log('Skipping Windows command Job Object helper build on non-Windows host.')
  process.exit(0)
}
const manifest = path.join(repoRoot, 'packages', 'magicpot-command-job', 'Cargo.toml')
const result = spawnSync(
  process.env.CARGO || 'cargo',
  ['build', '--release', '--locked', '--manifest-path', manifest],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
)
if (result.status !== 0) process.exit(result.status ?? 1)
const source = path.join(
  repoRoot,
  'packages',
  'magicpot-command-job',
  'target',
  'release',
  'magicpot-command-job.exe'
)
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
