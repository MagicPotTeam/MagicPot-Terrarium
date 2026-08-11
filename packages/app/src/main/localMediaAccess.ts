import fs from 'node:fs'
import path from 'node:path'

const MAX_SCOPED_LOCAL_MEDIA_PATHS = 1_000
const MAX_SCOPED_LOCAL_MEDIA_DIRECTORIES = 200
const LOCAL_MEDIA_GRANTS_VERSION = 1
const LOCAL_MEDIA_GRANTS_FLUSH_DELAY_MS = 250
const scopedLocalMediaPaths = new Map<string, string>()
const scopedLocalMediaDirectories = new Map<string, string>()
let localMediaGrantsPath: string | null = null
let localMediaGrantsDirty = false
let localMediaGrantsFlushTimer: ReturnType<typeof setTimeout> | null = null

type PersistedLocalMediaGrants = {
  version: typeof LOCAL_MEDIA_GRANTS_VERSION
  files: string[]
  directories: string[]
}

function comparisonKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath
}

function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function canonicalizeExistingPath(filePath: string): string | null {
  try {
    return path.resolve(fs.realpathSync.native(filePath))
  } catch {
    return null
  }
}

function isExistingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function persistScopedLocalMediaGrants(): void {
  if (!localMediaGrantsPath || !localMediaGrantsDirty) return

  const payload: PersistedLocalMediaGrants = {
    version: LOCAL_MEDIA_GRANTS_VERSION,
    files: Array.from(scopedLocalMediaPaths.values()),
    directories: Array.from(scopedLocalMediaDirectories.values())
  }
  const tempPath = `${localMediaGrantsPath}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(localMediaGrantsPath), { recursive: true })
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tempPath, localMediaGrantsPath)
    localMediaGrantsDirty = false
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // Ignore cleanup failures after a persistence error.
    }
    console.warn('[LocalMedia] Failed to persist scoped grants:', error)
  }
}

function scheduleScopedLocalMediaGrantsPersistence(): void {
  if (!localMediaGrantsPath) return
  localMediaGrantsDirty = true
  if (localMediaGrantsFlushTimer) return
  localMediaGrantsFlushTimer = setTimeout(() => {
    localMediaGrantsFlushTimer = null
    persistScopedLocalMediaGrants()
  }, LOCAL_MEDIA_GRANTS_FLUSH_DELAY_MS)
  localMediaGrantsFlushTimer.unref?.()
}

export function flushLocalMediaAccessGrants(): void {
  if (localMediaGrantsFlushTimer) {
    clearTimeout(localMediaGrantsFlushTimer)
    localMediaGrantsFlushTimer = null
  }
  persistScopedLocalMediaGrants()
}

function loadPersistedPaths(
  values: unknown,
  store: Map<string, string>,
  limit: number,
  isExpectedType: (filePath: string) => boolean
): void {
  if (!Array.isArray(values)) return
  for (const value of values.slice(-limit)) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) continue
    const canonical = canonicalizeExistingPath(value)
    if (!canonical || !isExpectedType(canonical)) continue
    rememberBoundedPath(store, comparisonKey(canonical), canonical, limit)
  }
}

/** Loads durable grants after Electron's userData path is finalized. */
export function initializeLocalMediaAccess(grantsPath: string): void {
  if (localMediaGrantsFlushTimer) {
    clearTimeout(localMediaGrantsFlushTimer)
    localMediaGrantsFlushTimer = null
  }
  localMediaGrantsPath = path.resolve(grantsPath)
  localMediaGrantsDirty = false
  scopedLocalMediaPaths.clear()
  scopedLocalMediaDirectories.clear()

  try {
    const parsed = JSON.parse(
      fs.readFileSync(localMediaGrantsPath, 'utf8')
    ) as Partial<PersistedLocalMediaGrants>
    if (parsed.version === LOCAL_MEDIA_GRANTS_VERSION) {
      loadPersistedPaths(
        parsed.files,
        scopedLocalMediaPaths,
        MAX_SCOPED_LOCAL_MEDIA_PATHS,
        isExistingFile
      )
      loadPersistedPaths(
        parsed.directories,
        scopedLocalMediaDirectories,
        MAX_SCOPED_LOCAL_MEDIA_DIRECTORIES,
        isExistingDirectory
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[LocalMedia] Failed to load scoped grants:', error)
    }
  }

  localMediaGrantsDirty = true
  flushLocalMediaAccessGrants()
}

function rememberBoundedPath(
  store: Map<string, string>,
  key: string,
  value: string,
  limit: number
): void {
  store.delete(key)
  store.set(key, value)
  while (store.size > limit) {
    const oldest = store.keys().next().value
    if (!oldest) break
    store.delete(oldest)
  }
}

/** Authorizes one file obtained from an OS file picker or Electron File object. */
export function authorizeScopedLocalMediaPath(filePath: string): boolean {
  const trimmed = String(filePath || '').trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return false

  const canonical = canonicalizeExistingPath(trimmed)
  if (!canonical) return false

  const key = comparisonKey(canonical)
  rememberBoundedPath(scopedLocalMediaPaths, key, canonical, MAX_SCOPED_LOCAL_MEDIA_PATHS)
  scheduleScopedLocalMediaGrantsPersistence()
  return true
}

/** Authorizes one directory returned directly by the main-process OS directory picker. */
export function authorizeScopedLocalMediaDirectory(directoryPath: string): boolean {
  const trimmed = String(directoryPath || '').trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return false

  const canonical = canonicalizeExistingPath(trimmed)
  if (!canonical || !isExistingDirectory(canonical)) return false

  const key = comparisonKey(canonical)
  rememberBoundedPath(
    scopedLocalMediaDirectories,
    key,
    canonical,
    MAX_SCOPED_LOCAL_MEDIA_DIRECTORIES
  )
  scheduleScopedLocalMediaGrantsPersistence()
  return true
}

export function hasLocalMediaTraversal(url: string): boolean {
  const pathPart = url.slice(url.indexOf(':') + 1).split(/[?#]/, 1)[0]
  let decoded = pathPart
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      return true
    }
  }
  return decoded.split(/[\\/]+/).some((segment) => segment === '..')
}

/** Returns a canonical path only when it is under an application root or explicitly scoped. */
export function resolveAuthorizedLocalMediaPath(
  filePath: string,
  allowedRoots: readonly string[]
): string | null {
  const trimmed = String(filePath || '').trim()
  const isNetworkPath = trimmed.startsWith('\\\\') || trimmed.startsWith('//')
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) {
    return null
  }

  const canonical = canonicalizeExistingPath(trimmed)
  if (!canonical) return null
  if (scopedLocalMediaPaths.has(comparisonKey(canonical))) return canonical
  if (
    Array.from(scopedLocalMediaDirectories.values()).some((directory) =>
      isSameOrInside(directory, canonical)
    )
  ) {
    return canonical
  }
  if (isNetworkPath) return null

  return allowedRoots.some((root) => {
    const canonicalRoot = canonicalizeExistingPath(root)
    return canonicalRoot ? isSameOrInside(canonicalRoot, canonical) : false
  })
    ? canonical
    : null
}

/** Checks an already-authorized path without expanding the scoped allowlist. */
export function isScopedLocalMediaPathAuthorized(filePath: string): boolean {
  const canonical = canonicalizeExistingPath(String(filePath || '').trim())
  return canonical ? scopedLocalMediaPaths.has(comparisonKey(canonical)) : false
}

export function clearScopedLocalMediaPathsForTest(): void {
  if (localMediaGrantsFlushTimer) {
    clearTimeout(localMediaGrantsFlushTimer)
    localMediaGrantsFlushTimer = null
  }
  scopedLocalMediaPaths.clear()
  scopedLocalMediaDirectories.clear()
  localMediaGrantsPath = null
  localMediaGrantsDirty = false
}
