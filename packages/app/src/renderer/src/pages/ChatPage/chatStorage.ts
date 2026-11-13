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
import { readMemberModelChoice, resolveMemberModelSelection } from './agentTeam'

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
  /** Original records removed from the model window by successful compaction.
   * Same session/storage owner, never automatically re-injected into requests.
   * Older summaries without these records cannot recover discarded originals. */
  compactedMessages?: ChatMessage[]
  teamLeadId?: string
  teamMemberName?: string
  /** Explicit member selection; absence preserves legacy lead inheritance. */
  memberModelChoice?: { version: 1; profileId: string }
  teamRole?: string
  /** Local team lifecycle; missing on legacy leads means generation zero. */
  teamGeneration?: number
  teamMemberGeneration?: number
  /** Storage lifecycle fence incremented when a team is ended. */
  teamLifecycleRevision?: number
  /** A finished team cannot accept new members or start new member requests. */
  teamEnded?: boolean
  /** Legacy defaultModel is historical; versioned member selection is reserved but unavailable. */
  teamSettings?: { maxMembers: number; defaultModel: string | null; autoCleanup: boolean; memberModelSelection?: { version: 1; profileId: string } }
  teamTasks?: { id: string; title: string; ownerId: string; status: 'pending' | 'running' | 'done'; dependsOn: string[] }[]
  teamChannel?: { id: string; senderId: string; text: string; createdAt: number }[]
  /** Durable user-channel intent snapshots. Queued means persisted pending, never delivery proof. */
  teamMessageReceipts?: import('./teamMessageReceipt').TeamMessageReceipt[]
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

export type ExistingSessionSummary = {
  storageScope: string
  sessionId: string
  title: string
  titleTruncated: boolean
  createdAt?: number
}
export type ExistingSessionSummaryResult =
  | { status: 'ready'; sessions: ExistingSessionSummary[] }
  | {
      status: 'unavailable'
      reason:
        | 'database-unavailable'
        | 'migration-required'
        | 'read-failed'
        | 'changed'
        | 'limit-exceeded'
        | 'cancelled'
        | 'invalid-scope'
    }

/**
 * Explicit management metadata only. Never use openDB(), its shared cache, migration,
 * normalizers, media APIs or mutation queue here. One browser-deserialized cursor
 * record at a time is still not a per-record memory/sandbox guarantee.
 */
