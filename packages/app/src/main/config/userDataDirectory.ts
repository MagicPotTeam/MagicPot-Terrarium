import * as fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import {
  readTestUiEnv,
  resolveConfiguredDesktopPath,
  resolveTestArtifactPath,
  resolveTestUiPolicy
} from '../testUiPolicy'
import {
  getDefaultPortableUserDataDirectory,
  getLegacyPortableUserDataDirectory,
  getPortableUserDataBootstrapPath,
  getPortableUserDataBootstrapPaths,
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

type BootstrapState = {
  customUserDataDir?: string
  pendingMigrationFrom?: string
}

export type UserDataDirectorySource = 'default' | 'persisted' | 'env'

export type CurrentUserDataDirectoryState = {
  currentPath: string
  defaultPath: string
  isCustom: boolean
  source: UserDataDirectorySource
}

export type ResolvedStartupUserDataDirectory = {
  path: string
  source: UserDataDirectorySource
}

type DirectoryClassification = 'missing-or-empty' | 'existing-user-data' | 'nonempty-foreign'

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
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
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

function copyDirectorySync(sourceDir: string, targetDir: string): void {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true })
      copyDirectorySync(sourcePath, targetPath)
      continue
    }

    if (entry.isFile() && !pathExistsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath)
    }
  }
}

function directoryHasEntriesSync(targetPath: string): boolean {
  if (!pathExistsSync(targetPath)) {
    return false
  }

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

function readBootstrapSync(): BootstrapState {
  for (const bootstrapPath of getPortableUserDataBootstrapPaths()) {
    if (!pathExistsSync(bootstrapPath)) {
      continue
    }

    try {
      const raw = JSON.parse(sanitizeText(fs.readFileSync(bootstrapPath, 'utf8'))) as BootstrapState
      const normalized = {
        customUserDataDir: cleanPath(raw.customUserDataDir) ?? undefined,
        pendingMigrationFrom: cleanPath(raw.pendingMigrationFrom) ?? undefined
      }
      if (normalized.customUserDataDir || normalized.pendingMigrationFrom) {
        if (!isSamePath(bootstrapPath, getBootstrapFilePath())) {
          writeBootstrapSync(normalized)
        }
        return normalized
      }
    } catch (error) {
      console.error(`[UserData] Failed to read bootstrap file ${bootstrapPath}:`, error)
    }
  }

  return {}
}

function writeBootstrapSync(state: BootstrapState): void {
  const normalized: BootstrapState = {
    customUserDataDir: cleanPath(state.customUserDataDir) ?? undefined,
    pendingMigrationFrom: cleanPath(state.pendingMigrationFrom) ?? undefined
  }
  const bootstrapPath = getBootstrapFilePath()

  if (!normalized.customUserDataDir && !normalized.pendingMigrationFrom) {
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
}

async function writeBootstrap(state: BootstrapState): Promise<void> {
  const normalized: BootstrapState = {
    customUserDataDir: cleanPath(state.customUserDataDir) ?? undefined,
    pendingMigrationFrom: cleanPath(state.pendingMigrationFrom) ?? undefined
  }
  const bootstrapPath = getBootstrapFilePath()

  if (!normalized.customUserDataDir && !normalized.pendingMigrationFrom) {
    await fsp.rm(bootstrapPath, { force: true })
    return
  }

  await ensureBootstrapParent()
  const tempPath = `${bootstrapPath}.${Date.now()}.tmp`
  await fsp.writeFile(tempPath, JSON.stringify(normalized, null, 2), 'utf8')
  await fsp.rename(tempPath, bootstrapPath)
}

export function getDefaultUserDataDirectory(): string {
  return getDefaultPortableUserDataDirectory()
}

function classifyDirectorySync(targetPath: string): DirectoryClassification {
  if (!pathExistsSync(targetPath)) {
    return 'missing-or-empty'
  }

  let stats: fs.Stats
  try {
    stats = fs.statSync(targetPath)
  } catch {
    return 'nonempty-foreign'
  }

  if (!stats.isDirectory()) {
    return 'nonempty-foreign'
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true })
  if (entries.length === 0) {
    return 'missing-or-empty'
  }

  const hasKnownMarker = entries.some((entry) => {
    return KNOWN_DATA_MARKERS.has(entry.name) || entry.name.startsWith('config.json.broken-')
  })

  return hasKnownMarker ? 'existing-user-data' : 'nonempty-foreign'
}

function maybeMigratePendingDataSync(bootstrap: BootstrapState): void {
  const fromDir = cleanPath(bootstrap.pendingMigrationFrom)
  if (!fromDir) {
    return
  }

  const targetDir = cleanPath(bootstrap.customUserDataDir) ?? getDefaultUserDataDirectory()
  if (isSamePath(fromDir, targetDir) || !pathExistsSync(fromDir)) {
    writeBootstrapSync({ customUserDataDir: bootstrap.customUserDataDir })
    return
  }

  const targetState = classifyDirectorySync(targetDir)
  if (targetState === 'missing-or-empty') {
    fs.mkdirSync(targetDir, { recursive: true })
    copyDirectorySync(fromDir, targetDir)
  }

  writeBootstrapSync({ customUserDataDir: bootstrap.customUserDataDir })
}

function maybeMigrateLegacyDefaultDataSync(): void {
  const legacyDir = getLegacyPortableUserDataDirectory()
  if (!legacyDir || !directoryHasEntriesSync(legacyDir)) {
    return
  }

  const defaultDir = getDefaultUserDataDirectory()
  if (
    isSamePath(legacyDir, defaultDir) ||
    classifyDirectorySync(defaultDir) === 'existing-user-data'
  ) {
    return
  }

  fs.mkdirSync(defaultDir, { recursive: true })
  copyDirectorySync(legacyDir, defaultDir)
}

function resolveDefaultUserDataDirectoryWithMigration(): string {
  maybeMigrateLegacyDefaultDataSync()
  return getDefaultUserDataDirectory()
}

function resolveAutomatedUserDataRoot(): string | null {
  const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())
  if (!testUiPolicy.automatedRun) {
    return null
  }

  return resolveTestArtifactPath({
    desktopPath: resolveConfiguredDesktopPath(app.getPath('desktop')),
    tempPath: app.getPath('temp'),
    policy: testUiPolicy,
    segments: []
  })
}

