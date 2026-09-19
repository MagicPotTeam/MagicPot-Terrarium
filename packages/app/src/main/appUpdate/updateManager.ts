import fs from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import { type FileHandle } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import type { AppUpdateStatus } from '@shared/api/svcAppUpdate'
import { isValidBuildId, isValidRuntimeId } from '@shared/appUpdate/launcherProtocol'
import { isValidLaunchToken } from './launcherHealth'
import {
  PACKAGE_MODE,
  PACKAGE_VERSION,
  UPDATE_PROVIDER_CHANNEL,
  UPDATE_PROVIDER_OWNER,
  UPDATE_PROVIDER_REPO
} from '@shared/config/viteEnv'

const UPDATE_PROVIDER = {
  type: 'github' as const,
  owner: UPDATE_PROVIDER_OWNER,
  repo: UPDATE_PROVIDER_REPO,
  channel: UPDATE_PROVIDER_CHANNEL
}

const SEMVER_PATTERN =
  '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?'
const WINDOWS_RELEASE_ASSET_PATTERN = new RegExp(
  `^magicpot-(${SEMVER_PATTERN})-(\\d{8}T\\d{6}Z)-(setup\\.exe|win\\.7z)$`
)
const WINDOWS_RELEASE_TAG_PATTERN = /^release\/[^\s/]+$/
const RELEASE_TIMESTAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/i
const UPDATE_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
}
const PART_DIRECTORY_PREFIX = 'magicpot-update-.part-'

type GithubReleaseAsset = {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
  digest?: unknown
}

