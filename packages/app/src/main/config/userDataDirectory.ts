import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import { resolveStorageLayout, STORAGE_DATA_DIRNAME } from '@shared/storageLayout'
import {
  readTestUiEnv,
  resolveConfiguredDesktopPath,
  resolveTestArtifactPath,
  resolveTestUiPolicy
} from '../testUiPolicy'
import {
  getDefaultPortableStorageRoot,
  getDefaultPortableUserDataDirectory,
  getLegacyPortableUserDataDirectory,
  getPortableUserDataBootstrapPath,
  getPortableUserDataBootstrapPaths,
  LEGACY_BOOTSTRAPS_RETIRED_FIELD,
  STORAGE_ROOT_OVERRIDE_ENV,
  USER_DATA_BOOTSTRAP_FILENAME,
  USER_DATA_OVERRIDE_ENV
} from './portablePaths'

const KNOWN_DATA_MARKERS = new Set([
  'config.json',
  USER_DATA_BOOTSTRAP_FILENAME,
  'qApps',
  'customSkills',
  'automationSchemes',
  'targetSchemes',
  'customChecks',
  'chat-workspaces',
  'chat-sessions.json',
  'window-state.json',
  'Partitions'
])
const KNOWN_STORAGE_ROOT_MARKERS = new Set(['Data', 'Projects', 'AutoSave'])

type PendingAutoSaveMigration = {
  source: string
  targetSubdirectory?: string
  copiedProjectsRelativePath?: string
  completed?: boolean
}

type BootstrapState = {
  customStorageRoot?: string
  customUserDataDir?: string
  pendingMigrationFrom?: string
  pendingProjectsFrom?: string
  pendingAutoSaveFrom?: string
  pendingAutoSaveFromSecondary?: string
  pendingAutoSaveMigrations?: PendingAutoSaveMigration[]
  legacyBootstrapsRetired?: boolean
}

export type UserDataDirectorySource = 'default' | 'persisted' | 'env'

export type CurrentUserDataDirectoryState = {
  currentPath: string
  defaultPath: string
  isCustom: boolean
  source: UserDataDirectorySource
  storageRoot: string
  defaultStorageRoot: string
  projectRoot: string
  autoSaveRoot: string
  legacyLayout: boolean
}

export type ResolvedStartupUserDataDirectory = {
  path: string
  source: UserDataDirectorySource
  storageRoot: string
  projectRoot: string
  autoSaveRoot: string
  legacyLayout: boolean
}

type DirectoryClassification = 'missing-or-empty' | 'existing-user-data' | 'nonempty-foreign'
type StorageRootClassification = 'missing-or-empty' | 'existing-storage-root' | 'nonempty-foreign'

function sanitizeText(text: string): string {
  return text.replace(/\uFEFF/g, '').replaceAll('\0', '')
}

function cleanPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? path.resolve(trimmed) : null
}

function normalizePathKey(targetPath: string): string {
  const normalized = path.resolve(targetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSamePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right)
}

function isNestedPath(baseDir: string, candidateDir: string): boolean {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidateDir))
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function isSameOrNestedPath(baseDir: string, candidateDir: string): boolean {
  return isSamePath(baseDir, candidateDir) || isNestedPath(baseDir, candidateDir)
}

function pathExistsSync(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath)
    return true
  } catch {
    return false
  }
}

function filesHaveSameContentsSync(leftPath: string, rightPath: string): boolean {
  const leftFd = fs.openSync(leftPath, 'r')
  const rightFd = fs.openSync(rightPath, 'r')
  const leftBuffer = Buffer.allocUnsafe(64 * 1024)
  const rightBuffer = Buffer.allocUnsafe(64 * 1024)

  try {
    let leftBytesRead: number
    let rightBytesRead: number
    do {
      leftBytesRead = fs.readSync(leftFd, leftBuffer, 0, leftBuffer.length, null)
      rightBytesRead = fs.readSync(rightFd, rightBuffer, 0, rightBuffer.length, null)
      if (
        leftBytesRead !== rightBytesRead ||
        !leftBuffer.subarray(0, leftBytesRead).equals(rightBuffer.subarray(0, rightBytesRead))
      ) {
        return false
      }
    } while (leftBytesRead > 0)
    return true
  } finally {
    fs.closeSync(leftFd)
    fs.closeSync(rightFd)
  }
}

type CanonicalPathInfo = {
  resolvedPath: string
  canonicalPath: string
  exists: boolean
  stats?: fs.Stats
}

type PendingCopyResult = 'completed' | 'retry'

type PendingMigrationResult = {
  bootstrap: BootstrapState
  completed: boolean
  recoverableDataRoot?: string
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isRetryableFileSystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return (
    isMissingPathError(error) ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EBUSY' ||
    code === 'EIO'
  )
}

function isUnavailableDirectoryError(error: unknown): boolean {
  return (
    isRetryableFileSystemError(error) ||
    (error instanceof Error && error.message.includes('must be a real directory'))
  )
}

