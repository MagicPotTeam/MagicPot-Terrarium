import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { getNativeBuildOptions } from './native-build-options.mjs'

const win = path.win32
const HOST = 'x86_64-pc-windows-msvc'
const VERSION = '1.98.1'
const SEP = '\x1f'
const ROOT = 'D:\\builds\\MagicPot'
const HOME = 'D:\\cache\\cargo'
const CARGO = 'D:\\tools\\rust\\bin\\cargo.exe'
const RUSTC = 'D:\\tools\\rust\\bin\\rustc.exe'
const manifest = (root = ROOT) => win.join(root, 'packages', 'lora-trigger-sidecar', 'Cargo.toml')
const reproEnv = (overrides = {}) => ({
  MAGICPOT_REPRODUCIBLE_NATIVE: '1',
  MAGICPOT_EXPECTED_RUST_VERSION: VERSION,
  CARGO,
  RUSTC,
  CARGO_HOME: HOME,
  ...overrides
})

// All filesystem and toolchain probes are synthetic: never invoke Cargo, rustc or rustup.
function fixture(overrides = {}) {
  const calls = []
  const reads = []
  const input = {
    repoRoot: ROOT,
    manifestPath: manifest(),
    platform: 'win32',
    env: reproEnv(),
    offlineFromEnv: true,
    realpath: (name) => {
      reads.push(name)
      return win.normalize(name)
    },
    stat: (name) => {
      if (win.basename(name).toLowerCase() === 'rustup.exe') {
        throw Object.assign(new Error('missing synthetic rustup'), { code: 'ENOENT' })
      }
      return {
        dev: 1n,
        ino: name.toLowerCase().endsWith('cargo.exe') ? 2n : 3n,
        isDirectory: () => !name.endsWith('.exe'),
        isFile: () => name.endsWith('.exe')
      }
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      const binary = win.basename(command, '.exe')
      return {
        status: 0,
        stdout: `${binary} ${VERSION} (synthetic)\nhost: ${HOST}\nrelease: ${VERSION}\n`
      }
    },
    ...overrides
  }
  return { input, calls, reads, run: () => getNativeBuildOptions(input) }
}

function rejected(envOverrides, pattern, inputOverrides = {}) {
  const f = fixture({ env: reproEnv(envOverrides), ...inputOverrides })
  assert.throws(f.run, pattern)
  assert.equal(f.calls.length, 0, 'invalid options fail before even version probes')
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`normal ${platform}: preserves flags, environment and default copy directory`, () => {
    const paths = platform === 'win32' ? win : path.posix
    const root = platform === 'win32' ? ROOT : '/builds/MagicPot'
    const manifestPath = paths.join(root, 'packages', 'lora-trigger-sidecar', 'Cargo.toml')
    const env = {
      CARGO: 'custom-cargo',
      RUSTFLAGS: '-C target-feature=+crt-static',
      CARGO_ENCODED_RUSTFLAGS: 'custom',
      RUSTC_WRAPPER: 'wrapper',
      CARGO_NET_OFFLINE: 'true'
    }
    const f = fixture({ platform, repoRoot: root, manifestPath, env })
    const result = f.run()
    assert.equal(result.cargo, 'custom-cargo')
    assert.equal(result.env, env)
    assert.deepEqual(result.args, [
      'build',
      '--release',
      '--locked',
      '--offline',
      '--manifest-path',
      manifestPath
    ])
    assert.equal(result.cwd, root)
    assert.equal(result.releaseDir, paths.join(paths.dirname(manifestPath), 'target', 'release'))
    assert.equal(f.calls.length, 0)
    assert.equal(f.reads.length, 0)
  })
}

test('normal command-job retains its existing arguments and non-Windows skip', () => {
  const f = fixture({ env: { CARGO_NET_OFFLINE: '1' }, offlineFromEnv: false, windowsOnly: true })
  assert.deepEqual(f.run().args, ['build', '--release', '--locked', '--manifest-path', manifest()])
  assert.equal(fixture({ env: {}, platform: 'linux', windowsOnly: true }).run(), null)
  assert.equal(f.calls.length, 0)
})

test('normal opt-out values and offline spelling keep existing behavior', () => {
  for (const mode of [undefined, '', '0']) {
    for (const offline of [undefined, 'false', 'TRUE', '0', '1', 'true']) {
      const f = fixture({ env: { MAGICPOT_REPRODUCIBLE_NATIVE: mode, CARGO_NET_OFFLINE: offline } })
      assert.equal(f.run().args.includes('--offline'), ['1', 'true'].includes(offline))
      assert.equal(f.calls.length, 0)
    }
  }
})

