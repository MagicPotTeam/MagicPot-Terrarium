import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { invokeCrashHook } from './crashHooks'
import {
  deepFreeze,
  _isEventStorePathOpen,
  validateEventStoreDatabaseV3,
  type EventStoreDatabaseCounts
} from './eventStore'
import {
  backupDatabase,
  EVENT_STORE_SCHEMA_VERSION,
  openReadOnlyDatabase,
  type NodeSQLiteAdapter
} from './sqliteAdapter'
import { acquireEventStoreWriteLock, assertNoActiveInstanceLeases } from './writeLock'

export type BackupManifest = Readonly<{
  kind: 'magic-agent-event-store-backup'
  backupPath: string
  sourcePath: string
  sha256: `sha256:${string}`
  size: number
  createdAt: number
  schemaVersion: 3
  counts: EventStoreDatabaseCounts
  sqliteVersion: string
}>
export type RestoreEventStoreResult = Readonly<{
  targetPath: string
  backupManifest: BackupManifest
  rollbackPath: string | null
  replacedExisting: boolean
}>

export class BackupError extends Error {
  readonly code: string = 'MAGIC_AGENT_BACKUP_FAILED'
  constructor(
    readonly stage: string,
    cause?: unknown
  ) {
    super(`MagicAgent Event Store backup failed at ${stage}.`, { cause })
    this.name = 'BackupError'
  }
}
export class RestoreError extends Error {
  readonly code: string = 'MAGIC_AGENT_RESTORE_FAILED'
  constructor(
    readonly stage: string,
    cause?: unknown
  ) {
    super(`MagicAgent Event Store restore failed at ${stage}.`, { cause })
    this.name = 'RestoreError'
  }
}
export class RestoreRecoveryRequiredError extends RestoreError {
  readonly code = 'MAGIC_AGENT_RESTORE_RECOVERY_REQUIRED'
  constructor(stage = 'recovery-manual', cause?: unknown) {
    super(stage, cause)
    this.name = 'RestoreRecoveryRequiredError'
  }
}
export class HashMismatchError extends RestoreError {
  readonly code = 'MAGIC_AGENT_RESTORE_HASH_MISMATCH'
  constructor() {
    super('hash', new Error('Backup SHA-256 did not match expectedSha256.'))
    this.name = 'HashMismatchError'
  }
}

export type RestoreStage =
  | 'prepared'
  | 'rollback-linking'
  | 'rollback-linked'
  | 'target-removing'
  | 'target-removed'
  | 'target-linking'
  | 'target-linked'
  | 'verifying'
  | 'verified'
export type RestoreIdentity = Readonly<{ dev: string; ino: string; size: string; mtimeNs: string }>
type RestoreJournal = Readonly<{
  kind: 'magic-agent-event-store-restore-journal'
  version: 2
  stage: RestoreStage
  targetPath: string
  backupPath: string
  partialPath: string
  rollbackPath: string | null
  expectedSha256: string
  replacedExisting: boolean
  backupIdentity: RestoreIdentity
  partialIdentity: RestoreIdentity
  targetIdentity: RestoreIdentity | null
  rollbackIdentity: RestoreIdentity | null
}>
type JournalRead = Readonly<{ journal: RestoreJournal; identity: RestoreIdentity }>
type BackupJournal = Readonly<{
  kind: 'magic-agent-event-store-backup-journal'
  version: 1
  stage: 'partial-ready' | 'target-published'
  sourcePath: string
  targetPath: string
  partialPath: string
  expectedHash: string
  partialIdentity: RestoreIdentity
  targetIdentity: RestoreIdentity | null
  manifest: BackupManifest
}>

class SimulatedCrashError extends Error {
  constructor(readonly stage: RestoreStage) {
    super(`Simulated restore crash after ${stage} filesystem action.`)
    this.name = 'SimulatedCrashError'
  }
}
let faultStage: RestoreStage | null = null
let stageHook: ((stage: RestoreStage) => void) | null = null
let failAfterPartialInspect = false
const ownedJournalIdentities = new Map<string, RestoreIdentity>()