/** Resolves through the nearest existing ancestor and rejects links/junctions in parent paths. */
function resolveCanonicalPathSync(targetPath: string, label: string): CanonicalPathInfo {
  const resolvedPath = path.resolve(targetPath)
  let existingPath = resolvedPath
  const missingSegments: string[] = []
  let stats: fs.Stats

  while (true) {
    try {
      stats = fs.lstatSync(existingPath)
      break
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parentPath = path.dirname(existingPath)
      if (isSamePath(parentPath, existingPath)) throw error
      missingSegments.unshift(path.basename(existingPath))
      existingPath = parentPath
    }
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Migration conflict: ${label} must not be a symbolic link or junction.`)
  }
  if (missingSegments.length > 0 && !stats.isDirectory()) {
    throw new Error(`Migration conflict: the existing ancestor of ${label} must be a directory.`)
  }

  const canonicalAncestor = fs.realpathSync.native(existingPath)
  if (!isSamePath(existingPath, canonicalAncestor)) {
    throw new Error(
      `Migration conflict: ${label} traverses a symbolic link, junction, or path alias.`
    )
  }
  const canonicalPath = path.resolve(canonicalAncestor, ...missingSegments)
  if (!isSameOrNestedPath(canonicalAncestor, canonicalPath)) {
    throw new Error(`Migration conflict: ${label} escapes its canonical ancestor.`)
  }

  return {
    resolvedPath,
    canonicalPath,
    exists: missingSegments.length === 0,
    stats: missingSegments.length === 0 ? stats : undefined
  }
}

function assertCanonicalRealDirectorySync(targetPath: string, label: string): CanonicalPathInfo {
  const info = resolveCanonicalPathSync(targetPath, label)
  if (!info.exists || info.stats?.isSymbolicLink() || !info.stats?.isDirectory()) {
    throw new Error(`Migration conflict: ${label} must be a real directory.`)
  }
  return info
}

function assertCanonicalContainment(
  baseCanonicalPath: string,
  candidateCanonicalPath: string,
  label: string,
  allowSame = true
): void {
  const contained = allowSame
    ? isSameOrNestedPath(baseCanonicalPath, candidateCanonicalPath)
    : isNestedPath(baseCanonicalPath, candidateCanonicalPath)
  if (!contained) {
    throw new Error(`Migration conflict: ${label} escapes its canonical migration root.`)
  }
}

function assertNoCanonicalOverlap(source: CanonicalPathInfo, target: CanonicalPathInfo): void {
  if (
    isSameOrNestedPath(source.canonicalPath, target.canonicalPath) ||
    isSameOrNestedPath(target.canonicalPath, source.canonicalPath)
  ) {
    throw new Error('Migration conflict: source and target directories must not overlap.')
  }
}

function assertCanonicalRealFileSync(
  targetPath: string,
  label: string,
  canonicalRoot: string
): CanonicalPathInfo {
  const info = resolveCanonicalPathSync(targetPath, label)
  if (!info.exists || info.stats?.isSymbolicLink() || !info.stats?.isFile()) {
    throw new Error(`Migration conflict: ${label} must be a real file.`)
  }
  assertCanonicalContainment(canonicalRoot, info.canonicalPath, label)
  return info
}

function copyDirectorySync(
  sourceDir: string,
  targetDir: string,
  sourceCanonicalRoot?: string,
  targetCanonicalRoot?: string
): void {
  const source = assertCanonicalRealDirectorySync(sourceDir, 'migration source')
  const target = assertCanonicalRealDirectorySync(targetDir, 'migration target')
  const canonicalSourceRoot = sourceCanonicalRoot ?? source.canonicalPath
  const canonicalTargetRoot = targetCanonicalRoot ?? target.canonicalPath
  assertCanonicalContainment(canonicalSourceRoot, source.canonicalPath, 'migration source')
  assertCanonicalContainment(canonicalTargetRoot, target.canonicalPath, 'migration target')
  assertNoCanonicalOverlap(source, target)
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      const sourceChild = assertCanonicalRealDirectorySync(sourcePath, sourcePath)
      assertCanonicalContainment(canonicalSourceRoot, sourceChild.canonicalPath, sourcePath)
      let targetChild = resolveCanonicalPathSync(targetPath, targetPath)
      assertCanonicalContainment(canonicalTargetRoot, targetChild.canonicalPath, targetPath)
      assertNoCanonicalOverlap(sourceChild, targetChild)
      if (targetChild.exists) {
        if (targetChild.stats?.isSymbolicLink() || !targetChild.stats?.isDirectory()) {
          throw new Error(`Migration conflict: ${targetPath} must be a real directory.`)
        }
      } else {
        fs.mkdirSync(targetPath)
      }
      // Verify again after creation; a path can be replaced by a junction between operations.
      targetChild = assertCanonicalRealDirectorySync(targetPath, targetPath)
      assertCanonicalContainment(canonicalTargetRoot, targetChild.canonicalPath, targetPath)
      assertNoCanonicalOverlap(sourceChild, targetChild)
      copyDirectorySync(sourcePath, targetPath, canonicalSourceRoot, canonicalTargetRoot)
      continue
    }

    if (entry.isFile()) {
      const sourceFile = assertCanonicalRealFileSync(sourcePath, sourcePath, canonicalSourceRoot)
      const targetFile = resolveCanonicalPathSync(targetPath, targetPath)
      assertCanonicalContainment(canonicalTargetRoot, targetFile.canonicalPath, targetPath)
      if (!targetFile.exists) {
        fs.copyFileSync(sourcePath, targetPath)
        assertCanonicalRealFileSync(targetPath, targetPath, canonicalTargetRoot)
        continue
      }
      if (
        targetFile.stats?.isSymbolicLink() ||
        !targetFile.stats?.isFile() ||
        !filesHaveSameContentsSync(sourceFile.resolvedPath, targetFile.resolvedPath)
      ) {
        throw new Error(`Migration conflict: ${targetPath} already exists with different contents.`)
      }
      continue
    }

    throw new Error(`Migration conflict: unsupported source entry ${sourcePath}.`)
  }
}

function directoryHasEntriesSync(targetPath: string): boolean {
  if (!pathExistsSync(targetPath)) return false
  try {
    return fs.statSync(targetPath).isDirectory() && fs.readdirSync(targetPath).length > 0
  } catch {
    return false
  }
}

function getBootstrapFilePath(): string {
  return getPortableUserDataBootstrapPath()
}

function ensureBootstrapParentSync(): void {
  fs.mkdirSync(path.dirname(getBootstrapFilePath()), { recursive: true })
}

async function ensureBootstrapParent(): Promise<void> {
  await fsp.mkdir(path.dirname(getBootstrapFilePath()), { recursive: true })
}

function parseSafeRelativeSegments(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) return null
  // Bootstrap files may move between platforms, so reject both separator forms everywhere.
  const segments = value.split(/[\\/]/u)
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\0') ||
        segment.trim() !== segment ||
        /^[a-zA-Z]:/u.test(segment)
    )
  ) {
    return null
  }
  return segments
}

function normalizeTargetSubdirectory(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  const segments = parseSafeRelativeSegments(value)
  return segments?.length === 2 && segments[0] === 'Projects' ? path.join(...segments) : null
}

function normalizeCopiedProjectsRelativePath(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  const segments = parseSafeRelativeSegments(value)
  if (!segments) return null
  if (segments.length === 1 && (segments[0] === '.AutoSave' || segments[0] === 'AutoSave')) {
    return segments[0]
  }
  return segments.length === 2 && segments[1] === '.AutoSave' ? path.join(...segments) : null
}

function normalizePendingAutoSaveMigration(value: unknown): PendingAutoSaveMigration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const migration = value as Record<string, unknown>
  const source = typeof migration.source === 'string' ? cleanPath(migration.source) : null
  const targetSubdirectory = normalizeTargetSubdirectory(migration.targetSubdirectory)
  const copiedProjectsRelativePath = normalizeCopiedProjectsRelativePath(
    migration.copiedProjectsRelativePath
  )
  if (!source || targetSubdirectory === null || copiedProjectsRelativePath === null) return null
  if (migration.completed !== undefined && migration.completed !== true) return null
  const allowedKeys = new Set([
    'source',
    'targetSubdirectory',
    'copiedProjectsRelativePath',
    'completed'
  ])
  if (Object.keys(migration).some((key) => !allowedKeys.has(key))) return null
  return {
    source,
    targetSubdirectory,
    copiedProjectsRelativePath,
    completed: migration.completed === true || undefined
  }
}

function normalizeBootstrapState(state: BootstrapState): BootstrapState {
  const pendingAutoSaveMigrations = Array.isArray(state.pendingAutoSaveMigrations)
    ? state.pendingAutoSaveMigrations.flatMap((value) => {
        const migration = normalizePendingAutoSaveMigration(value)
        return migration ? [migration] : []
      })
    : undefined
  return {
    customStorageRoot: cleanPath(state.customStorageRoot) ?? undefined,
    customUserDataDir: cleanPath(state.customUserDataDir) ?? undefined,
    pendingMigrationFrom: cleanPath(state.pendingMigrationFrom) ?? undefined,
    pendingProjectsFrom: cleanPath(state.pendingProjectsFrom) ?? undefined,
    pendingAutoSaveFrom: cleanPath(state.pendingAutoSaveFrom) ?? undefined,
    pendingAutoSaveFromSecondary: cleanPath(state.pendingAutoSaveFromSecondary) ?? undefined,
    pendingAutoSaveMigrations: pendingAutoSaveMigrations?.length
      ? pendingAutoSaveMigrations
      : undefined,
    legacyBootstrapsRetired: state.legacyBootstrapsRetired === true || undefined
  }
}

function hasActiveBootstrapState(state: BootstrapState): boolean {
  return Boolean(
    state.customStorageRoot ||
    state.customUserDataDir ||
    state.pendingMigrationFrom ||
    state.pendingProjectsFrom ||
    state.pendingAutoSaveFrom ||
    state.pendingAutoSaveFromSecondary ||
    state.pendingAutoSaveMigrations?.length
  )
}

function retireLegacyBootstrapFilesSync(): void {
  const primaryBootstrapPath = getBootstrapFilePath()
  for (const bootstrapPath of getPortableUserDataBootstrapPaths().slice(1)) {
    if (!isSamePath(bootstrapPath, primaryBootstrapPath)) {
      try {
        fs.rmSync(bootstrapPath, { force: true })
      } catch (error) {
        console.warn(`[UserData] Failed to retire legacy bootstrap ${bootstrapPath}:`, error)
      }
    }
  }
}

function readBootstrapSync(): BootstrapState {
  const bootstrapPaths = getPortableUserDataBootstrapPaths()
  const primaryBootstrapPath = bootstrapPaths[0]
  let legacyBootstrapsRetired = false

  for (const [index, bootstrapPath] of bootstrapPaths.entries()) {
    if (index > 0 && legacyBootstrapsRetired) break
    if (!pathExistsSync(bootstrapPath)) continue

    try {
      const raw = JSON.parse(sanitizeText(fs.readFileSync(bootstrapPath, 'utf8'))) as BootstrapState
      const normalized = normalizeBootstrapState(raw)
      if (index === 0) {
        legacyBootstrapsRetired = normalized.legacyBootstrapsRetired === true
      }
      if (hasActiveBootstrapState(normalized)) {
        if (primaryBootstrapPath && !isSamePath(bootstrapPath, primaryBootstrapPath)) {
          writeBootstrapSync({ ...normalized, legacyBootstrapsRetired: true })
          retireLegacyBootstrapFilesSync()
          return { ...normalized, legacyBootstrapsRetired: true }
        }
        return normalized
      }
    } catch (error) {
      console.error(`[UserData] Failed to read bootstrap file ${bootstrapPath}:`, error)
    }
  }

  return legacyBootstrapsRetired ? { legacyBootstrapsRetired: true } : {}
}

function writeBootstrapSync(state: BootstrapState): void {
  const normalized = normalizeBootstrapState(state)
  const bootstrapPath = getBootstrapFilePath()

  if (
    !normalized.customStorageRoot &&
    !normalized.customUserDataDir &&
    !normalized.pendingMigrationFrom &&
    !normalized.pendingProjectsFrom &&
    !normalized.pendingAutoSaveFrom &&
    !normalized.pendingAutoSaveFromSecondary &&
    !normalized.pendingAutoSaveMigrations?.length &&
    !normalized.legacyBootstrapsRetired
  ) {
    try {
      fs.rmSync(bootstrapPath, { force: true })
    } catch (error) {
      console.error('[UserData] Failed to remove bootstrap file:', error)
    }
    return
  }

  ensureBootstrapParentSync()
  const tempPath = `${bootstrapPath}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), 'utf8')
  fs.renameSync(tempPath, bootstrapPath)
  if (normalized.legacyBootstrapsRetired) {
    retireLegacyBootstrapFilesSync()
  }
}

