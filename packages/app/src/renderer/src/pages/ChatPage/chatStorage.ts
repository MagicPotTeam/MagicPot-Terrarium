/**
 * Chat Storage - IndexedDB-based persistent storage for chat sessions.
 *
 * Replaces localStorage (5-10MB limit) with IndexedDB (~50% of disk space).
 * - Stores full message history including data URL attachments
 * - Async API, does not block the main thread
 * - Individual session upsert for efficient writes
 * - One-time automatic migration from localStorage
 */

import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'
import type { ManagedMediaSvc, MigrateLegacyManagedMediaResp } from '@shared/api/svcManagedMedia'
import { normalizeMediaReference } from '@shared/mediaReference'
import { api } from '@renderer/utils/windowUtils'
import { normalizeChatProfileIdForStorage } from './chatPageShared'
import type { ChatContextCompressionSummary } from './chatContextCompression'
import { CHAT_ATTACHMENT_STORAGE } from './chatManagedMediaAttachments'

export interface ChatSessionDraft {
  inputValue: string
  pendingAttachments: ChatAttachment[]
  pendingHiddenContext: string
  updatedAt: number
}

export interface ChatSessionDraftBackupRecord {
  updatedAt: number
  draft?: ChatSessionDraft
}

/** Chat session with all messages. */
export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  draft?: ChatSessionDraft
  contextCompression?: ChatContextCompressionSummary
  profileId?: string
  skillId?: string
  pinned?: boolean
  archived?: boolean
  storageScope?: string
  /** Session continuation URL preserved across replies when the runtime returns one. */
  sessionUrl?: string
  /** Base profile id that owns sessionUrl; prevents reuse after a profile/provider switch. */
  sessionProfileId?: string
  /** Canonical remote route fingerprint that owns sessionUrl, when applicable. */
  sessionRouteFingerprint?: string
  createdAt?: number
}

type LegacyChatSession = ChatSession & { [key: string]: unknown }
type StoredChatSession = ChatSession & { storageKey: string; [key: string]: unknown }

const DB_NAME = 'magicpot-chat'
const DB_VERSION = 2
const DB_OPEN_TIMEOUT_MS = 10_000
const STORE_NAME = 'sessions-v2'
const LEGACY_STORE_NAME = 'sessions'
const DRAFT_BACKUP_STORAGE_KEY_PREFIX = 'magicpot-chat-draft'
const DELETE_TOMBSTONE_STORAGE_KEY_PREFIX = 'magicpot-chat-delete-tombstone:'

let dbInstance: IDBDatabase | null = null
let dbInitPromise: Promise<IDBDatabase> | null = null
const sessionMutationQueues = new Map<string, Promise<void>>()
const legacyMigrationFlights = new Map<string, Promise<ChatSession>>()