export async function _internalCreateEventStoreBackup(
  source: NodeSQLiteAdapter,
  targetPath: string,
  options: { createdAt?: number; rate?: number } = {}
): Promise<BackupManifest> {
  const targetInput = absoluteInput(targetPath)
  let partial: string | undefined
  let partialIdentity: RestoreIdentity | undefined
  try {
    const sourcePath = requireDiskPath(source.path, 'source')
    const sourceAbsolute = realpathSync(resolve(sourcePath))
    const recovered = await recoverBackupJournal(targetInput, sourceAbsolute)
    if (recovered) return recovered
    const target = prepareDestination(targetInput, false)
    assertDistinct(sourceAbsolute, target.expectedPath)
    const checkpoint = source.get('PRAGMA wal_checkpoint(FULL)')
    if (!checkpoint || checkpoint.busy !== 0) throw new Error('FULL checkpoint was busy.')
    partial = join(target.parent, `.${basename(target.absolute)}.partial-${randomUUID()}`)
    await backupDatabase(source, partial, options.rate === undefined ? {} : { rate: options.rate })
    partialIdentity = inspectRegularFile(partial).identity
    const validation = validateFile(partial)
    const hash = await hashFileStable(partial)
    assertIdentity(partial, partialIdentity)
    const manifest = deepFreeze({
      kind: 'magic-agent-event-store-backup' as const,
      backupPath: target.absolute,
      sourcePath: sourceAbsolute,
      sha256: `sha256:${hash.sha256}` as const,
      size: hash.size,
      createdAt: requireTimestamp(options.createdAt),
      schemaVersion: EVENT_STORE_SCHEMA_VERSION as 3,
      counts: validation.counts,
      sqliteVersion: validation.sqliteVersion
    })
    const journalPath = `${target.absolute}.backup-journal.json`
    let journal: BackupJournal = {
      kind: 'magic-agent-event-store-backup-journal',
      version: 1,
      stage: 'partial-ready',
      sourcePath: sourceAbsolute,
      targetPath: target.absolute,
      partialPath: partial,
      expectedHash: hash.sha256,
      partialIdentity,
      targetIdentity: null,
      manifest
    }
    writeAtomicJournal(journalPath, journal)
    invokeCrashHook('backup.after-partial')
    publishNoReplace(partial, target.absolute)
    fsyncFile(target.absolute)
    fsyncDirectory(target.parent)
    const targetIdentity = inspectRegularFile(target.absolute).identity
    if (!sameIdentity(targetIdentity, partialIdentity))
      throw new Error('Published backup identity mismatch.')
    journal = { ...journal, stage: 'target-published', targetIdentity }
    writeAtomicJournal(journalPath, journal)
    invokeCrashHook('backup.after-publish')
    unlinkRequiredOwned(partial, partialIdentity)
    unlinkJournal(journalPath)
    fsyncDirectory(target.parent)
    partial = undefined
    return deepFreeze({ ...manifest, backupPath: realpathSync(target.absolute) })
  } catch (cause) {
    if (partial && partialIdentity && !existsSync(`${targetInput}.backup-journal.json`))
      unlinkIfOwned(partial, partialIdentity)
    throw cause instanceof BackupError ? cause : new BackupError('create', cause)
  }
}

export async function restoreEventStoreBackup(input: {
  backupPath: string
  targetPath: string
  expectedSha256: string
  rollbackPath?: string
  createdAt?: number
}): Promise<RestoreEventStoreResult> {
  const targetInput = absoluteInput(input.targetPath)
  const release = acquireEventStoreWriteLock(targetInput)
  try {
    assertNoActiveInstanceLeases(targetInput)
    return await restoreEventStoreBackupLocked(input, targetInput)
  } finally {
    release()
  }
}

