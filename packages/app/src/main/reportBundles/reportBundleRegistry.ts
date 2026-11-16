/**
 * MAIN registry of canvas report bundles.
 *
 * MAIN is the only authority that says "this report bundle was written by this app just now,
 * for this conversation, and is unchanged":
 *
 * 1. beginReportBundle opens a one-shot write session (ticket, at most 10 minutes) for one
 *    directory directly under `<root>/.report_bundles`, where root is MAIN's own project or
 *    data root. MAIN records the issue time and the canonical directory.
 * 2. The producer writes the bundle files and manifest.json, then registerReportBundle seals
 *    it: every file must be a regular file with one link inside the directory whose ctime is not
 *    older than the ticket (so legacy bundles can never be re-signed). MAIN writes its own
 *    canonical manifest snapshot under `<userData>/report-bundles/<sha256(binding)>/` and
 *    returns a random binding (a bearer secret; only its sha256 is stored).
 * 3. verifyReportBundles / isBoundTo check binding, conversation, primary path and that the
 *    files are unchanged (same size, mtime, ctime, inode and one link; rehash on any
 *    difference). Every failure, including an uninitialised registry, is a refusal.
 *
 * Threat model: this protects against report descriptors that arrive as data (stored
 * conversations, imports, drags, model or tool replies). It does not protect against a
 * compromised renderer, which can already read every local-media root (userData included,
 * so it can read registry.json and the snapshots; bindings cannot be derived from them).
 * Residual risk: verify checks the files, then the renderer reads the primary and the images
 * from the original bundle directory; a file swapped in that window is sent.
 *
 * Importing this module touches no app path; initializeReportBundleRegistry does.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { MAX_FULL_FILE_BYTES, MAX_TEXT_FILE_BYTES } from '@shared/api/svcFs'
import {
  REPORT_BUNDLES_ROOT_DIR_NAME,
  REPORT_BUNDLE_MAX_MANIFEST_ENTRIES,
  REPORT_BUNDLE_VERIFY_MAX_ITEMS,
  isReportBundleBinding,
  isReportBundleTicket,
  type ReportBundleRole
} from '@shared/reportBundle'
import { localMediaUrlToFilePath, toLocalMediaUrl } from '@shared/localMediaUrl'
import type {
  BeginReportBundleReq,
  BeginReportBundleResp,
  RegisterReportBundleReq,
  RegisterReportBundleResp,
  ReportBundleConversation,
  VerifyReportBundleResult,
  VerifyReportBundlesReq,
  VerifyReportBundlesResp
} from '@shared/api/svcReportBundles'
import { hasLocalMediaTraversal } from '../localMediaAccess'

export const REPORT_BUNDLE_TICKET_TTL_MS = 10 * 60_000
/** File-system timestamps can lag the wall clock (coarse kernel clocks, FAT/exFAT granularity). */
export const REPORT_BUNDLE_CTIME_TOLERANCE_MS = 2_000
export const REPORT_BUNDLE_MAX_MANIFEST_BYTES = 256 * 1024
export const REPORT_BUNDLE_MAX_RECORDS = 2_000
export const REPORT_BUNDLE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const MAX_OUTSTANDING_TICKETS = 64
const REGISTRY_VERSION = 1
const REGISTRY_FLUSH_DELAY_MS = 250
const MAX_REGISTRY_FILE_BYTES = 64 * 1024 * 1024
const MAX_MANIFEST_NAME_CHARS = 1024
const MAX_MANIFEST_TITLE_CHARS = 4096
const MAX_BUNDLE_NAME_CHARS = 255
const READ_CHUNK_BYTES = 1024 * 1024
const SNAPSHOT_DIR_NAME = 'report-bundles'
const REGISTRY_FILE_NAME = 'registry.json'
const SNAPSHOT_MANIFEST_NAME = 'manifest.json'
const REFUSED_MESSAGE = 'Report bundle registration refused.'
const SHA256_HEX = /^[a-f0-9]{64}$/
const DECIMAL = /^\d{1,40}$/
const MIME_TYPE_PATTERN = /^[-!#$%&'*+.^_`|~0-9A-Za-z]+\/[-!#$%&'*+.^_`|~0-9A-Za-z]+$/
const MANIFEST_ROLES: readonly ReportBundleRole[] = [
  'primary-report',
  'report-image',
  'report-ocr',
  'manifest'
]

/** Refusal with a fixed public message; `reason` is a short internal code without paths. */
export class ReportBundleRefusedError extends Error {
  constructor(readonly reason: string) {
    super(REFUSED_MESSAGE)
    this.name = 'ReportBundleRefusedError'
  }
}

type FileFingerprint = {
  path: string
  size: number
  mtimeNs: string
  ctimeNs: string
  ino: string
  dev: string
  sha256: string
}

type RegistryRecord = {
  bindingHash: string
  bundleDir: string
  bundleId: string
  conversation: ReportBundleConversation
  primary: FileFingerprint
  images: FileFingerprint[]
  snapshotSha256: string
  createdAt: number
  lastVerifiedAt: number
}

type WriteTicket = {
  canonicalDir: string
  container: string
  bundleId: string
  conversation: ReportBundleConversation
  issuedAt: number
}

type RegistryState = {
  snapshotRoot: string
  registryPath: string
  now: () => number
  maxRecords: number
  flushDelayMs: number
  records: Map<string, RegistryRecord>
  tickets: Map<string, WriteTicket>
  dirty: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
}

export type ReportBundleRegistryOptions = {
  userDataDir: string
  now?: () => number
  maxRecords?: number
  flushDelayMs?: number
}

let state: RegistryState | null = null

const refuse = (reason: string): never => {
  throw new ReportBundleRefusedError(reason)
}

const pathKey = (filePath: string): string =>
  process.platform === 'win32' ? filePath.toLowerCase() : filePath

const samePath = (left: string, right: string): boolean => pathKey(left) === pathKey(right)

const sha256Hex = (value: string | Uint8Array): string =>
  crypto.createHash('sha256').update(value).digest('hex')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOptionalString = (value: unknown, maxChars: number): boolean =>
  value === undefined || (typeof value === 'string' && value.length <= maxChars)

function isStrictlyInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    samePath(path.join(parent, relative), candidate)
  )
}

