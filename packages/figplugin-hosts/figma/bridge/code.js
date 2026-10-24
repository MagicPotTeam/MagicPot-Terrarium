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
  let snapshot = null
  let planningSnapshot = null
  let planningNodes = null
  let recoveryDocumentRoot = null
  let review = null
  let planReview = null
  let activeExecution = null
  let sequence = 0
  let epoch = 0
  let disposed = false
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
    label = text
    emit({
      type: 'state',
      label,
      paired: session !== null,
      busy: pairing || review !== null || planReview !== null || activeExecution !== null
    })
  }
  const clearView = () => {
    emit({ type: 'preview', text: '', revision: '' })
    emit({ type: 'content', text: '' })
  }
  const stop = () => {
    if (connectionProbe) {
      connectionProbe.cancel()
      connectionProbe = null
    }
    epoch += 1
    clearTimeout(pollTimer)
    pollTimer = null
    clearTimeout(planPollTimer)
    planPollTimer = null
    for (const cancel of Array.from(operations)) cancel()
  }
  // No stream API is assumed: native Figma fetch supplies text(). The desktop also bounds bodies.
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
    state(text)
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
  function cancelReview() {
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
    if (activeExecution) return
    if (pairing || activeExecution) return
    cancelReview()
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
        supports: ['node.rename', 'node.opacity', 'node.visibility', 'text.content', 'layout.flow'],
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
  function capturePlan(revision, instanceEpoch) {
    if (activeExecution) return
    if (pairing || disposed || !config || activeExecution) return
    cancelReview()
    snapshot = null
    planningSnapshot = null
    planningNodes = null
    clearView()
    try {
      if (snapshotInstanceEpoch !== null && snapshotInstanceEpoch !== instanceEpoch)
        throw new Error('SNAPSHOT')
      snapshotInstanceEpoch = instanceEpoch
      const planner = globalThis.MagicPotPlanPreviewV1
      if (!planner) throw new Error('SNAPSHOT')
      const captured = captureFigmaHostContext(revision)
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
      emit({ type: 'preview', text: planner.formatContext(full), revision })
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
  const planCommands = [
    'node.rename',
    'node.opacity',
    'node.visibility',
    'text.content',
    'layout.flow'
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
                : contextNode.layout
      if (!samePlanValue(expected, baseline)) throw new Error('STALE_CONTEXT')
      checked.push({ node, contextNode, step })
    }
    return checked
  }
  function applyPlanStep(node, step) {
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
  function rollbackPlanStep(node, contextNode, step, appliedTypography, appliedAppearance) {
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
        const nativeNode = planningNodes && planningNodes.get(step.targetId)
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
          status: 'failed',
          effect: 'none',
          completed: 0,
          total: plan.steps.length,
          readback: createPlanReadback(item.hostContext, plan),
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
    let plan
    try {
      plan = planner.validateHostPlan(intent.plan, item.hostContext)
    } catch {
      state('Desktop plan validation failed. No document changes were made.')
      return
    }
    let checked
    let visualEntries
    try {
      checked = precheckPlan(plan, item.hostContext)
      visualEntries = visualEntriesForIntent(checked, item, intent)
    } catch {
      await reportPreparationFailure(item, plan, 'STALE_CONTEXT')
      state(
        'The document changed after capture or the correction scope was invalid. No plan steps were applied.'
      )
      return
    }
    let sequence = 2
    try {
      await prepareTextFonts(checked, item)
      assertExecutionCurrent(item)
      checked = precheckPlan(plan, item.hostContext)
    } catch {
      if (!executionCurrent(item)) return
      try {
        await postPlanProgress(item, sequence++, 'readback', 0, 0, plan.steps.length, 'none')
        await post(
          'planResult',
          {
            protocol: 1,
            executionId: item.executionId,
            actionId: item.actionId,
            status: 'failed',
            effect: 'none',
            completed: 0,
            total: plan.steps.length,
            readback: createPlanReadback(item.hostContext, plan),
            errorCode: 'HOST_UNAVAILABLE'
          },
          item.auth
        )
      } catch {}
      state('Font preparation failed or the text context changed. No document changes were made.')
      return
    }
    let beforeVisual = null
    if (item.hostContext.execution.visualAudit === 'hash-only') {
      try {
        beforeVisual = await capturePlanVisualPoints(visualEntries)
        assertExecutionCurrent(item)
        // Exporting is asynchronous. Re-check every native target before the first write.
        checked = precheckPlan(plan, item.hostContext)
        visualEntries = visualEntriesForIntent(checked, item, intent)
      } catch {
        if (!executionCurrent(item)) return
        const readback = createPlanReadback(item.hostContext, plan)
        try {
          await postPlanProgress(item, sequence++, 'readback', 0, 0, plan.steps.length, 'none')
          await post(
            'planResult',
            {
              protocol: 1,
              executionId: item.executionId,
              actionId: item.actionId,
              status: 'failed',
              effect: 'none',
              completed: 0,
              total: plan.steps.length,
              readback,
              errorCode: 'HOST_UNAVAILABLE'
            },
            item.auth
          )
        } catch {}
        state('Visual checkpoint capture failed. No document changes were made.')
        return
      }
    }
    try {
      await checkExecutionAuthority(item)
      await reserveNativeAction(item, intent)
      checked = precheckPlan(plan, item.hostContext)
    } catch (error) {
      if (!executionCurrent(item)) return
      if (String(error?.message).startsWith('JOURNAL_')) {
        // A previous crash may already have changed the document. Never claim
        // that a replay-blocked action had no effect or fabricate a success.
        try {
          await post(
            'planResult',
            {
              protocol: 1,
              executionId: item.executionId,
              actionId: item.actionId,
              status: 'failed',
              effect: 'unknown',
              completed: 0,
              total: plan.steps.length,
              readback: createPlanReadback(item.hostContext, plan),
              errorCode: 'QUARANTINED'
            },
            item.auth
          )
        } catch {}
        state(
          'Persistent action safety check blocked this write. It was not replayed. Verify the document and request a new approved plan.'
        )
      } else {
        await reportPreparationFailure(item, plan, 'STALE_CONTEXT')
        state('Execution permission ended or the document changed. No new writes were started.')
      }
      return
    }
    const applied = []
    let effect = 'none'
    try {
      for (let index = 0; index < checked.length; index += 1) {
        const entry = checked[index]
        assertExecutionCurrent(item)
        // Each progress receipt yields to other host edits. Revalidate this step
        // immediately before its synchronous mutation, not only before the loop.
        precheckPlan({ ...plan, steps: [entry.step] }, item.hostContext, false)
        applyPlanStep(entry.node, entry.step)
        if (entry.step.command === 'text.content') {
          entry.appliedTypography = readTypography(entry.node)
          entry.appliedAppearance = readAppearance(entry.node)
        }
        applied.push(entry)
        const completed = index + 1
        effect = completed === checked.length ? 'applied' : 'partial'
        await postPlanProgress(
          item,
          sequence++,
          'executing',
          index,
          completed,
          checked.length,
          effect
        )
        assertExecutionCurrent(item)
        state('Applying approved plan to the document... ' + completed + '/' + checked.length)
      }
    } catch {
      for (const entry of applied.reverse()) {
        try {
          // A delayed cleanup is still a write; it cannot outlive the original grant.
          if (Date.now() >= item.expiresAt) throw new Error('EXPIRED')
          rollbackPlanStep(
            entry.node,
            entry.contextNode,
            entry.step,
            entry.appliedTypography,
            entry.appliedAppearance
          )
        } catch {}
      }
      effect = applied.length ? 'rolled-back' : 'none'
    }
    let readback = createPlanReadback(item.hostContext, plan)
    let observations = readback.steps.map((step) => step.observation)
    if (observations.every((value) => value === 'requested')) effect = 'applied'
    else if (observations.every((value) => value === 'original')) effect = 'rolled-back'
    else if (observations.some((value) => value === 'requested')) effect = 'partial'
    else effect = 'unknown'

    let visualEvidence
    if (effect === 'applied' && item.hostContext.execution.visualAudit === 'hash-only') {
      try {
        const afterVisual = await capturePlanVisualPoints(visualEntries)
        assertExecutionCurrent(item)
        for (const entry of checked) verifyNativeNode(entry.contextNode)
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
              entry.node,
              entry.contextNode,
              entry.step,
              entry.appliedTypography,
              entry.appliedAppearance
            )
          } catch {}
        }
        visualEvidence = undefined
        readback = createPlanReadback(item.hostContext, plan)
        observations = readback.steps.map((step) => step.observation)
        effect = observations.every((value) => value === 'original') ? 'rolled-back' : 'unknown'
      }
    }
    if (!executionCurrent(item)) return
    let completed = readback.steps.filter((step) => step.observation === 'requested').length
    let status = effect === 'applied' ? 'completed' : 'failed'
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
      const latestReadback = createPlanReadback(item.hostContext, plan)
      let unchanged = samePlanValue(latestReadback, readback)
      if (status === 'completed') {
        try {
          for (const entry of checked) verifyNativeNode(entry.contextNode)
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
        // Do not roll back across this final yield: preserve the newer host state.
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
          ...(effect === 'rolled-back'
            ? { errorCode: 'ROLLED_BACK' }
            : effect === 'unknown'
              ? { errorCode: 'QUARANTINED' }
              : effect === 'partial'
                ? { errorCode: 'EXECUTION_FAILED' }
                : {})
        },
        item.auth
      )
      if (!executionCurrent(item)) return
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
    emit({ type: 'content', text: content })
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
          ['rebind']
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
    if (activeExecution) return
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
    const body = {
      protocol: 1,
      requestId: message.nonce,
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
    const call = {
      epoch: ++epoch,
      auth: session,
      callId: null,
      polls: 0,
      expiresAt: 0,
      hostContext: body.hostContext
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
    if (
      message.type === 'check-connection' &&
      keys(message, ['protocol', 'type', 'nonce']) &&
      hex(message.nonce, 32)
    ) {
      void checkConnection(message.nonce)
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
      message.type === 'capture-plan' &&
      keys(message, ['protocol', 'type', 'nonce', 'instanceEpoch']) &&
      hex(message.nonce, 32) &&
      hex(message.instanceEpoch, 32)
    ) {
      capturePlan(message.nonce, message.instanceEpoch)
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
      keys(message, ['protocol', 'type', 'nonce', 'revision', 'prompt', 'consent']) &&
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
  figma.on('close', () => {
    if (!disposed) forget(true, 'Session closed.', true)
  })
})()