test('CARGO_TARGET_DIR copy lookup is relative to Cargo cwd, without changing normal args', () => {
  for (const target of ['isolated target', 'E:\\native-target']) {
    const f = fixture({ env: { CARGO_TARGET_DIR: target } })
    const result = f.run()
    assert.equal(result.releaseDir, win.join(win.resolve(ROOT, target), 'release'))
    assert.equal(result.args.includes('--target-dir'), false)
  }
})

test('reproducible two-root options remap the same relative sources and cache paths', () => {
  const results = []
  for (const [root, home] of [
    [ROOT, HOME],
    ['E:\\second source 根', 'E:\\second cache']
  ]) {
    const env = Object.freeze(reproEnv({ CARGO_HOME: home, SECRET_REFERENCE: 'untouched' }))
    const f = fixture({ repoRoot: root, manifestPath: manifest(root), env })
    const result = f.run()
    assert.deepEqual(result.args, [
      'build',
      '--release',
      '--locked',
      '--offline',
      '--manifest-path',
      manifest(root),
      '--target',
      HOST,
      '--target-dir',
      win.join(root, 'packages', 'lora-trigger-sidecar', 'target')
    ])
    assert.deepEqual(result.env.CARGO_ENCODED_RUSTFLAGS.split(SEP), [
      '-C',
      'link-arg=/Brepro',
      `--remap-path-prefix=${root}=magicpot`,
      `--remap-path-prefix=${home}=cargo`
    ])
    assert.equal(result.env.CARGO_HOME, home)
    assert.equal(result.env.CARGO_NET_OFFLINE, 'true')
    assert.equal(result.env.RUSTUP_AUTO_INSTALL, '0')
    assert.equal(result.env.SECRET_REFERENCE, 'untouched')
    assert.equal(
      result.releaseDir,
      win.join(root, 'packages', 'lora-trigger-sidecar', 'target', HOST, 'release')
    )
    assert.equal(env.CARGO_ENCODED_RUSTFLAGS, undefined)
    assert.equal(f.calls.length, 2)
    for (const call of f.calls) {
      assert.ok([CARGO, RUSTC].includes(call.command))
      assert.deepEqual(call.args, ['--version', '--verbose'])
      assert.equal(call.options.shell, false)
      assert.equal(call.options.cwd, root)
      assert.equal(call.options.env, result.env)
      assert.equal(call.options.encoding, 'utf8')
      assert.equal(call.options.timeout, 10_000)
    }
    results.push(
      JSON.stringify(result)
        .replaceAll(root.replaceAll('\\', '\\\\'), '<root>')
        .replaceAll(home.replaceAll('\\', '\\\\'), '<home>')
    )
  }
  assert.equal(results[0], results[1])
})

test('reproducible command-job uses the same offline flags and matching copy directory', () => {
  const manifestPath = win.join(ROOT, 'packages', 'magicpot-command-job', 'Cargo.toml')
  const result = fixture({ manifestPath, offlineFromEnv: false, windowsOnly: true }).run()
  assert.ok(result.args.includes('--offline'))
  assert.equal(result.args[result.args.indexOf('--manifest-path') + 1], manifestPath)
  assert.equal(result.releaseDir, win.join(win.dirname(manifestPath), 'target', HOST, 'release'))
})

test('reproducible native target and custom target directory have matching copy paths', () => {
  for (const target of ['isolated target', 'E:\\native-target']) {
    const result = fixture({
      env: reproEnv({ CARGO_TARGET_DIR: target, CARGO_BUILD_TARGET: HOST })
    }).run()
    const absolute = win.resolve(ROOT, target)
    assert.equal(result.args.at(-1), absolute)
    assert.equal(result.env.CARGO_TARGET_DIR, target)
    assert.equal(result.releaseDir, win.join(absolute, HOST, 'release'))
  }
})

test('preserves unrelated encoded flags, empty raw flags and every unrelated env value', () => {
  const custom = [
    '-C',
    'target-feature=+crt-static',
    '-Clink-arg=/NODEFAULTLIB:libcmt',
    '-Clink-arg=/INCREMENTAL:NO',
    '--cfg',
    'feature="spaces allowed"'
  ]
  const env = Object.freeze(
    reproEnv({
      CARGO_ENCODED_RUSTFLAGS: custom.join(SEP),
      RUSTFLAGS: '',
      PATH: 'synthetic path',
      CARGO_ENCODED_RUSTDOCFLAGS: 'docs',
      CARGO_INCREMENTAL: '0'
    })
  )
  const result = fixture({ env }).run()
  assert.deepEqual(result.env.CARGO_ENCODED_RUSTFLAGS.split(SEP).slice(0, custom.length), custom)
  for (const [key, value] of Object.entries(env)) {
    if (key !== 'CARGO_ENCODED_RUSTFLAGS') assert.equal(result.env[key], value)
  }
})