function isSafePathSegment(segment: string, maxChars: number): boolean {
  return (
    segment.length > 0 &&
    segment.length <= maxChars &&
    segment !== '.' &&
    segment !== '..' &&
    // Windows: drive letters, alternate data streams, and names that the OS silently trims.
    !/[\\/:\0]/.test(segment) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(segment) &&
    !/[. ]$/.test(segment)
  )
}

function requireState(): RegistryState {
  return state ?? refuse('not-initialised')
}

/* ------------------------------------------------------------------ persistence */

function isFingerprint(value: unknown): value is FileFingerprint {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    path.isAbsolute(value.path) &&
    !value.path.includes('\0') &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.mtimeNs === 'string' &&
    DECIMAL.test(value.mtimeNs) &&
    typeof value.ctimeNs === 'string' &&
    DECIMAL.test(value.ctimeNs) &&
    typeof value.ino === 'string' &&
    DECIMAL.test(value.ino) &&
    typeof value.dev === 'string' &&
    DECIMAL.test(value.dev) &&
    typeof value.sha256 === 'string' &&
    SHA256_HEX.test(value.sha256)
  )
}

function parsePersistedRecord(value: unknown): RegistryRecord | null {
  if (!isRecord(value)) return null
  const conversation = value.conversation
  if (
    typeof value.bindingHash !== 'string' ||
    !SHA256_HEX.test(value.bindingHash) ||
    typeof value.bundleDir !== 'string' ||
    !path.isAbsolute(value.bundleDir) ||
    typeof value.bundleId !== 'string' ||
    !isRecord(conversation) ||
    typeof conversation.conversationId !== 'string' ||
    !conversation.conversationId ||
    (conversation.storageScope !== undefined && typeof conversation.storageScope !== 'string') ||
    !isFingerprint(value.primary) ||
    !Array.isArray(value.images) ||
    value.images.length > REPORT_BUNDLE_MAX_MANIFEST_ENTRIES ||
    !value.images.every(isFingerprint) ||
    typeof value.snapshotSha256 !== 'string' ||
    !SHA256_HEX.test(value.snapshotSha256) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.lastVerifiedAt !== 'number' ||
    !Number.isFinite(value.lastVerifiedAt)
  ) {
    return null
  }
  return {
    bindingHash: value.bindingHash,
    bundleDir: value.bundleDir,
    bundleId: value.bundleId,
    conversation: {
      conversationId: conversation.conversationId,
      ...(typeof conversation.storageScope === 'string'
        ? { storageScope: conversation.storageScope }
        : {})
    },
    primary: { ...value.primary },
    images: value.images.map((image) => ({ ...image })),
    snapshotSha256: value.snapshotSha256,
    createdAt: value.createdAt,
    lastVerifiedAt: value.lastVerifiedAt
  }
}

