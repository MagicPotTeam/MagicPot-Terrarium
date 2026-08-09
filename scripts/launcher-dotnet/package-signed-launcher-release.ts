import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageJson = require('../../package.json') as { version?: unknown }
const FALLBACK_VERSION = typeof packageJson.version === 'string' ? packageJson.version : ''
const CHANNELS = new Set(['stable', 'beta', 'nightly'])
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA = /^[0-9a-f]{40}$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const BUILD_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{7}$/
const RUNTIME_ID = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/
const WINDOWS_RESERVED =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/i
const DEFAULT_RUNTIME_RELATIVE_PATH = 'resources/vendor/comfyui/python_embeded'
const ENV: Record<string, string> = {
  '--channel': 'LAUNCHER_CHANNEL',
  '--version': 'LAUNCHER_VERSION',
  '--build-id': 'LAUNCHER_BUILD_ID',
  '--commit-sha': 'LAUNCHER_COMMIT_SHA',
  '--app-dir': 'LAUNCHER_APP_DIR',
  '--runtime-dir': 'LAUNCHER_RUNTIME_DIR',
  '--runtime-relative-path': 'LAUNCHER_RUNTIME_RELATIVE_PATH',
  '--base-url': 'LAUNCHER_BASE_URL',
  '--output-dir': 'LAUNCHER_OUTPUT_DIR',
  '--private-key': 'LAUNCHER_PRIVATE_KEY_FILE',
  '--key-id': 'LAUNCHER_KEY_ID',
  '--expected-public-key-base64': 'LAUNCHER_EXPECTED_PUBLIC_KEY_BASE64',
  '--platform': 'LAUNCHER_PLATFORM',
  '--abi': 'LAUNCHER_ABI',
  '--runtime-id': 'LAUNCHER_RUNTIME_ID',
  '--generated-at': 'LAUNCHER_GENERATED_AT',
  '--published-at': 'LAUNCHER_PUBLISHED_AT',
  '--release-notes-url': 'LAUNCHER_RELEASE_NOTES_URL',
  '--minimum-launcher-version': 'LAUNCHER_MINIMUM_VERSION',
  '--app-entrypoint': 'LAUNCHER_APP_ENTRYPOINT',
  '--python-entrypoint': 'LAUNCHER_PYTHON_ENTRYPOINT',
  '--comfyui-entrypoint': 'LAUNCHER_COMFYUI_ENTRYPOINT'
}
export interface ReleasePlan {
  channel: 'stable' | 'beta' | 'nightly'
  version: string
  buildId: string
  commitSha: string
  appDir: string
  runtimeDir: string
  runtimeRelativePath: string
  baseUrl: string
  outputDir: string
  privateKey: string
  keyId: string
  expectedPublicKeyBase64?: string
  platform: 'win32'
  abi: 'x64'
  runtimeId: string
  generatedAt: string
  publishedAt: string
  releaseNotesUrl: string
  minimumLauncherVersion: string
  appEntrypoint: string
  pythonEntrypoint: string
  comfyuiEntrypoint: string
  names: { app: string; runtime: string; unsignedManifest: string; manifest: string; index: string }
}
function fail(message: string): never {
  throw new Error(`launcher release packaging rejected: ${message}`)
}
export function isValidSemanticVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 127 && SEMVER.test(value)
}
export function isValidBuildId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = BUILD_ID.exec(value)
  if (!match) return false
  const [, year, month, day, hour, minute, second] = match
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
  )
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second)
  )
}
export function isValidRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && RUNTIME_ID.test(value) && !value.includes('..')
}
const hasInvalidWindowsFilenameChar = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32 || ':<>"|?*'.includes(character))
export function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 260 ||
    value.normalize('NFC') !== value ||
    isAbsolute(value) ||
    value.includes('\\') ||
    hasInvalidWindowsFilenameChar(value)
  )
    return false
  return value
    .split('/')
    .every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !/[ .]$/.test(part) &&
        !WINDOWS_RESERVED.test(part)
    )
}
function timestamp(value: string, label: string): string {
  if (!UTC.test(value) || Number.isNaN(Date.parse(value))) fail(`${label} must be a UTC timestamp`)
  return value
}
function directory(path: string, label: string): string {
  if (!isAbsolute(path)) fail(`${label} must be absolute`)
  const resolved = resolve(path)
  let current = resolved
  while (true) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) fail(`${label} must not traverse a symlink or reparse point`)
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  const stat = lstatSync(resolved)
  if (!stat.isDirectory()) fail(`${label} must be a real directory`)
  return resolved
}
function file(path: string, label: string): string {
  if (!isAbsolute(path)) fail(`${label} must be absolute`)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    fail(`${label} must be a single-link regular file`)
  return resolve(path)
}
function https(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail(`${label} must be an absolute HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    fail(`${label} must be credential-free HTTPS without a fragment`)
  return url
}
function value(values: Map<string, string>, option: string, required = true): string | undefined {
  const found = values.get(option) ?? process.env[ENV[option]!]
  if (required && !found) fail(`missing ${option} (or ${ENV[option]})`)
  return found
}
function normalized(path: string): string {
  const result = resolve(path)
  return process.platform === 'win32' ? result.toLowerCase() : result
}
export function planRelease(argv: readonly string[]): ReleasePlan {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const option = argv[i],
      item = argv[i + 1]
    if (!option || !Object.hasOwn(ENV, option)) fail('unknown option')
    if (!item || item.startsWith('--')) fail(`missing value for ${option}`)
    if (values.has(option)) fail(`duplicate ${option}`)
    values.set(option, item)
  }
  const channel = value(values, '--channel')!
  if (!CHANNELS.has(channel)) fail('channel must be stable, beta, or nightly')
  const version = value(values, '--version', false) || FALLBACK_VERSION
  if (!isValidSemanticVersion(version)) fail('version must be SemVer')
  const buildId = value(values, '--build-id')!,
    commitSha = value(values, '--commit-sha')!
  if (
    !isValidBuildId(buildId) ||
    !SHA.test(commitSha) ||
    buildId.slice(-7) !== commitSha.slice(0, 7)
  )
    fail('build ID and commit SHA do not form a valid identity')
  const platform = value(values, '--platform')!,
    abi = value(values, '--abi')!
  if (platform !== 'win32' || abi !== 'x64') fail('only platform=win32 and abi=x64 are supported')
  const runtimeId = value(values, '--runtime-id')!
  if (!isValidRuntimeId(runtimeId)) fail('runtime ID is invalid')
  const generatedAt = timestamp(value(values, '--generated-at')!, 'generated-at'),
    publishedAt = timestamp(value(values, '--published-at', false) ?? generatedAt, 'published-at')
  if (Date.parse(publishedAt) < Date.parse(generatedAt))
    fail('published-at must not predate generated-at')
  const appEntrypoint = value(values, '--app-entrypoint', false) ?? 'magicpot.exe',
    pythonEntrypoint = value(values, '--python-entrypoint', false) ?? 'python.exe',
    comfyuiEntrypoint = value(values, '--comfyui-entrypoint')!
  if (
    !isSafeRelativePath(appEntrypoint) ||
    !/\.exe$/i.test(appEntrypoint) ||
    !isSafeRelativePath(pythonEntrypoint) ||
    !/\.exe$/i.test(pythonEntrypoint) ||
    !isSafeRelativePath(comfyuiEntrypoint) ||
    !/\.py$/i.test(comfyuiEntrypoint)
  )
    fail('one or more entrypoints are invalid')
  const base = https(value(values, '--base-url')!, 'base-url')
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const releaseNotesUrl = value(values, '--release-notes-url', false) ?? new URL('./', base).href
  https(releaseNotesUrl, 'release-notes-url')
  const minimumLauncherVersion = value(values, '--minimum-launcher-version')!
  if (!isValidSemanticVersion(minimumLauncherVersion))
    fail('minimum launcher version must be SemVer')
  const keyId = value(values, '--key-id')!
  if (!KEY_ID.test(keyId) || keyId.includes('..')) fail('key ID is invalid')
  const runtimeRelativePath =
    value(values, '--runtime-relative-path', false) ?? DEFAULT_RUNTIME_RELATIVE_PATH
  if (!isSafeRelativePath(runtimeRelativePath))
    fail('runtime-relative-path must be a safe relative path')
  const appDir = directory(value(values, '--app-dir')!, 'app-dir'),
    runtimeDir = directory(value(values, '--runtime-dir')!, 'runtime-dir')
  if (normalized(runtimeDir) !== normalized(join(appDir, ...runtimeRelativePath.split('/'))))
    fail('runtime-dir must equal app-dir/runtime-relative-path')
  const safeVersion = version.replaceAll('+', '_'),
    stem = `magicpot-launcher-${channel}-${safeVersion}-${buildId}-win32-x64`
  const outputDir = value(values, '--output-dir')!
  if (!isAbsolute(outputDir)) fail('output-dir must be absolute')
  const plan: ReleasePlan = {
    channel: channel as ReleasePlan['channel'],
    version,
    buildId,
    commitSha,
    appDir,
    runtimeDir,
    runtimeRelativePath,
    baseUrl: base.href,
    outputDir: resolve(outputDir),
    privateKey: file(value(values, '--private-key')!, 'private-key'),
    keyId,
    expectedPublicKeyBase64: value(values, '--expected-public-key-base64', false),
    platform: 'win32',
    abi: 'x64',
    runtimeId,
    generatedAt,
    publishedAt,
    releaseNotesUrl,
    minimumLauncherVersion,
    appEntrypoint,
    pythonEntrypoint,
    comfyuiEntrypoint,
    names: {
      app: `${stem}-app.zip`,
      runtime: `${stem}-runtime.zip`,
      unsignedManifest: `magicpot-launcher-${channel}-win32-x64-channel.unsigned.json`,
      manifest: `magicpot-launcher-${channel}-win32-x64-channel.json`,
      index: `${stem}-release-index.json`
    }
  }
  if (
    new Set([plan.appDir, plan.runtimeDir, plan.outputDir, plan.privateKey].map(normalized))
      .size !== 4
  )
    fail('input, output, and private key paths must differ')
  return plan
}
function copyAppWithoutRuntime(source: string, destination: string, excluded: string): void {
  const walk = (from: string, to: string): void => {
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) fail('app input contains symlink or reparse point')
    if (stat.isDirectory()) {
      mkdirSync(to, { mode: 0o700 })
      for (const entry of readdirSync(from)) {
        const child = join(from, entry)
        if (normalized(child) !== normalized(excluded)) walk(child, join(to, entry))
      }
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) fail('app input contains hardlink')
      copyFileSync(from, to)
    } else fail('app input contains special file')
  }
  walk(source, destination)
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
}
export async function run(argv: readonly string[]): Promise<void> {
  const plan = planRelease(argv)
  mkdirSync(plan.outputDir, { recursive: true })
  directory(plan.outputDir, 'output-dir')
  const stagingRoot = mkdtempSync(join(tmpdir(), 'magicpot-launcher-release-')),
    stagedApp = join(stagingRoot, 'app')
  const app = join(plan.outputDir, plan.names.app),
    runtime = join(plan.outputDir, plan.names.runtime),
    appIdentity = join(plan.outputDir, '.app-identity.json'),
    runtimeIdentity = join(plan.outputDir, '.runtime-identity.json'),
    descriptor = join(plan.outputDir, '.release-descriptor.json'),
    sources = join(plan.outputDir, '.release-sources.json'),
    unsigned = join(plan.outputDir, plan.names.unsignedManifest),
    signed = join(plan.outputDir, plan.names.manifest)
  const transients = [appIdentity, runtimeIdentity, descriptor, sources]
  try {
    const [{ run: packArtifact }, { run: buildManifest }, { run: signManifest }] =
      await Promise.all([
        import('./pack-release-artifact.ts'),
        import('./build-channel-manifest.ts'),
        import('./sign-channel-manifest.ts')
      ])
    copyAppWithoutRuntime(plan.appDir, stagedApp, plan.runtimeDir)
    if (
      relative(stagedApp, join(stagedApp, ...plan.runtimeRelativePath.split('/')))
        .split(sep)
        .join('/') !== plan.runtimeRelativePath
    )
      fail('runtime exclusion path is invalid')
    writeJson(appIdentity, {
      version: plan.version,
      buildId: plan.buildId,
      commitSha: plan.commitSha,
      runtimeId: plan.runtimeId,
      platform: plan.platform,
      arch: plan.abi,
      entrypoint: plan.appEntrypoint,
      createdAt: plan.generatedAt
    })
    writeJson(runtimeIdentity, {
      runtimeId: plan.runtimeId,
      platform: plan.platform,
      arch: plan.abi,
      pythonEntrypoint: plan.pythonEntrypoint,
      comfyuiEntrypoint: plan.comfyuiEntrypoint,
      createdAt: plan.generatedAt
    })
    await packArtifact([
      '--kind',
      'app',
      '--input-dir',
      stagedApp,
      '--output',
      app,
      '--identity',
      appIdentity
    ])
    await packArtifact([
      '--kind',
      'runtime',
      '--input-dir',
      plan.runtimeDir,
      '--output',
      runtime,
      '--identity',
      runtimeIdentity
    ])
    const base = new URL(plan.baseUrl),
      prefix = base.pathname.split('/releases/download/')[0]
    if (!prefix || !base.pathname.includes('/releases/download/'))
      fail('base-url must be under a trusted /releases/download/ path')
    writeJson(descriptor, {
      schema: 1,
      releaseNotesUrl: plan.releaseNotesUrl,
      minimumLauncherVersion: plan.minimumLauncherVersion,
      publishedAt: plan.publishedAt,
      app: { archive: app, url: new URL(plan.names.app, base).href },
      runtime: { archive: runtime, url: new URL(plan.names.runtime, base).href }
    })
    writeJson(sources, {
      schema: 1,
      trustedSources: [{ origin: base.origin, repoPathPrefix: prefix }]
    })
    await buildManifest([
      '--descriptor',
      descriptor,
      '--output',
      unsigned,
      '--channel',
      plan.channel,
      '--generated-at',
      plan.generatedAt,
      '--release-source-config',
      sources
    ])
    const signArgs = [
      '--input',
      unsigned,
      '--output',
      signed,
      '--private-key',
      plan.privateKey,
      '--key-id',
      plan.keyId
    ]
    if (plan.expectedPublicKeyBase64)
      signArgs.push('--expected-public-key-base64', plan.expectedPublicKeyBase64)
    signManifest(signArgs)
    const manifest = JSON.parse(readFileSync(signed, 'utf8')) as {
      releases: Array<{
        artifacts: {
          app: { sha256: string; size: number; url: string }
          runtime?: { sha256: string; size: number; url: string }
        }
      }>
    }
    const release = manifest.releases[0]!
    writeJson(join(plan.outputDir, plan.names.index), {
      schema: 1,
      channel: plan.channel,
      version: plan.version,
      buildId: plan.buildId,
      commitSha: plan.commitSha,
      platform: plan.platform,
      abi: plan.abi,
      runtimeId: plan.runtimeId,
      generatedAt: plan.generatedAt,
      manifest: plan.names.manifest,
      artifacts: {
        app: { file: basename(app), ...release.artifacts.app },
        runtime: { file: basename(runtime), ...release.artifacts.runtime }
      }
    })
    process.stdout.write(
      `packaged signed launcher release channel=${plan.channel} buildId=${plan.buildId}\n`
    )
  } finally {
    for (const transient of transients) {
      try {
        unlinkSync(transient)
      } catch {
        /* absent or already cleaned */
      }
    }
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url)))
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'launcher release packaging failed'}\n`
    )
  })