type GithubRelease = {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

type SemVer = {
  major: string
  minor: string
  patch: string
  prerelease: string[]
}

type ParsedReleaseAsset = {
  kind: 'setup' | 'win'
  version: string
  semver: SemVer
  timestamp: string
  timestampMs: number
  asset: GithubReleaseAsset
}

type AvailableUpdate = {
  version: string
  semver: SemVer
  timestamp: string
  timestampMs: number
  tagName: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
  downloadUrl: string
  assetName: string
  assetSize: number
  assetDigest: string
}

type DownloadedUpdate = AvailableUpdate & {
  filePath: string
  tempDirectory: string
}

const isSupportedPackagedBuild = (): boolean =>
  process.platform === 'win32' &&
  app.isPackaged &&
  (PACKAGE_MODE === 'pure' || PACKAGE_MODE === 'embedded')

const isLauncherManaged = (): boolean => {
  const root = process.env.MAGICPOT_LAUNCHER_ROOT
  return (
    typeof root === 'string' &&
    path.isAbsolute(root) &&
    isValidBuildId(process.env.MAGICPOT_LAUNCH_BUILD_ID) &&
    isValidRuntimeId(process.env.MAGICPOT_LAUNCH_RUNTIME_ID) &&
    isValidLaunchToken(process.env.MAGICPOT_LAUNCH_TOKEN)
  )
}

function getCurrentVersion(): string {
  return PACKAGE_VERSION || app.getVersion()
}

function getCurrentInstallDirectory(): string {
  return path.dirname(app.getPath('exe'))
}

function getDownloadDirectory(): string {
  return path.join(app.getPath('temp'), 'magicpot-updates')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSemVer(value: string): SemVer | undefined {
  const match = new RegExp(`^${SEMVER_PATTERN}$`).exec(value)
  if (!match) return undefined
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function compareNumericStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '')
  const normalizedRight = right.replace(/^0+(?=\d)/, '')
  if (normalizedLeft.length !== normalizedRight.length)
    return normalizedLeft.length - normalizedRight.length
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0
}

function isNumericIdentifier(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value)
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const difference = compareNumericStrings(left[key], right[key])
    if (difference !== 0) return difference
  }

  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftNumeric = isNumericIdentifier(leftIdentifier)
    const rightNumeric = isNumericIdentifier(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumericStrings(leftIdentifier, rightIdentifier)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function parseReleaseTimestamp(
  value: string
): { timestamp: string; timestampMs: number } | undefined {
  const match = RELEASE_TIMESTAMP_PATTERN.exec(value)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match
  const timestampMs = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`)
  if (Number.isNaN(timestampMs)) return undefined
  const date = new Date(timestampMs)
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  )
    return undefined
  return { timestamp: value, timestampMs }
}

function expectedAssetUrl(tagName: string, assetName: string): string {
  return `https://github.com/${UPDATE_PROVIDER.owner}/${UPDATE_PROVIDER.repo}/releases/download/${tagName}/${assetName}`
}

function parseGithubAsset(
  release: GithubRelease,
  asset: GithubReleaseAsset
): ParsedReleaseAsset | undefined {
  if (typeof asset.name !== 'string') return undefined
  const match = WINDOWS_RELEASE_ASSET_PATTERN.exec(asset.name)
  if (!match) return undefined
  const version = match[1]
  const timestamp = match[7]
  const kind = match[8] === 'setup.exe' ? 'setup' : 'win'
  const semver = parseSemVer(version)
  const parsedTimestamp = parseReleaseTimestamp(timestamp)
  if (!semver || !parsedTimestamp) return undefined

  if (typeof release.tag_name !== 'string') return undefined
  if (asset.browser_download_url !== expectedAssetUrl(release.tag_name, asset.name))
    return undefined
  if (!Number.isSafeInteger(asset.size) || (asset.size as number) <= 0) return undefined
  if (typeof asset.digest !== 'string') return undefined
  const digestMatch = SHA256_DIGEST_PATTERN.exec(asset.digest)
  if (!digestMatch) return undefined

  return {
    kind,
    version,
    semver,
    timestamp,
    timestampMs: parsedTimestamp.timestampMs,
    asset: {
      ...asset,
      digest: `sha256:${digestMatch[1].toLowerCase()}`
    }
  }
}

function compareAvailableUpdates(left: AvailableUpdate, right: AvailableUpdate): number {
  const versionDifference = compareSemVer(left.semver, right.semver)
  if (versionDifference !== 0) return versionDifference
  if (left.timestampMs !== right.timestampMs) return left.timestampMs - right.timestampMs
  if (left.tagName !== right.tagName) return left.tagName < right.tagName ? -1 : 1
  if (left.assetName !== right.assetName) return left.assetName < right.assetName ? -1 : 1
  if (left.downloadUrl !== right.downloadUrl) return left.downloadUrl < right.downloadUrl ? -1 : 1
  return 0
}

function candidateFromRelease(release: GithubRelease): AvailableUpdate | undefined {
  if (release.draft !== false || release.prerelease !== false) return undefined
  if (typeof release.tag_name !== 'string' || !WINDOWS_RELEASE_TAG_PATTERN.test(release.tag_name))
    return undefined
  if (!Array.isArray(release.assets)) return undefined

  const parsedAssets = release.assets
    .filter(isRecord)
    .map((asset) => parseGithubAsset(release, asset as GithubReleaseAsset))
    .filter((asset): asset is ParsedReleaseAsset => Boolean(asset))

  const pairs = new Map<string, { setup?: ParsedReleaseAsset; win?: ParsedReleaseAsset }>()
  for (const asset of parsedAssets) {
    const key = `${asset.version}\u0000${asset.timestamp}`
    const pair = pairs.get(key) ?? {}
    if (pair[asset.kind]) continue
    pair[asset.kind] = asset
    pairs.set(key, pair)
  }

  const candidates: AvailableUpdate[] = []
  for (const pair of pairs.values()) {
    if (!pair.setup || !pair.win) continue
    const setup = pair.setup
    candidates.push({
      version: setup.version,
      semver: setup.semver,
      timestamp: setup.timestamp,
      timestampMs: setup.timestampMs,
      tagName: release.tag_name,
      releaseName: typeof release.name === 'string' ? release.name : undefined,
      releaseDate: typeof release.published_at === 'string' ? release.published_at : undefined,
      releaseNotes: typeof release.body === 'string' ? release.body : undefined,
      downloadUrl: setup.asset.browser_download_url as string,
      assetName: setup.asset.name as string,
      assetSize: setup.asset.size as number,
      assetDigest: setup.asset.digest as string
    })
  }

  return candidates.sort(compareAvailableUpdates).at(-1)
}

async function requestGithub(pathname: string): Promise<unknown> {
  const url = `https://api.github.com/repos/${UPDATE_PROVIDER.owner}/${UPDATE_PROVIDER.repo}${pathname}`
  let response: Response
  try {
    response = await fetch(url, {
      headers: UPDATE_API_HEADERS,
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    })
  } catch (error) {
    throw new Error(
      `Unable to access GitHub releases for ${UPDATE_PROVIDER.owner}/${UPDATE_PROVIDER.repo}. Check GitHub access or install the update manually: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!response.ok) {
    const accessHint =
      response.status === 404 || response.status === 401 || response.status === 403
        ? 'The configured repository may be private or inaccessible; provide GitHub access or install the update manually.'
        : 'Check GitHub access or install the update manually.'
    throw new Error(
      `Unable to access GitHub releases for ${UPDATE_PROVIDER.owner}/${UPDATE_PROVIDER.repo} (HTTP ${response.status}). ${accessHint}`
    )
  }
  return response.json()
}

async function findAvailableUpdate(): Promise<AvailableUpdate | null> {
  const releases = await requestGithub('/releases?per_page=100')
  if (!Array.isArray(releases))
    throw new Error('GitHub update API returned an invalid release list')

  const currentVersion = getCurrentVersion()
  const currentSemver = parseSemVer(currentVersion)
  if (!currentSemver)
    throw new Error(`Current application version is not valid semver: ${currentVersion}`)

  const updates = releases
    .filter(isRecord)
    .map((release) => candidateFromRelease(release as GithubRelease))
    .filter((update): update is AvailableUpdate => Boolean(update))
    .filter((update) => compareSemVer(update.semver, currentSemver) > 0)
    .sort(compareAvailableUpdates)

  return updates.at(-1) ?? null
}

type UpdateListener = (status: AppUpdateStatus) => void

type AsyncOperation<T> = () => Promise<T>

let updateInstallInProgress = false
let availableUpdate: AvailableUpdate | null = null
let downloadedUpdate: DownloadedUpdate | null = null
let commandQueue: Promise<void> = Promise.resolve()
const listeners = new Set<UpdateListener>()

let status: AppUpdateStatus = {
  state: isSupportedPackagedBuild() ? 'idle' : 'unsupported',
  currentVersion: getCurrentVersion(),
  provider: UPDATE_PROVIDER,
  supported: isSupportedPackagedBuild(),
  canCheck: isSupportedPackagedBuild(),
  canDownload: false,
  canInstall: false
}

function serialize<T>(operation: AsyncOperation<T>): Promise<T> {
  const result = commandQueue.then(operation, operation)
  commandQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function cloneStatus(value: AppUpdateStatus): AppUpdateStatus {
  return {
    ...value,
    provider: { ...value.provider },
    progress: value.progress ? { ...value.progress } : undefined
  }
}

function notifyListener(listener: UpdateListener, nextStatus: AppUpdateStatus): void {
  try {
    listener(cloneStatus(nextStatus))
  } catch (error) {
    console.warn('[AppUpdate] status listener failed:', error)
  }
}

function emitStatus(nextStatus: AppUpdateStatus): AppUpdateStatus {
  const canCheck =
    nextStatus.supported && !['checking', 'downloading', 'installing'].includes(nextStatus.state)
  const canDownload = nextStatus.supported && nextStatus.state === 'available'
  const canInstall = nextStatus.supported && nextStatus.state === 'downloaded'

  status = { ...nextStatus, canCheck, canDownload, canInstall }
  for (const listener of listeners) notifyListener(listener, status)
  return cloneStatus(status)
}

function setUnsupportedStatus(): AppUpdateStatus {
  return emitStatus({
    ...status,
    state: 'unsupported',
    supported: false,
    errorMessage: undefined,
    progress: undefined
  })
}

function setLauncherManagedStatus(): AppUpdateStatus {
  return emitStatus({
    ...status,
    state: 'managed-by-launcher',
    supported: false,
    errorMessage: undefined,
    progress: undefined
  })
}

function setUpdateError(error: unknown): AppUpdateStatus {
  return emitStatus({
    ...status,
    state: 'error',
    supported: true,
    progress: undefined,
    errorMessage: error instanceof Error ? error.message : String(error)
  })
}

async function removePath(targetPath: string | undefined): Promise<void> {
  if (!targetPath) return
  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true })
  } catch {
    // Cleanup is best effort and must not hide the verification/download error.
  }
}

async function clearDownloadedUpdate(): Promise<void> {
  const update = downloadedUpdate
  downloadedUpdate = null
  await removePath(update?.tempDirectory)
}

async function writeAll(fileHandle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const result = await fileHandle.write(buffer, offset, buffer.length - offset)
    if (result.bytesWritten <= 0)
      throw new Error('Update download made no forward progress while writing')
    offset += result.bytesWritten
  }
}

async function hashFile(filePath: string): Promise<{ size: number; digest: string }> {
  const hash = createHash('sha256')
  let size = 0
  const stream = fs.createReadStream(filePath)
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(buffer)
      size += buffer.length
    }
  } finally {
    stream.destroy()
  }
  return { size, digest: `sha256:${hash.digest('hex')}` }
}

async function verifyFile(update: AvailableUpdate, filePath: string): Promise<void> {
  const fileStats = await fs.promises.stat(filePath)
  if (!fileStats.isFile()) throw new Error('Downloaded update is not a regular file')
  if (fileStats.size !== update.assetSize) {
    throw new Error(
      `Downloaded update size mismatch: expected ${update.assetSize}, received ${fileStats.size}`
    )
  }

  const actual = await hashFile(filePath)
  if (actual.size !== update.assetSize || actual.digest !== update.assetDigest) {
    throw new Error(
      `Downloaded update SHA256 mismatch: expected ${update.assetDigest}, received ${actual.digest}`
    )
  }
}

async function downloadFile(update: AvailableUpdate): Promise<DownloadedUpdate> {
  const response = await fetch(update.downloadUrl, {
    headers: { Accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60 * 1000)
  })
  if (!response.ok || !response.body)
    throw new Error(`Update download returned HTTP ${response.status}`)

  const downloadDirectory = getDownloadDirectory()
  let tempDirectory: string | undefined
  let fileHandle: FileHandle | undefined
  try {
    await fs.promises.mkdir(downloadDirectory, { recursive: true, mode: 0o700 })
    tempDirectory = await fs.promises.mkdtemp(path.join(downloadDirectory, PART_DIRECTORY_PREFIX))
    await fs.promises.chmod(tempDirectory, 0o700)
    const filePath = path.join(tempDirectory, update.assetName)
    fileHandle = await fs.promises.open(filePath, 'wx', 0o600)
    let transferred = 0

    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        await writeAll(fileHandle, buffer)
        transferred += buffer.length
        emitStatus({
          ...status,
          state: 'downloading',
          supported: true,
          progress: {
            percent: (transferred / update.assetSize) * 100,
            transferredBytes: transferred,
            totalBytes: update.assetSize,
            bytesPerSecond: undefined
          },
          errorMessage: undefined
        })
        if (transferred > update.assetSize) {
          throw new Error(
            `Downloaded update size mismatch: expected ${update.assetSize}, received more than expected`
          )
        }
      }
      await fileHandle.sync()
    } finally {
      await fileHandle.close()
      fileHandle = undefined
    }

    await verifyFile(update, filePath)
    return { ...update, filePath, tempDirectory }
  } catch (error) {
    if (fileHandle) {
      try {
        await fileHandle.close()
      } catch {
        // The temporary directory is still removed below.
      }
    }
    await removePath(tempDirectory)
    throw error
  }
}

function launchInstaller(update: DownloadedUpdate): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(update.filePath, [`/D=${getCurrentInstallDirectory()}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: false
      })
    } catch (error) {
      reject(error)
      return
    }

    let settled = false
    const succeed = (): void => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    child.once('spawn', succeed)
    child.once('error', fail)
  })
}

