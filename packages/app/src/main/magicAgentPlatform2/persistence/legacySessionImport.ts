import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { AssistantSessionStore } from '../../assistantRuntime/sessionStore'
import type { AssistantSessionRecord } from '../../assistantRuntime/types'
import {
  canonicalJson,
  MAX_RESOURCE_MUTATION_BATCH_SIZE,
  type MagicAgentEventStore,
  type ResourceMutationInput
} from './eventStore'

const TIMESTAMP_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
  'occurredAt',
  'timestamp',
  'generatedAt',
  'completedAt',
  'cancelledAt',
  'failedAt'
])
export const MAX_LEGACY_SESSION_IMPORT_BYTES = 32 * 1024 * 1024
const LOCAL_PATH_KEYS = new Set([
  'path',
  'filepath',
  'absolutepath',
  'localpath',
  'storagepath',
  'rootdir',
  'workspacerootdir',
  'workspacemetafile',
  'memorydir',
  'memoryfile',
  'contextfile',
  'taskcontextfile',
  'pinnedcontextfile',
  'workflowdir',
  'outputdir',
  'downloaddir',
  'cachedir',
  'tempdir',
  'downloadpath',
  'localfile'
])
const BINARY_CONTENT_KEYS = new Set(['content', 'data', 'bytes', 'buffer', 'base64', 'blob'])
const SHA256 = /^[a-f0-9]{64}$/

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type LegacyStorageVersion = 1 | 2 | 3
export type LegacySessionImportEntry = Readonly<{
  originalIndex: number
  raw: JsonValue
  normalized: JsonValue & {
    sessionKey: string
    runs: AssistantSessionRecord['runs']
    artifacts: AssistantSessionRecord['artifacts']
  }
}>
export type LegacySessionImportCounts = Readonly<{
  sessions: number
  runs: number
  artifacts: number
  resources: number
}>
export type LegacySessionImportPlan = Readonly<{
  kind: 'legacy-session-import-plan'
  version: 1
  mode: 'preview-only'
  authority: 'legacy-json-until-explicit-switch'
  importId: string
  createdAt: number
  contentDigest: string
  source: Readonly<{
    absolutePath: string
    storageVersion: LegacyStorageVersion
    sha256: string
    size: number
  }>
  entries: readonly LegacySessionImportEntry[]
  rawFile: JsonValue
  counts: LegacySessionImportCounts
}>

export class LegacySessionImportValidationError extends Error {
  readonly code = 'MAGIC_AGENT_LEGACY_IMPORT_VALIDATION'
  constructor(message = 'Invalid legacy session import input.', cause?: unknown) {
    super(message, { cause })
    this.name = 'LegacySessionImportValidationError'
  }
}
export class LegacySessionImportTooLargeError extends Error {
  readonly code = 'MAGIC_AGENT_LEGACY_IMPORT_TOO_LARGE'
  constructor(readonly resources: number) {
    super(
      `Legacy import requires ${resources} resource mutations; the atomic limit is ${MAX_RESOURCE_MUTATION_BATCH_SIZE}.`
    )
    this.name = 'LegacySessionImportTooLargeError'
  }
}
export class LegacySessionImportFileTooLargeError extends Error {
  readonly code = 'MAGIC_AGENT_LEGACY_IMPORT_FILE_TOO_LARGE'
  constructor(readonly size: bigint) {
    super(`Legacy session import source exceeds ${MAX_LEGACY_SESSION_IMPORT_BYTES} bytes.`)
    this.name = 'LegacySessionImportFileTooLargeError'
  }
}
export class LegacySessionImportSourceChangedError extends Error {
  readonly code = 'MAGIC_AGENT_LEGACY_IMPORT_SOURCE_CHANGED'
  constructor() {
    super('Legacy session import source changed after the plan was created.')
    this.name = 'LegacySessionImportSourceChangedError'
  }
}

const hashBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const hashCanonical = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex')
const binaryCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function jsonSafeClone<T>(value: T): T {
  try {
    return JSON.parse(canonicalJson(value)) as T
  } catch (error) {
    throw new LegacySessionImportValidationError('Value is not canonical JSON-safe.', error)
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

async function readStableSource(
  sourcePath: string
): Promise<{ bytes: Buffer; path: string; sha256: string }> {
  const absolutePath = resolve(sourcePath)
  const parent = dirname(absolutePath)
  const parentReal = await fs.realpath(parent)
  if (
    (process.platform === 'win32' ? parentReal.toLowerCase() : parentReal) !==
    (process.platform === 'win32' ? parent.toLowerCase() : parent)
  )
    throw new LegacySessionImportValidationError('Source parent directories must not be symlinks.')
  const path = join(parentReal, basename(absolutePath))
  const pathStat = await fs.lstat(path, { bigint: true })
  if (pathStat.isSymbolicLink() || !pathStat.isFile())
    throw new LegacySessionImportValidationError('Source must be a regular file, not a symlink.')
  const handle = await fs.open(path, 'r')
  let primaryError: unknown
  let result: { bytes: Buffer; path: string; sha256: string } | undefined
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile())
      throw new LegacySessionImportValidationError('Source must be a regular file.')
    if (before.size > BigInt(MAX_LEGACY_SESSION_IMPORT_BYTES))
      throw new LegacySessionImportFileTooLargeError(before.size)
    const buffer = Buffer.allocUnsafe(MAX_LEGACY_SESSION_IMPORT_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_LEGACY_SESSION_IMPORT_BYTES)
      throw new LegacySessionImportFileTooLargeError(BigInt(offset))
    const after = await handle.stat({ bigint: true })
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(offset) !== after.size
    )
      throw new LegacySessionImportSourceChangedError()
    const bytes = buffer.subarray(0, offset)
    result = { bytes, path, sha256: hashBytes(bytes) }
  } catch (error) {
    primaryError = error
  }
  try {
    await handle.close()
  } catch (closeError) {
    if (primaryError !== undefined)
      throw new AggregateError([primaryError, closeError], 'Source read and close both failed.', {
        cause: primaryError
      })
    throw closeError
  }
  if (primaryError !== undefined) throw primaryError
  return result!
}

function parseRawFile(bytes: Buffer): Record<string, JsonValue> {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new LegacySessionImportValidationError('Legacy session JSON is malformed.', error)
  }
  const clone = jsonSafeClone(parsed)
  if (
    !isRecord(clone) ||
    ![1, 2, 3].includes(clone.version as number) ||
    !Array.isArray(clone.sessions)
  )
    throw new LegacySessionImportValidationError('Unsupported legacy session JSON.')
  return clone as Record<string, JsonValue>
}

function matchingRaw(normalized: unknown, raw: unknown, index: number): unknown {
  if (!Array.isArray(raw)) return undefined
  const item = Array.isArray(normalized) ? normalized[index] : undefined
  if (isRecord(item)) {
    for (const key of ['runId', 'artifactId', 'eventId', 'id']) {
      if (typeof item[key] === 'string') {
        const match = raw.find((candidate) => isRecord(candidate) && candidate[key] === item[key])
        if (match !== undefined) return match
      }
    }
  }
  return raw[index]
}

function sanitizeKnownTimestamps(normalized: unknown, raw: unknown, key?: string): unknown {
  if (key && TIMESTAMP_KEYS.has(key)) return validTimestamp(raw) ? raw : 0
  if (Array.isArray(normalized))
    return normalized.map((item, index) =>
      sanitizeKnownTimestamps(item, matchingRaw(normalized, raw, index))
    )
  if (isRecord(normalized)) {
    const rawRecord = isRecord(raw) ? raw : {}
    return Object.fromEntries(
      Object.entries(normalized).map(([childKey, child]) => [
        childKey,
        sanitizeKnownTimestamps(child, rawRecord[childKey], childKey)
      ])
    )
  }
  return normalized
}

