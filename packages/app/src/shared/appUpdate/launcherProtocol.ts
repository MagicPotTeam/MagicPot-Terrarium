export const LAUNCHER_PROTOCOL_SCHEMA = 1 as const
export const MAX_RETAIN_APP_VERSIONS = 100
export const MAX_LAUNCH_ATTEMPT = 10_000
export const MAX_UNPACKED_SIZE = 1024 ** 4
export const LAUNCHER_COMMAND_FILE = 'launcher-command.json'
export const LAUNCHER_COMMAND_RESULT_FILE = 'launcher-command-result.json'
export const MAX_LAUNCHER_COMMAND_AGE_MS = 24 * 60 * 60 * 1_000
export const DEFAULT_RETAIN_NIGHTLY_VERSIONS = 3

export type LauncherCommand = 'check-now' | 'install-latest' | 'rollback' | 'remove-version'
export interface LauncherCommandRequestV1 {
  schema: 1
  requestId: string
  command: LauncherCommand
  requestedAt: string
  buildId?: string
}
export interface LauncherCommandReceipt {
  accepted: boolean
  command: LauncherCommand
  requestId?: string
  requestedAt?: string
  error?: string
}
export type LauncherCommandResultStatus = 'completed' | 'failed' | 'rejected'
export interface LauncherCommandResultV1 {
  schema: 1
  requestId: string
  command: LauncherCommand
  status: LauncherCommandResultStatus
  completedAt: string
  error?: string
}

export type UpdateMode = 'manual' | 'notify-on-launch' | 'auto-on-launch'
export type UpdateChannel = 'stable' | 'beta' | 'nightly'
export type LaunchStatus = 'pending' | 'healthy' | 'failed'
export type LauncherPlatform = 'win32'
export type LauncherArch = 'x64'

export interface LauncherSettingsV1 {
  schema: 1
  updateMode: UpdateMode
  channel: UpdateChannel
  retainAppVersions: number
  retainNightlyVersions?: number
  allowPrerelease: boolean
}

export type NormalizedLauncherSettingsV1 = LauncherSettingsV1 & {
  retainNightlyVersions: number
}

export interface ActivePointerV1 {
  schema: 1
  activeBuildId: string
  activeRuntimeId: string
  previousBuildId?: string
  previousRuntimeId?: string
  activatedAt: string
}

export interface InstalledFileV1 {
  path: string
  size: number
  sha256: string
}

export interface InstalledAppManifestV1 {
  schema: 1
  kind: 'magicpot-app'
  version: string
  buildId: string
  commitSha: string
  platform: LauncherPlatform
  arch: LauncherArch
  runtimeId: string
  entrypoint: string
  createdAt: string
  unpackedSize: number
  files?: InstalledFileV1[]
}

export interface InstalledRuntimeManifestV1 {
  schema: 1
  kind: 'magicpot-runtime'
  runtimeId: string
  platform: LauncherPlatform
  arch: LauncherArch
  createdAt: string
  entrypoints: { python: string; comfyui: string }
  unpackedSize: number
  files?: InstalledFileV1[]
}

export interface LaunchStateV1 {
  schema: 1
  buildId: string
  state: LaunchStatus
  attempt: number
  startedAt: string
}

export class LauncherProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LauncherProtocolError'
  }
}

type Validator<T> = (value: unknown) => value is T

const BUILD_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{7}$/
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const RUNTIME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const VERSION_PATTERN = /^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,126}[0-9A-Za-z])?$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function isActualUtcDateTime(parts: readonly string[]): boolean {
  const [year, month, day, hour, minute, second] = parts.map(Number)
  if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59)
    return false
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  )
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_TIMESTAMP_PATTERN.exec(value)
  return match !== null && isActualUtcDateTime(match.slice(1, 7))
}

function isIntegerInRange(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum
}

export function isValidBuildId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = BUILD_ID_PATTERN.exec(value)
  return match !== null && isActualUtcDateTime(match.slice(1, 7))
}

export function isValidRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && RUNTIME_ID_PATTERN.test(value) && !value.includes('..')
}