function loadRecords(current: RegistryState): void {
  let raw: string
  try {
    const stat = fs.lstatSync(current.registryPath)
    if (!stat.isFile() || stat.size > MAX_REGISTRY_FILE_BYTES) {
      console.warn('[ReportBundles] Ignoring an unexpected registry file.')
      return
    }
    raw = fs.readFileSync(current.registryPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[ReportBundles] Failed to read the registry; starting empty.')
    }
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn('[ReportBundles] The registry is not valid JSON; starting empty.')
    return
  }
  if (!isRecord(parsed) || parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.records))
    return
  const records = parsed.records
    .map(parsePersistedRecord)
    .filter((record): record is RegistryRecord => record !== null)
    .sort((left, right) => right.lastVerifiedAt - left.lastVerifiedAt)
  for (const record of records) {
    if (current.records.has(record.bindingHash)) continue
    if (current.records.size >= current.maxRecords) {
      removeSnapshot(current, record.bindingHash)
      current.dirty = true
      continue
    }
    current.records.set(record.bindingHash, record)
  }
}

function persistRecords(current: RegistryState): void {
  if (!current.dirty) return
  const payload = { version: REGISTRY_VERSION, records: Array.from(current.records.values()) }
  const tempPath = `${current.registryPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.mkdirSync(path.dirname(current.registryPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    fs.renameSync(tempPath, current.registryPath)
    current.dirty = false
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // Ignore cleanup failures after a persistence error.
    }
    console.warn('[ReportBundles] Failed to persist the registry:', (error as Error)?.name)
  }
}

function schedulePersist(current: RegistryState): void {
  current.dirty = true
  if (current.flushTimer) return
  current.flushTimer = setTimeout(() => {
    current.flushTimer = null
    if (state === current) persistRecords(current)
  }, current.flushDelayMs)
  current.flushTimer.unref?.()
}

function flushNow(current: RegistryState): void {
  if (current.flushTimer) {
    clearTimeout(current.flushTimer)
    current.flushTimer = null
  }
  persistRecords(current)
}

function snapshotDirFor(current: RegistryState, bindingHash: string): string {
  return path.join(current.snapshotRoot, bindingHash)
}

function removeSnapshot(current: RegistryState, bindingHash: string): void {
  if (!SHA256_HEX.test(bindingHash)) return
  try {
    fs.rmSync(snapshotDirFor(current, bindingHash), { recursive: true, force: true })
  } catch {
    console.warn('[ReportBundles] Failed to remove a report-bundle snapshot.')
  }
}

function dropRecord(current: RegistryState, bindingHash: string): void {
  if (current.records.delete(bindingHash)) removeSnapshot(current, bindingHash)
}

/** Loads the registry after Electron's userData path is final. Never throws. */
export function initializeReportBundleRegistry(options: ReportBundleRegistryOptions): void {
  if (state?.flushTimer) clearTimeout(state.flushTimer)
  state = null
  try {
    const userDataDir = path.resolve(options.userDataDir)
    const snapshotRoot = path.join(userDataDir, SNAPSHOT_DIR_NAME)
    const next: RegistryState = {
      snapshotRoot,
      registryPath: path.join(snapshotRoot, REGISTRY_FILE_NAME),
      now: options.now ?? Date.now,
      maxRecords: Math.max(1, Math.floor(options.maxRecords ?? REPORT_BUNDLE_MAX_RECORDS)),
      flushDelayMs: Math.max(0, options.flushDelayMs ?? REGISTRY_FLUSH_DELAY_MS),
      records: new Map(),
      tickets: new Map(),
      dirty: false,
      flushTimer: null
    }
    loadRecords(next)
    state = next
    if (next.dirty) flushNow(next)
  } catch (error) {
    state = null
    console.warn('[ReportBundles] Registry initialisation failed:', (error as Error)?.name)
  }
}

export function isReportBundleRegistryInitialized(): boolean {
  return state !== null
}

export function flushReportBundleRegistry(): void {
  if (state) flushNow(state)
}

export function resetReportBundleRegistryForTest(): void {
  if (state?.flushTimer) clearTimeout(state.flushTimer)
  state = null
}

/* ------------------------------------------------------------------ file checks */

type BigStats = fs.BigIntStats

const sameIdentity = (left: BigStats, right: BigStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

const isSingleLinkRegularFile = (stats: BigStats): boolean =>
  stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n

const openFlags = (): number => fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)

/**
 * Hashes one regular single-link file by stream. The descriptor's identity must match the
 * lstat taken before opening and must not change while reading.
 */
async function fingerprintFile(
  filePath: string,
  maxBytes: number,
  keepBytes = false
): Promise<{ fingerprint: FileFingerprint; stats: BigStats; bytes?: Buffer }> {
  const before = await fsp.lstat(filePath, { bigint: true })
  if (!isSingleLinkRegularFile(before)) refuse('not-a-single-link-file')
  if (before.size > BigInt(maxBytes)) refuse('file-too-large')
  const handle = await fsp.open(filePath, openFlags())
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameIdentity(before, opened) || opened.nlink !== 1n) refuse('file-changed')
    const hash = crypto.createHash('sha256')
    const size = Number(opened.size)
    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, size)))
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > size) refuse('file-changed')
      hash.update(buffer.subarray(0, bytesRead))
      if (keepBytes) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    const after = await handle.stat({ bigint: true })
    if (total !== size || !sameIdentity(opened, after) || after.nlink !== 1n) refuse('file-changed')
    return {
      fingerprint: {
        path: filePath,
        size,
        mtimeNs: after.mtimeNs.toString(),
        ctimeNs: after.ctimeNs.toString(),
        ino: after.ino.toString(),
        dev: after.dev.toString(),
        sha256: hash.digest('hex')
      },
      stats: after,
      ...(keepBytes ? { bytes: Buffer.concat(chunks, total) } : {})
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function assertFresh(stats: BigStats, ticket: WriteTicket): void {
  const ctimeMs = Number(stats.ctimeNs / 1_000_000n)
  if (ctimeMs < ticket.issuedAt - REPORT_BUNDLE_CTIME_TOLERANCE_MS) refuse('stale-file')
}

async function assertCanonicalDirectory(dirPath: string): Promise<string> {
  const stats = await fsp.lstat(dirPath)
  if (!stats.isDirectory() || stats.isSymbolicLink()) refuse('linked-directory')
  const real = path.resolve(await fsp.realpath(dirPath))
  if (!samePath(real, dirPath)) refuse('linked-directory')
  return real
}

/** Resolves a manifest relativePath inside the bundle without following any link. */
async function resolveEntryPath(bundleDir: string, relativePath: string): Promise<string> {
  if (
    !relativePath ||
    relativePath.length > MAX_MANIFEST_NAME_CHARS ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath)
  ) {
    refuse('bad-relative-path')
  }
  const segments = relativePath.split(/[\\/]/)
  if (!segments.every((segment) => isSafePathSegment(segment, MAX_MANIFEST_NAME_CHARS)))
    refuse('bad-relative-path')
  const full = path.join(bundleDir, ...segments)
  if (!isStrictlyInside(bundleDir, full)) refuse('bad-relative-path')
  const real = path.resolve(await fsp.realpath(full))
  if (!samePath(real, full) || !isStrictlyInside(bundleDir, real)) refuse('linked-entry')
  return real
}

/** Strict local-media / file URL -> canonical absolute path (no query, fragment or `..`). */
function parseLocalFileUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length > 16384) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'local-media:' && parsed.protocol !== 'file:') return null
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash)
      return null
  } catch {
    return null
  }
  if (hasLocalMediaTraversal(url)) return null
  const filePath = localMediaUrlToFilePath(url)
  if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) return null
  return path.resolve(filePath)
}

/* ------------------------------------------------------------------ manifest */

type ParsedEntry = {
  role: ReportBundleRole
  fileName?: string
  mimeType?: string
  refName?: string
  relativePath?: string
  sourceUrl?: string
}

type ParsedManifest = {
  title?: string
  entries: ParsedEntry[]
}

function parseManifest(bytes: Buffer, bundleId: string): ParsedManifest {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return refuse('manifest-json')
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.bundleId !== bundleId ||
    !isOptionalString(value.title, MAX_MANIFEST_TITLE_CHARS) ||
    !isOptionalString(value.createdAt, MAX_MANIFEST_NAME_CHARS) ||
    !isOptionalString(value.primaryRefName, MAX_MANIFEST_NAME_CHARS) ||
    !Array.isArray(value.entries) ||
    value.entries.length > REPORT_BUNDLE_MAX_MANIFEST_ENTRIES
  ) {
    return refuse('manifest-shape')
  }
  const entries = value.entries.map((raw): ParsedEntry => {
    if (!isRecord(raw) || !MANIFEST_ROLES.includes(raw.role as ReportBundleRole))
      refuse('manifest-entry')
    const entry = raw as Record<string, unknown>
    if (
      (entry.role === 'report-image' &&
        (typeof entry.fileName !== 'string' || !entry.fileName.trim())) ||
      !isOptionalString(entry.fileName, MAX_MANIFEST_NAME_CHARS) ||
      !isOptionalString(entry.mimeType, MAX_MANIFEST_NAME_CHARS) ||
      !isOptionalString(entry.refName, MAX_MANIFEST_NAME_CHARS) ||
      !isOptionalString(entry.relativePath, MAX_MANIFEST_NAME_CHARS) ||
      !isOptionalString(entry.sourceUrl, REPORT_BUNDLE_MAX_MANIFEST_BYTES) ||
      (entry.sizeBytes !== undefined &&
        (typeof entry.sizeBytes !== 'number' ||
          !Number.isFinite(entry.sizeBytes) ||
          entry.sizeBytes < 0)) ||
      (entry.imageCount !== undefined &&
        (typeof entry.imageCount !== 'number' ||
          !Number.isSafeInteger(entry.imageCount) ||
          entry.imageCount < 0))
    ) {
      refuse('manifest-entry')
    }
    return {
      role: entry.role as ReportBundleRole,
      fileName: entry.fileName as string | undefined,
      mimeType: entry.mimeType as string | undefined,
      refName: entry.refName as string | undefined,
      relativePath: entry.relativePath as string | undefined,
      sourceUrl: entry.sourceUrl as string | undefined
    }
  })
  if (entries.filter((entry) => entry.role === 'primary-report').length !== 1)
    refuse('primary-count')
  return { title: value.title as string | undefined, entries }
}

/* ------------------------------------------------------------------ write session */

/**
 * Opens a one-shot write session for `bundleDir`, which must be directly under
 * `<root>/.report_bundles` for one of MAIN's own roots (never a renderer-supplied root).
 * Creates the directory when it does not exist yet.
 */
export async function beginReportBundle(
  req: BeginReportBundleReq,
  bundleRoots: readonly string[]
): Promise<BeginReportBundleResp> {
  return await refusingIo(() => beginReportBundleUnchecked(req, bundleRoots))
}

/** File-system errors carry paths; callers only ever see the fixed refusal. */
async function refusingIo<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ReportBundleRefusedError) throw error
    throw new ReportBundleRefusedError('io')
  }
}

async function beginReportBundleUnchecked(
  req: BeginReportBundleReq,
  bundleRoots: readonly string[]
): Promise<BeginReportBundleResp> {
  const current = requireState()
  const requested = req.bundleDir
  if (typeof requested !== 'string' || requested.includes('\0') || !path.isAbsolute(requested))
    refuse('bad-directory')
  const resolved = path.resolve(requested)
  const bundleId = path.basename(resolved)
  if (!isSafePathSegment(bundleId, MAX_BUNDLE_NAME_CHARS)) refuse('bad-directory')
  const root = bundleRoots
    .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
    .filter((candidate) => candidate && !candidate.includes('\0') && path.isAbsolute(candidate))
    .find((candidate) =>
      samePath(path.resolve(candidate, REPORT_BUNDLES_ROOT_DIR_NAME), path.dirname(resolved))
    )
  if (!root) return refuse('outside-root')

  const containerPath = path.resolve(root, REPORT_BUNDLES_ROOT_DIR_NAME)
  await fsp.mkdir(containerPath, { recursive: true })
  const container = path.resolve(await fsp.realpath(containerPath))
  if (!(await fsp.stat(container)).isDirectory()) refuse('bad-directory')
  const dirPath = path.join(container, bundleId)
  try {
    await fsp.mkdir(dirPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') refuse('bad-directory')
  }
  const canonicalDir = await assertCanonicalDirectory(dirPath)
  if (!samePath(path.dirname(canonicalDir), container)) refuse('outside-root')

  const issuedAt = current.now()
  for (const [ticket, entry] of current.tickets) {
    if (issuedAt - entry.issuedAt > REPORT_BUNDLE_TICKET_TTL_MS) current.tickets.delete(ticket)
  }
  while (current.tickets.size >= MAX_OUTSTANDING_TICKETS) {
    const oldest = current.tickets.keys().next().value
    if (oldest === undefined) break
    current.tickets.delete(oldest)
  }
  const ticket = `rbt1.${crypto.randomBytes(32).toString('base64url')}`
  current.tickets.set(ticket, {
    canonicalDir,
    container,
    bundleId: path.basename(canonicalDir),
    conversation: { ...req.conversation },
    issuedAt
  })
  return { ticket }
}

type VerifiedEntry = { entry: ParsedEntry; fingerprint: FileFingerprint }

/** Seals the bundle written under a ticket and returns its binding. */
export async function registerReportBundle(
  req: RegisterReportBundleReq
): Promise<RegisterReportBundleResp> {
  return await refusingIo(() => registerReportBundleUnchecked(req))
}

async function registerReportBundleUnchecked(
  req: RegisterReportBundleReq
): Promise<RegisterReportBundleResp> {
  const current = requireState()
  if (!isReportBundleTicket(req?.ticket)) return refuse('unknown-ticket')
  const ticket = current.tickets.get(req.ticket)
  // One-shot: a ticket is consumed by its first use, whatever the outcome.
  current.tickets.delete(req.ticket)
  if (!ticket) return refuse('unknown-ticket')
  const startedAt = current.now()
  if (startedAt < ticket.issuedAt || startedAt - ticket.issuedAt > REPORT_BUNDLE_TICKET_TTL_MS)
    refuse('expired-ticket')

  const container = path.resolve(await fsp.realpath(ticket.container))
  if (!samePath(container, ticket.container)) refuse('linked-directory')
  const bundleDir = await assertCanonicalDirectory(ticket.canonicalDir)
  if (!samePath(path.dirname(bundleDir), container)) refuse('outside-root')

  const manifestPath = path.join(bundleDir, SNAPSHOT_MANIFEST_NAME)
  const manifestRead = await fingerprintFile(manifestPath, REPORT_BUNDLE_MAX_MANIFEST_BYTES, true)
  assertFresh(manifestRead.stats, ticket)
  const manifest = parseManifest(manifestRead.bytes as Buffer, ticket.bundleId)

  let omittedEntries = 0
  let totalBytes = 0
  let primary: VerifiedEntry | null = null
  const images: VerifiedEntry[] = []
  const seenPaths = new Set<string>()
  for (const entry of manifest.entries) {
    if (entry.relativePath === undefined) {
      // An address MAIN cannot vouch for (e.g. an image the canvas failed to save): never honoured.
      if (entry.role === 'primary-report') refuse('primary-without-file')
      if (entry.role === 'report-image' && !entry.sourceUrl) refuse('manifest-entry')
      omittedEntries += 1
      continue
    }
    const filePath = await resolveEntryPath(bundleDir, entry.relativePath)
    if (samePath(filePath, manifestPath)) refuse('manifest-entry')
    const maxBytes = entry.role === 'report-image' ? MAX_FULL_FILE_BYTES : MAX_TEXT_FILE_BYTES
    const read = await fingerprintFile(filePath, maxBytes)
    assertFresh(read.stats, ticket)
    totalBytes += read.fingerprint.size
    if (totalBytes > REPORT_BUNDLE_MAX_TOTAL_BYTES) refuse('bundle-too-large')
    if (entry.role !== 'primary-report' && entry.role !== 'report-image') continue
    if (seenPaths.has(pathKey(filePath))) refuse('duplicate-entry')
    seenPaths.add(pathKey(filePath))
    if (entry.role === 'primary-report') primary = { entry, fingerprint: read.fingerprint }
    else images.push({ entry, fingerprint: read.fingerprint })
  }
  if (!primary) return refuse('primary-count')
  if (state !== current) return refuse('not-initialised')

  const binding = `rb1.${crypto.randomBytes(32).toString('base64url')}`
  const bindingHash = sha256Hex(binding)
  const snapshotBytes = buildSnapshotManifest({
    bundleId: ticket.bundleId,
    title: manifest.title,
    createdAt: startedAt,
    primary,
    images
  })
  const snapshotDir = snapshotDirFor(current, bindingHash)
  try {
    await fsp.mkdir(current.snapshotRoot, { recursive: true, mode: 0o700 })
    await fsp.mkdir(snapshotDir, { mode: 0o700 })
    const snapshotPath = path.join(snapshotDir, SNAPSHOT_MANIFEST_NAME)
    const tempPath = `${snapshotPath}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(tempPath, snapshotBytes, { mode: 0o600, flag: 'wx' })
    await fsp.rename(tempPath, snapshotPath)
  } catch {
    removeSnapshot(current, bindingHash)
    return refuse('snapshot-write')
  }
  if (state !== current) {
    removeSnapshot(current, bindingHash)
    return refuse('not-initialised')
  }

  // A new registration of the same directory supersedes every older one.
  for (const record of Array.from(current.records.values())) {
    if (samePath(record.bundleDir, bundleDir)) dropRecord(current, record.bindingHash)
  }
  current.records.set(bindingHash, {
    bindingHash,
    bundleDir,
    bundleId: ticket.bundleId,
    conversation: ticket.conversation,
    primary: primary.fingerprint,
    images: images.map((image) => image.fingerprint),
    snapshotSha256: sha256Hex(snapshotBytes),
    createdAt: startedAt,
    lastVerifiedAt: startedAt
  })
  while (current.records.size > current.maxRecords) {
    let victim: RegistryRecord | null = null
    for (const record of current.records.values()) {
      if (!victim || record.lastVerifiedAt < victim.lastVerifiedAt) victim = record
    }
    if (!victim) break
    dropRecord(current, victim.bindingHash)
  }
  // A lost registration would refuse the report forever: write it now, not debounced.
  current.dirty = true
  flushNow(current)
  return { binding, bundleId: ticket.bundleId, imageCount: images.length, omittedEntries }
}