async function writeBootstrap(state: BootstrapState): Promise<void> {
  const normalized = normalizeBootstrapState(state)
  const bootstrapPath = getBootstrapFilePath()

  if (
    !normalized.customStorageRoot &&
    !normalized.customUserDataDir &&
    !normalized.pendingMigrationFrom &&
    !normalized.pendingProjectsFrom &&
    !normalized.pendingAutoSaveFrom &&
    !normalized.pendingAutoSaveFromSecondary &&
    !normalized.pendingAutoSaveMigrations?.length &&
    !normalized.legacyBootstrapsRetired
  ) {
    await fsp.rm(bootstrapPath, { force: true })
    return
  }

  await ensureBootstrapParent()
  const tempPath = `${bootstrapPath}.${Date.now()}.tmp`
  await fsp.writeFile(tempPath, JSON.stringify(normalized, null, 2), 'utf8')
  await fsp.rename(tempPath, bootstrapPath)
  if (normalized.legacyBootstrapsRetired) {
    retireLegacyBootstrapFilesSync()
  }
}

export function getDefaultStorageRoot(): string {
  return getDefaultPortableStorageRoot()
}

export function getDefaultUserDataDirectory(): string {
  return getDefaultPortableUserDataDirectory()
}

function classifyDirectorySync(targetPath: string): DirectoryClassification {
  if (!pathExistsSync(targetPath)) return 'missing-or-empty'

  try {
    const directory = assertCanonicalRealDirectorySync(targetPath, 'storage Data directory')
    const entries = fs.readdirSync(directory.resolvedPath, { withFileTypes: true })
    if (entries.length === 0) return 'missing-or-empty'

    for (const entry of entries) {
      const entryPath = path.join(directory.resolvedPath, entry.name)
      const entryInfo = resolveCanonicalPathSync(entryPath, entryPath)
      if (
        !entryInfo.exists ||
        entryInfo.stats?.isSymbolicLink() ||
        !isSameOrNestedPath(directory.canonicalPath, entryInfo.canonicalPath)
      ) {
        return 'nonempty-foreign'
      }
    }
    const hasKnownMarker = entries.some(
      (entry) => KNOWN_DATA_MARKERS.has(entry.name) || entry.name.startsWith('config.json.broken-')
    )
    return hasKnownMarker ? 'existing-user-data' : 'nonempty-foreign'
  } catch {
    return 'nonempty-foreign'
  }
}

