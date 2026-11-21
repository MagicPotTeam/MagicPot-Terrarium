import fs from 'node:fs'
import path from 'node:path'

const MAX_SCOPED_LOCAL_MEDIA_PATHS = 1_000
const MAX_SCOPED_LOCAL_MEDIA_DIRECTORIES = 200
const LOCAL_MEDIA_GRANTS_VERSION = 1
const LOCAL_MEDIA_GRANTS_FLUSH_DELAY_MS = 250
const scopedLocalMediaPaths = new Map<string, string>()
const scopedLocalMediaDirectories = new Map<string, string>()
/**
 * Windows only. A network grant whose canonical form is spelled differently from the path the
 * user picked or dropped (a DFS namespace path resolves to its target server, a folder on a
 * share may be a link): resolved spelling key -> [resolved spelling, canonical grant]. The
 * refusal of network paths before any filesystem call compares spellings, and requests keep
 * the spelling the user dropped (a canvas item keeps it), so the spelling is remembered too.
 */
const scopedNetworkFileSpellings = new Map<string, [string, string]>()
const scopedNetworkDirectorySpellings = new Map<string, [string, string]>()
/**
 * Folders the user's grants never reach into: comparison key -> folder (as spelled and
 * canonical). See setLocalMediaGrantExcludedFolders.
 */
const grantExcludedFolders = new Map<string, string>()
let localMediaGrantsPath: string | null = null
let localMediaGrantsDirty = false
let localMediaGrantsFlushTimer: ReturnType<typeof setTimeout> | null = null

type PersistedLocalMediaGrants = {
  version: typeof LOCAL_MEDIA_GRANTS_VERSION
  files: string[]
  directories: string[]
  /** [spelling, canonical] pairs of scopedNetworkFileSpellings / scopedNetworkDirectorySpellings. */
  networkFileSpellings?: [string, string][]
  networkDirectorySpellings?: [string, string][]
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

/**
 * Sets the folders the user's grants never reach into: the app's data folder. A folder the user
 * once picked or dropped that holds it (their home folder) must not serve config.json, the
 * grants file, chats or Chromium's profile; only roots serve files there (its media folders,
 * see getLocalMediaAllowedRoots). One-use import grants are not affected: they are for the
 * very file the user just picked or dropped.
 */
export function setLocalMediaGrantExcludedFolders(folders: readonly string[]): void {
  grantExcludedFolders.clear()
  for (const folder of folders) {
    const trimmed = String(folder || '').trim()
    if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) continue
    for (const candidate of [path.resolve(trimmed), canonicalizeExistingPath(trimmed)]) {
      if (candidate) grantExcludedFolders.set(comparisonKey(candidate), candidate)
    }
  }
}