function buildSnapshotManifest(input: {
  bundleId: string
  title?: string
  createdAt: number
  primary: VerifiedEntry
  images: VerifiedEntry[]
}): Buffer {
  const toEntry = (verified: VerifiedEntry, role: 'primary-report' | 'report-image') => {
    const { entry, fingerprint } = verified
    const fileName = entry.fileName?.trim() || path.basename(fingerprint.path)
    const sourceUrl = toLocalMediaUrl(fingerprint.path) ?? refuse('snapshot-url')
    return {
      role,
      fileName,
      ...(entry.mimeType && MIME_TYPE_PATTERN.test(entry.mimeType)
        ? { mimeType: entry.mimeType }
        : {}),
      refName: entry.refName?.trim() || fileName,
      sourceUrl,
      sizeBytes: fingerprint.size,
      ...(role === 'primary-report' ? { imageCount: input.images.length } : {})
    }
  }
  const primaryEntry = toEntry(input.primary, 'primary-report')
  const manifest = {
    version: 1,
    bundleId: input.bundleId,
    title: input.title ?? input.bundleId,
    createdAt: new Date(input.createdAt).toISOString(),
    primaryRefName: primaryEntry.refName,
    entries: [primaryEntry, ...input.images.map((image) => toEntry(image, 'report-image'))]
  }
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ verification */

function conversationMatches(
  record: RegistryRecord,
  conversation: ReportBundleConversation | undefined
): boolean {
  if (!conversation || typeof conversation.conversationId !== 'string') return false
  if (record.conversation.conversationId !== conversation.conversationId) return false
  return (
    record.conversation.storageScope === undefined ||
    record.conversation.storageScope === conversation.storageScope
  )
}

const fingerprintMatchesStats = (fingerprint: FileFingerprint, stats: BigStats): boolean =>
  BigInt(fingerprint.size) === stats.size &&
  fingerprint.mtimeNs === stats.mtimeNs.toString() &&
  fingerprint.ctimeNs === stats.ctimeNs.toString() &&
  fingerprint.ino === stats.ino.toString() &&
  fingerprint.dev === stats.dev.toString()

/** Same regular single-link file at the same canonical path; rehash on any metadata change. */
async function checkUnchanged(fingerprint: FileFingerprint): Promise<FileFingerprint | null> {
  try {
    const stats = await fsp.lstat(fingerprint.path, { bigint: true })
    if (!isSingleLinkRegularFile(stats)) return null
    const real = path.resolve(await fsp.realpath(fingerprint.path))
    if (!samePath(real, fingerprint.path)) return null
    if (fingerprintMatchesStats(fingerprint, stats)) return fingerprint
    const reread = await fingerprintFile(fingerprint.path, MAX_FULL_FILE_BYTES)
    return reread.fingerprint.sha256 === fingerprint.sha256 &&
      reread.fingerprint.size === fingerprint.size
      ? reread.fingerprint
      : null
  } catch {
    return null
  }
}

async function primaryUrlMatches(record: RegistryRecord, primaryUrl: string): Promise<boolean> {
  const filePath = parseLocalFileUrl(primaryUrl)
  if (!filePath) return false
  try {
    const real = path.resolve(await fsp.realpath(filePath))
    if (!samePath(real, record.primary.path)) return false
    const stats = await fsp.lstat(real, { bigint: true })
    return (
      stats.ino.toString() === record.primary.ino && stats.dev.toString() === record.primary.dev
    )
  } catch {
    return false
  }
}

async function verifyOne(
  current: RegistryState,
  binding: string,
  primaryUrl: string,
  conversation: ReportBundleConversation
): Promise<VerifyReportBundleResult> {
  const refused: VerifyReportBundleResult = { binding, status: 'refused' }
  const bindingHash = sha256Hex(binding)
  const record = current.records.get(bindingHash)
  if (!record || !conversationMatches(record, conversation)) return refused
  if (!(await primaryUrlMatches(record, primaryUrl))) return refused

  const snapshotPath = path.join(snapshotDirFor(current, bindingHash), SNAPSHOT_MANIFEST_NAME)
  try {
    const snapshot = await fingerprintFile(snapshotPath, REPORT_BUNDLE_MAX_MANIFEST_BYTES)
    if (snapshot.fingerprint.sha256 !== record.snapshotSha256) return refused
  } catch {
    return refused
  }

  const primary = await checkUnchanged(record.primary)
  if (!primary) return refused
  const images: FileFingerprint[] = []
  for (const image of record.images) {
    const checked = await checkUnchanged(image)
    if (!checked) return refused
    images.push(checked)
  }
  // The record may have been superseded or evicted while the files were checked.
  if (state !== current || current.records.get(bindingHash) !== record) return refused
  const manifestUrl = toLocalMediaUrl(snapshotPath)
  if (!manifestUrl) return refused
  record.primary = primary
  record.images = images
  record.lastVerifiedAt = current.now()
  schedulePersist(current)
  return { binding, status: 'verified', manifestUrl, imageCount: record.images.length }
}

/**
 * Verifies bound primary reports for one conversation. Items are deduplicated by binding;
 * more than {@link REPORT_BUNDLE_VERIFY_MAX_ITEMS} distinct bindings refuse every item, and so
 * does a binding listed with two different primary URLs. Never throws for a refusal.
 */
export async function verifyReportBundles(
  req: VerifyReportBundlesReq
): Promise<VerifyReportBundlesResp> {
  const current = state
  const distinct = new Map<string, string | null>()
  for (const item of Array.isArray(req?.items) ? req.items : []) {
    if (!isReportBundleBinding(item?.binding)) continue
    const known = distinct.get(item.binding)
    distinct.set(
      item.binding,
      known === undefined || known === item.primaryUrl ? item.primaryUrl : null
    )
  }
  if (!current || distinct.size > REPORT_BUNDLE_VERIFY_MAX_ITEMS) {
    return {
      results: Array.from(distinct.keys())
        .slice(0, REPORT_BUNDLE_VERIFY_MAX_ITEMS)
        .map((binding) => ({ binding, status: 'refused' as const }))
    }
  }
  const results: VerifyReportBundleResult[] = []
  for (const [binding, primaryUrl] of distinct) {
    if (primaryUrl === null || typeof primaryUrl !== 'string') {
      results.push({ binding, status: 'refused' })
      continue
    }
    try {
      results.push(await verifyOne(current, binding, primaryUrl, req.conversation))
    } catch {
      results.push({ binding, status: 'refused' })
    }
  }
  return { results }
}

/* ------------------------------------------------------------------ MAIN chat boundary */

function decodeDataUrl(url: string): Buffer | null {
  const comma = url.indexOf(',')
  if (!url.startsWith('data:') || comma < 0) return null
  const header = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  if (payload.length > MAX_TEXT_FILE_BYTES * 3 + 16) return null
  try {
    if (/;base64$/i.test(header)) {
      const compact = payload.replace(/\s+/g, '')
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null
      return Buffer.from(compact, 'base64')
    }
    return Buffer.from(decodeURIComponent(payload), 'utf8')
  } catch {
    return null
  }
}

function isUnchangedSync(fingerprint: FileFingerprint): boolean {
  try {
    const stats = fs.lstatSync(fingerprint.path, { bigint: true })
    if (!isSingleLinkRegularFile(stats)) return false
    if (fingerprintMatchesStats(fingerprint, stats)) return true
    if (stats.size > BigInt(MAX_TEXT_FILE_BYTES)) return false
    return sha256Hex(fs.readFileSync(fingerprint.path)) === fingerprint.sha256
  } catch {
    return false
  }
}

/**
 * Synchronous check for the MAIN chat boundary: the binding belongs to this conversation and
 * `primaryUrl` is the registered primary itself, either as a local-media/file URL of the
 * unchanged registered file or as a data: URL whose decoded bytes hash to the registered
 * primary. Child images are checked only by verifyReportBundles.
 */
export function isBoundTo(binding: unknown, conversationId: unknown, primaryUrl: unknown): boolean {
  const current = state
  if (
    !current ||
    !isReportBundleBinding(binding) ||
    typeof conversationId !== 'string' ||
    !conversationId ||
    typeof primaryUrl !== 'string'
  ) {
    return false
  }
  const record = current.records.get(sha256Hex(binding))
  if (!record || record.conversation.conversationId !== conversationId) return false
  if (primaryUrl.startsWith('data:')) {
    const bytes = decodeDataUrl(primaryUrl)
    return bytes !== null && sha256Hex(bytes) === record.primary.sha256
  }
  const filePath = parseLocalFileUrl(primaryUrl)
  if (!filePath) return false
  try {
    const real = path.resolve(fs.realpathSync.native(filePath))
    return samePath(real, record.primary.path) && isUnchangedSync(record.primary)
  } catch {
    return false
  }
}