function attachmentNeedsLegacyMigration(attachment: ChatAttachment): boolean {
  return (
    attachment.type === 'image' &&
    !normalizeMediaReference(attachment.media) &&
    /^data:image\/[a-z0-9!#$&^_.+-]+;base64,/i.test(attachment.url)
  )
}

async function reclaimLegacyImports(
  service: ManagedMediaSvc,
  checkpoints: MigrateLegacyManagedMediaResp['checkpoint'][]
): Promise<void> {
  if (!service.reclaimLegacyMigration) return
  await Promise.allSettled(
    checkpoints.map((checkpoint) => service.reclaimLegacyMigration(checkpoint))
  )
}

async function migrateLegacyAttachmentsInSession(
  original: ChatSession,
  scope: string,
  retryRemaining = 1,
  pendingReclaims: MigrateLegacyManagedMediaResp['checkpoint'][] = []
): Promise<ChatSession> {
  const service = (api() as unknown as { svcManagedMedia?: ManagedMediaSvc } | undefined)
    ?.svcManagedMedia
  if (!service?.migrateLegacyDataUrl) return original

  let changed = false
  const migrate = async (attachment: ChatAttachment): Promise<ChatAttachment> => {
    if (!attachmentNeedsLegacyMigration(attachment)) return attachment
    const migrated = await service.migrateLegacyDataUrl({
      dataUrl: attachment.url,
      metadata: {
        originalFileName: attachment.fileName || 'legacy-image',
        sourceWidth: attachment.sourceWidth,
        sourceHeight: attachment.sourceHeight
      },
      // Legacy chat images become durable user-owned media rather than task
      // scratch data. The explicit namespace keeps old requests compatible
      // while allowing the physical lifecycle policy to apply on migration.
      storage: CHAT_ATTACHMENT_STORAGE
    })
    pendingReclaims.push(migrated.checkpoint)
    changed = true
    return { ...attachment, url: migrated.localMediaUrl, media: migrated.reference }
  }

  try {
    const messages: ChatMessage[] = []
    for (const message of original.messages) {
      if (!message.attachments) {
        messages.push(message)
        continue
      }
      const attachments: ChatAttachment[] = []
      for (const attachment of message.attachments) attachments.push(await migrate(attachment))
      messages.push({ ...message, attachments })
    }
    const replayImageMessages: ChatMessage[] = []
    for (const message of original.contextCompression?.replayImageMessages || []) {
      if (!message.attachments) {
        replayImageMessages.push(message)
        continue
      }
      const attachments: ChatAttachment[] = []
      for (const attachment of message.attachments) attachments.push(await migrate(attachment))
      replayImageMessages.push({ ...message, attachments })
    }
    const draft = original.draft
      ? {
          ...original.draft,
          pendingAttachments: [] as ChatAttachment[]
        }
      : undefined
    if (draft) {
      for (const attachment of original.draft!.pendingAttachments) {
        draft.pendingAttachments.push(await migrate(attachment))
      }
    }
    if (!changed) return original
    const contextCompression = original.contextCompression
      ? {
          ...original.contextCompression,
          ...(replayImageMessages.length > 0 ? { replayImageMessages } : {})
        }
      : undefined
    const replacement = {
      ...original,
      messages,
      ...(draft ? { draft } : {}),
      ...(contextCompression ? { contextCompression } : {})
    }
    const persisted = await compareAndUpdateSessionInDB(original.id, scope, {
      expectedSession: original,
      update: () => replacement
    })
    if (persisted) return persisted

    const current = await loadSessionRawFromDB(original.id, scope)
    if (!current || retryRemaining <= 0) {
      await reclaimLegacyImports(service, pendingReclaims)
      return current || original
    }
    await reclaimLegacyImports(service, pendingReclaims)
    return migrateLegacyAttachmentsInSession(current, scope, retryRemaining - 1, [])
  } catch (error) {
    await reclaimLegacyImports(service, pendingReclaims)
    console.warn('[ChatStorage] Failed to migrate legacy image attachment:', error)
    return original
  }
}

function migrateLegacyAttachmentsSingleFlight(
  session: ChatSession,
  scope: string
): Promise<ChatSession> {
  const key = createSessionStorageKey(session.id, scope)
  const existing = legacyMigrationFlights.get(key)
  if (existing) return existing
  const flight = migrateLegacyAttachmentsInSession(session, scope).finally(() => {
    if (legacyMigrationFlights.get(key) === flight) legacyMigrationFlights.delete(key)
  })
  legacyMigrationFlights.set(key, flight)
  return flight
}

function createSessionStorageKey(sessionId: string, scope = 'default'): string {
  return `${normalizeScope(scope)}\u0000${sessionId}`
}

const queueSessionMutation = async <T>(
  sessionId: string,
  scope: string,
  operation: () => Promise<T>
): Promise<T> => {
  const mutationKey = createSessionStorageKey(sessionId, scope)
  const previous = sessionMutationQueues.get(mutationKey) || Promise.resolve()
  let resolveResult: (value: T | PromiseLike<T>) => void
  let rejectResult: (reason?: unknown) => void
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .then(resolveResult!, rejectResult!)
    .then(
      () => undefined,
      () => undefined
    )
  sessionMutationQueues.set(mutationKey, next)
  void next.finally(() => {
    if (sessionMutationQueues.get(mutationKey) === next) {
      sessionMutationQueues.delete(mutationKey)
    }
  })
  return result
}

function normalizeScope(scope?: string): string {
  return scope || 'default'
}

const isChatAttachmentType = (value: unknown): value is ChatAttachment['type'] =>
  value === 'image' || value === 'video' || value === 'model3d' || value === 'file'

const normalizeDraftAttachments = (value: unknown): ChatAttachment[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return []
    }

    const attachment = candidate as Partial<ChatAttachment>
    if (!isChatAttachmentType(attachment.type) || typeof attachment.url !== 'string') {
      return []
    }

    return [
      {
        ...attachment,
        type: attachment.type,
        url: attachment.url
      } as ChatAttachment
    ]
  })
}

