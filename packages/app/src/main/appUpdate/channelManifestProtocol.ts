import { verify, type KeyLike } from 'node:crypto'

export const CHANNEL_MANIFEST_SCHEMA = 1 as const
export const CHANNEL_MANIFEST_KEY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/
export const DEFAULT_GITHUB_RELEASE_SOURCE = {
  origin: 'https://github.com',
  repoPathPrefix: '/MagicPotTeam/MagicPot-Terrarium-Releases'
} as const

export type UpdateChannel = 'stable' | 'beta' | 'nightly'
export type ArtifactPlatform = 'win32'
export type ArtifactArch = 'x64'

interface ArtifactBaseV1 {
  platform: ArtifactPlatform
  arch: ArtifactArch
  url: string
  sha256: string
  size: number
  unpackedSize: number
  createdAt: string
}

export interface AppArtifactV1 extends ArtifactBaseV1 {
  kind: 'app'
  version: string
  buildId: string
  commitSha: string
  runtimeId: string
  entrypoint: string
}

export interface RuntimeArtifactV1 extends ArtifactBaseV1 {
  kind: 'runtime'
  runtimeId: string
  entrypoint: string
}

export interface ChannelReleaseV1 {
  version: string
  buildId: string
  commitSha: string
  publishedAt: string
  releaseNotesUrl: string
  minimumLauncherVersion: string
  artifacts: { app: AppArtifactV1; runtime?: RuntimeArtifactV1 }
}

export interface ManifestSignatureV1 {
  algorithm: 'ed25519'
  keyId: string
  value: string
}

export interface ChannelManifestV1 {
  schema: 1
  channel: UpdateChannel
  generatedAt: string
  releases: ChannelReleaseV1[]
  signature: ManifestSignatureV1
}

export interface TrustedReleaseSource {
  origin: string
  repoPathPrefix: string
}

export interface ParseChannelManifestOptions {
  expectedChannel: UpdateChannel
  trustedSources?: readonly TrustedReleaseSource[]
}

export interface SelectedArtifactsV1 {
  release: ChannelReleaseV1
  app: AppArtifactV1
  runtime: RuntimeArtifactV1
}

export class ChannelManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelManifestError'
  }
}

const BUILD_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([0-9a-f]{7})$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ID = CHANNEL_MANIFEST_KEY_ID_PATTERN
const VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256 = /^[0-9a-f]{64}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const MAX_ARTIFACT_SIZE = 1024 ** 4
const MAX_RELEASES = 1_000

function fail(path: string, reason: string): never {
  throw new ChannelManifestError(`${path}: ${reason}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(path, 'expected object')
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  path: string
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required)
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path, `missing field ${key}`)
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(path, `unknown field ${key}`)
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected string')
  return value
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_ARTIFACT_SIZE
  )
    fail(path, 'expected positive safe integer within size limit')
  return value as number
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path)
  const match = ISO_UTC.exec(result)
  if (!match) fail(path, 'expected UTC ISO-8601 timestamp')
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    fail(path, 'invalid calendar timestamp')
  return result
}

function identifier(value: unknown, path: string): string {
  const result = string(value, path)
  if (!ID.test(result) || result.includes('..')) fail(path, 'invalid identifier')
  return result
}

function version(value: unknown, path: string): string {
  const result = string(value, path)
  if (!VERSION.test(result) || result.length > 128) fail(path, 'invalid semantic version')
  return result
}

function buildId(value: unknown, path: string): string {
  const result = string(value, path)
  const match = BUILD_ID.exec(result)
  if (!match) fail(path, 'invalid build ID')
  timestamp(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`, path)
  return result
}

function commitSha(value: unknown, path: string): string {
  const result = string(value, path)
  if (!COMMIT_SHA.test(result)) fail(path, 'expected 40 lowercase hexadecimal characters')
  return result
}