async function restoreEventStoreBackupLocked(
  input: {
    backupPath: string
    targetPath: string
    expectedSha256: string
    rollbackPath?: string
    createdAt?: number
  },
  targetPath: string
): Promise<RestoreEventStoreResult> {
  const backupPath = absoluteInput(input.backupPath)
  const requestedRollback = input.rollbackPath ? absoluteInput(input.rollbackPath) : undefined
  const journalPath = `${targetPath}.restore-journal.json`
  if (existsSync(journalPath)) await recoverEventStoreRestoreLocked(targetPath)
  let journal: RestoreJournal | undefined
  let preJournalPartial: Readonly<{ path: string; identity: RestoreIdentity }> | undefined
  try {
    const backup = inspectRegularFile(backupPath)
    const target = prepareDestination(targetPath, true)
    if (_isEventStorePathOpen(target.expectedPath))
      throw new Error('Restore target is open in this process.')
    assertNoActiveInstanceLeases(target.absolute)
    assertNoSidecars(target.absolute)
    const expected = normalizeHash(input.expectedSha256)
    assertDistinct(backup.realPath, target.expectedPath, journalPath)
    const backupHash = await hashFileStable(backupPath)
    if (!safeHashEqual(expected, backupHash.sha256)) throw new HashMismatchError()
    const validation = validateFile(backupPath)
    assertUnchanged(backup, inspectRegularFile(backupPath))

    const partialPath = join(target.parent, `.${basename(target.absolute)}.restore-${randomUUID()}`)
    copyFileSync(backupPath, partialPath, constants.COPYFILE_EXCL)
    let partial: ReturnType<typeof inspectRegularFile>
    try {
      partial = inspectRegularFile(partialPath)
    } catch (cause) {
      throw new Error(`Restore partial ownership is unknown; orphan may remain: ${partialPath}`, {
        cause
      })
    }
    preJournalPartial = { path: partialPath, identity: partial.identity }
    if (failAfterPartialInspect)
      throw new Error('Injected failure after restore partial inspection.')
    fsyncFile(partialPath)
    validateFile(partialPath)
    const copiedHash = await hashFileStable(partialPath)
    if (!safeHashEqual(backupHash.sha256, copiedHash.sha256)) throw new HashMismatchError()
    assertUnchanged(backup, inspectRegularFile(backupPath))

    const existing = existsSync(target.absolute) ? inspectRegularFile(target.absolute) : undefined
    if (existing && sameIdentity(backup.identity, existing.identity))
      throw new Error('Backup and target must not alias the same file.')
    let rollbackPath: string | null = null
    if (existing) {
      rollbackPath = requestedRollback ?? `${target.absolute}.rollback-${randomUUID()}`
      const rollback = prepareDestination(rollbackPath, false)
      if (normalize(rollback.parent) !== normalize(target.parent))
        throw new Error('rollbackPath must be in the target directory.')
      assertDistinct(
        rollback.expectedPath,
        backup.realPath,
        target.expectedPath,
        partialPath,
        journalPath
      )
      rollbackPath = rollback.absolute
    } else if (requestedRollback) {
      const rollback = prepareDestination(requestedRollback, false)
      if (normalize(rollback.parent) !== normalize(target.parent))
        throw new Error('rollbackPath must be in the target directory.')
      assertDistinct(
        rollback.expectedPath,
        backup.realPath,
        target.expectedPath,
        partialPath,
        journalPath
      )
    }

    journal = {
      kind: 'magic-agent-event-store-restore-journal',
      version: 2,
      stage: 'prepared',
      targetPath: target.absolute,
      backupPath: backup.realPath,
      partialPath,
      rollbackPath,
      expectedSha256: backupHash.sha256,
      replacedExisting: Boolean(existing),
      backupIdentity: backup.identity,
      partialIdentity: partial.identity,
      targetIdentity: existing?.identity ?? null,
      rollbackIdentity: null
    }
    writeJournal(journalPath, journal)
    preJournalPartial = undefined

    if (existing && rollbackPath) {
      journal = writeStage(journalPath, journal, 'rollback-linking')
      assertIdentity(target.absolute, existing.identity)
      publishNoReplace(target.absolute, rollbackPath)
      fsyncFile(rollbackPath)
      fsyncDirectory(target.parent)
      simulateCrash('rollback-linking')
      const rollbackIdentity = inspectRegularFile(rollbackPath).identity
      if (!sameIdentity(rollbackIdentity, existing.identity))
        throw new Error('Rollback link identity mismatch.')
      journal = { ...journal, stage: 'rollback-linked', rollbackIdentity }
      writeJournal(journalPath, journal)

      journal = writeStage(journalPath, journal, 'target-removing')
      unlinkRequiredOwned(target.absolute, existing.identity)
      fsyncDirectory(target.parent)
      simulateCrash('target-removing')
      journal = writeStage(journalPath, journal, 'target-removed')
    }

    journal = writeStage(journalPath, journal, 'target-linking')
    publishNoReplace(partialPath, target.absolute)
    fsyncFile(target.absolute)
    fsyncDirectory(target.parent)
    simulateCrash('target-linking')
    journal = writeStage(journalPath, journal, 'target-linked')
    journal = writeStage(journalPath, journal, 'verifying')
    validateFile(target.absolute)
    const finalHash = await hashFileStable(target.absolute)
    if (!safeHashEqual(backupHash.sha256, finalHash.sha256)) throw new HashMismatchError()
    assertNoSidecars(target.absolute)
    journal = writeStage(journalPath, journal, 'verified')

    unlinkRequiredOwned(partialPath, partial.identity)
    unlinkJournal(journalPath)
    fsyncDirectory(target.parent)
    return deepFreeze({
      targetPath: realpathSync(target.absolute),
      backupManifest: deepFreeze({
        kind: 'magic-agent-event-store-backup',
        backupPath: backup.realPath,
        sourcePath: backup.realPath,
        sha256: `sha256:${backupHash.sha256}`,
        size: backupHash.size,
        createdAt: requireTimestamp(input.createdAt),
        schemaVersion: 3,
        counts: validation.counts,
        sqliteVersion: validation.sqliteVersion
      }),
      rollbackPath: rollbackPath ? realpathSync(rollbackPath) : null,
      replacedExisting: Boolean(existing)
    })
  } catch (cause) {
    if (cause instanceof SimulatedCrashError) throw cause
    if (preJournalPartial && !existsSync(journalPath)) {
      const orphan = preJournalPartial
      try {
        assertNoSidecars(orphan.path)
        unlinkRequiredOwned(orphan.path, orphan.identity)
        fsyncDirectory(dirname(orphan.path))
        preJournalPartial = undefined
      } catch (cleanupCause) {
        throw new RestoreError(
          'restore',
          new AggregateError([
            cause,
            cleanupCause,
            new Error(`Orphan restore partial may remain: ${orphan.path}`)
          ])
        )
      }
    }
    try {
      if (journal || existsSync(journalPath)) await recoverEventStoreRestoreLocked(targetPath)
    } catch (recoveryCause) {
      throw new RestoreError('rollback', new AggregateError([cause, recoveryCause]))
    }
    if (cause instanceof RestoreError) throw cause
    throw new RestoreError('restore', cause)
  }
}