type SanitizerContext = 'general' | 'artifact' | 'attachment' | 'workspace' | 'context' | 'metadata'

function childContext(context: SanitizerContext, key: string, child: unknown): SanitizerContext {
  if (context === 'general') {
    if (key === 'artifacts' && Array.isArray(child)) return 'artifact'
    if (key === 'attachments' && Array.isArray(child)) return 'attachment'
    if (key === 'workspace') return 'workspace'
    if (key === 'contextSnapshot') return 'context'
    if (key === 'sourceMetadata') return 'metadata'
  }
  if (context === 'metadata') {
    if (key === 'artifacts' && Array.isArray(child)) return 'artifact'
    if (key === 'attachments' && Array.isArray(child)) return 'attachment'
  }
  return context
}

function sanitizeByContext(
  value: unknown,
  context: SanitizerContext = 'general',
  omittedFields?: string[],
  path = ''
): JsonValue {
  if (Array.isArray(value))
    return value.map((item, index) =>
      sanitizeByContext(item, context, omittedFields, `${path}[${index}]`)
    )
  if (!isRecord(value)) return value as JsonValue
  const effectiveContext =
    context === 'general' && typeof value.artifactId === 'string' ? 'artifact' : context
  const result: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase()
    const childPath = path ? `${path}.${key}` : key
    const removePath = effectiveContext !== 'general' && LOCAL_PATH_KEYS.has(lower)
    const removeBinary =
      (effectiveContext === 'artifact' ||
        effectiveContext === 'attachment' ||
        effectiveContext === 'metadata') &&
      BINARY_CONTENT_KEYS.has(lower)
    if (removePath || removeBinary || (effectiveContext === 'metadata' && key === 'sessions')) {
      omittedFields?.push(childPath)
      continue
    }
    result[key] = sanitizeByContext(
      child,
      childContext(effectiveContext, key, child),
      omittedFields,
      childPath
    )
  }
  return result
}

function normalizedSafeView(
  normalized: AssistantSessionRecord,
  raw: Record<string, unknown>
): JsonValue {
  const result = sanitizeKnownTimestamps(normalized, raw) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(raw, 'workspace'))
    result.workspace = sanitizeByContext(raw.workspace, 'workspace')
  else delete result.workspace
  if (Object.prototype.hasOwnProperty.call(raw, 'contextSnapshot'))
    result.contextSnapshot = sanitizeByContext(raw.contextSnapshot, 'context')
  else delete result.contextSnapshot
  return jsonSafeClone(result) as JsonValue
}

async function withTemporaryStore<T>(
  bytes: Buffer,
  action: (path: string) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'magicpot-legacy-import-'))
  let result: T | undefined
  let primaryError: unknown
  try {
    const copy = join(dir, 'chat-sessions.json')
    await fs.writeFile(copy, bytes, { flag: 'wx' })
    result = await action(copy)
  } catch (error) {
    primaryError = error
  }
  let cleanupError: unknown
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    cleanupError = error
  }
  if (primaryError !== undefined && cleanupError !== undefined)
    throw new AggregateError(
      [primaryError, cleanupError],
      'Legacy import failed and cleanup also failed.',
      { cause: primaryError }
    )
  if (primaryError !== undefined) throw primaryError
  if (cleanupError !== undefined) throw cleanupError
  return result as T
}

type TrustedContent = Readonly<{
  storageVersion: LegacyStorageVersion
  rawFile: JsonValue
  entries: readonly LegacySessionImportEntry[]
  counts: LegacySessionImportCounts
  contentDigest: string
}>

