// packages/app/src/main/chatSendStageBreadcrumbs.ts
// Keeps the last chat send-stage breadcrumb of each renderer (counts and sizes only, plus the JS
// heap size its preload read), so that a renderer death recorded by processDiagnostics.ts says
// where in a send it happened.
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import {
  CHAT_SEND_STAGE_CHANNEL,
  parseChatSendStageReport,
  type ChatSendStageReport
} from '@shared/utils/chatSendStageBreadcrumb'

export type StoredChatSendStage = ChatSendStageReport & { receivedAt: string }

const MAX_TRACKED_RENDERERS = 16
const lastStageByWebContents = new Map<number, StoredChatSendStage>()
let registered = false

export function recordChatSendStage(webContentsId: number, payload: unknown, receivedAt = Date.now()): boolean {
  const breadcrumb = parseChatSendStageReport(payload)
  if (!breadcrumb || !Number.isSafeInteger(webContentsId)) return false
  // Re-insert so that the map stays ordered by the latest report.
  lastStageByWebContents.delete(webContentsId)
  lastStageByWebContents.set(webContentsId, { ...breadcrumb, receivedAt: new Date(receivedAt).toISOString() })
  while (lastStageByWebContents.size > MAX_TRACKED_RENDERERS) {
    const oldest = lastStageByWebContents.keys().next().value
    if (oldest === undefined) break
    lastStageByWebContents.delete(oldest)
  }
  return true
}

/** The last breadcrumb of one renderer, or (without an id) the latest of any renderer. */
export function getLastChatSendStage(webContentsId?: number): StoredChatSendStage | null {
  if (webContentsId !== undefined) return lastStageByWebContents.get(webContentsId) ?? null
  let latest: StoredChatSendStage | null = null
  for (const stage of lastStageByWebContents.values()) latest = stage
  return latest
}

/** After a renderer death was recorded: the page that replaces it starts without a breadcrumb. */
export function forgetChatSendStage(webContentsId: number): void {
  lastStageByWebContents.delete(webContentsId)
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
      recordChatSendStage(sender.id, payload)
    } catch {
      // A frame or window that is going away: there is nothing to record.
    }
  })
}

export function resetChatSendStagesForTests(): void {
  lastStageByWebContents.clear()
  registered = false
}