test('an existing exact /Brepro flag is preserved without adding a duplicate', () => {
  for (const flags of [
    ['-C', 'link-arg=/Brepro'],
    ['-Clink-arg=/Brepro'],
    ['--codegen=link-arg=/Brepro']
  ]) {
    const result = fixture({ env: reproEnv({ CARGO_ENCODED_RUSTFLAGS: flags.join(SEP) }) }).run()
    assert.deepEqual(result.env.CARGO_ENCODED_RUSTFLAGS.split(SEP).slice(0, flags.length), flags)
    assert.equal(result.env.CARGO_ENCODED_RUSTFLAGS.match(/Brepro/g).length, 1)
  }
})

test('Windows env lookup and replacement are case-insensitive without duplicate child keys', () => {
  const env = Object.fromEntries(
    Object.entries(reproEnv({ CARGO_ENCODED_RUSTFLAGS: '-Copt-level=2', Path: 'keep' })).map(
      ([key, value]) => [key.toLowerCase(), value]
    )
  )
  const result = fixture({ env }).run()
  assert.ok(result.env.CARGO_ENCODED_RUSTFLAGS.startsWith(`-Copt-level=2${SEP}`))
  assert.equal(result.env.path, 'keep')
  assert.equal(
    Object.keys(result.env).filter((key) => key.toUpperCase() === 'CARGO_ENCODED_RUSTFLAGS').length,
    1
  )
  assert.equal(
    fixture({ env: { cargo: 'normal-cargo', cargo_net_offline: '1' } }).run().cargo,
    'normal-cargo'
  )
})

test('executable paths with spaces and shell metacharacters stay single shell-free commands', () => {
  const cargo = 'D:\\tools & echo NO\\cargo.exe'
  const rustc = 'D:\\tools & echo NO\\rustc.exe'
  const f = fixture({ env: reproEnv({ CARGO: cargo, RUSTC: rustc }) })
  assert.equal(f.run().cargo, cargo)
  assert.deepEqual(
    f.calls.map((call) => call.command),
    [cargo, rustc]
  )
  assert.ok(f.calls.every((call) => call.options.shell === false))
})