function resolveAutomatedUserDataDirectory(): { root: string; path: string } | null {
  const automatedRoot = resolveAutomatedUserDataRoot()
  if (!automatedRoot) {
    return null
  }

  return {
    root: automatedRoot,
    path: path.join(automatedRoot, 'userData')
  }
}

function resolveAutomatedUserDataEnvOverride(
  automatedRoot: string,
  envValue: string | undefined
): string | null {
  const trimmed = envValue?.trim()
  if (!trimmed) {
    return null
  }

  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(automatedRoot, trimmed)

  return isSameOrNestedPath(automatedRoot, candidate) ? candidate : null
}

export function resolveStartupUserDataDirectory(): ResolvedStartupUserDataDirectory {
  const automatedUserDataDir = resolveAutomatedUserDataDirectory()
  if (automatedUserDataDir) {
    const automatedEnvOverride = resolveAutomatedUserDataEnvOverride(
      automatedUserDataDir.root,
      process.env[USER_DATA_OVERRIDE_ENV]
    )
    if (automatedEnvOverride) {
      return { path: automatedEnvOverride, source: 'env' }
    }

    return { path: automatedUserDataDir.path, source: 'default' }
  }

  const envOverride = cleanPath(process.env[USER_DATA_OVERRIDE_ENV])
  if (envOverride) {
    return { path: envOverride, source: 'env' }
  }

  const bootstrap = readBootstrapSync()
  maybeMigratePendingDataSync(bootstrap)
  const persistedPath = cleanPath(bootstrap.customUserDataDir)
  if (persistedPath) {
    return { path: persistedPath, source: 'persisted' }
  }

  return { path: resolveDefaultUserDataDirectoryWithMigration(), source: 'default' }
}

export function getCurrentUserDataDirectoryState(
  currentPath: string = app.getPath('userData')
): CurrentUserDataDirectoryState {
  const defaultPath = getDefaultUserDataDirectory()
  const envOverride = cleanPath(process.env[USER_DATA_OVERRIDE_ENV])
  const bootstrap = readBootstrapSync()

  return {
    currentPath,
    defaultPath,
    isCustom: !isSamePath(currentPath, defaultPath),
    source: envOverride ? 'env' : cleanPath(bootstrap.customUserDataDir) ? 'persisted' : 'default'
  }
}

export async function prepareUserDataDirectoryChange(
  nextPath: string | null,
  currentPath: string
): Promise<boolean> {
  const currentState = getCurrentUserDataDirectoryState(currentPath)
  if (currentState.source === 'env') {
    throw new Error(
      `${USER_DATA_OVERRIDE_ENV} is forcing the current data directory. Remove that environment variable before changing it in Settings.`
    )
  }

  const customUserDataDir = cleanPath(nextPath)
  const targetPath = customUserDataDir ?? currentState.defaultPath

  if (isSamePath(currentPath, targetPath)) {
    return false
  }

  if (isNestedPath(currentPath, targetPath) || isNestedPath(targetPath, currentPath)) {
    throw new Error(
      'Please choose a directory that is not the current directory and not a parent or child of it.'
    )
  }

  const targetState = classifyDirectorySync(targetPath)
  if (targetState === 'nonempty-foreign') {
    throw new Error(
      'The selected directory is not empty and does not look like a Magic Pot data directory. Please choose an empty directory or an existing Magic Pot data directory.'
    )
  }

  await writeBootstrap({
    customUserDataDir: customUserDataDir ?? undefined,
    pendingMigrationFrom: targetState === 'missing-or-empty' ? currentPath : undefined
  })

  return true
}