function classifyStorageRootSync(targetPath: string): StorageRootClassification {
  if (!pathExistsSync(targetPath)) return 'missing-or-empty'

  try {
    const root = assertCanonicalRealDirectorySync(targetPath, 'storage root')
    const entries = fs.readdirSync(root.resolvedPath, { withFileTypes: true })
    if (entries.length === 0) return 'missing-or-empty'

    const knownMarkerKeys = new Map(
      [...KNOWN_STORAGE_ROOT_MARKERS].map((marker) => [
        process.platform === 'win32' ? marker.toLowerCase() : marker,
        marker
      ])
    )
    const seenMarkers = new Set<string>()
    for (const entry of entries) {
      const entryKey = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name
      if (entryKey === USER_DATA_BOOTSTRAP_FILENAME) continue
      const canonicalMarker = knownMarkerKeys.get(entryKey)
      if (!canonicalMarker || entry.isSymbolicLink() || !entry.isDirectory()) {
        return 'nonempty-foreign'
      }
      const marker = assertCanonicalRealDirectorySync(
        path.join(root.resolvedPath, entry.name),
        `storage ${entry.name} directory`
      )
      if (!isNestedPath(root.canonicalPath, marker.canonicalPath)) return 'nonempty-foreign'
      seenMarkers.add(canonicalMarker)
    }

    // Projects/AutoSave alone are too easy for an unrelated directory to match. Data must exist,
    // and the root must also contain another layout directory or recognizable application data.
    if (!seenMarkers.has('Data')) return 'nonempty-foreign'
    const dataState = classifyDirectorySync(resolveStorageLayout(root.resolvedPath, path).data)
    if (dataState === 'nonempty-foreign') return 'nonempty-foreign'
    const hasCredibleLayout =
      dataState === 'existing-user-data' ||
      seenMarkers.has('Projects') ||
      seenMarkers.has('AutoSave')
    return hasCredibleLayout ? 'existing-storage-root' : 'nonempty-foreign'
  } catch {
    return 'nonempty-foreign'
  }
}

function removeCopiedProjectEntrySync(
  projectsTarget: string,
  copiedProjectsRelativePath: string | undefined
): void {
  if (!copiedProjectsRelativePath) return
  const normalizedRelativePath = normalizeCopiedProjectsRelativePath(copiedProjectsRelativePath)
  if (!normalizedRelativePath) {
    throw new Error('Migration conflict: invalid copied AutoSave path.')
  }

  const projects = assertCanonicalRealDirectorySync(projectsTarget, 'Projects cleanup root')
  const segments = normalizedRelativePath.split(path.sep)
  let currentPath = projects.resolvedPath
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment)
    const current = resolveCanonicalPathSync(currentPath, 'copied AutoSave cleanup path')
    assertCanonicalContainment(projects.canonicalPath, current.canonicalPath, 'cleanup path', false)
    if (!current.exists) return
    if (current.stats?.isSymbolicLink()) {
      throw new Error('Migration conflict: copied AutoSave cleanup path must not contain links.')
    }
    if (!current.stats?.isDirectory()) {
      throw new Error('Migration conflict: copied AutoSave cleanup path must be a directory.')
    }
  }

  // Resolve once more immediately before recursive deletion.
  const copied = assertCanonicalRealDirectorySync(currentPath, 'copied AutoSave cleanup path')
  assertCanonicalContainment(projects.canonicalPath, copied.canonicalPath, 'cleanup path', false)
  fs.rmSync(copied.resolvedPath, { recursive: true, force: true })
}

function copyPendingDirectorySync(sourceDir: string | null, targetDir: string): PendingCopyResult {
  if (!sourceDir) return 'completed'
  try {
    const source = assertCanonicalRealDirectorySync(sourceDir, 'migration source')
    const targetProjection = resolveCanonicalPathSync(targetDir, 'migration target')
    assertNoCanonicalOverlap(source, targetProjection)
    if (fs.readdirSync(source.resolvedPath).length === 0) return 'completed'

    if (!targetProjection.exists) {
      fs.mkdirSync(targetProjection.resolvedPath, { recursive: true })
    }
    const target = assertCanonicalRealDirectorySync(targetDir, 'migration target')
    assertNoCanonicalOverlap(source, target)
    copyDirectorySync(source.resolvedPath, target.resolvedPath)
    return 'completed'
  } catch (error) {
    if (isUnavailableDirectoryError(error)) {
      console.warn(`[UserData] Migration source is temporarily unavailable: ${sourceDir}`, error)
      return 'retry'
    }
    throw error
  }
}

