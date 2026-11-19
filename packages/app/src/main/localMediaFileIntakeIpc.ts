import fs from 'node:fs/promises'
import path from 'node:path'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  authorizeScopedLocalMediaPath,
  localMediaImportGrantClock,
  recordLocalMediaImportGrant,
  resolveAuthorizedLocalMediaPath
} from './localMediaAccess'
import { getLocalMediaAllowedRoots } from './localMediaAllowedRoots'
import { toImportSourceLocalPath } from './api/svcManagedMediaImpl'
import {
  DEFAULT_IMPORT_SOURCE_GUARD,
  importSourceRootKey,
  isManagedMediaMimeTypeSupported,
  runImportSourceOperation
} from './llmProxy/managedMediaStore'

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
  stat?: (filePath: string) => Promise<{ isFile(): boolean; size: number }>
  now?: () => number
  /** Deadline for the realpath and stat (the file may sit on a stalled mount). */
  timeoutMs?: number
}

/** A one-use import grant: the canonical path main will import, and its size when granted. */
export type LocalMediaImportGrant = { path: string; sizeBytes: number }
/**
 * Why no grant was recorded, where the renderer acts on it: the file did not answer in time
 * (the composer says so and reads nothing itself), or its canonical form is a network path
 * main never imports by path (a mapped network drive: the composer may read it as bytes).
 */
export type LocalMediaImportGrantRefusal = { refused: 'timeout' | 'network' }

const isNetworkOrDevicePath = (value: string): boolean => /^[\\/]{2}/u.test(value)

const isImportablePath = (value: string): boolean => {
  try {
    return toImportSourceLocalPath(value) === value
  } catch {
    return false
  }
}

/**
 * Records a short-lived, in-memory import grant for one file the user picked or dropped and
 * returns its canonical path and size, or null when main would not import it: an
 * unsupported type, a path that is not a plain local path (checked before any filesystem
 * access, so a UNC path never makes main contact a host), a canonical form main refuses (a
 * mapped network drive resolves to UNC), or anything that is not an existing regular file.
 * Nothing is persisted and the persisted canvas grants are untouched.
 */
export async function grantLocalMediaImportFile(
  filePath: unknown,
  mimeType: unknown,
  {
    realpath = (value) => fs.realpath(value),
    stat = (value) => fs.stat(value),
    now = localMediaImportGrantClock,
    timeoutMs = DEFAULT_IMPORT_SOURCE_GUARD.operationTimeoutMs
  }: LocalMediaImportGrantDependencies = {}
): Promise<LocalMediaImportGrant | LocalMediaImportGrantRefusal | null> {
  if (typeof filePath !== 'string' || typeof mimeType !== 'string') return null
  if (!isManagedMediaMimeTypeSupported(mimeType) || !isImportablePath(filePath)) return null
  try {
    // Off the event loop and under the import-source deadline and gate.
    const granted = await runImportSourceOperation(
      async (): Promise<LocalMediaImportGrant | LocalMediaImportGrantRefusal | null> => {
        const canonical = await realpath(filePath)
        // Checked on the realpath result itself, in any path syntax: a mapped drive's UNC form.
        if (isNetworkOrDevicePath(canonical)) return { refused: 'network' }
        const resolved = path.resolve(canonical)
        if (!isImportablePath(resolved)) return null
        const stats = await stat(resolved)
        return stats.isFile() ? { path: resolved, sizeBytes: stats.size } : null
      },
      { key: importSourceRootKey(filePath), timeoutMs }
    )
    if (!granted || !('path' in granted)) return granted
    recordLocalMediaImportGrant(granted.path, now())
    return granted
  } catch (error) {
    return (error as { code?: unknown })?.code === 'MANAGED_MEDIA_IMPORT_TIMEOUT'
      ? { refused: 'timeout' }
      : null
  }
}

/** grantLocalMediaImportFile's canonical path, or ''. */
export async function grantLocalMediaImportPath(
  filePath: unknown,
  mimeType: unknown,
  dependencies: LocalMediaImportGrantDependencies = {}
): Promise<string> {
  const granted = await grantLocalMediaImportFile(filePath, mimeType, dependencies)
  return granted && 'path' in granted ? granted.path : ''
}

export function registerLocalMediaFileIntakeIpc(getMainWindow: () => BrowserWindow | null): void {
  if (localMediaFileIntakeIpcRegistered) return

  ipcMain.handle('local-media:authorize-picker-path', (event, filePath: string): boolean => {
    return isTrustedRenderer(event, getMainWindow) && authorizeScopedLocalMediaPath(filePath)
  })

  // The path comes only from the preload: webUtils.getPathForFile of a real File, or a file
  // URL of the current trusted drop (its private drop lease).
  ipcMain.handle(
    'local-media:authorize-import-path',
    async (
      event,
      filePath: unknown,
      mimeType: unknown
    ): Promise<LocalMediaImportGrant | LocalMediaImportGrantRefusal | null> => {
      if (!isTrustedRenderer(event, getMainWindow)) return null
      return grantLocalMediaImportFile(filePath, mimeType)
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