function assertUniqueContent(entries: readonly LegacySessionImportEntry[]): void {
  const sessions = new Set<string>()
  for (const { normalized: session } of entries) {
    if (sessions.has(session.sessionKey))
      throw new LegacySessionImportValidationError(`Duplicate sessionKey: ${session.sessionKey}.`)
    sessions.add(session.sessionKey)
    const runs = new Set<string>()
    for (const run of session.runs) {
      if (runs.has(run.runId))
        throw new LegacySessionImportValidationError(
          `Duplicate runId in ${session.sessionKey}: ${run.runId}.`
        )
      runs.add(run.runId)
    }
    const artifacts = new Set<string>()
    for (const artifact of session.artifacts) {
      if (artifacts.has(artifact.artifactId))
        throw new LegacySessionImportValidationError(
          `Duplicate artifactId in ${session.sessionKey}: ${artifact.artifactId}.`
        )
      artifacts.add(artifact.artifactId)
    }
  }
}

async function buildTrustedContent(bytes: Buffer): Promise<TrustedContent> {
  const rawFile = parseRawFile(bytes)
  const rawSessions = rawFile.sessions as JsonValue[]
  const entries = await withTemporaryStore(bytes, async (copy) => {
    const normalizedSessions = await new AssistantSessionStore(copy).listSessions()
    if (normalizedSessions.length !== rawSessions.length)
      throw new LegacySessionImportValidationError(
        'Legacy sessions could not be normalized without loss or identity collision.'
      )
    const byKey = new Map(normalizedSessions.map((session) => [session.sessionKey, session]))
    const settled = await Promise.allSettled(
      rawSessions.map((raw, originalIndex) => {
        if (!isRecord(raw))
          return Promise.reject(
            new LegacySessionImportValidationError(`Session ${originalIndex} must be an object.`)
          )
        const route = raw.route
        const isolatedBytes = Buffer.from(
          canonicalJson({ version: rawFile.version, sessions: [raw] })
        )
        return withTemporaryStore(isolatedBytes, async (isolatedPath) => {
          const [normalized] = await new AssistantSessionStore(isolatedPath).listSessions()
          if (!normalized || !byKey.has(normalized.sessionKey) || route === undefined)
            throw new LegacySessionImportValidationError(`Session ${originalIndex} is invalid.`)
          return {
            originalIndex,
            raw: jsonSafeClone(raw),
            normalized: normalizedSafeView(
              normalized,
              raw
            ) as LegacySessionImportEntry['normalized']
          }
        })
      })
    )
    const errors = settled
      .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      .map((item) => item.reason)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1)
      throw new AggregateError(errors, 'Multiple legacy sessions could not be normalized.', {
        cause: errors[0]
      })
    return settled.map((item) => (item as PromiseFulfilledResult<LegacySessionImportEntry>).value)
  })
  const resolvedEntries = entries
  assertUniqueContent(resolvedEntries)
  const runs = resolvedEntries.reduce((sum, entry) => sum + entry.normalized.runs.length, 0)
  const artifacts = resolvedEntries.reduce(
    (sum, entry) => sum + entry.normalized.artifacts.length,
    0
  )
  const counts = {
    sessions: resolvedEntries.length,
    runs,
    artifacts,
    resources: 1 + resolvedEntries.length + runs + artifacts
  }
  if (counts.resources > MAX_RESOURCE_MUTATION_BATCH_SIZE)
    throw new LegacySessionImportTooLargeError(counts.resources)
  const contentDigest = hashCanonical({ storageVersion: rawFile.version, entries: resolvedEntries })
  return deepFreeze({
    storageVersion: rawFile.version as LegacyStorageVersion,
    rawFile,
    entries: resolvedEntries,
    counts,
    contentDigest
  })
}