function withoutCompletedPendingField(
  bootstrap: BootstrapState,
  field: keyof Pick<
    BootstrapState,
    | 'pendingMigrationFrom'
    | 'pendingProjectsFrom'
    | 'pendingAutoSaveFrom'
    | 'pendingAutoSaveFromSecondary'
  >
): BootstrapState {
  return { ...bootstrap, [field]: undefined, legacyBootstrapsRetired: true }
}

function getPendingAutoSaveMigrations(bootstrap: BootstrapState): PendingAutoSaveMigration[] {
  if (bootstrap.pendingAutoSaveMigrations?.length) return bootstrap.pendingAutoSaveMigrations

  const projectsFrom = cleanPath(bootstrap.pendingProjectsFrom)
  return [bootstrap.pendingAutoSaveFrom, bootstrap.pendingAutoSaveFromSecondary].flatMap(
    (value) => {
      const source = cleanPath(value)
      if (!source) return []
      return [
        {
          source,
          copiedProjectsRelativePath:
            projectsFrom && isSamePath(path.dirname(source), projectsFrom)
              ? path.basename(source)
              : undefined
        }
      ]
    }
  )
}

function hasPendingMigration(bootstrap: BootstrapState): boolean {
  return Boolean(
    bootstrap.pendingMigrationFrom ||
    bootstrap.pendingProjectsFrom ||
    bootstrap.pendingAutoSaveFrom ||
    bootstrap.pendingAutoSaveFromSecondary ||
    bootstrap.pendingAutoSaveMigrations?.some((migration) => !migration.completed)
  )
}

function maybeMigratePendingDataSync(bootstrap: BootstrapState): PendingMigrationResult {
  let remaining = bootstrap
  const recoverableDataRoot = cleanPath(bootstrap.pendingMigrationFrom)
  const customStorageRoot = cleanPath(bootstrap.customStorageRoot)
  const targetDataDir = customStorageRoot
    ? resolveStorageLayout(customStorageRoot, path).data
    : (cleanPath(bootstrap.customUserDataDir) ?? getDefaultUserDataDirectory())
  const pendingDataFrom = cleanPath(remaining.pendingMigrationFrom)
  const dataCompleted = pendingDataFrom
    ? copyPendingDirectorySync(pendingDataFrom, targetDataDir) === 'completed'
    : true

  const targetStorageRoot =
    customStorageRoot ?? (bootstrap.customUserDataDir ? null : getDefaultStorageRoot())
  if (!targetStorageRoot) {
    return {
      bootstrap: remaining,
      completed: !hasPendingMigration(remaining),
      recoverableDataRoot: recoverableDataRoot ?? undefined
    }
  }

  if (pendingDataFrom && (!dataCompleted || !pathExistsSync(pendingDataFrom))) {
    return {
      bootstrap: remaining,
      completed: false,
      recoverableDataRoot: recoverableDataRoot ?? undefined
    }
  }

  const layout = resolveStorageLayout(targetStorageRoot, path)
  const projectsFrom = cleanPath(remaining.pendingProjectsFrom)
  const autoSaveMigrations = getPendingAutoSaveMigrations(remaining)
  const projectsCompleted = projectsFrom
    ? copyPendingDirectorySync(projectsFrom, layout.projects) === 'completed'
    : true
  const migrationStates: Array<PendingAutoSaveMigration | null> = [...autoSaveMigrations]

  const persistMigrationStates = (): void => {
    const pendingAutoSaveMigrations = migrationStates.filter(
      (migration): migration is PendingAutoSaveMigration => migration !== null
    )
    remaining = {
      ...remaining,
      pendingAutoSaveFrom: undefined,
      pendingAutoSaveFromSecondary: undefined,
      pendingAutoSaveMigrations: pendingAutoSaveMigrations.length
        ? pendingAutoSaveMigrations
        : undefined,
      legacyBootstrapsRetired: true
    }
    writeBootstrapSync(remaining)
  }

  for (let index = 0; index < migrationStates.length; index += 1) {
    const migration = migrationStates[index]
    if (!migration) continue
    if (!migration.completed) {
      const target = migration.targetSubdirectory
        ? path.join(layout.autoSave, migration.targetSubdirectory)
        : layout.autoSave
      if (copyPendingDirectorySync(migration.source, target) === 'retry') continue

      // Persist the entire list before cleanup. A crash cannot discard completed cleanup work for
      // this entry or pending work for another AutoSave source.
      migrationStates[index] = { ...migration, completed: true }
      persistMigrationStates()
    }

    const completedMigration = migrationStates[index]
    if (!completedMigration) continue
    removeCopiedProjectEntrySync(layout.projects, completedMigration.copiedProjectsRelativePath)
    // Projects is recopied on every retry. Keep cleanup metadata that can be reconstructed by that
    // copy until every AutoSave item is ready and Projects can be retired atomically with it.
    if (!projectsFrom || !completedMigration.copiedProjectsRelativePath) {
      migrationStates[index] = null
      persistMigrationStates()
    }
  }

  const hasUnfinishedAutoSave = migrationStates.some(
    (migration) => migration !== null && !migration.completed
  )
  if (projectsFrom && projectsCompleted && !hasUnfinishedAutoSave) {
    for (const migration of migrationStates) {
      if (migration) {
        removeCopiedProjectEntrySync(layout.projects, migration.copiedProjectsRelativePath)
      }
    }
    remaining = {
      ...withoutCompletedPendingField(remaining, 'pendingProjectsFrom'),
      pendingAutoSaveFrom: undefined,
      pendingAutoSaveFromSecondary: undefined,
      pendingAutoSaveMigrations: undefined
    }
    writeBootstrapSync(remaining)
  }

  if (
    dataCompleted &&
    remaining.pendingMigrationFrom &&
    !hasPendingMigration({
      ...remaining,
      pendingMigrationFrom: undefined
    })
  ) {
    remaining = withoutCompletedPendingField(remaining, 'pendingMigrationFrom')
    writeBootstrapSync(remaining)
  }

  return {
    bootstrap: remaining,
    completed: !hasPendingMigration(remaining),
    recoverableDataRoot: recoverableDataRoot ?? undefined
  }
}

