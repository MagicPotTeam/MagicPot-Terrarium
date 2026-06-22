import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildImageWorker, getImageWorkerBuildPaths } from './build-image-worker.mjs'

const tempRoots = []
const normalizePath = (value) => value.replaceAll(path.sep, '/')

function createTempRepo() {
  const trashRoot = path.join(process.cwd(), '.magicpot-trash')
  fs.mkdirSync(trashRoot, { recursive: true })
  const repoRoot = fs.mkdtempSync(path.join(trashRoot, 'image-worker-test-'))
  tempRoots.push(repoRoot)
  fs.mkdirSync(path.join(repoRoot, 'packages/canvas-thumbnail-sidecar'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'packages/canvas-thumbnail-sidecar/Cargo.toml'),
    '[package]\n'
  )
  return repoRoot
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('build-image-worker', () => {
  it('derives the cargo target and runtime asset paths', () => {
    const paths = getImageWorkerBuildPaths({ repoRoot: '/repo', platform: 'linux', arch: 'x64' })

    expect(normalizePath(paths.manifestPath)).toBe(
      '/repo/packages/canvas-thumbnail-sidecar/Cargo.toml'
    )
    expect(normalizePath(paths.cargoTargetDir)).toBe(
      '/repo/.cache/cargo-target/canvas-thumbnail-sidecar'
    )
    expect(normalizePath(paths.sourceBinaryPath)).toBe(
      '/repo/.cache/cargo-target/canvas-thumbnail-sidecar/release/canvas-thumbnail-sidecar'
    )
    expect(normalizePath(paths.outputBinaryPath)).toBe(
      '/repo/packages/runtime-assets/resources/bin/image-worker/linux-x64/magicpot-image-worker'
    )
  })

  it('uses .exe names on Windows', () => {
    const paths = getImageWorkerBuildPaths({ repoRoot: 'C:/repo', platform: 'win32', arch: 'x64' })

    expect(normalizePath(paths.sourceBinaryPath)).toBe(
      'C:/repo/.cache/cargo-target/canvas-thumbnail-sidecar/release/canvas-thumbnail-sidecar.exe'
    )
    expect(normalizePath(paths.outputBinaryPath)).toBe(
      'C:/repo/packages/runtime-assets/resources/bin/image-worker/win32-x64/magicpot-image-worker.exe'
    )
  })

  it('copies the release binary to runtime assets and chmods it on non-Windows', () => {
    const repoRoot = createTempRepo()
    const paths = getImageWorkerBuildPaths({ repoRoot, platform: 'linux', arch: 'x64' })
    fs.mkdirSync(path.join(paths.cargoTargetDir, 'release'), { recursive: true })
    fs.writeFileSync(paths.sourceBinaryPath, 'native-binary')
    fs.chmodSync(paths.sourceBinaryPath, 0o600)

    const spawn = vi.fn(() => ({ status: 0, signal: null, error: undefined }))
    buildImageWorker({ repoRoot, platform: 'linux', arch: 'x64', spawn })

    expect(spawn).toHaveBeenCalledWith(
      'cargo',
      ['build', '--release', '--manifest-path', paths.manifestPath],
      expect.objectContaining({
        cwd: repoRoot,
        shell: false,
        stdio: 'inherit',
        env: expect.objectContaining({ CARGO_TARGET_DIR: paths.cargoTargetDir })
      })
    )
    expect(fs.existsSync(paths.outputBinaryPath)).toBe(true)
    expect(fs.statSync(paths.outputBinaryPath).mode & 0o777).toBe(0o755)
  })
})