export async function readExistingSessionSummaries(
  scopes: readonly string[],
  signal?: AbortSignal
): Promise<ExistingSessionSummaryResult> {
  if (signal?.aborted) return { status: 'unavailable', reason: 'cancelled' }
  const validIdentifier = (value: unknown, cap: number): value is string =>
    typeof value === 'string' &&
    !!value &&
    value.length <= cap &&
    value.trim() === value &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  if (
    !Array.isArray(scopes) ||
    scopes.length > 256 ||
    scopes.some((scope) => !validIdentifier(scope, 1025) || scope === 'default') ||
    new Set(scopes).size !== scopes.length
  ) {
    return { status: 'unavailable', reason: 'invalid-scope' }
  }
  const wanted = new Set(scopes)
  if (!wanted.size) return { status: 'ready', sessions: [] }

  return new Promise((resolve) => {
    let settled = false
    let db: IDBDatabase | undefined
    let tx: IDBTransaction | undefined
    let closed = false
    let exhausted = false
    let visited = 0
    const summaries: ExistingSessionSummary[] = []
    const seen = new Set<string>()
    const close = () => {
      if (!db || closed) return
      closed = true
      try { db.close() } catch { /* A failed close cannot revive a settled result. */ }
    }
    const settle = (result: ExistingSessionSummaryResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (result.status === 'unavailable') {
        try { tx?.abort() } catch { /* Already complete/aborted. */ }
      }
      close()
      resolve(result)
    }
    const fail = (reason: Extract<ExistingSessionSummaryResult, { status: 'unavailable' }>['reason']) =>
      settle({ status: 'unavailable', reason })
    const cancel = () => fail('cancelled')
    const timer = setTimeout(() => fail('read-failed'), DB_OPEN_TIMEOUT_MS)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    const deleted = (item: ExistingSessionSummary): boolean =>
      // Any non-null value is a tombstone, including an empty string. Errors propagate.
      localStorage.getItem(getDeleteTombstoneStorageKey(item.sessionId, item.storageScope)) !== null

    try {
      if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
        fail('database-unavailable')
        return
      }
      const factory = indexedDB
      factory.databases().then((inventory) => {
        if (settled) return
        const entries = inventory.filter((entry) => entry.name === DB_NAME)
        if (!entries.length) { fail('database-unavailable'); return }
        if (entries.length !== 1 || entries[0].version !== DB_VERSION) {
          fail('migration-required')
          return
        }
        let request: IDBOpenDBRequest
        try { request = factory.open(DB_NAME) } catch { fail('read-failed'); return }
        // Open requests cannot be cancelled. Always abort a late upgrade, even after
        // timeout/blocked/cancel settled, to prevent a committed absent-DB creation.
        request.onupgradeneeded = () => {
          try { request.transaction?.abort() } catch { /* Report unavailable below. */ }
          fail('migration-required')
        }
        request.onerror = () => fail('read-failed')
        request.onblocked = () => fail('read-failed')
        request.onsuccess = () => {
          if (settled) { request.result.close(); return }
          db = request.result
          db.onversionchange = () => fail('changed')
          db.onclose = () => fail('read-failed')
          try {
            if (db.version !== DB_VERSION || !db.objectStoreNames.contains(STORE_NAME)) {
              fail('migration-required')
              return
            }
            tx = db.transaction(STORE_NAME, 'readonly')
            tx.onerror = () => fail('read-failed')
            tx.onabort = () => fail('read-failed')
            tx.oncomplete = () => {
              if (settled) return
              if (!exhausted) { fail('read-failed'); return }
              try {
                if (summaries.some(deleted)) { fail('changed'); return }
                settle({ status: 'ready', sessions: summaries })
              } catch { fail('read-failed') }
            }
            const store = tx.objectStore(STORE_NAME)
            if (store.keyPath !== 'storageKey') { fail('migration-required'); return }
            const cursorRequest = store.openCursor()
            cursorRequest.onerror = () => fail('read-failed')
            cursorRequest.onsuccess = () => {
              if (settled) return
              try {
                const cursor = cursorRequest.result
                if (!cursor) { exhausted = true; return }
                if (++visited > 4096) { fail('limit-exceeded'); return }
                const value: unknown = cursor.value
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                  fail('read-failed')
                  return
                }
                const item = value as Record<string, unknown>
                // Ignore other scopes without traversing their messages/drafts/URLs.
                if (typeof item.storageScope !== 'string' || !wanted.has(item.storageScope)) {
                  cursor.continue()
                  return
                }
                if (
                  !validIdentifier(item.id, 512) ||
                  typeof item.title !== 'string' ||
                  (item.createdAt !== undefined &&
                    (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt < 0))
                ) {
                  fail('read-failed')
                  return
                }
                const key = createSessionStorageKey(item.id, item.storageScope)
                if (item.storageKey !== key || cursor.primaryKey !== key || seen.has(key)) {
                  fail('read-failed')
                  return
                }
                seen.add(key)
                const summary: ExistingSessionSummary = {
                  storageScope: item.storageScope,
                  sessionId: item.id,
                  title: item.title.slice(0, 256),
                  titleTruncated: item.title.length > 256,
                  ...(item.createdAt !== undefined ? { createdAt: item.createdAt as number } : {})
                }
                if (!deleted(summary)) summaries.push(summary)
                if (summaries.length > 512) { fail('limit-exceeded'); return }
                cursor.continue()
              } catch { fail('read-failed') }
            }
          } catch { fail('read-failed') }
        }
      }).catch(() => fail('read-failed'))
    } catch { fail('read-failed') }
  })
}
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
    const compactedMessages: ChatMessage[] = []
    for (const message of original.compactedMessages || []) {
      if (!message.attachments) {
        compactedMessages.push(message)
        continue
      }
      const attachments: ChatAttachment[] = []
      for (const attachment of message.attachments) attachments.push(await migrate(attachment))
      compactedMessages.push({ ...message, attachments })
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
      ...(original.compactedMessages ? { compactedMessages } : {}),
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

function strictMarkerValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    const leftKeys = Object.keys(a), rightKeys = Object.keys(b)
    return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(b, key) && strictMarkerValueEqual((a as unknown as Record<string, unknown>)[key], (b as unknown as Record<string, unknown>)[key]))
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && strictMarkerValueEqual(left[key], right[key]))
}

