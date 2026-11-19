import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  let windowListeners: Map<string, EventListener>
  let addWindowListener: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    vi.resetModules()
    exposeMock.mockReset()
    getPathForFileMock.mockReset()
    invokeMock.mockReset()
    onMock.mockReset()
    removeListenerMock.mockReset()
    sendMock.mockReset()
    sendSyncMock.mockReset()
    windowListeners = new Map()
    addWindowListener = vi.fn((name: string, listener: EventListener) => {
      windowListeners.set(name, listener)
    })
    vi.stubGlobal('window', {
      addEventListener: addWindowListener,
      removeEventListener: vi.fn()
    })
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    await import('./index')
  })
  afterEach(() => vi.unstubAllGlobals())

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

  it('asks for an import grant only with the webUtils path of a real File', async () => {
    const electronFile = exposeMock.mock.calls.find(([name]) => name === 'electronFile')?.[1]
    const file = { name: 'picked.png' }
    getPathForFileMock.mockReturnValue('/picked/picked.png')
    invokeMock.mockResolvedValue({ path: '/canonical/picked.png', sizeBytes: 3 })

    await expect(electronFile.authorizeLocalMediaFileForImport(file, 'image/png')).resolves.toBe(
      '/canonical/picked.png'
    )
    expect(getPathForFileMock).toHaveBeenCalledWith(file)
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      'local-media:authorize-import-path',
      '/picked/picked.png',
      'image/png'
    )

    // A page cannot name the path: a string or a forged object has no webUtils path.
    invokeMock.mockClear()
    getPathForFileMock.mockImplementation((target: unknown) => {
      if (typeof target === 'string') throw new TypeError('not a File')
      return ''
    })
    await expect(
      electronFile.authorizeLocalMediaFileForImport('/home/user/.ssh/id_rsa', 'image/png')
    ).resolves.toBe('')
    await expect(
      electronFile.authorizeLocalMediaFileForImport(
        { name: 'forged.png', path: '/etc/shadow' },
        'image/png'
      )
    ).resolves.toBe('')
    expect(invokeMock).not.toHaveBeenCalled()
    // A malformed answer from main is never passed on as a path.
    getPathForFileMock.mockReturnValue('/picked/picked.png')
    for (const answer of ['/etc/shadow', { path: '/etc/shadow' }, { path: 7, sizeBytes: 1 }]) {
      invokeMock.mockResolvedValue(answer)
      await expect(electronFile.authorizeLocalMediaFileForImport(file, 'image/png')).resolves.toBe(
        ''
      )
    }
    expect(sendSyncMock).not.toHaveBeenCalled()
  })

  it('captures trusted drops before bridge exposure without exposing a trust setter', () => {
    const electronFile = exposeMock.mock.calls.find(([name]) => name === 'electronFile')?.[1]
    expect(Object.keys(electronFile).sort()).toEqual([
      'authorizeDroppedLocalImage',
      'authorizeDroppedLocalImageForImport',
      'authorizeLocalMediaFile',
      'authorizeLocalMediaFileForImport',
      'getPathForFile',
      'resolveAuthorizedLocalMediaPath'
    ])
    expect(addWindowListener).toHaveBeenCalledWith('drop', expect.any(Function), true)
    expect(addWindowListener.mock.invocationCallOrder[0]).toBeLessThan(
      exposeMock.mock.invocationCallOrder[0]
    )
  })

  it('never sends string-only or synthetic-drop requests to path authorization IPC', async () => {
    const electronFile = exposeMock.mock.calls.find(([name]) => name === 'electronFile')?.[1]
    const url = 'file:///C:/Synthetic%20Lark/unselected.png'
    await expect(electronFile.authorizeDroppedLocalImage(url, { isTrusted: true })).resolves.toBe(
      ''
    )
    windowListeners.get('drop')?.({
      isTrusted: false,
      dataTransfer: { getData: (type: string) => (type === 'text/plain' ? url : '') }
    } as unknown as Event)
    await expect(electronFile.authorizeDroppedLocalImage(url)).resolves.toBe('')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(getPathForFileMock).not.toHaveBeenCalled()
  })

  it('routes only the exact captured image URL through the existing async path-grant IPC', async () => {
    const electronFile = exposeMock.mock.calls.find(([name]) => name === 'electronFile')?.[1]
    const url =
      process.platform === 'win32'
        ? 'file:///C:/Synthetic%20Lark/drop.png'
        : 'file:///tmp/Synthetic%20Lark/drop.png'
    invokeMock.mockResolvedValue(true)
    windowListeners.get('drop')?.({
      isTrusted: true,
      dataTransfer: { getData: (type: string) => (type === 'text/plain' ? url : '') }
    } as unknown as Event)
    expect(invokeMock).not.toHaveBeenCalled()
    await expect(electronFile.authorizeDroppedLocalImage(url)).resolves.toBe(fileURLToPath(url))
    await expect(electronFile.authorizeDroppedLocalImage(url)).resolves.toBe('')
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      'local-media:authorize-picker-path',
      fileURLToPath(url)
    )
    expect(getPathForFileMock).not.toHaveBeenCalled()
    expect(sendSyncMock).not.toHaveBeenCalled()
  })

  it('asks main for a one-use import grant for the exact captured URL, once per drop', async () => {
    const electronFile = exposeMock.mock.calls.find(([name]) => name === 'electronFile')?.[1]
    const url =
      process.platform === 'win32'
        ? 'file:///C:/Synthetic%20Lark/import.png'
        : 'file:///tmp/Synthetic%20Lark/import.png'
    invokeMock.mockResolvedValue({ path: fileURLToPath(url), sizeBytes: 42 })
    // Nothing without a trusted drop that carried this URL.
    await expect(electronFile.authorizeDroppedLocalImageForImport(url, 'image/png')).resolves.toBe(
      null
    )
    windowListeners.get('drop')?.({
      isTrusted: true,
      dataTransfer: { getData: (type: string) => (type === 'text/uri-list' ? url : '') }
    } as unknown as Event)
    await expect(
      electronFile.authorizeDroppedLocalImageForImport(url, 'image/png')
    ).resolves.toEqual({ path: fileURLToPath(url), sizeBytes: 42 })
    // The URL is used up: no second grant of either kind from the same drop.
    await expect(electronFile.authorizeDroppedLocalImageForImport(url, 'image/png')).resolves.toBe(
      null
    )
    await expect(electronFile.authorizeDroppedLocalImage(url)).resolves.toBe('')
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      'local-media:authorize-import-path',
      fileURLToPath(url),
      'image/png'
    )
    // Never the persisted grant channel.
    expect(invokeMock).not.toHaveBeenCalledWith('local-media:authorize-picker-path', expect.anything())
  })

  it('invalidates an unconsumed trusted drop on navigation', async () => {
    const electronFile = exposeMock.mock.calls.find(([name]) => name === 'electronFile')?.[1]
    const url = 'file:///C:/Synthetic%20Lark/drop.png'
    windowListeners.get('drop')?.({
      isTrusted: true,
      dataTransfer: { getData: (type: string) => (type === 'text/plain' ? url : '') }
    } as unknown as Event)
    windowListeners.get('pagehide')?.({} as Event)
    await expect(electronFile.authorizeDroppedLocalImage(url)).resolves.toBe('')
    expect(invokeMock).not.toHaveBeenCalled()
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
    // Found by channel: the preload also listens for the renderer recovery notice from the start.
    const listener = onMock.mock.calls.find(([channel]) => channel === 'canvas:add-image')?.[1]
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

  it('keeps the renderer recovery notice until the app shell subscribes and delivers it once', () => {
    const appEvents = exposeMock.mock.calls.find(([name]) => name === 'appEvents')?.[1]
    const recoveryListener = onMock.mock.calls.find(
      ([channel]) => channel === 'app:renderer-recovered'
    )?.[1]
    expect(recoveryListener).toBeTypeOf('function')
    // Listening starts before the page can subscribe (the event comes on did-finish-load).
    expect(onMock.mock.invocationCallOrder[0]).toBeLessThan(exposeMock.mock.invocationCallOrder[0])

    recoveryListener({}, { reason: 'crashed', exitCode: 5, diedAt: 1000 })
    const first = vi.fn()
    const unsubscribe = appEvents.onRendererRecovered(first)
    expect(first).toHaveBeenCalledExactlyOnceWith({ reason: 'crashed', exitCode: 5, diedAt: 1000 })

    const second = vi.fn()
    appEvents.onRendererRecovered(second)
    expect(second).not.toHaveBeenCalled()

    recoveryListener({}, { reason: 'oom', exitCode: -536870904, diedAt: 2000 })
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledExactlyOnceWith({ reason: 'oom', exitCode: -536870904, diedAt: 2000 })
    unsubscribe()
    recoveryListener({}, { reason: 'crashed', exitCode: 5, diedAt: 3000 })
    expect(first).toHaveBeenCalledTimes(2)
  })

  it.each([
    null,
    'crashed',
    { reason: 'crashed', exitCode: 5 },
    { reason: 'crashed', exitCode: 1.5, diedAt: 1 },
    { reason: '<b>x</b>', exitCode: 1, diedAt: 1 },
    { reason: 'x'.repeat(65), exitCode: 1, diedAt: 1 }
  ])('drops a recovery notice of the wrong shape: %j', (payload) => {
    const appEvents = exposeMock.mock.calls.find(([name]) => name === 'appEvents')?.[1]
    const recoveryListener = onMock.mock.calls.find(
      ([channel]) => channel === 'app:renderer-recovered'
    )?.[1]
    recoveryListener({}, payload)
    const callback = vi.fn()
    appEvents.onRendererRecovered(callback)
    expect(callback).not.toHaveBeenCalled()
  })

  it('forwards only exact send-stage breadcrumbs on their one channel', () => {
    const appDiagnostics = exposeMock.mock.calls.find(([name]) => name === 'appDiagnostics')?.[1]
    expect(Object.keys(appDiagnostics)).toEqual(['reportChatSendStage'])
    const breadcrumb = { stage: 'request-built', sendSeq: 3, messageCount: 1, imageCount: 8, imageBytes: 10, dataUrlCount: 8, dataUrlChars: 99 }

    appDiagnostics.reportChatSendStage(breadcrumb)
    appDiagnostics.reportChatSendStage({ ...breadcrumb, content: 'secret' })
    // A symbol key is refused here, in the preload (main does not look for one: IPC cannot carry it).
    appDiagnostics.reportChatSendStage({ ...breadcrumb, [Symbol('content')]: 'secret' })
    appDiagnostics.reportChatSendStage('request-built')

    expect(sendMock).toHaveBeenCalledExactlyOnceWith('app:chat-send-stage', breadcrumb)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('forwards the send number and a failure\'s stage and enumerated error name, and nothing that is not one', () => {
    const appDiagnostics = exposeMock.mock.calls.find(([name]) => name === 'appDiagnostics')?.[1]
    const counts = { messageCount: 1, imageCount: 8, imageBytes: 10, dataUrlCount: 8, dataUrlChars: 99 }
    const failed = { stage: 'reply-failed', sendSeq: 4, ...counts, failedAfter: 'images-checked', errorName: 'RangeError' }
    appDiagnostics.reportChatSendStage(failed)
    // A number that is not a count, a message in the name, a free-text stage, failure fields on a running stage.
    for (const forged of [
      { stage: 'request-start', sendSeq: '4', ...counts },
      { stage: 'request-start', sendSeq: -1, ...counts },
      { stage: 'request-start', sendSeq: 1.5, ...counts },
      { stage: 'request-start', ...counts },
      { ...failed, errorName: 'Error: C:\\Users\\secret\\a.png not found' },
      { ...failed, failedAfter: 'while reading secret.png' },
      { ...failed, errorName: undefined },
      { stage: 'request-built', sendSeq: 4, ...counts, errorName: 'TypeError' }
    ]) {
      appDiagnostics.reportChatSendStage(forged)
    }
    expect(sendMock).toHaveBeenCalledExactlyOnceWith('app:chat-send-stage', failed)
  })

  it('adds the JS heap size from V8 itself and never forwards a heap number the page supplied', () => {
    const appDiagnostics = exposeMock.mock.calls.find(([name]) => name === 'appDiagnostics')?.[1]
    const breadcrumb = { stage: 'request-built', sendSeq: 1, messageCount: 9, imageCount: 40, imageBytes: 10, dataUrlCount: 40, dataUrlChars: 99 }
    // Electron reports the heap statistics in KB.
    const getHeapStatistics = vi.fn(() => ({ usedHeapSize: 1_887_346, heapSizeLimit: 2_195_456 }))
    Object.defineProperty(process, 'getHeapStatistics', { configurable: true, value: getHeapStatistics })
    try {
      appDiagnostics.reportChatSendStage(breadcrumb)
      // performance.memory is quantised and cached (26 MB during a real out-of-memory death):
      // a page that sends its own heap number is not forwarded at all.
      appDiagnostics.reportChatSendStage({ ...breadcrumb, usedJSHeapSize: 26_000_000, jsHeapSizeLimit: 2_330_000_000 })

      expect(sendMock).toHaveBeenCalledExactlyOnceWith('app:chat-send-stage', {
        ...breadcrumb,
        usedJSHeapSize: 1_932_642_304,
        jsHeapSizeLimit: 2_248_146_944
      })
      expect(getHeapStatistics).toHaveBeenCalledTimes(1)
    } finally {
      delete (process as { getHeapStatistics?: unknown }).getHeapStatistics
    }
  })

  it('still forwards the counts when the heap statistics cannot be read', () => {
    const appDiagnostics = exposeMock.mock.calls.find(([name]) => name === 'appDiagnostics')?.[1]
    const breadcrumb = { stage: 'reply-failed', sendSeq: 2, messageCount: 2, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, failedAfter: 'request-start', errorName: 'AbortError' }
    Object.defineProperty(process, 'getHeapStatistics', { configurable: true, value: () => { throw new Error('synthetic') } })
    try {
      expect(() => appDiagnostics.reportChatSendStage(breadcrumb)).not.toThrow()
      Object.defineProperty(process, 'getHeapStatistics', { configurable: true, value: () => ({ usedHeapSize: Number.NaN, heapSizeLimit: undefined }) })
      appDiagnostics.reportChatSendStage(breadcrumb)
    } finally {
      delete (process as { getHeapStatistics?: unknown }).getHeapStatistics
    }
    expect(sendMock.mock.calls).toEqual([
      ['app:chat-send-stage', breadcrumb],
      ['app:chat-send-stage', breadcrumb]
    ])
  })
})
