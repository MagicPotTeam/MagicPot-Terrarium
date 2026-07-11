import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useCanvasScreenshotShortcutSync } from './useCanvasScreenshotShortcutSync'

function renderShortcutSync(
  overrides: Partial<Parameters<typeof useCanvasScreenshotShortcutSync>[0]> = {}
) {
  const options = {
    toolShortcuts: { select: 'Ctrl+S' },
    setCurrentShortcut: vi.fn(),
    notifyWarning: vi.fn(),
    notifyError: vi.fn(),
    ...overrides
  }
  const view = renderHook(() => useCanvasScreenshotShortcutSync(options))
  return { ...view, options }
}

describe('useCanvasScreenshotShortcutSync', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when screenshot IPC invoke is unavailable', () => {
    const { options } = renderShortcutSync({ invoke: undefined })

    expect(options.setCurrentShortcut).not.toHaveBeenCalled()
    expect(options.notifyWarning).not.toHaveBeenCalled()
    expect(options.notifyError).not.toHaveBeenCalled()
  })

  it('stores the active shortcut when it does not conflict with canvas shortcuts', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ shortcut: 'Ctrl+Alt+P' })
    const { options } = renderShortcutSync({ invoke })

    await waitFor(() => expect(options.setCurrentShortcut).toHaveBeenCalledWith('Ctrl+Alt+P'))

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('screenshot:getShortcut')
    expect(options.notifyWarning).not.toHaveBeenCalled()
    expect(options.notifyError).not.toHaveBeenCalled()
  })

  it('resets to the default shortcut when the active shortcut conflicts', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ shortcut: 'Ctrl+S' })
      .mockResolvedValueOnce({ success: true })
    const { options } = renderShortcutSync({ invoke })

    await waitFor(() => expect(options.notifyWarning).toHaveBeenCalledTimes(1))

    expect(invoke).toHaveBeenNthCalledWith(1, 'screenshot:getShortcut')
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'screenshot:setShortcut',
      '`',
      expect.arrayContaining(['Ctrl+S'])
    )
    expect(options.setCurrentShortcut).toHaveBeenCalledWith('Ctrl+S')
    expect(options.setCurrentShortcut).toHaveBeenCalledWith('`')
    expect(options.notifyWarning).toHaveBeenCalledWith(
      'Screenshot shortcut Ctrl+S conflicts with a canvas shortcut; restored to `.'
    )
  })

  it('notifies an error when automatic conflict reset fails', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ shortcut: 'Ctrl+S' })
      .mockResolvedValueOnce({ success: false, error: 'reset failed' })
    const { options } = renderShortcutSync({ invoke })

    await waitFor(() => expect(options.notifyError).toHaveBeenCalledWith('reset failed'))

    expect(options.notifyWarning).not.toHaveBeenCalled()
  })

  it('does not update state after unmount', async () => {
    let resolveGetShortcut: (value: unknown) => void = () => undefined
    const invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveGetShortcut = resolve
        })
    )
    const { options, unmount } = renderShortcutSync({ invoke })

    unmount()
    resolveGetShortcut({ shortcut: 'Ctrl+Alt+P' })
    await Promise.resolve()

    expect(options.setCurrentShortcut).not.toHaveBeenCalled()
    expect(options.notifyWarning).not.toHaveBeenCalled()
    expect(options.notifyError).not.toHaveBeenCalled()
  })
})
