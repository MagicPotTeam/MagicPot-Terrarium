;(() => {
  const API_NAME = 'MagicPotExecutionJournalV1'
  const PREFIX = 'magicpot.figplugin.execution.v1.'
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
  const MAX_RECORDS = 256
  const MAX_KEYS = 4096
  const MAX_RECORD_BYTES = 512
  const MAX_INTENT_LIFETIME_MS = 10 * 60 * 1000
  const hex = (value, length) =>
    typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value)
  const fail = (code = 'JOURNAL_UNAVAILABLE') => {
    throw new Error(code)
  }
  // One serialization lane in this plugin runtime. Persistent storage is NOT a
  // cross-process compare-and-swap lock, nor an authority to execute an old plan.
  let queue = Promise.resolve()
  const exclusive = (work) => {
    const pending = queue.then(work)
    queue = pending.catch(() => {})
    return pending
  }
  const parse = (raw, key) => {
    if (typeof raw !== 'string' || raw.length > MAX_RECORD_BYTES) return fail()
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      return fail()
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'actionId,expiresAt,fingerprint,recordedAt,schemaVersion' ||
      value.schemaVersion !== 1 ||
      !hex(value.actionId, 32) ||
      !hex(value.fingerprint, 64) ||
      key !== PREFIX + value.actionId ||
      !Number.isSafeInteger(value.recordedAt) ||
      value.recordedAt < 0 ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= value.recordedAt ||
      value.expiresAt - value.recordedAt > MAX_INTENT_LIFETIME_MS
    )
      return fail()
    return value
  }
  const identity = (intent) => {
    if (
      !intent ||
      intent.purpose !== 'execute-host-plan' ||
      !hex(intent.actionId, 32) ||
      !hex(intent.executionId, 32) ||
      !hex(intent.callId, 32) ||
      !hex(intent.captureId, 32) ||
      !hex(intent.planSha256, 64) ||
      !['figma', 'photoshop'].includes(intent.host) ||
      !Number.isSafeInteger(intent.expiresAt)
    )
      return fail('JOURNAL_INVALID')
    for (const field of ['pluginId', 'documentId', 'scopeId', 'adapterVersion'])
      if (typeof intent[field] !== 'string' || !intent[field].length || intent[field].length > 160)
        return fail('JOURNAL_INVALID')
    const hash = globalThis.MagicPotVisualEvidenceV1?.sha256
    const encode = globalThis.MagicPotVisualEvidenceV1?.encodeUtf8
    if (typeof hash !== 'function' || typeof encode !== 'function') return fail()
    // Hash full approved payload in memory, but NEVER persist plan values,
    // design text, target names, session tokens or other bearer credentials.
    const serialized = JSON.stringify([
      intent.host,
      intent.pluginId,
      intent.executionId,
      intent.callId,
      intent.documentId,
      intent.scopeId,
      intent.captureId,
      intent.adapterVersion,
      intent.planSha256,
      intent.plan,
      intent.visualCorrection ?? null,
      intent.visualTargetIds ?? null,
      ...(intent.recovery ? ['task-recovery-v1', intent.recovery] : [])
    ])
    if (serialized.length > 65536) return fail('JOURNAL_INVALID')
    return hash(encode(serialized))
  }
  function create(storage, now = Date.now) {
    for (const method of ['read', 'write', 'keys', 'remove'])
      if (!storage || typeof storage[method] !== 'function') return fail()
    return Object.freeze({
      reserve(intent, assertCurrent = () => {}) {
        return exclusive(async () => {
          assertCurrent()
          const fingerprint = identity(intent)
          const at = now()
          if (
            !Number.isSafeInteger(at) ||
            at < 0 ||
            intent.expiresAt <= at ||
            intent.expiresAt - at > MAX_INTENT_LIFETIME_MS
          )
            return fail('JOURNAL_INVALID')
          const deadline = now() + 10000
          const call = async (method, ...args) => {
            assertCurrent()
            const remaining = Math.min(10000, deadline - now())
            if (remaining <= 0) return fail('JOURNAL_TIMEOUT')
            let timer
            try {
              return await Promise.race([
                Promise.resolve().then(() => storage[method](...args)),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error('JOURNAL_TIMEOUT')), remaining)
                })
              ])
            } finally {
              if (timer !== undefined) clearTimeout(timer)
            }
          }
          const key = PREFIX + intent.actionId
          const previous = await call('read', key)
          assertCurrent()
          // Any existing reservation blocks replay, including an incomplete or
          // rolled-back attempt. The journal cannot infer what happened in a crash.
          if (previous !== null && previous !== undefined) {
            const value = parse(previous, key)
            return fail(value.fingerprint === fingerprint ? 'JOURNAL_REPLAY' : 'JOURNAL_CONFLICT')
          }
          const keys = await call('keys')
          assertCurrent()
          if (!Array.isArray(keys) || keys.length > MAX_KEYS || new Set(keys).size !== keys.length)
            return fail()
          let retained = 0
          const expiredCandidates = []
          for (const existing of keys) {
            if (typeof existing !== 'string') return fail()
            if (!existing.startsWith(PREFIX)) continue
            if (!hex(existing.slice(PREFIX.length), 32)) return fail()
            const raw = await call('read', existing)
            assertCurrent()
            if (raw === undefined || raw === null) continue
            const record = parse(raw, existing)
            if (record.recordedAt > at) return fail()
            if (at - record.recordedAt >= RETENTION_MS && record.expiresAt <= at) {
              await call('remove', existing)
              assertCurrent()
            } else {
              retained++
              if (record.expiresAt <= at)
                expiredCandidates.push({ key: existing, recordedAt: record.recordedAt })
            }
          }
          // Expired executable intents cannot be used again. Under capacity
          // pressure discard only these oldest receipts, never a still-live
          // reservation. This is a replay fence, not a second history database.
          expiredCandidates.sort((a, b) => a.recordedAt - b.recordedAt)
          while (retained >= MAX_RECORDS && expiredCandidates.length) {
            await call('remove', expiredCandidates.shift().key)
            assertCurrent()
            retained--
          }
          if (retained >= MAX_RECORDS) return fail('JOURNAL_FULL')
          assertCurrent()
          const recordedAt = now()
          if (recordedAt < at || intent.expiresAt <= recordedAt) return fail('JOURNAL_INVALID')
          const record = {
            schemaVersion: 1,
            actionId: intent.actionId,
            fingerprint,
            recordedAt,
            expiresAt: intent.expiresAt
          }
          const text = JSON.stringify(record)
          if (text.length > MAX_RECORD_BYTES) return fail()
          await call('write', key, text)
          assertCurrent()
          const readback = await call('read', key)
          assertCurrent()
          if (readback !== text) return fail()
          if (now() >= intent.expiresAt) return fail('JOURNAL_INVALID')
          // No deletion/rollback API: an ambiguous operation requires a NEW plan
          // and fresh desktop approval, never reusing an old executable intent.
          return Object.freeze({ actionId: record.actionId, fingerprint })
        }).catch((error) => {
          const code = error?.message
          if (
            [
              'JOURNAL_UNAVAILABLE',
              'JOURNAL_INVALID',
              'JOURNAL_REPLAY',
              'JOURNAL_CONFLICT',
              'JOURNAL_FULL',
              'JOURNAL_TIMEOUT',
              'CANCELLED'
            ].includes(code)
          )
            throw new Error(code)
          return fail()
        })
      }
    })
  }
  const createFigma = (storage = globalThis.figma?.clientStorage, now) => {
    for (const method of ['getAsync', 'setAsync', 'keysAsync', 'deleteAsync'])
      if (!storage || typeof storage[method] !== 'function') return fail()
    return create(
      {
        read: (key) => storage.getAsync(key),
        write: (key, value) => storage.setAsync(key, value),
        keys: () => storage.keysAsync(),
        remove: (key) => storage.deleteAsync(key)
      },
      now
    )
  }
  const createPhotoshop = (
    storage = globalThis.localStorage ?? globalThis.window?.localStorage,
    now
  ) => {
    for (const method of ['getItem', 'setItem', 'key', 'removeItem'])
      if (!storage || typeof storage[method] !== 'function') return fail()
    return create(
      {
        read: (key) => storage.getItem(key),
        write: (key, value) => storage.setItem(key, value),
        keys: () => {
          const length = storage.length
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_KEYS) return fail()
          return Array.from({ length }, (_, index) => storage.key(index))
        },
        remove: (key) => storage.removeItem(key)
      },
      now
    )
  }
  if (Object.prototype.hasOwnProperty.call(globalThis, API_NAME)) return
  Object.defineProperty(globalThis, API_NAME, {
    value: Object.freeze({ create, createFigma, createPhotoshop }),
    configurable: false,
    enumerable: false,
    writable: false
  })
})()