export function getAppUpdateStatus(): AppUpdateStatus {
  if (isLauncherManaged()) {
    return {
      ...cloneStatus(status),
      state: 'managed-by-launcher',
      supported: false,
      canCheck: false,
      canDownload: false,
      canInstall: false
    }
  }

  if (!isSupportedPackagedBuild()) {
    return {
      ...cloneStatus(status),
      state: 'unsupported',
      supported: false,
      canCheck: false,
      canDownload: false,
      canInstall: false
    }
  }

  return cloneStatus(status)
}

export function addAppUpdateStatusListener(listener: UpdateListener): () => void {
  listeners.add(listener)
  notifyListener(listener, getAppUpdateStatus())
  return () => listeners.delete(listener)
}

export function initializeAppUpdateManager(): Promise<AppUpdateStatus> {
  return serialize(async () => {
    if (isLauncherManaged()) return setLauncherManagedStatus()
    if (!isSupportedPackagedBuild()) return setUnsupportedStatus()
    await clearDownloadedUpdate()
    availableUpdate = null
    return emitStatus({
      ...status,
      state: 'idle',
      supported: true,
      latestVersion: undefined,
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: undefined,
      checkedAt: undefined,
      downloadedAt: undefined,
      progress: undefined,
      errorMessage: undefined
    })
  })
}