function sameMemberModelMarker(a: ChatSession, b: ChatSession): boolean {
  const leftChoice = Object.hasOwn(a, 'memberModelChoice')
  const rightChoice = Object.hasOwn(b, 'memberModelChoice')
  if (leftChoice !== rightChoice || (leftChoice && !strictMarkerValueEqual(a.memberModelChoice, b.memberModelChoice))) return false
  const left = a.teamSettings
  const right = b.teamSettings
  const leftHasMarker = !!left && Object.hasOwn(left, 'memberModelSelection')
  const rightHasMarker = !!right && Object.hasOwn(right, 'memberModelSelection')
  if (leftHasMarker !== rightHasMarker) return false
  // Generic compare-and-update may neither remove a marker nor normalize unknown fields.
  return !leftHasMarker || strictMarkerValueEqual(left!.memberModelSelection, right!.memberModelSelection)
}

export function normalizedSessionsEqual(a: ChatSession, b: ChatSession, scope: string): boolean {
  const normalizedA = normalizeSession(a, scope)
  const normalizedB = normalizeSession(b, scope)
  // Undefined fields normally normalize away for legacy compatibility. This marker is
  // different: presence (including undefined nested fields) is a security signal.
  return sameMemberModelMarker(normalizedA, normalizedB) && stableDeepEqual(normalizedA, normalizedB)
}

/** Ordinary whole-session saves must never change team membership or lifecycle fences. */
export function sameTeamLifecycle(a: ChatSession, b: ChatSession): boolean {
  const managed = (session: ChatSession): boolean => session.teamLeadId !== undefined || session.teamMemberName !== undefined ||
    session.teamGeneration !== undefined || session.teamMemberGeneration !== undefined || session.teamLifecycleRevision !== undefined || session.teamEnded !== undefined
  if (!managed(a) && !managed(b)) return true
  const valid = (value: number | undefined): boolean => value === undefined || (Number.isSafeInteger(value) && value >= 0)
  if (![a.teamGeneration,b.teamGeneration,a.teamMemberGeneration,b.teamMemberGeneration,a.teamLifecycleRevision,b.teamLifecycleRevision].every(valid)) return false
  return (a.teamLeadId ?? null) === (b.teamLeadId ?? null) && (a.teamMemberName ?? null) === (b.teamMemberName ?? null) &&
    (a.teamGeneration ?? 0) === (b.teamGeneration ?? 0) && (a.teamMemberGeneration ?? 0) === (b.teamMemberGeneration ?? 0) &&
    (a.teamLifecycleRevision ?? 0) === (b.teamLifecycleRevision ?? 0) && Boolean(a.teamEnded) === Boolean(b.teamEnded) && Boolean(a.archived) === Boolean(b.archived)
}

