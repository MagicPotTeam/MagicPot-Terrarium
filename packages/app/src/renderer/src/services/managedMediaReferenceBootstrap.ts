import {
  CHAT_SESSION_LOADING_STATE_EVENT,
  hasRunningScopedChatRequests
} from '../pages/ChatPage/chatPageShared'
import { forEachStoredChatRecord } from '../pages/ChatPage/chatStorage'
import { loadCanvasItemsMetadata } from '../pages/ProjectCanvasPage/canvasStorage'
import { LEGACY_PROJECTS_STORAGE_KEY, PROJECTS_STORAGE_KEY } from '../pages/MainPage/projectStore'
import { api } from '../utils/windowUtils'
import {
  scanManagedMediaReferenceIds,
  type ManagedMediaReferenceScannerSources
} from './managedMediaReferenceScanner'

const SNAPSHOT_DEBOUNCE_MS = 2_000
const SNAPSHOT_RECONCILE_MS = 5 * 60_000
const SNAPSHOT_MAX_DEFER_MS = 15 * 60_000

type ProjectIndexEntry = {
  id?: unknown
  canvasId?: unknown
  canvasStorageKey?: unknown
}

function readProjectIds(): string[] {
  const raw =
    localStorage.getItem(PROJECTS_STORAGE_KEY) ?? localStorage.getItem(LEGACY_PROJECTS_STORAGE_KEY)
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Malformed project index')
  return parsed.map((project) => {
    if (!project || typeof project !== 'object') throw new Error('Malformed project entry')
    const candidate = project as ProjectIndexEntry
    // The canonical registry can use a separate storage key. Older records
    // only have id/canvasId, so keep those fallbacks for migration safety.
    const id =
      typeof candidate.canvasStorageKey === 'string'
        ? candidate.canvasStorageKey
        : typeof candidate.canvasId === 'string'
          ? candidate.canvasId
          : candidate.id
    if (typeof id !== 'string' || !id.trim()) throw new Error('Malformed project entry')
    return id
  })
}

function createScannerSources(): ManagedMediaReferenceScannerSources {
  return {
    // Every record of the chat store, of every scope (the Agent column's panes, team members and
    // anything else stored there), one at a time and as stored: the draft each record keeps (its
    // composer attachments and queued sends) is part of the record.
    visitChatRecords: (visit) => forEachStoredChatRecord(visit),
    visitCanvasItems: async (visit) => {
      // Only the items' media references are scanned: read the records, not the images
      // (a full load would wrap every image of every board in a new object URL each scan).
      const documents = await Promise.all(
        readProjectIds().map((projectId) => loadCanvasItemsMetadata(projectId))
      )
      for (const document of documents) visit(document.items)
    },
    // Draft backups of every scope are read from localStorage by the scanner itself.
    localStorage
  }
}

async function publishManagedMediaReferenceSnapshot(): Promise<void> {
  const result = await scanManagedMediaReferenceIds(createScannerSources())
  await api().svcManagedMedia.updateReferenceSnapshot({
    version: 1,
    complete: result.ok,
    ids: result.ids,
    referenceCounts: result.referenceCounts
  })
}

export function startManagedMediaReferenceScanner(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  // When the scan due first found a chat request running; undefined while none is waiting.
  let deferredSince: number | undefined
  const scan = () => {
    timer = undefined
    if (stopped) return
    // A scan never starts while a chat request runs: it waits for the requests to end, and is
    // retried by the reconcile timer. The wait is bounded, because main keeps using the last
    // complete snapshot for its daily cleanup until a newer one arrives.
    if (hasRunningScopedChatRequests()) {
      deferredSince ??= Date.now()
      if (Date.now() - deferredSince < SNAPSHOT_MAX_DEFER_MS) return
    }
    deferredSince = undefined
    void publishManagedMediaReferenceSnapshot().catch(() => undefined)
  }
  const schedule = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(scan, SNAPSHOT_DEBOUNCE_MS)
  }
  const onChatLoadingState = () => {
    if (deferredSince !== undefined && !hasRunningScopedChatRequests()) schedule()
  }
  schedule()
  const reconcileTimer = setInterval(schedule, SNAPSHOT_RECONCILE_MS)
  // Not on window focus: that is when the user comes back to send, and the scan has no reason
  // to run then (start, the reconcile timer and other windows' storage writes cover it).
  window.addEventListener('storage', schedule)
  window.addEventListener(CHAT_SESSION_LOADING_STATE_EVENT, onChatLoadingState)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = undefined
    clearInterval(reconcileTimer)
    window.removeEventListener('storage', schedule)
    window.removeEventListener(CHAT_SESSION_LOADING_STATE_EVENT, onChatLoadingState)
  }
}
