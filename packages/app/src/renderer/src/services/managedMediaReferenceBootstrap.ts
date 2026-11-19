import {
  CHAT_SESSION_LOADING_STATE_EVENT,
  hasRunningScopedChatRequests
} from '../pages/ChatPage/chatPageShared'
import { forEachStoredChatRecord } from '../pages/ChatPage/chatStorage'
import {
  CanvasMetadataFileError,
  loadCanvasItemsMetadata
} from '../pages/ProjectCanvasPage/canvasStorage'
import { LEGACY_PROJECTS_STORAGE_KEY, PROJECTS_STORAGE_KEY } from '../pages/MainPage/projectStore'
import { api } from '../utils/windowUtils'
import {
  ManagedMediaScanSourceError,
  scanManagedMediaReferenceIds,
  type ManagedMediaReferenceScannerSources,
  type ManagedMediaScanProblem,
  type ManagedMediaScanSource
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
      // One board at a time, so only one board's items are held; a board that cannot be read
      // fails the scan.
      let projectIds: string[]
      try {
        projectIds = readProjectIds()
      } catch (error) {
        throw new ManagedMediaScanSourceError({ source: 'project-index' }, { cause: error })
      }
      for (const projectId of projectIds) {
        let items: unknown[]
        try {
          items = (await loadCanvasItemsMetadata(projectId)).items
        } catch (error) {
          const source = error instanceof CanvasMetadataFileError ? 'canvas-file' : 'canvas-board'
          throw new ManagedMediaScanSourceError({ source, context: projectId }, { cause: error })
        }
        visit(items, projectId)
      }
    },
    // Draft backups of every scope are read from localStorage by the scanner itself.
    localStorage
  }
}

const SCAN_WARNING_INTERVAL_MS = 60 * 60_000
const SCAN_WARNING_CONTEXT_MAX_LENGTH = 120
const lastScanWarningAt = new Map<ManagedMediaScanSource, number>()

const quoted = (context: string | undefined): string =>
  context === undefined ? '' : ` "${context.slice(0, SCAN_WARNING_CONTEXT_MAX_LENGTH)}"`

function describeScanFailure({ source, context }: ManagedMediaScanProblem): string {
  switch (source) {
    case 'chat-store':
      return 'the chat store could not be read'
    case 'chat-media':
      return `a chat record of scope${quoted(context)} holds a media value that is not a managed reference`
    case 'canvas-board':
      return `canvas board${quoted(context)} could not be read`
    case 'canvas-file':
      return `a stored file of canvas board${quoted(context)} could not be read or parsed`
    case 'canvas-media':
      return `canvas board${quoted(context)} holds a media value that is not a managed reference`
    case 'project-index':
      return 'the project index could not be read'
    case 'draft-backup':
      return `a draft backup of scope${quoted(context)} could not be read or parsed`
    case 'draft-media':
      return `a draft backup of scope${quoted(context)} holds a media value that is not a managed reference`
    case 'local-storage':
      return 'localStorage could not be read'
  }
}

/** At most one warning per source per hour: a broken store fails every scan. */
function warnIncompleteScan(failure: ManagedMediaScanProblem): void {
  const now = Date.now()
  const last = lastScanWarningAt.get(failure.source)
  if (last !== undefined && now >= last && now - last < SCAN_WARNING_INTERVAL_MS) return
  lastScanWarningAt.set(failure.source, now)
  console.warn(
    `[ManagedMedia] Reference scan incomplete: ${describeScanFailure(failure)}. ` +
      'Unused managed media is not cleaned up until a scan completes.'
  )
}

async function publishManagedMediaReferenceSnapshot(isCurrent: () => boolean): Promise<void> {
  const result = await scanManagedMediaReferenceIds(createScannerSources())
  if (!result.ok) warnIncompleteScan(result.failure)
  // A deferral that began while this scan ran withdrew the snapshot: do not put one back.
  if (!isCurrent()) return
  await api().svcManagedMedia.updateReferenceSnapshot({
    version: 1,
    complete: result.ok,
    ids: result.ids,
    referenceCounts: result.referenceCounts
  })
}

/** Main drops its snapshot on an incomplete one: no cleanup runs until the next complete scan. */
async function withdrawManagedMediaReferenceSnapshot(): Promise<void> {
  await api().svcManagedMedia.updateReferenceSnapshot({
    version: 1,
    complete: false,
    ids: [],
    referenceCounts: {}
  })
}

export function startManagedMediaReferenceScanner(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  // When the scan due first found a chat request running; undefined while none is waiting.
  let deferredSince: number | undefined
  // Moves when a deferral withdraws the snapshot; a scan that started before is not published.
  let epoch = 0
  const scan = () => {
    timer = undefined
    if (stopped) return
    // A scan never starts while a chat request runs: it waits for the requests to end. Main
    // would keep planning its daily cleanup from the last complete snapshot, however old, so
    // the wait starts by withdrawing it, and it is bounded: past the cap the scan runs anyway.
    if (hasRunningScopedChatRequests()) {
      const now = Date.now()
      if (deferredSince === undefined) {
        deferredSince = now
        epoch += 1
        void withdrawManagedMediaReferenceSnapshot().catch(() => undefined)
      }
      const waited = now - deferredSince
      // A clock set back (a negative wait) counts as a wait past the cap.
      if (waited >= 0 && waited < SNAPSHOT_MAX_DEFER_MS) {
        timer = setTimeout(scan, SNAPSHOT_MAX_DEFER_MS - waited)
        return
      }
    }
    deferredSince = undefined
    const scanEpoch = epoch
    void publishManagedMediaReferenceSnapshot(() => scanEpoch === epoch).catch(() => undefined)
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