function entrypoint(value: unknown, path: string): string {
  const result = string(value, path)
  if (
    result.length === 0 ||
    result.length > 260 ||
    /^(?:[A-Za-z]:|[\\/])/.test(result) ||
    [...result].some((character) => character.charCodeAt(0) <= 0x1f) ||
    /[:<>"|?*]/.test(result) ||
    result
      .split(/[\\/]/)
      .some((part) => !part || part === '.' || part === '..' || /[ .]$/.test(part))
  )
    fail(path, 'unsafe relative entrypoint')
  return result
}

function normalizedSources(options: ParseChannelManifestOptions): TrustedReleaseSource[] {
  const sources = options.trustedSources ?? [DEFAULT_GITHUB_RELEASE_SOURCE]
  if (sources.length === 0) fail('options.trustedSources', 'must not be empty')
  return sources.map((source, index) => {
    let origin: URL
    try {
      origin = new URL(source.origin)
    } catch {
      return fail(`options.trustedSources[${index}].origin`, 'invalid URL origin')
    }
    if (origin.protocol !== 'https:' || origin.origin !== source.origin || origin.pathname !== '/')
      fail(`options.trustedSources[${index}].origin`, 'expected an HTTPS origin without path')
    const prefix = source.repoPathPrefix.replace(/\/$/, '')
    if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(prefix))
      fail(`options.trustedSources[${index}].repoPathPrefix`, 'expected /owner/repository')
    return { origin: origin.origin, repoPathPrefix: prefix }
  })
}