const normalizeSessionDraft = (value: unknown): ChatSessionDraft | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as Partial<ChatSessionDraft>
  const inputValue = typeof candidate.inputValue === 'string' ? candidate.inputValue : ''
  const pendingHiddenContext =
    typeof candidate.pendingHiddenContext === 'string' ? candidate.pendingHiddenContext : ''
  const pendingAttachments = normalizeDraftAttachments(candidate.pendingAttachments)
  const updatedAt =
    typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : 0

  if (!inputValue && !pendingHiddenContext && pendingAttachments.length === 0) {
    return undefined
  }

  return {
    inputValue,
    pendingAttachments,
    pendingHiddenContext,
    updatedAt
  }
}

const getDraftBackupStorageKey = (sessionId: string, scope?: string): string =>
  `${DRAFT_BACKUP_STORAGE_KEY_PREFIX}:${normalizeScope(scope)}:${sessionId}`

export interface ChatSessionDeleteTombstone {
  sessionId: string
  scope: string
}

const getDeleteTombstoneStorageKey = (sessionId: string, scope?: string): string =>
  `${DELETE_TOMBSTONE_STORAGE_KEY_PREFIX}${encodeURIComponent(normalizeScope(scope))}:${encodeURIComponent(sessionId)}`

export function hasSessionDeleteTombstone(sessionId: string, scope = 'default'): boolean {
  try {
    return localStorage.getItem(getDeleteTombstoneStorageKey(sessionId, scope)) !== null
  } catch {
    return false
  }
}

export function readSessionDeleteTombstones(): ChatSessionDeleteTombstone[] {
  const tombstones: ChatSessionDeleteTombstone[] = []
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(DELETE_TOMBSTONE_STORAGE_KEY_PREFIX)) continue
      const encoded = key.slice(DELETE_TOMBSTONE_STORAGE_KEY_PREFIX.length)
      const separatorIndex = encoded.indexOf(':')
      if (separatorIndex < 0) continue
      try {
        tombstones.push({
          scope: normalizeScope(decodeURIComponent(encoded.slice(0, separatorIndex))),
          sessionId: decodeURIComponent(encoded.slice(separatorIndex + 1))
        })
      } catch {
        // Ignore a malformed tombstone without hiding the remaining valid entries.
      }
    }
  } catch {
    return []
  }
  return tombstones
}

export function setSessionDeleteTombstone(
  sessionId: string,
  scope = 'default',
  deleted = true
): void {
  try {
    const key = getDeleteTombstoneStorageKey(sessionId, scope)
    if (deleted) {
      localStorage.setItem(key, '1')
    } else {
      localStorage.removeItem(key)
    }
  } catch (error) {
    console.warn('[ChatStorage] Failed to persist a session delete tombstone:', error)
  }
}

const normalizeDraftBackupRecord = (value: unknown): ChatSessionDraftBackupRecord | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as Partial<ChatSessionDraftBackupRecord>
  const updatedAt =
    typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : 0
  const draft = normalizeSessionDraft(candidate.draft)

  if (updatedAt <= 0 && !draft) {
    return undefined
  }

  return {
    updatedAt: Math.max(updatedAt, draft?.updatedAt || 0),
    ...(draft ? { draft } : {})
  }
}

export function readSessionDraftBackup(
  sessionId: string,
  scope = 'default'
): ChatSessionDraftBackupRecord | undefined {
  try {
    const raw = localStorage.getItem(getDraftBackupStorageKey(sessionId, scope))
    if (!raw) {
      return undefined
    }

    return normalizeDraftBackupRecord(JSON.parse(raw))
  } catch (error) {
    console.warn('[ChatStorage] Failed to read session draft backup:', error)
    return undefined
  }
}

export function writeSessionDraftBackup(
  sessionId: string,
  updatedAt: number,
  draft?: ChatSessionDraft,
  scope = 'default'
): void {
  try {
    const normalizedDraft = normalizeSessionDraft(draft)
    const nextRecord = normalizeDraftBackupRecord({
      updatedAt,
      ...(normalizedDraft ? { draft: normalizedDraft } : {})
    })
    if (!nextRecord) {
      localStorage.removeItem(getDraftBackupStorageKey(sessionId, scope))
      return
    }

    const existingRecord = readSessionDraftBackup(sessionId, scope)
    if (existingRecord && existingRecord.updatedAt > nextRecord.updatedAt) {
      return
    }

    localStorage.setItem(getDraftBackupStorageKey(sessionId, scope), JSON.stringify(nextRecord))
  } catch (error) {
    console.warn('[ChatStorage] Failed to write session draft backup:', error)
  }
}