/** Prove the stored record differs from the original baseline only by one End transition. */
export function matchesTeamEndBaseline(before: ChatSession, after: ChatSession, scope: string): boolean {
  if (before.id !== after.id || (before.teamLeadId ?? null) !== (after.teamLeadId ?? null) ||
      (before.teamMemberName ?? null) !== (after.teamMemberName ?? null) ||
      (before.teamMemberGeneration ?? 0) !== (after.teamMemberGeneration ?? 0)) return false
  const beforeRevision = before.teamLifecycleRevision ?? 0
  const afterRevision = after.teamLifecycleRevision ?? 0
  if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 0 || afterRevision !== beforeRevision + 1) return false
  if (before.teamLeadId) {
    if (before.archived || (before.teamGeneration ?? 0) !== (after.teamGeneration ?? 0) ||
        (after.archived !== undefined && typeof after.archived !== 'boolean')) return false
    return normalizedSessionsEqual(before, {...after, teamLifecycleRevision: before.teamLifecycleRevision, archived: before.archived}, scope)
  }
  const beforeGeneration = before.teamGeneration ?? 0
  if (!Number.isSafeInteger(beforeGeneration) || beforeGeneration < 0 || (after.teamGeneration ?? 0) !== beforeGeneration + 1) return false
  if (before.teamEnded || !after.teamEnded) return false
  return normalizedSessionsEqual(before, {...after, teamEnded: before.teamEnded, teamLifecycleRevision: before.teamLifecycleRevision, teamGeneration: before.teamGeneration}, scope)
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
            if (!normalizedSessionsEqual(currentSession, options.expectedSession, targetScope)) return
            // Never hand the predicate the canonical updater input: a predicate is not a write.
            // Its mutations must not leak into an otherwise identity updater.
            if (options.shouldUpdate && !options.shouldUpdate(structuredClone(currentSession))) return
            const beforeUpdate = structuredClone(currentSession)
            updatedSession = options.update(currentSession)
            if (updatedSession.id !== beforeUpdate.id || !sameTeamLifecycle(beforeUpdate, updatedSession) || !sameMemberModelMarker(beforeUpdate, updatedSession)) {
              updatedSession = null
              return
            }
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
  /** Optional identity of the debounced writer to supersede; null cancels none. */
  pendingSaveOwner?: object | null
  /** Recheck an owner-local snapshot at the point the transaction is ready to write. */
  shouldUpdate?: () => boolean
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

/** A guarded predecessor matched, but this owner's snapshot became stale before writing. */
export class ChatSessionSaveSupersededError extends Error {
  readonly code = 'CHAT_SESSION_SAVE_SUPERSEDED'
  constructor() {
    super('Local session snapshot was superseded before save.')
    this.name = 'ChatSessionSaveSupersededError'
  }
}

