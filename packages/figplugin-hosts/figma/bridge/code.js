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
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$(?![\s\S])/.test(input.origin) &&
    Number(input.origin.slice(17)) >= 1024 &&
    Number(input.origin.slice(17)) <= 65535 &&
    typeof input.pluginId === 'string' &&
    input.pluginId.length <= 128 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$(?![\s\S])/.test(input.pluginId)
  const config = validConfig
    ? Object.freeze({ protocol: 1, origin: input.origin, pluginId: input.pluginId, host: HOST })
    : null
  let session = null
  let pairing = false
  let snapshot = null
  let planningSnapshot = null
  let planningNodes = null
  let review = null
  let planReview = null
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
    planClaim: '/figplugin/v1/plan/claim',
    planProgress: '/figplugin/v1/plan/progress',
    planResult: '/figplugin/v1/plan/result'
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
    emit({ type: 'state', label, paired: session !== null, busy: pairing || review !== null })
  }
  const clearView = () => {
    emit({ type: 'preview', text: '', revision: '' })
    emit({ type: 'content', text: '' })
  }
  const stop = () => {
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
  async function pair(message) {
    if (pairing || session || review) return
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
    if (pairing) return
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
  function captureFigmaHostContext(captureId) {
    const root = figma.root
    const page = figma.currentPage
    const selection = page.selection
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
      const commands = []
      let layout = null
      let text
      if (selected && !effectiveLocked) {
        commands.push('node.rename', 'node.visibility')
        if (typeof node.opacity === 'number' && Number.isFinite(node.opacity))
          commands.push('node.opacity')
        if (type === 'TEXT' && exactText(node.characters, 4096) !== null) {
          text = node.characters
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
  function capturePlan(revision, instanceEpoch) {
    if (pairing || disposed || !config) return
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
      const node = verifyNativeNode(contextNode)
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
  function rollbackPlanStep(node, contextNode, step) {
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
  async function capturePlanVisualPoints(checked) {
    const helper = getVisualEvidenceHelper()
    const captured = new Map()
    for (const entry of checked) {
      if (captured.has(entry.step.targetId)) continue
      captured.set(entry.step.targetId, await helper.captureFigmaNode(entry.node))
    }
    return captured
  }
  function combinePlanVisualEvidence(checked, before, after) {
    const helper = getVisualEvidenceHelper()
    const evidence = []
    const seen = new Set()
    for (const entry of checked) {
      const targetId = entry.step.targetId
      if (seen.has(targetId)) continue
      seen.add(targetId)
      const beforePoint = before.get(targetId)
      const afterPoint = after.get(targetId)
      if (!beforePoint || !afterPoint) throw new Error('VISUAL_EVIDENCE_UNAVAILABLE')
      evidence.push(helper.combine(targetId, beforePoint, afterPoint))
    }
    return evidence
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
  async function executeClaimedPlan(item, intent) {
    const planner = globalThis.MagicPotPlanPreviewV1
    let plan
    try {
      plan = planner.validateHostPlan(intent.plan, item.hostContext)
    } catch {
      state('Desktop plan validation failed. No document changes were made.')
      return
    }
    let checked
    try {
      checked = precheckPlan(plan, item.hostContext)
    } catch {
      state('The document changed after capture. No plan steps were applied.')
      return
    }
    let sequence = 2
    let beforeVisual = null
    if (item.hostContext.execution.visualAudit === 'hash-only') {
      try {
        beforeVisual = await capturePlanVisualPoints(checked)
        // Exporting is asynchronous. Re-check every native target before the first write.
        checked = precheckPlan(plan, item.hostContext)
      } catch {
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
    const applied = []
    let effect = 'none'
    try {
      for (let index = 0; index < checked.length; index += 1) {
        const entry = checked[index]
        applyPlanStep(entry.node, entry.step)
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
        state('Applying approved plan to the document... ' + completed + '/' + checked.length)
      }
    } catch {
      for (const entry of applied.reverse()) {
        try {
          rollbackPlanStep(entry.node, entry.contextNode, entry.step)
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
        const afterVisual = await capturePlanVisualPoints(checked)
        visualEvidence = combinePlanVisualEvidence(checked, beforeVisual, afterVisual)
      } catch {
        for (const entry of [...applied].reverse()) {
          try {
            rollbackPlanStep(entry.node, entry.contextNode, entry.step)
          } catch {}
        }
        visualEvidence = undefined
        readback = createPlanReadback(item.hostContext, plan)
        observations = readback.steps.map((step) => step.observation)
        effect = observations.every((value) => value === 'original') ? 'rolled-back' : 'unknown'
      }
    }
    const completed = readback.steps.filter((step) => step.observation === 'requested').length
    const status = effect === 'applied' ? 'completed' : 'failed'
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
      const result = await post(
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
      if (result && result.status && result.status.state === 'completed')
        state(
          visualEvidence
            ? 'Approved plan applied with bounded before/after visual checkpoints.'
            : 'Approved plan applied and verified by document readback.'
        )
      else if (effect === 'rolled-back')
        state('Plan failed. Applied values were rolled back and verified.')
      else state('Plan failed. Check MagicPot desktop for the execution receipt.')
    } catch {
      state('Execution result could not be confirmed. Check MagicPot desktop.')
    }
  }
  function beginPlanReview(call, content) {
    planReview = {
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
  const currentPlan = (item) =>
    !disposed && planReview === item && live() && Date.now() < item.expiresAt
  function schedulePlan(item) {
    if (!currentPlan(item)) return
    if (item.polls >= 120) {
      clearTimeout(planPollTimer)
      planPollTimer = null
      planReview = null
      state('Plan approval expired or polling limit reached.')
      return
    }
    planPollTimer = setTimeout(() => void pollPlan(item), 1000)
  }
  async function pollPlan(item) {
    if (!currentPlan(item)) return
    item.polls += 1
    try {
      const status = await post('planStatus', { protocol: 1, callId: item.callId }, item.auth)
      if (!currentPlan(item)) return
      if (
        !status ||
        status.protocol !== 1 ||
        typeof status.executionId !== 'string' ||
        typeof status.state !== 'string'
      )
        throw new Error('REQUEST')
      if (status.state === 'awaiting-approval') {
        state('Plan ready. Awaiting separate write approval in MagicPot desktop.')
        schedulePlan(item)
        return
      }
      if (status.state === 'approved') {
        const claim = await post('planClaim', { protocol: 1, callId: item.callId }, item.auth)
        if (!currentPlan(item)) return
        if (!claim || claim.protocol !== 1) throw new Error('REQUEST')
        if (claim.status === 'pending') {
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
          intent.executionId === status.executionId &&
          intent.callId === item.callId &&
          intent.host === HOST &&
          intent.captureId === item.hostContext.captureId &&
          intent.expiresAt > Date.now()
        ) {
          item.started = true
          planReview = null
          item.executionId = intent.executionId
          item.actionId = intent.actionId
          await executeClaimedPlan(item, intent)
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
        state('Plan status request failed. Check MagicPot desktop; polling stopped.')
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
  async function share(message) {
    if (
      pairing ||
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
