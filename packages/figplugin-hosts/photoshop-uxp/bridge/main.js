// Connected source only. Writes run in Photoshop's modal API after a separate desktop approval.
/* global ImageBlob */
;(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Photoshop UXP exposes native modules through CommonJS.
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
          // eslint-disable-next-line no-control-regex -- Strip control and bidi formatting characters from untrusted display labels.
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
  const secure = () => typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
  function nonce() {
    if (!secure()) throw new Error('CRYPTO')
    const data = new Uint8Array(16)
    crypto.getRandomValues(data)
    return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('')
  }
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
  let planningImagePreview = null
  let planningImageVerification = null
  let planningImageOperation = null
  const planningImageDetaches = new Set()
  let planningImageEpoch = 0
  let imageObservationUnavailable = false
  const recoveryDocumentIds = new WeakMap()
  let review = null
  let generationReview = null
  let planReview = null
  let activeExecution = null
  let sequence = 0
  let epoch = 0
  let disposed = false
  let initialized = false
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
  let sessionAssetPreview = null
  const planningAssetReferences = new Map()
  const planningAssetControls = new Map()
  let planningAssetSelectionVersion = 0
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
    planPixelAudit: '/figplugin/v1/plan/pixel-audit',
    executionAssetsRead: '/figplugin/v1/plan/assets/read',
    assetsList: '/figplugin/v1/assets/list',
    assetsRead: '/figplugin/v1/assets/read',
    generationPrepare: '/figplugin/v1/image-generation/prepare',
    generationStatus: '/figplugin/v1/image-generation/status',
    generationCancel: '/figplugin/v1/image-generation/cancel'
  })
  const el = (id) => document.getElementById(id)
  // Adobe eventcodes/executeasmodal document these named actions and modal boundaries.
  // The final three are supplemental UXP notifications, not proof of complete delivery.
  const contextImageActionEvents = Object.freeze([
    'select',
    'deselect',
    'open',
    'close',
    'make',
    'delete',
    'set',
    'move',
    'transform',
    'paint',
    'draw',
    'stroke',
    'undoEvent',
    'revert',
    'play',
    'modalJavaScriptScopeEnter',
    'modalJavaScriptScopeExit',
    'historyStateChanged',
    'layersFiltered',
    'toolModalStateChanged'
  ])
  const contextImageUiEvents = Object.freeze(['panelVisibilityChanged'])
  const contextImageOsEvents = Object.freeze(['activationChanged'])
  function nativeImagePreviewAvailable() {
    try {
      const image = el('context-image')
      return (
        typeof ImageBlob === 'function' &&
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function' &&
        typeof URL.revokeObjectURL === 'function' &&
        typeof document.createElement === 'function' &&
        image &&
        typeof image.addEventListener === 'function' &&
        typeof image.removeEventListener === 'function' &&
        typeof image.naturalWidth === 'number' &&
        typeof image.naturalHeight === 'number' &&
        image.parentNode &&
        typeof image.parentNode.replaceChild === 'function'
      )
    } catch {
      return false
    }
  }
  function contextImageCaptureAvailable() {
    try {
      const action = photoshop.action
      const core = photoshop.core
      const helper = globalThis.MagicPotVisualEvidenceV1
      return (
        !imageObservationUnavailable &&
        nativeImagePreviewAvailable() &&
        !!getPhotoshopImaging() &&
        helper &&
        typeof helper.capturePhotoshopContextImage === 'function' &&
        typeof helper.sha256 === 'function' &&
        action &&
        typeof action.addNotificationListener === 'function' &&
        typeof action.removeNotificationListener === 'function' &&
        core &&
        typeof core.addNotificationListener === 'function' &&
        typeof core.removeNotificationListener === 'function'
      )
    } catch {
      return false
    }
  }
  function removeContextImageRegistration(registration) {
    if (!registration.settled || registration.removed) return
    registration.removed = true
    try {
      const result = registration.api.removeNotificationListener(
        ...registration.args,
        registration.callback
      )
      if (!result || typeof result.then !== 'function') throw new Error('IMAGE_OBSERVER')
      const pending = Promise.resolve(result)
        .catch(() => {
          imageObservationUnavailable = true
          invalidatePlanningContextImage(
            'Native image observation failed. Use metadata capture instead.'
          )
          state()
        })
        .finally(() => {
          registration.detached = true
          planningImageDetaches.delete(pending)
          state()
        })
      planningImageDetaches.add(pending)
    } catch {
      imageObservationUnavailable = true
    }
  }
  function clearPlanningContextImage() {
    planningImageEpoch += 1
    planningContextImage = null
    planningImageBinding = null
    pendingContextImage = null
    planningImageVerification = null
    const observer = planningImageObserver
    planningImageObserver = null
    if (observer) {
      observer.active = false
      for (const registration of observer.registrations)
        removeContextImageRegistration(registration)
    }
    const preview = planningImagePreview
    planningImagePreview = null
    if (preview) {
      clearTimeout(preview.timer)
      try {
        preview.element.removeEventListener('load', preview.onload)
        preview.element.removeEventListener('error', preview.onerror)
        preview.element.removeAttribute('src')
      } catch {
        // Native preview elements may already be detached during cleanup.
      }
      try {
        URL.revokeObjectURL(preview.url)
      } catch {
        // URL cleanup is best-effort after image authority has been cleared.
      }
    }
    if (!initialized || disposed) return
    el('context-image-view').hidden = true
    el('context-image-details').textContent = ''
    el('consent').checked = false
    el('consent').disabled = false
    el('consent-description').textContent =
      'Send this prompt and selection metadata to MagicPot for desktop approval; may incur model charges only after approval'
  }
  function invalidatePlanningContextImage(text) {
    if (!planningContextImage && !pendingContextImage && !planningImageObserver) return
    snapshot = null
    planningSnapshot = null
    planningNodes = null
    clearView()
    if (text) state(text)
  }
  async function observePlanningContextImage(binding) {
    if (!contextImageCaptureAvailable()) throw new Error('CONTEXT_IMAGE_OBSERVER_UNAVAILABLE')
    const observer = { active: true, ready: false, binding, registrations: [] }
    planningImageObserver = observer
    const callback = () => {
      // Delivered events still invalidate a recapture while its old listeners are detaching.
      const pendingDetachCapture =
        !observer.active &&
        pendingContextImage !== null &&
        observer.registrations.some(
          (registration) => registration.removed && !registration.detached
        )
      if (
        pendingContextImage === binding ||
        planningImageBinding === binding ||
        pendingDetachCapture
      )
        invalidatePlanningContextImage(
          'Document, selection or host state changed. Recapture the context image and consent again.'
        )
    }
    for (const [api, args] of [
      [photoshop.action, [contextImageActionEvents]],
      [photoshop.core, ['UI', contextImageUiEvents]],
      [photoshop.core, ['OS', contextImageOsEvents]]
    ]) {
      const registration = { api, args, callback, settled: false, removed: false, detached: false }
      observer.registrations.push(registration)
      try {
        const result = api.addNotificationListener(...args, callback)
        if (!result || typeof result.then !== 'function') throw new Error('IMAGE_OBSERVER')
        await result
      } catch {
        imageObservationUnavailable = true
        throw new Error('CONTEXT_IMAGE_OBSERVER_UNAVAILABLE')
      } finally {
        registration.settled = true
        if (!observer.active) removeContextImageRegistration(registration)
      }
      if (!observer.active || pendingContextImage !== binding)
        throw new Error('STALE_CONTEXT_IMAGE')
    }
    observer.ready = true
  }
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
    if (sessionAssetTask && sessionAssetTask.epoch !== epoch) clearSessionAssets()
    label = text
    if (!initialized || disposed) return
    el('generation-prompt').disabled = generationReview !== null
    el('generation-consent').disabled = generationReview !== null
    el('generation-submit').disabled =
      !config ||
      !secure() ||
      !session ||
      pairing ||
      review !== null ||
      planReview !== null ||
      activeExecution !== null ||
      generationReview !== null ||
      pendingContextImage !== null ||
      planningImageVerification !== null ||
      planningImageOperation !== null ||
      !el('generation-consent').checked ||
      !el('generation-prompt').value.trim() ||
      el('generation-prompt').value.length > 8192
    el('generation-cancel').disabled = generationReview === null
    for (const control of planningAssetControls.values())
      control.disabled =
        !session ||
        pairing ||
        review !== null ||
        planReview !== null ||
        activeExecution !== null ||
        planningImageVerification !== null
    el('planning-assets-status').textContent = planningAssetReferences.size
      ? planningAssetReferences.size +
        ' desktop image metadata reference(s) selected. ' +
        (planningSnapshot
          ? 'Fresh Share consent and desktop model approval are required.'
          : 'Capture native plan context before sharing; ordinary metadata analysis cannot include these references.')
      : 'No desktop image metadata selected for planning.'
    el('consent-description').textContent =
      'Send this prompt and selection metadata' +
      (planningContextImage ? ' AND the exact displayed layer image' : '') +
      (planningAssetReferences.size
        ? ' AND the selected desktop image metadata (not its pixels)'
        : '') +
      ' to MagicPot for desktop approval; model use and charges require separate approval'
    el('session-assets-refresh').disabled =
      !config || !session || pairing || activeExecution !== null
    el('session-assets-clear').disabled =
      !sessionAssetCatalog && !sessionAssetTask && !sessionAssetPreview
    el('status').textContent = label
    el('read-only-capture').disabled = !secure()
    el('check-connection').disabled =
      !config ||
      !secure() ||
      session !== null ||
      pairing ||
      connectionProbe !== null ||
      review !== null ||
      planReview !== null ||
      activeExecution !== null
    el('check-readiness').disabled =
      !config || !secure() || session === null || pairing || readinessPending
    el('pair').disabled =
      !config || !secure() || session !== null || pairing || connectionProbe !== null
    el('capture').disabled =
      !config || !secure() || pairing || activeExecution !== null || generationReview !== null
    el('plan-capture').disabled =
      !config || !secure() || pairing || activeExecution !== null || generationReview !== null
    const imageAvailable = contextImageCaptureAvailable()
    el('image-capture').disabled =
      !config ||
      !secure() ||
      pairing ||
      review !== null ||
      planReview !== null ||
      activeExecution !== null ||
      generationReview !== null ||
      planningImageOperation !== null ||
      planningImageDetaches.size !== 0 ||
      !imageAvailable
    el('context-image-status').textContent =
      planningImageOperation || planningImageDetaches.size
        ? 'Waiting for the previous native image operation and listener cleanup to finish. Cancellation clears consent immediately; metadata capture remains available.'
        : imageAvailable
          ? 'Image capture is local. Native decoding and a fresh image recheck must succeed before sharing.'
          : 'Local image capture is unavailable. Native Imaging, PNG ImageBlob, intrinsic image dimensions and action/core change listeners are required. Choose metadata capture instead; no image was sent.'
    el('restore-task').disabled =
      !config ||
      !secure() ||
      !session ||
      pairing ||
      review !== null ||
      planReview !== null ||
      activeExecution !== null ||
      generationReview !== null
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
      generationReview !== null ||
      pendingContextImage !== null ||
      planningImageVerification !== null ||
      (planningContextImage !== null && planningImagePreview?.ready !== true) ||
      !snapshot ||
      !el('consent').checked ||
      !el('prompt').value.trim() ||
      el('prompt').value.length > 16384
    el('consent').disabled =
      pendingContextImage !== null ||
      planningImageVerification !== null ||
      (planningContextImage !== null && planningImagePreview?.ready !== true)
    el('cancel').disabled =
      connectionProbe === null &&
      review === null &&
      generationReview === null &&
      planReview === null &&
      activeExecution === null &&
      pendingContextImage === null &&
      planningContextImage === null &&
      sessionAssetTask === null &&
      sessionAssetPreview === null &&
      sessionAssetCatalog === null
  }
  function clearView() {
    clearPlanningContextImage()
    if (!initialized || disposed) return
    el('selection').textContent = ''
    el('result').textContent = ''
    el('consent').checked = false
  }
  const stop = () => {
    clearSessionAssets()
    if (connectionProbe) {
      connectionProbe.cancel()
      connectionProbe = null
      if (initialized && !disposed)
        el('connection-status').textContent = '连接检查已取消。 / Connection check cancelled.'
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
  // text() works in native hosts without a ReadableStream; desktop independently bounds bodies.
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
          } catch {
            // The rejected request remains cancelled even if native abort fails.
          }
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
  function clearPlanningAssets() {
    planningAssetSelectionVersion += 1
    if (planningAssetReferences.size && initialized && !disposed) el('consent').checked = false
    planningAssetReferences.clear()
    for (const control of planningAssetControls.values()) control.checked = false
  }
  function clearSessionAssets(
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
    const preview = sessionAssetPreview
    sessionAssetPreview = null
    if (preview) {
      clearTimeout(preview.timer)
      try {
        preview.image.removeEventListener('load', preview.onload)
        preview.image.removeEventListener('error', preview.onerror)
        preview.image.removeAttribute('src')
      } catch {
        // The detached native preview may already have been removed during shutdown.
      }
      try {
        URL.revokeObjectURL(preview.url)
      } catch {
        // Authority and retained bytes are cleared even when native URL cleanup fails.
      }
    }
    if (!preserveCatalog) {
      clearPlanningAssets()
      planningAssetControls.clear()
      sessionAssetCatalog = null
      sessionAssetCatalogBinding = null
    }
    if (!initialized || disposed) return
    if (!preserveCatalog) {
      el('session-assets-list').textContent = ''
      el('planning-assets-list').textContent = ''
      el('planning-assets-status').textContent = 'No desktop image metadata selected for planning.'
    }
    el('session-asset-view').hidden = true
    el('session-asset-details').textContent = ''
    el('session-assets-status').textContent = text
    el('session-assets-clear').disabled = true
  }
  function newSessionAssetTask(asset = null) {
    const listeners = new Set()
    const signal = {
      aborted: false,
      addEventListener: (_event, callback) => listeners.add(callback),
      removeEventListener: (_event, callback) => listeners.delete(callback)
    }
    const task = {
      asset,
      epoch,
      auth: session,
      signal,
      data: null,
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
        () => {
          clearSessionAssets('Desktop image catalog expired. Refresh explicitly.')
          state()
        },
        Math.max(
          0,
          Math.min(...sessionAssetCatalog.assets.map((asset) => asset.expiresAt)) - Date.now()
        )
      )
  }
  function selectedPlanningAssetReferences() {
    if (!planningAssetReferences.size) return undefined
    const binding = sessionAssetCatalogBinding
    const helper = globalThis.MagicPotPlanPreviewV1
    if (!binding || binding.auth !== session || !helper?.selectPlanningAssetReferences)
      throw new Error('ASSET_UNAVAILABLE')
    return helper.selectPlanningAssetReferences(
      sessionAssetCatalog,
      Array.from(planningAssetReferences.values()),
      sessionAssetIdentity(session, binding.projectId)
    )
  }
  function renderSessionAssetCatalog(catalog) {
    el('session-assets-list').textContent = ''
    el('planning-assets-list').textContent = ''
    planningAssetControls.clear()
    for (const asset of catalog.assets) {
      const button = document.createElement('button')
      button.textContent =
        'Preview ' +
        asset.mimeType +
        ' / ' +
        asset.width +
        ' x ' +
        asset.height +
        ' / ' +
        asset.sizeBytes +
        ' bytes / ' +
        asset.assetId
      button.addEventListener('click', () => void previewSessionAsset(asset.assetId, asset.sha256))
      el('session-assets-list').appendChild(button)
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = false
      const details = document.createElement('span')
      details.textContent =
        ' Include metadata in next native plan: ' +
        asset.assetId +
        ' / SHA-256 ' +
        asset.sha256 +
        ' / ' +
        asset.mimeType +
        ' / ' +
        asset.sizeBytes +
        ' bytes / ' +
        asset.width +
        ' x ' +
        asset.height +
        ' px / expires ' +
        new Date(asset.expiresAt).toISOString()
      checkbox.addEventListener('change', () => {
        if (
          disposed ||
          pairing ||
          review ||
          planReview ||
          activeExecution ||
          planningImageVerification ||
          !session ||
          sessionAssetCatalog !== catalog ||
          sessionAssetCatalogBinding?.auth !== session ||
          Date.now() >= asset.expiresAt
        ) {
          checkbox.checked = planningAssetReferences.has(asset.assetId)
          state()
          return
        }
        if (checkbox.checked)
          planningAssetReferences.set(
            asset.assetId,
            Object.freeze({ assetId: asset.assetId, sha256: asset.sha256 })
          )
        else planningAssetReferences.delete(asset.assetId)
        planningAssetSelectionVersion += 1
        el('consent').checked = false
        state()
      })
      planningAssetControls.set(asset.assetId, checkbox)
      label.appendChild(checkbox)
      label.appendChild(details)
      el('planning-assets-list').appendChild(label)
    }
  }
  async function refreshSessionAssets() {
    if (disposed || pairing || activeExecution || !live()) return
    clearSessionAssets('Refreshing desktop image metadata only...')
    const task = newSessionAssetTask()
    state()
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
      renderSessionAssetCatalog(catalog)
      touch(task.auth)
      el('session-assets-status').textContent = catalog.assets.length
        ? 'Catalog only. Choose one image to read its pixels. No model or document changes.'
        : 'No desktop images published to this session.'
      armSessionAssetExpiry()
      state()
    } catch {
      if (sessionAssetTask === task) {
        clearSessionAssets('Desktop image catalog unavailable or revoked. Refresh to retry.')
        state()
      }
    }
  }
  function showSessionAsset(task) {
    const asset = task.asset
    const previous = el('session-asset-image')
    if (
      !currentSessionAsset(task) ||
      typeof ImageBlob !== 'function' ||
      typeof URL?.createObjectURL !== 'function' ||
      typeof URL?.revokeObjectURL !== 'function' ||
      !previous?.parentNode ||
      typeof previous.parentNode.replaceChild !== 'function'
    )
      throw new Error('ASSET_DECODE_UNAVAILABLE')
    const image = document.createElement('img')
    if (
      typeof image.naturalWidth !== 'number' ||
      typeof image.naturalHeight !== 'number' ||
      typeof image.addEventListener !== 'function' ||
      typeof image.removeEventListener !== 'function'
    )
      throw new Error('ASSET_DECODE_UNAVAILABLE')
    image.id = 'session-asset-image'
    image.setAttribute('alt', 'Exact desktop session image, local preview only')
    const blob = new ImageBlob(new Uint8Array(task.data).buffer, { type: asset.mimeType })
    const url = URL.createObjectURL(blob)
    const preview = { image, url, task, timer: null }
    sessionAssetPreview = preview
    if (typeof url !== 'string' || !url.startsWith('blob:'))
      throw new Error('ASSET_DECODE_UNAVAILABLE')
    task.data.fill(0)
    task.data = null
    preview.onerror = () => {
      if (sessionAssetPreview !== preview) return
      clearSessionAssets(
        'Desktop image exact native decoding failed or expired. Nothing applied or converted.'
      )
      state()
    }
    preview.onload = () => {
      if (sessionAssetPreview !== preview || !currentSessionAsset(task)) return
      if (
        image.src !== url ||
        image.naturalWidth !== asset.width ||
        image.naturalHeight !== asset.height
      )
        return preview.onerror()
      clearTimeout(preview.timer)
      el('session-asset-details').textContent =
        asset.mimeType +
        ' / ' +
        asset.width +
        ' x ' +
        asset.height +
        ' px / ' +
        asset.sizeBytes +
        ' bytes / SHA-256 ' +
        asset.sha256
      el('session-asset-view').hidden = false
      el('session-assets-status').textContent =
        'Exact desktop image decoded locally. Preview only; nothing applied or sent to a model.'
      state()
    }
    image.addEventListener('load', preview.onload)
    image.addEventListener('error', preview.onerror)
    previous.parentNode.replaceChild(image, previous)
    preview.timer = setTimeout(
      preview.onerror,
      Math.max(0, Math.min(15000, asset.expiresAt - Date.now()))
    )
    image.src = url
  }
  async function previewSessionAsset(assetId, sha256) {
    if (disposed || pairing || activeExecution || !live()) return
    const catalog = sessionAssetCatalog
    const asset = catalog?.assets.find(
      (value) => value.assetId === assetId && value.sha256 === sha256
    )
    if (!asset) return
    clearSessionAssets('Reading the explicitly chosen desktop image locally...', true)
    const task = newSessionAssetTask(asset)
    armSessionAssetExpiry()
    state()
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
      showSessionAsset(task)
      armSessionAssetExpiry()
    } catch {
      if (sessionAssetTask === task) {
        clearSessionAssets(
          'Desktop image failed integrity, was revoked or cannot decode exactly. Nothing applied.'
        )
        state()
      }
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
    review = null
    generationReview = null
    planReview = null
    sequence = 0
    clearView()
    if (initialized) {
      el('ticket').value = ''
      el('readiness-status').textContent =
        '配对后可检查分层就绪。 / Pair first to check layered readiness.'
    }
    state(text)
    generationState('Session closed. No image was shared or applied.')
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
  const readinessObservation = (state, code) => ({ state, code })
  function hostReadinessProbe() {
    // Metadata-only checks: no layer IDs, names, text, or pixel data cross the bridge.
    let document = readinessObservation('not-ready', 'document-api-unavailable')
    let fonts = readinessObservation('not-ready', 'fonts-api-unavailable')
    let visual = readinessObservation('not-ready', 'visual-api-unavailable')
    try {
      const active = app && app.activeDocument
      const layers = active && (active.activeLayers || active.layers)
      const hasLayers = layers && typeof layers.length === 'number'
      document =
        active && hasLayers
          ? readinessObservation('ready', 'document-open')
          : readinessObservation('not-ready', 'document-unavailable')
      // Photoshop does not expose a loadFontAsync equivalent; text resource checks
      // happen during the native prepare phase and are intentionally unknown here.
      fonts = active
        ? readinessObservation('unknown', 'fonts-prepare-required')
        : readinessObservation('not-ready', 'fonts-document-unavailable')
      const helper = globalThis.MagicPotVisualEvidenceV1
      const imaging = getPhotoshopImaging()
      const visualApi =
        !!active &&
        !!imaging &&
        !!helper &&
        typeof helper.capturePhotoshopLayer === 'function' &&
        typeof helper.combine === 'function'
      visual = visualApi
        ? readinessObservation('ready', 'visual-api-available')
        : active
          ? readinessObservation('not-ready', 'visual-api-unavailable')
          : readinessObservation('unknown', 'visual-document-unavailable')
    } catch {
      document = readinessObservation('not-ready', 'document-probe-failed')
      fonts = readinessObservation('not-ready', 'fonts-probe-failed')
      visual = readinessObservation('not-ready', 'visual-probe-failed')
    }
    return {
      hostProbe: {
        host: HOST,
        adapterVersion: EXECUTION_ADAPTER_VERSION,
        supports: ['node.rename', 'node.opacity', 'node.visibility', 'text.content'],
        rollback: 'verified-in-place',
        visualAudit: visual.state === 'ready' ? 'hash-only' : 'unavailable',
        document,
        resources: { fonts, visual }
      }
    }
  }
  async function checkReadiness() {
    if (!config || disposed || !initialized || !session || pairing || readinessPending) return
    const auth = session
    const own = epoch
    readinessPending = true
    el('readiness-status').textContent = '正在检查分层就绪… / Checking layered readiness…'
    state()
    try {
      const value = readinessOf(
        await post('readiness', { protocol: 1, ...hostReadinessProbe() }, auth)
      )
      if (!value) throw new Error('REQUEST')
      if (disposed || own !== epoch || session !== auth) return
      touch(auth)
      el('readiness-status').textContent = JSON.stringify(value, null, 2)
    } catch (error) {
      if (disposed || own !== epoch || session !== auth) return
      el('readiness-status').textContent =
        error && error.message === 'SESSION'
          ? '会话已过期，请重新配对。 / Session expired; pair again.'
          : '就绪检查失败，可重试。 / Readiness check failed; retry.'
      if (error && error.message === 'SESSION')
        forget(false, 'Session expired or unauthorized. Pair again.')
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
  async function checkConnection() {
    if (
      !config ||
      disposed ||
      !initialized ||
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
      el('connection-status').textContent =
        '连接检查模块缺失，请更新插件。 / Connection helper missing; update the plugin.'
      return
    }
    const own = epoch
    let probe
    try {
      probe = helper.startFigPluginBridgeProbe(config.origin, nonce())
      connectionProbe = probe
      el('connection-status').textContent = '正在检查固定桌面地址… / Checking fixed desktop origin…'
      state()
      const code = await probe.result
      if (disposed || own !== epoch || connectionProbe !== probe) return
      el('connection-status').textContent = helper.bridgeProbeMessage(code)
    } catch {
      if (!disposed && own === epoch)
        el('connection-status').textContent = '连接检查不可用。 / Connection check unavailable.'
    } finally {
      if (connectionProbe === probe) connectionProbe = null
      if (!disposed && own === epoch) state()
    }
  }
  async function pair() {
    let text = el('ticket').value
    el('ticket').value = ''
    if (!config || disposed || connectionProbe || pairing || session || review) return
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
    invalidatePlanningContextImage(
      'Pairing changed the image capture session. Recapture after pairing.'
    )
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
  function cancelReview(preserveSessionAssets = false) {
    if (generationReview) {
      cancelImageGeneration()
      return
    }
    if (!preserveSessionAssets) clearSessionAssets()
    invalidatePlanningContextImage('Image capture cancelled. Capture again before sharing.')
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
    if (activeExecution || generationReview) return
    if (!config || disposed || pairing) return
    cancelReview(true)
    snapshot = null
    planningSnapshot = null
    planningNodes = null
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
  function readAppearance(layer) {
    const helper = globalThis.MagicPotPlanPreviewV1
    if (!helper || typeof helper.photoshopTextAppearance !== 'function') throw new Error('SNAPSHOT')
    try {
      return helper.photoshopTextAppearance(layer.textItem.characterStyle.color.base)
    } catch {
      return { status: 'unavailable' }
    }
  }
  function readSpatial(layer) {
    const helper = globalThis.MagicPotPlanPreviewV1
    if (!helper || typeof helper.spatialEdges !== 'function') throw new Error('SNAPSHOT')
    try {
      const bounds = layer.boundsNoEffects
      if (!bounds) return { status: 'unavailable' }
      return helper.spatialEdges(bounds.left, bounds.top, bounds.right, bounds.bottom)
    } catch {
      return { status: 'unavailable' }
    }
  }
  function readCanvas(document) {
    const helper = globalThis.MagicPotPlanPreviewV1
    if (!helper || typeof helper.canvasMetrics !== 'function') throw new Error('SNAPSHOT')
    try {
      return helper.canvasMetrics(
        document.width,
        document.height,
        document.resolution,
        document.pixelAspectRatio
      )
    } catch {
      return { status: 'unavailable' }
    }
  }
  function readTypography(layer) {
    const helper = globalThis.MagicPotPlanPreviewV1
    if (!helper || typeof helper.photoshopTypography !== 'function') throw new Error('SNAPSHOT')
    try {
      const style = layer.textItem.characterStyle
      return helper.photoshopTypography(style.font, style.size)
    } catch {
      return { status: 'unavailable' }
    }
  }
  const PIXEL_RESOURCE_BYTES = 128 * 1024 * 1024
  const PIXEL_HASH_OVERHEAD = 1024
  const PIXEL_PROFILE = 'sRGB IEC61966-2.1'
  function pixelStorage() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- UXP private temporary files are the native decoder input.
      const storage = require('uxp').storage
      if (
        typeof storage?.localFileSystem?.getTemporaryFolder !== 'function' ||
        storage.formats?.binary === undefined
      )
        throw new Error('PIXEL_IMPORT_UNAVAILABLE')
      return storage
    } catch {
      throw new Error('PIXEL_IMPORT_UNAVAILABLE')
    }
  }
  function pixelDocumentReady(document) {
    const constants = photoshop.constants
    if (
      !document ||
      constants?.DocumentMode?.RGB === undefined ||
      constants?.BitsPerChannelType?.EIGHT === undefined ||
      constants?.ChannelType?.COMPONENT === undefined ||
      document.mode !== constants.DocumentMode.RGB ||
      document.bitsPerChannel !== constants.BitsPerChannelType.EIGHT ||
      document.colorProfileName !== PIXEL_PROFILE ||
      document.quickMaskMode !== false ||
      document.selection?.bounds !== null
    )
      throw new Error('PIXEL_DOCUMENT_UNSUPPORTED')
    const components = Array.from(document.componentChannels || [])
    const active = Array.from(document.activeChannels || [])
    const names = (channels) => channels.map((channel) => channel.name).sort()
    if (
      components.length !== 3 ||
      active.length !== 3 ||
      [...components, ...active].some(
        (channel) =>
          channel.kind !== constants.ChannelType.COMPONENT || typeof channel.name !== 'string'
      ) ||
      new Set(names(components)).size !== 3 ||
      !samePlanValue(names(components), names(active))
    )
      throw new Error('PIXEL_CHANNELS_UNSUPPORTED')
  }
  function pixelBounds(value) {
    const { left, top, right, bottom } = value || {}
    if (
      ![left, top, right, bottom].every(
        (number) => Number.isSafeInteger(number) && Math.abs(number) <= 10000000
      ) ||
      right <= left ||
      bottom <= top ||
      right - left > 4096 ||
      bottom - top > 4096
    )
      throw new Error('PIXEL_BOUNDS_UNSUPPORTED')
    return { left, top, right, bottom }
  }
  const containsPixelBounds = (outer, inner) =>
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  function pixelHistory(document) {
    const id = document.activeHistoryState?.id
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('PIXEL_HISTORY_UNAVAILABLE')
    return id
  }
  function readPixelDescriptor(layer) {
    try {
      const document = layer.document
      const imaging = getPhotoshopImaging()
      if (
        typeof imaging?.putPixels !== 'function' ||
        typeof app.open !== 'function' ||
        typeof executeAsModal !== 'function' ||
        typeof globalThis.MagicPotVisualEvidenceV1?.sha256PixelBuffer !== 'function' ||
        photoshop.constants?.LayerKind?.NORMAL === undefined ||
        layer.kind !== photoshop.constants.LayerKind.NORMAL ||
        layerLocked(layer) ||
        layer.isClippingMask !== false
      )
        throw new Error('PIXEL_LAYER_UNSUPPORTED')
      pixelStorage()
      pixelDocumentReady(document)
      const bounds = pixelBounds(layer.boundsNoEffects)
      const width = bounds.right - bounds.left
      const height = bounds.bottom - bounds.top
      if (
        bounds.left < 0 ||
        bounds.top < 0 ||
        bounds.right > document.width ||
        bounds.bottom > document.height ||
        width * height * 16 + PIXEL_HASH_OVERHEAD > PIXEL_RESOURCE_BYTES
      )
        throw new Error('PIXEL_RESOURCE_LIMIT')
      return { status: 'available', historyStateId: pixelHistory(document), bounds, width, height }
    } catch {
      return { status: 'unavailable' }
    }
  }
  function verifyPixelTarget(entry, context, historyStateId) {
    const document = entry.layer.document
    if (
      app.activeDocument !== document ||
      !Array.from(app.documents || []).includes(document) ||
      String(document.id) !== context.documentId ||
      verifyNativeLayer(entry.contextNode, context.documentId) !== entry.layer ||
      findPhotoshopLayer(document, entry.step.targetId) !== entry.layer ||
      !samePlanValue(
        Array.from(document.activeLayers || [], (layer) => String(layer.id)).sort(),
        [...context.selectedIds].sort()
      ) ||
      entry.layer.kind !== photoshop.constants?.LayerKind?.NORMAL ||
      entry.layer.isClippingMask !== false ||
      (historyStateId !== undefined && pixelHistory(document) !== historyStateId)
    )
      throw new Error('STALE_CONTEXT')
    pixelDocumentReady(document)
    return document
  }
  async function readPixelPoint(document, layer, bounds, retain, retainedBytes = 0) {
    const width = bounds.right - bounds.left
    const height = bounds.bottom - bounds.top
    const byteSize = width * height * 4
    // Hashing owns a padded buffer. Dispose non-retained native data before
    // hashing; retained decoder data instead counts as a fourth live pixel buffer.
    if (retainedBytes + byteSize * (retain ? 4 : 3) + PIXEL_HASH_OVERHEAD > PIXEL_RESOURCE_BYTES)
      throw new Error('PIXEL_RESOURCE_LIMIT')
    const historyStateId = pixelHistory(document)
    if (layer && !containsPixelBounds(bounds, pixelBounds(layer.boundsNoEffects)))
      throw new Error('PIXEL_EXTENT_CHANGED')
    const result = await getPhotoshopImaging().getPixels({
      documentID: document.id,
      ...(layer ? { layerID: layer.id } : {}),
      sourceBounds: { ...bounds },
      colorSpace: 'RGB',
      colorProfile: PIXEL_PROFILE,
      componentSize: 8,
      applyAlpha: false
    })
    const imageData = result?.imageData
    let canonical
    let retained = false
    let disposedNative = false
    try {
      if (!imageData || typeof imageData.dispose !== 'function')
        throw new Error('PIXEL_DATA_UNAVAILABLE')
      const sourceBounds = pixelBounds(result.sourceBounds)
      const components = imageData.components
      if (
        result.level !== 0 ||
        !containsPixelBounds(bounds, sourceBounds) ||
        imageData.width !== sourceBounds.right - sourceBounds.left ||
        imageData.height !== sourceBounds.bottom - sourceBounds.top ||
        imageData.componentSize !== 8 ||
        imageData.colorSpace !== 'RGB' ||
        imageData.colorProfile !== PIXEL_PROFILE ||
        !(
          (components === 3 && imageData.pixelFormat === 'RGB') ||
          (components === 4 && imageData.pixelFormat === 'RGBA')
        ) ||
        (imageData.hasAlpha !== undefined && imageData.hasAlpha !== (components === 4)) ||
        (imageData.type !== undefined && imageData.type !== 'image/uncompressed') ||
        typeof imageData.getData !== 'function'
      )
        throw new Error('PIXEL_DATA_UNSUPPORTED')
      const data = await imageData.getData({ chunky: true })
      if (
        !(data instanceof Uint8Array) ||
        data.byteLength !== imageData.width * imageData.height * components ||
        pixelHistory(document) !== historyStateId ||
        (layer && !containsPixelBounds(bounds, pixelBounds(layer.boundsNoEffects)))
      )
        throw new Error('PIXEL_DATA_CHANGED')
      canonical = new Uint8Array(byteSize)
      for (let y = 0; y < imageData.height; y++) {
        for (let x = 0; x < imageData.width; x++) {
          const source = (y * imageData.width + x) * components
          const target =
            ((y + sourceBounds.top - bounds.top) * width + x + sourceBounds.left - bounds.left) * 4
          const alpha = components === 4 ? data[source + 3] : 255
          if (alpha) {
            canonical[target] = data[source]
            canonical[target + 1] = data[source + 1]
            canonical[target + 2] = data[source + 2]
            canonical[target + 3] = alpha
          }
        }
      }
      if (!retain) {
        disposedNative = true
        imageData.dispose()
      }
      const point = {
        pixelSha256: globalThis.MagicPotVisualEvidenceV1.sha256PixelBuffer(canonical),
        width,
        height,
        bounds: { ...bounds }
      }
      if (retain) {
        retain(imageData)
        retained = true
      }
      return { point, ...(retained ? { imageData, sourceBounds } : {}) }
    } finally {
      canonical?.fill(0)
      if (!retained && !disposedNative && typeof imageData?.dispose === 'function')
        imageData.dispose()
    }
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
      const typography = type === 'text' ? readTypography(layer) : undefined
      const fontKey = typography && globalThis.MagicPotPlanPreviewV1.typographyFontKey(typography)
      const commands = []
      const imagePixels = selected && !effectiveLocked ? readPixelDescriptor(layer) : undefined
      let text
      if (selected && !effectiveLocked) {
        commands.push('node.rename', 'node.visibility')
        if (opacity !== undefined) commands.push('node.opacity')
        if (imagePixels?.status === 'available') commands.push('image.pixels')
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
        spatial: readSpatial(layer),
        ...(type === 'text' ? { appearance: readAppearance(layer) } : {}),
        ...(typography ? { typography } : {}),
        ...(fontKey === undefined ? {} : { fontKey }),
        ...(opacity === undefined ? {} : { opacity }),
        commands,
        ...(imagePixels?.status === 'available' ? { imagePixels } : {}),
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
      canvas: readCanvas(document),
      nodes: Array.from(records.values()),
      selectedIds,
      execution: {
        mode: 'native-write',
        adapterVersion: EXECUTION_ADAPTER_VERSION,
        supports: [
          'node.rename',
          'node.opacity',
          'node.visibility',
          'text.content',
          ...(Array.from(records.values()).some((record) =>
            record.commands.includes('image.pixels')
          )
            ? ['image.pixels']
            : [])
        ],
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
  function contextImageBounds(layer) {
    const value = layer.boundsNoEffects
    if (!value) throw new Error('CONTEXT_IMAGE_BOUNDS')
    const { left, top, right, bottom } = value
    if (
      ![left, top, right, bottom, right - left, bottom - top].every(Number.isSafeInteger) ||
      right <= left ||
      bottom <= top
    )
      throw new Error('CONTEXT_IMAGE_BOUNDS')
    return Object.freeze({ left, top, right, bottom })
  }
  function currentContextImageIdentity(binding) {
    if (
      disposed ||
      binding.epoch !== epoch ||
      binding.imageEpoch !== planningImageEpoch ||
      binding.auth !== session ||
      (binding.auth && Math.min(binding.auth.expiresAt, binding.auth.idleAt) <= Date.now()) ||
      snapshotInstanceEpoch !== binding.instanceEpoch ||
      imageObservationUnavailable
    )
      return false
    const document = app.activeDocument
    if (
      document !== binding.document ||
      document.id !== binding.documentId ||
      document.activeLayers.length !== 1 ||
      document.activeLayers[0] !== binding.layer ||
      binding.layer.document !== document ||
      binding.layer.id !== binding.layerId ||
      document.activeHistoryState?.id !== binding.sourceSnapshot.historyStateId ||
      JSON.stringify(contextImageBounds(binding.layer)) !==
        JSON.stringify(binding.sourceSnapshot.bounds)
    )
      return false
    const fresh = capturePhotoshopHostContext(binding.revision)
    return (
      JSON.stringify(fresh.context) === binding.serializedContext &&
      fresh.nodes.size === binding.nodes.size &&
      Array.from(fresh.nodes).every(([id, layer]) => binding.nodes.get(id) === layer)
    )
  }
  function currentContextImageCapture(binding) {
    return (
      planningImageObserver?.active === true &&
      planningImageObserver.ready === true &&
      planningImageObserver.binding === binding &&
      currentContextImageIdentity(binding)
    )
  }
  function validatedContextImage(value, binding) {
    const base64 = value?.bytesBase64
    if (
      !keys(value, [
        'version',
        'kind',
        'captureId',
        'targetId',
        'mimeType',
        'width',
        'height',
        'sizeBytes',
        'sha256',
        'bytesBase64'
      ]) ||
      value.version !== 1 ||
      value.kind !== 'host-context-image' ||
      value.captureId !== binding.revision ||
      value.targetId !== String(binding.layerId) ||
      value.mimeType !== 'image/png' ||
      !Number.isInteger(value.width) ||
      value.width < 1 ||
      value.width > 256 ||
      !Number.isInteger(value.height) ||
      value.height < 1 ||
      value.height > 256 ||
      !Number.isInteger(value.sizeBytes) ||
      value.sizeBytes < 33 ||
      value.sizeBytes > 24576 ||
      !hex(value.sha256, 64) ||
      typeof base64 !== 'string' ||
      base64.length > 32768 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/.test(base64) ||
      base64.length !== 4 * Math.ceil(value.sizeBytes / 3) ||
      (base64.length * 3) / 4 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) !==
        value.sizeBytes
    )
      throw new Error('CONTEXT_IMAGE')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const data = new Uint8Array(value.sizeBytes)
    let offset = 0
    for (let index = 0; index < base64.length; index += 4) {
      const a = alphabet.indexOf(base64[index])
      const b = alphabet.indexOf(base64[index + 1])
      const c = base64[index + 2] === '=' ? 0 : alphabet.indexOf(base64[index + 2])
      const d = base64[index + 3] === '=' ? 0 : alphabet.indexOf(base64[index + 3])
      if ((base64[index + 2] === '=' && b & 15) || (base64[index + 3] === '=' && c & 3))
        throw new Error('CONTEXT_IMAGE')
      data[offset++] = (a << 2) | (b >>> 4)
      if (offset < data.length) data[offset++] = (b << 4) | (c >>> 2)
      if (offset < data.length) data[offset++] = (c << 6) | d
    }
    if (globalThis.MagicPotVisualEvidenceV1.sha256(data) !== value.sha256)
      throw new Error('CONTEXT_IMAGE')
    return { value: Object.freeze({ ...value }), data }
  }
  function showPlanningContextImage(value, data, binding) {
    if (!nativeImagePreviewAvailable() || !currentContextImageCapture(binding))
      throw new Error('CONTEXT_IMAGE_PREVIEW_UNAVAILABLE')
    // UXP documents ImageBlob for compressed PNG. Preview the exact bytes, not a JPEG re-encode.
    const image = document.createElement('img')
    if (typeof image.naturalWidth !== 'number' || typeof image.naturalHeight !== 'number')
      throw new Error('CONTEXT_IMAGE_PREVIEW_UNAVAILABLE')
    image.id = 'context-image'
    image.setAttribute('alt', 'Exact selected-layer image proposed for desktop review')
    image.setAttribute('width', String(value.width))
    image.setAttribute('height', String(value.height))
    const blob = new ImageBlob(data.buffer, { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const preview = { element: image, url, binding, value, ready: false, timer: null }
    planningImagePreview = preview
    if (typeof url !== 'string' || !url.startsWith('blob:'))
      throw new Error('CONTEXT_IMAGE_PREVIEW_UNAVAILABLE')
    preview.onerror = () => {
      if (planningImagePreview !== preview || planningImageBinding !== binding) return
      invalidatePlanningContextImage(
        'Native image preview failed or became stale. Recapture before sharing; nothing was sent.'
      )
    }
    preview.onload = () => {
      if (planningImagePreview !== preview || planningImageBinding !== binding) return
      try {
        if (
          image.src !== url ||
          !currentContextImageCapture(binding) ||
          image.naturalWidth !== value.width ||
          image.naturalHeight !== value.height
        )
          throw new Error('CONTEXT_IMAGE_PREVIEW')
        clearTimeout(preview.timer)
        preview.ready = true
        el('consent').checked = false
        state('Exact context image decoded locally. Review it, then consent again before sharing.')
      } catch {
        preview.onerror()
      }
    }
    image.addEventListener('load', preview.onload)
    image.addEventListener('error', preview.onerror)
    const previous = el('context-image')
    previous.parentNode.replaceChild(image, previous)
    preview.timer = setTimeout(preview.onerror, 15000)
    el('context-image-details').textContent =
      value.width +
      ' x ' +
      value.height +
      ' px / ' +
      value.sizeBytes +
      ' bytes / SHA-256 ' +
      value.sha256
    el('context-image-view').hidden = false
    el('consent').checked = false
    el('consent-description').textContent =
      'Send this prompt, selection metadata AND the exact displayed layer image to MagicPot for desktop approval; model use and charges require approval'
    image.src = url
  }
  async function capturePlan(includeImage = false) {
    if (generationReview) return
    if (activeExecution) return
    if (pairing || disposed || !config || !initialized) return
    if (includeImage && (review || planReview)) return
    if (includeImage && (planningImageOperation || planningImageDetaches.size)) {
      state(
        'A native image operation or listener cleanup is still pending. Wait before capturing again.'
      )
      return
    }
    const operation = includeImage ? {} : null
    if (operation) planningImageOperation = operation
    cancelReview(true)
    snapshot = null
    planningSnapshot = null
    planningNodes = null
    clearView()
    let pending = null
    try {
      const revision = nonce()
      if (snapshotInstanceEpoch === null) snapshotInstanceEpoch = nonce()
      const instanceEpoch = snapshotInstanceEpoch
      const planner = globalThis.MagicPotPlanPreviewV1
      if (!planner) throw new Error('SNAPSHOT')
      if (includeImage && app.activeDocument?.activeLayers?.length !== 1)
        throw new Error('SINGLE_IMAGE_TARGET')
      const captured = capturePhotoshopHostContext(revision)
      const full = captured.context
      let image = null
      if (includeImage) {
        if (!contextImageCaptureAvailable()) throw new Error('CONTEXT_IMAGE_OBSERVER_UNAVAILABLE')
        const document = app.activeDocument
        const layer = captured.nodes.get(full.selectedIds[0])
        const historyStateId = document.activeHistoryState?.id
        if (!Number.isSafeInteger(historyStateId) || historyStateId <= 0)
          throw new Error('CONTEXT_IMAGE_HISTORY')
        const sourceSnapshot = Object.freeze({ historyStateId, bounds: contextImageBounds(layer) })
        pending = {
          epoch,
          imageEpoch: planningImageEpoch,
          auth: session,
          instanceEpoch,
          revision,
          document,
          documentId: document.id,
          layer,
          layerId: layer.id,
          sourceSnapshot,
          nodes: captured.nodes,
          serializedContext: JSON.stringify(full)
        }
        pendingContextImage = pending
        state('Capturing one layer image locally. Nothing is sent until you explicitly share.')
        if (planningImageDetaches.size) await Promise.all(Array.from(planningImageDetaches))
        if (pendingContextImage !== pending) return
        if (!currentContextImageIdentity(pending)) throw new Error('STALE_CONTEXT_IMAGE')
        await observePlanningContextImage(pending)
        if (pendingContextImage !== pending) return
        if (!currentContextImageCapture(pending)) throw new Error('STALE_CONTEXT_IMAGE')
        const value = await globalThis.MagicPotVisualEvidenceV1.capturePhotoshopContextImage(
          getPhotoshopImaging(),
          pending.documentId,
          pending.layerId,
          revision,
          sourceSnapshot
        )
        if (pendingContextImage !== pending) return
        if (!currentContextImageCapture(pending)) throw new Error('STALE_CONTEXT_IMAGE')
        image = validatedContextImage(value, pending)
        planningContextImage = image.value
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
      el('selection').textContent = planner.formatContext(full)
      if (image) showPlanningContextImage(image.value, image.data, pending)
      state(
        image
          ? 'Loading the exact local image preview. Fresh consent is required after native decoding.'
          : 'Native plan context captured. Model output still requires a separate desktop write approval.'
      )
    } catch (error) {
      if (pending && pendingContextImage !== pending && planningImageBinding !== pending) return
      snapshot = null
      planningSnapshot = null
      planningNodes = null
      clearView()
      state(
        error?.message === 'SINGLE_IMAGE_TARGET'
          ? 'Image capture requires exactly one selected layer. Nothing was sent or changed.'
          : error?.message === 'CONTEXT_IMAGE_OBSERVER_UNAVAILABLE'
            ? 'Native image preview or change observation is unavailable. Choose metadata capture instead; nothing was sent.'
            : includeImage
              ? 'Image capture failed or became stale. Recapture one layer; PNG must fit 256 px / 24 KiB. Nothing was sent.'
              : 'Planning capture failed. No content was sent and no document was changed.'
      )
    } finally {
      // Cancelling invalidates authority immediately, but cannot cancel a native imaging Promise.
      if (operation && planningImageOperation === operation) {
        planningImageOperation = null
        state()
      }
    }
  }
  const planCommands = [
    'node.rename',
    'node.opacity',
    'node.visibility',
    'text.content',
    'image.pixels'
  ]
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
  function precheckPlan(plan, context, checkSpatial = true) {
    // Revalidate the complete planning observation before the first write, including
    // after async exports/authority/journal waits. Do not compare an old rectangle
    // after our own text/layout step has legitimately changed document geometry.
    if (
      checkSpatial &&
      context.canvas !== undefined &&
      !samePlanValue(context.canvas, readCanvas(app.activeDocument))
    )
      throw new Error('STALE_CONTEXT')
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
      const layer = verifyNativeLayer(contextNode, context.documentId)
      if (step.command === 'image.pixels') {
        if (
          contextNode.imagePixels?.status !== 'available' ||
          (checkSpatial && !samePlanValue(readPixelDescriptor(layer), contextNode.imagePixels))
        )
          throw new Error('STALE_CONTEXT')
        checked.push({ layer, contextNode, step })
        continue
      }
      if (
        step.command === 'text.content' &&
        contextNode.typography !== undefined &&
        !samePlanValue(contextNode.typography, readTypography(layer))
      )
        throw new Error('STALE_CONTEXT')
      if (
        step.command === 'text.content' &&
        contextNode.appearance !== undefined &&
        !samePlanValue(contextNode.appearance, readAppearance(layer))
      )
        throw new Error('STALE_CONTEXT')
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
  function rollbackPlanStep(
    layer,
    contextNode,
    step,
    documentId,
    appliedTypography,
    appliedAppearance
  ) {
    if (
      step.command === 'text.content' &&
      appliedAppearance !== undefined &&
      !samePlanValue(appliedAppearance, readAppearance(layer))
    )
      throw new Error('STALE_CONTEXT')
    if (
      step.command === 'text.content' &&
      appliedTypography !== undefined &&
      !samePlanValue(appliedTypography, readTypography(layer))
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
  function executionImageMetadata(planner, item, intent) {
    if (item.recovery?.images !== undefined)
      item.recovery.images = validatedRecoveryImages(item.recovery.images)
    if (intent.recovery?.images !== undefined)
      intent.recovery.images = validatedRecoveryImages(intent.recovery.images)
    if (
      (intent.recovery || item.recovery) &&
      (!intent.recovery || !item.recovery || !samePlanValue(intent.recovery, item.recovery))
    )
      throw new Error('IMAGE_RECOVERY_UNBOUND')
    const steps = intent.plan.steps.filter((step) => step.command === 'image.pixels')
    if (!steps.length) {
      if (intent.executionAssets !== undefined || item.recovery?.images !== undefined)
        throw new Error('IMAGE_RESOURCE_UNBOUND')
      return undefined
    }
    if (
      intent.visualCorrection ||
      intent.visualTargetIds ||
      !Array.isArray(intent.executionAssets) ||
      intent.executionAssets.length < 1 ||
      intent.executionAssets.length > 4 ||
      (!intent.recovery && typeof item.auth.projectId !== 'string') ||
      typeof planner.validateExecutionAsset !== 'function' ||
      typeof planner.executionAssetMetadata !== 'function' ||
      typeof planner.readExecutionAsset !== 'function'
    )
      throw new Error('IMAGE_RESOURCE_UNBOUND')
    const assets = intent.executionAssets.map((asset) =>
      planner.validateExecutionAsset(asset, sessionAssetIdentity(item.auth), Date.now())
    )
    let approved = item.planningResources
    if (intent.recovery) {
      const images = validatedRecoveryImages(item.recovery.images)
      if (
        assets.length !== images.manifest.assets.length ||
        assets.some((asset) => asset.projectId !== assets[0].projectId) ||
        images.manifest.assets.some((source) => {
          const binding = images.assetBindings.find(
            (entry) => entry.sourceAssetId === source.assetId
          )
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
      // A reload has no catalog lease. Bind only this execution's authenticated descriptors.
      item.assetProjectId = assets[0].projectId
      approved = assets.map((asset) => planner.executionAssetMetadata(asset))
    }
    if (
      new Set(assets.map((asset) => asset.assetId)).size !== assets.length ||
      assets.some(
        (asset) =>
          !steps.some((step) => step.assetId === asset.assetId && step.sha256 === asset.sha256)
      ) ||
      steps.some(
        (step) =>
          !assets.some((asset) => step.assetId === asset.assetId && step.sha256 === asset.sha256)
      ) ||
      !Array.isArray(approved) ||
      assets.some(
        (asset) =>
          !approved.some((resource) =>
            samePlanValue(resource, planner.executionAssetMetadata(asset))
          )
      )
    )
      throw new Error('IMAGE_RESOURCE_UNBOUND')
    return assets.map((asset) => planner.executionAssetMetadata(asset))
  }
  async function preparePixelResources(
    planner,
    item,
    context,
    checked,
    signal,
    deferRelease,
    meta
  ) {
    const entries = checked.filter((entry) => entry.step.command === 'image.pixels')
    const images = new Map()
    if (!entries.length) return images
    const control = item.modalContext?.hostControl
    if (
      !control ||
      typeof control.suspendHistory !== 'function' ||
      typeof control.resumeHistory !== 'function' ||
      typeof control.registerAutoCloseDocument !== 'function' ||
      typeof control.unregisterAutoCloseDocument !== 'function'
    )
      throw new Error('PIXEL_HISTORY_UNAVAILABLE')
    const uniqueAssets = new Map()
    for (const entry of entries) {
      const asset = item.lifecycleIntent.executionAssets.find(
        (asset) => asset.assetId === entry.step.assetId && asset.sha256 === entry.step.sha256
      )
      const descriptor = entry.contextNode.imagePixels
      const accepted = planner.recoveryImageTarget(
        item.recovery?.images,
        entry.step.targetId,
        entry.step.command
      )?.acceptedEvidence
      const desired = accepted || descriptor
      if (
        !asset ||
        asset.width !== desired.width ||
        asset.height !== desired.height ||
        desired.bounds.left < 0 ||
        desired.bounds.top < 0 ||
        desired.bounds.right > app.activeDocument.width ||
        desired.bounds.bottom > app.activeDocument.height
      )
        throw new Error('IMAGE_RESOURCE_DIMENSIONS')
      uniqueAssets.set(asset.assetId, asset)
    }
    const retainedBytes = Array.from(uniqueAssets.values()).reduce(
      (total, asset) => total + asset.width * asset.height * 4,
      0
    )
    const workingBytes = Math.max(
      ...entries.map(
        (entry) => entry.contextNode.imagePixels.width * entry.contextNode.imagePixels.height * 12
      ),
      ...Array.from(uniqueAssets.values(), (asset) => asset.width * asset.height * 12)
    )
    if (retainedBytes + workingBytes + PIXEL_HASH_OVERHEAD > PIXEL_RESOURCE_BYTES)
      throw new Error('PIXEL_RESOURCE_LIMIT')
    const current = () => {
      if (signal.aborted || item.modalContext?.isCancelled) throw new Error('CANCELLED')
      assertExecutionCurrent(item)
    }
    for (const entry of entries) {
      current()
      const descriptor = entry.contextNode.imagePixels
      const document = verifyPixelTarget(entry, context, descriptor.historyStateId)
      const baseline = await readPixelPoint(document, entry.layer, descriptor.bounds)
      current()
      verifyPixelTarget(entry, context, descriptor.historyStateId)
      meta.pixelProofs.set(entry.step.targetId, {
        entry,
        before: baseline.point,
        expected: null,
        wrote: false
      })
    }
    const storage = pixelStorage()
    for (const asset of uniqueAssets.values()) {
      current()
      const data = await planner.readExecutionAsset(asset, {
        identity: sessionAssetIdentity(item.auth, item.assetProjectId),
        intent: item.lifecycleIntent,
        readChunk: (request) => post('executionAssetsRead', request, item.auth, signal),
        sha256: (bytes) => globalThis.MagicPotVisualEvidenceV1.sha256SessionAsset(bytes),
        signal,
        isCurrent: () => executionCurrent(item) && !item.modalContext?.isCancelled,
        deadline: Math.min(item.expiresAt, asset.expiresAt, Date.now() + 30000)
      })
      let imported = null
      let file = null
      let registered = false
      let deleted = false
      let closed = false
      const disposeImport = async () => {
        try {
          if (imported && !closed) {
            await imported.closeWithoutSaving()
            closed = true
            if (registered) {
              control.unregisterAutoCloseDocument(imported.id)
              registered = false
            }
          }
        } finally {
          if (file && !deleted) {
            await file.delete()
            deleted = true
          }
        }
      }
      deferRelease(disposeImport)
      try {
        current()
        const folder = await storage.localFileSystem.getTemporaryFolder()
        current()
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[
          asset.mimeType
        ]
        if (!extension) throw new Error('PIXEL_IMPORT_UNSUPPORTED')
        file = await folder.createFile('magicpot-' + nonce() + '.' + extension, {
          overwrite: false
        })
        current()
        await file.write(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), {
          format: storage.formats.binary
        })
        current()
        const existingDocuments = new Set(Array.from(app.documents || []))
        const candidate = await app.open(file)
        if (
          !candidate ||
          existingDocuments.has(candidate) ||
          !Number.isSafeInteger(candidate.id) ||
          candidate.id <= 0 ||
          [...existingDocuments].some((document) => document.id === candidate.id)
        )
          throw new Error('PIXEL_IMPORT_IDENTITY')
        imported = candidate
        // Register before any cancellation check: Photoshop may forbid close after cancellation.
        control.registerAutoCloseDocument(imported.id)
        registered = true
        current()
        if (
          !Array.from(app.documents || []).includes(imported) ||
          app.activeDocument !== imported ||
          imported.width !== asset.width ||
          imported.height !== asset.height
        )
          throw new Error('IMAGE_RESOURCE_DIMENSIONS')
        const decoded = await readPixelPoint(
          imported,
          null,
          { left: 0, top: 0, right: asset.width, bottom: asset.height },
          (imageData) => deferRelease(() => imageData.dispose()),
          retainedBytes - asset.width * asset.height * 4
        )
        current()
        images.set(asset.assetId, decoded)
        await disposeImport()
        current()
        for (const entry of entries) {
          verifyPixelTarget(entry, context, entry.contextNode.imagePixels.historyStateId)
          if (entry.step.assetId === asset.assetId) {
            const proof = meta.pixelProofs.get(entry.step.targetId)
            const accepted = planner.recoveryImageTarget(
              item.recovery?.images,
              entry.step.targetId,
              entry.step.command
            )?.acceptedEvidence
            if (accepted && decoded.point.pixelSha256 !== accepted.pixelSha256)
              throw new Error('IMAGE_RECOVERY_DECODE_MISMATCH')
            proof.expected = {
              ...decoded.point,
              bounds: { ...(accepted?.bounds || entry.contextNode.imagePixels.bounds) }
            }
          }
        }
      } finally {
        data.fill(0)
      }
    }
    meta.retainedPixelBytes = retainedBytes
    deferRelease(() => {
      meta.retainedPixelBytes = 0
      images.clear()
    })
    return images
  }
  async function observePixelStep(context, step, proof, retainedBytes = 0) {
    const unknown = { targetId: step.targetId, command: step.command, observation: 'unknown' }
    if (!proof) return unknown
    // Recovery's accepted rectangle can differ from the fresh rollback baseline.
    // Observe each full rectangle independently; a thumbnail or union hash is not a proof.
    if (proof.wrote && proof.expected) {
      try {
        const document = verifyPixelTarget(proof.entry, context)
        const { point } = await readPixelPoint(
          document,
          proof.entry.layer,
          proof.expected.bounds,
          null,
          retainedBytes
        )
        verifyPixelTarget(proof.entry, context)
        if (point.pixelSha256 === proof.expected.pixelSha256)
          return {
            targetId: step.targetId,
            command: step.command,
            observation: 'requested',
            value: { assetId: step.assetId, sha256: step.sha256 },
            imageEvidence: { kind: 'photoshop-pixels', sourceSha256: step.sha256, ...point }
          }
      } catch {
        // The original state still needs its own fresh full-resolution observation.
      }
    }
    try {
      const document = verifyPixelTarget(proof.entry, context)
      const { point } = await readPixelPoint(
        document,
        proof.entry.layer,
        proof.before.bounds,
        null,
        retainedBytes
      )
      verifyPixelTarget(proof.entry, context)
      if (point.pixelSha256 === proof.before.pixelSha256) {
        const { historyStateId, bounds, width, height } = proof.entry.contextNode.imagePixels
        return {
          targetId: step.targetId,
          command: step.command,
          observation: 'original',
          value: { historyStateId, bounds, width, height }
        }
      }
    } catch {
      // Absence of a fresh full-resolution observation never becomes a cached success.
    }
    return unknown
  }
  async function createPlanReadback(context, plan, meta) {
    const nodes = new Map(context.nodes.map((node) => [node.id, node]))
    return {
      version: 1,
      kind: 'host-plan-readback',
      host: HOST,
      documentId: context.documentId,
      scopeId: context.scopeId,
      captureId: context.captureId,
      steps: await (async () => {
        const steps = []
        for (const step of plan.steps) {
          if (step.command === 'image.pixels') {
            steps.push(
              await observePixelStep(
                context,
                step,
                meta?.pixelProofs.get(step.targetId),
                meta?.retainedPixelBytes || 0
              )
            )
            continue
          }
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
          steps.push({
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
          })
        }
        return steps
      })()
    }
  }
  async function finishPixelHistory(item, plan, meta, result) {
    const transaction = meta.pixelTransaction
    if (!transaction || transaction.finished) return result
    const control = item.modalContext.hostControl
    let owned = false
    try {
      owned =
        app.activeDocument === transaction.document &&
        Array.from(app.documents || []).includes(transaction.document) &&
        pixelHistory(transaction.document) === transaction.historyStateId &&
        Array.from(meta.pixelProofs.values()).every(
          (proof) => verifyPixelTarget(proof.entry, item.hostContext) === transaction.document
        )
    } catch {
      // Lost identity, selection or editability is not permission to undo native history.
    }
    const successful =
      owned &&
      executionCurrent(item) &&
      !item.modalContext.isCancelled &&
      result?.status === 'completed' &&
      result.readback?.steps.every((step) => step.observation === 'requested')
    // A changed native history is not ours to undo. Commit the suspension without
    // replacing later edits, then report the fresh observation as uncertain.
    await control.resumeHistory(transaction.id, successful || !owned)
    transaction.finished = true
    if (!successful && owned) {
      for (const proof of meta.pixelProofs.values()) proof.wrote = false
      meta.failureCode = 'ROLLED_BACK'
    } else if (!successful) {
      meta.failureCode = 'QUARANTINED'
    }
    if (!executionCurrent(item) || item.modalContext.isCancelled)
      return { status: 'cancelled', error: { code: 'CANCELLED', retryable: false } }
    const readback = await createPlanReadback(item.hostContext, plan, meta)
    if (!successful) meta.visualEvidence = undefined
    return {
      ...result,
      ...(!successful
        ? { status: 'failed', error: { code: 'READBACK_FAILED', retryable: false } }
        : {}),
      readback
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
  function createPhotoshopPlanLifecycle(planner, item) {
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
      lastProgressSequence: 1,
      pixelProofs: new Map(),
      retainedPixelBytes: 0,
      pixelTransaction: null
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
      // context captured for this exact claim. The shared lifecycle validates
      // the host and adapter identity before preparation or any write.
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
        const checked = ownRunCollection(runId, precheckPlan(plan, context))
        const images = await preparePixelResources(
          planner,
          item,
          context,
          checked,
          signal,
          deferRelease,
          meta
        )
        const visualEntries = ownRunCollection(runId, visualEntriesForIntent(checked, item, intent))
        let beforeVisual = null
        if (context.execution.visualAudit === 'hash-only') {
          beforeVisual = ownRunCollection(
            runId,
            await capturePlanVisualPoints(visualEntries, context.documentId)
          )
          if (signal.aborted) throw new Error('CANCELLED')
          assertExecutionCurrent(item)
          const current = ownRunCollection(runId, precheckPlan(plan, context))
          visualEntries.splice(
            0,
            visualEntries.length,
            ...visualEntriesForIntent(current, item, intent)
          )
        }
        await checkExecutionAuthority(item)
        try {
          await reserveNativeAction(item, intent)
        } catch (error) {
          meta.journalBlocked = String(error?.message).startsWith('JOURNAL_')
          throw error
        }
        return {
          checked: ownRunCollection(runId, precheckPlan(plan, context)),
          visualEntries,
          beforeVisual,
          ...(images.size ? { images } : {}),
          applied: ownRunCollection(runId, [])
        }
      },
      execute: async ({ runId, context, plan, resources, signal, onProgress }) => {
        if (!resources || signal.aborted) throw new Error('CANCELLED')
        const applied = ownRunCollection(runId, [])
        try {
          if (resources.images?.size) {
            const entry = resources.checked.find((entry) => entry.step.command === 'image.pixels')
            const document = verifyPixelTarget(
              entry,
              context,
              entry.contextNode.imagePixels.historyStateId
            )
            const id = await item.modalContext.hostControl.suspendHistory({
              documentID: document.id,
              name: 'MagicPot approved image plan'
            })
            meta.pixelTransaction = {
              id,
              document,
              historyStateId: pixelHistory(document),
              finished: false
            }
          }
          for (let index = 0; index < resources.checked.length; index += 1) {
            const entry = resources.checked[index]
            if (signal.aborted) throw new Error('CANCELLED')
            assertExecutionCurrent(item)
            if (meta.pixelTransaction) {
              if (
                item.modalContext.isCancelled ||
                app.activeDocument !== meta.pixelTransaction.document ||
                pixelHistory(meta.pixelTransaction.document) !==
                  meta.pixelTransaction.historyStateId
              )
                throw new Error('STALE_CONTEXT')
              await checkExecutionAuthority(item)
              if (
                signal.aborted ||
                item.modalContext.isCancelled ||
                app.activeDocument !== meta.pixelTransaction.document ||
                pixelHistory(meta.pixelTransaction.document) !==
                  meta.pixelTransaction.historyStateId
              )
                throw new Error('STALE_CONTEXT')
              for (const asset of intent.executionAssets)
                planner.validateExecutionAsset(
                  asset,
                  sessionAssetIdentity(item.auth, item.assetProjectId),
                  Date.now()
                )
            }
            precheckPlan({ ...plan, steps: [entry.step] }, context, false)
            if (entry.step.command === 'image.pixels') {
              const proof = meta.pixelProofs.get(entry.step.targetId)
              const document = verifyPixelTarget(entry, context)
              const current = await readPixelPoint(
                document,
                entry.layer,
                proof.before.bounds,
                null,
                meta.retainedPixelBytes
              )
              if (signal.aborted || item.modalContext.isCancelled) throw new Error('CANCELLED')
              assertExecutionCurrent(item)
              await checkExecutionAuthority(item)
              if (signal.aborted || item.modalContext.isCancelled) throw new Error('CANCELLED')
              verifyPixelTarget(entry, context, meta.pixelTransaction.historyStateId)
              if (current.point.pixelSha256 !== proof.before.pixelSha256)
                throw new Error('STALE_CONTEXT')
              const image = resources.images.get(entry.step.assetId)
              await getPhotoshopImaging().putPixels({
                documentID: document.id,
                layerID: entry.layer.id,
                imageData: image.imageData,
                replace: true,
                targetBounds: {
                  left: proof.expected.bounds.left + image.sourceBounds.left,
                  top: proof.expected.bounds.top + image.sourceBounds.top
                },
                commandName: 'MagicPot approved whole pixel-layer replacement'
              })
              proof.wrote = true
            } else applyPlanStep(entry.layer, entry.step)
            if (meta.pixelTransaction)
              meta.pixelTransaction.historyStateId = pixelHistory(meta.pixelTransaction.document)
            if (entry.step.command === 'text.content') {
              entry.appliedTypography = readTypography(entry.layer)
              entry.appliedAppearance = readAppearance(entry.layer)
            }
            applied.push(entry)
            const completed = index + 1
            onProgress?.(completed, resources.checked.length)
            await post(
              'planProgress',
              {
                protocol: 1,
                executionId: item.executionId,
                actionId: item.actionId,
                ...item.lineage,
                sequence: 2 + index,
                phase: 'executing',
                index,
                completed,
                total: resources.checked.length,
                effect: completed === resources.checked.length ? 'applied' : 'partial',
                at: Date.now()
              },
              item.auth
            )
            meta.lastProgressSequence = 2 + index
            assertExecutionCurrent(item)
          }
          return { ...resources, applied }
        } catch (error) {
          for (const entry of meta.pixelTransaction ? [] : applied.reverse()) {
            try {
              if (Date.now() >= item.expiresAt) throw new Error('EXPIRED')
              rollbackPlanStep(
                entry.layer,
                entry.contextNode,
                entry.step,
                context.documentId,
                entry.appliedTypography,
                entry.appliedAppearance
              )
            } catch {
              // Continue best-effort rollback of the remaining applied steps.
            }
          }
          if (signal.aborted || !executionCurrent(item) || String(error?.message) === 'CANCELLED')
            throw new Error('CANCELLED')
          meta.failureCode = 'ROLLED_BACK'
          throw new Error('EXECUTE_FAILED')
        }
      },
      readback: async ({ runId, context, plan, execution, signal }) => {
        if (signal.aborted) throw new Error('CANCELLED')
        const validatedReadback = async () => {
          const candidate = await createPlanReadback(context, plan, meta)
          return planner.validateHostPlanReadback(
            plan,
            item.hostContext,
            candidate,
            item.lifecycleResources,
            item.recovery?.images
          )
        }
        let readback = await validatedReadback()
        const observations = readback.steps.map((step) => step.observation)
        if (meta.pixelTransaction && observations.some((value) => value !== 'requested'))
          throw new Error('READBACK_FAILED')
        if (
          observations.every((value) => value === 'requested') &&
          context.execution.visualAudit === 'hash-only'
        ) {
          try {
            const afterVisual = ownRunCollection(
              runId,
              await capturePlanVisualPoints(execution.visualEntries, context.documentId)
            )
            if (signal.aborted) throw new Error('CANCELLED')
            assertExecutionCurrent(item)
            for (const entry of execution.checked)
              verifyNativeLayer(entry.contextNode, context.documentId)
            readback = await validatedReadback()
            if (readback.steps.some((step) => step.observation !== 'requested'))
              throw new Error('STALE_CONTEXT')
            meta.visualEvidence = combinePlanVisualEvidence(
              execution.visualEntries,
              execution.beforeVisual,
              afterVisual
            )
          } catch (error) {
            if (String(error?.message) === 'CANCELLED') throw error
            for (const entry of meta.pixelTransaction ? [] : [...execution.applied].reverse()) {
              try {
                if (Date.now() >= item.expiresAt) throw new Error('EXPIRED')
                rollbackPlanStep(
                  entry.layer,
                  entry.contextNode,
                  entry.step,
                  context.documentId,
                  entry.appliedTypography,
                  entry.appliedAppearance
                )
              } catch {
                // Continue rollback of remaining steps after readback failure.
              }
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
        // Include partial preparation, but never mutate host layers or shared pixel-cache values.
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
  async function checkExecutionAuthority(item, allowReadback = false) {
    assertExecutionCurrent(item)
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
      !['claimed', 'executing', ...(allowReadback ? ['readback'] : [])].includes(status.state)
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
      } catch {
        // Missing local audit data falls back to explicit unavailable results.
      }
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
  async function reportPreparationFailure(item, plan, errorCode) {
    if (!executionCurrent(item)) return
    try {
      await post(
        'planProgress',
        {
          protocol: 1,
          executionId: item.executionId,
          actionId: item.actionId,
          ...item.lineage,
          // Claim uses sequence 1; validation fails before any step receipt.
          sequence: 2,
          phase: 'readback',
          index: 0,
          completed: 0,
          total: plan.steps.length,
          effect: 'none',
          at: Date.now()
        },
        item.auth
      )
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
          readback: await createPlanReadback(item.hostContext, plan),
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
    if (typeof executeAsModal !== 'function') {
      await reportPreparationFailure(item, intent.plan, 'HOST_UNAVAILABLE')
      delete item.lifecycleIntent
      state('Photoshop modal execution is unavailable. No document changes were made.')
      return
    }
    let lifecycle
    let meta
    let plan
    item.lifecycleIntent = intent
    try {
      item.lifecycleResources = executionImageMetadata(planner, item, intent)
      if (item.lifecycleResources) item.expiresAt = Math.min(item.expiresAt, intent.expiresAt)
      const created = createPhotoshopPlanLifecycle(planner, item)
      lifecycle = created.lifecycle
      meta = created.meta
      plan = lifecycle.validatePlan(
        intent.plan,
        item.hostContext,
        item.lifecycleResources,
        item.recovery?.images
      )
    } catch (error) {
      delete item.lifecycleIntent
      delete item.lifecycleResources
      // Keep validation failures observable and release the Bridge write
      // reservation instead of waiting for execution expiry.
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
    let modalError
    try {
      let lifecycleResult
      await executeAsModal(
        async (executionContext) => {
          item.modalContext = executionContext
          lifecycleResult = await lifecycle.run({
            runId: item.executionId,
            plan,
            context: item.hostContext,
            resources: item.lifecycleResources,
            imageRecovery: item.recovery?.images,
            signal: abort?.signal
          })
          lifecycleResult = await finishPixelHistory(item, plan, meta, lifecycleResult)
        },
        { commandName: 'MagicPot approved FIGPLUGIN plan' }
      )
      result = lifecycleResult
    } catch (error) {
      modalError = error
    } finally {
      if (watcher !== null && typeof clearInterval === 'function') clearInterval(watcher)
      delete item.lifecycleIntent
      delete item.modalContext
    }
    if (modalError && !result) {
      if (String(modalError?.message) === 'CANCELLED' || !executionCurrent(item)) return
      if (meta.pixelTransaction) {
        meta.failureCode = 'QUARANTINED'
        meta.visualEvidence = undefined
        result = {
          status: 'failed',
          error: { code: 'READBACK_FAILED', retryable: false },
          readback: await createPlanReadback(item.hostContext, plan, meta)
        }
      } else {
        // If Photoshop rejects the modal wrapper before the lifecycle can return
        // a terminal result, release the claimed execution through the same
        // no-write receipt used by other preparation failures. Without this
        // path Bridge would leave the claim reserved until expiry.
        await reportPreparationFailure(item, plan, 'HOST_UNAVAILABLE')
        return
      }
    }
    if (!result || result.status === 'cancelled' || result.error?.code === 'CANCELLED') return
    if (!executionCurrent(item)) return

    const validateReadback = (candidate) =>
      planner.validateHostPlanReadback(
        plan,
        item.hostContext,
        candidate,
        item.lifecycleResources,
        item.recovery?.images
      )
    let readback
    try {
      readback = validateReadback(
        result.readback || (await createPlanReadback(item.hostContext, plan, meta))
      )
    } catch {
      readback = await createPlanReadback(item.hostContext, plan, meta)
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
    if (meta?.journalBlocked || meta?.failureCode === 'QUARANTINED') {
      effect = 'unknown'
      meta.failureCode = 'QUARANTINED'
    }
    if (result.status !== 'completed' && effect === 'applied') effect = 'partial'
    if (!executionCurrent(item)) return
    let completed = readback.steps.filter((step) => step.observation === 'requested').length
    let status = effect === 'applied' ? 'completed' : 'failed'
    // claim uses sequence 1 and step receipts use 2..N+1; readback is N+2.
    let sequence = (meta.lastProgressSequence ?? 1) + 1
    try {
      await post(
        'planProgress',
        {
          protocol: 1,
          executionId: item.executionId,
          actionId: item.actionId,
          ...item.lineage,
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
      if (meta.pixelProofs.size) await checkExecutionAuthority(item, true)
      const latestReadback = validateReadback(
        await createPlanReadback(item.hostContext, plan, meta)
      )
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
        if (meta.pixelProofs.size) {
          state(
            item.recovery
              ? 'Accepted image content and placement restored from saved source bytes and verified by fresh full-resolution canonical sRGB RGBA readback. Hidden RGB storage and a full-document restore are not claimed.'
              : 'Approved whole pixel-layer replacement verified by fresh full-resolution canonical sRGB RGBA readback. Hidden RGB storage and a full-document restore are not claimed; later recovery needs a separate desktop approval.'
          )
        } else if (item.recovery) {
          state(
            'Accepted task properties restored and read back. Check the separate visual comparison; this is not a full-document restore.'
          )
        } else if (
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
      planningResources: call.planningResources,
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
  function generationState(text) {
    if (initialized && !disposed) {
      el('generation-status').textContent = text
      el('generation-consent').checked = false
    }
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
      planningImageVerification ||
      planningImageOperation ||
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
          } catch {
            // Non-JSON planning output remains non-executable.
          }
        }
        const displayContent =
          result.status === 'completed'
            ? call.hostContext
              ? globalThis.MagicPotPlanPreviewV1.reviewPlanningResult(
                  result.content,
                  call.hostContext,
                  call.planningResources
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
    if (generationReview) return
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
          ['rebind', 'images']
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
      if (recovery.images !== undefined) {
        recovery.images = validatedRecoveryImages(recovery.images)
        if (
          recovery.images.manifest.targets.some(
            (target) =>
              target.command !== 'image.pixels' || !recovery.targetIds.includes(target.targetId)
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
  async function share() {
    if (activeExecution || generationReview) return
    if (
      !config ||
      disposed ||
      pairing ||
      review ||
      planReview ||
      !live() ||
      !snapshot ||
      !el('consent').checked ||
      pendingContextImage ||
      planningImageVerification ||
      (planningContextImage && planningImageOperation) ||
      (planningContextImage && planningImagePreview?.ready !== true)
    )
      return
    const prompt = el('prompt').value.trim()
    if (!prompt || prompt.length > 16384 || sequence >= 1000000000) {
      state('Prompt is invalid or too large.')
      return
    }
    if (planningAssetReferences.size && !planningSnapshot) {
      el('consent').checked = false
      state(
        'Selected desktop image metadata requires a native plan context. Recapture and consent again; nothing was sent.'
      )
      return
    }
    const assetSelectionVersion = planningAssetSelectionVersion
    if (planningContextImage) {
      const image = planningContextImage
      const binding = planningImageBinding
      const verification = { image, binding, prompt }
      const operation = {}
      planningImageOperation = operation
      try {
        if (!binding || !currentContextImageCapture(binding)) throw new Error('STALE_CONTEXT_IMAGE')
        planningImageVerification = verification
        state('Rechecking the exact layer image locally before sharing. No new image is sent.')
        const result = await globalThis.MagicPotVisualEvidenceV1.capturePhotoshopContextImage(
          getPhotoshopImaging(),
          binding.documentId,
          binding.layerId,
          binding.revision,
          binding.sourceSnapshot
        )
        if (planningImageVerification !== verification) return
        const checked = validatedContextImage(result, binding).value
        if (
          planningContextImage !== image ||
          planningImageBinding !== binding ||
          planningImagePreview?.ready !== true ||
          !currentContextImageCapture(binding) ||
          el('prompt').value.trim() !== prompt ||
          !el('consent').checked ||
          !live() ||
          JSON.stringify(checked) !== JSON.stringify(image)
        )
          throw new Error('STALE_CONTEXT_IMAGE')
        // Notifications are not complete evidence: compare locally, never replace the consented PNG.
      } catch {
        if (planningImageVerification === verification || planningImageBinding === binding)
          invalidatePlanningContextImage(
            'Image verification failed or content changed. Recapture, review and consent again; nothing was sent.'
          )
        return
      } finally {
        if (planningImageOperation === operation) planningImageOperation = null
        if (planningImageVerification === verification) {
          planningImageVerification = null
        }
        state()
      }
    }
    if (assetSelectionVersion !== planningAssetSelectionVersion || !el('consent').checked) {
      el('consent').checked = false
      state(
        'Desktop image selection changed. Review the selection and consent again; nothing was sent.'
      )
      return
    }
    let assetReferences
    let planningResources
    try {
      assetReferences = selectedPlanningAssetReferences()
      if (assetReferences)
        planningResources = assetReferences.map((reference) =>
          globalThis.MagicPotPlanPreviewV1.planningAssetMetadata(
            sessionAssetCatalog.assets.find(
              (asset) => asset.assetId === reference.assetId && asset.sha256 === reference.sha256
            )
          )
        )
    } catch {
      clearSessionAssets(
        'Desktop image selection is stale or invalid. Refresh and consent again; nothing was sent.'
      )
      state()
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
    el('consent').checked = false
    const call = {
      epoch: ++epoch,
      auth: session,
      callId: null,
      polls: 0,
      expiresAt: 0,
      hostContext: body.hostContext,
      planningResources
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
    el('check-connection').addEventListener('click', () => void checkConnection())
    el('check-readiness').addEventListener('click', () => void checkReadiness())
    el('pair').addEventListener('click', () => void pair())
    el('session-assets-refresh').addEventListener('click', () => void refreshSessionAssets())
    el('session-assets-clear').addEventListener('click', () => {
      clearSessionAssets()
      state()
    })
    el('capture').addEventListener('click', capture)
    el('plan-capture').addEventListener('click', () => void capturePlan(false))
    el('image-capture').addEventListener('click', () => void capturePlan(true))
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
    el('generation-prompt').addEventListener('input', () => {
      el('generation-consent').checked = false
      state()
    })
    el('generation-consent').addEventListener('change', () => state())
    el('generation-submit').addEventListener('click', () => {
      if (!el('generation-consent').checked) return
      try {
        const prompt = el('generation-prompt').value
        el('generation-consent').checked = false
        void prepareImageGeneration(nonce(), prompt)
      } catch {
        generationState('Secure image-generation request is unavailable.')
      }
    })
    el('generation-cancel').addEventListener('click', cancelImageGeneration)
    el('prompt').addEventListener('input', () => {
      if (planningImageVerification)
        invalidatePlanningContextImage(
          'Prompt changed during image verification. Recapture and consent again.'
        )
      el('consent').checked = false
      state()
    })
    el('consent').addEventListener('change', () => {
      if (planningImageVerification)
        invalidatePlanningContextImage(
          'Consent changed during image verification. Recapture and consent again.'
        )
      state()
    })
    el('cancel').addEventListener('click', () => cancelReview())
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