function maybeMigrateLegacyDefaultDataSync(): void {
  const defaultDir = getDefaultUserDataDirectory()

  const candidates = [getDefaultStorageRoot(), getLegacyPortableUserDataDirectory()].filter(
    (candidate): candidate is string => Boolean(candidate)
  )
  const legacyDir = candidates.find(
    (candidate) =>
      !isSamePath(candidate, defaultDir) &&
      directoryHasEntriesSync(candidate) &&
      classifyDirectorySync(candidate) === 'existing-user-data'
  )
  if (!legacyDir) return

  const legacy = assertCanonicalRealDirectorySync(legacyDir, 'legacy data migration source')
  const targetProjection = resolveCanonicalPathSync(defaultDir, 'default data migration target')
  const targetInsideLegacy = isNestedPath(legacy.canonicalPath, targetProjection.canonicalPath)
  if (!targetInsideLegacy) assertNoCanonicalOverlap(legacy, targetProjection)
  fs.mkdirSync(defaultDir, { recursive: true })
  const target = assertCanonicalRealDirectorySync(defaultDir, 'default data migration target')
  if (!targetInsideLegacy) assertNoCanonicalOverlap(legacy, target)
  for (const entry of fs.readdirSync(legacy.resolvedPath, { withFileTypes: true })) {
    const sourcePath = path.join(legacy.resolvedPath, entry.name)
    if (isSamePath(sourcePath, target.resolvedPath) || KNOWN_STORAGE_ROOT_MARKERS.has(entry.name)) {
      continue
    }
    const targetPath = path.join(target.resolvedPath, entry.name)
    if (entry.isDirectory()) {
      const targetChild = resolveCanonicalPathSync(targetPath, targetPath)
      if (!targetChild.exists) fs.mkdirSync(targetPath)
      copyDirectorySync(sourcePath, targetPath, legacy.canonicalPath, target.canonicalPath)
    } else if (entry.isFile()) {
      const sourceFile = assertCanonicalRealFileSync(sourcePath, sourcePath, legacy.canonicalPath)
      const targetFile = resolveCanonicalPathSync(targetPath, targetPath)
      assertCanonicalContainment(target.canonicalPath, targetFile.canonicalPath, targetPath)
      if (!targetFile.exists) {
        fs.copyFileSync(sourceFile.resolvedPath, targetFile.resolvedPath)
        assertCanonicalRealFileSync(targetFile.resolvedPath, targetPath, target.canonicalPath)
      } else if (
        targetFile.stats?.isSymbolicLink() ||
        !targetFile.stats?.isFile() ||
        !filesHaveSameContentsSync(sourceFile.resolvedPath, targetFile.resolvedPath)
      ) {
        throw new Error(`Migration conflict: ${targetPath} already exists with different contents.`)
      }
    } else {
      throw new Error(`Migration conflict: unsupported source entry ${sourcePath}.`)
    }
  }
}

function resolveDefaultUserDataDirectoryWithMigration(): string {
  maybeMigrateLegacyDefaultDataSync()
  return getDefaultUserDataDirectory()
}

function resolveAutomatedUserDataRoot(): string | null {
  const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())
  if (!testUiPolicy.automatedRun) return null

  return resolveTestArtifactPath({
    desktopPath: resolveConfiguredDesktopPath(app.getPath('desktop')),
    tempPath: app.getPath('temp'),
    policy: testUiPolicy,
    segments: []
  })
}

function resolveAutomatedUserDataDirectory(): { root: string; path: string } | null {
  const automatedRoot = resolveAutomatedUserDataRoot()
  if (!automatedRoot) return null
  return { root: automatedRoot, path: resolveStorageLayout(automatedRoot, path).data }
}

function resolveAutomatedUserDataEnvOverride(
  automatedRoot: string,
  envValue: string | undefined
): string | null {
  const trimmed = envValue?.trim()
  if (!trimmed) return null

  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(automatedRoot, trimmed)
  return isSameOrNestedPath(automatedRoot, candidate) ? candidate : null
}

function buildResolvedLayout(
  userDataDir: string,
  source: UserDataDirectorySource,
  storageRoot?: string | null,
  legacyLayout = false
): ResolvedStartupUserDataDirectory {
  if (storageRoot) {
    const layout = resolveStorageLayout(storageRoot, path)
    for (const targetPath of [layout.root, layout.data, layout.projects, layout.autoSave]) {
      fs.mkdirSync(targetPath, { recursive: true })
    }
    return {
      path: layout.data,
      source,
      storageRoot: layout.root,
      projectRoot: layout.projects,
      autoSaveRoot: layout.autoSave,
      legacyLayout: false
    }
  }

  const resolvedUserData = path.resolve(userDataDir)
  fs.mkdirSync(resolvedUserData, { recursive: true })
  return {
    path: resolvedUserData,
    source,
    storageRoot: resolvedUserData,
    projectRoot: path.join(resolvedUserData, 'renderer-state', 'project-canvas'),
    autoSaveRoot: path.join(resolvedUserData, 'AutoSave'),
    legacyLayout
  }
}

export function resolveStartupUserDataDirectory(): ResolvedStartupUserDataDirectory {
  const automatedUserDataDir = resolveAutomatedUserDataDirectory()
  if (automatedUserDataDir) {
    const automatedStorageRootOverride = resolveAutomatedUserDataEnvOverride(
      automatedUserDataDir.root,
      process.env[STORAGE_ROOT_OVERRIDE_ENV]
    )
    if (automatedStorageRootOverride) {
      const layout = resolveStorageLayout(automatedStorageRootOverride, path)
      return buildResolvedLayout(layout.data, 'env', layout.root)
    }

    const automatedLegacyOverride = resolveAutomatedUserDataEnvOverride(
      automatedUserDataDir.root,
      process.env[USER_DATA_OVERRIDE_ENV]
    )
    if (automatedLegacyOverride) {
      return buildResolvedLayout(automatedLegacyOverride, 'env', null, true)
    }
    return buildResolvedLayout(automatedUserDataDir.path, 'default', automatedUserDataDir.root)
  }

  const storageRootOverride = cleanPath(process.env[STORAGE_ROOT_OVERRIDE_ENV])
  if (storageRootOverride) {
    const layout = resolveStorageLayout(storageRootOverride, path)
    return buildResolvedLayout(layout.data, 'env', layout.root)
  }

  const legacyUserDataOverride = cleanPath(process.env[USER_DATA_OVERRIDE_ENV])
  if (legacyUserDataOverride) {
    return buildResolvedLayout(legacyUserDataOverride, 'env', null, true)
  }

  const migration = maybeMigratePendingDataSync(readBootstrapSync())
  const bootstrap = migration.bootstrap
  if (!migration.completed) {
    if (migration.recoverableDataRoot) {
      try {
        const recoverableData = assertCanonicalRealDirectorySync(
          migration.recoverableDataRoot,
          'recoverable legacy Data directory'
        )
        return buildResolvedLayout(recoverableData.resolvedPath, 'persisted', null, true)
      } catch (error) {
        if (!isUnavailableDirectoryError(error)) throw error
      }
    }
    throw new Error(
      'Storage migration is still pending because its legacy Data source is unavailable. Restore the source and restart Magic Pot.'
    )
  }

  const storageRoot = cleanPath(bootstrap.customStorageRoot)
  if (storageRoot) {
    const layout = resolveStorageLayout(storageRoot, path)
    return buildResolvedLayout(layout.data, 'persisted', layout.root)
  }

  const legacyPersistedPath = cleanPath(bootstrap.customUserDataDir)
  if (legacyPersistedPath) {
    return buildResolvedLayout(legacyPersistedPath, 'persisted', null, true)
  }

  return buildResolvedLayout(
    resolveDefaultUserDataDirectoryWithMigration(),
    'default',
    getDefaultStorageRoot()
  )
}