function trustedReleaseUrl(
  value: unknown,
  sources: readonly TrustedReleaseSource[],
  path: string
): string {
  const result = string(value, path)
  let url: URL
  try {
    url = new URL(result)
  } catch {
    return fail(path, 'invalid URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    fail(path, 'expected HTTPS URL without credentials or fragment')
  const trusted = sources.some(
    (source) =>
      url.origin === source.origin &&
      (url.pathname.startsWith(`${source.repoPathPrefix}/releases/download/`) ||
        url.pathname.startsWith(`${source.repoPathPrefix}/releases/tag/`))
  )
  if (!trusted) fail(path, 'URL is outside trusted GitHub release repository')
  return result
}

function parseBaseArtifact(
  input: Record<string, unknown>,
  sources: readonly TrustedReleaseSource[],
  path: string
): ArtifactBaseV1 {
  if (input.platform !== 'win32') fail(`${path}.platform`, 'unsupported platform')
  if (input.arch !== 'x64') fail(`${path}.arch`, 'unsupported architecture')
  const hash = string(input.sha256, `${path}.sha256`)
  if (!SHA256.test(hash)) fail(`${path}.sha256`, 'expected 64 lowercase hexadecimal characters')
  return {
    platform: 'win32',
    arch: 'x64',
    url: trustedReleaseUrl(input.url, sources, `${path}.url`),
    sha256: hash,
    size: positiveSafeInteger(input.size, `${path}.size`),
    unpackedSize: positiveSafeInteger(input.unpackedSize, `${path}.unpackedSize`),
    createdAt: timestamp(input.createdAt, `${path}.createdAt`)
  }
}

function parseAppArtifact(
  value: unknown,
  sources: readonly TrustedReleaseSource[],
  path: string
): AppArtifactV1 {
  const input = record(value, path)
  exactKeys(
    input,
    [
      'kind',
      'version',
      'buildId',
      'commitSha',
      'runtimeId',
      'platform',
      'arch',
      'url',
      'sha256',
      'size',
      'unpackedSize',
      'entrypoint',
      'createdAt'
    ],
    [],
    path
  )
  if (input.kind !== 'app') fail(`${path}.kind`, 'expected app')
  const result: AppArtifactV1 = {
    kind: 'app',
    version: version(input.version, `${path}.version`),
    buildId: buildId(input.buildId, `${path}.buildId`),
    commitSha: commitSha(input.commitSha, `${path}.commitSha`),
    runtimeId: identifier(input.runtimeId, `${path}.runtimeId`),
    entrypoint: entrypoint(input.entrypoint, `${path}.entrypoint`),
    ...parseBaseArtifact(input, sources, path)
  }
  if (!/\.exe$/i.test(result.entrypoint))
    fail(`${path}.entrypoint`, 'app entrypoint must be an executable')
  if (result.buildId.slice(-7) !== result.commitSha.slice(0, 7))
    fail(path, 'buildId and commitSha do not match')
  return result
}

function parseRuntimeArtifact(
  value: unknown,
  sources: readonly TrustedReleaseSource[],
  path: string
): RuntimeArtifactV1 {
  const input = record(value, path)
  exactKeys(
    input,
    [
      'kind',
      'runtimeId',
      'platform',
      'arch',
      'url',
      'sha256',
      'size',
      'unpackedSize',
      'entrypoint',
      'createdAt'
    ],
    [],
    path
  )
  if (input.kind !== 'runtime') fail(`${path}.kind`, 'expected runtime')
  return {
    kind: 'runtime',
    runtimeId: identifier(input.runtimeId, `${path}.runtimeId`),
    entrypoint: entrypoint(input.entrypoint, `${path}.entrypoint`),
    ...parseBaseArtifact(input, sources, path)
  }
}

function parseRelease(
  value: unknown,
  sources: readonly TrustedReleaseSource[],
  path: string
): ChannelReleaseV1 {
  const input = record(value, path)
  exactKeys(
    input,
    [
      'version',
      'buildId',
      'commitSha',
      'publishedAt',
      'releaseNotesUrl',
      'minimumLauncherVersion',
      'artifacts'
    ],
    [],
    path
  )
  const artifacts = record(input.artifacts, `${path}.artifacts`)
  exactKeys(artifacts, ['app'], ['runtime'], `${path}.artifacts`)
  const result: ChannelReleaseV1 = {
    version: version(input.version, `${path}.version`),
    buildId: buildId(input.buildId, `${path}.buildId`),
    commitSha: commitSha(input.commitSha, `${path}.commitSha`),
    publishedAt: timestamp(input.publishedAt, `${path}.publishedAt`),
    releaseNotesUrl: trustedReleaseUrl(input.releaseNotesUrl, sources, `${path}.releaseNotesUrl`),
    minimumLauncherVersion: version(input.minimumLauncherVersion, `${path}.minimumLauncherVersion`),
    artifacts: {
      app: parseAppArtifact(artifacts.app, sources, `${path}.artifacts.app`),
      ...(artifacts.runtime === undefined
        ? {}
        : {
            runtime: parseRuntimeArtifact(artifacts.runtime, sources, `${path}.artifacts.runtime`)
          })
    }
  }
  const app = result.artifacts.app
  if (
    app.version !== result.version ||
    app.buildId !== result.buildId ||
    app.commitSha !== result.commitSha
  )
    fail(path, 'release and app artifact identities do not match')
  if (result.buildId.slice(-7) !== result.commitSha.slice(0, 7))
    fail(path, 'buildId and commitSha do not match')
  if (result.artifacts.runtime && result.artifacts.runtime.runtimeId !== app.runtimeId)
    fail(path, 'app and runtime artifact runtimeId do not match')
  return result
}

function parseSignature(value: unknown): ManifestSignatureV1 {
  const input = record(value, 'signature')
  exactKeys(input, ['algorithm', 'keyId', 'value'], [], 'signature')
  if (input.algorithm !== 'ed25519') fail('signature.algorithm', 'expected ed25519')
  const signatureValue = string(input.value, 'signature.value')
  if (!BASE64.test(signatureValue) || Buffer.from(signatureValue, 'base64').length !== 64)
    fail('signature.value', 'expected a canonical base64 Ed25519 signature')
  if (Buffer.from(signatureValue, 'base64').toString('base64') !== signatureValue)
    fail('signature.value', 'non-canonical base64')
  return {
    algorithm: 'ed25519',
    keyId: identifier(input.keyId, 'signature.keyId'),
    value: signatureValue
  }
}

export function parseChannelManifestV1(
  input: string | unknown,
  options: ParseChannelManifestOptions
): ChannelManifestV1 {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown
    } catch {
      fail('$', 'invalid JSON')
    }
  }
  const source = record(value, '$')
  exactKeys(source, ['schema', 'channel', 'generatedAt', 'releases', 'signature'], [], '$')
  if (source.schema !== CHANNEL_MANIFEST_SCHEMA) fail('schema', 'unsupported schema')
  if (!['stable', 'beta', 'nightly'].includes(source.channel as string))
    fail('channel', 'unsupported channel')
  if (source.channel !== options.expectedChannel)
    fail('channel', 'does not match requested channel')
  if (!Array.isArray(source.releases) || source.releases.length > MAX_RELEASES)
    fail('releases', `expected an array of at most ${MAX_RELEASES} releases`)
  const sources = normalizedSources(options)
  const releases = source.releases.map((release, index) =>
    parseRelease(release, sources, `releases[${index}]`)
  )
  const buildIds = new Set<string>()
  const versions = new Map<string, string>()
  const runtimeIds = new Set<string>()
  for (const release of releases) {
    if (buildIds.has(release.buildId)) fail('releases', `duplicate buildId ${release.buildId}`)
    buildIds.add(release.buildId)
    const existingBuild = versions.get(release.version)
    if (existingBuild && existingBuild !== release.buildId)
      fail('releases', `version ${release.version} maps to conflicting build IDs`)
    versions.set(release.version, release.buildId)
    const runtime = release.artifacts.runtime
    if (runtime) {
      if (runtimeIds.has(runtime.runtimeId))
        fail('releases', `duplicate runtimeId ${runtime.runtimeId}`)
      runtimeIds.add(runtime.runtimeId)
    }
  }
  return {
    schema: 1,
    channel: source.channel as UpdateChannel,
    generatedAt: timestamp(source.generatedAt, 'generatedAt'),
    releases,
    signature: parseSignature(source.signature)
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('$', 'canonical JSON does not support non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  fail('$', 'value is not JSON-serializable')
}

export function channelManifestSigningPayload(manifest: ChannelManifestV1): Buffer {
  const { signature: _signature, ...unsigned } = manifest
  return Buffer.from(canonicalJson(unsigned), 'utf8')
}

export function verifyChannelManifestSignature(
  manifest: ChannelManifestV1,
  publicKeys: Readonly<Record<string, KeyLike>>
): boolean {
  const key = publicKeys[manifest.signature.keyId]
  if (!key) return false
  try {
    return verify(
      null,
      channelManifestSigningPayload(manifest),
      key,
      Buffer.from(manifest.signature.value, 'base64')
    )
  } catch {
    return false
  }
}

export interface SemanticVersionV1 {
  core: [number, number, number]
  prerelease: string[]
}

export function parseSemanticVersionV1(value: string): SemanticVersionV1 | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value
    )
  if (!match) return undefined
  const core = match.slice(1, 4).map(Number) as [number, number, number]
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined
  return { core, prerelease: match[4]?.split('.') ?? [] }
}

