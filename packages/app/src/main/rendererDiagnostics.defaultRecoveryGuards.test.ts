import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))

import { attachRendererDiagnostics, handleRendererProcessGone } from './rendererDiagnostics'

const details = { reason: 'crashed' as const, exitCode: 1 }
const createWindow = () => ({
  isDestroyed: vi.fn(() => false),
  webContents: {
    isDestroyed: vi.fn(() => false),
    reload: vi.fn(),
    on: vi.fn()
  }
})

describe('default renderer recovery guards', () => {
  afterEach(() => vi.restoreAllMocks())

  it('direct handler skips a destroyed window before checking webContents', () => {
    const window = createWindow()
    window.isDestroyed.mockReturnValue(true)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    handleRendererProcessGone(window as never, details)

    expect(window.webContents.isDestroyed).not.toHaveBeenCalled()
    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[App] Renderer recovery skipped because the window is already destroyed')
  })

  it('direct handler skips destroyed webContents', () => {
    const window = createWindow()
    window.webContents.isDestroyed.mockReturnValue(true)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    handleRendererProcessGone(window as never, details)

    expect(window.isDestroyed).toHaveBeenCalledOnce()
    expect(window.webContents.isDestroyed).toHaveBeenCalledOnce()
    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[App] Renderer recovery skipped because webContents is already destroyed')
  })

  it.each(['window', 'webContents'] as const)(
    'attached listener short-circuits when %s is destroyed',
    (destroyed) => {
      const window = createWindow()
      if (destroyed === 'window') window.isDestroyed.mockReturnValue(true)
      else window.webContents.isDestroyed.mockReturnValue(true)
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      attachRendererDiagnostics(window as never)
      const listener = window.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')?.[1] as unknown as (event: object, eventDetails: typeof details) => void
      expect(listener).toBeTypeOf('function')

      listener({}, details)

      expect(window.webContents.reload).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('attached listener catches a synchronous reload failure for a live window', () => {
    const window = createWindow()
    window.webContents.reload.mockImplementation(() => { throw new Error('synthetic reload failure') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    attachRendererDiagnostics(window as never)
    const listener = window.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')?.[1] as unknown as (event: object, eventDetails: typeof details) => void
    expect(listener).toBeTypeOf('function')

    expect(() => listener({}, details)).not.toThrow()
    expect(window.webContents.reload).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith('[App] Renderer recovery reload failed')
  })
})
