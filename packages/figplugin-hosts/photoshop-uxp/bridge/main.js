// Connected source only. No document mutation, modal execution, filesystem or credential APIs.
;(() => {
  const { app } = require('photoshop')
  const HOST = 'photoshop'
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
  let review = null
  let sequence = 0
  let epoch = 0
  let disposed = false
  let initialized = false
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
    el('capture').disabled = !config || !secure() || pairing
    el('share').disabled =
      !config ||
      !secure() ||
      !session ||
      pairing ||
      review !== null ||
      !snapshot ||
      !el('consent').checked ||
      !el('prompt').value.trim() ||
      el('prompt').value.length > 16384
    el('cancel').disabled = review === null
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
    if (!config || disposed || pairing) return
    cancelReview()
    snapshot = null
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
        if (result.status === 'completed') el('result').textContent = result.content
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
  async function share() {
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
    const body = { protocol: 1, requestId, sequence: sequence + 1, prompt, context: snapshot }
    if (!bounded(JSON.stringify(body), 64 * 1024)) {
      state('Prompt and selection metadata are too large.')
      return
    }
    sequence += 1
    snapshot = null
    el('consent').checked = false
    const call = { epoch: ++epoch, auth: session, callId: null, polls: 0, expiresAt: 0 }
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
