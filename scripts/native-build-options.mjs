import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const HOST = 'x86_64-pc-windows-msvc'
const SEPARATOR = '\x1f'

// Opt in with MAGICPOT_REPRODUCIBLE_NATIVE=1, MAGICPOT_EXPECTED_RUST_VERSION=x.y.z,
// explicit absolute CARGO/RUSTC paths to the same already-installed toolchain's
// cargo.exe/rustc.exe, and an existing CARGO_HOME. No +toolchain or rustup command,
// installation or online fallback is used. Standard CARGO_HOME/bin proxies and
// shared executable/rustup file identities are rejected before any tool is run.
// This is not binary authentication: a caller remains responsible for trusted tool bytes.
//
// Scope: the two standalone native packages on the checked native Windows MSVC
// host only. /Brepro and root/cache remapping address the nondeterminism observed
// in the two-directory locked-source probe, not whole-product reproducibility.
// Callers still control/compare source, lockfiles, cached dependencies, SDK/linker,
// Cargo config, other environment and custom flags, and use fresh isolated targets.
// Cargo config rustflags must be moved explicitly into CARGO_ENCODED_RUSTFLAGS:
// Cargo gives that variable precedence. This helper does not parse Cargo config.
// External target directories/custom flags can introduce further absolute paths.

function fail(message) {
  throw new Error(`Reproducible native build: ${message}`)
}

function envKeys(env, name, windows) {
  return Object.keys(env).filter((key) => (windows ? key.toUpperCase() === name : key === name))
}

function envValue(env, name, windows, strict = false) {
  const keys = envKeys(env, name, windows)
  if (strict && keys.length > 1) fail(`ambiguous Windows environment key ${name}`)
  return env[keys.includes(name) ? name : keys[0]]
}

function setEnv(env, name, value) {
  for (const key of envKeys(env, name, true)) delete env[key]
  env[name] = value
}

function hasControl(value, allowSeparator = false) {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0)
    return (code < 32 && !(allowSeparator && char === SEPARATOR)) || code === 127
  })
}

function localAbsolute(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z]:[\\/]/.test(value) ||
    hasControl(value) ||
    value.includes('=')
  ) {
    fail(`${label} must be an absolute local Windows path without control characters or '='`)
  }
  return path.win32.normalize(value)
}

function canonicalPath(value, label, directory, realpath, stat) {
  const absolute = localAbsolute(value, label)
  let canonical
  try {
    canonical = realpath(absolute)
    const info = stat(canonical)
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('wrong path type')
  } catch {
    fail(`${label} must be an existing ${directory ? 'directory' : 'file'}`)
  }
  return localAbsolute(canonical, label)
}

function contains(parent, child) {
  const relative = path.win32.relative(parent, child)
  return (
    relative === '' ||
    (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'))
  )
}

function rejectRustupProxies(cargo, rustc, home, stat) {
  const proxyDirectory = path.win32.join(home, 'bin').toLowerCase()
  if ([cargo, rustc].some((file) => path.win32.dirname(file).toLowerCase() === proxyDirectory)) {
    fail('CARGO_HOME/bin contains rustup proxies; supply direct toolchain executables')
  }
  const identity = (file, optional = false) => {
    try {
      const info = stat(file, { bigint: true })
      if (!info.isFile() || !info.ino || info.dev === undefined) {
        fail('tool proxy identity unavailable')
      }
      return `${info.dev}:${info.ino}`
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null
      fail('tool proxy identity check failed')
    }
  }
  const cargoId = identity(cargo)
  const rustcId = identity(rustc)
  if (cargoId === rustcId) fail('cargo/rustc must be distinct direct binaries, not shared proxies')
  for (const file of new Set([
    path.win32.join(path.win32.dirname(cargo), 'rustup.exe'),
    path.win32.join(home, 'bin', 'rustup.exe')
  ])) {
    const rustupId = identity(file, true)
    if (rustupId === cargoId || rustupId === rustcId)
      fail('rustup proxy executables are unsupported')
  }
}

function reproducibleFlags(value, root, home) {
  if (value !== undefined && (typeof value !== 'string' || hasControl(value, true))) {
    fail('invalid CARGO_ENCODED_RUSTFLAGS')
  }
  const flags = value ? value.split(SEPARATOR) : []
  if (flags.some((flag) => !flag)) fail('empty argument in CARGO_ENCODED_RUSTFLAGS')
  let hasBrepro = false
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]
    if (/^--remap-path-prefix(?:=|$)/.test(flag))
      fail('remap-path-prefix is owned by reproducible mode')
    if (/^--target(?:=|$)/.test(flag) || flag.startsWith('@')) {
      fail('target overrides and response files are unsupported in CARGO_ENCODED_RUSTFLAGS')
    }
    // Rustc accepts grouped short options (for example -vClink-arg=...). Only
    // known argument-taking short prefixes may have attached text; no-argument
    // flags must stand alone so a hidden -C cannot bypass this validation.
    if (/^-[^-].+/.test(flag) && !/^-[ACDFLWloZ]/.test(flag)) {
      fail('grouped or unknown short options are unsupported in CARGO_ENCODED_RUSTFLAGS')
    }
    let codegen
    if (flag === '-C' || flag === '--codegen') {
      codegen = flags[++i]
      if (codegen === undefined) fail('incomplete codegen option in CARGO_ENCODED_RUSTFLAGS')
    } else if (flag.startsWith('-C')) {
      codegen = flag.slice(2)
    } else if (flag.startsWith('--codegen=')) {
      codegen = flag.slice('--codegen='.length)
    }
    if (codegen === undefined) continue
    if (!codegen || codegen.startsWith('-')) {
      fail('incomplete codegen option in CARGO_ENCODED_RUSTFLAGS')
    }
    const separator = codegen.indexOf('=')
    const key = (separator < 0 ? codegen : codegen.slice(0, separator)).replaceAll('_', '-')
    const argument = separator < 0 ? '' : codegen.slice(separator + 1)
    if (['linker', 'linker-flavor', 'link-args'].includes(key)) {
      fail(`unsupported ${key} override in CARGO_ENCODED_RUSTFLAGS; use individual link-arg flags`)
    }
    if (key === 'link-arg') {
      if (argument.startsWith('@')) fail('linker response files are unsupported')
      if (/^[/-]Brepro$/i.test(argument)) hasBrepro = true
      else if (
        /^[/-](?:Brepro|TIMESTAMP|INCREMENTAL)/i.test(argument) &&
        !/^[/-]INCREMENTAL:NO$/i.test(argument)
      ) {
        fail('conflicting linker option in CARGO_ENCODED_RUSTFLAGS')
      }
    }
  }
  if (!hasBrepro) flags.push('-C', 'link-arg=/Brepro')
  flags.push(`--remap-path-prefix=${root}=magicpot`, `--remap-path-prefix=${home}=cargo`)
  return flags.join(SEPARATOR)
}