export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 260) return false
  if (/^(?:[A-Za-z]:|[\\/])/.test(value)) return false
  if ([...value].some((character) => character.charCodeAt(0) <= 0x1f)) return false
  if (/[:<>"|?*]/.test(value)) return false

  return value.split(/[\\/]/).every((segment) => {
    if (segment.length === 0 || segment === '.' || segment === '..' || /[ .]$/.test(segment))
      return false
    return (
      !WINDOWS_RESERVED_NAME.test(segment) && !WINDOWS_RESERVED_NAME.test(segment.split('.')[0])
    )
  })
}

export function isLauncherCommandRequestV1(value: unknown): value is LauncherCommandRequestV1 {
  if (!isRecord(value)) return false
  const removal = value.command === 'remove-version'
  return (
    hasOnlyKeys(
      value,
      removal
        ? ['schema', 'requestId', 'command', 'requestedAt', 'buildId']
        : ['schema', 'requestId', 'command', 'requestedAt']
    ) &&
    value.schema === LAUNCHER_PROTOCOL_SCHEMA &&
    typeof value.requestId === 'string' &&
    REQUEST_ID_PATTERN.test(value.requestId) &&
    ['check-now', 'install-latest', 'rollback', 'remove-version'].includes(
      value.command as string
    ) &&
    isIsoTimestamp(value.requestedAt) &&
    (!removal || isValidBuildId(value.buildId))
  )
}

export function isLauncherCommandResultV1(value: unknown): value is LauncherCommandResultV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['schema', 'requestId', 'command', 'status', 'completedAt'], ['error']) &&
    value.schema === LAUNCHER_PROTOCOL_SCHEMA &&
    typeof value.requestId === 'string' &&
    REQUEST_ID_PATTERN.test(value.requestId) &&
    ['check-now', 'install-latest', 'rollback', 'remove-version'].includes(
      value.command as string
    ) &&
    ['completed', 'failed', 'rejected'].includes(value.status as string) &&
    isIsoTimestamp(value.completedAt) &&
    (value.error === undefined || (typeof value.error === 'string' && value.error.length > 0))
  )
}

export function isLauncherSettingsV1(value: unknown): value is LauncherSettingsV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ['schema', 'updateMode', 'channel', 'retainAppVersions', 'allowPrerelease'],
      ['retainNightlyVersions']
    )
  )
    return false
  return (
    value.schema === LAUNCHER_PROTOCOL_SCHEMA &&
    ['manual', 'notify-on-launch', 'auto-on-launch'].includes(value.updateMode as string) &&
    ['stable', 'beta', 'nightly'].includes(value.channel as string) &&
    isIntegerInRange(value.retainAppVersions, MAX_RETAIN_APP_VERSIONS) &&
    (value.retainNightlyVersions === undefined ||
      isIntegerInRange(value.retainNightlyVersions, MAX_RETAIN_APP_VERSIONS)) &&
    typeof value.allowPrerelease === 'boolean'
  )
}

export function isActivePointerV1(value: unknown): value is ActivePointerV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ['schema', 'activeBuildId', 'activeRuntimeId', 'activatedAt'],
      ['previousBuildId', 'previousRuntimeId']
    )
  )
    return false
  const previousPairIsComplete =
    (value.previousBuildId === undefined && value.previousRuntimeId === undefined) ||
    (isValidBuildId(value.previousBuildId) && isValidRuntimeId(value.previousRuntimeId))
  return (
    value.schema === LAUNCHER_PROTOCOL_SCHEMA &&
    isValidBuildId(value.activeBuildId) &&
    isValidRuntimeId(value.activeRuntimeId) &&
    previousPairIsComplete &&
    isIsoTimestamp(value.activatedAt)
  )
}

function isInstalledFiles(value: unknown): value is InstalledFileV1[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const paths = new Set<string>()
  for (const file of value) {
    if (
      !isRecord(file) ||
      !hasOnlyKeys(file, ['path', 'size', 'sha256']) ||
      !isSafeRelativePath(file.path) ||
      file.path === 'manifest.json' ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      (file.size as number) > MAX_UNPACKED_SIZE ||
      typeof file.sha256 !== 'string' ||
      !SHA256_PATTERN.test(file.sha256)
    )
      return false
    const normalized = file.path.replaceAll('\\', '/').toLowerCase()
    if (paths.has(normalized)) return false
    paths.add(normalized)
  }
  return true
}

export function isInstalledAppManifestV1(value: unknown): value is InstalledAppManifestV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'schema',
        'kind',
        'version',
        'buildId',
        'commitSha',
        'platform',
        'arch',
        'runtimeId',
        'entrypoint',
        'createdAt',
        'unpackedSize'
      ],
      ['files']
    )
  )
    return false
  const entrypoint = value.entrypoint as string
  const files = value.files
  return (
    value.schema === LAUNCHER_PROTOCOL_SCHEMA &&
    value.kind === 'magicpot-app' &&
    typeof value.version === 'string' &&
    VERSION_PATTERN.test(value.version) &&
    isValidBuildId(value.buildId) &&
    typeof value.commitSha === 'string' &&
    COMMIT_SHA_PATTERN.test(value.commitSha) &&
    value.buildId.slice(-7) === value.commitSha.slice(0, 7) &&
    value.platform === 'win32' &&
    value.arch === 'x64' &&
    isValidRuntimeId(value.runtimeId) &&
    isSafeRelativePath(entrypoint) &&
    /\.exe$/i.test(entrypoint) &&
    isIsoTimestamp(value.createdAt) &&
    isIntegerInRange(value.unpackedSize, MAX_UNPACKED_SIZE) &&
    (files === undefined ||
      (isInstalledFiles(files) &&
        files.reduce((total, file) => total + file.size, 0) === value.unpackedSize &&
        files.some((file) => file.path.replaceAll('\\', '/') === entrypoint.replaceAll('\\', '/'))))
  )
}

