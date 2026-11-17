// packages/app/src/main/chatSendStageBreadcrumbs.ts
// Keeps, per renderer, the last chat send-stage breadcrumb and the sends that have not ended yet
// (counts, sizes and enumerated names only, plus the JS heap size its preload read), so that a
// renderer death recorded by processDiagnostics.ts says where in which send it happened. Several
// requests of one page can overlap (a thread's send, a background context compaction, another
// thread, the side panel): each carries its own sequence number, and 'reply-finished' /
// 'reply-failed' close only their own send.
import { ipcMain, type BrowserWindow, type IpcMainEvent, type WebContents } from 'electron'
import {
  CHAT_SEND_STAGES,
  CHAT_SEND_STAGE_CHANNEL,
  TERMINAL_CHAT_SEND_STAGES,
  parseChatSendStageReport,
  type ChatSendStageReport
} from '@shared/utils/chatSendStageBreadcrumb'

export type StoredChatSendStage = ChatSendStageReport & { receivedAt: string }

type RendererSends = {
  last: StoredChatSendStage
  /** Sends that reported a stage but not their end, oldest first. */
  open: Map<number, StoredChatSendStage>
  /** The last ended sends: a late report of one of them must not open it again. */
  closed: number[]
  /** The highest number that reported 'request-start': a lower one means the page restarted. */
  maxStartedSeq: number
}

const MAX_TRACKED_RENDERERS = 16
/** Unfinished sends kept per renderer; the oldest is dropped beyond this. */
export const MAX_OPEN_CHAT_SENDS = 8
const MAX_CLOSED_CHAT_SENDS = 32
const sendsByWebContents = new Map<number, RendererSends>()
let registered = false

const stageRank = (stage: string) => CHAT_SEND_STAGES.indexOf(stage as (typeof CHAT_SEND_STAGES)[number])

export function recordChatSendStage(webContentsId: number, payload: unknown, receivedAt = Date.now()): boolean {
  const breadcrumb = parseChatSendStageReport(payload)
  if (!breadcrumb || !Number.isSafeInteger(webContentsId)) return false
  const stored: StoredChatSendStage = { ...breadcrumb, receivedAt: new Date(receivedAt).toISOString() }
  let sends = sendsByWebContents.get(webContentsId)
  // Request numbers restart with the page: a start that is not newer than one already seen comes
  // from a page that replaced the old one without a process death.
  if (sends && stored.stage === 'request-start' && stored.sendSeq <= sends.maxStartedSeq) sends = undefined
  if (!sends) sends = { last: stored, open: new Map(), closed: [], maxStartedSeq: 0 }
  const seq = stored.sendSeq
  // A late report (of a send that has ended, or of a stage the send has already passed) changes
  // nothing: the last report must never move backwards.
  const previousOpen = sends.open.get(seq)
  const stale =
    sends.closed.includes(seq) ||
    (previousOpen !== undefined && stageRank(stored.stage) < stageRank(previousOpen.stage))
  if (!stale) sends.last = stored
  if (TERMINAL_CHAT_SEND_STAGES.includes(stored.stage)) {
    sends.open.delete(seq)
    if (!sends.closed.includes(seq)) {
      sends.closed.push(seq)
      if (sends.closed.length > MAX_CLOSED_CHAT_SENDS) sends.closed.shift()
    }
  } else if (!sends.closed.includes(seq)) {
    // A report that arrives out of order never moves a send back to an earlier stage.
    if (!stale) sends.open.set(seq, stored)
    while (sends.open.size > MAX_OPEN_CHAT_SENDS) {
      const oldest = sends.open.keys().next().value
      if (oldest === undefined) break
      sends.open.delete(oldest)
    }
  }
  if (stored.stage === 'request-start') sends.maxStartedSeq = Math.max(sends.maxStartedSeq, seq)
  // Re-insert so that the map stays ordered by the latest report.
  sendsByWebContents.delete(webContentsId)
  sendsByWebContents.set(webContentsId, sends)
  while (sendsByWebContents.size > MAX_TRACKED_RENDERERS) {
    const oldest = sendsByWebContents.keys().next().value
    if (oldest === undefined) break
    sendsByWebContents.delete(oldest)
  }
  return true
}

/** The last breadcrumb of one renderer, or (without an id) the latest of any renderer. */
export function getLastChatSendStage(webContentsId?: number): StoredChatSendStage | null {
  if (webContentsId !== undefined) return sendsByWebContents.get(webContentsId)?.last ?? null
  let latest: StoredChatSendStage | null = null
  for (const sends of sendsByWebContents.values()) latest = sends.last
  return latest
}

/** The sends of one renderer that have not ended, oldest first (at most MAX_OPEN_CHAT_SENDS). */
export function getOpenChatSends(webContentsId: number): StoredChatSendStage[] {
  const sends = sendsByWebContents.get(webContentsId)
  return sends ? [...sends.open.values()] : []
}

/** After a renderer death was recorded, or when its page is replaced: the next page starts empty. */
export function forgetChatSendStage(webContentsId: number): void {
  sendsByWebContents.delete(webContentsId)
}

// Each reporting page's WebContents gets these two listeners once, for its whole life.
const watchedWebContents = new WeakSet<WebContents>()
/**
 * A real navigation or reload of the main frame replaces the page without a process death (the
 * error screen's reload button, the unsaved-changes prompt): its requests are gone and will never
 * report an end, so their breadcrumbs must not be placed in a later death.
 */
export function forgetChatSendStageOnPageChange(webContents: WebContents): void {
  if (watchedWebContents.has(webContents)) return
  watchedWebContents.add(webContents)
  const webContentsId = webContents.id
  // Only when the new document commits ('did-navigate': main frame, never in-page). Not when a
  // navigation merely starts: the window blocks some of them (an untrusted link, a stray file drop,
  // see mainWindow.ts 'will-navigate') and the page keeps running its sends; and the sends of the
  // old page that run while a navigation starts really are running until the new page replaces it.
  webContents.on('did-navigate', () => forgetChatSendStage(webContentsId))
  webContents.once('destroyed', () => forgetChatSendStage(webContentsId))
}

/**
 * One fire-and-forget channel. A message is accepted only from the top frame of the main
 * window's page, and only when it is exactly a breadcrumb; everything else is ignored.
 */
export function registerChatSendStageIpc(getMainWindow: () => BrowserWindow | null): void {
  if (registered) return
  registered = true
  ipcMain.on(CHAT_SEND_STAGE_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
    try {
      const sender = event.sender
      if (!sender || sender.isDestroyed()) return
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== sender) return
      if (!event.senderFrame || event.senderFrame !== sender.mainFrame) return
      if (recordChatSendStage(sender.id, payload)) forgetChatSendStageOnPageChange(sender)
    } catch {
      // A frame or window that is going away: there is nothing to record.
    }
  })
}

export function resetChatSendStagesForTests(): void {
  sendsByWebContents.clear()
  registered = false
}