export async function recoverEventStoreRestore(targetPathInput: string): Promise<void> {
  const targetPath = absoluteInput(targetPathInput)
  const release = acquireEventStoreWriteLock(targetPath)
  try {
    if (_isEventStorePathOpen(targetPath))
      throw new RestoreRecoveryRequiredError('recovery-open-target')
    assertNoActiveInstanceLeases(targetPath)
    await recoverEventStoreRestoreLocked(targetPath)
  } finally {
    release()
  }
}

async function recoverEventStoreRestoreLocked(targetPath: string): Promise<void> {
  const journalPath = `${targetPath}.restore-journal.json`
  if (!existsSync(journalPath)) return
  if (_isEventStorePathOpen(targetPath))
    throw new RestoreRecoveryRequiredError('recovery-open-target')

  let read: JournalRead
  try {
    read = await readJournal(journalPath, targetPath)
  } catch (cause) {
    if (cause instanceof RestoreRecoveryRequiredError) throw cause
    throw new RestoreRecoveryRequiredError('journal-invalid', cause)
  }
  const { journal } = read
  const parent = dirname(targetPath)

  if (hasSidecars(targetPath)) throw new RestoreRecoveryRequiredError('recovery-sidecars')

  const target = inspectObserved(journal.targetPath)
  const rollback = journal.rollbackPath ? inspectObserved(journal.rollbackPath) : null
  const partial = inspectObserved(journal.partialPath)
  if (target && !identityIsOneOf(target.identity, journal.targetIdentity, journal.partialIdentity))
    throw new RestoreRecoveryRequiredError('recovery-target-identity')
  if (
    rollback &&
    !identityIsOneOf(rollback.identity, journal.targetIdentity, journal.rollbackIdentity)
  )
    throw new RestoreRecoveryRequiredError('recovery-rollback-identity')
  if (partial && !sameIdentity(partial.identity, journal.partialIdentity))
    throw new RestoreRecoveryRequiredError('recovery-partial-identity')

  if (journal.replacedExisting) {
    if (!journal.targetIdentity || !journal.rollbackPath)
      throw new RestoreRecoveryRequiredError('recovery-journal-inconsistent')
    if (target && sameIdentity(target.identity, journal.targetIdentity)) {
      removeObservedPartial(journal, partial)
      removeJournalRead(journalPath, read.identity)
      fsyncDirectory(parent)
      return
    }
    if (!rollback || !sameIdentity(rollback.identity, journal.targetIdentity))
      throw new RestoreRecoveryRequiredError('recovery-missing-rollback')

    if (target && sameIdentity(target.identity, journal.partialIdentity)) {
      if (await isValidRestoredTarget(targetPath, journal.expectedSha256)) {
        removeObservedPartial(journal, partial)
        removeJournalRead(journalPath, read.identity)
        fsyncDirectory(parent)
        return
      }
      if (hasSidecars(targetPath)) throw new RestoreRecoveryRequiredError('recovery-sidecars')
      unlinkRequiredOwned(targetPath, journal.partialIdentity)
      fsyncDirectory(parent)
    }
    if (!existsSync(targetPath)) {
      assertIdentity(journal.rollbackPath, journal.targetIdentity)
      publishNoReplace(journal.rollbackPath, targetPath)
      fsyncFile(targetPath)
      fsyncDirectory(parent)
    }
    removeObservedPartial(journal, partial)
    removeJournalRead(journalPath, read.identity)
    fsyncDirectory(parent)
    return
  }

  if (rollback) throw new RestoreRecoveryRequiredError('recovery-unexpected-rollback')
  if (target && sameIdentity(target.identity, journal.partialIdentity)) {
    if (!(await isValidRestoredTarget(targetPath, journal.expectedSha256))) {
      if (hasSidecars(targetPath)) throw new RestoreRecoveryRequiredError('recovery-sidecars')
      unlinkRequiredOwned(targetPath, journal.partialIdentity)
      fsyncDirectory(parent)
    }
  }
  removeObservedPartial(journal, partial)
  removeJournalRead(journalPath, read.identity)
  fsyncDirectory(parent)
}

