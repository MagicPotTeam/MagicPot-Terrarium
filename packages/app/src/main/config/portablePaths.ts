import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { resolveStorageLayout } from '@shared/storageLayout'
import {
  readTestUiEnv,
  resolveConfiguredDesktopPath,
  resolveTestArtifactPath,
  resolveTestUiPolicy
} from '../testUiPolicy'

export const USER_DATA_OVERRIDE_ENV = 'MAGICPOT_USER_DATA_DIR'
export const STORAGE_ROOT_OVERRIDE_ENV = 'MAGICPOT_STORAGE_ROOT'
export const USER_DATA_DIRNAME = 'aiengineelectron'
export const USER_DATA_PARENT_DIRNAME = 'MagicPot'
export const DEV_USER_DATA_DIRNAME = '.aiengineelectron-dev'
export const USER_DATA_BOOTSTRAP_FILENAME = 'user-data-bootstrap.json'
export const LEGACY_BOOTSTRAPS_RETIRED_FIELD = 'legacyBootstrapsRetired'

type BootstrapLike = {
  customStorageRoot?: unknown
  customUserDataDir?: unknown
  pendingMigrationFrom?: unknown
  pendingProjectsFrom?: unknown
  pendingAutoSaveFrom?: unknown
  pendingAutoSaveFromSecondary?: unknown
  pendingAutoSaveMigrations?: unknown
  legacyBootstrapsRetired?: unknown
}

type PortableBootstrapStorageOverride = {
  storageRoot: string | null
  userDataDir: string | null
  blocked: boolean
}

export type PortableRuntimePaths = {
  root: string
  cache: string
  home: string
  temp: string
  appData: string
  localAppData: string
  xdgCache: string
  huggingface: string
  huggingfaceHub: string
  transformers: string
  torch: string
  pip: string
  matplotlib: string
  numba: string
  gradioTemp: string
  pythonUserBase: string
  pythonPycache: string
}

function sanitizeText(text: string): string {
  return text.replace(/\uFEFF/g, '').replaceAll('\0', '')
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? path.resolve(trimmed) : null
}

function normalizePathKey(targetPath: string): string {
  const normalized = path.resolve(targetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function dedupePaths(paths: Array<string | null>): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const targetPath of paths) {
    if (!targetPath) {
      continue
    }
    const key = normalizePathKey(targetPath)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(targetPath)
  }
  return deduped
}

export function getDefaultPortableStorageRoot(): string {
  if (!app.isPackaged) {
    return path.join(process.cwd(), DEV_USER_DATA_DIRNAME)
  }

  let appDataRoot: string
  try {
    appDataRoot = app.getPath('appData')
  } catch {
    appDataRoot =
      process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Roaming')
        : path.join(os.homedir(), '.config')
  }

  return path.join(appDataRoot, USER_DATA_PARENT_DIRNAME, USER_DATA_DIRNAME)
}

export function getDefaultPortableUserDataDirectory(): string {
  return resolveStorageLayout(getDefaultPortableStorageRoot(), path).data
}

export function getLegacyPortableUserDataDirectory(): string | null {
  if (!app.isPackaged || !process.resourcesPath) {
    return null
  }

  const legacyDir = path.join(process.resourcesPath, '..', USER_DATA_DIRNAME)
  const defaultDir = getDefaultPortableUserDataDirectory()
  return normalizePathKey(legacyDir) === normalizePathKey(defaultDir) ? null : legacyDir
}

export function getPortableUserDataBootstrapPath(): string {
  return path.join(getDefaultPortableStorageRoot(), USER_DATA_BOOTSTRAP_FILENAME)
}

export function getLegacyPortableUserDataBootstrapPath(): string | null {
  const legacyDir = getLegacyPortableUserDataDirectory()
  return legacyDir ? path.join(legacyDir, USER_DATA_BOOTSTRAP_FILENAME) : null
}

export function getPortableUserDataBootstrapPaths(): string[] {
  const defaultRoot = getDefaultPortableStorageRoot()
  return dedupePaths([
    getPortableUserDataBootstrapPath(),
    path.join(defaultRoot, 'Data', USER_DATA_BOOTSTRAP_FILENAME),
    getLegacyPortableUserDataBootstrapPath()
  ])
}

function hasPendingMigration(raw: BootstrapLike): boolean {
  return Boolean(
    cleanPath(raw.pendingMigrationFrom) ||
    cleanPath(raw.pendingProjectsFrom) ||
    cleanPath(raw.pendingAutoSaveFrom) ||
    cleanPath(raw.pendingAutoSaveFromSecondary) ||
    (Array.isArray(raw.pendingAutoSaveMigrations) &&
      raw.pendingAutoSaveMigrations.some(
        (migration) =>
          migration !== null &&
          typeof migration === 'object' &&
          (migration as { completed?: unknown }).completed !== true
      ))
  )
}

