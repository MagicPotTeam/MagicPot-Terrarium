;(() => {
  const HOST = 'figma'
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
  let review = null
  let sequence = 0
  let epoch = 0
  let disposed = false
  let pollTimer = null
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
    close: '/figplugin/v1/close'
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
    review = null
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
        review = null
        if (result.status === 'completed') emit({ type: 'content', text: result.content })
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
      context: snapshot
    }
    if (!bounded(JSON.stringify(body), 64 * 1024)) {
      state('Prompt and selection metadata are too large.')
      return
    }
    sequence += 1
    snapshot = null
    const call = { epoch: ++epoch, auth: session, callId: null, polls: 0, expiresAt: 0 }
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