for (const [name, value, pattern] of [
  ['MAGICPOT_REPRODUCIBLE_NATIVE', 'true', /MAGICPOT_REPRODUCIBLE_NATIVE/],
  ['MAGICPOT_EXPECTED_RUST_VERSION', undefined, /MAGICPOT_EXPECTED_RUST_VERSION/],
  ['MAGICPOT_EXPECTED_RUST_VERSION', 'stable', /MAGICPOT_EXPECTED_RUST_VERSION/],
  ['MAGICPOT_EXPECTED_RUST_VERSION', '1.98.1 --flag', /MAGICPOT_EXPECTED_RUST_VERSION/],
  ['CARGO', undefined, /CARGO/],
  ['CARGO', 'cargo', /CARGO/],
  ['RUSTC', undefined, /RUSTC/],
  ['RUSTC', 'rustc', /RUSTC/],
  ['CARGO', 'D:\\tools\\cargo.cmd', /CARGO/],
  ['RUSTC', 'D:\\other\\bin\\rustc.exe', /same toolchain/],
  ['CARGO_HOME', undefined, /CARGO_HOME/],
  ['CARGO_HOME', '', /CARGO_HOME/],
  ['CARGO_HOME', 'relative', /CARGO_HOME/],
  ['CARGO_HOME', 'D:relative', /CARGO_HOME/],
  ['CARGO_HOME', '\\\\server\\cache', /CARGO_HOME/],
  ['CARGO_HOME', 'D:\\bad=cache', /CARGO_HOME/],
  ['CARGO_HOME', 'D:\\bad\x1fcache', /CARGO_HOME/],
  ['CARGO_HOME', ROOT, /overlap/],
  ['CARGO_HOME', win.join(ROOT, '.cargo'), /overlap/],
  ['CARGO_HOME', 'D:\\builds', /overlap/],
  ['CARGO_TARGET_DIR', '', /CARGO_TARGET_DIR/],
  ['CARGO_TARGET_DIR', 'D:relative', /CARGO_TARGET_DIR/],
  ['CARGO_BUILD_TARGET', 'aarch64-pc-windows-msvc', /CARGO_BUILD_TARGET/],
  ['CARGO_BUILD_TARGET', 'x86_64-pc-windows-gnu', /CARGO_BUILD_TARGET/],
  ['CARGO_BUILD_TARGET', 'custom.json', /CARGO_BUILD_TARGET/],
  ['CARGO_BUILD_TARGET_DIR', 'elsewhere', /CARGO_BUILD_TARGET_DIR/],
  ['CARGO_NET_OFFLINE', 'false', /CARGO_NET_OFFLINE/],
  ['RUSTUP_AUTO_INSTALL', '1', /RUSTUP_AUTO_INSTALL/],
  ['RUSTFLAGS', '-C target-feature=+crt-static', /RUSTFLAGS.*CARGO_ENCODED_RUSTFLAGS/],
  ['RUSTFLAGS', ' ', /RUSTFLAGS/],
  ['RUSTC_WRAPPER', 'wrapper', /RUSTC_WRAPPER/],
  ['RUSTC_WORKSPACE_WRAPPER', 'wrapper', /RUSTC_WORKSPACE_WRAPPER/],
  ['CARGO_BUILD_RUSTFLAGS', '-Copt-level=2', /CARGO_BUILD_RUSTFLAGS/],
  ['cargo_target_x86_64_pc_windows_msvc_rustflags', '-Copt-level=2', /RUSTFLAGS/i],
  ['CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', 'other.exe', /LINKER/],
  ['CARGO_ENCODED_RUSTFLAGS', '-C\x1f', /CARGO_ENCODED_RUSTFLAGS/],
  ['CARGO_ENCODED_RUSTFLAGS', '-C\0bad', /CARGO_ENCODED_RUSTFLAGS/],
  ['CARGO_ENCODED_RUSTFLAGS', '-C', /CARGO_ENCODED_RUSTFLAGS/],
  ['CARGO_ENCODED_RUSTFLAGS', '--codegen=', /CARGO_ENCODED_RUSTFLAGS/],
  ['CARGO_ENCODED_RUSTFLAGS', '--target=x86_64-pc-windows-gnu', /target/],
  ['CARGO_ENCODED_RUSTFLAGS', '@extra.rsp', /response files/],
  ['CARGO_ENCODED_RUSTFLAGS', '--remap-path-prefix=X=magicpot', /remap-path-prefix/],
  ['CARGO_ENCODED_RUSTFLAGS', '--remap-path-prefix\x1fX=other', /remap-path-prefix/],
  ['CARGO_ENCODED_RUSTFLAGS', '-Clink-arg=/Brepro-', /conflict/i],
  ['CARGO_ENCODED_RUSTFLAGS', '--codegen\x1flink-arg=/INCREMENTAL', /conflict/i],
  ['CARGO_ENCODED_RUSTFLAGS', '-Clink-arg=/TIMESTAMP:42', /conflict/i],
  ['CARGO_ENCODED_RUSTFLAGS', '-Clink-args=/Brepro /DEBUG', /link-args/],
  ['CARGO_ENCODED_RUSTFLAGS', '-Clink-arg=@extra.rsp', /response files/],
  ['CARGO_ENCODED_RUSTFLAGS', '-Clinker=custom', /linker/]
]) {
  test(`reproducible rejects ${name}=${JSON.stringify(value)} before toolchain probes`, () => {
    rejected({ [name]: value }, pattern)
  })
}

test('conflicting raw and encoded flags are not silently discarded', () => {
  rejected({ RUSTFLAGS: '-Copt-level=2', CARGO_ENCODED_RUSTFLAGS: '-Copt-level=3' }, /RUSTFLAGS/)
})

test('ambiguous Windows casing cannot shadow the gate, flags or tools', () => {
  for (const [key, value] of [
    ['magicpot_reproducible_native', '0'],
    ['cargo', 'other'],
    ['rustflags', 'other']
  ]) {
    rejected({ RUSTFLAGS: '', [key]: value }, /ambiguous.*environment/i)
  }
})

for (const platform of ['linux', 'darwin']) {
  test(`reproducible ${platform} fails even for the normally skipped command-job`, () => {
    rejected({}, /Windows.*MSVC/, { platform, windowsOnly: true })
  })
}

test('missing paths and non-directory Cargo home fail without any toolchain spawn', () => {
  rejected({}, /CARGO_HOME/, {
    realpath: (name) => {
      if (name === HOME) throw new Error('ENOENT')
      return name
    }
  })
  rejected({}, /CARGO_HOME/, {
    stat: (name) => ({ isDirectory: () => name !== HOME, isFile: () => name.endsWith('.exe') })
  })
  rejected({}, /CARGO/, {
    stat: (name) => ({ isDirectory: () => true, isFile: () => name !== CARGO })
  })
})

