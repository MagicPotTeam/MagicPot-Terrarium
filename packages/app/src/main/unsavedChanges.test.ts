import { EventEmitter } from 'node:events'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnsavedChangesController } from './unsavedChanges'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))

class FakeWebContents extends EventEmitter {
  destroyed = false

  constructor(private readonly senderId: number) {
    super()
  }

  get id(): number {
    if (this.destroyed) throw new Error('WebContents has been destroyed')
    return this.senderId
  }
}

class FakeWindow {
  destroyed = false
  readonly contents: FakeWebContents

  constructor(senderId: number) {
    this.contents = new FakeWebContents(senderId)
  }

  get webContents(): FakeWebContents {
    if (this.destroyed) throw new Error('BrowserWindow has been destroyed')
    return this.contents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

function asBrowserWindow(window: FakeWindow): BrowserWindow {
  return window as unknown as BrowserWindow
}

describe('UnsavedChangesController teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 2, checkboxChecked: false })
  })

  it.each([true, false])(
    'removes only the destroyed sender state (window destroyed: %s)',
    async (destroyWindow) => {
      const controller = new UnsavedChangesController()
      controller.registerIpc()
      expect(vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel)).toEqual([
        'win:set-unsaved-document-state',
        'win:unsaved-save-result'
      ])
      const setState = vi.mocked(ipcMain.handle).mock.calls[0][1]
      const window = new FakeWindow(41)
      const otherWindow = new FakeWindow(42)
      controller.attach(asBrowserWindow(window))
      controller.attach(asBrowserWindow(otherWindow))
      expect(window.contents.listenerCount('destroyed')).toBe(1)
      expect(window.contents.listenerCount('will-prevent-unload')).toBe(1)

      for (const senderId of [41, 42]) {
        setState({ sender: { id: senderId } } as IpcMainInvokeEvent, {
          dirty: true,
          title: 'Unsaved canvas'
        })
      }
      await expect(controller.confirm(asBrowserWindow(window))).resolves.toBe(false)
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
      vi.mocked(dialog.showMessageBox).mockClear()

      window.destroyed = destroyWindow
      window.contents.destroyed = true
      expect(() => window.contents.id).toThrow('WebContents has been destroyed')
      if (destroyWindow) {
        expect(() => window.webContents).toThrow('BrowserWindow has been destroyed')
      }
      expect(() => window.contents.emit('destroyed')).not.toThrow()

      // Probe the removed sender via a live fake, without inspecting private controller state.
      await expect(controller.confirm(asBrowserWindow(new FakeWindow(41)))).resolves.toBe(true)
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
      await expect(controller.confirm(asBrowserWindow(otherWindow))).resolves.toBe(false)
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    }
  )
})
