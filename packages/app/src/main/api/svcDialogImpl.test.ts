import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock, showOpenDialogMock, getFocusedWindowMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  getFocusedWindowMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: getFocusedWindowMock
  },
  dialog: {
    showMessageBox: showMessageBoxMock,
    showOpenDialog: showOpenDialogMock
  }
}))

import { DialogSvcImpl } from './svcDialogImpl'
import {
  clearScopedLocalMediaPathsForTest,
  resolveAuthorizedLocalMediaPath
} from '../localMediaAccess'
import {
  clearTrustedLocalFileSelectionsForTest,
  consumeTrustedLocalFileSelection
} from './trustedFileSelection'

const cleanupPaths: string[] = []

function makeTempDir(prefix: string): string {
  const tempRoot = os.tmpdir()
  fs.mkdirSync(tempRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tempRoot, prefix))
  cleanupPaths.push(directory)
  return directory
}

describe('DialogSvcImpl', () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset()
    showOpenDialogMock.mockReset()
    getFocusedWindowMock.mockReset()
    clearTrustedLocalFileSelectionsForTest()
    clearScopedLocalMediaPathsForTest()
  })

  afterEach(() => {
    cleanupPaths.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }))
  })

  it('remembers file selections as trusted local file paths', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:/models/model.glb'] })

    const svc = new DialogSvcImpl()
    await svc.showOpenDialog({ properties: ['openFile'] })

    expect(consumeTrustedLocalFileSelection('C:/models/model.glb')).toBe('C:/models/model.glb')
  })

  it('does not trust open-directory dialog results as uploadable local files', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:/models'] })

    const svc = new DialogSvcImpl()
    await svc.showOpenDialog({ properties: ['openDirectory'] })

    expect(() => consumeTrustedLocalFileSelection('C:/models')).toThrow('trusted dialog')
  })

  it('authorizes only descendants of a main-process directory picker result for local media', async () => {
    const selectedDirectory = makeTempDir('magicpot-dialog-selected-')
    const outsideDirectory = makeTempDir('magicpot-dialog-outside-')
    const selectedFile = path.join(selectedDirectory, 'nested', 'image.png')
    const outsideFile = path.join(outsideDirectory, 'image.png')
    fs.mkdirSync(path.dirname(selectedFile), { recursive: true })
    fs.writeFileSync(selectedFile, 'selected')
    fs.writeFileSync(outsideFile, 'outside')
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [selectedDirectory] })

    const svc = new DialogSvcImpl()
    await svc.showOpenDialog({ properties: ['openDirectory'] })

    expect(resolveAuthorizedLocalMediaPath(selectedFile, [])).toBe(
      path.resolve(fs.realpathSync.native(selectedFile))
    )
    expect(resolveAuthorizedLocalMediaPath(outsideFile, [])).toBeNull()
    expect(() => consumeTrustedLocalFileSelection(selectedDirectory)).toThrow('trusted dialog')
  })

  it('does not grant local-media directory access for canceled or mixed picker results', async () => {
    const directory = makeTempDir('magicpot-dialog-not-authorized-')
    const filePath = path.join(directory, 'image.png')
    fs.writeFileSync(filePath, 'image')
    const svc = new DialogSvcImpl()

    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [directory] })
    await svc.showOpenDialog({ properties: ['openDirectory'] })
    expect(resolveAuthorizedLocalMediaPath(filePath, [])).toBeNull()

    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [directory] })
    await svc.showOpenDialog({ properties: ['openFile', 'openDirectory'] })
    expect(resolveAuthorizedLocalMediaPath(filePath, [])).toBeNull()
  })

  it('uses the focused window as the parent for message boxes', async () => {
    const focusedWindow = { id: 1 }
    const options = { message: 'Clear Hunyuan3D COS cache?' }
    getFocusedWindowMock.mockReturnValue(focusedWindow)
    showMessageBoxMock.mockResolvedValue({ response: 1 })

    const svc = new DialogSvcImpl()
    await svc.showMessageBox(options)

    expect(showMessageBoxMock).toHaveBeenCalledWith(focusedWindow, options)
  })

  it('falls back to an unparented message box when no window is focused', async () => {
    const options = { message: 'Clear Hunyuan3D COS cache?' }
    getFocusedWindowMock.mockReturnValue(null)
    showMessageBoxMock.mockResolvedValue({ response: 0 })

    const svc = new DialogSvcImpl()
    await svc.showMessageBox(options)

    expect(showMessageBoxMock).toHaveBeenCalledWith(options)
  })
})
