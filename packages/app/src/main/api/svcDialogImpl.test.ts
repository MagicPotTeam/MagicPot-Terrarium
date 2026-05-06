import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock, getFocusedWindowMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  getFocusedWindowMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: getFocusedWindowMock
  },
  dialog: {
    showMessageBox: showMessageBoxMock
  }
}))

import { DialogSvcImpl } from './svcDialogImpl'

describe('DialogSvcImpl', () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset()
    getFocusedWindowMock.mockReset()
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