function hasActiveBootstrapState(raw: BootstrapLike): boolean {
  return Boolean(
    cleanPath(raw.customStorageRoot) || cleanPath(raw.customUserDataDir) || hasPendingMigration(raw)
  )
}

function resolveBootstrapStorageOverride(
  raw: BootstrapLike
): PortableBootstrapStorageOverride | null {
  if (hasPendingMigration(raw)) {
    const recoverableUserDataDir = cleanPath(raw.pendingMigrationFrom)
    let recoverableSourceIsAccessible = false
    if (recoverableUserDataDir) {
      try {
        recoverableSourceIsAccessible = fs.statSync(recoverableUserDataDir).isDirectory()
      } catch {
        recoverableSourceIsAccessible = false
      }
    }
    return {
      storageRoot: null,
      userDataDir: recoverableSourceIsAccessible ? recoverableUserDataDir : null,
      blocked: !recoverableSourceIsAccessible
    }
  }

  const storageRoot = cleanPath(raw.customStorageRoot)
  if (storageRoot) {
    return {
      storageRoot,
      userDataDir: resolveStorageLayout(storageRoot, path).data,
      blocked: false
    }
  }
  const userDataDir = cleanPath(raw.customUserDataDir)
  return userDataDir ? { storageRoot: null, userDataDir, blocked: false } : null
}

function readPortableBootstrapStorageOverrideSync(): PortableBootstrapStorageOverride {
  const bootstrapPaths = getPortableUserDataBootstrapPaths()
  const primaryBootstrapPath = bootstrapPaths[0]
  let legacyBootstrapsRetired = false

  if (primaryBootstrapPath && fs.existsSync(primaryBootstrapPath)) {
    try {
      const raw = JSON.parse(
        sanitizeText(fs.readFileSync(primaryBootstrapPath, 'utf8'))
      ) as BootstrapLike
      legacyBootstrapsRetired = raw[LEGACY_BOOTSTRAPS_RETIRED_FIELD] === true
      if (hasActiveBootstrapState(raw)) {
        return (
          resolveBootstrapStorageOverride(raw) ?? {
            storageRoot: null,
            userDataDir: null,
            blocked: false
          }
        )
      }
    } catch {
      // Keep scanning fallbacks so an unreadable primary bootstrap does not block startup.
    }
  }

  if (legacyBootstrapsRetired) {
    return { storageRoot: null, userDataDir: null, blocked: false }
  }

  for (const bootstrapPath of bootstrapPaths.slice(1)) {
    if (!fs.existsSync(bootstrapPath)) {
      continue
    }

    try {
      const raw = JSON.parse(sanitizeText(fs.readFileSync(bootstrapPath, 'utf8'))) as BootstrapLike
      if (!hasActiveBootstrapState(raw)) {
        continue
      }
      return (
        resolveBootstrapStorageOverride(raw) ?? {
          storageRoot: null,
          userDataDir: null,
          blocked: false
        }
      )
    } catch {
      // Keep scanning fallbacks so an unreadable legacy bootstrap does not block startup.
    }
  }

  return { storageRoot: null, userDataDir: null, blocked: false }
}

export function readPortableBootstrapCustomUserDataDirSync(): string | null {
  return readPortableBootstrapStorageOverrideSync().userDataDir
}

/**
 * Returns the unified storage root only when the current userData directory is identified by an
 * explicit storage-root source (environment/bootstrap) or by the known default layout. Unknown
 * directories and legacy exact-userData overrides deliberately return null instead of relying on
 * a basename such as `Data`.
 */
export function resolvePortableStorageRootForUserDataSync(userDataDir: string): string | null {
  const currentUserDataDir = cleanPath(userDataDir)
  if (!currentUserDataDir) return null

  const legacyUserDataOverride = cleanPath(process.env[USER_DATA_OVERRIDE_ENV])
  if (
    legacyUserDataOverride &&
    normalizePathKey(legacyUserDataOverride) === normalizePathKey(currentUserDataDir)
  ) {
    return null
  }

  const storageRootOverride = cleanPath(process.env[STORAGE_ROOT_OVERRIDE_ENV])
  if (storageRootOverride) {
    const layout = resolveStorageLayout(storageRootOverride, path)
    if (normalizePathKey(layout.data) === normalizePathKey(currentUserDataDir)) {
      return layout.root
    }
  }

  const bootstrapOverride = readPortableBootstrapStorageOverrideSync()
  if (bootstrapOverride.blocked) return null
  if (
    bootstrapOverride.userDataDir &&
    normalizePathKey(bootstrapOverride.userDataDir) === normalizePathKey(currentUserDataDir)
  ) {
    return bootstrapOverride.storageRoot
  }

  const defaultStorageRoot = getDefaultPortableStorageRoot()
  const defaultLayout = resolveStorageLayout(defaultStorageRoot, path)
  return normalizePathKey(defaultLayout.data) === normalizePathKey(currentUserDataDir)
    ? defaultLayout.root
    : null
}

