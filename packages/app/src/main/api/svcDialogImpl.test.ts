import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  clearTrustedLocalFileSelectionsForTest,
  consumeTrustedLocalFileSelection
} from './trustedFileSelection'

describe('DialogSvcImpl', () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset()
    showOpenDialogMock.mockReset()
    getFocusedWindowMock.mockReset()
    clearTrustedLocalFileSelectionsForTest()
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
