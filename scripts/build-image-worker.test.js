import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import { vol } from 'memfs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildImageWorker, getImageWorkerBuildPaths } from './build-image-worker.mjs'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => {
    throw new Error('Unexpected real process dispatch in image-worker tests')
  })
}))

const HOST = 'x86_64-pc-windows-msvc'
const VERSION = '1.98.1'
const HOME = 'D:\\synthetic cargo cache'
const CARGO = 'D:\\synthetic tools\\bin\\cargo.exe'
const RUSTC = 'D:\\synthetic tools\\bin\\rustc.exe'
const SEP = '\x1f'
const normalizePath = (value) => value.replaceAll(path.sep, '/')
const reproEnv = (overrides = {}) => ({
  MAGICPOT_REPRODUCIBLE_NATIVE: '1',
  MAGICPOT_EXPECTED_RUST_VERSION: VERSION,
  CARGO_HOME: HOME,
  CARGO,
  RUSTC,
  ...overrides
})

// node:fs is memfs in the node suite; every tool and preflight probe is synthetic.
function seed(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function fixture({ platform = 'win32', arch = 'x64', env = {}, source = true } = {}) {
  const repoRoot = path.join('D:/synthetic image-worker', 'repo')
  const paths = getImageWorkerBuildPaths({ repoRoot, platform, arch })
  seed(paths.manifestPath, '[package]\n')
  seed(paths.outputBinaryPath, 'existing packaged binary')
  if (source) seed(paths.sourceBinaryPath, 'old cache binary')
  const realpath = vi.fn((name) => path.win32.normalize(name))
  const stat = vi.fn((name) => {
    if (path.win32.basename(name).toLowerCase() === 'rustup.exe') {
      throw Object.assign(new Error('No synthetic rustup'), { code: 'ENOENT' })
    }
    return {
      dev: 1n,
      ino: name.toLowerCase().endsWith('cargo.exe') ? 2n : 3n,
      isDirectory: () => !name.endsWith('.exe'),
      isFile: () => name.endsWith('.exe')
    }
  })
  const spawn = vi.fn((command, args) => {
    if (args[0] === '--version') {
      const binary = path.win32.basename(command, '.exe')
      return {
        status: 0,
        stdout: `${binary} ${VERSION} (synthetic)\nrelease: ${VERSION}\nhost: ${HOST}\n`
      }
    }
    return { status: 0, signal: null }
  })
  const input = { repoRoot, platform, arch, env, spawn, realpath, stat }
  return { paths, input, spawn, realpath, stat, run: () => buildImageWorker(input) }
}

function reproFixture({ env = reproEnv(), source = true, ...options } = {}) {
  const f = fixture({ ...options, env })
  const target = Object.entries(env).find(([key]) => key.toUpperCase() === 'CARGO_TARGET_DIR')?.[1]
  const targetDir =
    target === undefined
      ? path.win32.join(path.win32.dirname(f.paths.manifestPath), 'target')
      : path.win32.resolve(f.input.repoRoot, target)
  const sourceBinaryPath = path.win32.join(
    targetDir,
    HOST,
    'release',
    'canvas-thumbnail-sidecar.exe'
  )
  if (source) seed(sourceBinaryPath, 'fresh controlled-target binary')
  return { ...f, targetDir, sourceBinaryPath }
}

function watchMutations() {
  return ['mkdirSync', 'rmSync', 'copyFileSync', 'chmodSync'].map((name) => vi.spyOn(fs, name))
}

function expectPreserved(f, pattern, expectedProbes = 0) {
  const before = vol.toJSON()
  const mutations = watchMutations()
  expect(f.run).toThrow(pattern)
  expect(f.spawn).toHaveBeenCalledTimes(expectedProbes)
  expect(f.spawn.mock.calls.every(([, args]) => args[0] === '--version')).toBe(true)
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled()
  expect(vol.toJSON()).toEqual(before)
  expect(fs.readFileSync(f.paths.outputBinaryPath, 'utf8')).toBe('existing packaged binary')
}

beforeEach(() => {
  vol.reset()
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  expect(spawnSync).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vol.reset()
})

describe('build-image-worker normal compatibility', () => {
  it('derives the existing cargo target and runtime asset paths', () => {
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

  it('keeps the existing API and inherited process environment with a fixed cache target', () => {
    vi.stubEnv('MAGICPOT_REPRODUCIBLE_NATIVE', '0')
    vi.stubEnv('CARGO_TARGET_DIR', 'E:\\must-not-use-in-normal-mode')
    const f = fixture({ platform: 'linux' })
    const input = { ...f.input }
    delete input.env
    const result = buildImageWorker(input)
    expect(result).toEqual(f.paths)
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
      'cargo',
      ['build', '--release', '--manifest-path', f.paths.manifestPath],
      {
        cwd: input.repoRoot,
        shell: false,
        stdio: 'inherit',
        env: { ...process.env, CARGO_TARGET_DIR: f.paths.cargoTargetDir }
      }
    )
    expect(fs.readFileSync(result.outputBinaryPath, 'utf8')).toBe('old cache binary')
    expect(fs.statSync(result.outputBinaryPath).mode & 0o777).toBe(0o755)
  })

  for (const platform of ['linux', 'darwin', 'win32']) {
    it.each([undefined, '', '0'])(
      `${platform}: mode %j preserves args, env, cache and chmod`,
      (mode) => {
        const env = Object.freeze({
          MAGICPOT_REPRODUCIBLE_NATIVE: mode,
          CARGO: 'ignored-custom-cargo',
          CARGO_TARGET_DIR: 'E:\\ignored-external-target',
          RUSTFLAGS: '-Copt-level=2',
          CARGO_ENCODED_RUSTFLAGS: 'unchanged',
          CARGO_NET_OFFLINE: 'true',
          RUSTC_WRAPPER: 'normal-wrapper',
          SYNTHETIC_REFERENCE: 'unchanged'
        })
        const f = fixture({ platform, arch: 'arm64', env })
        const chmod = vi.spyOn(fs, 'chmodSync')
        expect(f.run()).toEqual(f.paths)
        expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
          'cargo',
          ['build', '--release', '--manifest-path', f.paths.manifestPath],
          {
            cwd: f.input.repoRoot,
            shell: false,
            stdio: 'inherit',
            env: { ...env, CARGO_TARGET_DIR: f.paths.cargoTargetDir }
          }
        )
        expect(f.realpath).not.toHaveBeenCalled()
        expect(f.stat).not.toHaveBeenCalled()
        expect(fs.readFileSync(f.paths.outputBinaryPath, 'utf8')).toBe('old cache binary')
        if (platform === 'win32') {
          expect(chmod).not.toHaveBeenCalled()
        } else {
          expect(chmod).toHaveBeenCalledTimes(1)
          expect(chmod.mock.calls[0][0]).toContain(`${f.paths.outputBinaryPath}.`)
          expect(chmod.mock.calls[0][0]).toContain('.tmp')
          expect(chmod.mock.calls[0][1]).toBe(0o755)
        }
      }
    )
  }
})

describe('build-image-worker reproducible opt-in', () => {
  it.each([undefined, 'E:\\controlled target', 'isolated target'])(
    'uses shared preflight/build options and actual release output for target %j',
    (target) => {
      const env = Object.freeze(
        reproEnv({
          ...(target === undefined ? {} : { CARGO_TARGET_DIR: target }),
          CARGO_ENCODED_RUSTFLAGS: '-Copt-level=2',
          SYNTHETIC_REFERENCE: 'untouched'
        })
      )
      const f = reproFixture({ env })
      const mutations = watchMutations()
      const result = f.run()
      const childEnv = {
        ...env,
        CARGO_ENCODED_RUSTFLAGS: [
          '-Copt-level=2',
          '-C',
          'link-arg=/Brepro',
          `--remap-path-prefix=${path.win32.normalize(f.input.repoRoot)}=magicpot`,
          `--remap-path-prefix=${HOME}=cargo`
        ].join(SEP),
        CARGO_NET_OFFLINE: 'true',
        RUSTUP_AUTO_INSTALL: '0'
      }
      expect(f.spawn.mock.calls.map(([command]) => command)).toEqual([CARGO, RUSTC, CARGO])
      for (const [, args, options] of f.spawn.mock.calls.slice(0, 2)) {
        expect(args).toEqual(['--version', '--verbose'])
        expect(options).toEqual({
          cwd: path.win32.normalize(f.input.repoRoot),
          env: childEnv,
          shell: false,
          encoding: 'utf8',
          stdio: 'pipe',
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024
        })
      }
      expect(f.spawn.mock.calls[2]).toEqual([
        CARGO,
        [
          'build',
          '--release',
          '--locked',
          '--offline',
          '--manifest-path',
          path.win32.normalize(f.paths.manifestPath),
          '--target',
          HOST,
          '--target-dir',
          f.targetDir
        ],
        {
          cwd: path.win32.normalize(f.input.repoRoot),
          env: childEnv,
          shell: false,
          stdio: 'inherit'
        }
      ])
      expect(result).toEqual({
        ...f.paths,
        cargoTargetDir: f.targetDir,
        sourceBinaryPath: f.sourceBinaryPath
      })
      expect(fs.readFileSync(result.outputBinaryPath, 'utf8')).toBe(
        'fresh controlled-target binary'
      )
      expect(fs.readFileSync(f.paths.sourceBinaryPath, 'utf8')).toBe('old cache binary')
      expect(mutations[0]).toHaveBeenCalledExactlyOnceWith(f.paths.outputDir, { recursive: true })
      expect(mutations[2]).toHaveBeenCalledExactlyOnceWith(
        f.sourceBinaryPath,
        expect.stringContaining(`${f.paths.outputBinaryPath}.`)
      )
      expect(mutations[1].mock.calls.some(([file]) => file === f.paths.outputBinaryPath)).toBe(
        false
      )
      expect(mutations[3]).not.toHaveBeenCalled()
      expect(env.CARGO_ENCODED_RUSTFLAGS).toBe('-Copt-level=2')
    }
  )

  it('uses the helper canonical source root for cwd, manifest, flags and relative target', () => {
    const f = reproFixture({
      env: reproEnv({ CARGO_TARGET_DIR: 'isolated target' }),
      source: false
    })
    const root = 'E:\\canonical synthetic source'
    f.realpath.mockImplementation((name) =>
      name === path.win32.normalize(f.input.repoRoot) ? root : path.win32.normalize(name)
    )
    const source = path.win32.join(
      root,
      'isolated target',
      HOST,
      'release',
      'canvas-thumbnail-sidecar.exe'
    )
    seed(source, 'canonical release binary')
    expect(f.run().sourceBinaryPath).toBe(source)
    expect(f.spawn.mock.calls[2][2].cwd).toBe(root)
    expect(f.spawn.mock.calls[2][1]).toContain(
      path.win32.join(root, 'packages/canvas-thumbnail-sidecar/Cargo.toml')
    )
    expect(f.spawn.mock.calls[2][2].env.CARGO_ENCODED_RUSTFLAGS).toContain(
      `--remap-path-prefix=${root}=magicpot`
    )
    expect(fs.readFileSync(f.paths.outputBinaryPath, 'utf8')).toBe('canonical release binary')
  })

  it('honors Windows environment casing without bypassing the opt-in', () => {
    const env = Object.fromEntries(
      Object.entries(reproEnv({ CARGO_TARGET_DIR: 'E:\\lowercase target' })).map(([key, value]) => [
        key.toLowerCase(),
        value
      ])
    )
    const f = reproFixture({ env })
    expect(f.run().sourceBinaryPath).toBe(f.sourceBinaryPath)
    expect(f.spawn.mock.calls.map(([command]) => command)).toEqual([CARGO, RUSTC, CARGO])
    expect(fs.readFileSync(f.paths.outputBinaryPath, 'utf8')).toBe('fresh controlled-target binary')
  })

  it.each(['linux', 'darwin'])('rejects opt-in on %s without probes or mutations', (platform) => {
    expectPreserved(fixture({ platform, env: reproEnv() }), /Windows.*MSVC/)
  })

  it.each(['arm64', 'ia32'])(
    'rejects opt-in for Windows %s without probes or mutations',
    (arch) => {
      expectPreserved(fixture({ arch, env: reproEnv() }), /x64|architecture/i)
    }
  )

  it.each(['true', 'false', '2', ' 1', '1 '])(
    'rejects malformed opt-in %j before dispatch',
    (mode) => {
      expectPreserved(
        fixture({ env: { MAGICPOT_REPRODUCIBLE_NATIVE: mode } }),
        /MAGICPOT_REPRODUCIBLE_NATIVE/
      )
    }
  )

  it('rejects malformed opt-in on non-Windows too', () => {
    expectPreserved(
      fixture({ platform: 'linux', env: { MAGICPOT_REPRODUCIBLE_NATIVE: 'yes' } }),
      /MAGICPOT_REPRODUCIBLE_NATIVE/
    )
  })

  it('rejects ambiguous Windows opt-in keys instead of falling back to normal', () => {
    expectPreserved(
      fixture({ env: reproEnv({ magicpot_reproducible_native: '0' }) }),
      /ambiguous.*environment/i
    )
  })

  it.each([
    ['MAGICPOT_EXPECTED_RUST_VERSION', undefined, /MAGICPOT_EXPECTED_RUST_VERSION/],
    ['CARGO', 'cargo', /CARGO/],
    ['RUSTC', 'rustc', /RUSTC/],
    ['CARGO_HOME', 'relative', /CARGO_HOME/],
    ['CARGO_TARGET_DIR', '', /CARGO_TARGET_DIR/],
    ['CARGO_BUILD_TARGET', 'aarch64-pc-windows-msvc', /CARGO_BUILD_TARGET/],
    ['RUSTFLAGS', '-Copt-level=2', /RUSTFLAGS/],
    ['RUSTC_WRAPPER', 'wrapper', /RUSTC_WRAPPER/],
    ['CARGO_NET_OFFLINE', 'false', /CARGO_NET_OFFLINE/],
    ['CARGO_ENCODED_RUSTFLAGS', '-Clink-arg=/Brepro-', /conflict/i],
    ['CARGO_ENCODED_RUSTFLAGS', '--remap-path-prefix=X=other', /remap-path-prefix/]
  ])('delegates preflight rejection of %s=%j to the shared helper', (name, value, pattern) => {
    expectPreserved(fixture({ env: reproEnv({ [name]: value }) }), pattern)
  })

  it('rejects rustup proxies without executing them', () => {
    expectPreserved(
      fixture({
        env: reproEnv({
          CARGO: path.win32.join(HOME, 'bin/cargo.exe'),
          RUSTC: path.win32.join(HOME, 'bin/rustc.exe')
        })
      }),
      /proxy|direct/i
    )
  })

  it('rejects inaccessible preflight paths before dispatch', () => {
    const f = fixture({ env: reproEnv() })
    f.realpath.mockImplementation(() => {
      throw new Error('synthetic missing path')
    })
    expectPreserved(f, /source root/)
  })

  it.each([CARGO, RUSTC])(
    'rejects a bad version/host probe from %s before build or copy',
    (tool) => {
      const f = fixture({ env: reproEnv() })
      const good = f.spawn.getMockImplementation()
      f.spawn.mockImplementation((command, args, options) =>
        command === tool
          ? { status: 0, stdout: 'wrong version and host' }
          : good(command, args, options)
      )
      expectPreserved(f, /must report release/, tool === CARGO ? 1 : 2)
    }
  )
})

describe('build-image-worker failure preservation', () => {
  for (const reproducible of [false, true]) {
    it.each([
      [
        'spawn error',
        () => ({ status: null, error: new Error('synthetic ENOENT') }),
        /Failed to start cargo.*ENOENT/
      ],
      [
        'spawn exception',
        () => {
          throw new Error('synthetic spawn exception')
        },
        /synthetic spawn exception/
      ],
      ['nonzero exit', () => ({ status: 7 }), /exit code 7/],
      ['signal', () => ({ status: null, signal: 'SIGTERM' }), /signal SIGTERM/],
      ['unknown exit', () => ({ status: null }), /unknown exit status/]
    ])(
      `reproducible=${reproducible}: %s preserves an existing binary`,
      (_name, result, pattern) => {
        const f = reproducible ? reproFixture() : fixture()
        const good = f.spawn.getMockImplementation()
        f.spawn.mockImplementation((command, args, options) =>
          args[0] === 'build' ? result() : good(command, args, options)
        )
        const before = vol.toJSON()
        const mutations = watchMutations()
        expect(f.run).toThrow(pattern)
        expect(f.spawn).toHaveBeenCalledTimes(reproducible ? 3 : 1)
        for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled()
        expect(vol.toJSON()).toEqual(before)
        expect(fs.readFileSync(f.paths.outputBinaryPath, 'utf8')).toBe('existing packaged binary')
      }
    )

    it(`reproducible=${reproducible}: missing actual output preserves binary, never uses stale cache`, () => {
      const f = reproducible ? reproFixture({ source: false }) : fixture({ source: false })
      const before = vol.toJSON()
      const mutations = watchMutations()
      expect(f.run).toThrow(
        `binary was not found: ${f.sourceBinaryPath ?? f.paths.sourceBinaryPath}`
      )
      expect(f.spawn).toHaveBeenCalledTimes(reproducible ? 3 : 1)
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled()
      expect(vol.toJSON()).toEqual(before)
      expect(fs.readFileSync(f.paths.outputBinaryPath, 'utf8')).toBe('existing packaged binary')
    })
  }

  it('rejects a missing manifest without dispatch, creation or deletion', () => {
    const f = fixture()
    fs.rmSync(f.paths.manifestPath)
    expectPreserved(f, /Cargo manifest not found/)
  })
})
