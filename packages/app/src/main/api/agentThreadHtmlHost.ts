import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, nativeTheme, session, type Session } from 'electron'
import { buildIsolatedHtmlShell, htmlTheme, HTML_INTERACTION_MS, scriptJson, validateHtmlHostDocument } from './agentThreadHtmlDocument'
export { buildIsolatedHtmlShell, validateHtmlHostDocument } from './agentThreadHtmlDocument'
export type HtmlAppDocument = { title: string; html: string; data?: Record<string, unknown>; state?: Record<string, unknown>; revision: number }
export type HtmlAppState = { revision: number; stateRevision: number; value: Record<string, unknown> }
export type HtmlAppEvent = { name: string; data: unknown; revision: number; origin: 'app'; untrustedData: true; grantsPermission: false }
export type HtmlAppHost = { update(document: HtmlAppDocument): Promise<void>; captureState(): Promise<HtmlAppState>; close(): void; readonly closed: boolean }

export async function openIsolatedHtmlHost(document: HtmlAppDocument, options: {
  onState?(state: HtmlAppState): void
  onEvent(event: HtmlAppEvent): void; onClosed(reason: 'closed' | 'failed' | 'unresponsive' | 'expired'): void
  /** Main/test-only visibility; never accepted in model arguments. */
  hidden?: boolean; lifetimeMs?: number
}): Promise<HtmlAppHost> {
  validateHtmlHostDocument(document)
  if (app.commandLine.hasSwitch('no-sandbox') || app.commandLine.hasSwitch('disable-web-security')) throw new Error('HTML apps require Electron security controls.')
  const lifetime = options.lifetimeMs ?? 15 * 60 * 1000
  if (!Number.isSafeInteger(lifetime) || lifetime < 1000 || lifetime > 15 * 60 * 1000) throw new Error('Invalid HTML host lifetime.')
  await app.whenReady()
  const partition = `magicpot-html-${randomUUID()}`, isolated: Session = session.fromPartition(partition, { cache: false })
  if (isolated.getPreloadScripts().length) throw new Error('HTML session unexpectedly contains preload scripts.')
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.setDevicePermissionHandler(() => false)
  // Fixed rejecting proxy covers RTC TCP; child startup also denies external DNS.
  const denyProxy = createServer(socket => socket.destroy())
  denyProxy.maxConnections = 8
  await new Promise<void>((resolve, reject) => { denyProxy.once('error', reject); denyProxy.listen(0, '127.0.0.1', resolve) })
  try { await isolated.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${(denyProxy.address() as { port: number }).port}`, proxyBypassRules: '<-loopback>' }) }
  catch (error) { denyProxy.close(); throw error }
  let hostUrl = '', hostHtml = '', ownerWebContentsId = -1
  let window: BrowserWindow | undefined, removeTheme = () => undefined as void
  try {
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.webContentsId !== ownerWebContentsId || details.resourceType !== 'mainFrame' || details.url !== hostUrl }))
    isolated.protocol.handle('https', (request) => request.url === hostUrl ? new Response(hostHtml, { headers: { 'Connection-Allowlist': '();webrtc=block', 'X-DNS-Prefetch-Control': 'off', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=()', 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } }) : new Response('Blocked', { status: 403 }))
    isolated.on('will-download', (event) => event.preventDefault())
    isolated.protocol.handle('file', () => new Response('Blocked', { status: 403 }))
    window = new BrowserWindow({ title: 'MagicPot · untrusted HTML app', width: 900, height: 680, show: false, autoHideMenuBar: true, fullscreenable: false,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, devTools: false, backgroundThrottling: false, safeDialogs: true, disableDialogs: true, spellcheck: false }
    })
    const ownedWindow = window, contents = ownedWindow.webContents
    ownerWebContentsId = contents.id
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-frame-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('page-title-updated', (event) => event.preventDefault())
    let closed = false, revision = document.revision, bridge = '', loading = false, frozen = false, reportedDrops = 0, stateRevision = 0, poll: ReturnType<typeof setTimeout> | undefined
    const inputIntervals = new Map<string, number>()
    let inputCalls = 0, appliedTheme = nativeTheme.shouldUseDarkColors
    const activeInputSurface = () => !closed && !loading && !ownedWindow.isDestroyed() && ownedWindow.isVisible() && ownedWindow.isFocused()
    const revokeInput = () => {
      inputIntervals.clear()
      if (closed || loading || !bridge) return
      void contents.executeJavaScript(`window[${scriptJson(bridge)}]?.revokeInput()`, false).catch(() => undefined)
    }
    ownedWindow.on('blur', revokeInput); ownedWindow.on('hide', revokeInput)
    const noteInput = (keyboard: boolean) => {
      if (!activeInputSurface() || inputCalls >= 4) return
      const now = performance.now()
      for (const [token, at] of inputIntervals) if (now - at > HTML_INTERACTION_MS) inputIntervals.delete(token)
      if (inputIntervals.size >= 32) inputIntervals.delete(inputIntervals.keys().next().value!)
      const token = randomUUID(), ownedBridge = bridge
      inputIntervals.set(token, now); inputCalls++
      // Record in the trusted shell before admitting subsequent frame messages.
      // This proves receipt in an interval, NOT that app code was caused by input.
      void contents.executeJavaScript(`window[${scriptJson(ownedBridge)}]?.markInput(${scriptJson(token)},${keyboard})`, false)
        .then(accepted => { if (accepted !== true) inputIntervals.delete(token) })
        .catch(() => inputIntervals.delete(token)).finally(() => { inputCalls-- })
    }
    contents.on('before-mouse-event', (_event, input) => {
      // OOPIF events carry frame-local x/y. Screen coordinates are compared with
      // native content bounds instead, never a model-supplied iframe rectangle.
      const bounds = ownedWindow.getContentBounds()
      if (['mouseDown', 'mouseUp'].includes(input.type) && Number.isFinite(input.globalX) && Number.isFinite(input.globalY) && input.globalX! >= bounds.x && input.globalX! < bounds.x + bounds.width && input.globalY! >= bounds.y + 42 && input.globalY! < bounds.y + bounds.height) noteInput(false)
    })
    contents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown' && !input.isAutoRepeat) noteInput(true) })
    const close = (reason: 'closed' | 'failed' | 'unresponsive' | 'expired') => {
      if (closed) return
      closed = true; inputIntervals.clear(); clearTimeout(poll); clearTimeout(expiry); removeTheme()
      if (!ownedWindow.isDestroyed()) { if (reason === 'unresponsive' && !contents.isDestroyed()) contents.forcefullyCrashRenderer(); ownedWindow.destroy() }
      hostHtml = ''; hostUrl = ''
      isolated.protocol.unhandle('https'); isolated.protocol.unhandle('file'); denyProxy.close()
      void isolated.clearStorageData().catch(() => undefined)
      try { options.onClosed(reason) } catch { /* Cannot undo disposal. */ }
    }
    const expiry = setTimeout(() => close('expired'), lifetime)
    ownedWindow.on('closed', () => close('closed')); ownedWindow.on('unresponsive', () => close('unresponsive'))
    contents.on('render-process-gone', () => close('failed'))
    const bounded = async <T>(promise: Promise<T>, ms: number, current = () => true): Promise<T> => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => { if (current()) close('unresponsive'); reject(new Error('HTML renderer did not respond.')) }, ms) })]) }
      finally { clearTimeout(timeout); promise.catch(() => undefined) }
    }
    // OS theme is only a fixed palette; no model CSS or app credentials cross here.
    let themeDirty = false
    const themeChanged = () => { themeDirty = true }
    nativeTheme.on('updated', themeChanged); removeTheme = () => { nativeTheme.removeListener('updated', themeChanged) }
    const drain = async () => {
      if (closed || loading) return
      const ownedBridge = bridge, ownedRevision = revision
      const current = () => !closed && !loading && ownedBridge === bridge && ownedRevision === revision
      try {
        if (themeDirty || appliedTheme !== nativeTheme.shouldUseDarkColors) {
          appliedTheme = nativeTheme.shouldUseDarkColors; themeDirty = false
          await bounded(contents.executeJavaScript(`window[${scriptJson(ownedBridge)}].setTheme(${scriptJson(htmlTheme(appliedTheme))})`, false), 2000, current)
          if (!current()) return
        }
        const raw: unknown = await bounded(contents.executeJavaScript(`window[${scriptJson(ownedBridge)}].drain()`, false), 2000, current)
        if (!current()) return
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 128 * 1024) throw new Error('HTML bridge response exceeded limit.')
        const data = JSON.parse(raw)
        if (!Array.isArray(data.requests) || data.requests.length > 2 || !Number.isSafeInteger(data.dropped) || data.dropped < 0) throw new Error('Invalid HTML bridge reply.')
        if (data.state !== undefined) {
          const state = data.state
          if (!state || state.revision !== revision || !Number.isSafeInteger(state.stateRevision) || state.stateRevision < 1 || !state.value || typeof state.value !== 'object' || Array.isArray(state.value)) throw new Error('Invalid HTML state reply.')
          const value = cloneBoundedMcpJson(state.value, 65536) as Record<string, unknown>
          if (state.stateRevision > stateRevision) { stateRevision = state.stateRevision; options.onState?.({ revision, stateRevision, value }) }
          if (!current()) return
        }
        if (data.dropped > reportedDrops) { reportedDrops = data.dropped; options.onEvent({ name: '__overflow__', data: { dropped: reportedDrops, source: 'renderer' }, revision, origin: 'app', untrustedData: true, grantsPermission: false }) }
        const receipts: Array<{ id: number; error?: string }> = []
        for (const request of data.requests) {
          if (!current()) break
          const event = request?.event
          if (!Number.isSafeInteger(request?.id) || request.id < 1 || typeof request.inputToken !== 'string' || !event || event.revision !== revision || event.origin !== 'app' || event.untrustedData !== true || event.grantsPermission !== false || typeof event.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(event.name) || Buffer.byteLength(JSON.stringify(event)) > 16384) throw new Error('Invalid HTML app event.')
          const inputAt = inputIntervals.get(request.inputToken)
          const diagnostic = event.name === '__error__'
          if (!diagnostic && (event.name.startsWith('__') || inputAt === undefined || !activeInputSurface() || performance.now() - inputAt > HTML_INTERACTION_MS)) { receipts.push({ id: request.id, error: 'App input expired or revoked' }); continue }
          options.onEvent(event)
          receipts.push({ id: request.id })
        }
        if (current() && receipts.length) await bounded(contents.executeJavaScript(`window[${scriptJson(ownedBridge)}].settle(${scriptJson(receipts)})`, false), 2000, current)
      } catch { if (current()) close('failed') }
      finally { if (current()) poll = setTimeout(() => void drain(), 250) }
    }
    const update = async (next: HtmlAppDocument) => {
      validateHtmlHostDocument(next)
      if (closed || loading && !frozen || next.revision < revision) throw new Error('HTML app is closed, busy or stale.')
      loading = true; frozen = false; stateRevision = 0; inputIntervals.clear(); reportedDrops = 0; clearTimeout(poll); bridge = randomUUID(); revision = next.revision
      try {
        hostUrl = `https://magicpot-html.invalid/${bridge}`
        appliedTheme = nativeTheme.shouldUseDarkColors
        hostHtml = buildIsolatedHtmlShell(next, bridge, appliedTheme)
        await bounded(ownedWindow.loadURL(hostUrl), 8000)
        if (closed) throw new Error('HTML app closed while loading.')
        ownedWindow.setTitle('MagicPot · untrusted HTML app')
        if (!options.hidden) ownedWindow.showInactive()
      } catch (error) { close('failed'); throw error }
      finally { loading = false; if (!closed) poll = setTimeout(() => void drain(), 50) }
    }
    const captureState = async (): Promise<HtmlAppState> => {
      if (closed || loading) throw new Error('HTML app is closed or busy during state capture.')
      // Freeze state and supersede any pending drain before taking its last value.
      loading = true; inputIntervals.clear(); clearTimeout(poll)
      const ownedBridge = bridge, ownedRevision = revision
      const current = () => !closed && bridge === ownedBridge && revision === ownedRevision
      try {
        const raw: unknown = await bounded(contents.executeJavaScript(`window[${scriptJson(ownedBridge)}].freezeState()`, false), 2000, current)
        if (!current() || typeof raw !== 'string' || Buffer.byteLength(raw) > 73728) throw new Error('HTML state capture is unavailable.')
        const state = JSON.parse(raw)
        if (!state || state.revision !== ownedRevision || !Number.isSafeInteger(state.stateRevision) || state.stateRevision < 0 || !state.value || typeof state.value !== 'object' || Array.isArray(state.value)) throw new Error('Invalid HTML captured state.')
        frozen = true
        return { revision: ownedRevision, stateRevision: state.stateRevision, value: cloneBoundedMcpJson(state.value, 65536) as Record<string, unknown> }
      } catch (error) { if (current()) close('failed'); throw error }
      // Deliberately remain frozen/loading until close or an explicit document update.
    }
    try { await update(document) } catch (error) { close('failed'); throw error }
    return { update, captureState, close: () => close('closed'), get closed() { return closed } }
  } catch (error) {
    removeTheme()
    if (window && !window.isDestroyed()) window.destroy()
    hostHtml = ''; hostUrl = ''; denyProxy.close()
    isolated.protocol.unhandle('https'); isolated.protocol.unhandle('file')
    void isolated.clearStorageData().catch(() => undefined)
    throw error
  }
}
