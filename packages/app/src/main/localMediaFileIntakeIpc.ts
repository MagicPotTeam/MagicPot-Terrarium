import fs from 'node:fs/promises'
import path from 'node:path'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  authorizeScopedLocalMediaPath,
  recordLocalMediaImportGrant,
  resolveAuthorizedLocalMediaPath
} from './localMediaAccess'
import { getLocalMediaAllowedRoots } from './localMediaAllowedRoots'
import { toImportSourceLocalPath } from './api/svcManagedMediaImpl'
import { isManagedMediaMimeTypeSupported } from './llmProxy/managedMediaStore'

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

export type LocalMediaImportGrantDependencies = {
  realpath?: (filePath: string) => Promise<string>
  stat?: (filePath: string) => Promise<{ isFile(): boolean }>
  now?: () => number
}

const isImportablePath = (value: string): boolean => {
  try {
    return toImportSourceLocalPath(value) === value
  } catch {
    return false
  }
}

/**
 * Records a short-lived, in-memory import grant for one file the user picked or dropped and
 * returns its canonical path, or '' when main would not import it: an unsupported type, a
 * path that is not a plain local path (checked before any filesystem access, so a UNC path
 * never makes main contact a host), a canonical form main refuses (a mapped network drive
 * resolves to UNC), or anything that is not an existing regular file. Nothing is persisted
 * and the persisted canvas grants are untouched.
 */
export async function grantLocalMediaImportPath(
  filePath: unknown,
  mimeType: unknown,
  {
    realpath = (value) => fs.realpath(value),
    stat = (value) => fs.stat(value),
    now = Date.now
  }: LocalMediaImportGrantDependencies = {}
): Promise<string> {
  if (typeof filePath !== 'string' || typeof mimeType !== 'string') return ''
  if (!isManagedMediaMimeTypeSupported(mimeType) || !isImportablePath(filePath)) return ''
  try {
    const canonical = path.resolve(await realpath(filePath))
    if (!isImportablePath(canonical) || !(await stat(canonical)).isFile()) return ''
    recordLocalMediaImportGrant(canonical, now())
    return canonical
  } catch {
    return ''
  }
}

export function registerLocalMediaFileIntakeIpc(getMainWindow: () => BrowserWindow | null): void {
  if (localMediaFileIntakeIpcRegistered) return

  ipcMain.handle('local-media:authorize-picker-path', (event, filePath: string): boolean => {
    return isTrustedRenderer(event, getMainWindow) && authorizeScopedLocalMediaPath(filePath)
  })

  // The path comes only from the preload's webUtils.getPathForFile of a real File.
  ipcMain.handle(
    'local-media:authorize-import-path',
    async (event, filePath: unknown, mimeType: unknown): Promise<string> => {
      if (!isTrustedRenderer(event, getMainWindow)) return ''
      return grantLocalMediaImportPath(filePath, mimeType)
    }
  )

  ipcMain.handle('local-media:resolve-scoped-path', (event, filePath: string): string => {
    if (!isTrustedRenderer(event, getMainWindow)) return ''
    return resolveAuthorizedLocalMediaPath(filePath, getLocalMediaAllowedRoots()) ?? ''
  })

  localMediaFileIntakeIpcRegistered = true
}

export function resetLocalMediaFileIntakeIpcForTest(): void {
  localMediaFileIntakeIpcRegistered = false
}