export function checkForAppUpdates(): Promise<AppUpdateStatus> {
  return serialize(async () => {
    if (isLauncherManaged()) return setLauncherManagedStatus()
    if (!isSupportedPackagedBuild()) return setUnsupportedStatus()

    await clearDownloadedUpdate()
    availableUpdate = null
    emitStatus({
      ...status,
      state: 'checking',
      supported: true,
      latestVersion: undefined,
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: undefined,
      checkedAt: undefined,
      downloadedAt: undefined,
      progress: undefined,
      errorMessage: undefined
    })
    try {
      availableUpdate = await findAvailableUpdate()
      if (!availableUpdate) {
        return emitStatus({
          ...status,
          state: 'not-available',
          supported: true,
          latestVersion: getCurrentVersion(),
          checkedAt: Date.now(),
          errorMessage: undefined
        })
      }

      return emitStatus({
        ...status,
        state: 'available',
        supported: true,
        latestVersion: availableUpdate.version,
        releaseName: availableUpdate.releaseName,
        releaseDate: availableUpdate.releaseDate,
        releaseNotes: availableUpdate.releaseNotes,
        checkedAt: Date.now(),
        progress: undefined,
        errorMessage: undefined
      })
    } catch (error) {
      availableUpdate = null
      return setUpdateError(error)
    }
  })
}