export function deleteSessionDraftBackup(sessionId: string, scope = 'default'): void {
  try {
    localStorage.removeItem(getDraftBackupStorageKey(sessionId, scope))
  } catch (error) {
    console.warn('[ChatStorage] Failed to delete session draft backup:', error)
  }
}

function normalizeSession(session: ChatSession | LegacyChatSession, scope?: string): ChatSession {
  const {
    sessionUrl,
    sessionProfileId,
    sessionRouteFingerprint,
    draft,
    storageKey: _storageKey,
    ...rest
  } = session as StoredChatSession
  delete (rest as Record<string, unknown>).contextCompressionActivity
  const legacySessionUrlEntry = Object.entries(session as Record<string, unknown>).find(
    ([key, value]) =>
      key !== 'sessionUrl' && key.toLowerCase().endsWith('sessionurl') && typeof value === 'string'
  )
  const legacySessionUrl =
    typeof legacySessionUrlEntry?.[1] === 'string' ? legacySessionUrlEntry[1] : undefined
  const normalizedDraft = normalizeSessionDraft(draft ?? (session as Record<string, unknown>).draft)

  return {
    ...rest,
    ...(sessionUrl || legacySessionUrl ? { sessionUrl: sessionUrl || legacySessionUrl } : {}),
    ...(typeof sessionProfileId === 'string' && sessionProfileId.trim()
      ? { sessionProfileId: normalizeChatProfileIdForStorage(sessionProfileId) }
      : {}),
    ...(typeof sessionRouteFingerprint === 'string' && sessionRouteFingerprint.trim()
      ? { sessionRouteFingerprint: sessionRouteFingerprint.trim() }
      : {}),
    ...(normalizedDraft ? { draft: normalizedDraft } : {}),
    profileId: normalizeChatProfileIdForStorage(session.profileId),
    storageScope: normalizeScope(scope ?? session.storageScope)
  }
}

function createStoredSession(
  session: ChatSession | LegacyChatSession,
  scope?: string
): StoredChatSession {
  const normalized = normalizeSession(session, scope)
  return {
    ...normalized,
    storageKey: createSessionStorageKey(normalized.id, normalized.storageScope)
  }
}

function createStorageError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(fallbackMessage)
}

/**
 * Order-insensitive (for object keys) but array-order-strict deep equality. Null/undefined values
 * are treated as absent so a raw snapshot and a normalized stored record that only differ by an
 * explicit `undefined`/key insertion order still compare equal. Avoids JSON.stringify ordering bugs.
 */
function stableDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
  const aIsArray = Array.isArray(a)
  const bIsArray = Array.isArray(b)
  if (aIsArray !== bIsArray) return false
  if (aIsArray) {
    const arrA = a as unknown[]
    const arrB = b as unknown[]
    if (arrA.length !== arrB.length) return false
    for (let index = 0; index < arrA.length; index += 1) {
      if (!stableDeepEqual(arrA[index], arrB[index])) return false
    }
    return true
  }
  const recA = a as Record<string, unknown>
  const recB = b as Record<string, unknown>
  const keysA = Object.keys(recA).filter((key) => recA[key] !== undefined)
  const keysB = Object.keys(recB).filter((key) => recB[key] !== undefined)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recB, key)) return false
    if (!stableDeepEqual(recA[key], recB[key])) return false
  }
  return true
}

function normalizedSessionsEqual(a: ChatSession, b: ChatSession, scope: string): boolean {
  return stableDeepEqual(normalizeSession(a, scope), normalizeSession(b, scope))
}

