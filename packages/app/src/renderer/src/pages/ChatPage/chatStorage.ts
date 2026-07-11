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
import { normalizeChatProfileIdForStorage } from './chatPageShared'
import type { ChatContextCompressionSummary } from './chatContextCompression'

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
let fatalStorageError: Error | null = null
let fatalStorageErrorLogged = false
let storageRecoveryPromise: Promise<boolean> | null = null
const sessionMutationQueues = new Map<string, Promise<void>>()

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
  const { sessionUrl, draft, storageKey: _storageKey, ...rest } = session as StoredChatSession
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

function isFatalStorageError(error: Error): boolean {
  return (
    error.name === 'NotReadableError' ||
    error.name === 'InvalidStateError' ||
    /missing file/i.test(error.message) ||
    /irrecoverable/i.test(error.message)
  )
}

function closeCachedDb(): void {
  if (!dbInstance) {
    dbInitPromise = null
    return
  }

  try {
    dbInstance.close()
  } catch {
    /* ignore close failure */
  }

  dbInstance = null
  dbInitPromise = null
}

function rememberFatalStorageError(error: Error): void {
  if (!isFatalStorageError(error)) {
    return
  }

  fatalStorageError = error
  closeCachedDb()
}

function clearFatalStorageError(): void {
  fatalStorageError = null
  fatalStorageErrorLogged = false
}

async function resetCorruptedStorage(error: Error): Promise<boolean> {
  if (!isFatalStorageError(error)) {
    return false
  }

  if (storageRecoveryPromise) {
    return storageRecoveryPromise
  }

  rememberFatalStorageError(error)

  storageRecoveryPromise = new Promise<boolean>((resolve) => {
    const finalize = (recovered: boolean) => {
      storageRecoveryPromise = null
      if (recovered) {
        clearFatalStorageError()
      }
      resolve(recovered)
    }

    try {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => {
        console.warn(`[ChatStorage] Reset corrupted IndexedDB database "${DB_NAME}".`)
        finalize(true)
      }
      request.onerror = () => {
        const resetError = createStorageError(
          request.error ?? error,
          'IndexedDB failed to reset corrupted chat storage.'
        )
        rememberFatalStorageError(resetError)
        console.error(
          `[ChatStorage] Failed to reset corrupted IndexedDB database: ${describeStorageError(resetError)}`
        )
        finalize(false)
      }
      request.onblocked = () => {
        console.warn('[ChatStorage] IndexedDB reset is blocked by another open connection.')
      }
    } catch (resetError) {
      const nextError = createStorageError(
        resetError,
        'IndexedDB failed to reset corrupted chat storage.'
      )
      rememberFatalStorageError(nextError)
      console.error(
        `[ChatStorage] Failed to reset corrupted IndexedDB database: ${describeStorageError(nextError)}`
      )
      finalize(false)
    }
  })

  return storageRecoveryPromise
}

function isStorageDisabled(): boolean {
  if (!fatalStorageError) {
    return false
  }

  if (storageRecoveryPromise) {
    return true
  }

  if (!fatalStorageErrorLogged) {
    console.error(
      `[ChatStorage] IndexedDB disabled due to fatal error: ${describeStorageError(fatalStorageError)}`
    )
    fatalStorageErrorLogged = true
  }

  return true
}

async function ensureStorageAvailable(): Promise<boolean> {
  if (storageRecoveryPromise) {
    await storageRecoveryPromise
  }

  return !isStorageDisabled()
}

