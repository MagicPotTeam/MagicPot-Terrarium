import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { authorizeScopedLocalMediaPath, resolveAuthorizedLocalMediaPath } from './localMediaAccess'
import { getLocalMediaAllowedRoots } from './localMediaAllowedRoots'

let localMediaFileIntakeIpcRegistered = false

function isTrustedRenderer(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null
): boolean {
  const mainWindow = getMainWindow()
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    event.sender === mainWindow.webContents
  )
}

export function registerLocalMediaFileIntakeIpc(getMainWindow: () => BrowserWindow | null): void {
  if (localMediaFileIntakeIpcRegistered) return

  ipcMain.handle('local-media:authorize-picker-path', (event, filePath: string): boolean => {
    return isTrustedRenderer(event, getMainWindow) && authorizeScopedLocalMediaPath(filePath)
  })

  ipcMain.handle('local-media:resolve-scoped-path', (event, filePath: string): string => {
    if (!isTrustedRenderer(event, getMainWindow)) return ''
    return resolveAuthorizedLocalMediaPath(filePath, getLocalMediaAllowedRoots()) ?? ''
  })

  localMediaFileIntakeIpcRegistered = true
}

export function resetLocalMediaFileIntakeIpcForTest(): void {
  localMediaFileIntakeIpcRegistered = false
}