function describeStorageError(error: unknown): string {
  if (error instanceof Error) {
    const detail = error.message?.trim() || 'Unknown error'
    return error.name && error.name !== 'Error' ? `${error.name}: ${detail}` : detail
  }
  if (typeof error === 'string') {
    return error.trim() || 'Unknown error'
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return 'Unknown error'
}

/** Invalidate only our connection. A read failure is never permission to delete history. */
function closeCachedDb(): void {
  const previous = dbInstance
  dbInstance = null
  dbInitPromise = null
  try {
    previous?.close()
  } catch {
    // Preserve the original operation error if the failed connection cannot close.
  }
}

async function handleStorageFailure(error: Error, operation: string): Promise<void> {
  closeCachedDb()
  console.error(`[ChatStorage] ${operation}: ${describeStorageError(error)}`)
  // The caller receives the failure. Its next explicit attempt opens the same database;
  // there is no automatic reset, destructive migration, or unbounded retry loop.
}

/** Open (or create) the IndexedDB database. */
function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance)
  if (dbInitPromise) return dbInitPromise

  dbInitPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    let settled = false
    const rejectOpen = (error: Error) => {
      if (settled) return
      settled = true
      dbInitPromise = null
      reject(error)
    }
    const openTimeout = setTimeout(() => {
      rejectOpen(new Error('IndexedDB open timed out, possibly blocked by another window.'))
    }, DB_OPEN_TIMEOUT_MS)

    request.onupgradeneeded = (event) => {
      const openRequest = event.target as IDBOpenDBRequest
      const db = openRequest.result
      const tx = openRequest.transaction
      const targetStore = db.objectStoreNames.contains(STORE_NAME)
        ? tx?.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'storageKey' })

      if (targetStore && tx && db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        const legacyRequest = tx.objectStore(LEGACY_STORE_NAME).getAll()
        legacyRequest.onsuccess = () => {
          for (const session of (legacyRequest.result || []) as LegacyChatSession[]) {
            if (!hasSessionDeleteTombstone(session.id, 'default')) {
              targetStore.put(createStoredSession(session))
            }
          }
        }
      }
    }

    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      clearTimeout(openTimeout)
      const openedDb = request.result
      dbInstance = openedDb
      openedDb.onclose = () => {
        if (dbInstance === openedDb) {
          dbInstance = null
          dbInitPromise = null
        }
      }
      openedDb.onversionchange = () => {
        openedDb.close()
        if (dbInstance === openedDb) {
          dbInstance = null
          dbInitPromise = null
        }
      }
      resolve(openedDb)
    }

    request.onerror = () => {
      clearTimeout(openTimeout)
      const error = createStorageError(request.error, 'IndexedDB failed to open chat storage.')
      rejectOpen(error)
    }

    request.onblocked = () => {
      console.warn('[ChatStorage] IndexedDB upgrade is blocked by another open window.')
    }
  })

  return dbInitPromise
}

/** Load all sessions, sorted by creation order. */
export async function loadAllSessions(scope = 'default'): Promise<ChatSession[]> {
  let sessions: ChatSession[]
  const targetScope = normalizeScope(scope)
  try {
    const db = await openDB()
    sessions = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.getAll()
      request.onsuccess = () => {
        const loadedSessions = ((request.result || []) as StoredChatSession[])
          .filter((session) => normalizeScope(session.storageScope) === targetScope)
          .map((session) => normalizeSession(session, targetScope))
        loadedSessions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        resolve(loadedSessions)
      }
      request.onerror = () =>
        reject(createStorageError(request.error, 'IndexedDB failed to load chat sessions.'))
    })
  } catch (error) {
    const storageError = createStorageError(error, 'IndexedDB failed to load chat sessions.')
    await handleStorageFailure(storageError, 'loadAllSessions failed')
    throw storageError
  }

  // Listing stays cheap. Legacy media is migrated only when its session is opened, preserving
  // the original record until the replacement has been atomically persisted.
  return sessions
}

/** Load a single session by ID without scanning the whole store. */
async function loadSessionRawFromDB(
  sessionId: string,
  scope = 'default'
): Promise<ChatSession | null> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(createSessionStorageKey(sessionId, scope))
      request.onsuccess = () => {
        const session = request.result as StoredChatSession | undefined
        if (!session) {
          resolve(null)
          return
        }

        const targetScope = normalizeScope(scope)
        if (normalizeScope(session.storageScope) !== targetScope) {
          resolve(null)
          return
        }

        resolve(normalizeSession(session, targetScope))
      }
      request.onerror = () =>
        reject(createStorageError(request.error, 'IndexedDB failed to load the chat session.'))
    })
  } catch (error) {
    const storageError = createStorageError(error, 'IndexedDB failed to load the chat session.')
    await handleStorageFailure(storageError, 'loadSession failed')
    throw storageError
  }
}

/** Load a single session and lazily replace legacy image data URLs after an atomic save. */
export async function loadSessionFromDB(
  sessionId: string,
  scope = 'default'
): Promise<ChatSession | null> {
  const session = await loadSessionRawFromDB(sessionId, scope)
  return session ? migrateLegacyAttachmentsSingleFlight(session, normalizeScope(scope)) : null
}