export function downloadAppUpdate(): Promise<AppUpdateStatus> {
  return serialize(async () => {
    if (isLauncherManaged()) return setLauncherManagedStatus()
    if (!isSupportedPackagedBuild()) return setUnsupportedStatus()
    if (!availableUpdate) return setUpdateError(new Error('Check for updates before downloading'))

    const update = availableUpdate
    await clearDownloadedUpdate()
    try {
      downloadedUpdate = await downloadFile(update)
      return emitStatus({
        ...status,
        state: 'downloaded',
        supported: true,
        progress: undefined,
        downloadedAt: Date.now(),
        errorMessage: undefined
      })
    } catch (error) {
      downloadedUpdate = null
      return setUpdateError(error)
    }
  })
}

export function installAppUpdate(): Promise<AppUpdateStatus> {
  return serialize(async () => {
    if (isLauncherManaged()) return setLauncherManagedStatus()
    if (!isSupportedPackagedBuild()) return setUnsupportedStatus()
    if (updateInstallInProgress)
      return setUpdateError(new Error('An update installation is already in progress'))
    if (!downloadedUpdate) return setUpdateError(new Error('Download an update before installing'))

    const update = downloadedUpdate
    updateInstallInProgress = true
    emitStatus({ ...status, state: 'installing', supported: true, errorMessage: undefined })
    try {
      await verifyFile(update, update.filePath)
      await launchInstaller(update)
      app.quit()
      return getAppUpdateStatus()
    } catch (error) {
      updateInstallInProgress = false
      downloadedUpdate = null
      await removePath(update.tempDirectory)
      return setUpdateError(error)
    }
  })
}

export function isAppUpdateInstallInProgress(): boolean {
  return updateInstallInProgress
}