/** Save a single session (upsert) - efficient for single-session updates. */
export async function saveSessionToDB(
  session: ChatSession,
  scope = 'default',
  options?: SaveSessionToDBOptions
): Promise<void> {
  const guard =
    options && Object.prototype.hasOwnProperty.call(options, 'expectedSession')
      ? options.expectedSession
      : undefined
  if ((!options || !Object.prototype.hasOwnProperty.call(options, 'expectedSession')) && options?.pendingSaveOwner !== null) {
    cancelDebouncedSessionSave(session.id, scope, options?.pendingSaveOwner ?? defaultSaveOwner)
  }
  const guarded = guard === null || (guard !== undefined && typeof guard === 'object')

  return queueSessionMutation(session.id, scope, async () => {
    if (hasSessionDeleteTombstone(session.id, scope)) {
      if (guarded) throw new ChatSessionSaveConflictError(session.id, scope)
      return
    }
    const targetScope = normalizeScope(scope)
    try {
      const db = await openDB()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        let conflict: Error | null = null
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

        const request = store.get(createSessionStorageKey(session.id, targetScope))
        request.onsuccess = () => {
            try {
              const stored = request.result as StoredChatSession | undefined
              // Deletion can begin while the open/read is pending. Never acknowledge a guarded
              // payload that the tombstone causes us to skip.
              if (hasSessionDeleteTombstone(session.id, targetScope)) {
                if (guarded) conflict = new ChatSessionSaveConflictError(session.id, targetScope)
                return
              }
              const exists = !!stored && normalizeScope(stored.storageScope) === targetScope
              if (!exists && Object.hasOwn(session, 'memberModelChoice')) {
                conflict = new ChatSessionSaveConflictError(session.id, targetScope)
                return
              }
              if (!guarded) {
                if (exists && (!sameTeamLifecycle(stored as StoredChatSession, session) || !sameMemberModelMarker(stored as StoredChatSession, session))) {
                  conflict = new ChatSessionSaveConflictError(session.id, targetScope)
                  return
                }
                if (options?.shouldUpdate && !options.shouldUpdate()) {
                  conflict = new ChatSessionSaveConflictError(session.id, targetScope)
                  return
                }
                write()
                return
              }
              // Idempotent retry: a previous save already persisted exactly this snapshot but its
              // acknowledgement was lost. Treat as success without adding another put. Uses a stable
              // (key-order-insensitive, array-order-strict) deep compare, not JSON.stringify order.
              const alreadyPersisted =
                exists && normalizedSessionsEqual(stored as StoredChatSession, session, targetScope)
              const expectedMatches = guard === null
                ? !exists
                : exists && normalizedSessionsEqual(stored as StoredChatSession, guard as ChatSession, targetScope)
              if (!expectedMatches && !alreadyPersisted) {
                conflict = new ChatSessionSaveConflictError(session.id, targetScope)
                return
              }
              if (exists && (!sameTeamLifecycle(stored as StoredChatSession, session) || !sameMemberModelMarker(stored as StoredChatSession, session))) {
                conflict = new ChatSessionSaveConflictError(session.id, targetScope)
                return
              }
              if (options?.shouldUpdate && !options.shouldUpdate()) {
                conflict = expectedMatches
                  ? new ChatSessionSaveSupersededError()
                  : new ChatSessionSaveConflictError(session.id, targetScope)
                return
              }
              if (!alreadyPersisted) write()
            } catch (error) {
              fail(createStorageError(error, 'IndexedDB failed to compare the chat session.'))
            }
          }
        request.onerror = () =>
          fail(createStorageError(request.error, 'IndexedDB failed to compare the chat session.'))

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
      if (error instanceof ChatSessionSaveConflictError || error instanceof ChatSessionSaveSupersededError) {
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
        const scoped = ((request.result || []) as StoredChatSession[]).filter(existing => normalizeScope(existing.storageScope) === targetScope)
        const teamManaged = (session: ChatSession): boolean => session.teamLeadId !== undefined || session.teamMemberName !== undefined ||
          session.teamGeneration !== undefined || session.teamMemberGeneration !== undefined || session.teamLifecycleRevision !== undefined || session.teamEnded !== undefined || session.teamSettings !== undefined
        if (scoped.some(teamManaged) || sessions.some(teamManaged)) {
          try { tx.abort() } catch { /* Already closed. */ }
          reject(new Error('Bulk replacement of team sessions is unavailable.'))
          return
        }
        for (const existing of scoped) {
          store.delete(existing.storageKey)
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

interface TeamMutationInput {
  scope: string
  expectedLead: ChatSession
  shouldUpdate?: () => boolean
}

/** Explicit user-initiated choice only. No profile availability check or execution authority. */
export async function setTeamMemberModelChoiceInDB(input: TeamMutationInput & { expectedMember: ChatSession; profileId: string }): Promise<{ lead: ChatSession; member: ChatSession }> {
  const expectedLead = structuredClone(input.expectedLead)
  const expectedMember = structuredClone(input.expectedMember)
  const targetScope = normalizeScope(input.scope)
  const choice = { version: 1 as const, profileId: input.profileId }
  readMemberModelChoice({ ...expectedMember, memberModelChoice: choice })
  if (!expectedLead.id || !expectedMember.id || expectedLead.id === expectedMember.id) throw new Error('Invalid team member')
  return queueSessionMutation(expectedMember.id, targetScope, async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.getAll()
      let result: { lead: ChatSession; member: ChatSession } | undefined
      let failure: Error | undefined
      const abort = (error: Error) => { failure = error; try { tx.abort() } catch { reject(error) } }
      request.onsuccess = () => {
        try {
          const records = (request.result as StoredChatSession[]).filter(record => normalizeScope(record.storageScope) === targetScope)
          const lead = records.find(record => record.id === expectedLead.id)
          const member = records.find(record => record.id === expectedMember.id)
          if (!lead || !member || !normalizedSessionsEqual(lead, expectedLead, targetScope) || !normalizedSessionsEqual(member, expectedMember, targetScope) ||
              lead.teamLeadId || lead.archived || lead.teamEnded || member.teamLeadId !== lead.id || member.archived || member.teamEnded ||
              !Number.isSafeInteger(lead.teamGeneration ?? 0) || (lead.teamGeneration ?? 0) < 0 ||
              !Number.isSafeInteger(member.teamMemberGeneration ?? 0) || (member.teamMemberGeneration ?? 0) !== (lead.teamGeneration ?? 0) ||
              hasSessionDeleteTombstone(lead.id, targetScope) || hasSessionDeleteTombstone(member.id, targetScope) || input.shouldUpdate?.() === false) throw new Error('Team changed')
          if (resolveMemberModelSelection(lead)) throw new Error('Legacy team model selection unavailable')
          readMemberModelChoice(member)
          const updated = { ...normalizeSession(member, targetScope), memberModelChoice: choice, sessionUrl: undefined, sessionProfileId: undefined, sessionRouteFingerprint: undefined }
          store.put(createStoredSession(updated, targetScope))
          result = { lead: normalizeSession(lead, targetScope), member: updated }
        } catch (error) { abort(createStorageError(error, 'Member model choice failed')) }
      }
      request.onerror = () => abort(createStorageError(request.error, 'Member model choice failed'))
      tx.oncomplete = () => result ? resolve(result) : reject(new Error('Member model choice failed'))
      tx.onerror = () => reject(failure ?? createStorageError(tx.error, 'Member model choice failed'))
      tx.onabort = () => reject(failure ?? createStorageError(tx.error, 'Member model choice aborted'))
    })
  })
}

/** Atomically admit a new member against the stored lead, limits and all stored team members. */
export async function createTeamMemberInDB(input: TeamMutationInput & { member: ChatSession }): Promise<{lead: ChatSession; member: ChatSession}> {
  const { scope, expectedLead, member } = input
  if (Object.hasOwn(member, 'memberModelChoice')) throw new Error('Member model choice requires explicit selection')
  const targetScope = normalizeScope(scope)
  if (!member.id || member.id === expectedLead.id || member.teamLeadId !== expectedLead.id || member.archived ||
      !member.teamMemberName || !/^[\p{L}\p{N}_-]{1,32}$/u.test(member.teamMemberName)) throw new Error('Invalid team member')
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    let result: {lead: ChatSession; member: ChatSession} | undefined
    let failure: Error | undefined
    const abort = (error: Error) => { failure = error; try { tx.abort() } catch { reject(error) } }
    request.onsuccess = () => {
      try {
        const records = (request.result as StoredChatSession[]).filter(record => normalizeScope(record.storageScope) === targetScope)
        const rawLead = records.find(record => record.id === expectedLead.id)
        if (!rawLead || !normalizedSessionsEqual(rawLead, expectedLead, targetScope) || rawLead.teamLeadId || rawLead.archived || rawLead.teamEnded ||
            hasSessionDeleteTombstone(expectedLead.id, targetScope) || hasSessionDeleteTombstone(member.id, targetScope) || input.shouldUpdate?.() === false) throw new Error('Team changed')
        if (records.some(record => record.id === member.id)) throw new Error('Member already exists')
        const limit = rawLead.teamSettings?.maxMembers ?? 6
        if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('Invalid team member limit')
        const members = records.filter(record => record.teamLeadId === expectedLead.id && !record.archived && (record.teamMemberGeneration ?? 0) === (rawLead.teamGeneration ?? 0))
        if (members.length >= limit || members.some(record => record.teamMemberName === member.teamMemberName)) throw new Error('Team is full or name is already used')
        const generation = rawLead.teamGeneration ?? 0
        if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid team generation')
        const admitted = {...member, teamMemberGeneration: generation}
        store.put(createStoredSession(admitted, targetScope))
        result = { lead: normalizeSession(rawLead, targetScope), member: normalizeSession(admitted, targetScope) }
      } catch (error) { abort(createStorageError(error, 'Team creation failed')) }
    }
    request.onerror = () => abort(createStorageError(request.error, 'Team creation failed'))
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('Team creation failed'))
    tx.onerror = () => reject(failure ?? createStorageError(tx.error, 'Team creation failed'))
    tx.onabort = () => reject(failure ?? createStorageError(tx.error, 'Team creation aborted'))
  })
}