export interface CompareAndUpdateSessionOptions {
  expectedSession: ChatSession
  shouldUpdate?: (currentSession: ChatSession) => boolean
  update: (currentSession: ChatSession) => ChatSession
}

/**
 * Atomically updates a session only while its stored value still matches the caller's snapshot.
 * The read/compare/write shares the per-session mutation queue with ordinary saves and deletes.
 */
export async function compareAndUpdateSessionInDB(
  sessionId: string,
  scope: string,
  options: CompareAndUpdateSessionOptions
): Promise<ChatSession | null> {
  return queueSessionMutation(sessionId, scope, async () => {
    try {
      const db = await openDB()
      return await new Promise<ChatSession | null>((resolve, reject) => {
        const targetScope = normalizeScope(scope)
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        const request = store.get(createSessionStorageKey(sessionId, targetScope))
        let updatedSession: ChatSession | null = null
        let failed = false
        const fail = (error: Error): void => {
          if (failed) return
          failed = true
          try {
            tx.abort()
          } catch {
            /* ignore abort failures on an already-settled/aborted transaction */
          }
          reject(error)
        }
        request.onsuccess = () => {
          try {
            const stored = request.result as StoredChatSession | undefined
            if (!stored || normalizeScope(stored.storageScope) !== targetScope) return

            const currentSession = normalizeSession(stored, targetScope)
            if (
              !normalizedSessionsEqual(currentSession, options.expectedSession, targetScope) ||
              (options.shouldUpdate && !options.shouldUpdate(currentSession))
            ) {
              return
            }

            updatedSession = options.update(currentSession)
            store.put(createStoredSession(updatedSession, targetScope))
          } catch (error) {
            fail(createStorageError(error, 'IndexedDB failed to compare the chat session.'))
          }
        }
        request.onerror = () =>
          fail(createStorageError(request.error, 'IndexedDB failed to compare the chat session.'))
        tx.oncomplete = () => {
          if (!failed) resolve(updatedSession)
        }
        tx.onerror = () =>
          fail(createStorageError(tx.error, 'IndexedDB failed to update the chat session.'))
        tx.onabort = () =>
          fail(
            createStorageError(
              tx.error,
              'IndexedDB transaction aborted while updating the chat session.'
            )
          )
      })
    } catch (error) {
      const storageError = createStorageError(
        error,
        'IndexedDB failed to compare and update the chat session.'
      )
      await handleStorageFailure(storageError, 'compareAndUpdateSession failed')
      throw storageError
    }
  })
}

export interface SaveSessionToDBOptions {
  /**
   * Optional pre-write consistency guard evaluated inside the same readwrite transaction as the
   * upsert, so a stale whole-session snapshot cannot clobber a newer record written elsewhere:
   * - omitted (legacy): unconditional upsert, unchanged for existing callers
   * - null: the session is expected to be absent (create); a present record is a conflict
   * - ChatSession: the stored record must equal this snapshot; a mismatch is a conflict
   */
  expectedSession?: ChatSession | null
}

/** Raised when a guarded save would overwrite a record that changed since the caller's snapshot. */
export class ChatSessionSaveConflictError extends Error {
  readonly code = 'CHAT_SESSION_SAVE_CONFLICT'
  readonly sessionId: string
  readonly scope: string
  constructor(sessionId: string, scope: string) {
    super(
      `Chat session ${sessionId} changed in another writer; refusing to overwrite the newer record.`
    )
    this.name = 'ChatSessionSaveConflictError'
    this.sessionId = sessionId
    this.scope = normalizeScope(scope)
  }
}