export function isInstalledRuntimeManifestV1(value: unknown): value is InstalledRuntimeManifestV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'schema',
        'kind',
        'runtimeId',
        'platform',
        'arch',
        'createdAt',
        'entrypoints',
        'unpackedSize'
      ],
      ['files']
    ) ||
    !isRecord(value.entrypoints) ||
    !hasOnlyKeys(value.entrypoints, ['python', 'comfyui'])
  )
    return false
  const entrypoints = value.entrypoints as InstalledRuntimeManifestV1['entrypoints']
  const files = value.files
  return (
    value.schema === LAUNCHER_PROTOCOL_SCHEMA &&
    value.kind === 'magicpot-runtime' &&
    isValidRuntimeId(value.runtimeId) &&
    value.platform === 'win32' &&
    value.arch === 'x64' &&
    isIsoTimestamp(value.createdAt) &&
    isSafeRelativePath(entrypoints.python) &&
    /\.exe$/i.test(entrypoints.python) &&
    isSafeRelativePath(entrypoints.comfyui) &&
    /\.py$/i.test(entrypoints.comfyui) &&
    isIntegerInRange(value.unpackedSize, MAX_UNPACKED_SIZE) &&
    (files === undefined ||
      (isInstalledFiles(files) &&
        files.reduce((total, file) => total + file.size, 0) === value.unpackedSize &&
        Object.values(entrypoints).every((entrypoint) =>
          files.some((file) => file.path.replaceAll('\\', '/') === entrypoint.replaceAll('\\', '/'))
        )))
  )
}

export function isLaunchStateV1(value: unknown): value is LaunchStateV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['schema', 'buildId', 'state', 'attempt', 'startedAt'])
  )
    return false
  return (
    value.schema === LAUNCHER_PROTOCOL_SCHEMA &&
    isValidBuildId(value.buildId) &&
    ['pending', 'healthy', 'failed'].includes(value.state as string) &&
    isIntegerInRange(value.attempt, MAX_LAUNCH_ATTEMPT) &&
    isIsoTimestamp(value.startedAt)
  )
}

function parseWith<T>(text: string, validator: Validator<T>, label: string): T {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new LauncherProtocolError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!validator(value)) throw new LauncherProtocolError(`${label} does not match schema 1`)
  return value
}

function serializeWith<T>(value: T, validator: Validator<T>, label: string): string {
  if (!validator(value)) throw new LauncherProtocolError(`${label} does not match schema 1`)
  return `${JSON.stringify(value, null, 2)}\n`
}

export const parseLauncherCommandRequest = (text: string): LauncherCommandRequestV1 =>
  parseWith(text, isLauncherCommandRequestV1, 'launcher command request')
export const serializeLauncherCommandRequest = (value: LauncherCommandRequestV1): string =>
  serializeWith(value, isLauncherCommandRequestV1, 'launcher command request')
export const parseLauncherCommandResult = (text: string): LauncherCommandResultV1 =>
  parseWith(text, isLauncherCommandResultV1, 'launcher command result')
export const serializeLauncherCommandResult = (value: LauncherCommandResultV1): string =>
  serializeWith(value, isLauncherCommandResultV1, 'launcher command result')
export const parseLauncherSettings = (text: string): NormalizedLauncherSettingsV1 => {
  const parsed = parseWith(text, isLauncherSettingsV1, 'launcher settings')
  return {
    ...parsed,
    retainNightlyVersions: parsed.retainNightlyVersions ?? DEFAULT_RETAIN_NIGHTLY_VERSIONS
  }
}
export const serializeLauncherSettings = (value: LauncherSettingsV1): string =>
  serializeWith(value, isLauncherSettingsV1, 'launcher settings')
export const parseActivePointer = (text: string): ActivePointerV1 =>
  parseWith(text, isActivePointerV1, 'active pointer')
export const serializeActivePointer = (value: ActivePointerV1): string =>
  serializeWith(value, isActivePointerV1, 'active pointer')
export const parseInstalledAppManifest = (text: string): InstalledAppManifestV1 =>
  parseWith(text, isInstalledAppManifestV1, 'installed app manifest')
export const serializeInstalledAppManifest = (value: InstalledAppManifestV1): string =>
  serializeWith(value, isInstalledAppManifestV1, 'installed app manifest')
export const parseInstalledRuntimeManifest = (text: string): InstalledRuntimeManifestV1 =>
  parseWith(text, isInstalledRuntimeManifestV1, 'installed runtime manifest')
export const serializeInstalledRuntimeManifest = (value: InstalledRuntimeManifestV1): string =>
  serializeWith(value, isInstalledRuntimeManifestV1, 'installed runtime manifest')
export const parseLaunchState = (text: string): LaunchStateV1 =>
  parseWith(text, isLaunchStateV1, 'launch state')
export const serializeLaunchState = (value: LaunchStateV1): string =>
  serializeWith(value, isLaunchStateV1, 'launch state')