/** End and optional archive commit atomically against the latest records in this scope. */
export async function endTeamInDB(input: TeamMutationInput): Promise<{lead: ChatSession; members: ChatSession[]}> {
  const { scope, expectedLead } = input
  const targetScope = normalizeScope(scope)
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    let result: {lead: ChatSession; members: ChatSession[]} | undefined
    let failure: Error | undefined
    const abort = (error: Error) => { failure = error; try { tx.abort() } catch { reject(error) } }
    request.onsuccess = () => {
      try {
        const records = (request.result as StoredChatSession[]).filter(record => normalizeScope(record.storageScope) === targetScope)
        const rawLead = records.find(record => record.id === expectedLead.id)
        if (!rawLead || !normalizedSessionsEqual(rawLead, expectedLead, targetScope) || rawLead.teamLeadId || rawLead.archived || rawLead.teamEnded ||
            hasSessionDeleteTombstone(expectedLead.id, targetScope) || input.shouldUpdate?.() === false) throw new Error('Team changed')
        const generation = rawLead.teamGeneration ?? 0
        if (!Number.isSafeInteger(generation) || generation < 0 || generation === Number.MAX_SAFE_INTEGER) throw new Error('Invalid team generation')
        const leadRevision = rawLead.teamLifecycleRevision ?? 0
        if (!Number.isSafeInteger(leadRevision) || leadRevision < 0 || leadRevision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid lifecycle revision')
        const lead = {...normalizeSession(rawLead, targetScope), teamEnded: true, teamGeneration: generation + 1, teamLifecycleRevision: leadRevision + 1}
        const members = records.filter(record => record.teamLeadId === rawLead.id && !record.archived).map(record => {
          const current = normalizeSession(record, targetScope)
          const revision = current.teamLifecycleRevision ?? 0
          if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid lifecycle revision')
          return {...current, teamLifecycleRevision:revision + 1, ...(rawLead.teamSettings?.autoCleanup ? {archived:true} : {})}
        })
        store.put(createStoredSession(lead, targetScope))
        for (const member of members) store.put(createStoredSession(member, targetScope))
        result = {lead, members}
      } catch (error) { abort(createStorageError(error, 'Team end failed')) }
    }
    request.onerror = () => abort(createStorageError(request.error, 'Team end failed'))
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('Team end failed'))
    tx.onerror = () => reject(failure ?? createStorageError(tx.error, 'Team end failed'))
    tx.onabort = () => reject(failure ?? createStorageError(tx.error, 'Team end aborted'))
  })
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
const defaultSaveOwner = Object.freeze({})
interface PendingOwnerSaves {
  sessions: Map<string, ChatSession>
  options: DebouncedSessionSaveOptions
  timer: ReturnType<typeof setTimeout>
}
const pendingSessionSaves = new Map<string, Map<object, PendingOwnerSaves>>()