test('canonicalizes directory aliases and direct executable paths for build and remapping', () => {
  const root = 'D:\\aliases\\source'
  const home = 'D:\\aliases\\cargo'
  const result = fixture({
    repoRoot: root,
    manifestPath: manifest(root),
    env: reproEnv({ CARGO_HOME: home }),
    realpath: (name) => (name === root ? ROOT : name === home ? HOME : name)
  }).run()
  assert.equal(result.cwd, ROOT)
  assert.equal(result.args[result.args.indexOf('--manifest-path') + 1], manifest())
  assert.equal(result.env.CARGO_HOME, HOME)
  assert.ok(result.env.CARGO_ENCODED_RUSTFLAGS.includes(`--remap-path-prefix=${ROOT}=magicpot`))
})

for (const binary of ['cargo', 'rustc']) {
  for (const [name, response] of [
    [
      'wrong version',
      { status: 0, stdout: `${binary} 1.97.0 (synthetic)\nrelease: 1.97.0\nhost: ${HOST}\n` }
    ],
    [
      'unsupported host',
      {
        status: 0,
        stdout: `${binary} ${VERSION} (synthetic)\nrelease: ${VERSION}\nhost: x86_64-pc-windows-gnu\n`
      }
    ],
    ['missing host', { status: 0, stdout: `${binary} ${VERSION}\nrelease: ${VERSION}\n` }],
    [
      'duplicate host',
      {
        status: 0,
        stdout: `${binary} ${VERSION}\nrelease: ${VERSION}\nhost: ${HOST}\nhost: other\n`
      }
    ],
    [
      'wrong binary',
      { status: 0, stdout: `rustup ${VERSION}\nrelease: ${VERSION}\nhost: ${HOST}\n` }
    ],
    ['failed exit', { status: 7, stdout: '' }],
    ['signal', { status: null, signal: 'SIGTERM', stdout: '' }],
    ['spawn error', { error: new Error('ENOENT'), status: null }],
    ['timeout', { error: new Error('ETIMEDOUT'), status: null }],
    ['malformed output', { status: 0, stdout: null }]
  ]) {
    test(`${binary} ${name} rejects before any build command can be returned`, () => {
      const f = fixture()
      const original = f.input.spawn
      f.input.spawn = (command, args, options) => {
        const good = original(command, args, options)
        return command === (binary === 'cargo' ? CARGO : RUSTC) ? response : good
      }
      assert.throws(f.run, new RegExp(binary, 'i'))
      assert.ok(f.calls.length <= 2)
      assert.ok(f.calls.every((call) => call.args[0] === '--version'))
    })
  }
}

for (const grouped of ['-vClink-arg=/Brepro-', '-vClinker=custom', '-vvClink-args=/Brepro-']) {
  test(`grouped rustc short options cannot bypass checked codegen: ${grouped}`, () => {
    rejected({ CARGO_ENCODED_RUSTFLAGS: ['-Clink-arg=/Brepro', grouped].join(SEP) }, /grouped/)
  })
}

test('ordinary CARGO_HOME/bin proxies are rejected before version probes', () => {
  rejected(
    { CARGO: win.join(HOME, 'bin/cargo.exe'), RUSTC: win.join(HOME, 'bin/rustc.exe') },
    /proxy|direct/i
  )
})

test('hardlinked cargo/rustc proxies are rejected even outside the default proxy directory', () => {
  const stat = fixture().input.stat
  rejected({}, /proxy|distinct/i, {
    stat: (name) => ({ ...stat(name), dev: 7n, ino: 17n })
  })
})

test('a tool hardlinked to sibling rustup is rejected before executing it', () => {
  const stat = fixture().input.stat
  rejected({}, /proxy|rustup/i, {
    stat: (name) => (win.basename(name) === 'rustup.exe' ? stat(CARGO) : stat(name))
  })
})

test('inaccessible proxy identity checks fail closed before probing', () => {
  const stat = fixture().input.stat
  rejected({}, /proxy|identity/i, {
    stat: (name) => {
      if (win.basename(name) === 'rustup.exe') {
        throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' })
      }
      return stat(name)
    }
  })
})

test('spawn exceptions fail preflight without retry or build', () => {
  const f = fixture({
    spawn: () => {
      throw new Error('cannot spawn')
    }
  })
  assert.throws(f.run, /cargo.*cannot spawn/i)
})