export async function createLegacySessionImportPlan(input: {
  sourcePath: string
  createdAt: number
}): Promise<LegacySessionImportPlan> {
  if (!validTimestamp(input.createdAt))
    throw new LegacySessionImportValidationError('createdAt is invalid.')
  const source = await readStableSource(input.sourcePath)
  const trusted = await buildTrustedContent(source.bytes)
  const current = await readStableSource(source.path)
  const sha256 = source.sha256
  if (current.sha256 !== sha256) throw new LegacySessionImportSourceChangedError()
  return deepFreeze({
    kind: 'legacy-session-import-plan',
    version: 1,
    mode: 'preview-only',
    authority: 'legacy-json-until-explicit-switch',
    importId: `legacy-session-import:${sha256}`,
    createdAt: input.createdAt,
    contentDigest: trusted.contentDigest,
    source: {
      absolutePath: source.path,
      storageVersion: trusted.storageVersion,
      sha256,
      size: source.bytes.length
    },
    entries: trusted.entries,
    rawFile: trusted.rawFile,
    counts: trusted.counts
  })
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

export function parseLegacySessionImportPlan(value: unknown): LegacySessionImportPlan {
  const plan = jsonSafeClone(value) as LegacySessionImportPlan
  try {
    if (
      !isRecord(plan) ||
      plan.kind !== 'legacy-session-import-plan' ||
      plan.version !== 1 ||
      plan.mode !== 'preview-only' ||
      plan.authority !== 'legacy-json-until-explicit-switch' ||
      !validTimestamp(plan.createdAt) ||
      !isRecord(plan.source) ||
      !isAbsolute(plan.source.absolutePath) ||
      ![1, 2, 3].includes(plan.source.storageVersion) ||
      !SHA256.test(plan.source.sha256) ||
      !SHA256.test(plan.contentDigest) ||
      !Number.isSafeInteger(plan.source.size) ||
      plan.source.size < 0 ||
      plan.importId !== `legacy-session-import:${plan.source.sha256}` ||
      !Array.isArray(plan.entries) ||
      !isRecord(plan.rawFile) ||
      !isRecord(plan.counts)
    )
      throw new Error('shape')
    const sessions = (plan.rawFile as Record<string, unknown>).sessions
    if (
      (plan.rawFile as Record<string, unknown>).version !== plan.source.storageVersion ||
      !Array.isArray(sessions) ||
      sessions.length !== plan.entries.length
    )
      throw new Error('envelope')
    for (let index = 0; index < plan.entries.length; index += 1) {
      const entry = plan.entries[index]
      if (
        !isRecord(entry) ||
        entry.originalIndex !== index ||
        !isRecord(entry.raw) ||
        !isRecord(entry.normalized) ||
        !sameCanonical(sessions[index], entry.raw) ||
        typeof entry.normalized.sessionKey !== 'string' ||
        !Array.isArray(entry.normalized.runs) ||
        !Array.isArray(entry.normalized.artifacts)
      )
        throw new Error('entry')
    }
    assertUniqueContent(plan.entries)
    const runs = plan.entries.reduce((sum, entry) => sum + entry.normalized.runs.length, 0)
    const artifacts = plan.entries.reduce(
      (sum, entry) => sum + entry.normalized.artifacts.length,
      0
    )
    const counts = {
      sessions: plan.entries.length,
      runs,
      artifacts,
      resources: 1 + plan.entries.length + runs + artifacts
    }
    if (!sameCanonical(plan.counts, counts)) throw new Error('counts')
    if (counts.resources > MAX_RESOURCE_MUTATION_BATCH_SIZE)
      throw new LegacySessionImportTooLargeError(counts.resources)
    if (
      plan.contentDigest !==
      hashCanonical({ storageVersion: plan.source.storageVersion, entries: plan.entries })
    )
      throw new Error('digest')
    return deepFreeze(plan)
  } catch (error) {
    if (error instanceof LegacySessionImportTooLargeError) throw error
    if (error instanceof LegacySessionImportValidationError) throw error
    throw new LegacySessionImportValidationError('Invalid legacy session import plan.', error)
  }
}

function deterministicTimestamp(entries: readonly LegacySessionImportEntry[]): number {
  let maximum = 0
  const visit = (value: unknown, key?: string): void => {
    if (key && TIMESTAMP_KEYS.has(key) && validTimestamp(value)) maximum = Math.max(maximum, value)
    else if (Array.isArray(value)) value.forEach((item) => visit(item))
    else if (isRecord(value))
      Object.entries(value).forEach(([childKey, child]) => visit(child, childKey))
  }
  for (const entry of entries) visit(entry.normalized)
  return maximum
}

function artifactDescriptor(value: unknown): { descriptor: JsonValue; omittedFields: string[] } {
  const omittedFields: string[] = []
  const descriptor = sanitizeByContext(value, 'artifact', omittedFields)
  return { descriptor, omittedFields: [...new Set(omittedFields)].sort(binaryCompare) }
}

function sanitizePersistenceValue(value: unknown): JsonValue {
  return sanitizeByContext(value, 'general')
}

function findRawArtifactById(rawSession: JsonValue, id: string, index: number): JsonValue | null {
  const values =
    isRecord(rawSession) && Array.isArray(rawSession.artifacts) ? rawSession.artifacts : []
  const found = values.find((item) => isRecord(item) && item.artifactId === id) ?? values[index]
  return found === undefined ? null : jsonSafeClone(found)
}

function assertNoSensitivePersistenceLeak(
  value: unknown,
  context: SanitizerContext = 'general'
): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitivePersistenceLeak(item, context)
    return
  }
  if (!isRecord(value)) return
  const effectiveContext =
    context === 'general' && typeof value.artifactId === 'string' ? 'artifact' : context
  for (const [key, child] of Object.entries(value)) {
    if (key === 'rawRecord' || key === 'rawDescriptor' || key === 'rawFile')
      throw new LegacySessionImportValidationError(
        `Raw plan-only field remained in persistence state: ${key}.`
      )
    const lower = key.toLowerCase()
    const pathLeak = effectiveContext !== 'general' && LOCAL_PATH_KEYS.has(lower)
    const binaryLeak =
      (effectiveContext === 'artifact' ||
        effectiveContext === 'attachment' ||
        effectiveContext === 'metadata') &&
      BINARY_CONTENT_KEYS.has(lower)
    if (pathLeak || binaryLeak || (effectiveContext === 'metadata' && key === 'sessions'))
      throw new LegacySessionImportValidationError(
        `Sensitive persistence field remained in ${effectiveContext} context: ${key}.`
      )
    assertNoSensitivePersistenceLeak(child, childContext(effectiveContext, key, child))
  }
}