function inferStorageRootFromCurrentPath(currentPath: string): {
  root: string
  legacyLayout: boolean
} {
  const normalizedCurrentPath = path.resolve(currentPath)
  if (path.basename(normalizedCurrentPath).toLowerCase() === STORAGE_DATA_DIRNAME.toLowerCase()) {
    return { root: path.dirname(normalizedCurrentPath), legacyLayout: false }
  }
  return { root: normalizedCurrentPath, legacyLayout: true }
}

export function getCurrentUserDataDirectoryState(
  currentPath: string = app.getPath('userData')
): CurrentUserDataDirectoryState {
  const defaultStorageRoot = getDefaultStorageRoot()
  const defaultPath = getDefaultUserDataDirectory()
  const bootstrap = readBootstrapSync()
  const storageRootEnv = cleanPath(process.env[STORAGE_ROOT_OVERRIDE_ENV])
  const legacyUserDataEnv = cleanPath(process.env[USER_DATA_OVERRIDE_ENV])
  const persistedStorageRoot = cleanPath(bootstrap.customStorageRoot)
  const persistedLegacyPath = cleanPath(bootstrap.customUserDataDir)
  const inferred = inferStorageRootFromCurrentPath(currentPath)
  const legacyLayout = storageRootEnv
    ? false
    : legacyUserDataEnv
      ? true
      : persistedStorageRoot
        ? false
        : persistedLegacyPath
          ? true
          : inferred.legacyLayout
  const storageRoot = legacyLayout
    ? legacyUserDataEnv || persistedLegacyPath || inferred.root
    : storageRootEnv || persistedStorageRoot || inferred.root
  const layout = legacyLayout
    ? {
        root: storageRoot,
        data: legacyUserDataEnv || persistedLegacyPath || path.resolve(currentPath),
        projects: path.join(storageRoot, 'renderer-state', 'project-canvas'),
        autoSave: path.join(storageRoot, 'AutoSave')
      }
    : resolveStorageLayout(storageRoot, path)

  return {
    currentPath: layout.data,
    defaultPath,
    isCustom: !isSamePath(storageRoot, defaultStorageRoot),
    source: storageRootEnv
      ? 'env'
      : legacyUserDataEnv
        ? 'env'
        : persistedStorageRoot
          ? 'persisted'
          : persistedLegacyPath
            ? 'persisted'
            : 'default',
    storageRoot: layout.root,
    defaultStorageRoot,
    projectRoot: layout.projects,
    autoSaveRoot: layout.autoSave,
    legacyLayout
  }
}

export type StorageDirectoryMigrationSources = {
  projectsFrom?: string | null
  autoSaveFrom?: string | null
  autoSaveFromSecondary?: string | null
  autoSaveFromCandidates?: Array<string | null | undefined>
}

export type PreparedUserDataDirectoryChange = {
  changed: boolean
  commit: () => Promise<void>
  rollback: () => Promise<void>
}

async function restoreBootstrapSnapshot(
  bootstrapPath: string,
  previousContents: string | null
): Promise<void> {
  if (previousContents === null) {
    await fsp.rm(bootstrapPath, { force: true })
    return
  }
  await ensureBootstrapParent()
  const tempPath = `${bootstrapPath}.${Date.now()}.rollback.tmp`
  await fsp.writeFile(tempPath, previousContents, 'utf8')
  await fsp.rename(tempPath, bootstrapPath)
}