function compareNumericIdentifiers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, '') || '0'
  const normalizedRight = right.replace(/^0+/, '') || '0'
  if (normalizedLeft.length !== normalizedRight.length)
    return normalizedLeft.length > normalizedRight.length ? 1 : -1
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1
}

export function compareSemanticVersionsV1(left: string, right: string): number | undefined {
  const a = parseSemanticVersionV1(left)
  const b = parseSemanticVersionV1(right)
  if (!a || !b) return undefined
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const order = compareNumericIdentifiers(leftPart, rightPart)
      if (order !== 0) return order
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export type ReleasePredicateV1 = (release: ChannelReleaseV1) => boolean

export function selectLatestArtifactsV1(
  manifest: ChannelManifestV1,
  platform: ArtifactPlatform = 'win32',
  arch: ArtifactArch = 'x64',
  predicate: ReleasePredicateV1 = () => true
): SelectedArtifactsV1 | undefined {
  const runtimes = new Map<string, RuntimeArtifactV1>()
  for (const release of manifest.releases) {
    const runtime = release.artifacts.runtime
    if (runtime && runtime.platform === platform && runtime.arch === arch)
      runtimes.set(runtime.runtimeId, runtime)
  }
  const compatible = manifest.releases
    .map((release) => ({ release, version: parseSemanticVersionV1(release.version) }))
    .filter(
      (item): item is { release: ChannelReleaseV1; version: SemanticVersionV1 } =>
        item.version !== undefined &&
        predicate(item.release) &&
        item.release.artifacts.app.platform === platform &&
        item.release.artifacts.app.arch === arch
    )
    .sort((left, right) => {
      const precedence = compareSemanticVersionsV1(right.release.version, left.release.version) ?? 0
      return (
        precedence ||
        Date.parse(right.release.publishedAt) - Date.parse(left.release.publishedAt) ||
        (right.release.buildId > left.release.buildId
          ? 1
          : right.release.buildId < left.release.buildId
            ? -1
            : 0)
      )
    })
  for (const { release } of compatible) {
    const runtime = runtimes.get(release.artifacts.app.runtimeId)
    if (runtime) return { release, app: release.artifacts.app, runtime }
  }
  return undefined
}