export interface DebouncedSessionSaveOptions {
  onSuccess?: (sessions: ChatSession[]) => void
  onError?: (error: unknown, sessions: ChatSession[]) => void
  /** Optional single-session writer (e.g. a baseline-guarded save); defaults to saveSessionToDB. */
  saveOne?: (session: ChatSession, scope: string) => Promise<unknown>
  /** Resolve the live session just before writing, rather than saving a registered snapshot. */
  resolveLatest?: (sessionId: string, scope: string) => ChatSession | null
  /** Optional writer for the resolved snapshot; execute it within the caller's per-session queue. */
  saveLatest?: (sessionId: string, scope: string) => Promise<ChatSession | null>
  /** Distinct owners never share a debounce batch or writer callback. */
  owner?: object
  /** Release a payload that was canceled or replaced without running its writer. */
  onDiscard?: (session: ChatSession) => void
}

export function cancelDebouncedSessionSave(sessionId: string, scope = 'default', owner?: object): void {
  const targetScope = normalizeScope(scope)
  const owners = pendingSessionSaves.get(targetScope)
  if (!owners) return
  for (const [candidate, pending] of owners) {
    if (owner !== undefined && candidate !== owner) continue
    const discarded = pending.sessions.get(sessionId)
    if (discarded) pending.options.onDiscard?.(discarded)
    pending.sessions.delete(sessionId)
    if (pending.sessions.size === 0) {
      clearTimeout(pending.timer)
      owners.delete(candidate)
    }
  }
  if (owners.size === 0) pendingSessionSaves.delete(targetScope)
}

