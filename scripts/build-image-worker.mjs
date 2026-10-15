import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve, win32 } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getNativeBuildOptions } from './native-build-options.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(__dirname, '..')
const sidecarPackageName = 'canvas-thumbnail-sidecar'
const packagedBinaryBaseName = 'magicpot-image-worker'

export function getImageWorkerBuildPaths({
  repoRoot = defaultRepoRoot,
  platform = process.platform,
  arch = process.arch
} = {}) {
  const binaryExtension = platform === 'win32' ? '.exe' : ''
  const manifestPath = join(repoRoot, 'packages/canvas-thumbnail-sidecar/Cargo.toml')
  const cargoTargetDir = join(repoRoot, '.cache/cargo-target/canvas-thumbnail-sidecar')
  const sourceBinaryPath = join(
    cargoTargetDir,
    'release',
    `${sidecarPackageName}${binaryExtension}`
  )
  const outputDir = join(
    repoRoot,
    'packages/runtime-assets/resources/bin/image-worker',
    `${platform}-${arch}`
  )

  return {
    manifestPath,
    cargoTargetDir,
    sourceBinaryPath,
    outputDir,
    outputBinaryPath: join(outputDir, `${packagedBinaryBaseName}${binaryExtension}`)
  }
}

function describeExit(result) {
  if (result.status !== null) {
    return `exit code ${result.status}`
  }
  if (result.signal) {
    return `signal ${result.signal}`
  }
  return 'unknown exit status'
}

export function buildImageWorker({
  repoRoot = defaultRepoRoot,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  spawn = spawnSync,
  realpath,
  stat
} = {}) {
  const paths = getImageWorkerBuildPaths({ repoRoot, platform, arch })

  if (!existsSync(paths.manifestPath)) {
    throw new Error(`Cargo manifest not found: ${paths.manifestPath}`)
  }

  const reproducible = Object.entries(env).some(
    ([key, value]) =>
      (platform === 'win32' ? key.toUpperCase() : key) === 'MAGICPOT_REPRODUCIBLE_NATIVE' &&
      value === '1'
  )
  if (reproducible && platform === 'win32' && arch !== 'x64') {
    throw new Error(
      'Reproducible native build: image worker requires native Windows x64 architecture'
    )
  }
  // The helper validates the gate (including malformed/ambiguous values). Normal
  // image-worker builds still use their original command, flags and fixed cache.
  const options = getNativeBuildOptions({
    repoRoot,
    manifestPath: paths.manifestPath,
    platform,
    env: reproducible ? env : { ...env, CARGO_TARGET_DIR: paths.cargoTargetDir },
    spawn,
    realpath,
    stat
  })
  if (reproducible) {
    paths.cargoTargetDir = win32.dirname(win32.dirname(options.releaseDir))
    paths.sourceBinaryPath = win32.join(options.releaseDir, `${sidecarPackageName}.exe`)
  } else {
    options.cargo = 'cargo'
    options.args = ['build', '--release', '--manifest-path', paths.manifestPath]
  }

  console.log(`[image-worker] repo root: ${repoRoot}`)
  console.log(`[image-worker] cargo manifest: ${paths.manifestPath}`)
  console.log(`[image-worker] CARGO_TARGET_DIR: ${paths.cargoTargetDir}`)
  console.log(`[image-worker] package output: ${paths.outputBinaryPath}`)

  const result = spawn(options.cargo, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: 'inherit'
  })

  if (result.error) {
    throw new Error(`Failed to start cargo: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new Error(`cargo build failed with ${describeExit(result)}`)
  }

  if (!existsSync(paths.sourceBinaryPath)) {
    throw new Error(`cargo build completed but binary was not found: ${paths.sourceBinaryPath}`)
  }

  mkdirSync(paths.outputDir, { recursive: true })
  rmSync(paths.outputBinaryPath, { force: true })
  copyFileSync(paths.sourceBinaryPath, paths.outputBinaryPath)

  if (platform !== 'win32') {
    chmodSync(paths.outputBinaryPath, 0o755)
  }

  console.log(`[image-worker] copied from: ${paths.sourceBinaryPath}`)
  console.log(`[image-worker] wrote: ${paths.outputBinaryPath}`)

  return paths
}

export function main() {
  try {
    buildImageWorker()
    return 0
  } catch (error) {
    console.error(`[image-worker] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main()
}
