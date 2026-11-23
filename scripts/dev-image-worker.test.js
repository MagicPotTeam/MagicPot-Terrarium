import * as fs from 'node:fs'
import path from 'node:path'
import { vol } from 'memfs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getImageWorkerBuildPaths } from './build-image-worker.mjs'
import { ensureDevImageWorker, findCargo } from './dev-image-worker.mjs'

// node:fs is memfs in the node suite; cargo and the build are synthetic fakes.
const platform = process.platform
const arch = 'x64'
const exe = platform === 'win32' ? '.exe' : ''
const repoRoot = path.resolve('synthetic dev image-worker', 'repo')
const homedir = path.resolve('synthetic dev image-worker', 'home')
const pathDir = path.resolve('synthetic dev image-worker', 'tools')
const paths = getImageWorkerBuildPaths({ repoRoot, platform, arch })
const crateDir = path.dirname(paths.manifestPath)
const homeCargo = path.join(homedir, '.cargo', 'bin', `cargo${exe}`)
const pathCargo = path.join(pathDir, `cargo${exe}`)

function seed(file, contents = 'synthetic', mtimeSeconds = 1_000) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds)
}

function seedSources(mtimeSeconds = 1_000) {
  seed(paths.manifestPath, '[package]\n', mtimeSeconds)
  seed(path.join(crateDir, 'Cargo.lock'), 'lock', mtimeSeconds)
  seed(path.join(crateDir, 'src', 'main.rs'), 'fn main() {}', mtimeSeconds)
}

function run(overrides = {}) {
  const log = vi.fn()
  const warn = vi.fn()
  const build = vi.fn(() => seed(paths.outputBinaryPath, 'fresh worker', 500))
  const result = ensureDevImageWorker({
    repoRoot,
    platform,
    arch,
    env: { PATH: pathDir },
    homedir,
    fsModule: fs,
    build,
    log,
    warn,
    ...overrides
  })
  return { result, log, warn, build }
}

beforeEach(() => {
  vol.reset()
  seedSources()
})

afterEach(() => {
  vol.reset()
})

describe('dev image worker', () => {
  it('skips cargo entirely when the published worker is newer than the sources', () => {
    seed(paths.outputBinaryPath, 'worker', 2_000)
    const { result, build, log, warn } = run()
    expect(result.status).toBe('up-to-date')
    expect(build).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('builds offline with cargo from PATH on first start and announces the wait', () => {
    seed(pathCargo)
    const { result, build, log, warn } = run({
      env: { PATH: pathDir, CARGO_NET_OFFLINE: 'false', KEEP: 'yes' }
    })
    expect(result.status).toBe('built')
    expect(warn).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/首次构建.*约需 .+ 分钟/))
    expect(build).toHaveBeenCalledExactlyOnceWith({
      repoRoot,
      platform,
      arch,
      cargo: pathCargo,
      env: { PATH: pathDir, CARGO_NET_OFFLINE: 'true', KEEP: 'yes' }
    })
    // Stamped after the build so the next start is a fast skip.
    expect(fs.statSync(paths.outputBinaryPath).mtimeMs).toBeGreaterThan(1_000_000)
    expect(run().result.status).toBe('up-to-date')
  })

  it('falls back to ~/.cargo/bin when PATH has no cargo and puts it on the child PATH', () => {
    seed(homeCargo)
    expect(findCargo({ env: { PATH: pathDir }, platform, homedir, fsModule: fs })).toEqual({
      cargo: homeCargo,
      fromPath: false
    })
    const { result, build } = run()
    expect(result.status).toBe('built')
    expect(build.mock.calls[0][0].cargo).toBe(homeCargo)
    expect(build.mock.calls[0][0].env.PATH).toBe(
      [path.dirname(homeCargo), pathDir].join(path.delimiter)
    )
  })

  it('warns in two short lines and keeps dev running when cargo is missing', () => {
    const { result, build, warn } = run()
    expect(result.status).toBe('cargo-missing')
    expect(build).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0][0]
    expect(message.split('\n')).toHaveLength(2)
    expect(message).toContain('没找到 cargo')
    expect(message).toContain('MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH')
  })

  it('never throws when the build fails and says how to fix a first build', () => {
    seed(pathCargo)
    const { result, warn } = run({
      build: vi.fn(() => {
        throw new Error('cargo build failed with exit code 101')
      })
    })
    expect(result.status).toBe('failed')
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0][0]
    expect(message.split('\n')).toHaveLength(2)
    expect(message).toContain('exit code 101')
    expect(message).toContain('npm run build:image-worker')
  })

  it('rebuilds a stale worker and keeps the old one if that rebuild fails', () => {
    seed(paths.outputBinaryPath, 'old worker', 500)
    seed(pathCargo)
    const rebuilt = run()
    expect(rebuilt.result.status).toBe('built')
    expect(rebuilt.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('重新构建'))

    seed(paths.outputBinaryPath, 'old worker', 500)
    const failed = run({
      build: vi.fn(() => {
        throw new Error('offline: missing crate')
      })
    })
    expect(failed.result.status).toBe('failed')
    expect(failed.warn.mock.calls[0][0]).toContain('先继续用旧版本')
    expect(fs.readFileSync(paths.outputBinaryPath, 'utf8')).toBe('old worker')
  })

  it('leaves an explicit worker path alone', () => {
    seed(pathCargo)
    const { result, build, warn } = run({
      env: { PATH: pathDir, MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH: 'D:/workers/worker.exe' }
    })
    expect(result.status).toBe('env-override')
    expect(build).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