export function debouncedSaveSessions(
  sessions: ChatSession[],
  delayMs = 500,
  scope = 'default',
  options: DebouncedSessionSaveOptions = {}
): void {
  if (sessions.length === 0) return

  const targetScope = normalizeScope(scope)
  const owner = options.owner ?? defaultSaveOwner
  const owners = pendingSessionSaves.get(targetScope) ?? new Map<object, PendingOwnerSaves>()
  const pending = owners.get(owner)
  const entries = pending?.sessions ?? new Map<string, ChatSession>()
  for (const session of sessions) {
    if (hasSessionDeleteTombstone(session.id, targetScope)) {
      const previous = entries.get(session.id)
      if (previous) pending?.options.onDiscard?.(previous)
      entries.delete(session.id)
      options.onDiscard?.(session)
      options.onError?.(new ChatSessionSaveConflictError(session.id, targetScope), [session])
      continue
    }
    const previous = entries.get(session.id)
    if (previous && previous !== session) pending?.options.onDiscard?.(previous)
    entries.set(session.id, session)
  }
  if (entries.size === 0) {
    if (pending) {
      clearTimeout(pending.timer)
      owners.delete(owner)
      if (owners.size === 0) pendingSessionSaves.delete(targetScope)
    }
    return
  }
  if (pending) clearTimeout(pending.timer)
  const timer = setTimeout(() => {
    const batch = owners.get(owner)
    if (!batch || batch.timer !== timer) return
    owners.delete(owner)
    if (owners.size === 0) pendingSessionSaves.delete(targetScope)
    const snapshots = [...batch.sessions.values()]
    // Capture synchronous throws too; one failed item must not prevent the rest from settling.
    for (const registered of snapshots) {
      void Promise.resolve().then(async () => {
        if (batch.options.saveLatest) return batch.options.saveLatest(registered.id, targetScope)
        const session = batch.options.resolveLatest
          ? batch.options.resolveLatest(registered.id, targetScope)
          : registered
        if (!session) return null
        if (session.id !== registered.id) throw new Error('Resolved session ID changed')
        if (session !== registered) batch.options.onDiscard?.(registered)
        if (batch.options.saveOne) await batch.options.saveOne(session, targetScope)
        else await saveSessionToDB(session, targetScope, {pendingSaveOwner: null})
        return session
      }).then(
        session => session ? batch.options.onSuccess?.([session]) : batch.options.onDiscard?.(registered),
        error => {
          batch.options.onError?.(error, [registered])
          console.error(
            `[ChatStorage] debouncedSave failed: ${describeStorageError(createStorageError(error, 'IndexedDB debounced save failed.'))}`
          )
        }
      ).catch(error => console.error('[ChatStorage] debouncedSave callback failed:', error))
    }
  }, delayMs)
  owners.set(owner, {sessions: entries, options, timer})
  pendingSessionSaves.set(targetScope, owners)
}
