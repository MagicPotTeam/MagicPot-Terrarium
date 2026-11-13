import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ windows: [] as any[], sessions: [] as any[], theme: undefined as any, visible: true, focused: true, mark: vi.fn(), settle: vi.fn(), setTheme: vi.fn(), setupError: false, proxyClose: vi.fn(), unsafe: false, load: vi.fn(), execute: vi.fn() }))
vi.mock('node:net', () => ({ createServer: () => ({ maxConnections: 0, once: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => { ready() }, address: () => ({ port: 12345 }), close: h.proxyClose }) }))
vi.mock('electron', () => ({
  get nativeTheme() { return h.theme },
  app: { commandLine: { hasSwitch: () => h.unsafe }, whenReady: async () => undefined },
  session: { fromPartition: (partition: string) => {
    const session = Object.assign(new EventEmitter(), { partition, setProxy: vi.fn(async () => undefined), getPreloadScripts: () => [], setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() }, protocol: { handle: vi.fn(), unhandle: vi.fn() }, clearStorageData: vi.fn(async () => undefined) }); h.sessions.push(session); return session
  } },
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), { id: h.windows.length + 10, isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(), setWebRTCIPHandlingPolicy: vi.fn(), executeJavaScript: (script: string) => script.includes('.markInput(') ? h.mark(script) : script.includes('.settle(') ? h.settle(script) : script.includes('.setTheme(') ? h.setTheme(script) : script.includes('.revokeInput(') ? Promise.resolve() : h.execute(script), forcefullyCrashRenderer: vi.fn() })
    constructor(readonly options: unknown) { super(); if (h.setupError) throw new Error('window setup failed'); h.windows.push(this) }
    isVisible() { return h.visible }
    isFocused() { return h.focused }
    getContentBounds() { return { x: 0, y: 0, width: 900, height: 680 } }
    getContentSize() { return [900, 680] }
    isDestroyed() { return this.destroyed }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    loadURL = h.load
    setTitle = vi.fn()
    showInactive = vi.fn()
  }
}))
import { buildIsolatedHtmlShell, openIsolatedHtmlHost } from './agentThreadHtmlHost'
const document = { title: 'App', html: '<h1>ok</h1>', revision: 1 }
beforeEach(() => { h.theme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false }); h.visible = true; h.focused = true; h.mark.mockReset().mockResolvedValue(true); h.settle.mockReset().mockResolvedValue(undefined); h.setTheme.mockReset().mockResolvedValue(undefined); vi.useFakeTimers(); h.unsafe = false; h.setupError = false; h.proxyClose.mockClear(); h.windows.length = 0; h.sessions.length = 0; h.load.mockReset().mockResolvedValue(undefined); h.execute.mockReset().mockResolvedValue('{"requests":[],"dropped":0}') })
afterEach(() => { h.windows.forEach((window) => window.destroy()); vi.useRealTimers() })
describe('isolated HTML host main lifecycle', () => {
  it('requires sandbox controls and a bounded document before creating a window', async () => {
    h.unsafe = true
    await expect(openIsolatedHtmlHost(document, { onEvent: vi.fn(), onClosed: vi.fn() })).rejects.toThrow('security')
    h.unsafe = false
    await expect(openIsolatedHtmlHost({ ...document, html: 'x'.repeat(262145) }, { onEvent: vi.fn(), onClosed: vi.fn() })).rejects.toThrow('bounded')
    expect(h.windows).toEqual([])
  })
  it('escapes model text in the trusted shell payload and never grants same-origin/preload/Node', async () => {
    const shell = buildIsolatedHtmlShell({ ...document, html: '</script><script>ATTACK</script>', data: { x: '</script>' } }, '11111111-1111-4111-8111-111111111111')
    expect(shell).not.toContain('</script><script>ATTACK'); expect(shell).toContain('sandbox="allow-scripts"'); expect(shell).not.toContain('allow-same-origin')
    const host = await openIsolatedHtmlHost(document, { hidden: true, onEvent: vi.fn(), onClosed: vi.fn() })
    expect(h.windows[0].options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, webSecurity: true })
    expect(h.windows[0].options.webPreferences).not.toHaveProperty('preload')
    expect(h.windows[0].showInactive).not.toHaveBeenCalled(); host.close()
  })
  it('captures final bounded state after freezing and superseding a pending poll', async () => {
    const receive = vi.fn(), state = { revision: 1, stateRevision: 3, value: { n: 42 } }
    const host = await openIsolatedHtmlHost(document, { onEvent: receive, onClosed: vi.fn() })
    let drain!: (value: string) => void
    h.execute.mockImplementationOnce(() => new Promise(resolve => { drain = resolve })).mockResolvedValueOnce(JSON.stringify(state))
    await vi.advanceTimersByTimeAsync(50)
    expect(await host.captureState()).toEqual(state)
    drain(JSON.stringify({ requests: [{ id: 1, event: {} }], dropped: 0 }))
    await vi.advanceTimersByTimeAsync(250); expect(receive).not.toHaveBeenCalled(); expect(h.execute).toHaveBeenCalledTimes(2)
    await host.update({ ...document, revision: 2, state: state.value })
    expect(h.load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(50); expect(h.execute).toHaveBeenCalledTimes(3)
    host.close()
  })
  it('does not close or spawn duplicate polling when an old drain rejects after an update', async () => {
    let fail!: (error: Error) => void
    h.execute.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const closed = vi.fn(), host = await openIsolatedHtmlHost(document, { hidden: true, onEvent: vi.fn(), onClosed: closed })
    await vi.advanceTimersByTimeAsync(50); expect(h.execute).toHaveBeenCalledOnce()
    await host.update({ ...document, revision: 2, html: '<p>new</p>' })
    fail(new Error('old navigation context destroyed'))
    await vi.advanceTimersByTimeAsync(50)
    expect(closed).not.toHaveBeenCalled(); expect(h.execute).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(250); expect(h.execute).toHaveBeenCalledTimes(3)
    host.close(); expect(closed).toHaveBeenCalledTimes(1)
  })
  it('does not crash the new generation if the old execute promise ignores navigation and times out', async () => {
    h.execute.mockImplementationOnce(() => new Promise(() => undefined))
    const closed = vi.fn(), host = await openIsolatedHtmlHost(document, { hidden: true, onEvent: vi.fn(), onClosed: closed })
    await vi.advanceTimersByTimeAsync(50); await host.update({ ...document, revision: 2 })
    await vi.advanceTimersByTimeAsync(2200)
    expect(host.closed).toBe(false); expect(closed).not.toHaveBeenCalled(); expect(h.windows[0].webContents.forcefullyCrashRenderer).not.toHaveBeenCalled()
    host.close()
  })
  it('disposes the proxy and protocol handlers when window creation fails', async () => {
    h.setupError = true
    await expect(openIsolatedHtmlHost(document, { hidden: true, onEvent: vi.fn(), onClosed: vi.fn() })).rejects.toThrow('window setup failed')
    expect(h.proxyClose).toHaveBeenCalledOnce()
    expect(h.sessions[0].protocol.unhandle).toHaveBeenCalledWith('https')
    expect(h.sessions[0].clearStorageData).toHaveBeenCalledOnce()
  })
  it('does not deliver a second drained event after the first event callback closes its host', async () => {
    const event = { name: '__error__', data: {}, revision: 1, origin: 'app', untrustedData: true, grantsPermission: false }
    h.execute.mockResolvedValueOnce(JSON.stringify({ requests: [{ id: 1, inputToken: '', event }, { id: 2, inputToken: '', event }], dropped: 0 }))
    const receive = vi.fn(() => host.close()), host = await openIsolatedHtmlHost(document, { hidden: true, onEvent: receive, onClosed: vi.fn() })
    await vi.advanceTimersByTimeAsync(50)
    expect(receive).toHaveBeenCalledOnce(); expect(host.closed).toBe(true)
  })
  it('reports renderer queue/rate-limit overflow rather than silently losing feedback', async () => {
    h.execute.mockResolvedValue(JSON.stringify({ requests: [], dropped: 4 }))
    const receive = vi.fn(), host = await openIsolatedHtmlHost(document, { hidden: true, onEvent: receive, onClosed: vi.fn() })
    await vi.advanceTimersByTimeAsync(50)
    expect(receive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: '__overflow__', revision: 1, data: { dropped: 4, source: 'renderer' }, grantsPermission: false }))
    await vi.advanceTimersByTimeAsync(250); expect(receive).toHaveBeenCalledOnce()
    host.close()
  })
  it('tags native input intervals and acknowledges events only after current-window dispatch', async () => {
    const receive = vi.fn(), host = await openIsolatedHtmlHost(document, { onEvent: receive, onClosed: vi.fn() })
    h.windows[0].webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 100, y: 100, globalX: 100, globalY: 100 })
    const token = /markInput\("([a-f0-9-]+)"/.exec(h.mark.mock.calls[0][0])![1]
    const event = { name: 'done', data: 42, revision: 1, origin: 'app', untrustedData: true, grantsPermission: false }
    h.execute.mockResolvedValueOnce(JSON.stringify({ requests: [{ id: 1, inputToken: token, event }], dropped: 0 }))
    h.settle.mockImplementationOnce(async () => { expect(receive).toHaveBeenCalledOnce() })
    await vi.advanceTimersByTimeAsync(50); expect(receive).toHaveBeenCalledWith(event); expect(h.settle).toHaveBeenCalledOnce()
    host.close()
  })
  it.each(['expired', 'blur', 'hidden', 'outside', 'autorepeat'] as const)('rejects %s input without receiving model feedback', async reason => {
    const receive = vi.fn(), host = await openIsolatedHtmlHost(document, { onEvent: receive, onClosed: vi.fn() })
    if (reason === 'autorepeat') h.windows[0].webContents.emit('before-input-event', {}, { type: 'keyDown', isAutoRepeat: true })
    else h.windows[0].webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 50, y: reason === 'outside' ? 10 : 100, globalX: 50, globalY: reason === 'outside' ? 10 : 100 })
    const token = h.mark.mock.calls[0] ? /markInput\("([a-f0-9-]+)"/.exec(h.mark.mock.calls[0][0])![1] : 'forged'
    if (reason === 'blur') h.windows[0].emit('blur')
    if (reason === 'hidden') h.visible = false
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(5001)
    h.execute.mockResolvedValueOnce(JSON.stringify({ requests: [{ id: 1, inputToken: token, event: { name: 'done', data: {}, revision: 1, origin: 'app', untrustedData: true, grantsPermission: false } }], dropped: 0 }))
    await vi.advanceTimersByTimeAsync(reason === 'expired' ? 250 : 50)
    expect(receive).not.toHaveBeenCalled(); expect(h.settle.mock.calls.at(-1)![0]).toContain('expired or revoked'); host.close()
  })
  it('retains a mousedown interval after mouseup and rechecks expiry after awaited drain', async () => {
    const receive = vi.fn(), host = await openIsolatedHtmlHost(document, { onEvent: receive, onClosed: vi.fn() })
    h.windows[0].webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 100, y: 100, globalX: 100, globalY: 100 })
    const token = /markInput\("([a-f0-9-]+)"/.exec(h.mark.mock.calls[0][0])![1]
    h.windows[0].webContents.emit('before-mouse-event', {}, { type: 'mouseUp', x: 100, y: 100, globalX: 100, globalY: 100 })
    const response = JSON.stringify({ requests: [{ id: 1, inputToken: token, event: { name: 'done', data: {}, revision: 1, origin: 'app', untrustedData: true, grantsPermission: false } }], dropped: 0 })
    h.execute.mockResolvedValueOnce(response); await vi.advanceTimersByTimeAsync(50); expect(receive).toHaveBeenCalledOnce()
    let finish!: (value: string) => void
    await vi.advanceTimersByTimeAsync(4500)
    h.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(250); await vi.advanceTimersByTimeAsync(300); finish(response); await Promise.resolve(); await Promise.resolve()
    expect(receive).toHaveBeenCalledOnce(); host.close()
  })
  it('drops former document input tokens even when an old native marker resolves late', async () => {
    const receive = vi.fn(), host = await openIsolatedHtmlHost(document, { onEvent: receive, onClosed: vi.fn() })
    let finishMark!: (value: boolean) => void
    h.mark.mockImplementationOnce(() => new Promise(resolve => { finishMark = resolve }))
    h.windows[0].webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 50, y: 100, globalX: 50, globalY: 100 })
    const oldToken = /markInput\("([a-f0-9-]+)"/.exec(h.mark.mock.calls[0][0])![1]
    await host.update({ ...document, revision: 2 }); finishMark(true); await Promise.resolve()
    h.execute.mockResolvedValueOnce(JSON.stringify({ requests: [{ id: 1, inputToken: oldToken, event: { name: 'done', data: {}, revision: 2, origin: 'app', untrustedData: true, grantsPermission: false } }], dropped: 0 }))
    await vi.advanceTimersByTimeAsync(50); expect(receive).not.toHaveBeenCalled(); expect(h.settle.mock.calls.at(-1)![0]).toContain('expired or revoked'); host.close()
  })
  it('rechecks input revocation between two callbacks in a single drained batch', async () => {
    const receive = vi.fn(() => h.windows[0].emit('blur')), host = await openIsolatedHtmlHost(document, { onEvent: receive, onClosed: vi.fn() })
    h.windows[0].webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 100, y: 100, globalX: 100, globalY: 100 })
    const token = /markInput\("([a-f0-9-]+)"/.exec(h.mark.mock.calls[0][0])![1]
    const event = { name: 'done', data: {}, revision: 1, origin: 'app', untrustedData: true, grantsPermission: false }
    h.execute.mockResolvedValueOnce(JSON.stringify({ requests: [{ id: 1, inputToken: token, event }, { id: 2, inputToken: token, event }], dropped: 0 }))
    await vi.advanceTimersByTimeAsync(50); expect(receive).toHaveBeenCalledOnce(); expect(h.settle.mock.calls.at(-1)![0]).toContain('expired or revoked'); host.close()
  })
  it('updates a fixed OS palette without reloading and releases theme listeners on close', async () => {
    const host = await openIsolatedHtmlHost(document, { onEvent: vi.fn(), onClosed: vi.fn() })
    expect(h.theme.listenerCount('updated')).toBe(1)
    h.theme.shouldUseDarkColors = true; h.theme.emit('updated')
    await vi.advanceTimersByTimeAsync(50); expect(h.setTheme.mock.calls[0][0]).toContain('"scheme":"dark"'); expect(h.load).toHaveBeenCalledOnce()
    host.close(); expect(h.theme.listenerCount('updated')).toBe(0)
  })
  it('crashes an unresponsive current renderer and clears retained documents on close', async () => {
    h.execute.mockImplementationOnce(() => new Promise(() => undefined))
    const closed = vi.fn(), host = await openIsolatedHtmlHost(document, { hidden: true, onEvent: vi.fn(), onClosed: closed })
    await vi.advanceTimersByTimeAsync(2050)
    expect(host.closed).toBe(true); expect(closed).toHaveBeenCalledWith('unresponsive'); expect(h.windows[0].webContents.forcefullyCrashRenderer).toHaveBeenCalledOnce()
    expect(h.sessions[0].protocol.unhandle).toHaveBeenCalledWith('https')
    expect(h.sessions[0].clearStorageData).toHaveBeenCalledOnce()
  })
})
