import { loadAllSessions, readSessionDraftBackup } from '../pages/ChatPage/chatStorage'
import { loadCanvasItems } from '../pages/ProjectCanvasPage/canvasStorage'
import { api } from '../utils/windowUtils'
import {
  scanManagedMediaReferenceIds,
  type ManagedMediaReferenceScannerSources
} from './managedMediaReferenceScanner'

const SNAPSHOT_DEBOUNCE_MS = 2_000
const SNAPSHOT_RECONCILE_MS = 5 * 60_000

type ProjectIndexEntry = { id?: unknown; canvasId?: unknown }

function readProjectIds(): string[] {
  const raw = localStorage.getItem('ai_engine_projects')
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Malformed project index')
  return parsed.map((project) => {
    if (!project || typeof project !== 'object') throw new Error('Malformed project entry')
    const candidate = project as ProjectIndexEntry
    const id = typeof candidate.canvasId === 'string' ? candidate.canvasId : candidate.id
    if (typeof id !== 'string' || !id.trim()) throw new Error('Malformed project entry')
    return id
  })
}

function createScannerSources(): ManagedMediaReferenceScannerSources {
  return {
    readChatSessions: async () => loadAllSessions(),
    readChatDrafts: async () => {
      const sessions = await loadAllSessions()
      return sessions.map((session) => readSessionDraftBackup(session.id)).filter(Boolean)
    },
    readCanvasItems: async () => {
      const documents = await Promise.all(
        readProjectIds().map((projectId) => loadCanvasItems(projectId))
      )
      return documents.flatMap((document) => document.items)
    },
    localStorage
  }
}

async function publishManagedMediaReferenceSnapshot(): Promise<void> {
  const result = await scanManagedMediaReferenceIds(createScannerSources())
  await api().svcManagedMedia.updateReferenceSnapshot({
    version: 1,
    complete: result.ok,
    ids: result.ids
  })
}

export function startManagedMediaReferenceScanner(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void publishManagedMediaReferenceSnapshot().catch(() => undefined)
    }, SNAPSHOT_DEBOUNCE_MS)
  }
  schedule()
  const reconcileTimer = setInterval(schedule, SNAPSHOT_RECONCILE_MS)
  window.addEventListener('storage', schedule)
  window.addEventListener('focus', schedule)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    clearInterval(reconcileTimer)
    window.removeEventListener('storage', schedule)
    window.removeEventListener('focus', schedule)
  }
}