async function isValidRestoredTarget(path: string, expectedSha256: string): Promise<boolean> {
  try {
    validateFile(path)
    const hash = await hashFileStable(path)
    return safeHashEqual(expectedSha256, hash.sha256) && !hasSidecars(path)
  } catch {
    return false
  }
}

function removeObservedPartial(
  journal: RestoreJournal,
  partial: ReturnType<typeof inspectObserved>
): void {
  if (partial) unlinkRequiredOwned(journal.partialPath, journal.partialIdentity)
}
function inspectObserved(path: string): ReturnType<typeof inspectRegularFile> | null {
  try {
    return inspectRegularFile(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw new RestoreRecoveryRequiredError('recovery-unsafe-path', error)
  }
}
function identityIsOneOf(
  actual: RestoreIdentity,
  ...expected: Array<RestoreIdentity | null>
): boolean {
  return expected.some((value) => value !== null && sameIdentity(actual, value))
}

function validateFile(path: string) {
  const db = openReadOnlyDatabase(path)
  try {
    return validateEventStoreDatabaseV3(db)
  } finally {
    db.close()
  }
}
function absoluteInput(path: string): string {
  requirePath(path)
  return resolve(path)
}
function prepareDestination(absoluteInputPath: string, allowExisting: boolean) {
  const absolute = resolve(absoluteInputPath)
  const parentInput = dirname(absolute)
  mkdirSync(parentInput, { recursive: true })
  assertNoSymlinkChain(parentInput)
  const parent = realpathSync(parentInput)
  const canonical = join(parent, basename(absolute))
  if (existsSync(canonical)) {
    if (!allowExisting) throw new Error('Destination already exists.')
    inspectRegularFile(canonical)
  }
  return { absolute: canonical, parent, expectedPath: normalize(canonical) }
}
function inspectRegularFile(path: string): { realPath: string; identity: RestoreIdentity } {
  const absolute = resolve(path)
  assertNoSymlinkChain(dirname(absolute))
  const lst = lstatSync(absolute)
  if (lst.isSymbolicLink() || !lst.isFile())
    throw new Error('Path must be a regular non-symbolic file.')
  const st = statSync(absolute, { bigint: true })
  if (st.dev === 0n || st.ino === 0n) throw new Error('Stable file identity unavailable.')
  return {
    realPath: normalize(realpathSync(absolute)),
    identity: {
      dev: String(st.dev),
      ino: String(st.ino),
      size: String(st.size),
      mtimeNs: String(st.mtimeNs)
    }
  }
}
function assertNoSymlinkChain(path: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    current = join(current, part)
    const st = lstatSync(current)
    if (st.isSymbolicLink()) throw new Error(`Symlink parent is forbidden: ${current}`)
    if (process.platform === 'win32' && normalize(realpathSync(current)) !== normalize(current))
      throw new Error(`Reparse-point parent is forbidden: ${current}`)
  }
}
function publishNoReplace(source: string, target: string): void {
  linkSync(source, target)
}
function assertIdentity(path: string, expected: RestoreIdentity): void {
  if (!sameIdentity(inspectRegularFile(path).identity, expected))
    throw new Error('File identity changed.')
}
function assertUnchanged(
  a: ReturnType<typeof inspectRegularFile>,
  b: ReturnType<typeof inspectRegularFile>
): void {
  if (!sameFullIdentity(a.identity, b.identity))
    throw new Error('File identity changed during operation.')
}
function sameIdentity(a: RestoreIdentity, b: RestoreIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
function sameFullIdentity(a: RestoreIdentity, b: RestoreIdentity): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
}
function unlinkRequiredOwned(path: string, identity: RestoreIdentity): void {
  if (!existsSync(path)) return
  assertIdentity(path, identity)
  unlinkSync(path)
}
function unlinkIfOwned(path: string, identity: RestoreIdentity): void {
  try {
    unlinkRequiredOwned(path, identity)
  } catch {
    // Preserve the primary error and never remove a path whose identity is uncertain.
  }
}
function assertDistinct(path: string, ...others: string[]): void {
  const first = normalize(path)
  if (others.some((value) => normalize(value) === first))
    throw new Error('Backup, target, rollback, partial, and journal paths must be distinct.')
}
function normalize(path: string): string {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function hasSidecars(path: string): boolean {
  return ['-wal', '-shm'].some((suffix) => existsSync(`${path}${suffix}`))
}
function assertNoSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm'])
    if (existsSync(`${path}${suffix}`)) throw new Error(`SQLite sidecar exists: ${path}${suffix}`)
}
function requireDiskPath(path: string, name: string): string {
  requirePath(path)
  if (path === ':memory:') throw new Error(`${name} must be file-backed.`)
  return path
}
function requirePath(path: string): void {
  if (typeof path !== 'string' || path.trim().length === 0)
    throw new TypeError('Path must be non-empty.')
}
function normalizeHash(value: string): string {
  if (typeof value !== 'string' || !/^(sha256:)?[a-fA-F0-9]{64}$/.test(value))
    throw new TypeError('expectedSha256 is invalid.')
  return value.replace(/^sha256:/i, '').toLowerCase()
}
function safeHashEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
async function hashFileStable(path: string): Promise<{ sha256: string; size: number }> {
  const before = inspectRegularFile(path)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const after = inspectRegularFile(path)
  assertUnchanged(before, after)
  const size = BigInt(after.identity.size)
  if (size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('File size exceeds JSON safe integer range.')
  return { sha256: hash.digest('hex'), size: Number(size) }
}
function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function fsyncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
    if (!(process.platform === 'win32' && ['EINVAL', 'EPERM', 'EBADF'].includes(code))) throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
async function recoverBackupJournal(
  targetInput: string,
  sourcePath: string
): Promise<BackupManifest | null> {
  const targetPath = resolve(targetInput)
  const journalPath = `${targetPath}.backup-journal.json`
  if (!existsSync(journalPath)) return null
  const journalFile = inspectRegularFile(journalPath)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(journalPath, 'utf8'))
  } catch (cause) {
    throw new Error(`Backup journal requires manual recovery: ${journalPath}`, { cause })
  }
  assertIdentity(journalPath, journalFile.identity)
  if (!isBackupJournal(value))
    throw new Error(`Backup journal requires manual recovery: ${journalPath}`)
  const journal = value
  const parent = normalize(dirname(targetPath))
  if (
    normalize(journal.targetPath) !== normalize(targetPath) ||
    normalize(journal.sourcePath) !== normalize(sourcePath) ||
    normalize(dirname(journal.partialPath)) !== parent ||
    normalize(dirname(journalPath)) !== parent
  )
    throw new Error(`Backup journal paths require manual recovery: ${journalPath}`)
  assertDistinct(journal.targetPath, journal.sourcePath, journal.partialPath, journalPath)
  const partial = inspectObserved(journal.partialPath)
  const target = inspectObserved(journal.targetPath)
  if (partial && !sameFullIdentity(partial.identity, journal.partialIdentity))
    throw new Error(`Backup partial identity requires manual recovery: ${journal.partialPath}`)
  if (target && !sameIdentity(target.identity, journal.partialIdentity))
    throw new Error(`Backup target identity requires manual recovery: ${journal.targetPath}`)

  if (!target) {
    if (journal.stage !== 'partial-ready' || journal.targetIdentity !== null)
      throw new Error(`Backup journal state requires manual recovery: ${journalPath}`)
    if (partial) unlinkRequiredOwned(journal.partialPath, journal.partialIdentity)
    unlinkRequiredOwned(journalPath, journalFile.identity)
    fsyncDirectory(dirname(targetPath))
    return null
  }

  if (journal.stage === 'target-published') {
    if (!journal.targetIdentity || !sameIdentity(target.identity, journal.targetIdentity))
      throw new Error(`Backup target identity requires manual recovery: ${journal.targetPath}`)
  }
  validateFile(targetPath)
  const hash = await hashFileStable(targetPath)
  if (!safeHashEqual(hash.sha256, journal.expectedHash))
    throw new Error(`Backup target hash requires manual recovery: ${journal.targetPath}`)
  if (partial) unlinkRequiredOwned(journal.partialPath, journal.partialIdentity)
  unlinkRequiredOwned(journalPath, journalFile.identity)
  fsyncDirectory(dirname(targetPath))
  return deepFreeze({ ...journal.manifest, backupPath: realpathSync(targetPath) })
}

