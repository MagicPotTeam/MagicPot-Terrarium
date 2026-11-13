import { fileURLToPath } from 'node:url'

// Private experiment only: this plugin is deliberately absent from product config.
const VIRTUAL_ID = 'virtual:magicpot-isolated-cpp-preview'
const RESOLVED_ID = '\0' + VIRTUAL_ID
const HOOK_IMPORT = "import { useIsolatedCppPreview } from '" + VIRTUAL_ID + "'\n"
const normalizeId = (id) => {
  const clean = id.split('?')[0].replace(/\\/g, '/')
  return process.platform === 'win32' ? clean.toLowerCase() : clean
}
const targets = [
  {
    id: normalizeId(fileURLToPath(new URL('../../../packages/app/src/renderer/src/pages/ChatPage/components/ChatComposer.tsx', import.meta.url))),
    start: 'const ComposerImageThumbnail: React.FC<{',
    end: '\nconst ATTACHMENT_PREVIEW_SCROLLBAR_GUTTER',
    anchor: '  const displaySrc = canRequestDerivative ? current?.src : src',
    replacement: "  const displaySrc = useIsolatedCppPreview(canRequestDerivative ? current?.src : src, media?.kind !== 'managed')"
  },
  {
    id: normalizeId(fileURLToPath(new URL('../../../packages/app/src/renderer/src/pages/ChatPage/components/ChatMessageList.tsx', import.meta.url))),
    start: 'const ChatImage: React.FC<{',
    end: '\nconst CopiableIconButton',
    anchor: '  const displaySrc = displaySource?.src ?? null',
    replacement: "  const displaySrc = useIsolatedCppPreview(displaySource?.src ?? null, media?.kind !== 'managed')"
  }
]

