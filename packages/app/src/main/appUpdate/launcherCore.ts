import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  parseActivePointer,
  parseInstalledAppManifest,
  parseInstalledRuntimeManifest,
  serializeActivePointer,
  type ActivePointerV1,
  type InstalledAppManifestV1,
  type InstalledRuntimeManifestV1
} from '../../shared/appUpdate/launcherProtocol'
import {
  createLauncherLayout,
  getAppDirectory,
  getRuntimeDirectory,
  INSTALLED_MANIFEST_FILE,
  isPathInside,
  resolveInstalledPath,
  type LauncherLayout
} from './launcherLayout'
import {
  createLauncherStateStore,
  type LauncherStateFileSystem,
  type LauncherStateStore
} from './launcherStateStore'
import {
  createLauncherHealth,
  type LauncherHealth,
  type LauncherHealthMutationResult,
  type LauncherHealthStateV1,
  type PendingLaunchIdentity
} from './launcherHealth'
import { withWaitedUpdateLock } from './updateLock'

const MAX_INSTALLED_BUILD_CANDIDATES = 1_000
export const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3
export const LAUNCHER_HEALTH_FILE = 'launcher-health.json'
export const ACTIVATION_JOURNAL_SCHEMA = 1 as const

interface ActivationJournalV1 {
  schema: 1
  phase: 'prepared'
  createdAt: string
  from?: ActivePointerV1
  to: ActivePointerV1
}
export const DEFAULT_HEALTH_DEADLINE_MS = 60_000
export const LAUNCH_TOKEN_ENV = 'MAGICPOT_LAUNCH_TOKEN'
export const LAUNCH_BUILD_ENV = 'MAGICPOT_LAUNCH_BUILD_ID'
export const LAUNCH_RUNTIME_ENV = 'MAGICPOT_LAUNCH_RUNTIME_ID'
export const LAUNCHER_ROOT_ENV = 'MAGICPOT_LAUNCHER_ROOT'

export interface LauncherCoreFileSystem extends LauncherStateFileSystem {
  readdir(path: string): Promise<string[]>
  lstat(
    path: string
  ): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>
  realpath(path: string): Promise<string>
}

export interface ValidatedInstallation {
  app: InstalledAppManifestV1
  runtime: InstalledRuntimeManifestV1
  appDirectory: string
  runtimeDirectory: string
  appEntrypoint: string
  pythonEntrypoint: string
  comfyuiEntrypoint: string
}

export interface LaunchSelection extends ValidatedInstallation {
  source: 'active' | 'previous' | 'installed'
  pointer?: ActivePointerV1
}

export class LauncherCoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LauncherCoreError'
  }
}

function isActivationJournal(value: unknown): value is ActivationJournalV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const journal = value as Record<string, unknown>
  const keys = Object.keys(journal)
  if (
    !keys.every((key) => ['schema', 'phase', 'createdAt', 'from', 'to'].includes(key)) ||
    journal.schema !== ACTIVATION_JOURNAL_SCHEMA ||
    journal.phase !== 'prepared' ||
    typeof journal.createdAt !== 'string'
  )
    return false
  const createdAt = new Date(journal.createdAt)
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== journal.createdAt)
    return false
  try {
    parseActivePointer(JSON.stringify(journal.to))
    if (journal.from !== undefined) parseActivePointer(JSON.stringify(journal.from))
    return true
  } catch {
    return false
  }
}

