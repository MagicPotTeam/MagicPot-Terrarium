import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizedPath, publishExactNoReplace, safeReadRegularFile } from './safe-file.ts'

export const BOOTSTRAP_BUNDLE_NAMES = Object.freeze({
  descriptor: 'MagicPot.Bootstrap.json',
  signature: 'MagicPot.Bootstrap.sig',
  launcher: 'MagicPot.Launcher.exe',
  uninstaller: 'MagicPot.Uninstall.exe'
})
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CHANNELS = new Set(['stable', 'beta', 'nightly'])
const RUNTIME = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
function fail(message: string): never {
  throw new Error(`bootstrap descriptor rejected: ${message}`)
}
function absolute(path: string, label: string): string {
  if (!isAbsolute(path)) fail(`${label} must be absolute`)
  return resolve(path)
}
function read(path: string, label: string, max: number): Buffer {
  return safeReadRegularFile(
    absolute(path, label),
    max,
    `${label} must be a nonempty single-link regular file within a non-symlink path`
  )
}
function identity(bytes: Buffer): { size: number; sha256: string } {
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
function exactObject(
  value: unknown,
  names: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...names].sort().join('\0')
  )
    fail(`${label} schema mismatch`)
  return value as Record<string, unknown>
}
export function buildDescriptor(options: {
  manifest: string
  launcher: string
  uninstaller: string
  channel: string
  buildId: string
  runtimeId: string
  launcherVersion: string
  uninstallerVersion: string
  keyId: string
}): { bytes: Buffer; launcherBytes: Buffer; uninstallerBytes: Buffer } {
  if (
    !CHANNELS.has(options.channel) ||
    !RUNTIME.test(options.runtimeId) ||
    options.runtimeId.includes('..') ||
    !SEMVER.test(options.launcherVersion) ||
    !SEMVER.test(options.uninstallerVersion) ||
    !KEY_ID.test(options.keyId) ||
    options.keyId.includes('..')
  )
    fail('selection, version, or key ID is invalid')
  const manifestBytes = read(options.manifest, 'manifest', 4 * 1024 * 1024)
  if (manifestBytes.length === 0) fail('manifest is empty')
  const manifestRaw = manifestBytes.toString('utf8')
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestRaw)
  } catch {
    fail('manifest is not JSON')
  }
  const root = exactObject(
    manifest,
    ['schema', 'channel', 'generatedAt', 'releases', 'signature'],
    'manifest'
  )
  if (root.schema !== 1 || root.channel !== options.channel || !Array.isArray(root.releases))
    fail('manifest identity mismatch')
  const selected = root.releases.filter((item) => {
    const release = item as any
    return (
      release?.buildId === options.buildId &&
      release?.artifacts?.app?.runtimeId === options.runtimeId &&
      release?.artifacts?.runtime?.runtimeId === options.runtimeId
    )
  })
  if (selected.length !== 1) fail('selection is not unique in signed manifest')
  const launcherPath = absolute(options.launcher, 'launcher'),
    uninstallerPath = absolute(options.uninstaller, 'uninstaller')
  if (
    !/MagicPot\.Launcher\.exe$/i.test(launcherPath) ||
    !/MagicPot\.Uninstall\.exe$/i.test(uninstallerPath) ||
    normalizedPath(launcherPath) === normalizedPath(uninstallerPath)
  )
    fail('stable binary path or type is invalid')
  const launcherBytes = read(launcherPath, 'launcher', 512 * 1024 * 1024),
    uninstallerBytes = read(uninstallerPath, 'uninstaller', 512 * 1024 * 1024)
  if (launcherBytes.length === 0 || uninstallerBytes.length === 0)
    fail('stable binaries must be nonempty')
  const descriptor = {
    schema: 1,
    signature: { algorithm: 'ed25519', keyId: options.keyId },
    launcherVersion: options.launcherVersion,
    launcher: { sourcePath: BOOTSTRAP_BUNDLE_NAMES.launcher, ...identity(launcherBytes) },
    uninstaller: {
      version: options.uninstallerVersion,
      sourcePath: BOOTSTRAP_BUNDLE_NAMES.uninstaller,
      ...identity(uninstallerBytes)
    },
    channelManifestRaw: manifestRaw,
    selection: { channel: options.channel, buildId: options.buildId, runtimeId: options.runtimeId }
  }
  return { bytes: Buffer.from(JSON.stringify(descriptor), 'utf8'), launcherBytes, uninstallerBytes }
}
export function run(argv: readonly string[]): void {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i],
      value = argv[i + 1]
    if (!key || !value || values.has(key)) fail('invalid arguments')
    values.set(key, value)
  }
  const get = (name: string) => values.get(name) ?? fail(`missing ${name}`)
  const outputDir = absolute(get('--output-dir'), 'output directory')
  mkdirSync(outputDir, { recursive: true })
  const outputs = Object.values(BOOTSTRAP_BUNDLE_NAMES).map((name) => resolve(outputDir, name))
  const inputs = [
    get('--manifest'),
    get('--launcher'),
    get('--uninstaller'),
    get('--private-key')
  ].map((path) => normalizedPath(absolute(path, 'input')))
  if (new Set([...outputs.map(normalizedPath), ...inputs]).size !== outputs.length + inputs.length)
    fail('input and bundle output paths must be distinct')
  const privateKey = createPrivateKey(read(get('--private-key'), 'private key', 64 * 1024))
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('private key must be Ed25519')
  const expected = values.get('--expected-public-key-base64')
  if (expected) {
    const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' })
    if (
      publicJwk.kty !== 'OKP' ||
      publicJwk.crv !== 'Ed25519' ||
      !publicJwk.x ||
      Buffer.from(publicJwk.x, 'base64url').toString('base64') !== expected
    )
      fail('private key does not match expected public key')
  }
  const built = buildDescriptor({
    manifest: get('--manifest'),
    launcher: get('--launcher'),
    uninstaller: get('--uninstaller'),
    channel: get('--channel'),
    buildId: get('--build-id'),
    runtimeId: get('--runtime-id'),
    launcherVersion: get('--launcher-version'),
    uninstallerVersion: get('--uninstaller-version'),
    keyId: get('--key-id')
  })
  const signature = sign(null, built.bytes, privateKey)
  if (signature.length !== 64) fail('unexpected Ed25519 signature size')
  const publications: Array<[string, Buffer]> = [
    [BOOTSTRAP_BUNDLE_NAMES.launcher, built.launcherBytes],
    [BOOTSTRAP_BUNDLE_NAMES.uninstaller, built.uninstallerBytes],
    [BOOTSTRAP_BUNDLE_NAMES.descriptor, built.bytes],
    [BOOTSTRAP_BUNDLE_NAMES.signature, signature]
  ]
  for (const [name, bytes] of publications) publishExactNoReplace(resolve(outputDir, name), bytes)
}
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'bootstrap descriptor failed'}\n`
    )
    process.exitCode = 1
  }
}
