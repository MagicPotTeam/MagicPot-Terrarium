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

/**
 * A Windows network (UNC) spelling: two leading separators of either kind (`\\server`,
 * `//server`, `/\server`, `\/server`; device paths such as `\\?\` included). Checked on the
 * raw string: on Windows any filesystem call on such a path contacts the host (SMB, with the
 * user's NTLM credentials), and a host that does not answer blocks the caller.
 */
export function isWindowsNetworkLocalMediaPath(value: string): boolean {
  return /^[\\/]{2}/.test(value)
}

/**
 * A network path the user granted (an exact picked file or a picked directory), decided on the
 * resolved spelling alone: no filesystem call. Only such a path is canonicalized afterwards.
 */
function isWindowsNetworkPathScoped(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  if (scopedLocalMediaPaths.has(comparisonKey(resolved))) return true
  return Array.from(scopedLocalMediaDirectories.values()).some((directory) =>
    isSameOrInside(directory, resolved)
  )
}

/**
 * A root used by the canonical path recorded when it was verified (the private temp root):
 * it is never resolved again, so a symlink put in its place later cannot widen it.
 */
export type PinnedLocalMediaRoot = { readonly pinnedCanonicalPath: string }
export type LocalMediaRoot = string | PinnedLocalMediaRoot

/** Returns a canonical path only when it is under an application root or explicitly scoped. */
export function resolveAuthorizedLocalMediaPath(
  filePath: string,
  allowedRoots: readonly LocalMediaRoot[]
): string | null {
  const trimmed = String(filePath || '').trim()
  // Only Windows has network (UNC) paths. On POSIX `//dir/file` is the local file `/dir/file`,
  // and that is the form every application-root file arrives in there: `local-media` is a
  // standard scheme, so Chromium reads `local-media:///dir/file` with `dir` as the host, and
  // both the renderer and the protocol handler turn host + path back into `//dir/file`.
  // Refusing it as a network path made every thumbnail and every managed file under an
  // application root unreadable on Linux and macOS. The canonical path still has to be inside
  // an allowed root (or scoped) below.
  const isNetworkPath = process.platform === 'win32' && isWindowsNetworkLocalMediaPath(trimmed)
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) {
    return null
  }
  // Before any filesystem call: an unsolicited network path never makes main contact its host.
  if (isNetworkPath && !isWindowsNetworkPathScoped(trimmed)) return null

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
    const canonicalRoot =
      typeof root === 'string' ? canonicalizeExistingPath(root) : root.pinnedCanonicalPath
    return canonicalRoot ? isSameOrInside(canonicalRoot, canonical) : false
  })
    ? canonical
    : null
}

/**
 * Short-lived import grants. A file the user picks or drops into the chat composer is copied
 * into managed media at once, so it needs no durable grant: these grants live in memory only
 * (never persisted), expire LOCAL_MEDIA_IMPORT_GRANT_TTL_MS after they were recorded on a
 * monotonic clock, are spent by the one import that uses them, and never evict the persisted
 * grants that canvas boards rely on.
 */
export const LOCAL_MEDIA_IMPORT_GRANT_TTL_MS = 60_000
const MAX_LOCAL_MEDIA_IMPORT_GRANTS = 256
/**
 * What a grant lets main do once: copy the file into managed media by its path ('import'),
 * or read its bytes for the renderer ('read': only for a file whose canonical form is a
 * network path, which main never imports by path, such as a file on a mapped drive).
 */
export type LocalMediaImportGrantKind = 'import' | 'read'
type LocalMediaImportGrantEntry = { expiresAt: number; kind: LocalMediaImportGrantKind }
/** Canonical-path key -> each grant for that path, oldest first. */
const localMediaImportGrants = new Map<string, LocalMediaImportGrantEntry[]>()

/** Monotonic: setting the clock back never extends a grant. */
export const localMediaImportGrantClock = (): number => performance.now()

function pruneLocalMediaImportGrants(now: number): number {
  let total = 0
  for (const [key, entries] of localMediaImportGrants) {
    const live = entries.filter((entry) => entry.expiresAt > now)
    if (live.length) {
      localMediaImportGrants.set(key, live)
      total += live.length
    } else {
      localMediaImportGrants.delete(key)
    }
  }
  return total
}

/**
 * Records one grant for a canonical path (the caller has canonicalised it and checked that
 * main would import, or read, it). The oldest grants go first when the bound is reached.
 */
export function recordLocalMediaImportGrant(
  canonicalPath: string,
  now = localMediaImportGrantClock(),
  kind: LocalMediaImportGrantKind = 'import'
): void {
  const key = comparisonKey(canonicalPath)
  let total = pruneLocalMediaImportGrants(now)
  const entries = localMediaImportGrants.get(key) ?? []
  localMediaImportGrants.delete(key)
  localMediaImportGrants.set(key, [
    ...entries,
    { expiresAt: now + LOCAL_MEDIA_IMPORT_GRANT_TTL_MS, kind }
  ])
  total += 1
  while (total > MAX_LOCAL_MEDIA_IMPORT_GRANTS) {
    const [oldestKey, oldestEntries] = localMediaImportGrants.entries().next().value ?? []
    if (!oldestKey || !oldestEntries) break
    oldestEntries.shift()
    if (!oldestEntries.length) localMediaImportGrants.delete(oldestKey)
    total -= 1
  }
}