function makeMutations(
  source: { path: string; sha256: string; size: number },
  trusted: TrustedContent
): ResourceMutationInput[] {
  const prefix = `legacy-import/${source.sha256}/`
  const resources: Array<{ kind: string; id: string; state: Record<string, unknown> }> = []
  for (const entry of [...trusted.entries].sort((a, b) =>
    binaryCompare(a.normalized.sessionKey, b.normalized.sessionKey)
  )) {
    const session = entry.normalized
    const sessionPart = encodeURIComponent(session.sessionKey)
    resources.push({
      kind: 'session',
      id: `${prefix}session/${sessionPart}`,
      state: {
        sourceHash: source.sha256,
        sourceVersion: trusted.storageVersion,
        originalSessionKey: session.sessionKey,
        normalizedRecord: sanitizePersistenceValue(entry.normalized)
      }
    })
    for (const run of [...session.runs].sort((a, b) => binaryCompare(a.runId, b.runId)))
      resources.push({
        kind: 'run',
        id: `${prefix}session/${sessionPart}/run/${encodeURIComponent(run.runId)}`,
        state: {
          normalizedRecord: sanitizePersistenceValue(run)
        }
      })
    for (const [index, artifact] of [...session.artifacts]
      .sort((a, b) => binaryCompare(a.artifactId, b.artifactId))
      .entries()) {
      const rawArtifact = findRawArtifactById(entry.raw, artifact.artifactId, index)
      const normalizedDescriptor = artifactDescriptor(artifact)
      const rawDescriptor = artifactDescriptor(rawArtifact)
      const normalizedArtifact = normalizedDescriptor.descriptor as Record<string, JsonValue>
      const descriptorDetails = { ...normalizedArtifact }
      for (const key of ['artifactId', 'runId', 'kind', 'source', 'createdAt'])
        delete descriptorDetails[key]
      const omittedFields = [
        ...new Set([...rawDescriptor.omittedFields, ...normalizedDescriptor.omittedFields])
      ].sort(binaryCompare)
      resources.push({
        kind: 'artifact',
        id: `${prefix}session/${sessionPart}/artifact/${encodeURIComponent(artifact.artifactId)}`,
        state: {
          storage: 'legacy-reference',
          sourceHash: source.sha256,
          sourceVersion: trusted.storageVersion,
          originalSessionKey: session.sessionKey,
          artifactId: normalizedArtifact.artifactId,
          runId: normalizedArtifact.runId,
          kind: normalizedArtifact.kind,
          source: normalizedArtifact.source,
          createdAt: normalizedArtifact.createdAt,
          legacyRef: {
            normalizedDescriptor: descriptorDetails,
            omittedFields
          }
        }
      })
    }
  }
  const manifestId = `${prefix}manifest`
  const finalResourceIds = [...resources.map((resource) => resource.id), manifestId].sort(
    binaryCompare
  )
  resources.push({
    kind: 'legacy-session-import',
    id: manifestId,
    state: {
      source: {
        sha256: source.sha256,
        size: source.size,
        version: trusted.storageVersion,
        fileName: basename(source.path)
      },
      contentDigest: trusted.contentDigest,
      authority: false,
      sourceMetadata: sanitizeByContext(
        Object.fromEntries(
          Object.entries(trusted.rawFile as Record<string, JsonValue>).filter(
            ([key]) => key !== 'sessions'
          )
        ),
        'metadata'
      ),
      resourceIds: finalResourceIds,
      counts: trusted.counts
    }
  })
  resources.sort((a, b) => binaryCompare(a.id, b.id))
  for (const resource of resources)
    assertNoSensitivePersistenceLeak(
      resource.state,
      resource.kind === 'artifact' ? 'artifact' : 'general'
    )
  const createdAt = deterministicTimestamp(trusted.entries)
  const streamId = `legacy-session-import:${source.sha256}`
  return resources.map((resource, sequence) => {
    const eventId = `${streamId}:${sequence}`
    return {
      operation: 'create',
      kind: resource.kind,
      id: resource.id,
      idempotencyKey: eventId,
      state: resource.state,
      createdAt,
      event: {
        protocolVersion: '2.0.0',
        envelopeKind: 'event',
        id: eventId,
        type: 'legacy.session.imported-resource',
        createdAt,
        streamId,
        sequence,
        actor: { kind: 'system', id: 'legacy-session-import' },
        payload: {
          resource: { kind: resource.kind, id: resource.id },
          source: { sha256: source.sha256, version: trusted.storageVersion }
        }
      }
    }
  })
}

export async function executeLegacySessionImportPlan(
  store: MagicAgentEventStore,
  input: LegacySessionImportPlan
) {
  const plan = parseLegacySessionImportPlan(input)
  const source = await readStableSource(plan.source.absolutePath)
  if (source.bytes.length !== plan.source.size || source.sha256 !== plan.source.sha256)
    throw new LegacySessionImportSourceChangedError()
  const trusted = await buildTrustedContent(source.bytes)
  if (
    trusted.storageVersion !== plan.source.storageVersion ||
    trusted.contentDigest !== plan.contentDigest ||
    !sameCanonical(trusted.rawFile, plan.rawFile) ||
    !sameCanonical(trusted.entries, plan.entries) ||
    !sameCanonical(trusted.counts, plan.counts)
  )
    throw new LegacySessionImportSourceChangedError()
  const results = store.mutateResourcesBatch(
    makeMutations(
      { path: source.path, sha256: plan.source.sha256, size: source.bytes.length },
      trusted
    )
  )
  return deepFreeze({
    importId: plan.importId,
    counts: trusted.counts,
    imported: results.filter((result) => result.inserted).length,
    replayed: results.filter((result) => !result.inserted).length,
    authoritySwitched: false
  })
}