/** Save a single session (upsert) - efficient for single-session updates. */
export async function saveSessionToDB(
  session: ChatSession,
  scope = 'default',
  options?: SaveSessionToDBOptions
): Promise<void> {
  cancelDebouncedSessionSave(session.id, scope)
  const guard =
    options && Object.prototype.hasOwnProperty.call(options, 'expectedSession')
      ? options.expectedSession
      : undefined
  const guarded = guard === null || (guard !== undefined && typeof guard === 'object')

  return queueSessionMutation(session.id, scope, async () => {
    if (hasSessionDeleteTombstone(session.id, scope)) {
      return
    }
    const targetScope = normalizeScope(scope)
    try {
      const db = await openDB()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        let conflict: ChatSessionSaveConflictError | null = null
        let failed = false
        const fail = (error: Error): void => {
          if (failed) return
          failed = true
          try {
            tx.abort()
          } catch {
            /* ignore abort failures on an already-settled/aborted transaction */
          }
          reject(error)
        }
        const write = (): void => {
          store.put(createStoredSession(session, targetScope))
        }

        if (!guarded) {
          write()
        } else {
          const request = store.get(createSessionStorageKey(session.id, targetScope))
          request.onsuccess = () => {
            try {
              const stored = request.result as StoredChatSession | undefined
              const exists = !!stored && normalizeScope(stored.storageScope) === targetScope
              // Idempotent retry: a previous save already persisted exactly this snapshot but its
              // acknowledgement was lost. Treat as success without adding another put. Uses a stable
              // (key-order-insensitive, array-order-strict) deep compare, not JSON.stringify order.
              const alreadyPersisted =
                exists && normalizedSessionsEqual(stored as StoredChatSession, session, targetScope)
              if (guard === null) {
                if (alreadyPersisted) return
                if (exists) {
                  conflict = new ChatSessionSaveConflictError(session.id, targetScope)
                  return
                }
                write()
                return
              }
              const expectedMatches =
                exists &&
                normalizedSessionsEqual(
                  stored as StoredChatSession,
                  guard as ChatSession,
                  targetScope
                )
              if (expectedMatches || alreadyPersisted) {
                if (!alreadyPersisted) write()
                return
              }
              conflict = new ChatSessionSaveConflictError(session.id, targetScope)
            } catch (error) {
              fail(createStorageError(error, 'IndexedDB failed to compare the chat session.'))
            }
          }
          request.onerror = () =>
            fail(createStorageError(request.error, 'IndexedDB failed to compare the chat session.'))
        }

        tx.oncomplete = () => {
          if (failed) return
          if (conflict) reject(conflict)
          else resolve()
        }
        tx.onerror = () =>
          fail(createStorageError(tx.error, 'IndexedDB failed to save the chat session.'))
        tx.onabort = () =>
          fail(
            createStorageError(
              tx.error,
              'IndexedDB transaction aborted while saving the chat session.'
            )
          )
      })
    } catch (error) {
      if (error instanceof ChatSessionSaveConflictError) {
        throw error
      }
      const storageError = createStorageError(error, 'IndexedDB failed to save the chat session.')
      await handleStorageFailure(storageError, 'saveSession failed')
      throw storageError
    }
  })
}

/** Save all sessions (replace entire store). */
export async function saveAllSessions(sessions: ChatSession[], scope = 'default'): Promise<void> {
  try {
    const db = await openDB()
    const targetScope = normalizeScope(scope)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.getAll()
      request.onsuccess = () => {
        for (const existing of (request.result || []) as StoredChatSession[]) {
          if (normalizeScope(existing.storageScope) === targetScope) {
            store.delete(existing.storageKey)
          }
        }
        for (const session of sessions.map((item) => createStoredSession(item, targetScope))) {
          store.put(session)
        }
      }
      request.onerror = () =>
        reject(
          createStorageError(request.error, 'IndexedDB failed to read existing chat sessions.')
        )
      tx.oncomplete = () => resolve()
      tx.onerror = () =>
        reject(createStorageError(tx.error, 'IndexedDB failed to save chat sessions.'))
    })
  } catch (error) {
    const storageError = createStorageError(error, 'IndexedDB failed to save chat sessions.')
    await handleStorageFailure(storageError, 'saveAllSessions failed')
    throw storageError
  }
}

/** Delete a single session by ID. */
export async function deleteSessionFromDB(sessionId: string, scope = 'default'): Promise<void> {
  cancelDebouncedSessionSave(sessionId, scope)
  return queueSessionMutation(sessionId, scope, async () => {
    try {
      const db = await openDB()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.delete(createSessionStorageKey(sessionId, scope))
        tx.oncomplete = () => resolve()
        tx.onerror = () =>
          reject(createStorageError(tx.error, 'IndexedDB failed to delete the chat session.'))
      })
    } catch (error) {
      const storageError = createStorageError(error, 'IndexedDB failed to delete the chat session.')
      await handleStorageFailure(storageError, 'deleteSession failed')
      throw storageError
    }
  })
}

/**
 * One-time migration from localStorage to IndexedDB.
 * Returns migrated sessions if successful, null if no migration needed.
 */