const VIRTUAL_SOURCE = String.raw`
import { useEffect, useRef, useState } from 'react'

const PNG_PREFIX = 'data:image/png;base64,'
const MAX_ENTRIES = 16
const MAX_QUEUE = 16
const MAX_SOURCE_UTF16_BYTES = 96 * 1024 * 1024
const MAX_OUTPUT_UTF16_BYTES = 8 * 1024 * 1024
const CACHE_TTL_MS = 60 * 1000
const cache = new Map()
const queue = []
let activeEntry = null
let pumpScheduled = false
let expiryTimer
let sourceBytes = 0
let outputBytes = 0

const stats = {
  enabled: 0,
  queueDepth: 0,
  activeRequests: 0,
  cacheEntries: 0,
  cacheSourceUtf16Bytes: 0,
  cacheOutputUtf16Bytes: 0,
  requestCount: 0,
  successCount: 0,
  failureCount: 0,
  cacheHitCount: 0,
  sharedPendingCount: 0,
  capacityRejectionCount: 0,
  cancelledQueuedCount: 0,
  evictedCount: 0,
  expiredCount: 0,
  staleHookResultCount: 0,
  listenerErrorCount: 0,
  peakQueueDepth: 0,
  peakActiveRequests: 0,
  peakCacheEntries: 0,
  peakSourceUtf16Bytes: 0,
  peakOutputUtf16Bytes: 0
}
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__MAGICPOT_CPP_PREVIEW_RENDERER__', {
    value: stats, configurable: true
  })
}

function publishStats() {
  stats.queueDepth = queue.length
  stats.activeRequests = activeEntry ? 1 : 0
  stats.cacheEntries = cache.size
  stats.cacheSourceUtf16Bytes = sourceBytes
  stats.cacheOutputUtf16Bytes = outputBytes
  stats.peakQueueDepth = Math.max(stats.peakQueueDepth, queue.length)
  stats.peakActiveRequests = Math.max(stats.peakActiveRequests, stats.activeRequests)
  stats.peakCacheEntries = Math.max(stats.peakCacheEntries, cache.size)
  stats.peakSourceUtf16Bytes = Math.max(stats.peakSourceUtf16Bytes, sourceBytes)
  stats.peakOutputUtf16Bytes = Math.max(stats.peakOutputUtf16Bytes, outputBytes)
}

function dropCompleted(entry, reason) {
  if (entry.state !== 'ready' && entry.state !== 'failed') return false
  if (cache.get(entry.source) !== entry) return false
  cache.delete(entry.source)
  sourceBytes -= entry.sourceBytes
  outputBytes -= entry.outputBytes
  entry.source = null
  entry.dataUrl = null
  entry.bridge = null
  entry.listeners.clear()
  if (reason === 'expired') stats.expiredCount += 1
  else stats.evictedCount += 1
  return true
}

function pruneExpired() {
  const now = Date.now()
  for (const entry of cache.values()) {
    if ((entry.state === 'ready' || entry.state === 'failed') && entry.expiresAt <= now) {
      dropCompleted(entry, 'expired')
    }
  }
}

function scheduleExpiry() {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer)
  expiryTimer = undefined
  let earliest = Infinity
  for (const entry of cache.values()) {
    if (entry.state === 'ready' || entry.state === 'failed') {
      earliest = Math.min(earliest, entry.expiresAt)
    }
  }
  if (!Number.isFinite(earliest)) return
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined
    pruneExpired()
    publishStats()
    scheduleExpiry()
  }, Math.max(1, earliest - Date.now()))
}

function evictOldestCompleted() {
  for (const entry of cache.values()) {
    if (dropCompleted(entry, 'evicted')) return true
  }
  return false
}

function makeSourceRoom(bytes) {
  if (bytes > MAX_SOURCE_UTF16_BYTES) return false
  while (cache.size >= MAX_ENTRIES || sourceBytes + bytes > MAX_SOURCE_UTF16_BYTES) {
    if (!evictOldestCompleted()) return false
  }
  return true
}

function makeOutputRoom(bytes) {
  if (bytes > MAX_OUTPUT_UTF16_BYTES) return false
  while (outputBytes + bytes > MAX_OUTPUT_UTF16_BYTES) {
    if (!evictOldestCompleted()) return false
  }
  return true
}

function touch(entry) {
  if (cache.get(entry.source) !== entry) return
  cache.delete(entry.source)
  cache.set(entry.source, entry)
}

function notify(entry, dataUrl) {
  const listeners = [...entry.listeners]
  entry.listeners.clear()
  for (const listener of listeners) {
    try { listener(dataUrl) }
    catch { stats.listenerErrorCount += 1 }
  }
}

function cancelQueued(entry) {
  if (entry.state !== 'queued') return
  const index = queue.indexOf(entry)
  if (index >= 0) queue.splice(index, 1)
  if (cache.get(entry.source) === entry) {
    cache.delete(entry.source)
    sourceBytes -= entry.sourceBytes
  }
  entry.state = 'cancelled'
  entry.source = null
  entry.bridge = null
  entry.listeners.clear()
  stats.cancelledQueuedCount += 1
  publishStats()
}

function validateOutput(value) {
  if (!value || typeof value.dataUrl !== 'string' || !value.dataUrl.startsWith(PNG_PREFIX) ||
      !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
      value.width < 1 || value.height < 1 || value.width > 512 || value.height > 512 ||
      value.dataUrl.length * 2 > MAX_OUTPUT_UTF16_BYTES) {
    throw new Error('Invalid private preview output')
  }
  return value.dataUrl
}

function requestPump() {
  if (pumpScheduled) return
  pumpScheduled = true
  queueMicrotask(() => {
    pumpScheduled = false
    if (activeEntry) return
    let entry
    while ((entry = queue.shift())) {
      if (entry.state !== 'queued') continue
      if (entry.listeners.size === 0 || entry.bridge?.enabled !== true) {
        cancelQueued(entry)
        continue
      }
      break
    }
    if (!entry || entry.state !== 'queued') {
      publishStats()
      return
    }
    activeEntry = entry
    entry.state = 'running'
    stats.requestCount += 1
    publishStats()
    // The bridge owns native decoding and its timeout. No renderer image/canvas decode.
    Promise.resolve().then(() => entry.bridge.request({ dataUrl: entry.source })).then(
      (value) => {
        const dataUrl = validateOutput(value)
        const bytes = dataUrl.length * 2
        pruneExpired()
        if (!makeOutputRoom(bytes)) throw new Error('Private preview cache is full')
        entry.state = 'ready'
        entry.dataUrl = dataUrl
        entry.outputBytes = bytes
        entry.expiresAt = Date.now() + CACHE_TTL_MS
        outputBytes += bytes
        touch(entry)
        stats.successCount += 1
        notify(entry, dataUrl)
      }
    ).catch(() => {
      entry.state = 'failed'
      entry.dataUrl = null
      entry.expiresAt = Date.now() + CACHE_TTL_MS
      stats.failureCount += 1
      notify(entry, null)
    }).finally(() => {
      activeEntry = null
      publishStats()
      scheduleExpiry()
      requestPump()
    })
  })
}

function subscribePreview(source, bridge, listener) {
  pruneExpired()
  const existing = cache.get(source)
  if (existing?.state === 'ready' || existing?.state === 'failed') {
    touch(existing)
    existing.expiresAt = Date.now() + CACHE_TTL_MS
    if (existing.state === 'ready') stats.cacheHitCount += 1
    listener(existing.dataUrl)
    publishStats()
    scheduleExpiry()
    return () => {}
  }
  let entry = existing
  if (entry) {
    stats.sharedPendingCount += 1
  } else {
    const bytes = source.length * 2
    if (queue.length >= MAX_QUEUE || !makeSourceRoom(bytes)) {
      stats.capacityRejectionCount += 1
      listener(null)
      publishStats()
      scheduleExpiry()
      return () => {}
    }
    entry = {
      source, sourceBytes: bytes, outputBytes: 0, dataUrl: null, bridge,
      state: 'queued', expiresAt: 0, listeners: new Set()
    }
    cache.set(source, entry)
    sourceBytes += bytes
    queue.push(entry)
  }
  entry.listeners.add(listener)
  publishStats()
  scheduleExpiry()
  requestPump()
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0) cancelQueued(entry)
  }
}

export function useIsolatedCppPreview(source, allowInline) {
  const bridge = typeof window === 'undefined' ? undefined : window.__MAGICPOT_CPP_PREVIEW__
  const enabled = bridge?.enabled === true
  stats.enabled = enabled ? 1 : 0
  const eligible = enabled && allowInline && typeof source === 'string' &&
    source.startsWith(PNG_PREFIX)
  const generation = useRef(0)
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    const current = ++generation.current
    if (!eligible) {
      setPreview(null)
      return () => { generation.current += 1 }
    }
    let live = true
    setPreview(null)
    const unsubscribe = subscribePreview(source, bridge, (dataUrl) => {
      if (!live || current !== generation.current) {
        stats.staleHookResultCount += 1
        return
      }
      setPreview(dataUrl ? { source, bridge, dataUrl } : null)
    })
    return () => {
      live = false
      generation.current += 1
      unsubscribe()
    }
  }, [source, bridge, eligible])

  if (!eligible) return source
  // Pending, failed and superseded work stays a placeholder; never mount the large PNG.
  return preview?.source === source && preview.bridge === bridge ? preview.dataUrl : null
}
`;

function assertOnce(source, anchor, label) {
  const first = source.indexOf(anchor)
  if (first < 0 || source.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error('Private C++ preview transform expected exactly one ' + label)
  }
  return first
}

export function createIsolatedCppPreviewPlugin() {
  return {
    name: 'magicpot-private-cpp-preview',
    enforce: 'pre',
    resolveId(id) { return id === VIRTUAL_ID ? RESOLVED_ID : null },
    load(id) { return id === RESOLVED_ID ? VIRTUAL_SOURCE : null },
    transform(source, id) {
      const target = targets.find((candidate) => candidate.id === normalizeId(id))
      if (!target) return null
      if (source.includes('useIsolatedCppPreview')) {
        throw new Error('Private C++ preview hook is already present in target source')
      }
      const start = assertOnce(source, target.start, 'component start')
      const end = assertOnce(source, target.end, 'component end')
      const anchor = assertOnce(source, target.anchor, 'display source assignment')
      if (!(start < anchor && anchor < end)) {
        throw new Error('Private C++ preview anchor is outside the expected component')
      }
      return { code: HOOK_IMPORT + source.replace(target.anchor, target.replacement), map: null }
    }
  }
}