function resolveAutomatedPortableUserDataDirectory(): string | null {
  const policy = resolveTestUiPolicy(readTestUiEnv())
  if (!policy.automatedRun) return null

  const automatedRoot = resolveTestArtifactPath({
    desktopPath: resolveConfiguredDesktopPath(app.getPath('desktop')),
    tempPath: app.getPath('temp'),
    policy,
    segments: []
  })
  const resolveAutomatedOverride = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null
    const trimmed = value.trim()
    const candidate = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(automatedRoot, trimmed)
    const relative = path.relative(automatedRoot, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      ? candidate
      : null
  }

  const storageRootOverride = resolveAutomatedOverride(process.env[STORAGE_ROOT_OVERRIDE_ENV])
  if (storageRootOverride) return resolveStorageLayout(storageRootOverride, path).data
  return (
    resolveAutomatedOverride(process.env[USER_DATA_OVERRIDE_ENV]) ??
    resolveStorageLayout(automatedRoot, path).data
  )
}

export function resolveEarlyPortableUserDataDirectory(): string {
  const automatedUserDataDir = resolveAutomatedPortableUserDataDirectory()
  if (automatedUserDataDir) return automatedUserDataDir

  const storageRootOverride = cleanPath(process.env[STORAGE_ROOT_OVERRIDE_ENV])
  if (storageRootOverride) {
    return resolveStorageLayout(storageRootOverride, path).data
  }

  const legacyUserDataOverride = cleanPath(process.env[USER_DATA_OVERRIDE_ENV])
  if (legacyUserDataOverride) {
    return legacyUserDataOverride
  }

  const bootstrapOverride = readPortableBootstrapStorageOverrideSync()
  if (bootstrapOverride.blocked) {
    throw new Error(
      'Storage migration is still pending, but its legacy Data source is unavailable. Restore the source and restart Magic Pot.'
    )
  }
  return bootstrapOverride.userDataDir ?? getDefaultPortableUserDataDirectory()
}

export function getPortableRuntimePaths(userDataDir: string): PortableRuntimePaths {
  const root = path.join(userDataDir, 'runtime')
  const cache = path.join(root, 'cache')
  const home = path.join(root, 'home')
  const temp = path.join(root, 'temp')
  const appData = path.join(home, 'AppData', 'Roaming')
  const localAppData = path.join(home, 'AppData', 'Local')
  const huggingface = path.join(cache, 'huggingface')

  return {
    root,
    cache,
    home,
    temp,
    appData,
    localAppData,
    xdgCache: path.join(cache, 'xdg'),
    huggingface,
    huggingfaceHub: path.join(huggingface, 'hub'),
    transformers: path.join(huggingface, 'transformers'),
    torch: path.join(cache, 'torch'),
    pip: path.join(cache, 'pip'),
    matplotlib: path.join(cache, 'matplotlib'),
    numba: path.join(cache, 'numba'),
    gradioTemp: path.join(temp, 'gradio'),
    pythonUserBase: path.join(cache, 'python-userbase'),
    pythonPycache: path.join(cache, 'pycache')
  }
}

export function ensurePortableRuntimePaths(userDataDir: string): PortableRuntimePaths {
  const paths = getPortableRuntimePaths(userDataDir)
  for (const targetPath of Object.values(paths)) {
    fs.mkdirSync(targetPath, { recursive: true })
  }
  return paths
}

export function createPortablePythonEnv(
  userDataDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const paths = ensurePortableRuntimePaths(userDataDir)

  return {
    ...baseEnv,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    XDG_CACHE_HOME: paths.xdgCache,
    HF_HOME: paths.huggingface,
    HUGGINGFACE_HUB_CACHE: paths.huggingfaceHub,
    TRANSFORMERS_CACHE: paths.transformers,
    TORCH_HOME: paths.torch,
    PIP_CACHE_DIR: paths.pip,
    MPLCONFIGDIR: paths.matplotlib,
    NUMBA_CACHE_DIR: paths.numba,
    GRADIO_TEMP_DIR: paths.gradioTemp,
    PYTHONUSERBASE: paths.pythonUserBase,
    PYTHONPYCACHEPREFIX: paths.pythonPycache,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONLEGACYWINDOWSSTDIO: '1',
    PYTHONUNBUFFERED: '1'
  }
}