export async function migrateFromLocalStorage(): Promise<ChatSession[] | null> {
  const STORAGE_KEY = 'chat.sessions'
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return null

    const sessions = JSON.parse(saved) as LegacyChatSession[]
    if (sessions.length > 0) {
      const normalized = sessions.map((session) => ({
        ...normalizeSession(session),
        pinned: !!session.pinned,
        archived: !!session.archived
      }))
      const db = await openDB()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        for (const session of normalized) {
          if (hasSessionDeleteTombstone(session.id, 'default')) continue
          const storageKey = createSessionStorageKey(session.id, 'default')
          const request = store.get(storageKey)
          request.onsuccess = () => {
            if (!request.result) {
              store.put(createStoredSession(session, 'default'))
            }
          }
          request.onerror = () =>
            reject(
              createStorageError(request.error, 'IndexedDB migration failed to read a session.')
            )
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(createStorageError(tx.error, 'IndexedDB migration failed.'))
      })
      localStorage.removeItem(STORAGE_KEY)
      console.log(
        `[ChatStorage] Migrated ${normalized.length} sessions from localStorage to IndexedDB`
      )
      return await loadAllSessions('default')
    }
  } catch (error) {
    const storageError = createStorageError(error, 'IndexedDB migration failed.')
    await handleStorageFailure(storageError, 'Migration failed')
    throw storageError
  }
  return null
}

/**
 * Debounced save: saves all sessions to IndexedDB with a delay.
 * Multiple calls within the delay period are coalesced into one write.
 */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingSessionSaves = new Map<string, Map<string, ChatSession>>()

export interface DebouncedSessionSaveOptions {
  onSuccess?: (sessions: ChatSession[]) => void
  onError?: (error: unknown, sessions: ChatSession[]) => void
  /** Optional single-session writer (e.g. a baseline-guarded save); defaults to saveSessionToDB. */
  saveOne?: (session: ChatSession, scope: string) => Promise<unknown>
}

const pendingSaveCallbacks = new Map<string, DebouncedSessionSaveOptions>()

/**
 * Debounced session upserts. Only sessions changed by the caller are written;
 * unrelated scopes and unchanged sessions are never read, cleared, or cloned.
 */
export function cancelDebouncedSessionSave(sessionId: string, scope = 'default'): void {
  const targetScope = normalizeScope(scope)
  const pending = pendingSessionSaves.get(targetScope)
  pending?.delete(sessionId)
  if (pending && pending.size === 0) {
    pendingSessionSaves.delete(targetScope)
    pendingSaveCallbacks.delete(targetScope)
    const timer = saveTimers.get(targetScope)
    if (timer) clearTimeout(timer)
    saveTimers.delete(targetScope)
  }
}

export function debouncedSaveSessions(
  sessions: ChatSession[],
  delayMs = 500,
  scope = 'default',
  options: DebouncedSessionSaveOptions = {}
): void {
  if (sessions.length === 0) return

  const targetScope = normalizeScope(scope)
  const pending = pendingSessionSaves.get(targetScope) || new Map<string, ChatSession>()
  for (const session of sessions) {
    if (!hasSessionDeleteTombstone(session.id, targetScope)) {
      pending.set(session.id, session)
    }
  }
  if (pending.size === 0) return
  pendingSessionSaves.set(targetScope, pending)
  pendingSaveCallbacks.set(targetScope, options)

  const existingTimer = saveTimers.get(targetScope)
  if (existingTimer) clearTimeout(existingTimer)
  const timer = setTimeout(() => {
    const sessionsToSave = [...(pendingSessionSaves.get(targetScope)?.values() || [])]
    const callbacks = pendingSaveCallbacks.get(targetScope)
    pendingSessionSaves.delete(targetScope)
    pendingSaveCallbacks.delete(targetScope)
    saveTimers.delete(targetScope)
    Promise.all(
      sessionsToSave.map((session) =>
        callbacks?.saveOne
          ? callbacks.saveOne(session, targetScope)
          : saveSessionToDB(session, targetScope)
      )
    ).then(
      () => {
        callbacks?.onSuccess?.(sessionsToSave)
      },
      (error) => {
        callbacks?.onError?.(error, sessionsToSave)
        console.error(
          `[ChatStorage] debouncedSave failed: ${describeStorageError(createStorageError(error, 'IndexedDB debounced save failed.'))}`
        )
      }
    )
  }, delayMs)
  saveTimers.set(targetScope, timer)
}