/** Whether a live grant of this kind covers this canonical path; nothing is spent. */
function hasLocalMediaImportGrant(
  canonicalPath: string,
  now: number,
  kind: LocalMediaImportGrantKind = 'import'
): boolean {
  return (localMediaImportGrants.get(comparisonKey(canonicalPath)) ?? []).some(
    (entry) => entry.kind === kind && entry.expiresAt > now
  )
}

/**
 * Spends one live grant of this kind for this canonical path; false when there is none. It
 * is synchronous, so two uses that both saw the grant cannot both spend it.
 */
export function consumeLocalMediaImportGrant(
  canonicalPath: string,
  now = localMediaImportGrantClock(),
  kind: LocalMediaImportGrantKind = 'import'
): boolean {
  pruneLocalMediaImportGrants(now)
  const key = comparisonKey(canonicalPath)
  const entries = localMediaImportGrants.get(key)
  const index = entries?.findIndex((entry) => entry.kind === kind) ?? -1
  if (!entries || index < 0) return false
  entries.splice(index, 1)
  if (!entries.length) localMediaImportGrants.delete(key)
  return true
}

/**
 * The canonical path of `filePath` when a one-use read grant covers it, spending that grant:
 * readImageFromPath may then hand the renderer its bytes once (a file the user dropped from
 * a mapped network drive, within the caller's byte limit). A UNC or device path named by the
 * renderer is refused before any filesystem access.
 */
export function consumeLocalMediaReadGrant(
  filePath: string,
  now = localMediaImportGrantClock()
): string | null {
  const trimmed = String(filePath || '').trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return null
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return null
  const canonical = canonicalizeExistingPath(trimmed)
  if (!canonical) return null
  return consumeLocalMediaImportGrant(canonical, now, 'read') ? canonical : null
}

async function canonicalizeExistingPathAsync(
  filePath: string,
  realpath: (value: string) => Promise<string>
): Promise<string | null> {
  try {
    return path.resolve(await realpath(filePath))
  } catch {
    return null
  }
}

export type LocalMediaImportSourceAuthorization = {
  canonicalPath: string
  /**
   * Only a one-use import grant covers the path: the import must spend it
   * (consumeLocalMediaImportGrant) once it has accepted the request.
   */
  viaImportGrant: boolean
}

/**
 * Source-path policy for a renderer importFile request: the canonical path when it is
 * persistently authorized (scoped grant or application root) or covered by a live import
 * grant, otherwise null. It spends nothing: the import grant is spent by importFile, after
 * its own checks. Every realpath (of the source and of each root) is fs.promises.realpath,
 * on the threadpool, so a path on a stalled mount never blocks main's event loop.
 */
export async function authorizeLocalMediaImportSourcePathAsync(
  filePath: string,
  allowedRoots: readonly LocalMediaRoot[],
  {
    now = localMediaImportGrantClock,
    realpath = (value: string) => fs.promises.realpath(value)
  }: { now?: () => number; realpath?: (value: string) => Promise<string> } = {}
): Promise<LocalMediaImportSourceAuthorization | null> {
  const trimmed = String(filePath || '').trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return null
  const isNetworkPath =
    process.platform === 'win32'
      ? isWindowsNetworkLocalMediaPath(trimmed)
      : trimmed.startsWith('\\\\') || trimmed.startsWith('//')
  // Before any filesystem call on Windows: see resolveAuthorizedLocalMediaPath.
  if (process.platform === 'win32' && isNetworkPath && !isWindowsNetworkPathScoped(trimmed)) {
    return null
  }
  const canonical = await canonicalizeExistingPathAsync(trimmed, realpath)
  if (!canonical) return null
  const persisted = { canonicalPath: canonical, viaImportGrant: false }
  if (scopedLocalMediaPaths.has(comparisonKey(canonical))) return persisted
  if (
    Array.from(scopedLocalMediaDirectories.values()).some((directory) =>
      isSameOrInside(directory, canonical)
    )
  ) {
    return persisted
  }
  if (!isNetworkPath) {
    for (const root of allowedRoots) {
      const canonicalRoot =
        typeof root === 'string'
          ? await canonicalizeExistingPathAsync(root, realpath)
          : root.pinnedCanonicalPath
      if (canonicalRoot && isSameOrInside(canonicalRoot, canonical)) return persisted
    }
  }
  return hasLocalMediaImportGrant(canonical, now())
    ? { canonicalPath: canonical, viaImportGrant: true }
    : null
}

export function countLocalMediaImportGrantsForTest(now = localMediaImportGrantClock()): number {
  return pruneLocalMediaImportGrants(now)
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
  localMediaImportGrants.clear()
  localMediaGrantsPath = null
  localMediaGrantsDirty = false
}