function isBackupJournal(value: unknown): value is BackupJournal {
  if (
    !isPlainRecord(value) ||
    !hasExactlyOwnFields(value, [
      'kind',
      'version',
      'stage',
      'sourcePath',
      'targetPath',
      'partialPath',
      'expectedHash',
      'partialIdentity',
      'targetIdentity',
      'manifest'
    ])
  )
    return false
  if (
    value.kind !== 'magic-agent-event-store-backup-journal' ||
    value.version !== 1 ||
    !['partial-ready', 'target-published'].includes(String(value.stage)) ||
    !isAbsoluteString(value.sourcePath) ||
    !isAbsoluteString(value.targetPath) ||
    !isAbsoluteString(value.partialPath) ||
    typeof value.expectedHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expectedHash) ||
    !isIdentity(value.partialIdentity) ||
    !(value.targetIdentity === null || isIdentity(value.targetIdentity)) ||
    !isPlainRecord(value.manifest)
  )
    return false
  const manifest = value.manifest
  return (
    hasExactlyOwnFields(manifest, [
      'kind',
      'backupPath',
      'sourcePath',
      'sha256',
      'size',
      'createdAt',
      'schemaVersion',
      'counts',
      'sqliteVersion'
    ]) &&
    manifest.kind === 'magic-agent-event-store-backup' &&
    isAbsoluteString(manifest.backupPath) &&
    isAbsoluteString(manifest.sourcePath) &&
    manifest.backupPath === value.targetPath &&
    manifest.sourcePath === value.sourcePath &&
    manifest.sha256 === `sha256:${value.expectedHash}` &&
    Number.isSafeInteger(manifest.size) &&
    typeof manifest.createdAt === 'number' &&
    Number.isFinite(manifest.createdAt) &&
    manifest.schemaVersion === 3 &&
    isPlainRecord(manifest.counts) &&
    typeof manifest.sqliteVersion === 'string'
  )
}