function collectAutoSaveMigrations(
  projectsFrom: string | null,
  candidates: Array<string | null | undefined>
): PendingAutoSaveMigration[] {
  const migrations: PendingAutoSaveMigration[] = []
  const migrationIndexBySource = new Map<string, number>()

  const add = (
    sourceValue: string | null | undefined,
    targetSubdirectory?: string,
    copiedProjectsRelativePath?: string
  ) => {
    const source = cleanPath(sourceValue)
    if (!source || !directoryHasEntriesSync(source)) return
    const sourceInfo = assertCanonicalRealDirectorySync(source, 'AutoSave migration source')
    const normalizedTarget = normalizeTargetSubdirectory(targetSubdirectory)
    const normalizedCopiedPath = normalizeCopiedProjectsRelativePath(copiedProjectsRelativePath)
    if (normalizedTarget === null || normalizedCopiedPath === null) {
      throw new Error('Migration conflict: invalid AutoSave migration metadata.')
    }
    const key = normalizePathKey(sourceInfo.canonicalPath)
    const existingIndex = migrationIndexBySource.get(key)
    if (existingIndex !== undefined) {
      const existing = migrations[existingIndex]
      migrations[existingIndex] = {
        ...existing,
        targetSubdirectory: existing.targetSubdirectory ?? normalizedTarget,
        copiedProjectsRelativePath: existing.copiedProjectsRelativePath ?? normalizedCopiedPath
      }
      return
    }
    migrationIndexBySource.set(key, migrations.length)
    migrations.push({
      source: sourceInfo.resolvedPath,
      targetSubdirectory: normalizedTarget,
      copiedProjectsRelativePath: normalizedCopiedPath
    })
  }

  for (const candidate of candidates) add(candidate)
  if (!projectsFrom || !pathExistsSync(projectsFrom)) return migrations

  const projects = assertCanonicalRealDirectorySync(projectsFrom, 'projects migration source')
  add(path.join(projects.resolvedPath, '.AutoSave'), undefined, '.AutoSave')
  add(path.join(projects.resolvedPath, 'AutoSave'), undefined, 'AutoSave')
  for (const entry of fs.readdirSync(projects.resolvedPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const projectDir = assertCanonicalRealDirectorySync(
      path.join(projects.resolvedPath, entry.name),
      'project migration source'
    )
    assertCanonicalContainment(projects.canonicalPath, projectDir.canonicalPath, entry.name, false)
    const projectRelativePath = path.join(entry.name, '.AutoSave')
    add(
      path.join(projects.resolvedPath, projectRelativePath),
      path.join('Projects', entry.name),
      projectRelativePath
    )
  }
  return migrations
}

export async function beginUserDataDirectoryChange(
  nextPath: string | null,
  currentPath: string,
  migrationSources: StorageDirectoryMigrationSources = {}
): Promise<PreparedUserDataDirectoryChange> {
  const currentState = getCurrentUserDataDirectoryState(currentPath)
  if (currentState.source === 'env') {
    throw new Error(
      `${STORAGE_ROOT_OVERRIDE_ENV} or ${USER_DATA_OVERRIDE_ENV} is forcing the current storage directory. Remove that environment variable before changing it in Settings.`
    )
  }

  const customStorageRoot = cleanPath(nextPath)
  const targetRoot = customStorageRoot ?? currentState.defaultStorageRoot
  const targetLayout = resolveStorageLayout(targetRoot, path)

  if (isSamePath(currentState.storageRoot, targetRoot) && !currentState.legacyLayout) {
    return { changed: false, commit: async () => undefined, rollback: async () => undefined }
  }
  const projectsFrom = cleanPath(migrationSources.projectsFrom) ?? currentState.projectRoot
  const fallbackProjectsFrom = path.join(currentPath, 'renderer-state', 'project-canvas')
  const explicitProjectsFrom = cleanPath(migrationSources.projectsFrom)
  const pendingProjectsFrom = directoryHasEntriesSync(projectsFrom)
    ? projectsFrom
    : directoryHasEntriesSync(fallbackProjectsFrom)
      ? fallbackProjectsFrom
      : explicitProjectsFrom
  const autoSaveMigrations = collectAutoSaveMigrations(pendingProjectsFrom, [
    ...(migrationSources.autoSaveFromCandidates ?? []),
    migrationSources.autoSaveFrom,
    migrationSources.autoSaveFromSecondary,
    currentState.autoSaveRoot
  ])
  const sourceRoots = [
    currentPath,
    currentState.storageRoot,
    currentState.projectRoot,
    currentState.autoSaveRoot,
    projectsFrom,
    fallbackProjectsFrom,
    ...autoSaveMigrations.map(({ source }) => source)
  ].filter((sourceRoot): sourceRoot is string => Boolean(sourceRoot))
  const canonicalSources = sourceRoots.map((sourceRoot) => {
    const source = resolveCanonicalPathSync(sourceRoot, 'migration source')
    if (source.exists && (!source.stats?.isDirectory() || source.stats.isSymbolicLink())) {
      throw new Error('Migration conflict: migration source must be a real directory.')
    }
    return source
  })
  let canonicalTarget = resolveCanonicalPathSync(targetRoot, 'migration target')
  if (
    canonicalSources.some(
      (source) =>
        isSameOrNestedPath(source.canonicalPath, canonicalTarget.canonicalPath) ||
        isSameOrNestedPath(canonicalTarget.canonicalPath, source.canonicalPath)
    )
  ) {
    throw new Error('Please choose a storage root outside the current storage directories.')
  }

  const targetState = classifyStorageRootSync(targetRoot)
  if (targetState === 'nonempty-foreign') {
    throw new Error(
      'The selected directory is not empty and does not look like a Magic Pot storage root. Please choose an empty directory or an existing Magic Pot storage root.'
    )
  }

  if (!canonicalTarget.exists) fs.mkdirSync(canonicalTarget.resolvedPath, { recursive: true })
  canonicalTarget = assertCanonicalRealDirectorySync(targetRoot, 'migration target')
  if (
    canonicalSources.some(
      (source) =>
        isSameOrNestedPath(source.canonicalPath, canonicalTarget.canonicalPath) ||
        isSameOrNestedPath(canonicalTarget.canonicalPath, source.canonicalPath)
    )
  ) {
    throw new Error('Please choose a storage root outside the current storage directories.')
  }

  const migrateIntoTarget = targetState === 'missing-or-empty'
  const nextBootstrap: BootstrapState = {
    customStorageRoot: customStorageRoot ?? undefined,
    pendingMigrationFrom:
      migrateIntoTarget && !isSamePath(currentPath, targetLayout.data) ? currentPath : undefined,
    pendingProjectsFrom:
      migrateIntoTarget &&
      pendingProjectsFrom &&
      !isSamePath(pendingProjectsFrom, targetLayout.projects)
        ? pendingProjectsFrom
        : undefined,
    pendingAutoSaveMigrations: migrateIntoTarget
      ? autoSaveMigrations.filter(({ source }) => !isSamePath(source, targetLayout.autoSave))
      : undefined,
    legacyBootstrapsRetired: true
  }
  const bootstrapPath = getBootstrapFilePath()
  const previousContents = pathExistsSync(bootstrapPath)
    ? await fsp.readFile(bootstrapPath, 'utf8')
    : null
  let committed = false

  return {
    changed: true,
    commit: async () => {
      if (committed) return
      await writeBootstrap(nextBootstrap)
      committed = true
    },
    rollback: async () => {
      if (!committed) return
      await restoreBootstrapSnapshot(bootstrapPath, previousContents)
      committed = false
    }
  }
}

export async function prepareUserDataDirectoryChange(
  nextPath: string | null,
  currentPath: string,
  migrationSources: StorageDirectoryMigrationSources = {}
): Promise<boolean> {
  const prepared = await beginUserDataDirectoryChange(nextPath, currentPath, migrationSources)
  await prepared.commit()
  return prepared.changed
}