function checkTool(command, binary, expectedVersion, cwd, env, spawn) {
  let result
  try {
    result = spawn(command, ['--version', '--verbose'], {
      cwd,
      env,
      shell: false,
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024
    })
  } catch (error) {
    fail(`${binary} version probe failed: ${error.message}`)
  }
  if (result.error || result.status !== 0 || result.signal || typeof result.stdout !== 'string') {
    fail(`${binary} version probe failed`)
  }
  const lines = result.stdout.split(/\r?\n/)
  const releases = lines.filter((line) => line.startsWith('release: '))
  const hosts = lines.filter((line) => line.startsWith('host: '))
  if (
    !lines[0].startsWith(`${binary} ${expectedVersion} `) ||
    releases.length !== 1 ||
    releases[0] !== `release: ${expectedVersion}` ||
    hosts.length !== 1 ||
    hosts[0] !== `host: ${HOST}`
  ) {
    fail(`${binary} must report release ${expectedVersion} and native host ${HOST}`)
  }
}

// Derive build/copy options before running Cargo build. FS/version probes are
// injectable so tests need neither a native toolchain nor filesystem fixtures.
// Normal mode deliberately leaves the environment/flags untouched. The only
// copy-path correction is honoring CARGO_TARGET_DIR relative to the Cargo cwd.
export function getNativeBuildOptions({
  repoRoot,
  manifestPath,
  env = process.env,
  platform = process.platform,
  offlineFromEnv = false,
  windowsOnly = false,
  spawn = spawnSync,
  realpath = realpathSync.native,
  stat = statSync
}) {
  const windows = platform === 'win32'
  const get = (name) => envValue(env, name, windows)
  const mode = envValue(env, 'MAGICPOT_REPRODUCIBLE_NATIVE', windows, true)
  if (![undefined, '', '0', '1'].includes(mode)) fail('MAGICPOT_REPRODUCIBLE_NATIVE must be 0 or 1')
  const reproducible = mode === '1'
  if (windowsOnly && !windows && !reproducible) return null
  const paths = windows ? path.win32 : path.posix
  const args = ['build', '--release', '--locked', '--manifest-path', manifestPath]
  if (reproducible || (offlineFromEnv && ['true', '1'].includes(get('CARGO_NET_OFFLINE')))) {
    args.splice(3, 0, '--offline')
  }
  if (!reproducible) {
    const targetDir = get('CARGO_TARGET_DIR')
      ? paths.resolve(repoRoot, get('CARGO_TARGET_DIR'))
      : paths.join(paths.dirname(manifestPath), 'target')
    return {
      cargo: get('CARGO') || 'cargo',
      args,
      cwd: repoRoot,
      env,
      releaseDir: paths.join(targetDir, 'release')
    }
  }

  if (!windows) fail(`only the native Windows MSVC host ${HOST} is supported`)
  const seen = new Set()
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (seen.has(upper)) fail(`ambiguous Windows environment key ${upper}`)
    seen.add(upper)
    // These would be overridden by encoded flags or could bypass checked rustc/linker.
    if (
      /^(?:RUSTC_(?:WORKSPACE_)?WRAPPER|CARGO_BUILD_(?:RUSTFLAGS|RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER)?|TARGET_DIR)|CARGO_TARGET_.+_(?:RUSTFLAGS|LINKER))$/.test(
        upper
      ) &&
      env[key] !== undefined &&
      env[key] !== ''
    ) {
      fail(`unsupported ${upper}; supply explicit tools and CARGO_ENCODED_RUSTFLAGS`)
    }
  }
  const version = get('MAGICPOT_EXPECTED_RUST_VERSION')
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail('MAGICPOT_EXPECTED_RUST_VERSION must be an explicit x.y.z release')
  }
  if (get('RUSTFLAGS') !== undefined && get('RUSTFLAGS') !== '') {
    fail('RUSTFLAGS is ambiguous; move its arguments explicitly to CARGO_ENCODED_RUSTFLAGS')
  }
  if (![undefined, 'true', '1'].includes(get('CARGO_NET_OFFLINE'))) {
    fail('CARGO_NET_OFFLINE must be true or 1 in reproducible mode')
  }
  if (![undefined, '0'].includes(get('RUSTUP_AUTO_INSTALL'))) fail('RUSTUP_AUTO_INSTALL must be 0')
  if (get('CARGO_BUILD_TARGET') !== undefined && get('CARGO_BUILD_TARGET') !== HOST) {
    fail(`CARGO_BUILD_TARGET must be unset or ${HOST}; cross-target builds are unsupported`)
  }

  const root = canonicalPath(repoRoot, 'source root', true, realpath, stat)
  const home = canonicalPath(get('CARGO_HOME'), 'CARGO_HOME', true, realpath, stat)
  if (contains(root, home) || contains(home, root))
    fail('source root and CARGO_HOME must not overlap')
  const cargo = canonicalPath(get('CARGO'), 'CARGO', false, realpath, stat)
  const rustc = canonicalPath(get('RUSTC'), 'RUSTC', false, realpath, stat)
  if (paths.basename(cargo).toLowerCase() !== 'cargo.exe')
    fail('CARGO must name a direct cargo.exe')
  if (paths.basename(rustc).toLowerCase() !== 'rustc.exe')
    fail('RUSTC must name a direct rustc.exe')
  if (paths.dirname(cargo).toLowerCase() !== paths.dirname(rustc).toLowerCase()) {
    fail('CARGO and RUSTC must be in the same toolchain directory')
  }
  rejectRustupProxies(cargo, rustc, home, stat)
  const relativeManifest = paths.relative(repoRoot, manifestPath)
  if (!contains(repoRoot, manifestPath)) fail('manifest must be inside the source root')
  const canonicalManifest = paths.join(root, relativeManifest)
  const target = get('CARGO_TARGET_DIR')
  let targetDir = paths.join(paths.dirname(canonicalManifest), 'target')
  if (target !== undefined) {
    if (typeof target !== 'string' || !target || hasControl(target) || target.includes('=')) {
      fail('invalid CARGO_TARGET_DIR')
    }
    if (/^[A-Za-z]:/.test(target) || /^[\\/]/.test(target))
      localAbsolute(target, 'CARGO_TARGET_DIR')
    targetDir = paths.resolve(root, target)
  }
  const childEnv = { ...env }
  setEnv(
    childEnv,
    'CARGO_ENCODED_RUSTFLAGS',
    reproducibleFlags(get('CARGO_ENCODED_RUSTFLAGS'), root, home)
  )
  setEnv(childEnv, 'CARGO_HOME', home)
  setEnv(childEnv, 'CARGO', cargo)
  setEnv(childEnv, 'RUSTC', rustc)
  setEnv(childEnv, 'CARGO_NET_OFFLINE', 'true')
  setEnv(childEnv, 'RUSTUP_AUTO_INSTALL', '0')
  args[args.indexOf('--manifest-path') + 1] = canonicalManifest
  // Explicit native --target avoids an implicit Cargo-config cross target, and
  // --target-dir makes the copy location unambiguous even with Cargo config.
  args.push('--target', HOST, '--target-dir', targetDir)
  checkTool(cargo, 'cargo', version, root, childEnv, spawn)
  checkTool(rustc, 'rustc', version, root, childEnv, spawn)
  return {
    cargo,
    args,
    cwd: root,
    env: childEnv,
    releaseDir: paths.join(targetDir, HOST, 'release')
  }
}