function parseActivationJournal(text: string): ActivationJournalV1 {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new TypeError(
      `activation journal is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isActivationJournal(value)) throw new TypeError('activation journal does not match schema 1')
  return value
}

function serializeActivationJournal(value: ActivationJournalV1): string {
  if (!isActivationJournal(value)) throw new TypeError('activation journal does not match schema 1')
  return `${JSON.stringify(value, null, 2)}\n`
}

function samePointer(
  pointer: ActivePointerV1 | undefined,
  expected: ActivePointerV1 | undefined
): boolean {
  if (!pointer || !expected) return pointer === expected
  return (
    pointer.schema === expected.schema &&
    pointer.activeBuildId === expected.activeBuildId &&
    pointer.activeRuntimeId === expected.activeRuntimeId &&
    pointer.previousBuildId === expected.previousBuildId &&
    pointer.previousRuntimeId === expected.previousRuntimeId &&
    pointer.activatedAt === expected.activatedAt
  )
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function readOptional(
  fs: LauncherCoreFileSystem,
  filePath: string
): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
}

function isRedirectingEntry(stat: { isSymbolicLink(): boolean }): boolean {
  // On Windows Node reports directory junctions and other name-surrogate reparse points as links.
  return stat.isSymbolicLink()
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

async function requireRealManagedDirectory(
  fs: LauncherCoreFileSystem,
  directory: string,
  label: string,
  expectedParent = path.dirname(directory)
): Promise<string> {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || isRedirectingEntry(stat))
    throw new LauncherCoreError(`${label} is not a real directory: ${directory}`)
  const [realDirectory, realParent] = await Promise.all([
    fs.realpath(directory),
    fs.realpath(expectedParent)
  ])
  const expectedDirectory = path.join(realParent, path.basename(directory))
  if (!sameCanonicalPath(realDirectory, expectedDirectory))
    throw new LauncherCoreError(`${label} is redirected: ${directory}`)
  return realDirectory
}

async function requireRealDirectory(
  fs: LauncherCoreFileSystem,
  directory: string,
  expectedParent: string
): Promise<string> {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || isRedirectingEntry(stat))
    throw new LauncherCoreError(`Installation directory is not a real directory: ${directory}`)
  const [realDirectory, realParent] = await Promise.all([
    fs.realpath(directory),
    fs.realpath(expectedParent)
  ])
  if (!sameCanonicalPath(realDirectory, path.join(realParent, path.basename(directory))))
    throw new LauncherCoreError(`Installation directory is redirected: ${directory}`)
  return realDirectory
}

async function requireManagedRoots(
  fs: LauncherCoreFileSystem,
  layout: LauncherLayout
): Promise<void> {
  await requireRealManagedDirectory(fs, layout.root, 'Launcher root')
  await Promise.all([
    requireRealManagedDirectory(fs, layout.apps, 'Managed apps root', layout.root),
    requireRealManagedDirectory(fs, layout.runtimes, 'Managed runtimes root', layout.root)
  ])
}

async function requireContainedFile(
  fs: LauncherCoreFileSystem,
  directory: string,
  relativePath: string,
  label = 'Installed file'
): Promise<string> {
  const candidate = resolveInstalledPath(directory, relativePath)
  const stat = await fs.lstat(candidate)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new LauncherCoreError(`${label} is not a regular file: ${candidate}`)
  const [realDirectory, realCandidate] = await Promise.all([
    fs.realpath(directory),
    fs.realpath(candidate)
  ])
  if (!isPathInside(realDirectory, realCandidate) || realCandidate === realDirectory)
    throw new LauncherCoreError(`${label} escapes its directory: ${candidate}`)
  return realCandidate
}

export async function validateInstalledPair(
  layout: LauncherLayout,
  buildId: string,
  runtimeId: string,
  fileSystem: LauncherCoreFileSystem = fs
): Promise<ValidatedInstallation> {
  const appDirectory = getAppDirectory(layout, buildId)
  const runtimeDirectory = getRuntimeDirectory(layout, runtimeId)
  await requireManagedRoots(fileSystem, layout)
  const [realAppDirectory, realRuntimeDirectory] = await Promise.all([
    requireRealDirectory(fileSystem, appDirectory, layout.apps),
    requireRealDirectory(fileSystem, runtimeDirectory, layout.runtimes)
  ])

  const [appManifestPath, runtimeManifestPath] = await Promise.all([
    requireContainedFile(fileSystem, appDirectory, INSTALLED_MANIFEST_FILE, 'App manifest'),
    requireContainedFile(fileSystem, runtimeDirectory, INSTALLED_MANIFEST_FILE, 'Runtime manifest')
  ])
  const [appText, runtimeText] = await Promise.all([
    fileSystem.readFile(appManifestPath, 'utf8'),
    fileSystem.readFile(runtimeManifestPath, 'utf8')
  ])
  const app = parseInstalledAppManifest(appText)
  const runtime = parseInstalledRuntimeManifest(runtimeText)
  if (app.buildId !== buildId)
    throw new LauncherCoreError('App manifest build ID does not match its directory')
  if (runtime.runtimeId !== runtimeId)
    throw new LauncherCoreError('Runtime manifest ID does not match its directory')
  if (app.runtimeId !== runtimeId)
    throw new LauncherCoreError('App manifest does not target the selected runtime')

  const [appEntrypoint, pythonEntrypoint, comfyuiEntrypoint] = await Promise.all([
    requireContainedFile(fileSystem, appDirectory, app.entrypoint, 'App entrypoint'),
    requireContainedFile(
      fileSystem,
      runtimeDirectory,
      runtime.entrypoints.python,
      'Python entrypoint'
    ),
    requireContainedFile(
      fileSystem,
      runtimeDirectory,
      runtime.entrypoints.comfyui,
      'ComfyUI entrypoint'
    )
  ])
  return {
    app,
    runtime,
    appDirectory: realAppDirectory,
    runtimeDirectory: realRuntimeDirectory,
    appEntrypoint,
    pythonEntrypoint,
    comfyuiEntrypoint
  }
}

async function tryPair(
  layout: LauncherLayout,
  buildId: string,
  runtimeId: string,
  fileSystem: LauncherCoreFileSystem
): Promise<ValidatedInstallation | undefined> {
  try {
    return await validateInstalledPair(layout, buildId, runtimeId, fileSystem)
  } catch {
    return undefined
  }
}

export async function selectLaunchInstallation(
  root: string,
  fileSystem: LauncherCoreFileSystem = fs
): Promise<LaunchSelection> {
  const layout = createLauncherLayout(root)
  let pointer: ActivePointerV1 | undefined
  const pointerText = await readOptional(fileSystem, layout.activePointer)
  if (pointerText !== undefined) {
    try {
      pointer = parseActivePointer(pointerText)
    } catch {
      pointer = undefined
    }
  }

  if (pointer) {
    const active = await tryPair(layout, pointer.activeBuildId, pointer.activeRuntimeId, fileSystem)
    if (active) return { ...active, source: 'active', pointer }
    if (pointer.previousBuildId && pointer.previousRuntimeId) {
      const previous = await tryPair(
        layout,
        pointer.previousBuildId,
        pointer.previousRuntimeId,
        fileSystem
      )
      if (previous) return { ...previous, source: 'previous', pointer }
    }
  }

  let buildIds: string[]
  try {
    buildIds = await fileSystem.readdir(layout.apps)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) buildIds = []
    else throw error
  }
  const candidates = await Promise.all(
    buildIds.slice(0, MAX_INSTALLED_BUILD_CANDIDATES).map(async (buildId) => {
      let app: InstalledAppManifestV1
      try {
        app = parseInstalledAppManifest(
          await fileSystem.readFile(
            path.join(getAppDirectory(layout, buildId), INSTALLED_MANIFEST_FILE),
            'utf8'
          )
        )
      } catch {
        return undefined
      }
      const installed = await tryPair(layout, buildId, app.runtimeId, fileSystem)
      return installed ? { installed, createdAt: Date.parse(app.createdAt) } : undefined
    })
  )
  const newest = candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        right.installed.app.buildId.localeCompare(left.installed.app.buildId)
    )[0]
  if (!newest)
    throw new LauncherCoreError('No valid installed app/runtime combination is available')
  return { ...newest.installed, source: 'installed', pointer }
}

export interface LocalLauncherCoreOptions {
  now?: () => Date
  consecutiveFailureThreshold?: number
  healthDeadlineMs?: number
  createLaunchToken?: () => string
}

export class LocalLauncherCore {
  readonly layout: LauncherLayout
  readonly fileSystem: LauncherCoreFileSystem
  private readonly pointerStore: LauncherStateStore<ActivePointerV1 | undefined>
  private readonly activationJournalStore: LauncherStateStore<ActivationJournalV1 | undefined>
  private readonly health: LauncherHealth
  private readonly now: () => Date
  private readonly healthDeadlineMs: number
  private readonly createLaunchToken: () => string
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    layout: LauncherLayout,
    fileSystem: LauncherCoreFileSystem = fs,
    options: LocalLauncherCoreOptions = {}
  ) {
    this.layout = layout
    this.fileSystem = fileSystem
    this.now = options.now ?? (() => new Date())
    const threshold = options.consecutiveFailureThreshold ?? DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD
    this.healthDeadlineMs = options.healthDeadlineMs ?? DEFAULT_HEALTH_DEADLINE_MS
    this.createLaunchToken = options.createLaunchToken ?? randomUUID
    if (!Number.isSafeInteger(threshold) || threshold < 1)
      throw new TypeError('Consecutive failure threshold must be a positive integer')
    if (!Number.isSafeInteger(this.healthDeadlineMs) || this.healthDeadlineMs < 1)
      throw new TypeError('Health deadline must be a positive integer')
    this.pointerStore = createLauncherStateStore<ActivePointerV1 | undefined>({
      filePath: layout.activePointer,
      parse: parseActivePointer,
      serialize: (value) => {
        if (!value) throw new LauncherCoreError('Cannot persist an empty active pointer')
        return serializeActivePointer(value)
      },
      fileSystem
    })
    this.activationJournalStore = createLauncherStateStore<ActivationJournalV1 | undefined>({
      filePath: layout.activationJournal,
      parse: parseActivationJournal,
      serialize: (value) => {
        if (!value) throw new LauncherCoreError('Cannot persist an empty activation journal')
        return serializeActivationJournal(value)
      },
      fileSystem
    })
    this.health = createLauncherHealth({
      filePath: path.join(layout.root, LAUNCHER_HEALTH_FILE),
      rollbackThreshold: threshold,
      fileSystem,
      now: this.now,
      withLock:
        fileSystem === fs
          ? async (operation) => {
              const lockRoot = path.join(layout.root, '.health-lock')
              await fs.mkdir(lockRoot, { recursive: true })
              return withWaitedUpdateLock(lockRoot, operation)
            }
          : undefined
    })
    const recovery = this.recoverActivationInternal()
    this.operationQueue = recovery.then(
      () => undefined,
      () => undefined
    )
  }

  validateBuild(buildId: string): Promise<ValidatedInstallation | null> {
    return this.enqueue(() => this.validateBuildInternal(buildId))
  }
  validateRuntime(runtimeId: string): Promise<InstalledRuntimeManifestV1 | null> {
    return this.enqueue(() => this.validateRuntimeInternal(runtimeId))
  }
  getActive(): Promise<LaunchSelection | null> {
    return this.enqueue(() => this.getActiveInternal())
  }
  activate(buildId: string, runtimeId: string): Promise<LaunchSelection> {
    return this.enqueue(() => this.activateInternal(buildId, runtimeId))
  }
  async verifyLaunchTarget(
    buildId: string,
    runtimeId: string
  ): Promise<ValidatedInstallation | null> {
    const verified = await this.validateBuildInternal(buildId)
    if (!verified || verified.runtime.runtimeId !== runtimeId) return null
    await reverifyLaunchBinding(this.fileSystem, verified)
    return verified
  }
  resolveActive(): Promise<LaunchSelection> {
    return this.enqueue(() => this.resolveActiveInternal())
  }
  readHealthState(): Promise<LauncherHealthStateV1> {
    return this.health.load()
  }
  repairActivePointer(): Promise<LaunchSelection> {
    return this.resolveActive()
  }
  rollback(): Promise<LaunchSelection> {
    return this.enqueue(() => this.rollbackInternal())
  }

  spawnActive(options: SpawnSelectedAppOptions = {}): Promise<ChildProcess> {
    return this.enqueue(async () => {
      await this.recoverExpiredPendingInternal()
      const selected = await this.resolveActiveInternal()
      const identity = await this.beginPendingInternal(selected, options)
      try {
        const child = await spawnSelectedApp(this, selected, {
          ...options,
          env: {
            ...(options.env ?? process.env),
            [LAUNCH_TOKEN_ENV]: identity.launchToken,
            [LAUNCH_BUILD_ENV]: identity.buildId,
            [LAUNCH_RUNTIME_ENV]: identity.runtimeId,
            MAGICPOT_ACTIVE_RUNTIME_ID: identity.runtimeId,
            [LAUNCHER_ROOT_ENV]: this.layout.root
          }
        })
        this.observeChildBeforeHealth(child, identity)
        return child
      } catch (error) {
        await this.recordFailureInternal(identity, 'failed')
        throw error
      }
    })
  }

  beginPendingLaunch(
    buildId: string,
    runtimeId: string,
    options: Pick<SpawnSelectedAppOptions, 'launchToken' | 'healthDeadline'> = {}
  ): Promise<LauncherHealthStateV1> {
    return this.enqueue(async () => {
      await this.recoverExpiredPendingInternal()
      const selected = await this.verifyLaunchTarget(buildId, runtimeId)
      if (!selected)
        throw new LauncherCoreError(`Cannot record launch for invalid build: ${buildId}`)
      await this.beginPendingInternal(selected, options)
      return this.health.load()
    })
  }
  confirmHealthy(input: PendingLaunchIdentity): Promise<LauncherHealthMutationResult> {
    return this.enqueue(() => this.health.confirmHealthy(input))
  }
  recoverExpiredPending(): Promise<LauncherHealthMutationResult | undefined> {
    return this.enqueue(() => this.recoverExpiredPendingInternal())
  }

  private async validateBuildInternal(buildId: string): Promise<ValidatedInstallation | null> {
    try {
      const app = parseInstalledAppManifest(
        await this.fileSystem.readFile(
          path.join(getAppDirectory(this.layout, buildId), INSTALLED_MANIFEST_FILE),
          'utf8'
        )
      )
      return await validateInstalledPair(this.layout, buildId, app.runtimeId, this.fileSystem)
    } catch {
      return null
    }
  }
  private async validateRuntimeInternal(
    runtimeId: string
  ): Promise<InstalledRuntimeManifestV1 | null> {
    try {
      await requireManagedRoots(this.fileSystem, this.layout)
      const directory = getRuntimeDirectory(this.layout, runtimeId)
      await requireRealDirectory(this.fileSystem, directory, this.layout.runtimes)
      const manifestPath = await requireContainedFile(
        this.fileSystem,
        directory,
        INSTALLED_MANIFEST_FILE,
        'Runtime manifest'
      )
      const runtime = parseInstalledRuntimeManifest(
        await this.fileSystem.readFile(manifestPath, 'utf8')
      )
      if (runtime.runtimeId !== runtimeId) return null
      await Promise.all([
        requireContainedFile(
          this.fileSystem,
          directory,
          runtime.entrypoints.python,
          'Python entrypoint'
        ),
        requireContainedFile(
          this.fileSystem,
          directory,
          runtime.entrypoints.comfyui,
          'ComfyUI entrypoint'
        )
      ])
      return runtime
    } catch {
      return null
    }
  }
  private async recoverActivationInternal(): Promise<void> {
    const journal = await this.activationJournalStore.loadStrict(undefined)
    if (!journal) return
    const current = await this.pointerStore.loadStrict(undefined)
    if (samePointer(current, journal.to)) {
      await this.health.reset()
      await this.activationJournalStore.remove()
      return
    }
    if (samePointer(current, journal.from)) {
      await this.activationJournalStore.remove()
      return
    }
    throw new LauncherCoreError(
      'Active pointer is inconsistent with the pending activation journal'
    )
  }
  private async commitActivationInternal(
    from: ActivePointerV1 | undefined,
    to: ActivePointerV1
  ): Promise<void> {
    await this.activationJournalStore.save({
      schema: ACTIVATION_JOURNAL_SCHEMA,
      phase: 'prepared',
      createdAt: this.now().toISOString(),
      ...(from ? { from } : {}),
      to
    })
    await this.pointerStore.save(to)
    await this.health.reset()
    await this.activationJournalStore.remove()
  }
  private async getActiveInternal(): Promise<LaunchSelection | null> {
    await this.recoverActivationInternal()
    const pointer = await this.pointerStore.load(undefined)
    if (!pointer) return null
    const active = await tryPair(
      this.layout,
      pointer.activeBuildId,
      pointer.activeRuntimeId,
      this.fileSystem
    )
    return active ? { ...active, source: 'active', pointer } : null
  }
  private async activateInternal(buildId: string, runtimeId: string): Promise<LaunchSelection> {
    await this.recoverActivationInternal()
    const installation = await validateInstalledPair(
      this.layout,
      buildId,
      runtimeId,
      this.fileSystem
    )
    const current = await this.pointerStore.load(undefined)
    const changed = current?.activeBuildId !== buildId || current.activeRuntimeId !== runtimeId
    const pointer: ActivePointerV1 = {
      schema: 1,
      activeBuildId: buildId,
      activeRuntimeId: runtimeId,
      ...(changed && current
        ? {
            previousBuildId: current.activeBuildId,
            previousRuntimeId: current.activeRuntimeId
          }
        : current?.previousBuildId && current.previousRuntimeId
          ? {
              previousBuildId: current.previousBuildId,
              previousRuntimeId: current.previousRuntimeId
            }
          : {}),
      activatedAt: changed || !current ? this.now().toISOString() : current.activatedAt
    }
    await this.commitActivationInternal(current, pointer)
    return { ...installation, source: 'active', pointer }
  }
  private async resolveActiveInternal(): Promise<LaunchSelection> {
    await this.recoverActivationInternal()
    const selected = await selectLaunchInstallation(this.layout.root, this.fileSystem)
    if (selected.source === 'active') return selected
    const prior = selected.pointer
    const repaired: ActivePointerV1 = {
      schema: 1,
      activeBuildId: selected.app.buildId,
      activeRuntimeId: selected.runtime.runtimeId,
      ...(selected.source === 'previous'
        ? { previousBuildId: prior?.activeBuildId, previousRuntimeId: prior?.activeRuntimeId }
        : prior?.activeBuildId && prior.activeRuntimeId
          ? { previousBuildId: prior.activeBuildId, previousRuntimeId: prior.activeRuntimeId }
          : {}),
      activatedAt: this.now().toISOString()
    }
    await this.commitActivationInternal(prior, repaired)
    return { ...selected, source: 'active', pointer: repaired }
  }
  private async rollbackInternal(): Promise<LaunchSelection> {
    await this.recoverActivationInternal()
    const pointer = await this.pointerStore.load(undefined)
    if (!pointer?.previousBuildId || !pointer.previousRuntimeId)
      throw new LauncherCoreError('No previous installation is available for rollback')
    const previous = await tryPair(
      this.layout,
      pointer.previousBuildId,
      pointer.previousRuntimeId,
      this.fileSystem
    )
    if (!previous) throw new LauncherCoreError('Previous launcher installation is not valid')
    const rolledBack: ActivePointerV1 = {
      schema: 1,
      activeBuildId: pointer.previousBuildId,
      activeRuntimeId: pointer.previousRuntimeId,
      previousBuildId: pointer.activeBuildId,
      previousRuntimeId: pointer.activeRuntimeId,
      activatedAt: this.now().toISOString()
    }
    await this.commitActivationInternal(pointer, rolledBack)
    return { ...previous, source: 'active', pointer: rolledBack }
  }
  private async beginPendingInternal(
    selected: ValidatedInstallation,
    options: Pick<SpawnSelectedAppOptions, 'launchToken' | 'healthDeadline'>
  ): Promise<PendingLaunchIdentity> {
    const launchToken = options.launchToken ?? this.createLaunchToken()
    const deadline =
      options.healthDeadline ?? new Date(this.now().getTime() + this.healthDeadlineMs)
    await this.health.beginPendingLaunch({
      buildId: selected.app.buildId,
      runtimeId: selected.runtime.runtimeId,
      launchToken,
      deadline
    })
    return {
      buildId: selected.app.buildId,
      runtimeId: selected.runtime.runtimeId,
      launchToken
    }
  }
  private async recordFailureInternal(
    identity: PendingLaunchIdentity,
    reason: 'failed' | 'expired'
  ): Promise<LauncherHealthMutationResult> {
    const result = await this.health.recordFailedOrExpired({ ...identity, reason })
    if (result.accepted && result.shouldRollback) {
      const pointer = await this.pointerStore.load(undefined)
      if (
        pointer?.activeBuildId === identity.buildId &&
        pointer.activeRuntimeId === identity.runtimeId &&
        pointer.previousBuildId
      )
        await this.rollbackInternal()
    }
    return result
  }

  private observeChildBeforeHealth(child: ChildProcess, identity: PendingLaunchIdentity): void {
    if (typeof child.once !== 'function') return
    let settled = false
    const recordFailure = (): void => {
      if (settled) return
      settled = true
      void this.enqueue(() => this.recordFailureInternal(identity, 'failed')).catch((error) => {
        console.error('[Launcher] Failed to record early child exit:', error)
      })
    }
    child.once('error', recordFailure)
    child.once('exit', recordFailure)
  }

  private async recoverExpiredPendingInternal(): Promise<LauncherHealthMutationResult | undefined> {
    const current = await this.health.load()
    if (!current.pending || this.now().getTime() < Date.parse(current.pending.deadline))
      return undefined
    return this.recordFailureInternal(current.pending, 'expired')
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export type SpawnLauncherProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface SpawnSelectedAppOptions {
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  spawn?: SpawnLauncherProcess
  launchToken?: string
  healthDeadline?: Date | string
}

async function reverifyLaunchBinding(
  fileSystem: LauncherCoreFileSystem,
  verified: ValidatedInstallation
): Promise<void> {
  const [appDirectory, appEntrypoint] = await Promise.all([
    requireRealDirectory(fileSystem, verified.appDirectory, path.dirname(verified.appDirectory)),
    requireContainedFile(
      fileSystem,
      verified.appDirectory,
      verified.app.entrypoint,
      'App entrypoint'
    )
  ])
  if (
    !sameCanonicalPath(appDirectory, verified.appDirectory) ||
    !sameCanonicalPath(appEntrypoint, verified.appEntrypoint)
  )
    throw new LauncherCoreError('Selected launcher target changed after validation')
}

export async function spawnSelectedApp(
  launcher: LocalLauncherCore,
  selected: ValidatedInstallation,
  options: SpawnSelectedAppOptions = {}
): Promise<ChildProcess> {
  const verified = await launcher.verifyLaunchTarget(
    selected.app.buildId,
    selected.runtime.runtimeId
  )
  if (!verified) throw new LauncherCoreError('Selected launcher installation is no longer valid')
  await reverifyLaunchBinding(launcher.fileSystem, verified)
  const spawnProcess = options.spawn ?? nodeSpawn
  return spawnProcess(verified.appEntrypoint, [...(options.args ?? [])], {
    shell: false,
    cwd: verified.appDirectory,
    env: { ...(options.env ?? process.env) },
    windowsHide: true
  })
}
