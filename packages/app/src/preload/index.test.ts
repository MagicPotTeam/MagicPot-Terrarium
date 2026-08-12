import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  exposeMock,
  getPathForFileMock,
  invokeMock,
  onMock,
  removeListenerMock,
  sendMock,
  sendSyncMock
} = vi.hoisted(() => ({
  exposeMock: vi.fn(),
  getPathForFileMock: vi.fn(),
  invokeMock: vi.fn(),
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
  sendMock: vi.fn(),
  sendSyncMock: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeMock },
  ipcRenderer: {
    invoke: invokeMock,
    on: onMock,
    removeListener: removeListenerMock,
    send: sendMock,
    sendSync: sendSyncMock
  },
  webUtils: { getPathForFile: getPathForFileMock }
}))

vi.mock('./apiIpc', () => ({ newApiIpc: () => ({}) }))
vi.mock('./winBridge', () => ({ winBridge: {} }))

describe('preload capability boundary', () => {
  beforeEach(async () => {
    vi.resetModules()
    exposeMock.mockReset()
    getPathForFileMock.mockReset()
    invokeMock.mockReset()
    onMock.mockReset()
    removeListenerMock.mockReset()
    sendMock.mockReset()
    sendSyncMock.mockReset()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    await import('./index')
  })

  it('does not expose the generic Electron ipcRenderer API', () => {
    const exposedNames = exposeMock.mock.calls.map(([name]) => name)

    expect(exposedNames).not.toContain('electron')
    expect(exposedNames).toEqual(
      expect.arrayContaining([
        'api',
        'appEvents',
        'canvasScreenshot',
        'electronFile',
        'path',
        'win'
      ])
    )
  })

  it('authorizes picker files only through webUtils.getPathForFile and async IPC', async () => {
    const file = { name: 'selected.png' }
    getPathForFileMock.mockReturnValue('/picked/selected.png')
    invokeMock.mockResolvedValue(true)
    const electronFile = exposeMock.mock.calls.find(([name]) => name === 'electronFile')?.[1]

    await expect(electronFile.authorizeLocalMediaFile(file)).resolves.toBe('/picked/selected.png')
    expect(getPathForFileMock).toHaveBeenCalledWith(file)
    expect(invokeMock).toHaveBeenCalledWith(
      'local-media:authorize-picker-path',
      '/picked/selected.png'
    )
    expect(sendSyncMock).not.toHaveBeenCalled()
  })

  it('exposes only named main-process event subscriptions', () => {
    const appEvents = exposeMock.mock.calls.find(([name]) => name === 'appEvents')?.[1]
    const closeTab = vi.fn()
    const refreshQApps = vi.fn()

    const removeCloseTab = appEvents.onCloseActiveTab(closeTab)
    const closeTabListener = onMock.mock.calls.find(([channel]) => channel === 'app:close-tab')?.[1]
    closeTabListener({})
    removeCloseTab()

    const removeRefresh = appEvents.onQAppDirectoryChanged(refreshQApps)
    const refreshListener = onMock.mock.calls.find(
      ([channel]) => channel === 'qapp:dir-changed'
    )?.[1]
    refreshListener({})
    removeRefresh()

    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(refreshQApps).toHaveBeenCalledTimes(1)
    expect(removeListenerMock).toHaveBeenCalledWith('app:close-tab', closeTabListener)
    expect(removeListenerMock).toHaveBeenCalledWith('qapp:dir-changed', refreshListener)
  })

  it('preserves narrow screenshot and canvas-image event bridges', async () => {
    const canvasScreenshot = exposeMock.mock.calls.find(
      ([name]) => name === 'canvasScreenshot'
    )?.[1]
    const callback = vi.fn()

    await canvasScreenshot.capture()
    await canvasScreenshot.getShortcut()
    await canvasScreenshot.setShortcut('Ctrl+Shift+S', ['Ctrl+S'])
    canvasScreenshot.selectRegion({ x: 10, y: 20, w: 300, h: 200 })
    canvasScreenshot.cancelSelection()
    canvasScreenshot.setFloatingOpacity('floating-1', 0.75)
    canvasScreenshot.closeFloatingWindow('floating-1')
    canvasScreenshot.sendFloatingToCanvas('floating-1')
    const remove = canvasScreenshot.onAddImage(callback)
    const listener = onMock.mock.calls[0]?.[1]
    listener({}, 'data:image/png;base64,abc')
    remove()

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'screenshot:capture')
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'screenshot:getShortcut')
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'screenshot:setShortcut', 'Ctrl+Shift+S', [
      'Ctrl+S'
    ])
    expect(sendMock).toHaveBeenNthCalledWith(1, 'screenshot:region', {
      x: 10,
      y: 20,
      w: 300,
      h: 200
    })
    expect(sendMock).toHaveBeenNthCalledWith(2, 'screenshot:cancel')
    expect(sendMock).toHaveBeenNthCalledWith(3, 'floating:opacity', 'floating-1', 0.75)
    expect(sendMock).toHaveBeenNthCalledWith(4, 'floating:close', 'floating-1')
    expect(sendMock).toHaveBeenNthCalledWith(5, 'floating:to-canvas', 'floating-1')
    expect(onMock).toHaveBeenCalledWith('canvas:add-image', listener)
    expect(callback).toHaveBeenCalledWith('data:image/png;base64,abc')
    expect(removeListenerMock).toHaveBeenCalledWith('canvas:add-image', listener)
  })
})