/** Whether a path (canonical, or resolved by its text) lies in a folder grants never reach. */
function isInGrantExcludedFolder(filePath: string): boolean {
  for (const folder of grantExcludedFolders.values()) {
    if (isSameOrInside(folder, filePath)) return true
  }
  return false
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
    directories: Array.from(scopedLocalMediaDirectories.values()),
    ...(scopedNetworkFileSpellings.size
      ? { networkFileSpellings: Array.from(scopedNetworkFileSpellings.values()) }
      : {}),
    ...(scopedNetworkDirectorySpellings.size
      ? { networkDirectorySpellings: Array.from(scopedNetworkDirectorySpellings.values()) }
      : {})
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

/**
 * Keeps a persisted spelling only while its canonical grant was loaded too; no filesystem call
 * (the spelling is a network path).
 */
function loadPersistedNetworkSpellings(
  values: unknown,
  store: Map<string, [string, string]>,
  grants: Map<string, string>,
  limit: number
): void {
  if (process.platform !== 'win32' || !Array.isArray(values)) return
  for (const value of values.slice(-limit)) {
    if (!Array.isArray(value) || value.length !== 2) continue
    const [spelling, canonical] = value as unknown[]
    if (typeof spelling !== 'string' || typeof canonical !== 'string') continue
    if (!grants.has(comparisonKey(canonical))) continue
    rememberNetworkSpelling(store, spelling, canonical, limit)
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
  scopedNetworkFileSpellings.clear()
  scopedNetworkDirectorySpellings.clear()

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
      loadPersistedNetworkSpellings(
        parsed.networkFileSpellings,
        scopedNetworkFileSpellings,
        scopedLocalMediaPaths,
        MAX_SCOPED_LOCAL_MEDIA_PATHS
      )
      loadPersistedNetworkSpellings(
        parsed.networkDirectorySpellings,
        scopedNetworkDirectorySpellings,
        scopedLocalMediaDirectories,
        MAX_SCOPED_LOCAL_MEDIA_DIRECTORIES
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

/**
 * Remembers the spelling of a Windows network grant when its canonical form differs (see
 * scopedNetworkFileSpellings). Pure string work.
 */
function rememberNetworkSpelling(
  store: Map<string, [string, string]>,
  spelling: string,
  canonical: string,
  limit: number
): void {
  if (process.platform !== 'win32' || spelling.includes('\0')) return
  if (!isWindowsNetworkLocalMediaPath(spelling)) return
  const resolved = path.resolve(spelling)
  const key = comparisonKey(resolved)
  if (key === comparisonKey(canonical)) return
  store.delete(key)
  store.set(key, [resolved, canonical])
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
  rememberNetworkSpelling(
    scopedNetworkFileSpellings,
    trimmed,
    canonical,
    MAX_SCOPED_LOCAL_MEDIA_PATHS
  )
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
  rememberNetworkSpelling(
    scopedNetworkDirectorySpellings,
    trimmed,
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
 * `//server`, `/\server`, `\/server`; device paths such as `\\?\` included), or the NT
 * object-namespace prefix (see isWindowsNtNamespaceLocalMediaPath). Checked on the raw string:
 * on Windows any filesystem call on such a path contacts the host (SMB, with the user's NTLM
 * credentials), and a host that does not answer blocks the caller.
 */
export function isWindowsNetworkLocalMediaPath(value: string): boolean {
  return /^[\\/]{2}/.test(value) || isWindowsNtNamespaceLocalMediaPath(value)
}

/**
 * The NT object-namespace prefix ('\' + '??' + '\', separators of either kind): Windows file
 * APIs hand such a path to the object manager as it is, so '\??\UNC\host\share' contacts the
 * host as a UNC path does. No grant is ever for such a spelling, so it is refused whatever is
 * scoped (its resolved form, C:\??\..., would otherwise sit inside a picked C:\).
 */
function isWindowsNtNamespaceLocalMediaPath(value: string): boolean {
  return /^[\\/][?]{2}[\\/]/.test(value)
}

/**
 * A network path the user granted (an exact picked file or a picked directory), decided on the
 * resolved spelling alone: no filesystem call. Only such a path is canonicalized afterwards.
 * Both the canonical spelling of a grant and the spelling it was made with count (they differ
 * for a DFS namespace path); a remembered spelling counts only while its grant is alive.
 */
function isWindowsNetworkPathScoped(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  const key = comparisonKey(resolved)
  if (scopedLocalMediaPaths.has(key)) return true
  const spelled = scopedNetworkFileSpellings.get(key)
  if (spelled && scopedLocalMediaPaths.has(comparisonKey(spelled[1]))) return true
  if (
    Array.from(scopedLocalMediaDirectories.values()).some((directory) =>
      isSameOrInside(directory, resolved)
    )
  ) {
    return true
  }
  return Array.from(scopedNetworkDirectorySpellings.values()).some(
    ([spelling, canonical]) =>
      scopedLocalMediaDirectories.has(comparisonKey(canonical)) &&
      isSameOrInside(spelling, resolved)
  )
}

/**
 * A root used by the canonical path recorded when it was verified (the private temp root):
 * it is never resolved again, so a symlink put in its place later cannot widen it.
 */
export type PinnedLocalMediaRoot = { readonly pinnedCanonicalPath: string }
export type LocalMediaRoot = string | PinnedLocalMediaRoot

type LocalMediaPathPrecheck = {
  trimmed: string
  /** A Windows network spelling (see isWindowsNetworkLocalMediaPath). */
  isNetworkPath: boolean
  /** A network spelling admitted only because it lies inside a network root (async policy). */
  viaNetworkRoot: boolean
}

/**
 * Everything decided before any filesystem call: null when the path is refused outright.
 * On Windows an unscoped network spelling never reaches the filesystem, so main never contacts
 * a host the user did not grant. `networkRoots` are roots whose own spelling is a Windows
 * network path (a share the user configured): a request lexically inside one of them may go on
 * to the filesystem, which contacts that host only.
 */
function precheckLocalMediaPath(
  filePath: string,
  networkRoots: readonly string[] = [],
  grants = true
): LocalMediaPathPrecheck | null {
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
  // Before any filesystem call: an unsolicited network path never makes main contact its host
  // (an NT namespace spelling never counts as scoped).
  if (process.platform === 'win32' && isWindowsNtNamespaceLocalMediaPath(trimmed)) return null
  if (!isNetworkPath || (grants && isWindowsNetworkPathScoped(trimmed))) {
    return { trimmed, isNetworkPath, viaNetworkRoot: false }
  }
  const resolved = path.resolve(trimmed)
  const viaNetworkRoot = networkRoots.some(
    (root) =>
      isWindowsNetworkLocalMediaPath(root) &&
      !isWindowsNtNamespaceLocalMediaPath(root) &&
      isSameOrInside(path.resolve(root), resolved)
  )
  return viaNetworkRoot ? { trimmed, isNetworkPath, viaNetworkRoot } : null
}

/**
 * A canonical path the user granted: an exact picked file, or inside a picked directory, and
 * not in a folder grants never reach (setLocalMediaGrantExcludedFolders).
 */
function isScopedCanonicalLocalMediaPath(canonical: string): boolean {
  if (isInGrantExcludedFolder(canonical)) return false
  return (
    scopedLocalMediaPaths.has(comparisonKey(canonical)) ||
    Array.from(scopedLocalMediaDirectories.values()).some((directory) =>
      isSameOrInside(directory, canonical)
    )
  )
}

/** Returns a canonical path only when it is under an application root or explicitly scoped. */
export function resolveAuthorizedLocalMediaPath(
  filePath: string,
  allowedRoots: readonly LocalMediaRoot[]
): string | null {
  const checked = precheckLocalMediaPath(filePath)
  if (!checked) return null

  const canonical = canonicalizeExistingPath(checked.trimmed)
  if (!canonical) return null
  if (isScopedCanonicalLocalMediaPath(canonical)) return canonical
  if (checked.isNetworkPath) return null

  return allowedRoots.some((root) => {
    const canonicalRoot =
      typeof root === 'string' ? canonicalizeExistingPath(root) : root.pinnedCanonicalPath
    return canonicalRoot ? isSameOrInside(canonicalRoot, canonical) : false
  })
    ? canonical
    : null
}

export type LocalMediaPathAuthorizationOptions = {
  realpath?: (value: string) => Promise<string>
  /**
   * Let a Windows network spelling through when it lies inside a root whose own spelling is a
   * network path (a share the user configured as a storage or model folder). Off by default:
   * the local-media protocol never serves an unscoped network path.
   */
  allowNetworkRoots?: boolean
  /**
   * Whether the user's grants (picked or dropped files and folders) count besides the roots
   * (default true). Off for a read that only ever names files under the roots.
   */
  grants?: boolean
}

/**
 * Why a path was not authorized. 'missing': it does not exist (ENOENT or ENOTDIR). 'refused':
 * refused before any filesystem call, or it resolves outside every root and grant (a stable
 * answer). 'unavailable': the filesystem gave no answer (an error other than a missing path;
 * callers that run this under a deadline also use it for no answer in time): the file may well
 * be there, so nobody may treat it as absent.
 */
export type LocalMediaPathRefusalReason = 'missing' | 'refused' | 'unavailable'

export type LocalMediaPathAuthorization =
  | { canonicalPath: string; reason?: undefined }
  | { canonicalPath: null; reason: LocalMediaPathRefusalReason }

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * resolveAuthorizedLocalMediaPath off main's event loop, with the reason of a refusal: the same
 * decision, but every realpath (of the path and of each root) is fs.promises.realpath, on the
 * threadpool. For a path the renderer names: a synchronous realpath of a path on a share that
 * stopped answering would block main.
 */
export async function authorizeLocalMediaPathAsync(
  filePath: string,
  allowedRoots: readonly LocalMediaRoot[],
  {
    realpath = (value: string) => fs.promises.realpath(value),
    allowNetworkRoots = false,
    grants = true
  }: LocalMediaPathAuthorizationOptions = {}
): Promise<LocalMediaPathAuthorization> {
  const refused = (reason: LocalMediaPathRefusalReason): LocalMediaPathAuthorization => ({
    canonicalPath: null,
    reason
  })
  const checked = precheckLocalMediaPath(
    filePath,
    allowNetworkRoots
      ? allowedRoots.filter((root): root is string => typeof root === 'string')
      : [],
    grants
  )
  if (!checked) return refused('refused')

  let canonical: string
  try {
    canonical = path.resolve(await realpath(checked.trimmed))
  } catch (error) {
    return refused(isMissingPathError(error) ? 'missing' : 'unavailable')
  }
  if (grants && isScopedCanonicalLocalMediaPath(canonical)) return { canonicalPath: canonical }
  if (checked.isNetworkPath && !checked.viaNetworkRoot) return refused('refused')

  const resolved = path.resolve(checked.trimmed)
  // A root that gave no answer may hold the path: then the path is not known to be outside.
  let rootUnanswered = false
  for (const root of allowedRoots) {
    // A network root is canonicalized only for a request inside it by its text (that host is
    // contacted for the request anyway): any other request never makes main contact a share.
    if (
      typeof root === 'string' &&
      process.platform === 'win32' &&
      isWindowsNetworkLocalMediaPath(root) &&
      !isSameOrInside(path.resolve(root), resolved)
    ) {
      continue
    }
    let canonicalRoot: string
    if (typeof root === 'string') {
      try {
        canonicalRoot = path.resolve(await realpath(root))
      } catch (error) {
        if (!isMissingPathError(error)) rootUnanswered = true
        continue
      }
    } else {
      canonicalRoot = root.pinnedCanonicalPath
    }
    if (isSameOrInside(canonicalRoot, canonical)) return { canonicalPath: canonical }
  }
  return refused(rootUnanswered ? 'unavailable' : 'refused')
}

/** authorizeLocalMediaPathAsync without the reason: the canonical path, or null. */
export async function resolveAuthorizedLocalMediaPathAsync(
  filePath: string,
  allowedRoots: readonly LocalMediaRoot[],
  options: LocalMediaPathAuthorizationOptions = {}
): Promise<string | null> {
  return (await authorizeLocalMediaPathAsync(filePath, allowedRoots, options)).canonicalPath
}

/**
 * Whether a path lies, by its text alone, where the policy above could authorize it: inside an
 * allowed root or a granted directory, or a granted file. No filesystem call. Callers use it to
 * tell "missing" from "not authorized" without revealing whether a file outside exists.
 */
export function isLexicallyCoveredLocalMediaPath(
  filePath: string,
  allowedRoots: readonly LocalMediaRoot[],
  { grants = true }: { grants?: boolean } = {}
): boolean {
  const trimmed = String(filePath || '').trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return false
  const resolved = path.resolve(trimmed)
  return (
    (grants &&
      !isInGrantExcludedFolder(resolved) &&
      (scopedLocalMediaPaths.has(comparisonKey(resolved)) ||
        Array.from(scopedLocalMediaDirectories.values()).some((directory) =>
          isSameOrInside(directory, resolved)
        ))) ||
    allowedRoots.some((root) =>
      isSameOrInside(
        typeof root === 'string' ? path.resolve(root) : root.pinnedCanonicalPath,
        resolved
      )
    )
  )
}

/**
 * Short-lived import grants. A file the user picks or drops into the chat composer is copied
 * into managed media at once, so it needs no durable grant: these grants live in memory only
 * (never persisted), expire LOCAL_MEDIA_IMPORT_GRANT_TTL_MS after they were recorded on a
 * monotonic clock, are spent by the one import that uses them, and never evict the persisted
 * grants that canvas boards rely on.
 */
export const LOCAL_MEDIA_IMPORT_GRANT_TTL_MS = 60_000
/** The grants of one drop never live longer than this after they were recorded. */
export const LOCAL_MEDIA_IMPORT_GRANT_BATCH_MAX_MS = 10 * 60_000
const MAX_LOCAL_MEDIA_IMPORT_GRANTS = 256
/**
 * What a grant lets main do once: copy the file into managed media by its path ('import'),
 * or read its bytes for the renderer ('read': only for a file whose canonical form is a
 * network path, which main never imports by path, such as a file on a mapped drive).
 */
export type LocalMediaImportGrantKind = 'import' | 'read'
type LocalMediaImportGrantEntry = {
  /** Expiry on the monotonic clock and on the wall clock: a grant expires at the first. */
  expiresAt: number
  wallExpiresAt: number
  kind: LocalMediaImportGrantKind
  /** The drop it belongs to: its imports run one after another (see spendLocalMediaImportGrant). */
  batch?: string
  batchDeadline?: number
  batchWallDeadline?: number
  /** A read grant: the canonical path main resolved when it granted the read, and reads. */
  readPath?: string
  /** A read grant: the file's size main measured then (the read takes no more). */
  sizeBytes?: number
}
/**
 * Path key -> each grant for that path, oldest first: the canonical path of an import grant,
 * the path the user dropped or picked for a read grant.
 */
const localMediaImportGrants = new Map<string, LocalMediaImportGrantEntry[]>()
/** Drops with an import running now -> how many. */
const localMediaImportBatchesInUse = new Map<string, number>()

/**
 * Monotonic: setting the clock back never extends a grant. It stops during system sleep, so
 * a grant also expires when the wall clock passes its time (localMediaImportGrantWallClock).
 */
export const localMediaImportGrantClock = (): number => performance.now()
export const localMediaImportGrantWallClock = (): number => Date.now()

function isLiveGrant(entry: LocalMediaImportGrantEntry, now: number, wallNow: number): boolean {
  if (entry.batch !== undefined) {
    if (now >= (entry.batchDeadline ?? 0) || wallNow >= (entry.batchWallDeadline ?? 0)) return false
    // While an import of its drop runs, the rest of the drop waits for its turn.
    if (localMediaImportBatchesInUse.has(entry.batch)) return true
  }
  return now < entry.expiresAt && wallNow < entry.wallExpiresAt
}

function pruneLocalMediaImportGrants(now: number, wallNow: number): number {
  let total = 0
  for (const [key, entries] of localMediaImportGrants) {
    const live = entries.filter((entry) => isLiveGrant(entry, now, wallNow))
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
 * `batch` names the drop it belongs to. A read grant is found by `requestedPath`, the path the
 * user dropped or picked (default: the canonical path), as the page names it when it spends
 * the grant: no filesystem call is needed to find it. `sizeBytes` is the size main measured.
 */
export function recordLocalMediaImportGrant(
  canonicalPath: string,
  now = localMediaImportGrantClock(),
  kind: LocalMediaImportGrantKind = 'import',
  {
    wallNow = localMediaImportGrantWallClock(),
    batch,
    requestedPath,
    sizeBytes
  }: { wallNow?: number; batch?: string; requestedPath?: string; sizeBytes?: number } = {}
): void {
  const key = comparisonKey(
    kind === 'read' && requestedPath !== undefined ? path.resolve(requestedPath) : canonicalPath
  )
  let total = pruneLocalMediaImportGrants(now, wallNow)
  const entries = localMediaImportGrants.get(key) ?? []
  localMediaImportGrants.delete(key)
  localMediaImportGrants.set(key, [
    ...entries,
    {
      expiresAt: now + LOCAL_MEDIA_IMPORT_GRANT_TTL_MS,
      wallExpiresAt: wallNow + LOCAL_MEDIA_IMPORT_GRANT_TTL_MS,
      kind,
      ...(batch !== undefined
        ? {
            batch,
            batchDeadline: now + LOCAL_MEDIA_IMPORT_GRANT_BATCH_MAX_MS,
            batchWallDeadline: wallNow + LOCAL_MEDIA_IMPORT_GRANT_BATCH_MAX_MS
          }
        : {}),
      ...(kind === 'read'
        ? { readPath: canonicalPath, ...(sizeBytes !== undefined ? { sizeBytes } : {}) }
        : {})
    }
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
  kind: LocalMediaImportGrantKind = 'import',
  wallNow = localMediaImportGrantWallClock()
): boolean {
  return (localMediaImportGrants.get(comparisonKey(canonicalPath)) ?? []).some(
    (entry) => entry.kind === kind && isLiveGrant(entry, now, wallNow)
  )
}

/** A spent grant; finished() when its import (or read) is over, whatever its outcome. */
export type LocalMediaImportGrantUse = { finished(now?: number, wallNow?: number): void }

/**
 * Spends one live grant of this kind for this canonical path; null when there is none. It is
 * synchronous, so two uses that both saw the grant cannot both spend it. The imports of one
 * drop run one after another: while one of them runs, the drop's other grants wait, and when
 * it is finished each of them lives LOCAL_MEDIA_IMPORT_GRANT_TTL_MS more, never past
 * LOCAL_MEDIA_IMPORT_GRANT_BATCH_MAX_MS after it was recorded. Each is still spent once.
 */
export function spendLocalMediaImportGrant(
  canonicalPath: string,
  kind: LocalMediaImportGrantKind = 'import',
  now = localMediaImportGrantClock(),
  wallNow = localMediaImportGrantWallClock()
): LocalMediaImportGrantUse | null {
  return spendLocalMediaGrantEntry(canonicalPath, kind, now, wallNow)?.use ?? null
}

function spendLocalMediaGrantEntry(
  keyPath: string,
  kind: LocalMediaImportGrantKind,
  now: number,
  wallNow: number
): { spent: LocalMediaImportGrantEntry; use: LocalMediaImportGrantUse } | null {
  pruneLocalMediaImportGrants(now, wallNow)
  const key = comparisonKey(keyPath)
  const entries = localMediaImportGrants.get(key)
  const index = entries?.findIndex((entry) => entry.kind === kind) ?? -1
  if (!entries || index < 0) return null
  const [spent] = entries.splice(index, 1)
  if (!entries.length) localMediaImportGrants.delete(key)
  return { spent, use: batchGrantUse(spent.batch) }
}

/** The use of a spent grant: its drop's other grants wait while it runs (see above). */
function batchGrantUse(batch: string | undefined): LocalMediaImportGrantUse {
  if (batch === undefined) return { finished: () => undefined }
  localMediaImportBatchesInUse.set(batch, (localMediaImportBatchesInUse.get(batch) ?? 0) + 1)
  let done = false
  return {
    finished(
      finishedAt = localMediaImportGrantClock(),
      wallFinishedAt = localMediaImportGrantWallClock()
    ) {
      if (done) return
      done = true
      const running = (localMediaImportBatchesInUse.get(batch) ?? 1) - 1
      if (running > 0) localMediaImportBatchesInUse.set(batch, running)
      else localMediaImportBatchesInUse.delete(batch)
      for (const others of localMediaImportGrants.values()) {
        for (const entry of others) {
          if (entry.batch !== batch) continue
          entry.expiresAt = Math.max(entry.expiresAt, finishedAt + LOCAL_MEDIA_IMPORT_GRANT_TTL_MS)
          entry.wallExpiresAt = Math.max(
            entry.wallExpiresAt,
            wallFinishedAt + LOCAL_MEDIA_IMPORT_GRANT_TTL_MS
          )
        }
      }
    }
  }
}

/** spendLocalMediaImportGrant for a use that is over at once: true when a grant was spent. */
export function consumeLocalMediaImportGrant(
  canonicalPath: string,
  now = localMediaImportGrantClock(),
  kind: LocalMediaImportGrantKind = 'import',
  wallNow = localMediaImportGrantWallClock()
): boolean {
  const use = spendLocalMediaImportGrant(canonicalPath, kind, now, wallNow)
  use?.finished(now, wallNow)
  return use !== null
}

/**
 * Spends the one-use read grant of `filePath`, the path the user dropped or picked (a file on
 * a mapped network drive): readImageFromPath may then hand the renderer its bytes once,
 * reading `canonicalPath`, which main resolved when it granted the read, and no more than the
 * `sizeBytes` it measured then. Found by the path's text alone, so nothing touches the
 * filesystem here (on main's event loop): a share that stopped answering cannot block it. A
 * UNC or device path named by the renderer is refused.
 */
export function consumeLocalMediaReadGrant(
  filePath: string,
  now = localMediaImportGrantClock(),
  wallNow = localMediaImportGrantWallClock()
):
  | (LocalMediaImportGrantUse & {
      canonicalPath: string
      requestedPath: string
      sizeBytes?: number
    })
  | null {
  const trimmed = String(filePath || '').trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return null
  // A read grant is only ever for a plain local path the user dropped or picked.
  if (isWindowsNetworkLocalMediaPath(trimmed)) return null
  const requestedPath = path.resolve(trimmed)
  const granted = spendLocalMediaGrantEntry(requestedPath, 'read', now, wallNow)
  if (!granted) return null
  const { readPath, sizeBytes } = granted.spent
  return {
    canonicalPath: readPath ?? requestedPath,
    requestedPath,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    finished: granted.use.finished
  }
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
  if (
    process.platform === 'win32' &&
    (isWindowsNtNamespaceLocalMediaPath(trimmed) ||
      (isNetworkPath && !isWindowsNetworkPathScoped(trimmed)))
  ) {
    return null
  }
  const canonical = await canonicalizeExistingPathAsync(trimmed, realpath)
  if (!canonical) return null
  const persisted = { canonicalPath: canonical, viaImportGrant: false }
  if (isScopedCanonicalLocalMediaPath(canonical)) return persisted
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

export function countLocalMediaImportGrantsForTest(
  now = localMediaImportGrantClock(),
  wallNow = localMediaImportGrantWallClock()
): number {
  return pruneLocalMediaImportGrants(now, wallNow)
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
  scopedNetworkFileSpellings.clear()
  scopedNetworkDirectorySpellings.clear()
  grantExcludedFolders.clear()
  localMediaImportGrants.clear()
  localMediaImportBatchesInUse.clear()
  localMediaGrantsPath = null
  localMediaGrantsDirty = false
}
