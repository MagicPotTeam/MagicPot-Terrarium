// Connected source only. Writes run in Photoshop's modal API after a separate desktop approval.
;(() => {
  const photoshop = require('photoshop')
  const { app } = photoshop
  const executeAsModal = photoshop.core && photoshop.core.executeAsModal
  const getPhotoshopImaging = () => {
    try {
      const value = photoshop.imaging
      return value && typeof value.getPixels === 'function' ? value : null
    } catch {
      return null
    }
  }
  const HOST = 'photoshop'
  const EXECUTION_ADAPTER_VERSION = 'photoshop-uxp-native-1'
  const keys = (value, required, optional = []) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  const hex = (value, size) =>
    typeof value === 'string' && value.length === size && !/[^a-f0-9]/.test(value)
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
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$(?![\s\S])/.test(input.origin) &&
    Number(input.origin.slice(17)) >= 1024 &&
    Number(input.origin.slice(17)) <= 65535 &&
    typeof input.pluginId === 'string' &&
    input.pluginId.length <= 128 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$(?![\s\S])/.test(input.pluginId)
  const config = validConfig
    ? Object.freeze({ protocol: 1, origin: input.origin, pluginId: input.pluginId, host: HOST })
    : null
  const secure = () => typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
  function nonce() {
    if (!secure()) throw new Error('CRYPTO')
    const data = new Uint8Array(16)
    crypto.getRandomValues(data)
    return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('')
  }
  let session = null
  let pairing = false
  let snapshot = null
  let planningSnapshot = null
  let planningNodes = null
  const recoveryDocumentIds = new WeakMap()
  let review = null
  let planReview = null
  let activeExecution = null
  let sequence = 0
  let epoch = 0
  let disposed = false
  let initialized = false
  let pollTimer = null
  let planPollTimer = null
  let expiryTimer = null
  let snapshotReader = null
  let snapshotInstanceEpoch = null
  let label = config
    ? 'Paste a desktop pairing ticket to connect.'
    : 'Bridge configuration is invalid.'
  const operations = new Set()
  const routes = Object.freeze({
    pair: '/figplugin/v1/pair',
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
    planPixelAudit: '/figplugin/v1/plan/pixel-audit'
  })
  const el = (id) => document.getElementById(id)
  function captureReadOnlySnapshot() {
    if (!initialized || disposed) return
    let text = 'SNAPSHOT_FAILED'
    try {
      const helper = globalThis.MagicPotSelectionSnapshotV1
      if (
        !secure() ||
        (!snapshotReader && (!helper || typeof helper.createPhotoshopReader !== 'function'))
      ) {
        text = 'SNAPSHOT_UNAVAILABLE'
      } else {
        if (snapshotInstanceEpoch === null) snapshotInstanceEpoch = nonce()
        if (!snapshotReader)
          snapshotReader = helper.createPhotoshopReader({
            app,
            instanceEpoch: snapshotInstanceEpoch
          })
        const result = snapshotReader.capture()
        if (keys(result, ['ok', 'snapshot']) && result.ok === true)
          text = JSON.stringify(result.snapshot, null, 2)
        else if (
          keys(result, ['ok', 'error']) &&
          result.ok === false &&
          keys(result.error, ['code']) &&
          typeof result.error.code === 'string' &&
          /^[A-Z][A-Z0-9_]{0,63}$(?![\s\S])/.test(result.error.code)
        )
          text = result.error.code
      }
    } catch {
      text = 'SNAPSHOT_FAILED'
    }
    // Metadata observation only; keep this completely separate from the consent-bound share context.
    el('read-only-output').textContent = typeof text === 'string' ? text : 'SNAPSHOT_FAILED'
  }
  function state(text = label) {
    label = text
    if (!initialized || disposed) return
    el('status').textContent = label
    el('read-only-capture').disabled = !secure()
    el('pair').disabled = !config || !secure() || session !== null || pairing
    el('capture').disabled = !config || !secure() || pairing || activeExecution !== null
    el('plan-capture').disabled = !config || !secure() || pairing || activeExecution !== null
    el('restore-task').disabled =
      !config ||
      !secure() ||
      !session ||
      pairing ||
      review !== null ||
      planReview !== null ||
      activeExecution !== null
    el('rebind-task').disabled =
      el('restore-task').disabled || !hex(el('rebind-checkpoint').value.trim(), 32)
    el('share').disabled =
      !config ||
      !secure() ||
      !session ||
      pairing ||
      review !== null ||
      planReview !== null ||
      activeExecution !== null ||
      !snapshot ||
      !el('consent').checked ||
      !el('prompt').value.trim() ||
      el('prompt').value.length > 16384
    el('cancel').disabled = review === null && planReview === null && activeExecution === null
  }
  function clearView() {
    if (!initialized || disposed) return
    el('selection').textContent = ''
    el('result').textContent = ''
    el('consent').checked = false
  }
  const stop = () => {
    epoch += 1
    clearTimeout(pollTimer)
    pollTimer = null
    clearTimeout(planPollTimer)
    planPollTimer = null
    for (const cancel of Array.from(operations)) cancel()
  }
  // text() works in native hosts without a ReadableStream; desktop independently bounds bodies.
  async function post(route, body, auth = null) {
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
    const work = (async () => {
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
      if (route === 'cancel' || route === 'close') {
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
    snapshot = null
    planningSnapshot = null
    planningNodes = null
    review = null
    planReview = null
    sequence = 0
    clearView()
    if (initialized) el('ticket').value = ''
    state(text)
    disposed = disposing
    if (disposing) {
      snapshotReader = null
      snapshotInstanceEpoch = null
      if (initialized) {
        el('read-only-output').textContent = ''
        el('read-only-capture').disabled = true
      }
    }
    // Single best-effort request. The desktop TTL covers hosts that cannot finish unload callbacks.
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
  async function pair() {
    let text = el('ticket').value
    el('ticket').value = ''
    if (!config || disposed || pairing || session || review) return
    let ticket
    let clientNonce
    try {
      ticket = ticketOf(text)
      clientNonce = nonce()
    } catch {
      state('Pairing ticket or secure randomness is invalid or unavailable.')
      return
    } finally {
      text = ''
    }
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
        clientNonce
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
  function cancelReview() {
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
    if (!review || disposed) return
    const old = review
    if (!old.callId) {
      forget(true, 'Session closed to cancel the pending request. Pair again.')
      return
    }
    stop()
    review = null
    el('result').textContent = ''
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
  function capture() {
    if (activeExecution) return
    if (!config || disposed || pairing) return
    cancelReview()
    snapshot = null
    planningSnapshot = null
    clearView()
    try {
      const selectionRevision = nonce()
      const activeDocument = app.activeDocument
      const layers = activeDocument ? activeDocument.activeLayers : []
      const nodes = []
      const ids = new Set()
      for (let index = 0; index < Math.min(layers.length, 100); index += 1) {
        const layer = layers[index]
        const id = layer.id
        if (!integer(id)) throw new Error('CONTEXT')
        const item = {
          id: String(id),
          type: safeLabel(layer.kind, 64),
          name: safeLabel(layer.name),
          locked: layer.allLocked === true
        }
        if (!item.type || ids.has(item.id)) throw new Error('CONTEXT')
        ids.add(item.id)
        nodes.push(item)
      }
      const context = { selectionRevision, nodes }
      if (!bounded(JSON.stringify(context), 48 * 1024)) throw new Error('CONTEXT')
      snapshot = context
      el('selection').textContent = JSON.stringify(context, null, 2)
      state(
        layers.length > 100
          ? 'Captured first 100 selected items. Review the exact metadata below.'
          : 'Selection captured. Review the exact metadata below.'
      )
    } catch {
      state('Selection capture or secure randomness failed. Capture again before sharing.')
    }
  }
  const layerLocked = (layer) =>
    layer.allLocked === true ||
    layer.pixelsLocked === true ||
    layer.positionLocked === true ||
    layer.transparentPixelsLocked === true ||
    layer.isBackgroundLayer === true
  const normalizedOpacity = (layer) => {
    const value = Number(layer.opacity)
    if (!Number.isFinite(value) || value < 0 || value > 100) return undefined
    // Native opacity is an 8-bit value exposed as a percentage. Canonicalize the
    // representation, not the accepted error tolerance. Plans use the same grid.
    return Math.round((value * 255) / 100) / 255
  }
  function capturePhotoshopHostContext(captureId, selectionOverride = null) {
    const document = app.activeDocument
    if (!document || !Number.isSafeInteger(document.id) || document.id <= 0)
      throw new Error('CONTEXT')
    const layers = selectionOverride || document.activeLayers
    if (!layers || typeof layers.length !== 'number' || layers.length < 1 || layers.length > 100)
      throw new Error('CONTEXT')
    const documentId = String(document.id)
    if (!recoveryDocumentIds.has(document)) recoveryDocumentIds.set(document, nonce())
    const recoveryIdentity = recoveryDocumentIds.get(document)
    const records = new Map()
    const objects = new Map()
    const selectedIds = []
    const ancestorsOf = (layer) => {
      const ancestors = []
      let current = layer.parent
      let depth = 0
      while (current) {
        if (depth++ >= 32) throw new Error('CONTEXT')
        if (!Number.isSafeInteger(current.id) || current.id <= 0) throw new Error('CONTEXT')
        const type = exactText(current.kind, 128)
        if (!type) throw new Error('CONTEXT')
        ancestors.push({ id: String(current.id), type, locked: layerLocked(current) })
        current = current.parent
      }
      return ancestors
    }
    const visit = (layer, selected) => {
      if (!Number.isSafeInteger(layer.id) || layer.id <= 0) throw new Error('CONTEXT')
      const id = String(layer.id)
      if (records.has(id)) {
        if (selected) throw new Error('CONTEXT')
        return id
      }
      if (records.size >= 100) throw new Error('CONTEXT')
      if (!layer.document || String(layer.document.id) !== documentId) throw new Error('CONTEXT')
      const type = exactText(layer.kind, 128)
      const name = exactText(layer.name, 4096)
      if (!type || name === null || typeof layer.visible !== 'boolean') throw new Error('CONTEXT')
      const ancestors = ancestorsOf(layer)
      const locked = layerLocked(layer)
      const effectiveLocked = locked || ancestors.some((ancestor) => ancestor.locked)
      const opacity = normalizedOpacity(layer)
      const commands = []
      let text
      if (selected && !effectiveLocked) {
        commands.push('node.rename', 'node.visibility')
        if (opacity !== undefined) commands.push('node.opacity')
        if (type === 'text' && layer.textItem) {
          const contents = exactText(layer.textItem.contents, 4096)
          if (contents !== null) {
            text = contents
            commands.push('text.content')
          }
        }
      }
      const record = {
        id,
        type,
        name,
        parentId: ancestors[0]?.id ?? null,
        ancestors,
        locked,
        visible: layer.visible,
        ...(opacity === undefined ? {} : { opacity }),
        commands,
        ...(text === undefined ? {} : { text })
      }
      records.set(id, record)
      objects.set(id, layer)
      if (selected) selectedIds.push(id)
      return id
    }
    for (let index = 0; index < layers.length; index += 1) {
      const selected = layers[index]
      visit(selected, true)
      let parent = selected.parent
      while (parent) {
        visit(parent, false)
        parent = parent.parent
      }
    }
    const visualHelper = globalThis.MagicPotVisualEvidenceV1
    const visualImaging = getPhotoshopImaging()
    const canCaptureVisualEvidence =
      visualHelper &&
      typeof visualHelper.capturePhotoshopLayer === 'function' &&
      typeof visualHelper.combine === 'function' &&
      visualImaging &&
      selectedIds.every((id) => {
        const layer = objects.get(id)
        return layer && Number.isSafeInteger(layer.id) && layer.id > 0
      })
    const context = {
      version: 1,
      host: HOST,
      documentId,
      scopeId: documentId,
      captureId,
      recoveryIdentity,
      nodes: Array.from(records.values()),
      selectedIds,
      execution: {
        mode: 'native-write',
        adapterVersion: EXECUTION_ADAPTER_VERSION,
        supports: ['node.rename', 'node.opacity', 'node.visibility', 'text.content'],
        opacityEncoding: 'uint8',
        rollback: 'verified-in-place',
        visualAudit: canCaptureVisualEvidence ? 'hash-only' : 'unavailable'
      }
    }
    const planner = globalThis.MagicPotPlanPreviewV1
    if (!planner || typeof planner.validateHostContext !== 'function') throw new Error('SNAPSHOT')
    return {
      context: planner.validateHostContext(JSON.parse(JSON.stringify(context))),
      nodes: objects
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
  function findPhotoshopLayer(document, targetId) {
    const stack = []
    const add = (collection) => {
      if (!collection || typeof collection.length !== 'number') return
      for (let index = 0; index < collection.length; index += 1) stack.push(collection[index])
    }
    add(document.layers)
    add(document.activeLayers)
    const seen = new Set()
    let visited = 0
    while (stack.length) {
      const layer = stack.shift()
      if (!layer || ++visited > 1000) throw new Error('CONTEXT')
      const id = String(layer.id)
      if (seen.has(id)) continue
      seen.add(id)
      if (id === targetId) return layer
      add(layer.layers)
    }
    throw new Error('CONTEXT')
  }
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
  function capturePhotoshopCorrectionContext(authorization) {
    const document = app.activeDocument
    if (!document || String(document.id) !== authorization.documentId) throw new Error('CONTEXT')
    const selection = authorization.visualTargetIds.map((targetId) =>
      findPhotoshopLayer(document, targetId)
    )
    const captured = capturePhotoshopHostContext(authorization.authorizationId, selection)
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
  function capturePlan() {
    if (activeExecution) return
    if (pairing || disposed || !config || !initialized) return
    cancelReview()
    snapshot = null
    planningSnapshot = null
    planningNodes = null
    clearView()
    try {
      const revision = nonce()
      if (snapshotInstanceEpoch === null) snapshotInstanceEpoch = nonce()
      const instanceEpoch = snapshotInstanceEpoch
      const planner = globalThis.MagicPotPlanPreviewV1
      if (!planner) throw new Error('SNAPSHOT')
      const captured = capturePhotoshopHostContext(revision)
      const full = captured.context
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
      el('selection').textContent = planner.formatContext(full)
      state(
        'Native plan context captured. Model output still requires a separate desktop write approval.'
      )
    } catch {
      snapshot = null
      planningSnapshot = null
      planningNodes = null
      state('Planning capture failed. No content was sent and no document was changed.')
    }
  }
  const planCommands = ['node.rename', 'node.opacity', 'node.visibility', 'text.content']
  const readNodeValue = (layer, command) => {
    switch (command) {
      case 'node.rename':
        return layer.name
      case 'node.opacity':
        return normalizedOpacity(layer)
      case 'node.visibility':
        return layer.visible
      case 'text.content':
        return layer.kind === 'text' && layer.textItem ? layer.textItem.contents : undefined
      default:
        return undefined
    }
  }
  const samePlanValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  function verifyNativeLayer(record, documentId) {
    if (!planningNodes) throw new Error('STALE_CONTEXT')
    const layer = planningNodes.get(record.id)
    if (
      !layer ||
      String(layer.id) !== record.id ||
      !layer.document ||
      String(layer.document.id) !== documentId
    )
      throw new Error('STALE_CONTEXT')
    const ancestors = []
    let current = layer.parent
    while (current) {
      ancestors.push(current)
      current = current.parent
      if (ancestors.length > 32) throw new Error('STALE_CONTEXT')
    }
    if (
      ancestors.length !== record.ancestors.length ||
      ancestors.some((ancestor, index) => {
        const expected = record.ancestors[index]
        return (
          String(ancestor.id) !== expected.id ||
          String(ancestor.kind) !== expected.type ||
          layerLocked(ancestor) !== expected.locked
        )
      })
    )
      throw new Error('STALE_CONTEXT')
    if (layerLocked(layer) || record.ancestors.some((ancestor) => ancestor.locked))
      throw new Error('LOCKED_TARGET')
    return layer
  }
  function precheckPlan(plan, context) {
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
      const layer = verifyNativeLayer(contextNode, context.documentId)
      const expected = readNodeValue(layer, step.command)
      const baseline =
        step.command === 'node.rename'
          ? contextNode.name
          : step.command === 'node.opacity'
            ? contextNode.opacity
            : step.command === 'node.visibility'
              ? contextNode.visible
              : contextNode.text
      if (!samePlanValue(expected, baseline)) throw new Error('STALE_CONTEXT')
      checked.push({ layer, contextNode, step })
    }
    return checked
  }
  function applyPlanStep(layer, step) {
    switch (step.command) {
      case 'node.rename':
        layer.name = step.name
        break
      case 'node.opacity':
        layer.opacity = step.opacity * 100
        break
      case 'node.visibility':
        layer.visible = step.visible
        break
      case 'text.content':
        if (layer.kind !== 'text' || !layer.textItem) throw new Error('UNSUPPORTED_COMMAND')
        layer.textItem.contents = step.text
        break
      default:
        throw new Error('UNSUPPORTED_COMMAND')
    }
  }
  function rollbackPlanStep(layer, contextNode, step, documentId) {
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
      verifyNativeLayer(contextNode, documentId) !== layer ||
      !samePlanValue(readNodeValue(layer, step.command), requested)
    )
      throw new Error('STALE_CONTEXT')
    switch (step.command) {
      case 'node.rename':
        layer.name = contextNode.name
        break
      case 'node.opacity':
        layer.opacity = contextNode.opacity * 100
        break
      case 'node.visibility':
        layer.visible = contextNode.visible
        break
      case 'text.content':
        layer.textItem.contents = contextNode.text
        break
    }
  }
  function createPlanReadback(context, plan) {
    const nodes = new Map(context.nodes.map((node) => [node.id, node]))
    return {
      version: 1,
      kind: 'host-plan-readback',
      host: HOST,
      documentId: context.documentId,
      scopeId: context.scopeId,
      captureId: context.captureId,
      steps: plan.steps.map((step) => {
        const contextNode = nodes.get(step.targetId)
        const layer = planningNodes && planningNodes.get(step.targetId)
        const expected = contextNode
          ? step.command === 'node.rename'
            ? contextNode.name
            : step.command === 'node.opacity'
              ? contextNode.opacity
              : step.command === 'node.visibility'
                ? contextNode.visible
                : contextNode.text
          : undefined
        const requested =
          step.command === 'node.rename'
            ? step.name
            : step.command === 'node.opacity'
              ? step.opacity
              : step.command === 'node.visibility'
                ? step.visible
                : step.text
        let value
        try {
          value = layer ? readNodeValue(layer, step.command) : undefined
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
  }
  const getVisualEvidenceHelper = () => {
    const helper = globalThis.MagicPotVisualEvidenceV1
    if (
      !helper ||
      typeof helper.capturePhotoshopLayer !== 'function' ||
      typeof helper.combine !== 'function'
    )
      throw new Error('VISUAL_EVIDENCE_UNAVAILABLE')
    return helper
  }
  async function capturePlanVisualPoints(entries, documentId) {
    const helper = getVisualEvidenceHelper()
    const imaging = getPhotoshopImaging()
    if (!imaging) throw new Error('VISUAL_EVIDENCE_UNAVAILABLE')
    const numericDocumentId = Number(documentId)
    if (!Number.isSafeInteger(numericDocumentId) || numericDocumentId <= 0)
      throw new Error('VISUAL_EVIDENCE_UNAVAILABLE')
    const captured = new Map()
    for (const entry of entries) {
      if (captured.has(entry.targetId)) continue
      captured.set(
        entry.targetId,
        await helper.capturePhotoshopLayer(imaging, numericDocumentId, entry.layer.id)
      )
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
      return checked.map((entry) => ({ targetId: entry.step.targetId, layer: entry.layer }))
    }
    if (!intent.visualCorrection && !intent.visualTargetIds)
      return checked.map((entry) => ({ targetId: entry.step.targetId, layer: entry.layer }))
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
      return {
        targetId,
        layer: verifyNativeLayer(contextNode, item.hostContext.documentId)
      }
    })
  }
  const executionCurrent = (item) =>
    !disposed &&
    activeExecution === item &&
    item.executionEpoch === epoch &&
    session === item.auth &&
    Date.now() < Math.min(item.expiresAt, item.auth.expiresAt, item.auth.idleAt)
  function assertExecutionCurrent(item) {
    if (!executionCurrent(item)) throw new Error('CANCELLED')
  }
  async function checkExecutionAuthority(item) {
    assertExecutionCurrent(item)
    const status = await post(
      'planStatus',
      {
        protocol: 1,
        callId: item.callId,
        executionId: item.executionId
      },
      item.auth
    )
    assertExecutionCurrent(item)
    if (
      !status ||
      status.protocol !== 1 ||
      status.executionId !== item.executionId ||
      status.callId !== item.callId ||
      !['claimed', 'executing'].includes(status.state)
    )
      throw new Error('CANCELLED')
  }
  let executionJournal = null
  async function reserveNativeAction(item, intent) {
    const helper = globalThis.MagicPotExecutionJournalV1
    if (!helper) throw new Error('JOURNAL_UNAVAILABLE')
    if (!executionJournal) executionJournal = helper.createPhotoshop()
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
  async function executeClaimedPlan(item, intent) {
    assertExecutionCurrent(item)
    const planner = globalThis.MagicPotPlanPreviewV1
    let plan
    try {
      plan = planner.validateHostPlan(intent.plan, item.hostContext)
    } catch {
      state('Desktop plan validation failed. No document changes were made.')
      return
    }
    if (typeof executeAsModal !== 'function') {
      state('Photoshop modal execution is unavailable. No document changes were made.')
      return
    }
    let effect = 'none'
    let readback = createPlanReadback(item.hostContext, plan)
    let visualEvidence
    let failureCode
    let journalBlocked = false
    let sequence = 2
    try {
      await executeAsModal(
        async () => {
          assertExecutionCurrent(item)
          let checked = precheckPlan(plan, item.hostContext)
          let visualEntries = visualEntriesForIntent(checked, item, intent)
          let beforeVisual = null
          if (item.hostContext.execution.visualAudit === 'hash-only') {
            beforeVisual = await capturePlanVisualPoints(visualEntries, item.hostContext.documentId)
            assertExecutionCurrent(item)
            // Pixel capture is asynchronous. Re-check native identities before the first mutation.
            checked = precheckPlan(plan, item.hostContext)
            visualEntries = visualEntriesForIntent(checked, item, intent)
          }
          await checkExecutionAuthority(item)
          try {
            await reserveNativeAction(item, intent)
          } catch (error) {
            journalBlocked = String(error?.message).startsWith('JOURNAL_')
            throw error
          }
          checked = precheckPlan(plan, item.hostContext)
          const applied = []
          try {
            for (let index = 0; index < checked.length; index += 1) {
              const entry = checked[index]
              assertExecutionCurrent(item)
              precheckPlan({ ...plan, steps: [entry.step] }, item.hostContext)
              applyPlanStep(entry.layer, entry.step)
              applied.push(entry)
              await post(
                'planProgress',
                {
                  protocol: 1,
                  executionId: item.executionId,
                  actionId: item.actionId,
                  sequence: sequence++,
                  phase: 'executing',
                  index,
                  completed: index + 1,
                  total: checked.length,
                  effect: index + 1 === checked.length ? 'applied' : 'partial',
                  at: Date.now()
                },
                item.auth
              )
              assertExecutionCurrent(item)
            }
          } catch {
            for (const entry of applied.reverse()) {
              try {
                // A delayed cleanup is still a write; it cannot outlive the original grant.
                if (Date.now() >= item.expiresAt) throw new Error('EXPIRED')
                rollbackPlanStep(
                  entry.layer,
                  entry.contextNode,
                  entry.step,
                  item.hostContext.documentId
                )
              } catch {}
            }
            failureCode = 'ROLLED_BACK'
            return
          }
          readback = createPlanReadback(item.hostContext, plan)
          let observations = readback.steps.map((step) => step.observation)
          effect = observations.every((value) => value === 'requested')
            ? 'applied'
            : observations.every((value) => value === 'original')
              ? 'rolled-back'
              : observations.some((value) => value === 'requested')
                ? 'partial'
                : 'unknown'
          if (effect === 'applied' && item.hostContext.execution.visualAudit === 'hash-only') {
            try {
              const afterVisual = await capturePlanVisualPoints(
                visualEntries,
                item.hostContext.documentId
              )
              assertExecutionCurrent(item)
              for (const entry of checked)
                verifyNativeLayer(entry.contextNode, item.hostContext.documentId)
              readback = createPlanReadback(item.hostContext, plan)
              if (readback.steps.some((step) => step.observation !== 'requested'))
                throw new Error('STALE_CONTEXT')
              visualEvidence = combinePlanVisualEvidence(visualEntries, beforeVisual, afterVisual)
            } catch {
              for (const entry of [...applied].reverse()) {
                try {
                  // A delayed cleanup is still a write; it cannot outlive the original grant.
                  if (Date.now() >= item.expiresAt) throw new Error('EXPIRED')
                  rollbackPlanStep(
                    entry.layer,
                    entry.contextNode,
                    entry.step,
                    item.hostContext.documentId
                  )
                } catch {}
              }
              visualEvidence = undefined
              readback = createPlanReadback(item.hostContext, plan)
              observations = readback.steps.map((step) => step.observation)
              effect = observations.every((value) => value === 'original')
                ? 'rolled-back'
                : 'unknown'
              failureCode = effect === 'rolled-back' ? 'ROLLED_BACK' : 'QUARANTINED'
            }
          }
        },
        { commandName: 'MagicPot approved FIGPLUGIN plan' }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failureCode = message === 'VISUAL_EVIDENCE_UNAVAILABLE' ? 'HOST_UNAVAILABLE' : 'STALE_CONTEXT'
    }
    readback = createPlanReadback(item.hostContext, plan)
    const observations = readback.steps.map((step) => step.observation)
    if (observations.every((value) => value === 'requested')) effect = 'applied'
    else if (observations.every((value) => value === 'original'))
      effect = failureCode === 'ROLLED_BACK' ? 'rolled-back' : failureCode ? 'none' : 'rolled-back'
    else if (observations.some((value) => value === 'requested')) effect = 'partial'
    else effect = 'unknown'
    if (journalBlocked) {
      effect = 'unknown'
      failureCode = 'QUARANTINED'
    }
    if (effect !== 'applied') visualEvidence = undefined
    if (!executionCurrent(item)) return
    let completed = readback.steps.filter((step) => step.observation === 'requested').length
    let status = effect === 'applied' ? 'completed' : 'failed'
    let errorCode =
      effect === 'unknown'
        ? 'QUARANTINED'
        : effect === 'partial'
          ? 'EXECUTION_FAILED'
          : failureCode || (effect === 'rolled-back' ? 'ROLLED_BACK' : 'HOST_UNAVAILABLE')
    try {
      await post(
        'planProgress',
        {
          protocol: 1,
          executionId: item.executionId,
          actionId: item.actionId,
          sequence: sequence++,
          phase: 'readback',
          index: plan.steps.length - 1,
          completed,
          total: plan.steps.length,
          effect,
          at: Date.now()
        },
        item.auth
      )
      assertExecutionCurrent(item)
      const latestReadback = createPlanReadback(item.hostContext, plan)
      let unchanged = samePlanValue(latestReadback, readback)
      if (status === 'completed') {
        try {
          for (const record of item.hostContext.nodes)
            if (plan.steps.some((step) => step.targetId === record.id))
              verifyNativeLayer(record, item.hostContext.documentId)
        } catch {
          unchanged = false
        }
      }
      if (!unchanged) {
        readback = latestReadback
        completed = readback.steps.filter((step) => step.observation === 'requested').length
        status = 'failed'
        effect = 'unknown'
        visualEvidence = undefined
        errorCode = 'QUARANTINED'
      }
      let result = await post(
        'planResult',
        {
          protocol: 1,
          executionId: item.executionId,
          actionId: item.actionId,
          status,
          effect,
          completed,
          total: plan.steps.length,
          readback,
          ...(visualEvidence ? { visualEvidence } : {}),
          ...(status === 'failed' ? { errorCode } : {})
        },
        item.auth
      )
      if (!executionCurrent(item)) return
      if (journalBlocked) {
        state(
          'Persistent action safety check blocked this write. It was not replayed. Verify the document and request a new approved plan.'
        )
        return
      }
      result = await reportPixelAudit(item, result)
      if (!executionCurrent(item)) return
      if (result && result.status && result.status.state === 'completed') {
        if (item.recovery) {
          state(
            'Accepted task properties restored and read back. Check the separate visual comparison; this is not a full-document restore.'
          )
        } else if (
          result.status.visualBaselineComparison &&
          result.status.visualBaselineComparison.exactMatch === false &&
          result.status.pixelAudit?.outcome !== 'match'
        ) {
          beginCorrectionReview(item, result.status)
        } else {
          state(
            visualEvidence
              ? result.status.visualBaselineComparison?.exactMatch === true
                ? result.status.pixelAudit?.outcome === 'match'
                  ? 'Approved result matches the accepted checkpoint in bounded exported pixels.'
                  : 'Export hashes match; a complete pixel audit has not been confirmed.'
                : 'Approved plan applied with bounded before/after visual checkpoints.'
              : 'Approved plan applied and verified by document readback.'
          )
        }
      } else if (effect === 'rolled-back')
        state('Plan failed. Applied values were rolled back and verified.')
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
      expiresAt: call.expiresAt,
      polls: 0,
      display: content,
      started: false
    }
    el('result').textContent = content
    state('Plan ready. Awaiting separate write approval in MagicPot desktop.')
    schedulePlan(planReview)
  }
  function beginCorrectionReview(source, status) {
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
      const captured = capturePhotoshopCorrectionContext(authorization)
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
          intent.expiresAt > Date.now()
        ) {
          item.started = true
          item.executionEpoch = epoch
          activeExecution = item
          planReview = null
          item.actionId = intent.actionId
          state('Executing the separately approved native plan...')
          try {
            await executeClaimedPlan(item, intent)
          } finally {
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
                  call.hostContext
                )
              : result.content
            : ''
        review = null
        if (executionReady) {
          beginPlanReview(call, displayContent)
          return
        }
        if (result.status === 'completed') el('result').textContent = displayContent
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
  async function restoreTask(requestId, rebindBaselineId, reopenDocument = false) {
    if (reopenDocument && !rebindBaselineId) return
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
    let captured
    try {
      captured = capturePhotoshopHostContext(requestId)
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
          ...(rebindBaselineId ? { rebindBaselineId } : {}),
          ...(reopenDocument ? { reopenDocument: true } : {})
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
          ['rebind']
        ) ||
        (rebindBaselineId !== undefined && recovery.baselineId !== rebindBaselineId) ||
        (recovery.rebind !== undefined &&
          (!rebindBaselineId ||
            !keys(recovery.rebind, ['previousIdentity', 'nextIdentity'], ['document']) ||
            !hex(recovery.rebind.previousIdentity, 32) ||
            !hex(recovery.rebind.nextIdentity, 32) ||
            recovery.rebind.previousIdentity === recovery.rebind.nextIdentity ||
            recovery.rebind.nextIdentity !== call.hostContext.recoveryIdentity ||
            (recovery.rebind.document !== undefined &&
              (!reopenDocument ||
                !keys(recovery.rebind.document, ['host', 'previousDocumentId', 'nextDocumentId']) ||
                recovery.rebind.document.host !== 'photoshop' ||
                typeof recovery.rebind.document.previousDocumentId !== 'string' ||
                recovery.rebind.document.previousDocumentId.length > 16 ||
                !/^[1-9][0-9]{0,15}$(?![\s\S])/.test(recovery.rebind.document.previousDocumentId) ||
                !Number.isSafeInteger(Number(recovery.rebind.document.previousDocumentId)) ||
                recovery.rebind.document.previousDocumentId ===
                  recovery.rebind.document.nextDocumentId ||
                recovery.rebind.document.nextDocumentId !== call.hostContext.documentId ||
                call.hostContext.scopeId !== call.hostContext.documentId)))) ||
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
  async function share() {
    if (activeExecution) return
    if (!config || disposed || pairing || review || !live() || !snapshot || !el('consent').checked)
      return
    const prompt = el('prompt').value.trim()
    if (!prompt || prompt.length > 16384 || sequence >= 1000000000) {
      state('Prompt is invalid or too large.')
      return
    }
    let requestId
    try {
      requestId = nonce()
    } catch {
      state('Secure randomness is unavailable.')
      return
    }
    const body = {
      protocol: 1,
      requestId,
      sequence: sequence + 1,
      prompt,
      context: snapshot,
      ...(planningSnapshot ? { featureId: 'plan-preview', hostContext: planningSnapshot } : {})
    }
    if (!bounded(JSON.stringify(body), 64 * 1024)) {
      state('Prompt and selection metadata are too large.')
      return
    }
    sequence += 1
    snapshot = null
    planningSnapshot = null
    el('consent').checked = false
    const call = {
      epoch: ++epoch,
      auth: session,
      callId: null,
      polls: 0,
      expiresAt: 0,
      hostContext: body.hostContext
    }
    review = call
    el('result').textContent = ''
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
      if (current(call))
        forget(true, 'Prepare failed. Session closed; check desktop before pairing again.')
    }
  }
  function initialize() {
    if (initialized) return
    initialized = true
    el('configuration').textContent = config
      ? HOST + ' / ' + config.pluginId + ' / ' + config.origin
      : 'Bridge configuration is invalid.'
    el('read-only-capture').addEventListener('click', captureReadOnlySnapshot)
    el('pair').addEventListener('click', () => void pair())
    el('capture').addEventListener('click', capture)
    el('plan-capture').addEventListener('click', capturePlan)
    el('restore-task').addEventListener('click', () => {
      try {
        void restoreTask(nonce())
      } catch {
        state('Recovery capture is unavailable.')
      }
    })
    el('rebind-checkpoint').addEventListener('input', () => {
      el('reopen-document').checked = false
      state()
    })
    el('rebind-task').addEventListener('click', () => {
      try {
        const reopen = el('reopen-document').checked === true
        el('reopen-document').checked = false
        void restoreTask(nonce(), el('rebind-checkpoint').value.trim(), reopen)
      } catch {
        state('Recovery reassociation is unavailable.')
      }
    })
    el('share').addEventListener('click', () => void share())
    el('prompt').addEventListener('input', () => {
      el('consent').checked = false
      state()
    })
    el('consent').addEventListener('change', () => state())
    el('cancel').addEventListener('click', cancelReview)
    el('close').addEventListener('click', () => {
      if (!disposed) forget(true, 'Session closed.')
    })
    window.addEventListener('pagehide', () => {
      if (!disposed) forget(true, 'Session closed.', true)
    })
    window.addEventListener('unload', () => {
      if (!disposed) forget(true, 'Session closed.', true)
    })
    state()
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', initialize, { once: true })
  else initialize()
})()