function writeAtomicJournal(path: string, journal: BackupJournal): void {
  const temp = `${path}.tmp-${randomUUID()}`
  writeFileSync(temp, JSON.stringify(journal), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const tempIdentity = inspectRegularFile(temp).identity
  try {
    fsyncFile(temp)
    if (!existsSync(path)) publishNoReplace(temp, path)
    else {
      const old = inspectRegularFile(path).identity
      renameSync(temp, path)
      void old
    }
    fsyncFile(path)
    fsyncDirectory(dirname(path))
  } finally {
    if (existsSync(temp)) unlinkIfOwned(temp, tempIdentity)
  }
}

function writeStage(path: string, journal: RestoreJournal, stage: RestoreStage): RestoreJournal {
  const next = { ...journal, stage }
  writeJournal(path, next)
  return next
}
function writeJournal(path: string, journal: RestoreJournal): void {
  const temp = `${path}.tmp-${randomUUID()}`
  writeFileSync(temp, JSON.stringify(journal), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const tempIdentity = inspectRegularFile(temp).identity
  try {
    fsyncFile(temp)
    if (!existsSync(path)) {
      publishNoReplace(temp, path)
    } else {
      const oldIdentity = ownedJournalIdentities.get(normalize(path))
      if (!oldIdentity) throw new Error('Journal ownership is unavailable for update.')
      assertIdentity(path, oldIdentity)
      renameSync(temp, path)
    }
    fsyncFile(path)
    fsyncDirectory(dirname(path))
    ownedJournalIdentities.set(normalize(path), inspectRegularFile(path).identity)
  } finally {
    if (existsSync(temp)) unlinkIfOwned(temp, tempIdentity)
  }
}
async function readJournal(path: string, expectedTarget: string): Promise<JournalRead> {
  assertNoSymlinkChain(dirname(path))
  const journalFile = inspectRegularFile(path)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new RestoreRecoveryRequiredError('journal-invalid', cause)
  }
  assertIdentity(path, journalFile.identity)
  if (!isPlainRecord(value)) throw new RestoreRecoveryRequiredError('journal-invalid')
  const fields = [
    'kind',
    'version',
    'stage',
    'targetPath',
    'backupPath',
    'partialPath',
    'rollbackPath',
    'expectedSha256',
    'replacedExisting',
    'backupIdentity',
    'partialIdentity',
    'targetIdentity',
    'rollbackIdentity'
  ]
  if (!hasExactlyOwnFields(value, fields)) throw new RestoreRecoveryRequiredError('journal-fields')
  if (value.kind !== 'magic-agent-event-store-restore-journal' || value.version !== 2)
    throw new RestoreRecoveryRequiredError('journal-version')
  if (!isRestoreStage(value.stage)) throw new RestoreRecoveryRequiredError('journal-stage')
  if (
    !isAbsoluteString(value.targetPath) ||
    !isAbsoluteString(value.backupPath) ||
    !isAbsoluteString(value.partialPath) ||
    !(value.rollbackPath === null || isAbsoluteString(value.rollbackPath)) ||
    typeof value.expectedSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expectedSha256) ||
    typeof value.replacedExisting !== 'boolean' ||
    !isIdentity(value.backupIdentity) ||
    !isIdentity(value.partialIdentity) ||
    !(value.targetIdentity === null || isIdentity(value.targetIdentity)) ||
    !(value.rollbackIdentity === null || isIdentity(value.rollbackIdentity))
  )
    throw new RestoreRecoveryRequiredError('journal-invalid')

  const journal = value as RestoreJournal
  if (normalize(journal.targetPath) !== normalize(expectedTarget))
    throw new RestoreRecoveryRequiredError('journal-target')
  const parent = normalize(dirname(expectedTarget))
  for (const pathValue of [journal.targetPath, journal.partialPath, journal.rollbackPath, path]) {
    if (pathValue && normalize(dirname(pathValue)) !== parent)
      throw new RestoreRecoveryRequiredError('journal-path')
  }
  assertDistinct(
    journal.targetPath,
    journal.backupPath,
    journal.partialPath,
    path,
    ...(journal.rollbackPath ? [journal.rollbackPath] : [])
  )
  if (
    journal.replacedExisting !== Boolean(journal.targetIdentity) ||
    journal.replacedExisting !== Boolean(journal.rollbackPath) ||
    (!journal.replacedExisting && journal.rollbackIdentity !== null) ||
    (journal.rollbackIdentity !== null &&
      (!journal.targetIdentity || !sameIdentity(journal.rollbackIdentity, journal.targetIdentity)))
  )
    throw new RestoreRecoveryRequiredError('journal-consistency')
  if (
    sameIdentity(journal.backupIdentity, journal.partialIdentity) ||
    (journal.targetIdentity && sameIdentity(journal.backupIdentity, journal.targetIdentity)) ||
    (journal.rollbackIdentity && sameIdentity(journal.backupIdentity, journal.rollbackIdentity))
  )
    throw new RestoreRecoveryRequiredError('journal-alias')

  let backup: ReturnType<typeof inspectRegularFile>
  try {
    backup = inspectRegularFile(journal.backupPath)
  } catch (cause) {
    throw new RestoreRecoveryRequiredError('journal-backup', cause)
  }
  if (!sameFullIdentity(backup.identity, journal.backupIdentity))
    throw new RestoreRecoveryRequiredError('journal-backup-identity')
  const backupHash = await hashFileStable(journal.backupPath)
  if (!safeHashEqual(journal.expectedSha256, backupHash.sha256))
    throw new RestoreRecoveryRequiredError('journal-backup-hash')
  assertIdentity(path, journalFile.identity)
  return { journal, identity: journalFile.identity }
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function hasExactlyOwnFields(value: Record<string, unknown>, fields: string[]): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  )
}
function isAbsoluteString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value)
}
function isIdentity(value: unknown): value is RestoreIdentity {
  if (!isPlainRecord(value) || !hasExactlyOwnFields(value, ['dev', 'ino', 'size', 'mtimeNs']))
    return false
  return ['dev', 'ino', 'size', 'mtimeNs'].every(
    (field) => typeof value[field] === 'string' && /^(0|[1-9][0-9]*)$/.test(value[field] as string)
  )
}
function isRestoreStage(value: unknown): value is RestoreStage {
  return (
    typeof value === 'string' &&
    [
      'prepared',
      'rollback-linking',
      'rollback-linked',
      'target-removing',
      'target-removed',
      'target-linking',
      'target-linked',
      'verifying',
      'verified'
    ].includes(value)
  )
}
function removeJournalRead(path: string, identity: RestoreIdentity): void {
  unlinkRequiredOwned(path, identity)
  ownedJournalIdentities.delete(normalize(path))
}
function unlinkJournal(path: string): void {
  const identity = inspectRegularFile(path).identity
  unlinkRequiredOwned(path, identity)
  ownedJournalIdentities.delete(normalize(path))
}
function simulateCrash(stage: RestoreStage): void {
  stageHook?.(stage)
  if (faultStage === stage) throw new SimulatedCrashError(stage)
}
function requireTimestamp(value?: number): number {
  const result = value ?? Date.now()
  if (!Number.isFinite(result) || result < 0)
    throw new RangeError('createdAt must be finite and non-negative.')
  return result
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const _backupRestoreTesting = Object.freeze({
  setFaultStage(stage: RestoreStage | null): void {
    faultStage = stage
  },
  setStageHook(hook: ((stage: RestoreStage) => void) | null): void {
    stageHook = hook
  },
  setFailAfterPartialInspect(enabled: boolean): void {
    failAfterPartialInspect = enabled
  },
  captureIdentity(path: string): RestoreIdentity {
    return inspectRegularFile(path).identity
  },
  journalPath(targetPath: string): string {
    return `${absoluteInput(targetPath)}.restore-journal.json`
  },
  writeJournal(path: string, journal: RestoreJournal): void {
    writeJournal(path, journal)
  }
})
