;(() => {
  const HOST = 'figma'
  const EXECUTION_ADAPTER_VERSION = 'figma-native-1'
  const keys = (value, required, optional = []) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  const hex = (value, size) =>
    typeof value === 'string' && value.length === size && !/[^a-f0-9]/.test(value)
  const readExecutionLineage = (intent) => {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null
    const requestId = intent.requestId
    const runId = intent.runId
    const correlationId = intent.correlationId
    const lineageCount = [requestId, runId, correlationId].filter(
      (field) => field !== undefined
    ).length
    if (lineageCount !== 0 && lineageCount !== 3) return null
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' ||
        !bounded(requestId, 80) ||
        !/^[A-Za-z0-9_-]{1,80}$(?![\s\S])/.test(requestId))
    )
      return null
    if (runId !== undefined && !hex(runId, 32)) return null
    if (correlationId !== undefined && !hex(correlationId, 32)) return null
    return Object.freeze({
      ...(requestId === undefined ? {} : { requestId }),
      ...(runId === undefined ? {} : { runId }),
      ...(correlationId === undefined ? {} : { correlationId })
    })
  }
  const executionLineageMatches = (expected, actual) =>
    expected?.requestId === actual?.requestId &&
    expected?.runId === actual?.runId &&
    expected?.correlationId === actual?.correlationId
  const integer = (value) => Number.isSafeInteger(value) && value >= 0
  const bytes = (text) => {
    let size = 0
    for (const char of text) {
      const point = char.codePointAt(0)
      size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    }
    return size
  }
  const bounded = (text, limit) =>
    typeof text === 'string' && text.length <= limit && bytes(text) <= limit
  const safeLabel = (value, limit = 120) =>
    typeof value === 'string'
      ? value
          .slice(0, limit)
          .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      : ''
  const exactText = (value, limit) =>
    typeof value === 'string' && value.length <= limit && bytes(value) <= limit ? value : null
  const input = globalThis.MAGICPOT_BRIDGE_CONFIG
  const validConfig =
    keys(input, ['protocol', 'origin', 'pluginId', 'host']) &&
    Object.isFrozen(input) &&
    input.protocol === 1 &&
    input.host === HOST &&
    typeof input.origin === 'string' &&
    /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{3,4}$(?![\s\S])/.test(input.origin) &&
    Number(input.origin.slice(input.origin.lastIndexOf(':') + 1)) >= 1024 &&
    Number(input.origin.slice(input.origin.lastIndexOf(':') + 1)) <= 65535 &&
    typeof input.pluginId === 'string' &&
    input.pluginId.length <= 128 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$(?![\s\S])/.test(input.pluginId)
  const config = validConfig
    ? Object.freeze({ protocol: 1, origin: input.origin, pluginId: input.pluginId, host: HOST })
    : null
  let session = null
  let connectionProbe = null
  let pairing = false
  let readinessPending = false
  let snapshot = null
  let planningSnapshot = null
  let planningNodes = null
  let planningContextImage = null
  let planningImageBinding = null
  let pendingContextImage = null
  let planningImageObserver = null
  let recoveryDocumentRoot = null
  let review = null
  let generationReview = null
  let planReview = null
  let activeExecution = null
  let sequence = 0
  let epoch = 0
  let disposed = false
  let pollTimer = null
  let planPollTimer = null
  let generationPollTimer = null
  let expiryTimer = null
  let snapshotReader = null
  let snapshotInstanceEpoch = null
  let sessionAssetCatalog = null
  let sessionAssetCatalogBinding = null
  let sessionAssetTask = null
  let sessionAssetTimer = null
  let label = config
    ? 'Paste a desktop pairing ticket to connect.'
    : 'Bridge configuration is invalid.'
  const operations = new Set()
  const routes = Object.freeze({
    pair: '/figplugin/v1/pair',
    readiness: '/figplugin/v1/readiness',
    prepare: '/figplugin/v1/prepare',
    status: '/figplugin/v1/status',
    cancel: '/figplugin/v1/cancel',
    close: '/figplugin/v1/close',
    planStatus: '/figplugin/v1/plan/status',
    planCorrectionPrepare: '/figplugin/v1/plan/correction/prepare',
    taskRecoveryPrepare: '/figplugin/v1/plan/recovery/prepare',
    planClaim: '/figplugin/v1/plan/claim',
    planProgress: '/figplugin/v1/plan/progress',
    planResult: '/figplugin/v1/plan/result',
    planAssetsRead: '/figplugin/v1/plan/assets/read',
    planPixelAudit: '/figplugin/v1/plan/pixel-audit',
    assetsList: '/figplugin/v1/assets/list',
    assetsRead: '/figplugin/v1/assets/read',
    generationPrepare: '/figplugin/v1/image-generation/prepare',
    generationStatus: '/figplugin/v1/image-generation/status',
    generationCancel: '/figplugin/v1/image-generation/cancel'
  })
  const emit = (message) => {
    if (disposed) return
    try {
      figma.ui.postMessage({ protocol: 1, ...message })
    } catch {}
  }
  function captureReadOnlySnapshot(instanceEpoch, requestId) {
    const failure = (code) => ({ ok: false, error: { code } })
    let result
    try {
      if (snapshotInstanceEpoch !== null && snapshotInstanceEpoch !== instanceEpoch) {
        result = failure('INSTANCE_EPOCH_MISMATCH')
      } else {
        snapshotInstanceEpoch = instanceEpoch
        const helper = globalThis.MagicPotSelectionSnapshotV1
        if (!snapshotReader && (!helper || typeof helper.createFigmaReader !== 'function')) {
          result = failure('SNAPSHOT_UNAVAILABLE')
        } else {
          if (!snapshotReader) snapshotReader = helper.createFigmaReader({ figma, instanceEpoch })
          const captured = snapshotReader.capture()
          if (keys(captured, ['ok', 'snapshot']) && captured.ok === true) result = captured
          else if (
            keys(captured, ['ok', 'error']) &&
            captured.ok === false &&
            keys(captured.error, ['code']) &&
            typeof captured.error.code === 'string' &&
            /^[A-Z][A-Z0-9_]{0,63}$(?![\s\S])/.test(captured.error.code)
          ) {
            result = failure(captured.error.code)
          } else result = failure('SNAPSHOT_FAILED')
        }
      }
    } catch {
      result = failure('SNAPSHOT_FAILED')
    }
    // This result is local only and never becomes the consent-bound share context.
    emit({ type: 'read-only-snapshot', instanceEpoch, requestId, result })
  }
  const state = (text = label) => {
    if (sessionAssetTask && sessionAssetTask.epoch !== epoch) clearSessionAssets()
    label = text
    emit({
      type: 'state',
      label,
      paired: session !== null,
      busy:
        pairing ||
        review !== null ||
        generationReview !== null ||
        planReview !== null ||
        activeExecution !== null ||
        pendingContextImage !== null
    })
  }
  const clearView = () => {
    emit({ type: 'preview', text: '', revision: '' })
    emit({ type: 'content', text: '' })
  }
  function clearPlanningContextImage() {
    if (planningImageObserver) {
      try {
        planningImageObserver.page.off('nodechange', planningImageObserver.callback)
      } catch {}
      try {
        figma.off('stylechange', planningImageObserver.callback)
      } catch {}
      planningImageObserver = null
    }
    planningContextImage = null
    planningImageBinding = null
    pendingContextImage = null
  }
  function invalidatePlanningContextImage(text) {
    if (!planningContextImage && !pendingContextImage && !planningImageObserver) return
    clearPlanningContextImage()
    snapshot = null
    planningSnapshot = null
    planningNodes = null
    clearView()
    if (text) state(text)
  }
  function observePlanningContextImage(binding) {
    // dynamic-page cannot observe documentchange without loading every page.
    const page = binding.page
    if (
      !page ||
      typeof page.on !== 'function' ||
      typeof page.off !== 'function' ||
      typeof figma.on !== 'function' ||
      typeof figma.off !== 'function'
    )
      throw new Error('CONTEXT_IMAGE_OBSERVER_UNAVAILABLE')
    const callback = () => {
      if (pendingContextImage === binding || planningImageBinding === binding)
        invalidatePlanningContextImage(
          'Document content changed. Recapture the context image before sharing.'
        )
    }
    page.on('nodechange', callback)
    try {
      figma.on('stylechange', callback)
    } catch {
      try {
        page.off('nodechange', callback)
      } catch {}
      throw new Error('CONTEXT_IMAGE_OBSERVER_UNAVAILABLE')
    }
    planningImageObserver = { page, callback }
  }
  const stop = () => {
    clearSessionAssets()
    if (connectionProbe) {
      connectionProbe.cancel()
      connectionProbe = null
    }
    epoch += 1
    clearTimeout(pollTimer)
    pollTimer = null
    clearTimeout(planPollTimer)
    planPollTimer = null
    clearTimeout(generationPollTimer)
    generationPollTimer = null
    for (const cancel of Array.from(operations)) cancel()
  }
  // No stream API is assumed: native Figma fetch supplies text(). The desktop also bounds bodies.
  async function post(route, body, auth = null, signal = null) {
    if (!config || !Object.prototype.hasOwnProperty.call(routes, route)) throw new Error('REQUEST')
    const serialized = JSON.stringify(body)
    if (!bounded(serialized, 64 * 1024)) throw new Error('REQUEST')
    const url = config.origin + routes[route]
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const headers = { 'Content-Type': 'application/json' }
    if (auth) {
      headers.Authorization = 'Bearer ' + auth.sessionToken
      headers['X-Figplugin-Session'] = auth.sessionId
    }
    const options = {
      method: 'POST',
      headers,
      body: serialized,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store'
    }
    if (controller) options.signal = controller.signal
    let active = true
    let timer
    let cancel
    const deadline = Date.now() + 15000
    const stopped = new Promise((_, reject) => {
      cancel = () => {
        active = false
        reject(new Error('REQUEST'))
        if (controller) {
          try {
            controller.abort()
          } catch {}
        }
      }
      timer = setTimeout(cancel, 15000)
      operations.add(cancel)
    })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const work = (async () => {
      if (!active) throw new Error('REQUEST')
      const response = await fetch(url, options)
      if (!active || Date.now() >= deadline) throw new Error('REQUEST')
      if (response.status === 401 || response.status === 410) throw new Error('SESSION')
      if (!response.ok || response.redirected === true || (response.url && response.url !== url))
        throw new Error('REQUEST')
      const length =
        response.headers &&
        (typeof response.headers.get === 'function'
          ? response.headers.get('content-length')
          : response.headers['content-length'] || response.headers['Content-Length'])
      if (
        length != null &&
        (!/^[0-9]+$(?![\s\S])/.test(String(length)) || Number(length) > 128 * 1024)
      )
        throw new Error('REQUEST')
      if (route === 'cancel' || route === 'close' || route === 'generationCancel') {
        if (response.status !== 204) throw new Error('REQUEST')
        return null
      }
      const text = await response.text()
      if (!active || Date.now() >= deadline || !bounded(text, 128 * 1024))
        throw new Error('REQUEST')
      return JSON.parse(text)
    })()
    try {
      const result = await Promise.race([work, stopped])
      if (!active || Date.now() >= deadline) throw new Error('REQUEST')
      return result
    } finally {
      active = false
      clearTimeout(timer)
      operations.delete(cancel)
      signal?.removeEventListener('abort', cancel)
    }
  }
  function clearSessionAssets(
    announce = true,
    text = 'Local desktop image preview cleared.',
    preserveCatalog = false
  ) {
    clearTimeout(sessionAssetTimer)
    sessionAssetTimer = null
    const task = sessionAssetTask
    sessionAssetTask = null
    if (task) {
      task.cancel()
      task.data?.fill(0)
      task.data = null
    }
    if (!preserveCatalog) {
      sessionAssetCatalog = null
      sessionAssetCatalogBinding = null
    }
    if (announce) emit({ type: 'session-assets-clear', text })
  }
  function newSessionAssetTask(nonce, asset = null) {
    const listeners = new Set()
    const signal = {
      aborted: false,
      addEventListener: (_event, callback) => listeners.add(callback),
      removeEventListener: (_event, callback) => listeners.delete(callback)
    }
    const task = {
      nonce,
      asset,
      epoch,
      auth: session,
      signal,
      data: null,
      nextIndex: 0,
      cancel() {
        signal.aborted = true
        for (const callback of listeners) callback()
        listeners.clear()
      }
    }
    sessionAssetTask = task
    return task
  }
  function currentSessionAsset(task) {
    return (
      !disposed &&
      sessionAssetTask === task &&
      task.epoch === epoch &&
      session === task.auth &&
      !task.signal.aborted &&
      (!task.asset || Date.now() < task.asset.expiresAt) &&
      live()
    )
  }
  function sessionAssetIdentity(auth, projectId = auth.projectId) {
    return {
      sessionId: auth.sessionId,
      pluginId: config.pluginId,
      host: HOST,
      ...(projectId === undefined ? {} : { projectId })
    }
  }
  function armSessionAssetExpiry() {
    clearTimeout(sessionAssetTimer)
    if (sessionAssetCatalog?.assets.length)
      sessionAssetTimer = setTimeout(
        () => clearSessionAssets(true, 'Desktop image catalog expired. Refresh explicitly.'),
        Math.max(
          0,
          Math.min(...sessionAssetCatalog.assets.map((asset) => asset.expiresAt)) - Date.now()
        )
      )
  }
  async function refreshSessionAssets(nonce) {
    if (disposed || pairing || activeExecution || !live()) return
    clearSessionAssets(false)
    const task = newSessionAssetTask(nonce)
    try {
      const helper = globalThis.MagicPotPlanPreviewV1
      if (!helper || typeof helper.validateSessionAssetCatalog !== 'function')
        throw new Error('ASSET_UNAVAILABLE')
      const raw = await post(
        'assetsList',
        { protocol: 1, purpose: 'local-preview' },
        task.auth,
        task.signal
      )
      if (!currentSessionAsset(task)) return
      const catalog = helper.validateSessionAssetCatalog(raw, sessionAssetIdentity(task.auth))
      if (catalog.assets.length) task.auth.projectId = catalog.assets[0].projectId
      sessionAssetCatalog = catalog
      sessionAssetCatalogBinding = { auth: task.auth, projectId: catalog.assets[0]?.projectId }
      touch(task.auth)
      emit({ type: 'session-assets-catalog', nonce, catalog })
      armSessionAssetExpiry()
    } catch {
      if (sessionAssetTask === task)
        clearSessionAssets(true, 'Desktop image catalog unavailable or revoked. Refresh to retry.')
    }
  }
  async function previewSessionAsset(message) {
    if (disposed || pairing || activeExecution || !live()) return
    const catalog = sessionAssetCatalog
    const asset = catalog?.assets.find(
      (value) => value.assetId === message.assetId && value.sha256 === message.sha256
    )
    if (!asset) return
    clearSessionAssets(false, 'Local desktop image preview cleared.', true)
    const task = newSessionAssetTask(message.nonce, asset)
    armSessionAssetExpiry()
    try {
      const helper = globalThis.MagicPotPlanPreviewV1
      const visual = globalThis.MagicPotVisualEvidenceV1
      if (!helper || !visual || typeof visual.sha256SessionAsset !== 'function')
        throw new Error('ASSET_UNAVAILABLE')
      task.data = await helper.readSessionAsset(asset, {
        identity: sessionAssetIdentity(task.auth),
        readChunk: (request) => post('assetsRead', request, task.auth, task.signal),
        sha256: visual.sha256SessionAsset,
        signal: task.signal,
        isCurrent: () => currentSessionAsset(task),
        deadline: Math.min(task.auth.expiresAt, asset.expiresAt, Date.now() + 30000)
      })
      if (!currentSessionAsset(task)) {
        task.data.fill(0)
        task.data = null
        return
      }
      touch(task.auth)
      armSessionAssetExpiry()
      emit({ type: 'session-asset-start', nonce: task.nonce, asset })
    } catch {
      if (sessionAssetTask === task)
        clearSessionAssets(
          true,
          'Desktop image failed integrity, expired or was revoked. Nothing applied.'
        )
    }
  }
  function sendSessionAssetChunk(message) {
    const task = sessionAssetTask
    if (
      !task ||
      task.nonce !== message.nonce ||
      !task.asset ||
      !task.data ||
      !currentSessionAsset(task) ||
      message.index !== task.nextIndex
    )
      return
    const index = task.nextIndex++
    const start = index * task.asset.chunkSize
    // UI pulls one <=24 KiB byte slice at a time, never an 8 MiB postMessage.
    emit({
      type: 'session-asset-bytes',
      nonce: task.nonce,
      index,
      data: Array.from(task.data.subarray(start, start + task.asset.chunkSize))
    })
    if (task.nextIndex === task.asset.chunkCount) {
      task.data.fill(0)
      task.data = null
    }
  }
  function forget(sendClose, text, disposing = false) {
    globalThis.MagicPotPixelAuditV1?.clear()
    const old = session
    stop()
    clearTimeout(expiryTimer)
    expiryTimer = null
    session = null
    pairing = false
    readinessPending = false
    snapshot = null
    planningSnapshot = null
    planningNodes = null
    clearPlanningContextImage()
    review = null
    generationReview = null
    planReview = null
    sequence = 0
    clearView()
    state(text)
    generationState('Session closed. No image was shared or applied.')
    disposed = disposing
    if (disposing) snapshotReader = null
    // One attempt; never await unload, persist credentials, or retry an uncertain result.
    if (sendClose && old) void post('close', { protocol: 1 }, old).catch(() => {})
  }
  function armExpiry() {
    clearTimeout(expiryTimer)
    if (session)
      expiryTimer = setTimeout(
        () => forget(false, 'Session expired. Pair again.'),
        Math.max(0, Math.min(session.expiresAt, session.idleAt) - Date.now())
      )
  }
  function live() {
    if (session && Math.min(session.expiresAt, session.idleAt) <= Date.now())
      forget(false, 'Session expired. Pair again.')
    return session !== null
  }
  function touch(auth) {
    if (session === auth) {
      auth.idleAt = Date.now() + 120000
      armExpiry()
    }
  }
  function failed(error, text) {
    if (error && error.message === 'SESSION')
      forget(false, 'Session expired or unauthorized. Pair again.')
    else state(text)
  }
  const readinessState = (value) =>
    value === 'ready' || value === 'not-ready' || value === 'unknown'
  const readinessCode = (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[a-z][a-z0-9-]*$(?![\s\S])/.test(value)
  const readinessCheck = (value) =>
    keys(value, ['state', 'code']) && readinessState(value.state) && readinessCode(value.code)
  function readinessOf(value) {
    if (
      !keys(value, [
        'protocol',
        'kind',
        'checkedAt',
        'bridge',
        'configuration',
        'provider',
        'resources',
        'host'
      ]) ||
      value.protocol !== 1 ||
      value.kind !== 'figplugin-bridge-readiness' ||
      !integer(value.checkedAt) ||
      !readinessCheck(value.bridge) ||
      !readinessCheck(value.configuration) ||
      !readinessCheck(value.provider) ||
      !readinessCheck(value.resources) ||
      !keys(value.host, ['state', 'code', 'host', 'capabilities']) ||
      !readinessCheck({ state: value.host.state, code: value.host.code }) ||
      value.host.host !== HOST ||
      !readinessCheck(value.host.capabilities)
    )
      return null
    return value
  }
  function emitReadiness(pending, value, error) {
    if (pending) emit({ type: 'readiness', pending: true })
    else if (value) emit({ type: 'readiness', pending: false, value })
    else emit({ type: 'readiness', pending: false, error: error || 'request-failed' })
  }
  const readinessObservation = (state, code) => ({ state, code })
  function hostReadinessProbe() {
    // Metadata-only checks: do not include node IDs, names, text, or document data.
    let document = readinessObservation('not-ready', 'document-api-unavailable')
    let fonts = readinessObservation('not-ready', 'fonts-api-unavailable')
    let visual = readinessObservation('not-ready', 'visual-api-unavailable')
    try {
      const page = figma && figma.currentPage
      const selection = page && page.selection
      document =
        figma && page && Array.isArray(selection)
          ? readinessObservation('ready', 'document-open')
          : readinessObservation('not-ready', 'document-unavailable')
      fonts =
        figma &&
        Object.prototype.hasOwnProperty.call(figma, 'loadFontAsync') &&
        typeof figma.loadFontAsync === 'function'
          ? readinessObservation('ready', 'fonts-api-available')
          : readinessObservation('not-ready', 'fonts-api-unavailable')
      const helper = globalThis.MagicPotVisualEvidenceV1
      const hasSelection = Array.isArray(selection) && selection.length > 0
      const visualApi =
        helper &&
        typeof helper.captureFigmaNode === 'function' &&
        typeof helper.combine === 'function' &&
        hasSelection &&
        selection.every(
          (node) =>
            node &&
            typeof node.exportAsync === 'function' &&
            typeof node.width === 'number' &&
            Number.isFinite(node.width) &&
            node.width > 0 &&
            typeof node.height === 'number' &&
            Number.isFinite(node.height) &&
            node.height > 0
        )
      visual = visualApi
        ? readinessObservation('ready', 'visual-api-available')
        : hasSelection
          ? readinessObservation('not-ready', 'visual-api-unavailable')
          : readinessObservation('unknown', 'visual-selection-empty')
    } catch {
      document = readinessObservation('not-ready', 'document-probe-failed')
      fonts = readinessObservation('not-ready', 'fonts-probe-failed')
      visual = readinessObservation('not-ready', 'visual-probe-failed')
    }
    return {
      hostProbe: {
        host: HOST,
        adapterVersion: EXECUTION_ADAPTER_VERSION,
        supports: [
          'node.rename',
          'node.opacity',
          'node.visibility',
          'text.content',
          'layout.flow',
          ...(imageFillApiAvailable() ? ['image.fill'] : [])
        ],
        rollback: 'verified-in-place',
        visualAudit: visual.state === 'ready' ? 'hash-only' : 'unavailable',
        document,
        resources: { fonts, visual }
      }
    }
  }
  async function checkReadiness() {
    if (!config || disposed || !session || pairing || readinessPending) return
    const auth = session
    const own = epoch
    readinessPending = true
    emitReadiness(true)
    try {
      const value = readinessOf(
        await post('readiness', { protocol: 1, ...hostReadinessProbe() }, auth)
      )
      if (!value) throw new Error('REQUEST')
      if (disposed || own !== epoch || session !== auth) return
      touch(auth)
      emitReadiness(false, value)
    } catch (error) {
      if (disposed || own !== epoch || session !== auth) return
      if (error && error.message === 'SESSION') {
        emitReadiness(false, null, 'session-expired')
        forget(false, 'Session expired or unauthorized. Pair again.')
      } else emitReadiness(false, null, 'request-failed')
    } finally {
      if (session === auth) readinessPending = false
      if (!disposed && session === auth) state()
    }
  }
  function ticketOf(text) {
    if (!bounded(text, 4096)) throw new Error('TICKET')
    const ticket = JSON.parse(text)
    if (
      !keys(ticket, [
        'ticketId',
        'pairingSecret',
        'expiresAt',
        'bridgeOrigin',
        'pluginId',
        'host',
        'artifactSha256'
      ]) ||
      !hex(ticket.ticketId, 32) ||
      !hex(ticket.pairingSecret, 64) ||
      !hex(ticket.artifactSha256, 64) ||
      !integer(ticket.expiresAt) ||
      ticket.expiresAt <= Date.now() ||
      ticket.bridgeOrigin !== config.origin ||
      ticket.pluginId !== config.pluginId ||
      ticket.host !== HOST
    )
      throw new Error('TICKET')
    return ticket
  }
  async function checkConnection(challenge) {
    if (
      !config ||
      disposed ||
      connectionProbe ||
      pairing ||
      session ||
      review ||
      planReview ||
      activeExecution
    )
      return
    const helper = globalThis.MagicPotBridgeReadinessV1
    if (
      !helper ||
      typeof helper.startFigPluginBridgeProbe !== 'function' ||
      typeof helper.bridgeProbeMessage !== 'function'
    ) {
      emit({
        type: 'connection-check',
        nonce: challenge,
        text: '连接检查模块缺失，请更新插件。 / Connection helper missing; update the plugin.'
      })
      return
    }
    const own = epoch
    const probe = helper.startFigPluginBridgeProbe(config.origin, challenge)
    connectionProbe = probe
    try {
      const code = await probe.result
      if (!disposed && own === epoch && connectionProbe === probe)
        emit({ type: 'connection-check', nonce: challenge, text: helper.bridgeProbeMessage(code) })
    } finally {
      if (connectionProbe === probe) connectionProbe = null
    }
  }
  async function pair(message) {
    if (connectionProbe || pairing || session || review) return
    let ticket
    try {
      ticket = ticketOf(message.ticket)
    } catch {
      state('Pairing ticket is invalid or expired.')
      return
    }
    invalidatePlanningContextImage()
    clearSessionAssets()
    pairing = true
    const own = ++epoch
    state('Pairing with desktop...')
    try {
      const result = await post('pair', {
        protocol: 1,
        ticketId: ticket.ticketId,
        pairingSecret: ticket.pairingSecret,
        pluginId: config.pluginId,
        host: HOST,
        artifactSha256: ticket.artifactSha256,
        clientNonce: message.nonce
      })
      if (own !== epoch || disposed) return
      if (
        !keys(result, ['protocol', 'sessionId', 'sessionToken', 'expiresAt', 'idleTimeoutMs']) ||
        result.protocol !== 1 ||
        !hex(result.sessionId, 32) ||
        !hex(result.sessionToken, 64) ||
        !integer(result.expiresAt) ||
        result.expiresAt <= Date.now() ||
        result.idleTimeoutMs !== 120000
      )
        throw new Error('REQUEST')
      session = {
        sessionId: result.sessionId,
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
        idleAt: Date.now() + 120000
      }
      sequence = 0
      armExpiry()
      state('Paired. Capture selection, review it, then explicitly share.')
    } catch {
      if (own === epoch && !disposed) state('Pairing failed. Obtain a new desktop ticket.')
    } finally {
      ticket = null
      if (own === epoch && !disposed) {
        pairing = false
        state()
      }
    }
  }
  function cancelReview(preserveSessionAssets = false) {
    if (generationReview) {
      cancelImageGeneration()
      return
    }
    if (!preserveSessionAssets) clearSessionAssets()
    invalidatePlanningContextImage('Local context image cleared. Capture again before sharing.')
    if (connectionProbe) {
      stop()
      state()
      return
    }
    if (activeExecution) {
      const item = activeExecution
      stop()
      state('Execution cancellation requested. Waiting for the native operation to stop safely.')
      void post('cancel', { protocol: 1, callId: item.callId }, item.auth).catch(() => {})
      return
    }
    if (!review && planReview) {
      const old = planReview
      clearTimeout(planPollTimer)
      planPollTimer = null
      planReview = null
      state('Plan cancelled locally; desktop cancellation requested.')
      const own = epoch
      void post('cancel', { protocol: 1, callId: old.callId }, old.auth)
        .then(() => {
          if (own === epoch && !disposed) {
            touch(old.auth)
            state('Plan cancelled.')
          }
        })
        .catch(() => {
          if (own === epoch && !disposed)
            state('Plan cancellation could not be confirmed. Check desktop.')
        })
      return
    }
    if (!review) return
    const old = review
    if (!old.callId) {
      // An in-flight prepare has no cancellable ID yet. Closing the session covers that race.
      forget(true, 'Session closed to cancel the pending request. Pair again.')
      return
    }
    stop()
    review = null
    emit({ type: 'content', text: '' })
    state('Review cancelled locally; desktop cancellation requested.')
    const own = epoch
    void post('cancel', { protocol: 1, callId: old.callId }, old.auth)
      .then(() => {
        if (own === epoch && !disposed) {
          touch(old.auth)
          state('Review cancelled.')
        }
      })
      .catch((error) => {
        if (own === epoch && !disposed)
          failed(error, 'Cancellation could not be confirmed. Check desktop; no retry was sent.')
      })
  }
  function capture(revision) {
    if (activeExecution || generationReview) return
    if (pairing || activeExecution) return
    cancelReview(true)
    snapshot = null
    planningSnapshot = null
    clearView()
    try {
      const selection = figma.currentPage.selection
      const nodes = []
      const ids = new Set()
      for (let index = 0; index < Math.min(selection.length, 100); index += 1) {
        const node = selection[index]
        const item = {
          id: safeLabel(node.id, 128),
          type: safeLabel(node.type, 64),
          name: safeLabel(node.name),
          locked: node.locked === true
        }
        if (!item.id || !item.type || ids.has(item.id)) throw new Error('CONTEXT')
        ids.add(item.id)
        const geometry = {}
        for (const key of ['x', 'y', 'width', 'height', 'rotation']) geometry[key] = node[key]
        if (
          Object.values(geometry).every(
            (value) =>
              typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000000
          )
        )
          item.geometry = geometry
        nodes.push(item)
      }
      const context = { selectionRevision: revision, nodes }
      if (!bounded(JSON.stringify(context), 48 * 1024)) throw new Error('CONTEXT')
      snapshot = context
      emit({ type: 'preview', text: JSON.stringify(context, null, 2), revision })
      state(
        selection.length > 100
          ? 'Captured first 100 selected items. Review the exact metadata below.'
          : 'Selection captured. Review the exact metadata below.'
      )
    } catch {
      state('Selection capture failed. Capture again before sharing.')
    }
  }
  function readAppearance(node) {
    const helper = globalThis.MagicPotPlanPreviewV1
    if (!helper || typeof helper.figmaAppearance !== 'function') throw new Error('SNAPSHOT')
    try {
      return helper.figmaAppearance(
        node.fills,
        node.strokes,
        figma.root.documentColorProfile,
        figma.mixed
      )
    } catch {
      return { status: 'unavailable' }
    }
  }
  const imageFillTypes = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'FRAME']
  const imagePaintTypes = [
    'SOLID',
    'IMAGE',
    'GRADIENT_LINEAR',
    'GRADIENT_RADIAL',
    'GRADIENT_ANGULAR',
    'GRADIENT_DIAMOND'
  ]
  function imageFillApiAvailable() {
    try {
      const helper = globalThis.MagicPotVisualEvidenceV1
      return (
        typeof helper?.encodeUtf8 === 'function' &&
        typeof helper?.sha256SessionAsset === 'function' &&
        'createImage' in figma &&
        'getImageByHash' in figma &&
        typeof figma.createImage === 'function' &&
        typeof figma.getImageByHash === 'function'
      )
    } catch {
      return false
    }
  }
  function fillImagesAvailable(paints) {
    return paints.every(
      (paint) =>
        paint.type !== 'IMAGE' ||
        paint.imageHash === null ||
        (validNativeImageHash(paint.imageHash) &&
          figma.getImageByHash(paint.imageHash)?.hash === paint.imageHash)
    )
  }
  function nativeFills(node) {
    if (
      !imageFillApiAvailable() ||
      !imageFillTypes.includes(node.type) ||
      (node.fillStyleId !== undefined && node.fillStyleId !== '')
    )
      throw new Error('IMAGE_FILL_UNAVAILABLE')
    let ancestor = node.parent
    let depth = 0
    while (ancestor && ancestor !== figma.currentPage) {
      if (++depth > 32 || ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(ancestor.type))
        throw new Error('IMAGE_FILL_UNAVAILABLE')
      ancestor = ancestor.parent
    }
    if (ancestor !== figma.currentPage) throw new Error('IMAGE_FILL_UNAVAILABLE')
    const fills = node.fills
    if (!Array.isArray(fills) || fills.length > 32) throw new Error('IMAGE_FILL_UNAVAILABLE')
    let count = 0
    const clone = (value, depth = 0) => {
      if (++count > 4096 || depth > 8) throw new Error('IMAGE_FILL_UNAVAILABLE')
      if (value === null || typeof value === 'boolean') return value
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && bounded(value, 32768)) return value
      if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length)
        throw new Error('IMAGE_FILL_UNAVAILABLE')
      if (Array.isArray(value)) {
        if (value.length > 128) throw new Error('IMAGE_FILL_UNAVAILABLE')
        const output = []
        for (let index = 0; index < value.length; index++)
          output.push(clone(value[index], depth + 1))
        return output
      }
      const fields = Object.keys(value).sort()
      if (
        fields.length > 64 ||
        fields.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))
      )
        throw new Error('IMAGE_FILL_UNAVAILABLE')
      const output = {}
      for (const key of fields) {
        const field = Object.getOwnPropertyDescriptor(value, key)
        if (!field || !Object.prototype.hasOwnProperty.call(field, 'value'))
          throw new Error('IMAGE_FILL_UNAVAILABLE')
        output[key] = clone(field.value, depth + 1)
      }
      return output
    }
    const paints = clone(fills)
    if (
      paints.some((paint) => {
        if (!paint || !imagePaintTypes.includes(paint.type)) return true
        const fields =
          paint.type === 'SOLID'
            ? ['color']
            : paint.type === 'IMAGE'
              ? ['imageHash', 'scaleMode', 'imageTransform', 'scalingFactor', 'rotation', 'filters']
              : ['gradientTransform', 'gradientStops']
        return (
          !keys(
            paint,
            ['type'],
            [...fields, 'visible', 'opacity', 'blendMode', 'boundVariables']
          ) ||
          (paint.boundVariables !== undefined && !keys(paint.boundVariables, []))
        )
      })
    )
      throw new Error('IMAGE_FILL_UNAVAILABLE')
    if (!fillImagesAvailable(paints)) throw new Error('IMAGE_FILL_UNAVAILABLE')
    const serialized = JSON.stringify(paints)
    if (!bounded(serialized, 32768)) throw new Error('IMAGE_FILL_UNAVAILABLE')
    const helper = globalThis.MagicPotVisualEvidenceV1
    const data = helper.encodeUtf8(serialized)
    try {
      return { paints, fingerprint: helper.sha256SessionAsset(data) }
    } finally {
      data.fill(0)
    }
  }
  function imageFillSnapshot(node) {
    try {
      return { status: 'available', fingerprint: nativeFills(node).fingerprint }
    } catch {
      return { status: 'unavailable' }
    }
  }
  function approvedImagePaint(paints, nativeImageHash, scaleMode) {
    if (paints.length !== 1) return false
    const paint = paints[0]
    if (
      !keys(
        paint,
        ['type', 'imageHash', 'scaleMode'],
        [
          'visible',
          'opacity',
          'blendMode',
          'rotation',
          'filters',
          'imageTransform',
          'scalingFactor',
          'boundVariables'
        ]
      ) ||
      paint.type !== 'IMAGE' ||
      paint.imageHash !== nativeImageHash ||
      paint.scaleMode !== scaleMode ||
      (paint.boundVariables !== undefined && !keys(paint.boundVariables, [])) ||
      (paint.visible !== undefined && paint.visible !== true) ||
      (paint.opacity !== undefined && paint.opacity !== 1) ||
      (paint.blendMode !== undefined && paint.blendMode !== 'NORMAL') ||
      (paint.rotation !== undefined && paint.rotation !== 0) ||
      (paint.scalingFactor !== undefined && paint.scalingFactor !== 1) ||
      (paint.imageTransform !== undefined &&
        !samePlanValue(paint.imageTransform, [
          [1, 0, 0],
          [0, 1, 0]
        ]))
    )
      return false
    return (
      paint.filters === undefined ||
      (keys(
        paint.filters,
        [],
        ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows']
      ) &&
        Object.values(paint.filters).every((value) => value === 0))
    )
  }
  function readSpatial(node) {
    const helper = globalThis.MagicPotPlanPreviewV1
    if (!helper || typeof helper.spatialBounds !== 'function') throw new Error('SNAPSHOT')
    try {
      const bounds = node.absoluteBoundingBox
      if (!bounds) return { status: 'unavailable' }
      return helper.spatialBounds('page', bounds.x, bounds.y, bounds.width, bounds.height)
    } catch {
      return { status: 'unavailable' }
    }
  }
  function readTypography(node) {
    const helper = globalThis.MagicPotPlanPreviewV1
    if (!helper || typeof helper.figmaTypography !== 'function') throw new Error('SNAPSHOT')
    try {
      const text = exactText(node.characters, 4096)
      if (text === null) return { status: 'unavailable' }
      const segments = text.length
        ? node.getStyledTextSegments(['fontName', 'fontSize'], 0, text.length)
        : [{ start: 0, end: 0, fontName: node.fontName, fontSize: node.fontSize }]
      return helper.figmaTypography(text, node.hasMissingFont, segments)
    } catch {
      return { status: 'unavailable' }
    }
  }
  function captureFigmaHostContext(captureId, selectionOverride = null) {
    const root = figma.root
    if (
      !hex(snapshotInstanceEpoch, 32) ||
      (recoveryDocumentRoot !== null && recoveryDocumentRoot !== root)
    )
      throw new Error('CONTEXT')
    recoveryDocumentRoot = root
    const page = figma.currentPage
    const selection = selectionOverride || page.selection
    if (
      !root ||
      !page ||
      root.type !== 'DOCUMENT' ||
      page.type !== 'PAGE' ||
      page.parent !== root ||
      !selection ||
      typeof selection.length !== 'number' ||
      selection.length < 1 ||
      selection.length > 100
    )
      throw new Error('CONTEXT')
    const documentId = exactText(root.id, 128)
    const scopeId = exactText(page.id, 128)
    if (!documentId || !scopeId || documentId === scopeId) throw new Error('CONTEXT')
    const records = new Map()
    const selectedIds = []
    const pending = []
    const idOf = (node) => {
      const value = exactText(node && node.id, 128)
      if (!value) throw new Error('CONTEXT')
      return value
    }
    const ancestorsOf = (node) => {
      const result = []
      let current = node.parent
      let depth = 0
      while (current) {
        if (depth++ >= 32) throw new Error('CONTEXT')
        const id = idOf(current)
        const type = exactText(current.type, 128)
        if (!id || !type) throw new Error('CONTEXT')
        result.push({
          id,
          type,
          locked: current === page ? false : current.locked === true
        })
        if (current === page) break
        current = current.parent
      }
      if (current !== page) throw new Error('CONTEXT')
      return result
    }
    const readLayout = (node) => {
      const direction = node.layoutMode
      if (!['NONE', 'HORIZONTAL', 'VERTICAL'].includes(direction)) return null
      const values = [
        node.itemSpacing,
        node.paddingTop,
        node.paddingRight,
        node.paddingBottom,
        node.paddingLeft
      ]
      if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null
      return {
        direction,
        gap: node.itemSpacing,
        padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
      }
    }
    const visit = (node, selected) => {
      const id = idOf(node)
      if (records.has(id)) {
        if (selected) throw new Error('CONTEXT')
        return id
      }
      if (records.size >= 100) throw new Error('CONTEXT')
      const type = exactText(node.type, 128)
      const name = exactText(node.name, 4096)
      if (!type || name === null || typeof node.visible !== 'boolean') throw new Error('CONTEXT')
      if (typeof node.locked !== 'boolean' || !node.parent) throw new Error('CONTEXT')
      const ancestors = ancestorsOf(node)
      const effectiveLocked = node.locked || ancestors.some((ancestor) => ancestor.locked)
      const parentId = ancestors[0]?.id ?? null
      const typography = type === 'TEXT' ? readTypography(node) : undefined
      const imageFill = imageFillTypes.includes(type) ? imageFillSnapshot(node) : undefined
      const fontKey = typography && globalThis.MagicPotPlanPreviewV1.typographyFontKey(typography)
      const commands = []
      let layout = null
      let text
      if (selected && !effectiveLocked) {
        commands.push('node.rename', 'node.visibility')
        if (typeof node.opacity === 'number' && Number.isFinite(node.opacity))
          commands.push('node.opacity')
        if (type === 'TEXT' && exactText(node.characters, 4096) !== null) {
          text = node.characters
          if (
            typography?.status === 'available' &&
            typography.hasMissingFont === false &&
            typeof figma.loadFontAsync === 'function'
          )
            commands.push('text.content')
        }
        layout = readLayout(node)
        if (layout) commands.push('layout.flow')
        if (imageFill?.status === 'available') commands.push('image.fill')
      }
      const record = {
        id,
        type,
        name,
        parentId,
        ancestors,
        locked: node.locked,
        visible: node.visible,
        spatial: readSpatial(node),
        appearance: readAppearance(node),
        ...(imageFill ? { imageFill } : {}),
        ...(typography ? { typography } : {}),
        ...(fontKey === undefined ? {} : { fontKey }),
        ...(typeof node.opacity === 'number' && Number.isFinite(node.opacity)
          ? { opacity: Math.max(0, Math.min(1, node.opacity)) }
          : {}),
        commands,
        ...(text === undefined ? {} : { text }),
        ...(layout ? { layout } : {})
      }
      records.set(id, { node, record })
      if (selected) {
        selectedIds.push(id)
        if (commands.includes('layout.flow')) pending.push(node)
      }
      return id
    }
    for (let index = 0; index < selection.length; index += 1) visit(selection[index], true)
    while (pending.length) {
      const parent = pending.shift()
      const parentRecord = records.get(idOf(parent)).record
      const children = parent.children
      if (!children || typeof children.length !== 'number') throw new Error('CONTEXT')
      const childIds = []
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]
        const childId = visit(child, false)
        childIds.push(childId)
        pending.push(child)
      }
      parentRecord.children = childIds
    }
    const nodes = Array.from(records.values(), (entry) => entry.record)
    const visualHelper = globalThis.MagicPotVisualEvidenceV1
    const canCaptureVisualEvidence =
      visualHelper &&
      typeof visualHelper.captureFigmaNode === 'function' &&
      typeof visualHelper.combine === 'function' &&
      selectedIds.every((id) => {
        const node = records.get(id)?.node
        return (
          node &&
          typeof node.exportAsync === 'function' &&
          typeof node.width === 'number' &&
          Number.isFinite(node.width) &&
          node.width > 0 &&
          typeof node.height === 'number' &&
          Number.isFinite(node.height) &&
          node.height > 0
        )
      })
    const context = {
      version: 1,
      host: HOST,
      documentId,
      scopeId,
      captureId,
      recoveryIdentity: snapshotInstanceEpoch,
      nodes,
      selectedIds,
      execution: {
        mode: 'native-write',
        adapterVersion: EXECUTION_ADAPTER_VERSION,
        supports: [
          'node.rename',
          'node.opacity',
          'node.visibility',
          'text.content',
          'layout.flow',
          ...(nodes.some((node) => node.commands.includes('image.fill')) ? ['image.fill'] : [])
        ],
        rollback: 'verified-in-place',
        visualAudit: canCaptureVisualEvidence ? 'hash-only' : 'unavailable'
      }
    }
    const planner = globalThis.MagicPotPlanPreviewV1
    if (!planner || typeof planner.validateHostContext !== 'function') throw new Error('SNAPSHOT')
    return {
      context: planner.validateHostContext(JSON.parse(JSON.stringify(context))),
      nodes: new Map(Array.from(records, ([id, entry]) => [id, entry.node]))
    }
  }
  const exactIdArray = (value) =>
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 20 &&
    value.every((item) => exactText(item, 160) === item) &&
    new Set(value).size === value.length &&
    value.every((item, index) => item === [...value].sort()[index])
  const sameIds = (left, right) =>
    exactIdArray(left) &&
    exactIdArray(right) &&
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  function validateCorrectionAuthorization(value, item) {
    if (
      !keys(value, [
        'protocol',
        'authorizationId',
        'baselineId',
        'sourceExecutionId',
        'pluginId',
        'host',
        'projectId',
        'documentId',
        'scopeId',
        'captureId',
        'adapterVersion',
        'baselineEvidenceSha256',
        'visualEvidenceSha256',
        'comparisonSha256',
        'visualTargetIds',
        'authorizedTargetIds',
        'round',
        'maxCorrectionRounds',
        'authorizedAt',
        'expiresAt',
        'state'
      ]) ||
      value.protocol !== 1 ||
      !hex(value.authorizationId, 32) ||
      !hex(value.baselineId, 32) ||
      value.baselineId !== item.baselineId ||
      value.baselineEvidenceSha256 !== item.baselineEvidenceSha256 ||
      value.visualEvidenceSha256 !== item.visualEvidenceSha256 ||
      value.sourceExecutionId !== item.sourceExecutionId ||
      value.pluginId !== config.pluginId ||
      value.host !== HOST ||
      exactText(value.projectId, 160) !== value.projectId ||
      value.documentId !== item.sourceHostContext.documentId ||
      value.scopeId !== item.sourceHostContext.scopeId ||
      value.captureId !== item.sourceHostContext.captureId ||
      value.adapterVersion !== EXECUTION_ADAPTER_VERSION ||
      !hex(value.baselineEvidenceSha256, 64) ||
      !hex(value.visualEvidenceSha256, 64) ||
      !hex(value.comparisonSha256, 64) ||
      !exactIdArray(value.visualTargetIds) ||
      !exactIdArray(value.authorizedTargetIds) ||
      !sameIds(value.visualTargetIds, item.visualTargetIds) ||
      !sameIds(value.authorizedTargetIds, item.authorizedTargetIds) ||
      value.authorizedTargetIds.some((targetId) => !value.visualTargetIds.includes(targetId)) ||
      !Number.isInteger(value.round) ||
      value.round < 1 ||
      value.round > 3 ||
      value.maxCorrectionRounds !== 3 ||
      !integer(value.authorizedAt) ||
      !integer(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt <= value.authorizedAt ||
      value.state !== 'authorized'
    )
      throw new Error('REQUEST')
    return value
  }
  function captureFigmaCorrectionContext(authorization) {
    if (typeof figma.getNodeById !== 'function') throw new Error('CONTEXT')
    const selection = authorization.visualTargetIds.map((targetId) => {
      const node = figma.getNodeById(targetId)
      if (!node || node.id !== targetId || node.removed === true) throw new Error('CONTEXT')
      return node
    })
    const captured = captureFigmaHostContext(authorization.authorizationId, selection)
    const selectedIds = [...captured.context.selectedIds].sort()
    if (
      captured.context.documentId !== authorization.documentId ||
      captured.context.scopeId !== authorization.scopeId ||
      captured.context.captureId !== authorization.authorizationId ||
      captured.context.execution.adapterVersion !== authorization.adapterVersion ||
      captured.context.execution.visualAudit !== 'hash-only' ||
      !sameIds(selectedIds, authorization.visualTargetIds)
    )
      throw new Error('CONTEXT')
    return captured
  }
  function currentContextImageCapture(binding) {
    if (
      disposed ||
      snapshotInstanceEpoch !== binding.instanceEpoch ||
      figma.root !== binding.root ||
      figma.currentPage !== binding.page ||
      binding.page.selection.length !== 1 ||
      binding.page.selection[0] !== binding.node ||
      binding.node.width !== binding.width ||
      binding.node.height !== binding.height
    )
      return false
    const fresh = captureFigmaHostContext(binding.revision)
    return (
      JSON.stringify(fresh.context) === binding.serializedContext &&
      fresh.nodes.size === binding.nodes.size &&
      Array.from(fresh.nodes).every(([id, node]) => binding.nodes.get(id) === node)
    )
  }
  async function capturePlan(revision, instanceEpoch, includeImage = false) {
    if (generationReview) return
    if (activeExecution) return
    if (pairing || disposed || !config || activeExecution) return
    if (includeImage && (review || planReview)) return
    cancelReview(true)
    snapshot = null
    planningSnapshot = null
    planningNodes = null
    clearPlanningContextImage()
    clearView()
    let pending = null
    try {
      if (snapshotInstanceEpoch !== null && snapshotInstanceEpoch !== instanceEpoch)
        throw new Error('SNAPSHOT')
      snapshotInstanceEpoch = instanceEpoch
      const planner = globalThis.MagicPotPlanPreviewV1
      if (!planner) throw new Error('SNAPSHOT')
      if (includeImage && figma.currentPage.selection.length !== 1)
        throw new Error('SINGLE_IMAGE_TARGET')
      const captured = captureFigmaHostContext(revision)
      const full = captured.context
      let image = null
      if (includeImage) {
        const helper = globalThis.MagicPotVisualEvidenceV1
        if (full.selectedIds.length !== 1) throw new Error('SINGLE_IMAGE_TARGET')
        if (!helper || typeof helper.captureFigmaContextImage !== 'function')
          throw new Error('CONTEXT_IMAGE_UNAVAILABLE')
        const node = captured.nodes.get(full.selectedIds[0])
        pending = {
          epoch,
          auth: session,
          instanceEpoch,
          revision,
          root: figma.root,
          page: figma.currentPage,
          node,
          width: node.width,
          height: node.height,
          nodes: captured.nodes,
          serializedContext: JSON.stringify(full)
        }
        pendingContextImage = pending
        observePlanningContextImage(pending)
        if (!currentContextImageCapture(pending)) throw new Error('STALE_CONTEXT_IMAGE')
        state('Capturing one selection image locally. Nothing is sent until you explicitly share.')
        image = await helper.captureFigmaContextImage(node, {
          captureId: revision,
          targetId: full.selectedIds[0]
        })
        // Export is asynchronous: native identity, full observed context and session must still match.
        if (pendingContextImage !== pending) return
        if (
          pending.epoch !== epoch ||
          pending.auth !== session ||
          !currentContextImageCapture(pending)
        )
          throw new Error('STALE_CONTEXT_IMAGE')
        planningContextImage = image
        planningImageBinding = pending
        pendingContextImage = null
      }
      planningNodes = captured.nodes
      const selected = new Set(full.selectedIds)
      snapshot = {
        selectionRevision: revision,
        nodes: full.nodes
          .filter((node) => selected.has(node.id))
          .map((node) => ({
            id: node.id,
            type: node.type,
            name: safeLabel(node.name),
            locked: node.locked || node.ancestors.some((ancestor) => ancestor.locked)
          }))
      }
      planningSnapshot = full
      emit({
        type: 'preview',
        text: planner.formatContext(full),
        revision,
        planning: true,
        ...(image ? { contextImage: image } : {})
      })
      state(
        image
          ? 'Context and exact image captured locally. Review both and consent before sharing for desktop approval.'
          : 'Native plan context captured. Model output still requires a separate desktop write approval.'
      )
    } catch (error) {
      if (pending && pendingContextImage !== pending && planningImageBinding !== pending) return
      snapshot = null
      planningSnapshot = null
      planningNodes = null
      clearPlanningContextImage()
      clearView()
      state(
        error?.message === 'SINGLE_IMAGE_TARGET'
          ? 'Image capture requires exactly one selected node. Nothing was sent or changed.'
          : error?.message === 'CONTEXT_IMAGE_OBSERVER_UNAVAILABLE'
            ? 'Native image-change observation is unavailable. Capture context without an image instead; nothing was sent.'
            : includeImage
              ? 'Image capture failed or became stale. Select one node and recapture; PNG must fit 256 px / 24 KiB. Nothing was sent.'
              : 'Planning capture failed. No content was sent and no document was changed.'
      )
    }
  }
  const planCommands = [
    'node.rename',
    'node.opacity',
    'node.visibility',
    'text.content',
    'layout.flow',
    'image.fill'
  ]
  const readNodeValue = (node, command) => {
    switch (command) {
      case 'node.rename':
        return node.name
      case 'node.opacity':
        return node.opacity
      case 'node.visibility':
        return node.visible
      case 'text.content':
        return node.type === 'TEXT' ? node.characters : undefined
      case 'layout.flow':
        return readNodeLayout(node)
      case 'image.fill':
        return { fingerprint: nativeFills(node).fingerprint }
      default:
        return undefined
    }
  }
  function readNodeLayout(node) {
    const direction = node.layoutMode
    if (!['NONE', 'HORIZONTAL', 'VERTICAL'].includes(direction)) return undefined
    const values = [
      node.itemSpacing,
      node.paddingTop,
      node.paddingRight,
      node.paddingBottom,
      node.paddingLeft
    ]
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
      return undefined
    return {
      direction,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
    }
  }
  const samePlanValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  // Keep the shared lifecycle contract at the native boundary. The lifecycle
  // callbacks below are the actual Figma prepare/write/readback path; the
  // surrounding bridge still owns the desktop receipt and visual audit.
  function createFigmaPlanLifecycle(planner, item) {
    if (
      !planner ||
      typeof planner.createHostAdapterLifecycle !== 'function' ||
      typeof planner.validateHostPlanReadback !== 'function'
    )
      throw new Error('PLAN_LIFECYCLE_UNAVAILABLE')
    const meta = {
      failureCode: null,
      journalBlocked: false,
      visualEvidence: undefined,
      // Claim is sequence 1. Keep the last step receipt so a failed plan can
      // still append its readback without skipping unexecuted steps.
      lastProgressSequence: 1
    }
    const intent = item.lifecycleIntent
    const ownedCollectionsByRun = new Map()
    function ownRunCollection(runId, collection) {
      let owned = ownedCollectionsByRun.get(runId)
      if (!owned) {
        owned = new Set()
        ownedCollectionsByRun.set(runId, owned)
      }
      owned.add(collection)
      return collection
    }
    const lifecycle = planner.createHostAdapterLifecycle({
      host: HOST,
      adapterVersion: EXECUTION_ADAPTER_VERSION,
      retainExecution: false,
      // Native descriptors must negotiate capabilities before any write.
      // Legacy shared fixtures leave this opt-in disabled for compatibility.
      requireCapabilityDiscovery: true,
      // Capability discovery is metadata-only and remains bound to the
      // context captured for this exact claim. A future lifecycle.run call
      // therefore fails closed if the host or adapter capabilities drift.
      discoverCapabilities: () => ({
        host: HOST,
        execution: item.hostContext.execution
      }),
      // The desktop has already captured and authorized this exact context.
      // A fallback capture must never observe a different selection.
      captureContext: (captureId) => {
        if (captureId !== item.hostContext.captureId) throw new Error('STALE_CONTEXT')
        return item.hostContext
      },
      prepareResources: async ({ runId, context, plan, signal, deferRelease }) => {
        if (!intent || signal.aborted) throw new Error('CANCELLED')
        assertExecutionCurrent(item)
        let checked = ownRunCollection(runId, precheckPlan(plan, context))
        let visualEntries = ownRunCollection(runId, visualEntriesForIntent(checked, item, intent))
        await prepareTextFonts(checked, item)
        if (signal.aborted) throw new Error('CANCELLED')
        assertExecutionCurrent(item)
        const imageSources = ownRunCollection(
          runId,
          await prepareImageSources(plan, item, signal, deferRelease)
        )
        checked = ownRunCollection(runId, precheckPlan(plan, context))
        visualEntries = ownRunCollection(runId, visualEntriesForIntent(checked, item, intent))
        let beforeVisual = null
        if (context.execution.visualAudit === 'hash-only') {
          beforeVisual = ownRunCollection(runId, await capturePlanVisualPoints(visualEntries))
          if (signal.aborted) throw new Error('CANCELLED')
          assertExecutionCurrent(item)
          checked = ownRunCollection(runId, precheckPlan(plan, context))
          visualEntries = ownRunCollection(runId, visualEntriesForIntent(checked, item, intent))
        }
        await checkExecutionAuthority(item)
        try {
          await reserveNativeAction(item, intent)
        } catch (error) {
          meta.journalBlocked = String(error?.message).startsWith('JOURNAL_')
          throw error
        }
        if (signal.aborted) throw new Error('CANCELLED')
        assertExecutionCurrent(item)
        checked = ownRunCollection(runId, precheckPlan(plan, context))
        const imageResources = ownRunCollection(runId, new Map())
        for (const [assetId, source] of imageSources) {
          await checkExecutionAuthority(item)
          if (signal.aborted) throw new Error('CANCELLED')
          assertExecutionCurrent(item)
          const image = figma.createImage(source.bytes)
          const nativeImageHash = image?.hash
          if (
            !validNativeImageHash(nativeImageHash) ||
            figma.getImageByHash(nativeImageHash)?.hash !== nativeImageHash
          )
            throw new Error('IMAGE_IMPORT_FAILED')
          const nativeContentSha256 = await nativeImageDigest(nativeImageHash, item, signal)
          if (signal.aborted) throw new Error('CANCELLED')
          assertExecutionCurrent(item)
          imageResources.set(assetId, {
            assetId,
            sha256: source.asset.sha256,
            nativeImageHash,
            nativeContentSha256
          })
          source.bytes.fill(0)
        }
        if (imageResources.size) await checkExecutionAuthority(item)
        if (signal.aborted) throw new Error('CANCELLED')
        assertExecutionCurrent(item)
        checked = ownRunCollection(runId, precheckPlan(plan, context))
        return {
          checked,
          visualEntries,
          beforeVisual,
          ...(imageResources.size ? { imageResources } : {}),
          applied: ownRunCollection(runId, [])
        }
      },
      execute: async ({ runId, context, plan, resources, signal, onProgress }) => {
        if (!resources || signal.aborted) throw new Error('CANCELLED')
        const applied = ownRunCollection(runId, [])
        try {
          for (let index = 0; index < resources.checked.length; index += 1) {
            const entry = resources.checked[index]
            if (signal.aborted) throw new Error('CANCELLED')
            assertExecutionCurrent(item)
            if (resources.imageResources?.size) await checkExecutionAuthority(item)
            if (signal.aborted) throw new Error('CANCELLED')
            assertExecutionCurrent(item)
            precheckPlan({ ...plan, steps: [entry.step] }, context, false)
            if (entry.step.command === 'image.fill') {
              entry.imageResource = resources.imageResources.get(entry.step.assetId)
              if (!entry.imageResource || entry.imageResource.sha256 !== entry.step.sha256)
                throw new Error('IMAGE_IMPORT_FAILED')
              // Record the attempted step before a setter can partially apply and throw.
              applied.push(entry)
              try {
                applyPlanStep(entry.node, entry.step, entry.imageResource)
              } finally {
                const actual = nativeFills(entry.node)
                if (
                  !approvedImagePaint(
                    actual.paints,
                    entry.imageResource.nativeImageHash,
                    entry.step.scaleMode
                  )
                )
                  throw new Error('IMAGE_WRITE_MISMATCH')
                entry.appliedFillsSha256 = actual.fingerprint
                item.imageWrites.set(entry.step.targetId, {
                  ...entry.imageResource,
                  scaleMode: entry.step.scaleMode,
                  fillsSha256: actual.fingerprint
                })
              }
            } else applyPlanStep(entry.node, entry.step)
            if (entry.step.command === 'text.content') {
              entry.appliedTypography = readTypography(entry.node)
              entry.appliedAppearance = readAppearance(entry.node)
            }
            if (entry.step.command !== 'image.fill') applied.push(entry)
            const completed = index + 1
            onProgress?.(completed, resources.checked.length)
            await postPlanProgress(
              item,
              2 + index,
              'executing',
              index,
              completed,
              resources.checked.length,
              completed === resources.checked.length ? 'applied' : 'partial'
            )
            meta.lastProgressSequence = 2 + index
            assertExecutionCurrent(item)
            if (resources.imageResources?.size) await checkExecutionAuthority(item)
          }
          return { ...resources, applied }
        } catch (error) {
          if (item.imageExecution && !signal.aborted && executionCurrent(item)) {
            try {
              await checkExecutionAuthority(item)
            } catch {}
          }
          for (const entry of applied.reverse()) {
            try {
              if (Date.now() >= item.expiresAt) throw new Error('EXPIRED')
              if (
                entry.step.command === 'image.fill' &&
                (signal.aborted || !executionCurrent(item))
              )
                throw new Error('CANCELLED')
              rollbackPlanStep(
                entry.node,
                entry.contextNode,
                entry.step,
                entry.appliedTypography,
                entry.appliedAppearance,
                entry
              )
            } catch {}
          }
          if (signal.aborted || !executionCurrent(item) || String(error?.message) === 'CANCELLED')
            throw new Error('CANCELLED')
          meta.failureCode = 'ROLLED_BACK'
          throw new Error('EXECUTE_FAILED')
        }
      },
      readback: async ({ runId, context, plan, execution, signal }) => {
        if (signal.aborted) throw new Error('CANCELLED')
        assertExecutionCurrent(item)
        await verifyImageResources(item, signal)
        if (signal.aborted) throw new Error('CANCELLED')
        assertExecutionCurrent(item)
        let readback = createPlanReadback(context, plan, item)
        const observations = readback.steps.map((step) => step.observation)
        if (
          observations.every((value) => value === 'requested') &&
          context.execution.visualAudit === 'hash-only'
        ) {
          try {
            const afterVisual = ownRunCollection(
              runId,
              await capturePlanVisualPoints(execution.visualEntries)
            )
            if (signal.aborted) throw new Error('CANCELLED')
            assertExecutionCurrent(item)
            for (const entry of execution.checked) verifyNativeNode(entry.contextNode)
            await verifyImageResources(item, signal)
            if (signal.aborted) throw new Error('CANCELLED')
            assertExecutionCurrent(item)
            readback = createPlanReadback(context, plan, item)
            if (readback.steps.some((step) => step.observation !== 'requested'))
              throw new Error('STALE_CONTEXT')
            meta.visualEvidence = combinePlanVisualEvidence(
              execution.visualEntries,
              execution.beforeVisual,
              afterVisual
            )
          } catch (error) {
            if (String(error?.message) === 'CANCELLED') throw error
            if (item.imageExecution && !signal.aborted && executionCurrent(item)) {
              try {
                await checkExecutionAuthority(item)
              } catch {}
            }
            for (const entry of [...execution.applied].reverse()) {
              try {
                if (Date.now() >= item.expiresAt) throw new Error('EXPIRED')
                if (
                  entry.step.command === 'image.fill' &&
                  (signal.aborted || !executionCurrent(item))
                )
                  throw new Error('CANCELLED')
                rollbackPlanStep(
                  entry.node,
                  entry.contextNode,
                  entry.step,
                  entry.appliedTypography,
                  entry.appliedAppearance,
                  entry
                )
              } catch {}
            }
            meta.visualEvidence = undefined
            meta.failureCode = 'ROLLED_BACK'
            throw new Error('READBACK_FAILED')
          }
        }
        assertExecutionCurrent(item)
        return readback
      },
      releaseResources: async ({ runId }) => {
        const owned = ownedCollectionsByRun.get(runId)
        ownedCollectionsByRun.delete(runId)
        if (!owned) return
        // Include partial preparation, but never mutate host nodes or shared pixel-cache values.
        for (const collection of owned) {
          if (Array.isArray(collection)) collection.length = 0
          else collection.clear()
        }
        owned.clear()
      },
      now: () => Date.now()
    })
    return { lifecycle, meta }
  }

  function verifyNativeNode(record) {
    if (!planningNodes) throw new Error('STALE_CONTEXT')
    const node = planningNodes.get(record.id)
    if (!node || node.id !== record.id || node.removed === true) throw new Error('STALE_CONTEXT')
    const ancestors = []
    let current = node.parent
    while (current) {
      ancestors.push(current)
      if (current === figma.currentPage) break
      current = current.parent
      if (ancestors.length > 33) throw new Error('STALE_CONTEXT')
    }
    if (
      ancestors.at(-1) !== figma.currentPage ||
      ancestors.length !== record.ancestors.length ||
      ancestors.some((ancestor, index) => {
        const expected = record.ancestors[index]
        return (
          String(ancestor.id) !== expected.id ||
          String(ancestor.type) !== expected.type ||
          (ancestor === figma.currentPage ? false : ancestor.locked === true) !== expected.locked
        )
      })
    )
      throw new Error('STALE_CONTEXT')
    if (node.locked === true || record.ancestors.some((ancestor) => ancestor.locked))
      throw new Error('LOCKED_TARGET')
    return node
  }
  function precheckPlan(plan, context, checkSpatial = true) {
    // Revalidate the complete planning observation before the first write, including
    // after async exports/authority/journal waits. Do not compare an old rectangle
    // after our own text/layout step has legitimately changed document geometry.
    if (checkSpatial)
      for (const record of context.nodes) {
        if (record.appearance !== undefined) {
          const native = planningNodes && planningNodes.get(record.id)
          if (!native || !samePlanValue(record.appearance, readAppearance(native)))
            throw new Error('STALE_CONTEXT')
        }
        if (record.typography !== undefined) {
          const native = planningNodes && planningNodes.get(record.id)
          if (!native || !samePlanValue(record.typography, readTypography(native)))
            throw new Error('STALE_CONTEXT')
        }
        if (record.imageFill?.status === 'available') {
          const native = planningNodes && planningNodes.get(record.id)
          if (!native || !samePlanValue(record.imageFill, imageFillSnapshot(native)))
            throw new Error('STALE_CONTEXT')
        }
        if (record.spatial !== undefined) {
          const native = planningNodes && planningNodes.get(record.id)
          if (!native || !samePlanValue(record.spatial, readSpatial(native)))
            throw new Error('STALE_CONTEXT')
        }
      }
    if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 20)
      throw new Error('INVALID_PLAN')
    const nodes = new Map(context.nodes.map((node) => [node.id, node]))
    const selected = new Set(context.selectedIds)
    const checked = []
    for (const step of plan.steps) {
      if (
        !step ||
        !selected.has(step.targetId) ||
        !planCommands.includes(step.command) ||
        !context.execution.supports.includes(step.command)
      )
        throw new Error('UNSUPPORTED_COMMAND')
      const contextNode = nodes.get(step.targetId)
      if (!contextNode || !contextNode.commands.includes(step.command))
        throw new Error('UNSUPPORTED_COMMAND')
      const node = verifyNativeNode(contextNode)
      if (
        step.command === 'image.fill' &&
        (!Array.isArray(figma.currentPage.selection) || !figma.currentPage.selection.includes(node))
      )
        throw new Error('STALE_CONTEXT')
      if (
        step.command === 'text.content' &&
        (!contextNode.typography || !samePlanValue(contextNode.typography, readTypography(node)))
      )
        throw new Error('STALE_CONTEXT')
      if (
        step.command === 'text.content' &&
        contextNode.appearance !== undefined &&
        !samePlanValue(contextNode.appearance, readAppearance(node))
      )
        throw new Error('STALE_CONTEXT')
      const expected = readNodeValue(node, step.command)
      const baseline =
        step.command === 'node.rename'
          ? contextNode.name
          : step.command === 'node.opacity'
            ? contextNode.opacity
            : step.command === 'node.visibility'
              ? contextNode.visible
              : step.command === 'text.content'
                ? contextNode.text
                : step.command === 'image.fill'
                  ? { fingerprint: contextNode.imageFill?.fingerprint }
                  : contextNode.layout
      if (!samePlanValue(expected, baseline)) throw new Error('STALE_CONTEXT')
      checked.push({
        node,
        contextNode,
        step,
        ...(step.command === 'image.fill' ? { originalFills: nativeFills(node).paints } : {})
      })
    }
    return checked
  }
  function applyPlanStep(node, step, imageResource) {
    switch (step.command) {
      case 'node.rename':
        node.name = step.name
        break
      case 'node.opacity':
        node.opacity = step.opacity
        break
      case 'node.visibility':
        node.visible = step.visible
        break
      case 'text.content':
        if (node.type !== 'TEXT') throw new Error('UNSUPPORTED_COMMAND')
        node.characters = step.text
        break
      case 'image.fill':
        node.fills = [
          {
            type: 'IMAGE',
            imageHash: imageResource.nativeImageHash,
            scaleMode: step.scaleMode,
            visible: true,
            opacity: 1,
            blendMode: 'NORMAL'
          }
        ]
        break
      case 'layout.flow':
        node.layoutMode = step.layout.direction
        if (step.layout.direction !== 'NONE') {
          node.itemSpacing = step.layout.gap
          node.paddingTop = step.layout.padding[0]
          node.paddingRight = step.layout.padding[1]
          node.paddingBottom = step.layout.padding[2]
          node.paddingLeft = step.layout.padding[3]
        }
        break
      default:
        throw new Error('UNSUPPORTED_COMMAND')
    }
  }
  function rollbackPlanStep(node, contextNode, step, appliedTypography, appliedAppearance, entry) {
    if (step.command === 'image.fill') {
      if (
        !entry?.originalFills ||
        !entry.appliedFillsSha256 ||
        !fillImagesAvailable(entry.originalFills) ||
        verifyNativeNode(contextNode) !== node ||
        figma.getImageByHash(entry.imageResource?.nativeImageHash)?.hash !==
          entry.imageResource?.nativeImageHash ||
        nativeFills(node).fingerprint !== entry.appliedFillsSha256
      )
        throw new Error('STALE_CONTEXT')
      node.fills = entry.originalFills
      if (nativeFills(node).fingerprint !== contextNode.imageFill.fingerprint)
        throw new Error('ROLLBACK_FAILED')
      return
    }
    if (
      step.command === 'text.content' &&
      appliedAppearance !== undefined &&
      !samePlanValue(appliedAppearance, readAppearance(node))
    )
      throw new Error('STALE_CONTEXT')
    if (
      step.command === 'text.content' &&
      appliedTypography !== undefined &&
      !samePlanValue(appliedTypography, readTypography(node))
    )
      throw new Error('STALE_CONTEXT')
    // Roll back only a value still owned by this attempt. Never overwrite a later
    // user edit, a moved/replaced object, or a newly locked target.
    const requested =
      step.command === 'node.rename'
        ? step.name
        : step.command === 'node.opacity'
          ? step.opacity
          : step.command === 'node.visibility'
            ? step.visible
            : step.command === 'text.content'
              ? step.text
              : step.layout
    if (
      verifyNativeNode(contextNode) !== node ||
      !samePlanValue(readNodeValue(node, step.command), requested)
    )
      throw new Error('STALE_CONTEXT')
    switch (step.command) {
      case 'node.rename':
        node.name = contextNode.name
        break
      case 'node.opacity':
        node.opacity = contextNode.opacity
        break
      case 'node.visibility':
        node.visible = contextNode.visible
        break
      case 'text.content':
        node.characters = contextNode.text
        break
      case 'layout.flow':
        node.layoutMode = contextNode.layout.direction
        if (contextNode.layout.direction !== 'NONE') {
          node.itemSpacing = contextNode.layout.gap
          node.paddingTop = contextNode.layout.padding[0]
          node.paddingRight = contextNode.layout.padding[1]
          node.paddingBottom = contextNode.layout.padding[2]
          node.paddingLeft = contextNode.layout.padding[3]
        }
        break
    }
  }
  function createPlanReadback(context, plan, item) {
    const nodes = new Map(context.nodes.map((node) => [node.id, node]))
    const readback = {
      version: 1,
      kind: 'host-plan-readback',
      host: HOST,
      documentId: context.documentId,
      scopeId: context.scopeId,
      captureId: context.captureId,
      steps: plan.steps.map((step) => {
        const contextNode = nodes.get(step.targetId)
        const nativeNode = planningNodes && planningNodes.get(step.targetId)
        if (step.command === 'image.fill') {
          const row = { targetId: step.targetId, command: step.command, observation: 'unknown' }
          try {
            if (!contextNode || !nativeNode || verifyNativeNode(contextNode) !== nativeNode)
              return row
            const actual = nativeFills(nativeNode)
            const fact = item?.imageWrites?.get(step.targetId)
            const resource = fact && figma.getImageByHash(fact.nativeImageHash)
            if (
              fact &&
              fact.assetId === step.assetId &&
              fact.sha256 === step.sha256 &&
              fact.scaleMode === step.scaleMode &&
              actual.fingerprint === fact.fillsSha256 &&
              resource?.hash === fact.nativeImageHash &&
              approvedImagePaint(actual.paints, fact.nativeImageHash, step.scaleMode)
            ) {
              return {
                ...row,
                observation: 'requested',
                value: { assetId: step.assetId, sha256: step.sha256, scaleMode: step.scaleMode },
                imageEvidence: {
                  kind: 'figma-image-fill',
                  sourceSha256: fact.sha256,
                  nativeImageHash: fact.nativeImageHash,
                  fillsSha256: actual.fingerprint
                }
              }
            }
            return {
              ...row,
              observation:
                actual.fingerprint === contextNode.imageFill?.fingerprint ? 'original' : 'other',
              value: { fingerprint: actual.fingerprint }
            }
          } catch {
            return row
          }
        }
        const expected = contextNode
          ? step.command === 'node.rename'
            ? contextNode.name
            : step.command === 'node.opacity'
              ? contextNode.opacity
              : step.command === 'node.visibility'
                ? contextNode.visible
                : step.command === 'text.content'
                  ? contextNode.text
                  : contextNode.layout
          : undefined
        const requested =
          step.command === 'node.rename'
            ? step.name
            : step.command === 'node.opacity'
              ? step.opacity
              : step.command === 'node.visibility'
                ? step.visible
                : step.command === 'text.content'
                  ? step.text
                  : step.layout
        let value
        try {
          value = nativeNode ? readNodeValue(nativeNode, step.command) : undefined
        } catch {
          value = undefined
        }
        return {
          targetId: step.targetId,
          command: step.command,
          observation:
            value === undefined
              ? 'unknown'
              : samePlanValue(value, requested)
                ? 'requested'
                : samePlanValue(value, expected)
                  ? 'original'
                  : 'other',
          ...(value === undefined ? {} : { value })
        }
      })
    }
    const planner = globalThis.MagicPotPlanPreviewV1
    if (!planner || typeof planner.validateHostPlanReadback !== 'function')
      throw new Error('READBACK_UNAVAILABLE')
    // Validate every readback at construction time, including failure and
    // rollback paths. No result is sent to desktop before this check passes.
    return planner.validateHostPlanReadback(
      plan,
      context,
      readback,
      item?.assetMetadata,
      item?.recovery?.images
    )
  }
  const getVisualEvidenceHelper = () => {
    const helper = globalThis.MagicPotVisualEvidenceV1
    if (
      !helper ||
      typeof helper.captureFigmaNode !== 'function' ||
      typeof helper.combine !== 'function'
    )
      throw new Error('VISUAL_EVIDENCE_UNAVAILABLE')
    return helper
  }
  async function capturePlanVisualPoints(entries) {
    const helper = getVisualEvidenceHelper()
    const captured = new Map()
    for (const entry of entries) {
      if (captured.has(entry.targetId)) continue
      captured.set(entry.targetId, await helper.captureFigmaNode(entry.node))
    }
    return captured
  }
  function combinePlanVisualEvidence(entries, before, after) {
    const helper = getVisualEvidenceHelper()
    const evidence = []
    const seen = new Set()
    for (const entry of entries) {
      const targetId = entry.targetId
      if (seen.has(targetId)) continue
      seen.add(targetId)
      const beforePoint = before.get(targetId)
      const afterPoint = after.get(targetId)
      if (!beforePoint || !afterPoint) throw new Error('VISUAL_EVIDENCE_UNAVAILABLE')
      evidence.push(helper.combine(targetId, beforePoint, afterPoint))
    }
    return evidence
  }
  function visualEntriesForIntent(checked, item, intent) {
    if (intent.recovery || item.recovery) {
      const recovery = intent.recovery
      if (
        !item.recovery ||
        !recovery ||
        intent.visualCorrection ||
        intent.visualTargetIds ||
        !samePlanValue(recovery, item.recovery) ||
        recovery.requestId !== item.hostContext.captureId ||
        !sameIds(
          [...new Set(checked.map((entry) => entry.step.targetId))].sort(),
          recovery.targetIds
        ) ||
        !sameIds([...item.hostContext.selectedIds].sort(), recovery.targetIds)
      )
        throw new Error('REQUEST')
      return checked.map((entry) => ({ targetId: entry.step.targetId, node: entry.node }))
    }
    if (!intent.visualCorrection && !intent.visualTargetIds)
      return checked.map((entry) => ({ targetId: entry.step.targetId, node: entry.node }))
    const authorization = item.authorization
    const attempt = intent.visualCorrection
    if (
      !authorization ||
      !attempt ||
      !sameIds(intent.visualTargetIds, authorization.visualTargetIds) ||
      attempt.authorizationId !== authorization.authorizationId ||
      attempt.baselineId !== authorization.baselineId ||
      attempt.sourceExecutionId !== authorization.sourceExecutionId ||
      attempt.round !== authorization.round ||
      attempt.maxCorrectionRounds !== authorization.maxCorrectionRounds ||
      !sameIds(attempt.authorizedTargetIds, authorization.authorizedTargetIds) ||
      item.hostContext.captureId !== authorization.authorizationId ||
      !sameIds([...item.hostContext.selectedIds].sort(), authorization.visualTargetIds)
    )
      throw new Error('REQUEST')
    const planTargetIds = [...new Set(checked.map((entry) => entry.step.targetId))].sort()
    if (!sameIds(planTargetIds, authorization.authorizedTargetIds)) throw new Error('REQUEST')
    const contextNodes = new Map(item.hostContext.nodes.map((node) => [node.id, node]))
    return authorization.visualTargetIds.map((targetId) => {
      const contextNode = contextNodes.get(targetId)
      if (!contextNode) throw new Error('STALE_CONTEXT')
      return { targetId, node: verifyNativeNode(contextNode) }
    })
  }
  async function postPlanProgress(item, sequence, phase, index, completed, total, effect) {
    return post(
      'planProgress',
      {
        protocol: 1,
        executionId: item.executionId,
        actionId: item.actionId,
        ...item.lineage,
        sequence,
        phase,
        ...(index === undefined ? {} : { index }),
        completed,
        total,
        effect,
        at: Date.now()
      },
      item.auth
    )
  }
  const executionCurrent = (item) =>
    !disposed &&
    activeExecution === item &&
    item.executionEpoch === epoch &&
    session === item.auth &&
    Date.now() < Math.min(item.expiresAt, item.auth.expiresAt, item.auth.idleAt) &&
    item.imageAuthorityRevoked !== true
  function assertExecutionCurrent(item) {
    if (!executionCurrent(item)) throw new Error('CANCELLED')
  }
  async function checkExecutionAuthority(item, allowReadback = false) {
    assertExecutionCurrent(item)
    try {
      const status = await post(
        'planStatus',
        {
          protocol: 1,
          callId: item.callId,
          executionId: item.executionId,
          ...item.lineage
        },
        item.auth
      )
      assertExecutionCurrent(item)
      if (
        !status ||
        status.protocol !== 1 ||
        status.executionId !== item.executionId ||
        status.callId !== item.callId ||
        !executionLineageMatches(item.lineage, status) ||
        !(allowReadback ? ['claimed', 'executing', 'readback'] : ['claimed', 'executing']).includes(
          status.state
        )
      )
        throw new Error('CANCELLED')
    } catch (error) {
      if (item.imageExecution) item.imageAuthorityRevoked = true
      throw error
    }
  }
  let executionJournal = null
  async function reserveNativeAction(item, intent) {
    const helper = globalThis.MagicPotExecutionJournalV1
    if (!helper) throw new Error('JOURNAL_UNAVAILABLE')
    if (!executionJournal) executionJournal = helper.createFigma()
    await executionJournal.reserve(intent, () => assertExecutionCurrent(item))
    // Storage can yield. Desktop cancellation and native state must be checked
    // again after the durable marker, immediately before applying any step.
    await checkExecutionAuthority(item)
  }
  async function reportPixelAudit(item, result) {
    const comparison = result?.status?.visualBaselineComparison
    if (!comparison || !executionCurrent(item)) return result
    try {
      if (
        !Array.isArray(comparison.targets) ||
        !comparison.targets.length ||
        comparison.targets.length > 20
      )
        throw new Error('REQUEST')
      const helper = globalThis.MagicPotPixelAuditV1
      let targets
      try {
        targets = helper?.compare(comparison.targets)
      } catch {}
      targets ??= comparison.targets.map((target) => ({
        targetId: target.targetId,
        status: 'unavailable'
      }))
      assertExecutionCurrent(item)
      const audited = await post(
        'planPixelAudit',
        {
          protocol: 1,
          executionId: item.executionId,
          actionId: item.actionId,
          ...item.lineage,
          policy: 'rgba8-exact-v1',
          baselineId: comparison.baselineId,
          baselineEvidenceSha256: comparison.baselineEvidenceSha256,
          visualEvidenceSha256: comparison.visualEvidenceSha256,
          targets
        },
        item.auth
      )
      assertExecutionCurrent(item)
      if (
        audited?.executionId !== item.executionId ||
        audited.status?.executionId !== item.executionId ||
        audited.status.pixelAudit?.baselineId !== comparison.baselineId ||
        audited.status.pixelAudit?.visualEvidenceSha256 !== comparison.visualEvidenceSha256
      )
        throw new Error('REQUEST')
      return audited
    } catch {
      // The write receipt remains valid, but an unavailable pixel report never becomes a pass.
      return result
    }
  }
  async function prepareTextFonts(checked, item) {
    const helper = globalThis.MagicPotPlanPreviewV1
    const fonts = new Map()
    for (const entry of checked) {
      if (entry.step.command !== 'text.content') continue
      for (const font of helper.requiredFigmaFonts(entry.contextNode.typography))
        fonts.set(JSON.stringify(font), font)
    }
    if (!fonts.size) return
    if (fonts.size > 32 || typeof figma.loadFontAsync !== 'function')
      throw new Error('FONT_UNAVAILABLE')
    assertExecutionCurrent(item)
    state('Preparing approved text fonts; no document changes have been made.')
    const deadline = Math.min(item.expiresAt, Date.now() + 15000)
    let timer,
      cancel,
      stopped = false
    const interrupted = new Promise((_, reject) => {
      cancel = () => {
        stopped = true
        reject(new Error('FONT_UNAVAILABLE'))
      }
      operations.add(cancel)
      timer = setTimeout(cancel, Math.max(1, deadline - Date.now()))
    })
    const work = (async () => {
      for (const font of fonts.values()) {
        if (stopped || Date.now() >= deadline) throw new Error('FONT_UNAVAILABLE')
        assertExecutionCurrent(item)
        await figma.loadFontAsync(font)
        if (stopped || Date.now() >= deadline) throw new Error('FONT_UNAVAILABLE')
        assertExecutionCurrent(item)
      }
    })()
    try {
      await Promise.race([work, interrupted])
    } finally {
      stopped = true
      clearTimeout(timer)
      operations.delete(cancel)
    }
  }
  const validNativeImageHash = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(value)
  function validatedRecoveryImages(value) {
    const planner = globalThis.MagicPotPlanPreviewV1
    const visual = globalThis.MagicPotVisualEvidenceV1
    const images = planner.validateRecoveryExecutionImages(value)
    const bytes = visual.encodeUtf8(planner.recoveryImagesManifestContent(images.manifest))
    try {
      if (visual.sha256SessionAsset(bytes) !== images.manifest.manifestSha256)
        throw new Error('IMAGE_RECOVERY_UNBOUND')
    } finally {
      bytes.fill(0)
    }
    return images
  }
  function recoveryImageMetadata(planner, item, intent) {
    if (!intent.recovery && !item.recovery) return undefined
    if (item.recovery?.images !== undefined)
      item.recovery.images = validatedRecoveryImages(item.recovery.images)
    if (intent.recovery?.images !== undefined)
      intent.recovery.images = validatedRecoveryImages(intent.recovery.images)
    if (
      !item.recovery ||
      !intent.recovery ||
      !samePlanValue(item.recovery, intent.recovery) ||
      intent.visualCorrection ||
      intent.visualTargetIds
    )
      throw new Error('IMAGE_RECOVERY_UNBOUND')
    const steps = intent.plan.steps.filter((step) => step.command === 'image.fill')
    if (!steps.length) {
      if (item.recovery.images !== undefined || intent.executionAssets !== undefined)
        throw new Error('IMAGE_RECOVERY_UNBOUND')
      return undefined
    }
    const images = validatedRecoveryImages(item.recovery.images)
    if (
      !Array.isArray(intent.executionAssets) ||
      intent.executionAssets.length !== images.manifest.assets.length
    )
      throw new Error('IMAGE_RECOVERY_UNBOUND')
    const assets = intent.executionAssets.map((asset) =>
      planner.validateExecutionAsset(asset, sessionAssetIdentity(item.auth), Date.now())
    )
    if (
      new Set(assets.map((asset) => asset.assetId)).size !== assets.length ||
      assets.some((asset) => asset.projectId !== assets[0].projectId) ||
      images.manifest.assets.some((source) => {
        const binding = images.assetBindings.find((entry) => entry.sourceAssetId === source.assetId)
        const asset = assets.find((entry) => entry.assetId === binding?.assetId)
        return (
          !asset ||
          ['sha256', 'mimeType', 'sizeBytes', 'width', 'height'].some(
            (key) => asset[key] !== source[key]
          )
        )
      })
    )
      throw new Error('IMAGE_RECOVERY_UNBOUND')
    // This identity belongs only to the new claim, never to the local-preview catalog.
    item.assetProjectId = assets[0].projectId
    return assets.map((asset) => planner.executionAssetMetadata(asset))
  }
  async function prepareImageSources(plan, item, signal, deferRelease) {
    const sources = new Map()
    deferRelease(() => {
      for (const source of sources.values()) source.bytes.fill(0)
      sources.clear()
    })
    const steps = plan.steps.filter((step) => step.command === 'image.fill')
    if (!steps.length) return sources
    const intent = item.lifecycleIntent
    const helper = globalThis.MagicPotPlanPreviewV1
    const descriptors = intent.executionAssets
    const references = new Map(steps.map((step) => [step.assetId, step.sha256]))
    if (
      intent.visualCorrection ||
      intent.visualTargetIds ||
      !Array.isArray(descriptors) ||
      descriptors.length !== references.size ||
      descriptors.length > 4 ||
      new Set(descriptors.map((asset) => asset.assetId)).size !== descriptors.length ||
      typeof helper.readExecutionAsset !== 'function' ||
      typeof helper.executionAssetMetadata !== 'function'
    )
      throw new Error('IMAGE_ASSET_UNBOUND')
    for (const asset of descriptors) {
      const approved = item.assetMetadata?.find((metadata) => metadata.assetId === asset.assetId)
      if (
        references.get(asset.assetId) !== asset.sha256 ||
        !approved ||
        !samePlanValue(helper.executionAssetMetadata(asset), approved)
      )
        throw new Error('IMAGE_ASSET_UNBOUND')
      if (signal.aborted) throw new Error('CANCELLED')
      assertExecutionCurrent(item)
      const data = await helper.readExecutionAsset(asset, {
        identity: sessionAssetIdentity(item.auth, item.assetProjectId),
        intent,
        readChunk: (request) => post('planAssetsRead', request, item.auth, signal),
        sha256: globalThis.MagicPotVisualEvidenceV1.sha256SessionAsset,
        signal,
        isCurrent: () => executionCurrent(item),
        deadline: Math.min(item.expiresAt, asset.expiresAt, Date.now() + 30000)
      })
      sources.set(asset.assetId, { asset, bytes: data })
      if (signal.aborted) throw new Error('CANCELLED')
      assertExecutionCurrent(item)
    }
    return sources
  }
  async function nativeImageDigest(nativeImageHash, item, signal) {
    assertExecutionCurrent(item)
    const image = figma.getImageByHash(nativeImageHash)
    if (!image || image.hash !== nativeImageHash) throw new Error('IMAGE_RESOURCE_CHANGED')
    if (typeof image.getBytesAsync !== 'function') return null
    let active = true
    let timer
    let cancel
    const deadline = Math.min(item.expiresAt, Date.now() + 15000)
    const check = () => {
      if (!active || signal?.aborted || Date.now() >= deadline) throw new Error('CANCELLED')
      assertExecutionCurrent(item)
    }
    const stopped = new Promise((_, reject) => {
      cancel = () => {
        active = false
        reject(new Error('CANCELLED'))
      }
      timer = setTimeout(cancel, Math.max(1, deadline - Date.now()))
      operations.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    const work = Promise.resolve()
      .then(() => {
        check()
        return image.getBytesAsync()
      })
      .then((data) => {
        try {
          check()
          if (
            !(data instanceof Uint8Array) ||
            !data.byteLength ||
            data.byteLength > 8 * 1024 * 1024
          )
            throw new Error('IMAGE_RESOURCE_CHANGED')
          // Native encoding may differ from the approved source. Compare native reads
          // only with the native digest taken just after this claim's import.
          return globalThis.MagicPotVisualEvidenceV1.sha256SessionAsset(data)
        } finally {
          if (data instanceof Uint8Array) data.fill(0)
        }
      })
    try {
      return await Promise.race([work, stopped])
    } finally {
      active = false
      clearTimeout(timer)
      operations.delete(cancel)
      signal?.removeEventListener('abort', cancel)
    }
  }
  async function verifyImageResources(item, signal) {
    for (const [targetId, fact] of item.imageWrites ?? []) {
      try {
        const digest = await nativeImageDigest(fact.nativeImageHash, item, signal)
        if (digest !== fact.nativeContentSha256) throw new Error('IMAGE_RESOURCE_CHANGED')
      } catch (error) {
        item.imageWrites.delete(targetId)
        throw error
      }
      if (signal?.aborted || !executionCurrent(item)) {
        item.imageWrites.delete(targetId)
        throw new Error('IMAGE_RESOURCE_CHANGED')
      }
    }
  }
  async function reportPreparationFailure(item, plan, errorCode) {
    if (!executionCurrent(item)) return
    try {
      await postPlanProgress(item, 2, 'readback', 0, 0, plan.steps.length, 'none')
      assertExecutionCurrent(item)
      await post(
        'planResult',
        {
          protocol: 1,
          executionId: item.executionId,
          actionId: item.actionId,
          ...item.lineage,
          status: 'failed',
          effect: 'none',
          completed: 0,
          total: plan.steps.length,
          readback: createPlanReadback(item.hostContext, plan, item),
          errorCode
        },
        item.auth
      )
    } catch {
      /* An unconfirmed receipt never authorizes another write. */
    }
  }
  async function executeClaimedPlan(item, intent) {
    assertExecutionCurrent(item)
    const planner = globalThis.MagicPotPlanPreviewV1
    let lifecycle
    let meta
    let plan
    item.lifecycleIntent = intent
    item.imageWrites = new Map()
    item.imageExecution = intent.plan?.steps?.some((step) => step.command === 'image.fill') === true
    try {
      const recoveryAssets = recoveryImageMetadata(planner, item, intent)
      if (recoveryAssets) item.assetMetadata = recoveryAssets
      const created = createFigmaPlanLifecycle(planner, item)
      lifecycle = created.lifecycle
      meta = created.meta
      plan = lifecycle.validatePlan(
        intent.plan,
        item.hostContext,
        item.assetMetadata,
        item.recovery?.images
      )
    } catch (error) {
      delete item.lifecycleIntent
      // Desktop approval can race a host capability/context change. Report the
      // failed validation through the same readback/result path as preparation
      // failures so the Bridge releases its write reservation immediately
      // instead of leaving a claimed execution to expire silently.
      await reportPreparationFailure(
        item,
        intent.plan,
        String(error?.message) === 'STALE_CONTEXT' ? 'STALE_CONTEXT' : 'INVALID_PLAN'
      )
      state('Desktop plan validation failed. No document changes were made.')
      return
    }
    // Older plugin runtimes do not expose timer APIs (and some test hosts do
    // not expose AbortController). The lifecycle still performs its own
    // cancellation checks, so the bridge watcher is only an optional extra.
    const abort = typeof AbortController === 'function' ? new AbortController() : null
    const watcher =
      typeof setInterval === 'function' && abort
        ? setInterval(() => {
            if (!executionCurrent(item) && !abort.signal.aborted) abort.abort()
          }, 50)
        : null
    let result
    try {
      result = await lifecycle.run({
        runId: item.executionId,
        plan,
        context: item.hostContext,
        resources: item.assetMetadata,
        imageRecovery: item.recovery?.images,
        signal: abort?.signal
      })
    } catch {
      result = undefined
    } finally {
      if (watcher !== null && typeof clearInterval === 'function') clearInterval(watcher)
      delete item.lifecycleIntent
    }
    if (!result || result.status === 'cancelled' || result.error?.code === 'CANCELLED') return
    if (!executionCurrent(item)) return

    let readback
    try {
      readback = result.readback || createPlanReadback(item.hostContext, plan, item)
    } catch {
      readback = createPlanReadback(item.hostContext, plan, item)
    }
    let observations = readback.steps.map((step) => step.observation)
    let effect = observations.every((value) => value === 'requested')
      ? 'applied'
      : observations.every((value) => value === 'original')
        ? result.status === 'completed' || meta?.failureCode === 'ROLLED_BACK'
          ? 'rolled-back'
          : 'none'
        : observations.some((value) => value === 'requested')
          ? 'partial'
          : 'unknown'
    if (meta?.journalBlocked) {
      effect = 'unknown'
      meta.failureCode = 'QUARANTINED'
    }
    if (result.status !== 'completed' && effect === 'applied') effect = 'partial'
    if (meta?.visualEvidence === undefined) meta.visualEvidence = undefined
    if (!executionCurrent(item)) return
    let completed = readback.steps.filter((step) => step.observation === 'requested').length
    let status = effect === 'applied' ? 'completed' : 'failed'
    // claim uses sequence 1 and step receipts use 2..N+1; readback is N+2.
    let sequence = (meta.lastProgressSequence ?? 1) + 1
    try {
      await postPlanProgress(
        item,
        sequence++,
        'readback',
        plan.steps.length - 1,
        completed,
        plan.steps.length,
        effect
      )
      assertExecutionCurrent(item)
      if (item.imageExecution) await checkExecutionAuthority(item, true)
      await verifyImageResources(item)
      assertExecutionCurrent(item)
      const latestReadback = createPlanReadback(item.hostContext, plan, item)
      let unchanged = samePlanValue(latestReadback, readback)
      if (status === 'completed') {
        try {
          for (const record of item.hostContext.nodes)
            if (plan.steps.some((step) => step.targetId === record.id)) verifyNativeNode(record)
        } catch {
          unchanged = false
        }
      }
      if (!unchanged) {
        readback = latestReadback
        completed = readback.steps.filter((step) => step.observation === 'requested').length
        status = 'failed'
        effect = 'unknown'
        meta.visualEvidence = undefined
      }
      const errorCode =
        result.error?.code === 'STALE_CONTEXT'
          ? 'STALE_CONTEXT'
          : effect === 'rolled-back'
            ? 'ROLLED_BACK'
            : effect === 'unknown'
              ? 'QUARANTINED'
              : effect === 'partial'
                ? 'EXECUTION_FAILED'
                : result.error?.code === 'PREPARE_FAILED'
                  ? 'HOST_UNAVAILABLE'
                  : undefined
      let receipt = await post(
        'planResult',
        {
          protocol: 1,
          executionId: item.executionId,
          actionId: item.actionId,
          ...item.lineage,
          status,
          effect,
          completed,
          total: plan.steps.length,
          readback,
          ...(meta.visualEvidence ? { visualEvidence: meta.visualEvidence } : {}),
          ...(errorCode ? { errorCode } : {})
        },
        item.auth
      )
      if (!executionCurrent(item)) return
      receipt = await reportPixelAudit(item, receipt)
      if (!executionCurrent(item)) return
      if (receipt && receipt.status && receipt.status.state === 'completed') {
        if (item.recovery) {
          state(
            item.recovery.images
              ? 'Accepted image source and fill mode restored with a fresh native image import and identity readback. Other task properties were read back separately; this is not a full-document restore.'
              : 'Accepted task properties restored and read back. Check the separate visual comparison; this is not a full-document restore.'
          )
        } else if (
          !item.imageExecution &&
          receipt.status.visualBaselineComparison &&
          receipt.status.visualBaselineComparison.exactMatch === false &&
          receipt.status.pixelAudit?.outcome !== 'match'
        ) {
          beginCorrectionReview(item, receipt.status)
        } else {
          state(
            meta.visualEvidence
              ? receipt.status.visualBaselineComparison?.exactMatch === true
                ? receipt.status.pixelAudit?.outcome === 'match'
                  ? 'Approved result matches the accepted checkpoint in bounded exported pixels.'
                  : 'Export hashes match; a complete pixel audit has not been confirmed.'
                : 'Approved plan applied with bounded before/after visual checkpoints.'
              : 'Approved plan applied and verified by document readback.'
          )
        }
      } else if (effect === 'rolled-back')
        state('Plan failed. Applied values were rolled back and verified.')
      else if (meta?.journalBlocked)
        state(
          'Persistent action safety check blocked this write. It was not replayed. Verify the document and request a new approved plan.'
        )
      else state('Plan failed. Check MagicPot desktop for the execution receipt.')
    } catch {
      state('Execution result could not be confirmed. Check MagicPot desktop.')
    }
  }
  function beginPlanReview(call, content) {
    planReview = {
      kind: 'plan',
      auth: call.auth,
      callId: call.callId,
      hostContext: call.hostContext,
      assetMetadata: call.assetMetadata,
      assetProjectId: call.assetProjectId,
      expiresAt: call.expiresAt,
      polls: 0,
      display: content,
      started: false
    }
    emit({ type: 'content', text: content })
    state('Plan ready. Awaiting separate write approval in MagicPot desktop.')
    schedulePlan(planReview)
  }
  function beginCorrectionReview(source, status) {
    if (source.imageExecution) return
    const comparison = status && status.visualBaselineComparison
    const targets = comparison && Array.isArray(comparison.targets) ? comparison.targets : []
    const visualTargetIds = targets.map((target) => target && target.targetId).sort()
    const authorizedTargetIds = targets
      .filter((target) => target && target.changed === true)
      .map((target) => target.targetId)
      .sort()
    const evidenceTargetIds = Array.isArray(status && status.visualEvidence)
      ? status.visualEvidence.map((item) => item && item.targetId).sort()
      : []
    if (
      !source ||
      !source.auth ||
      !source.hostContext ||
      source.hostContext.execution?.visualAudit !== 'hash-only' ||
      !status ||
      status.state !== 'completed' ||
      status.effect !== 'applied' ||
      status.executionId !== source.executionId ||
      !comparison ||
      comparison.executionId !== status.executionId ||
      comparison.exactMatch !== false ||
      !Number.isInteger(comparison.changedCount) ||
      comparison.changedCount < 1 ||
      comparison.changedCount !== authorizedTargetIds.length ||
      !sameIds(visualTargetIds, evidenceTargetIds) ||
      !exactIdArray(authorizedTargetIds) ||
      comparison.visualEvidenceSha256 !== status.visualEvidenceSha256 ||
      Date.now() >= source.expiresAt
    ) {
      state(
        'Visual comparison could not be bound to a correction request. No correction was started.'
      )
      return
    }
    planReview = {
      kind: 'correction',
      auth: source.auth,
      callId: source.callId,
      sourceExecutionId: status.executionId,
      baselineId: comparison.baselineId,
      baselineEvidenceSha256: comparison.baselineEvidenceSha256,
      visualEvidenceSha256: status.visualEvidenceSha256,
      sourceHostContext: JSON.parse(JSON.stringify(source.hostContext)),
      visualTargetIds,
      authorizedTargetIds,
      expiresAt: source.expiresAt,
      polls: 0,
      started: false,
      authorization: null,
      hostContext: null,
      executionId: null
    }
    state(
      'Visual result differs from the accepted checkpoint. Awaiting an explicit correction authorization in MagicPot desktop.'
    )
    schedulePlan(planReview)
  }
  const currentPlan = (item) =>
    !disposed && planReview === item && live() && Date.now() < item.expiresAt
  function schedulePlan(item) {
    if (!currentPlan(item)) return
    if (item.polls >= 120) {
      clearTimeout(planPollTimer)
      planPollTimer = null
      planReview = null
      state('Plan approval or correction authorization expired, or the polling limit was reached.')
      return
    }
    planPollTimer = setTimeout(() => void pollPlan(item), 1000)
  }
  async function prepareCorrection(item) {
    if (item.kind !== 'correction' || item.executionId) return true
    let response = await post(
      'planCorrectionPrepare',
      {
        protocol: 1,
        sourceExecutionId: item.sourceExecutionId,
        ...(item.hostContext ? { hostContext: item.hostContext } : {})
      },
      item.auth
    )
    if (!currentPlan(item) || !response || response.protocol !== 1) return false
    touch(item.auth)
    if (response.status === 'pending') {
      if (!keys(response, ['protocol', 'status', 'expiresAt']) || !integer(response.expiresAt))
        throw new Error('REQUEST')
      item.expiresAt = Math.min(item.expiresAt, response.expiresAt)
      state('Awaiting an explicit correction authorization in MagicPot desktop.')
      schedulePlan(item)
      return false
    }
    if (response.status === 'authorized') {
      if (!keys(response, ['protocol', 'status', 'authorization'])) throw new Error('REQUEST')
      const authorization = validateCorrectionAuthorization(response.authorization, item)
      const captured = captureFigmaCorrectionContext(authorization)
      item.authorization = authorization
      item.hostContext = captured.context
      planningNodes = captured.nodes
      item.expiresAt = Math.min(item.expiresAt, authorization.expiresAt)
      response = await post(
        'planCorrectionPrepare',
        {
          protocol: 1,
          sourceExecutionId: item.sourceExecutionId,
          hostContext: item.hostContext
        },
        item.auth
      )
      if (!currentPlan(item) || !response || response.protocol !== 1) return false
      touch(item.auth)
    }
    if (response.status === 'terminal') {
      if (
        !keys(response, ['protocol', 'status', 'state'], ['errorCode']) ||
        typeof response.state !== 'string'
      )
        throw new Error('REQUEST')
      planReview = null
      state('Visual correction authorization ended without a document write.')
      return false
    }
    if (
      response.status !== 'prepared' ||
      !keys(response, ['protocol', 'status', 'executionId', 'callId', 'state', 'expiresAt']) ||
      !hex(response.executionId, 32) ||
      response.callId !== item.callId ||
      typeof response.state !== 'string' ||
      !integer(response.expiresAt) ||
      response.expiresAt <= Date.now() ||
      !item.authorization ||
      !item.hostContext
    )
      throw new Error('REQUEST')
    item.executionId = response.executionId
    item.expiresAt = Math.min(item.expiresAt, response.expiresAt)
    state(
      'Correction plan prepared. Awaiting a separate native write approval in MagicPot desktop.'
    )
    return true
  }
  async function pollPlan(item) {
    if (!currentPlan(item)) return
    item.polls += 1
    try {
      if (item.kind === 'correction' && !(await prepareCorrection(item))) return
      if (!currentPlan(item)) return
      const selector = {
        protocol: 1,
        callId: item.callId,
        ...(item.executionId ? { executionId: item.executionId } : {})
      }
      const status = await post('planStatus', selector, item.auth)
      if (!currentPlan(item)) return
      if (
        !status ||
        status.protocol !== 1 ||
        !hex(status.executionId, 32) ||
        typeof status.state !== 'string' ||
        (item.executionId && status.executionId !== item.executionId)
      )
        throw new Error('REQUEST')
      const statusLineage = readExecutionLineage(status)
      if (
        statusLineage === null ||
        (item.lineage && !executionLineageMatches(item.lineage, statusLineage))
      )
        throw new Error('REQUEST')
      if (!item.lineage && Object.keys(statusLineage).length > 0) item.lineage = statusLineage
      item.executionId = status.executionId
      if (status.state === 'awaiting-approval') {
        state(
          item.kind === 'correction'
            ? 'Correction plan ready. Awaiting a separate native write approval in MagicPot desktop.'
            : 'Plan ready. Awaiting separate write approval in MagicPot desktop.'
        )
        schedulePlan(item)
        return
      }
      if (status.state === 'approved') {
        const claim = await post(
          'planClaim',
          { protocol: 1, callId: item.callId, executionId: item.executionId },
          item.auth
        )
        if (!currentPlan(item)) return
        if (!claim || claim.protocol !== 1) throw new Error('REQUEST')
        if (claim.status === 'pending') {
          state(
            '等待同一文档的其他写入结束；尚未修改文档。 Waiting for another document write to finish.'
          )
          schedulePlan(item)
          return
        }
        if (claim.status === 'terminal') {
          planReview = null
          state('Plan execution was denied or expired. No document changes were made.')
          return
        }
        const intent = claim.intent
        const lineage = readExecutionLineage(intent)
        if (
          !item.started &&
          intent &&
          intent.executionId === item.executionId &&
          intent.callId === item.callId &&
          intent.purpose === 'execute-host-plan' &&
          intent.host === HOST &&
          intent.pluginId === config.pluginId &&
          intent.documentId === item.hostContext.documentId &&
          intent.scopeId === item.hostContext.scopeId &&
          intent.adapterVersion === EXECUTION_ADAPTER_VERSION &&
          hex(intent.actionId, 32) &&
          intent.captureId === item.hostContext.captureId &&
          lineage !== null &&
          (!item.lineage || executionLineageMatches(item.lineage, lineage)) &&
          intent.expiresAt > Date.now()
        ) {
          item.started = true
          item.executionEpoch = epoch
          activeExecution = item
          planReview = null
          item.actionId = intent.actionId
          item.lineage = lineage
          item.expiresAt = Math.min(item.expiresAt, intent.expiresAt)
          state('Executing the separately approved native plan...')
          try {
            await executeClaimedPlan(item, intent)
          } finally {
            item.imageWrites?.clear()
            delete item.imageWrites
            if (activeExecution === item) {
              activeExecution = null
              if (!disposed && session === item.auth) state()
            }
          }
          return
        }
        throw new Error('REQUEST')
      }
      if (
        status.state === 'claimed' ||
        status.state === 'executing' ||
        status.state === 'readback'
      ) {
        state('Approved plan is running in the native host.')
        schedulePlan(item)
        return
      }
      planReview = null
      if (status.state === 'completed')
        state('Approved plan completed and the document readback was verified.')
      else if (status.state === 'cancelled') state('Plan execution was cancelled.')
      else state('Plan execution failed. Check MagicPot desktop for diagnostics.')
    } catch {
      if (currentPlan(item)) {
        planReview = null
        state('Plan or correction status request failed. Check MagicPot desktop; polling stopped.')
      }
    }
  }
  const callErrors = [
    'DENIED',
    'EXPIRED',
    'CONFIGURATION_CHANGED',
    'CANCELLED',
    'TIMEOUT',
    'UPSTREAM_FAILED'
  ]
  function validStatus(value, callId) {
    if (!value || value.protocol !== 1 || value.callId !== callId) return false
    const base = ['protocol', 'callId', 'status']
    if (value.status === 'awaiting-approval' || value.status === 'running') return keys(value, base)
    if (value.status === 'completed')
      return (
        keys(value, [...base, 'content'], ['reportedTotalTokens']) &&
        bounded(value.content, 32 * 1024) &&
        value.content.length > 0 &&
        (!Object.prototype.hasOwnProperty.call(value, 'reportedTotalTokens') ||
          integer(value.reportedTotalTokens))
      )
    return (
      (value.status === 'cancelled' || value.status === 'failed') &&
      keys(value, base, ['errorCode']) &&
      (!Object.prototype.hasOwnProperty.call(value, 'errorCode') ||
        callErrors.includes(value.errorCode))
    )
  }
  function generationState(text) {
    emit({ type: 'image-generation-state', label: text, active: generationReview !== null })
    state()
  }
  function currentGeneration(call) {
    return (
      !disposed &&
      generationReview === call &&
      !call.cancelSent &&
      call.epoch === epoch &&
      call.auth === session &&
      live()
    )
  }
  function cancelImageGeneration() {
    const call = generationReview
    if (!call || call.cancelSent) return
    if (!call.proposalId) {
      forget(true, 'Session closed to cancel a pending image proposal. Pair again.')
      return
    }
    call.cancelSent = true
    stop()
    generationState(
      'Image-generation cancellation requested. A dispatched charge cannot be undone.'
    )
    const own = epoch
    void post(
      'generationCancel',
      {
        protocol: 1,
        requestId: call.requestId,
        proposalId: call.proposalId
      },
      call.auth
    )
      .then(() => {
        if (disposed || generationReview !== call || own !== epoch) return
        generationReview = null
        generationState(
          'Stopped locally. Check desktop; an accepted image is retained. Nothing was shared or applied.'
        )
      })
      .catch(() => {
        if (!disposed && generationReview === call && own === epoch)
          forget(true, 'Image cancellation could not be confirmed. Session closed; check desktop.')
      })
  }
  function scheduleGeneration(call) {
    if (!currentGeneration(call)) return
    if (call.polls >= 120 || Date.now() >= call.expiresAt) {
      cancelImageGeneration()
      return
    }
    generationPollTimer = setTimeout(
      () => void pollGeneration(call),
      Math.min(1000, call.expiresAt - Date.now())
    )
  }
  async function pollGeneration(call) {
    if (!currentGeneration(call)) return
    if (Date.now() >= call.expiresAt) {
      scheduleGeneration(call)
      return
    }
    call.polls += 1
    try {
      const result = await post(
        'generationStatus',
        {
          protocol: 1,
          requestId: call.requestId,
          proposalId: call.proposalId
        },
        call.auth
      )
      if (!currentGeneration(call)) return
      const value = globalThis.MagicPotPlanPreviewV1.validateNativeImageGenerationStatus(result, {
        requestId: call.requestId,
        proposalId: call.proposalId,
        createdAt: call.createdAt,
        expiresAt: call.expiresAt,
        now: Date.now()
      })
      const labels = {
        'awaiting-approval':
          'Awaiting explicit image-generation review and model confirmation in MagicPot desktop.',
        preparing: 'Desktop is preparing the exact approved image request.',
        generating:
          'The approved image model is running. Cancellation cannot undo a dispatched charge.',
        materializing: 'Desktop is validating and storing the generated image.',
        'awaiting-acceptance':
          'Desktop must validate and accept the image. It has not been shared here.',
        accepted:
          'Image accepted in desktop only. Separately choose/share it for local preview; native writes need another approval.',
        declined:
          'Image generation declined. Nothing was shared or applied. A new request needs fresh consent.',
        cancelled:
          'Image generation cancelled. Nothing was shared or applied. A dispatched charge cannot be undone.',
        failed:
          'Image generation failed. Nothing was shared or applied. No automatic retry was sent.'
      }
      if (['accepted', 'declined', 'cancelled', 'failed'].includes(value.phase)) {
        generationReview = null
        clearTimeout(generationPollTimer)
        generationPollTimer = null
        generationState(labels[value.phase])
      } else {
        generationState(labels[value.phase])
        scheduleGeneration(call)
      }
    } catch {
      if (currentGeneration(call))
        forget(
          true,
          'Image-generation status failed. Session closed; check desktop. No retry was sent.'
        )
    }
  }
  async function prepareImageGeneration(requestId, text) {
    if (
      !config ||
      disposed ||
      pairing ||
      review ||
      planReview ||
      activeExecution ||
      generationReview ||
      pendingContextImage ||
      !live()
    ) {
      generationState('Image generation is unavailable while another review or capture is active.')
      return
    }
    const prompt = text.trim()
    const helper = globalThis.MagicPotPlanPreviewV1
    if (
      !hex(requestId, 32) ||
      !prompt ||
      prompt.length > 8192 ||
      sequence >= 1000000000 ||
      !helper ||
      typeof helper.validateNativeImageGenerationReceipt !== 'function' ||
      typeof helper.validateNativeImageGenerationStatus !== 'function'
    ) {
      generationState(
        'A bounded prompt and the image-generation validator are required. Nothing was sent.'
      )
      return
    }
    const call = {
      epoch: ++epoch,
      auth: session,
      requestId,
      proposalId: null,
      createdAt: 0,
      expiresAt: 0,
      polls: 0,
      cancelSent: false
    }
    generationReview = call
    sequence += 1
    generationState(
      'Sending this text-only proposal for desktop review. No model call is approved yet.'
    )
    try {
      const result = await post(
        'generationPrepare',
        { protocol: 1, requestId, sequence, prompt },
        call.auth
      )
      if (!currentGeneration(call)) return
      const value = helper.validateNativeImageGenerationReceipt(result, {
        requestId,
        now: Date.now(),
        sessionExpiresAt: call.auth.expiresAt
      })
      call.proposalId = value.proposalId
      call.createdAt = value.createdAt
      call.expiresAt = value.expiresAt
      generationState(
        'Awaiting explicit image-generation review in MagicPot desktop. Nothing is shared or applied.'
      )
      scheduleGeneration(call)
    } catch {
      if (currentGeneration(call))
        forget(
          true,
          'Image proposal could not be confirmed. Session closed; check desktop before pairing again.'
        )
    }
  }
  function current(call) {
    return !disposed && review === call && call.epoch === epoch && live()
  }
  function schedule(call) {
    if (!current(call)) return
    if (call.polls >= 120 || Date.now() >= call.expiresAt) {
      cancelReview()
      state('Review expired or polling limit reached. Check desktop.')
      return
    }
    pollTimer = setTimeout(() => void poll(call), Math.min(1000, call.expiresAt - Date.now()))
  }
  async function poll(call) {
    if (!current(call)) return
    if (Date.now() >= call.expiresAt) {
      schedule(call)
      return
    }
    call.polls += 1
    try {
      const result = await post('status', { protocol: 1, callId: call.callId }, call.auth)
      if (!current(call)) return
      if (Date.now() >= call.expiresAt) {
        schedule(call)
        return
      }
      if (!validStatus(result, call.callId)) throw new Error('REQUEST')
      touch(call.auth)
      if (
        result.status === 'completed' ||
        result.status === 'cancelled' ||
        result.status === 'failed'
      ) {
        let executionReady = false
        if (result.status === 'completed' && call.hostContext) {
          try {
            const parsed = JSON.parse(result.content)
            executionReady = parsed && parsed.executable === true
          } catch {}
        }
        const displayContent =
          result.status === 'completed'
            ? call.hostContext
              ? globalThis.MagicPotPlanPreviewV1.reviewPlanningResult(
                  result.content,
                  call.hostContext,
                  call.assetMetadata
                )
              : result.content
            : ''
        review = null
        if (executionReady) {
          beginPlanReview(call, displayContent)
          return
        }
        if (result.status === 'completed') emit({ type: 'content', text: displayContent })
        state(
          result.status === 'completed'
            ? 'Completed. Result is plain text; nothing was applied to the document.'
            : result.status === 'cancelled'
              ? 'Review cancelled.'
              : 'Desktop request failed.'
        )
      } else {
        state(
          result.status === 'running'
            ? 'Desktop-approved request is running.'
            : 'Awaiting explicit approval in MagicPot desktop.'
        )
        schedule(call)
      }
    } catch (error) {
      if (current(call)) {
        if (error && error.message === 'SESSION')
          forget(false, 'Session expired or unauthorized. Pair again.')
        else forget(true, 'Status request failed. Session closed; check desktop. Polling stopped.')
      }
    }
  }
  async function restoreTask(requestId, rebindBaselineId) {
    if (generationReview) return
    if (rebindBaselineId !== undefined && !hex(rebindBaselineId, 32)) return
    if (
      !config ||
      disposed ||
      pairing ||
      review ||
      planReview ||
      activeExecution ||
      !live() ||
      sequence >= 1000000000
    )
      return
    invalidatePlanningContextImage()
    let captured
    try {
      captured = captureFigmaHostContext(requestId)
    } catch {
      state(
        'Recovery capture failed. Select the exact accepted task targets; nothing was sent or changed.'
      )
      return
    }
    planningNodes = captured.nodes
    snapshot = null
    planningSnapshot = null
    clearView()
    const call = {
      epoch: ++epoch,
      auth: session,
      callId: null,
      polls: 0,
      expiresAt: 0,
      hostContext: captured.context
    }
    review = call
    sequence++
    state(
      'Preparing recovery of accepted task properties. No model call and no document changes yet.'
    )
    try {
      const response = await post(
        'taskRecoveryPrepare',
        {
          protocol: 1,
          requestId,
          sequence,
          hostContext: call.hostContext,
          ...(rebindBaselineId ? { rebindBaselineId } : {})
        },
        call.auth
      )
      if (!current(call)) return
      if (
        keys(response, ['protocol', 'status', 'baselineId']) &&
        response.protocol === 1 &&
        response.status === 'unchanged' &&
        hex(response.baselineId, 32) &&
        (!rebindBaselineId || response.baselineId === rebindBaselineId)
      ) {
        review = null
        touch(call.auth)
        state(
          'Accepted task properties already match. No write or round was used; this does not prove pixel equality.'
        )
        return
      }
      const recovery = response && response.recovery
      if (
        !keys(response, ['protocol', 'status', 'callId', 'executionId', 'expiresAt', 'recovery']) ||
        response.protocol !== 1 ||
        response.status !== 'prepared' ||
        !hex(response.callId, 32) ||
        !hex(response.executionId, 32) ||
        !integer(response.expiresAt) ||
        response.expiresAt <= Date.now() ||
        !keys(
          recovery,
          [
            'baselineId',
            'sourceExecutionId',
            'requestId',
            'round',
            'maxCorrectionRounds',
            'targetIds'
          ],
          ['rebind', 'images']
        ) ||
        (rebindBaselineId !== undefined && recovery.baselineId !== rebindBaselineId) ||
        (recovery.rebind !== undefined &&
          (!rebindBaselineId ||
            !keys(recovery.rebind, ['previousIdentity', 'nextIdentity']) ||
            !hex(recovery.rebind.previousIdentity, 32) ||
            !hex(recovery.rebind.nextIdentity, 32) ||
            recovery.rebind.previousIdentity === recovery.rebind.nextIdentity ||
            recovery.rebind.nextIdentity !== call.hostContext.recoveryIdentity)) ||
        !hex(recovery.baselineId, 32) ||
        !hex(recovery.sourceExecutionId, 32) ||
        recovery.requestId !== requestId ||
        !Number.isInteger(recovery.round) ||
        recovery.round < 1 ||
        recovery.round > 3 ||
        recovery.maxCorrectionRounds !== 3 ||
        !sameIds(recovery.targetIds, [...call.hostContext.selectedIds].sort())
      )
        throw new Error('REQUEST')
      if (recovery.images !== undefined) {
        recovery.images = validatedRecoveryImages(recovery.images)
        if (
          recovery.images.manifest.targets.some(
            (target) =>
              target.command !== 'image.fill' || !recovery.targetIds.includes(target.targetId)
          )
        )
          throw new Error('REQUEST')
      }
      call.callId = response.callId
      review = null
      touch(call.auth)
      planReview = {
        kind: 'recovery',
        auth: call.auth,
        callId: response.callId,
        executionId: response.executionId,
        hostContext: call.hostContext,
        expiresAt: Math.min(response.expiresAt, call.auth.expiresAt),
        recovery,
        polls: 0,
        started: false
      }
      state(
        'Recovery preview ready. Review its exact changes and approve once in MagicPot desktop.'
      )
      schedulePlan(planReview)
    } catch {
      if (current(call))
        forget(
          true,
          'Recovery unavailable or preparation could not be confirmed. No write started; check desktop and pair again.'
        )
    }
  }
  async function share(message) {
    if (activeExecution || generationReview) return
    if (
      pairing ||
      activeExecution ||
      review ||
      !live() ||
      !snapshot ||
      snapshot.selectionRevision !== message.revision
    )
      return
    const prompt = message.prompt.trim()
    if (!prompt || prompt.length > 16384 || sequence >= 1000000000) {
      state('Prompt is invalid or too large.')
      return
    }
    let assetReferences
    let assetMetadata
    let assetProjectId
    if (message.assetReferences !== undefined) {
      if (!planningSnapshot) {
        state(
          'Selected desktop image metadata requires a native plan context. Recapture and consent again; nothing was sent.'
        )
        return
      }
      try {
        const binding = sessionAssetCatalogBinding
        const helper = globalThis.MagicPotPlanPreviewV1
        if (!binding || binding.auth !== session || !helper?.selectPlanningAssetReferences)
          throw new Error('ASSET_UNAVAILABLE')
        assetReferences = helper.selectPlanningAssetReferences(
          sessionAssetCatalog,
          message.assetReferences,
          sessionAssetIdentity(session, binding.projectId)
        )
        assetProjectId = binding.projectId
        assetMetadata = assetReferences.map((reference) => {
          const asset = sessionAssetCatalog.assets.find(
            (entry) => entry.assetId === reference.assetId
          )
          return {
            assetId: asset.assetId,
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            width: asset.width,
            height: asset.height,
            expiresAt: asset.expiresAt
          }
        })
      } catch {
        clearSessionAssets(
          true,
          'Desktop image selection is stale or invalid. Refresh and consent again; nothing was sent.'
        )
        return
      }
    }
    if (planningContextImage) {
      try {
        if (!planningImageBinding || !currentContextImageCapture(planningImageBinding))
          throw new Error('STALE_CONTEXT_IMAGE')
      } catch {
        invalidatePlanningContextImage(
          'The captured image is stale. Recapture and consent again before sharing.'
        )
        return
      }
    }
    const body = {
      protocol: 1,
      requestId: message.nonce,
      sequence: sequence + 1,
      prompt,
      context: snapshot,
      ...(planningSnapshot ? { featureId: 'plan-preview', hostContext: planningSnapshot } : {}),
      ...(assetReferences ? { assetReferences } : {}),
      ...(planningContextImage ? { contextImage: planningContextImage } : {})
    }
    if (!bounded(JSON.stringify(body), 64 * 1024)) {
      if (planningContextImage)
        invalidatePlanningContextImage(
          'Prompt, metadata and image exceed 64 KiB. Recapture with a shorter prompt or without an image; nothing was sent.'
        )
      else state('Prompt and selection metadata are too large.')
      return
    }
    sequence += 1
    snapshot = null
    planningSnapshot = null
    clearPlanningContextImage()
    const call = {
      epoch: ++epoch,
      auth: session,
      callId: null,
      polls: 0,
      expiresAt: 0,
      hostContext: body.hostContext,
      assetMetadata,
      assetProjectId
    }
    review = call
    emit({ type: 'content', text: '' })
    state('Sending for desktop approval...')
    try {
      const result = await post('prepare', body, call.auth)
      if (!current(call)) return
      if (
        !keys(result, ['protocol', 'callId', 'status', 'expiresAt']) ||
        result.protocol !== 1 ||
        !hex(result.callId, 32) ||
        result.status !== 'awaiting-approval' ||
        !integer(result.expiresAt) ||
        result.expiresAt <= Date.now()
      )
        throw new Error('REQUEST')
      call.callId = result.callId
      call.expiresAt = Math.min(result.expiresAt, call.auth.expiresAt)
      touch(call.auth)
      state('Awaiting explicit approval in MagicPot desktop.')
      schedule(call)
    } catch {
      if (current(call)) {
        // An uncertain prepare may have reached desktop. Close once rather than retry it.
        forget(true, 'Prepare failed. Session closed; check desktop before pairing again.')
      }
    }
  }
  function receive(message) {
    if (disposed || !message || message.protocol !== 1 || typeof message.type !== 'string') return
    if (keys(message, ['protocol', 'type']) && message.type === 'ready') {
      if (config)
        emit({ type: 'config', origin: config.origin, pluginId: config.pluginId, host: HOST })
      state()
      return
    }
    if (
      message.type === 'capture-read-only-snapshot' &&
      keys(message, ['protocol', 'type', 'instanceEpoch', 'requestId']) &&
      hex(message.instanceEpoch, 32) &&
      hex(message.requestId, 32)
    ) {
      captureReadOnlySnapshot(message.instanceEpoch, message.requestId)
      return
    }
    if (
      keys(message, ['protocol', 'type']) &&
      ['cancel', 'close', 'dispose'].includes(message.type)
    ) {
      if (message.type === 'cancel') cancelReview()
      else {
        forget(true, 'Session closed.', message.type === 'dispose')
        if (message.type === 'dispose') figma.closePlugin()
      }
      return
    }
    if (!config) return
    if (message.type === 'image-generation-cancel' && keys(message, ['protocol', 'type'])) {
      cancelImageGeneration()
      return
    }
    if (
      message.type === 'image-generation-prepare' &&
      keys(message, ['protocol', 'type', 'requestId', 'prompt', 'consent']) &&
      hex(message.requestId, 32) &&
      message.consent === true &&
      typeof message.prompt === 'string' &&
      message.prompt.length <= 8192
    ) {
      void prepareImageGeneration(message.requestId, message.prompt)
      return
    }
    if (
      ['refresh-session-assets', 'preview-session-asset', 'session-asset-next'].includes(
        message.type
      )
    ) {
      if (
        message.type === 'refresh-session-assets' &&
        keys(message, ['protocol', 'type', 'nonce']) &&
        hex(message.nonce, 32)
      )
        void refreshSessionAssets(message.nonce)
      else if (
        message.type === 'preview-session-asset' &&
        keys(message, ['protocol', 'type', 'nonce', 'assetId', 'sha256']) &&
        hex(message.nonce, 32) &&
        hex(message.assetId, 32) &&
        hex(message.sha256, 64)
      )
        void previewSessionAsset(message)
      else if (
        message.type === 'session-asset-next' &&
        keys(message, ['protocol', 'type', 'nonce', 'index']) &&
        hex(message.nonce, 32) &&
        integer(message.index) &&
        message.index < 342
      )
        sendSessionAssetChunk(message)
      return
    }
    if (message.type === 'clear-session-assets' && keys(message, ['protocol', 'type'])) {
      clearSessionAssets()
      return
    }
    if (
      message.type === 'check-connection' &&
      keys(message, ['protocol', 'type', 'nonce']) &&
      hex(message.nonce, 32)
    ) {
      void checkConnection(message.nonce)
      return
    }
    if (message.type === 'readiness' && keys(message, ['protocol', 'type'])) {
      void checkReadiness()
      return
    }
    if (
      message.type === 'restore-task' &&
      keys(message, ['protocol', 'type', 'nonce', 'instanceEpoch'], ['rebindBaselineId']) &&
      (message.rebindBaselineId === undefined || hex(message.rebindBaselineId, 32)) &&
      hex(message.nonce, 32) &&
      hex(message.instanceEpoch, 32)
    ) {
      if (snapshotInstanceEpoch !== null && snapshotInstanceEpoch !== message.instanceEpoch) return
      snapshotInstanceEpoch = message.instanceEpoch
      void restoreTask(message.nonce, message.rebindBaselineId)
      return
    }
    if (
      ['capture-plan', 'capture-plan-image'].includes(message.type) &&
      keys(message, ['protocol', 'type', 'nonce', 'instanceEpoch']) &&
      hex(message.nonce, 32) &&
      hex(message.instanceEpoch, 32)
    ) {
      void capturePlan(message.nonce, message.instanceEpoch, message.type === 'capture-plan-image')
      return
    }
    if (
      message.type === 'pair' &&
      keys(message, ['protocol', 'type', 'ticket', 'nonce']) &&
      hex(message.nonce, 32) &&
      bounded(message.ticket, 4096)
    )
      void pair(message)
    else if (
      message.type === 'capture' &&
      keys(message, ['protocol', 'type', 'nonce']) &&
      hex(message.nonce, 32)
    )
      capture(message.nonce)
    else if (
      message.type === 'share' &&
      keys(
        message,
        ['protocol', 'type', 'nonce', 'revision', 'prompt', 'consent'],
        ['assetReferences']
      ) &&
      hex(message.nonce, 32) &&
      hex(message.revision, 32) &&
      message.consent === true &&
      typeof message.prompt === 'string' &&
      message.prompt.length <= 16384
    )
      void share(message)
  }
  figma.showUI(__html__, { width: 440, height: 700 })
  figma.ui.onmessage = receive
  for (const event of ['selectionchange', 'currentpagechange']) {
    try {
      figma.on(event, () =>
        invalidatePlanningContextImage(
          'Selection or document changed. Recapture the context image before sharing.'
        )
      )
    } catch {}
  }
  figma.on('close', () => {
    if (!disposed) forget(true, 'Session closed.', true)
  })
})()