async function handleStorageFailure(error: Error, operation: string): Promise<void> {
  rememberFatalStorageError(error)
  console.error(`[ChatStorage] ${operation}: ${describeStorageError(error)}`)
  await resetCorruptedStorage(error)
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
            targetStore.put(createStoredSession(session))
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
      dbInstance = request.result
      dbInstance.onclose = () => {
        dbInstance = null
        dbInitPromise = null
      }
      dbInstance.onversionchange = () => {
        dbInstance?.close()
        dbInstance = null
        dbInitPromise = null
      }
      resolve(dbInstance)
    }

    request.onerror = () => {
      clearTimeout(openTimeout)
      const error = createStorageError(request.error, 'IndexedDB failed to open chat storage.')
      rememberFatalStorageError(error)
      void resetCorruptedStorage(error)
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
  if (!(await ensureStorageAvailable())) {
    return []
  }

  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.getAll()
      request.onsuccess = () => {
        const targetScope = normalizeScope(scope)
        const sessions = ((request.result || []) as StoredChatSession[])
          .filter((session) => normalizeScope(session.storageScope) === targetScope)
          .map((session) => normalizeSession(session, targetScope))
        sessions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        resolve(sessions)
      }
      request.onerror = () =>
        reject(createStorageError(request.error, 'IndexedDB failed to load chat sessions.'))
    })
  } catch (error) {
    const storageError = createStorageError(error, 'IndexedDB failed to load chat sessions.')
    await handleStorageFailure(storageError, 'loadAllSessions failed')
    return []
  }
}

/** Load a single session by ID without scanning the whole store. */
export async function loadSessionFromDB(
  sessionId: string,
  scope = 'default'
): Promise<ChatSession | null> {
  if (!(await ensureStorageAvailable())) {
    return null
  }

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
    return null
  }
}

/** Save a single session (upsert) - efficient for single-session updates. */
export async function saveSessionToDB(session: ChatSession, scope = 'default'): Promise<void> {
  cancelDebouncedSessionSave(session.id, scope)
  return queueSessionMutation(session.id, scope, async () => {
    if (!(await ensureStorageAvailable())) {
      throw fatalStorageError || new Error('Chat storage is unavailable.')
    }

    try {
      const db = await openDB()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.put(createStoredSession(session, scope))
        tx.oncomplete = () => resolve()
        tx.onerror = () =>
          reject(createStorageError(tx.error, 'IndexedDB failed to save the chat session.'))
      })
    } catch (error) {
      const storageError = createStorageError(error, 'IndexedDB failed to save the chat session.')
      await handleStorageFailure(storageError, 'saveSession failed')
      throw storageError
    }
  })
}

/** Save all sessions (replace entire store). */
export async function saveAllSessions(sessions: ChatSession[], scope = 'default'): Promise<void> {
  if (!(await ensureStorageAvailable())) {
    throw fatalStorageError || new Error('Chat storage is unavailable.')
  }

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
    if (!(await ensureStorageAvailable())) {
      throw fatalStorageError || new Error('Chat storage is unavailable.')
    }

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
  if (!(await ensureStorageAvailable())) {
    return null
  }

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
}

const pendingSaveCallbacks = new Map<string, DebouncedSessionSaveOptions[]>()

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
    pending.set(session.id, session)
  }
  pendingSessionSaves.set(targetScope, pending)
  const callbacks = pendingSaveCallbacks.get(targetScope) || []
  callbacks.push(options)
  pendingSaveCallbacks.set(targetScope, callbacks)

  const existingTimer = saveTimers.get(targetScope)
  if (existingTimer) clearTimeout(existingTimer)
  const timer = setTimeout(() => {
    const sessionsToSave = [...(pendingSessionSaves.get(targetScope)?.values() || [])]
    const callbacks = pendingSaveCallbacks.get(targetScope) || []
    pendingSessionSaves.delete(targetScope)
    pendingSaveCallbacks.delete(targetScope)
    saveTimers.delete(targetScope)
    Promise.all(sessionsToSave.map((session) => saveSessionToDB(session, targetScope))).then(
      () => {
        for (const callback of callbacks) callback.onSuccess?.(sessionsToSave)
      },
      (error) => {
        for (const callback of callbacks) callback.onError?.(error, sessionsToSave)
        console.error(
          `[ChatStorage] debouncedSave failed: ${describeStorageError(createStorageError(error, 'IndexedDB debounced save failed.'))}`
        )
      }
    )
  }, delayMs)
  saveTimers.set(targetScope, timer)
}
