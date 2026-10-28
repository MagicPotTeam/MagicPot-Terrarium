import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { setImmediate } from 'node:timers'
import { types } from 'node:util'
import type { TrustedBackgroundRemovalDeadline } from './runner'

/** Persisted opt-in only. No defaults, migrations or generic image-profile interpretation. */
export type LocalComfyBackgroundRemovalConfig = {
  id: string
  enabled: boolean
  comfy_instance_id: string
}

/** Main-approved data, NOT server self-report, a signature issuer, or executable hooks. */
export type ApprovedLocalComfyAdapterManifest = {
  schemaVersion: 1
  adapterId: string
  adapterRevision: string
  nodes: { id: string; sha256: string }[]
  dependencies: { id: string; sha256: string }[]
  checkpoint: { sha256: string; sizeBytes: number }
  loader: {
    revision: string
    sha256: string
    offlineOnly: true
    enforcesCheckpointHashAndSize: true
  }
  output: { revision: string; format: 'RGBA8'; metadata: 'none' }
  cancellation: { revision: string; scope: 'job'; atomic: true }
}

/** Trusted-main attestor input ONLY; never send this record to a renderer or IPC. */
export type LocalComfyCandidate = Readonly<{
  requestId: string
  reference: string
  instanceId: string
  origin: string
  maxConcurrency: number
  configurationRevision: string
  epoch: number
  adapterId: string
  adapterRevision: string
  manifestDigest: string
  expiresAt: number
  monotonicDeadline: number
}>
export type LocalComfyAttestation = {
  candidate: LocalComfyCandidate
  runtimeIdentity: string
  expiresAt: number
  monotonicDeadline: number
}
export type LocalComfyLiveIdentity = {
  candidate: LocalComfyCandidate
  runtimeIdentity: string
}
export type LocalComfyCapabilityLease = Readonly<{
  id: string
  reference: string
  configurationRevision: string
  epoch: number
  manifestDigest: string
  expiresAt: number
  monotonicDeadline: number
  signal: AbortSignal
}>
export type LocalComfyCapabilityError =
  'BUSY' | 'UNAVAILABLE' | 'INVALID_REQUEST' | 'REVOKED' | 'CANCELLED' | 'EXPIRED'
export type LocalComfyCapabilityResult =
  | Readonly<{ status: 'lease'; lease: LocalComfyCapabilityLease }>
  | Readonly<{ status: 'error'; error: LocalComfyCapabilityError }>
export type LocalComfyCapabilityStatus = Readonly<{
  status: 'unavailable' | 'configured-but-unattested'
  ready: false
}>
export type TrustedLocalComfyCapabilityOptions = {
  readConfig: () => unknown
  /**
   * Subscribe synchronously, before construction returns. Every commit (even unrelated or
   * A-B-A) MUST notify synchronously. Honor lifetime abort even if installation throws;
   * the returned idempotent cleanup must remove all subscription listeners. No async install.
   */
  onConfigCommitted: (listener: () => void, lifetime: AbortSignal) => () => void
  /**
   * REQUIRED trusted-main runtime/session producer subscription, with the same synchronous
   * installation and lifetime cleanup contract as onConfigCommitted. Every identity/session
   * transition, loss of attestation validity, restart or A-B-A MUST notify synchronously,
   * before changed state is observable (including reentry and queued/nested microtasks).
   * No default probe, renderer event, JSON readiness flag or repeated identity read can supply
   * this guarantee. Missing/invalid subscription fails acquisition closed.
   */
  onRuntimeChanged: (listener: () => void, lifetime: AbortSignal) => () => void
  approvedManifest?: ApprovedLocalComfyAdapterManifest
  /**
   * Independent runtime attestation, never a generic health/queue endpoint probe. Return a
   * native Promise of plain data. JS assimilates `then` during the producer's resolution,
   * before this boundary can inspect data; that producer/settlement is trusted main code.
   */
  attest?: (candidate: LocalComfyCandidate, signal: AbortSignal) => Promise<unknown>
  /** Synchronous live identity verification of the entire candidate, not a boolean ready flag. */
  isAttestationCurrent?: (attestation: Readonly<LocalComfyAttestation>) => unknown
}
export type LocalComfyCapabilityRegistry = Readonly<{
  status: (reference: string) => LocalComfyCapabilityStatus
  /**
   * Optional signal must be a same-realm native AbortSignal (controller, any or timeout),
   * not a Proxy/subclass/custom prototype or an own aborted/addEventListener/removeEventListener
   * shadow (data OR accessor). Invalid shapes fail INVALID_REQUEST without invoking accessors.
   * Keep that shape unchanged while owned; no caller object/prototype is mutated here.
   * Global/native-prototype or private-symbol/internal-state tampering is outside this contract.
   */
  acquire: (
    reference: string,
    deadline: TrustedBackgroundRemovalDeadline
  ) => Promise<LocalComfyCapabilityResult>
  isCurrent: (lease: unknown) => boolean
  revoke: () => void
  dispose: () => void
}>

const MAX_VALIDITY_MS = 120_000
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_CONTRACT_BYTES = 16 * 1024
const PREFIX = 'local-comfy-rembg:'
const unavailable: LocalComfyCapabilityStatus = Object.freeze({
  status: 'unavailable',
  ready: false
})
const configured: LocalComfyCapabilityStatus = Object.freeze({
  status: 'configured-but-unattested',
  ready: false
})
const failure = (error: LocalComfyCapabilityError): LocalComfyCapabilityResult =>
  Object.freeze({ status: 'error', error })
function invalid(): never {
  throw new Error('Invalid capability data')
}
const token = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) &&
  !/[\r\n]/.test(value)
const sha256 = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) invalid()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  return value as Record<string, unknown>
}

/** Like the main figplugin descriptor boundary: reject Proxies BEFORE any reflection. */
function ownData(value: unknown, maxKeys = 4096): Record<string, unknown> {
  const input = record(value)
  const keys = Reflect.ownKeys(input)
  if (keys.length > maxKeys) invalid()
  const out: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || forbidden.has(key)) invalid()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid()
    out[key] = descriptor.value
  }
  return out
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const data = record(value)
  const actual = Object.keys(data)
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) invalid()
  return data
}

/**
 * Full config, not a selected subset. Undefined is retained/bound distinctly from absence.
 * Enumeration of a huge already-created plain object cannot itself be preempted; trusted
 * main must bound ingress allocations. Traversal/output here have explicit size/depth caps.
 */
function snapshot(value: unknown, maxBytes: number): unknown {
  let nodes = 0
  let bytes = 0
  const ancestors = new Set<object>()
  const count = (text: string) => {
    if (text.length > maxBytes) invalid()
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > maxBytes) invalid()
  }
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 16_384 || depth > 16 || bytes > maxBytes) invalid()
    if (typeof item === 'string') {
      if (item.length > maxBytes) invalid()
      count(JSON.stringify(item))
      return item
    }
    if (item === undefined || item === null || typeof item === 'boolean') {
      bytes += 9
      return item
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      bytes += 24
      return item
    }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) invalid()
    const array = Array.isArray(item)
    if (!array) record(item)
    else if (Object.getPrototypeOf(item) !== Array.prototype) invalid()
    const keys = Reflect.ownKeys(item)
    const length: unknown = array
      ? Object.getOwnPropertyDescriptor(item, 'length')?.value
      : undefined
    if (
      keys.length > 4097 ||
      (array &&
        (!Number.isInteger(length) ||
          (length as number) > 4096 ||
          keys.length !== (length as number) + 1))
    )
      invalid()
    const out: Record<string, unknown> = array
      ? ([] as unknown as Record<string, unknown>)
      : Object.create(null)
    ancestors.add(item)
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string' || forbidden.has(key)) invalid()
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (length as number))) invalid()
      if (key.length > maxBytes) invalid()
      count(JSON.stringify(key))
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid()
      out[key] = visit(descriptor.value, depth + 1)
    }
    ancestors.delete(item)
    return Object.freeze(out)
  }
  const data = visit(value, 0)
  if (bytes > maxBytes || Buffer.byteLength(canonical(data)) > maxBytes) invalid()
  return data
}
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Object.is(value, -0)) return '-0'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const data = value as Record<string, unknown>
    return `{${Object.keys(data)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(data[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex')
function approved(raw: unknown): Readonly<ApprovedLocalComfyAdapterManifest> {
  const data = exact(snapshot(raw, MAX_CONTRACT_BYTES), [
    'schemaVersion',
    'adapterId',
    'adapterRevision',
    'nodes',
    'dependencies',
    'checkpoint',
    'loader',
    'output',
    'cancellation'
  ])
  if (data.schemaVersion !== 1 || !token(data.adapterId) || !token(data.adapterRevision)) invalid()
  for (const list of [data.nodes, data.dependencies]) {
    if (!Array.isArray(list) || !list.length || list.length > 64) invalid()
    const ids = new Set<string>()
    for (const item of list) {
      const entry = exact(item, ['id', 'sha256'])
      if (!token(entry.id) || !sha256(entry.sha256) || ids.has(entry.id)) invalid()
      ids.add(entry.id)
    }
  }
  const checkpoint = exact(data.checkpoint, ['sha256', 'sizeBytes'])
  const loader = exact(data.loader, [
    'revision',
    'sha256',
    'offlineOnly',
    'enforcesCheckpointHashAndSize'
  ])
  const output = exact(data.output, ['revision', 'format', 'metadata'])
  const cancellation = exact(data.cancellation, ['revision', 'scope', 'atomic'])
  if (
    !sha256(checkpoint.sha256) ||
    !positiveInteger(checkpoint.sizeBytes) ||
    !token(loader.revision) ||
    !sha256(loader.sha256) ||
    loader.offlineOnly !== true ||
    loader.enforcesCheckpointHashAndSize !== true ||
    !token(output.revision) ||
    output.format !== 'RGBA8' ||
    output.metadata !== 'none' ||
    !token(cancellation.revision) ||
    cancellation.scope !== 'job' ||
    cancellation.atomic !== true
  )
    invalid()
  return data as unknown as Readonly<ApprovedLocalComfyAdapterManifest>
}
function referenceId(reference: unknown): string | undefined {
  if (
    typeof reference !== 'string' ||
    reference.length > PREFIX.length + 128 ||
    !reference.startsWith(PREFIX)
  )
    return undefined
  const id = reference.slice(PREFIX.length)
  return token(id) ? id : undefined
}
function select(config: unknown, reference: string) {
  const id = referenceId(reference)
  if (!id) invalid()
  const data = record(config)
  const capability = exact(data.background_removal_capability, [
    'id',
    'enabled',
    'comfy_instance_id'
  ])
  if (
    capability.id !== id ||
    capability.enabled !== true ||
    !token(capability.comfy_instance_id) ||
    !Array.isArray(data.comfy_batch_profiles)
  )
    invalid()
  const matches = data.comfy_batch_profiles.filter(
    (item) => record(item).id === capability.comfy_instance_id
  )
  if (matches.length !== 1) invalid()
  const instance = record(matches[0])
  if (
    instance.enabled !== true ||
    !positiveInteger(instance.maxConcurrency) ||
    typeof instance.baseUrl !== 'string'
  )
    invalid()
  // Do NOT URL-normalize aliases, port spelling, paths or credentials into an authority.
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})(\/)?$/.exec(instance.baseUrl)
  if (!match || match[0] !== instance.baseUrl || Number(match[2]) > 65535) invalid()
  return {
    instanceId: capability.comfy_instance_id,
    origin: `http://${match[1]}:${match[2]}`,
    maxConcurrency: instance.maxConcurrency
  }
}

const nativeSignalPrototype = AbortSignal.prototype
const nativeAborted = Object.getOwnPropertyDescriptor(nativeSignalPrototype, 'aborted')!.get!
const addListener = EventTarget.prototype.addEventListener
const removeListener = EventTarget.prototype.removeEventListener
function signalAborted(signal: AbortSignal): boolean {
  if (types.isProxy(signal)) invalid()
  return nativeAborted.call(signal) as boolean
}
function validateSignal(signal: AbortSignal): void {
  if (
    !signal ||
    typeof signal !== 'object' ||
    types.isProxy(signal) ||
    Object.getPrototypeOf(signal) !== nativeSignalPrototype
  )
    invalid()
  // Capturing EventTarget methods does NOT bypass Node's internal kNewListener hook:
  // on composite/timeout signals it reads this.aborted, even after linking the listener.
  for (const key of ['aborted', 'addEventListener', 'removeEventListener'])
    if (Object.getOwnPropertyDescriptor(signal, key)) invalid()
  signalAborted(signal) // Native brand check only after the descriptor/prototype boundary.
}
function listenForAbort(signal: AbortSignal, listener: () => void): () => void {
  // Node 24 addAbortListener supplies unsuppressible cancellation and disposable ownership.
  // The facade AND validated signal shape are required; native methods can call native hooks.
  // Revalidate these version-dependent semantics when upgrading the pinned Node runtime.
  const target = Object.freeze({
    aborted: signalAborted(signal),
    addEventListener: (...args: Parameters<typeof addListener>) => {
      try {
        addListener.call(signal, ...args)
      } catch (error) {
        // add may link before throwing, so op.detach has not yet been assigned. Roll back
        // the exact callback/capture supplied by trusted Node, without caller method lookup.
        removeListener.call(signal, args[0], args[1], args[2])
        throw error
      }
    },
    removeEventListener: removeListener.bind(signal)
  })
  const subscription = addAbortListener(target as AbortSignal, listener)
  return () => subscription[Symbol.dispose]()
}
function captureDeadline(input: unknown) {
  const data = ownData(input, 3)
  if (Object.keys(data).some((key) => !['expiresAt', 'monotonicDeadline', 'signal'].includes(key)))
    invalid()
  const { expiresAt, monotonicDeadline } = data
  if (
    !finite(expiresAt) ||
    !finite(monotonicDeadline) ||
    expiresAt - Date.now() > MAX_VALIDITY_MS ||
    monotonicDeadline - performance.now() > MAX_VALIDITY_MS
  )
    invalid()
  const signal = data.signal as AbortSignal | undefined
  if (signal !== undefined) validateSignal(signal)
  return { expiresAt, monotonicDeadline, signal }
}
type Operation = {
  epoch: number
  phase: 'acquiring' | 'leased'
  controller: AbortController
  expiresAt: number
  monotonicDeadline: number
  external?: AbortSignal
  detach?: () => void
  timer?: ReturnType<typeof setTimeout>
  error?: LocalComfyCapabilityError
  candidate?: LocalComfyCandidate
  attestation?: Readonly<LocalComfyAttestation>
  lease?: LocalComfyCapabilityLease
}

/**
 * MAIN ONLY, inert/unwired. No network, GPU, filesystem, pool, issuer, consent or backend.
 * Numeric loopback constrains a destination, NOT server identity. Manifest metadata/digests
 * cannot prove installed code/checkpoints/output/cancellation; independent trusted attestation
 * and live identity verification must do that. There are deliberately no production defaults.
 *
 * One owner retains one registry. One slot covers callbacks AND the outstanding lease. Abort
 * is synchronous but uncooperative dispatched work retains capacity until settlement: no race
 * frees the slot, no hard realtime completion promise. Every owner must use the same explicit
 * pre-choice dual deadline. A lease is NOT runnable authority or the runner's synthetic backend.
 * Options/hooks and promise scheduling are trusted main, not an in-process hostile-code sandbox.
 * Runtime/config producers MUST synchronously revoke via their lifetime-owned subscriptions;
 * callbacks can invalidate each other's reads, so arbitrary extra reads cannot replace events.
 */
export function createLocalComfyCapabilityRegistry(
  options: TrustedLocalComfyCapabilityOptions
): LocalComfyCapabilityRegistry {
  const revisionKey = randomBytes(32)
  const lifetime = new AbortController()
  let epoch = 0
  let busy = 1 // Reserve before subscription installation can reenter through its listener.
  let initializing = true
  let unavailableSubscription = false
  let disposed = false
  let active: Operation | undefined
  const subscriptions: (() => void)[] = []
  let readConfig: TrustedLocalComfyCapabilityOptions['readConfig'] | undefined
  let attest: TrustedLocalComfyCapabilityOptions['attest']
  let currentIdentity: TrustedLocalComfyCapabilityOptions['isAttestationCurrent']
  let manifest: Readonly<ApprovedLocalComfyAdapterManifest> | undefined
  let manifestDigest: string | undefined

  function cleanupSubscription(): void {
    const cleanups = subscriptions.splice(0)
    lifetime.abort()
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        /* Fail closed; lifetime abort also owns cleanup, including failed installations. */
      }
    }
  }
  function detach(op: Operation): void {
    clearTimeout(op.timer)
    op.timer = undefined
    const cleanup = op.detach
    op.detach = undefined
    cleanup?.()
  }
  function stop(op: Operation, error: LocalComfyCapabilityError): void {
    if (op.error) return
    op.error = error
    detach(op)
    op.attestation = undefined
    // Keep active reserved THROUGH synchronous abort listeners before allowing replacement.
    op.controller.abort()
    if (op.phase === 'leased' && active === op) active = undefined
  }
  function revoke(): void {
    epoch++
    if (!Number.isSafeInteger(epoch)) {
      disposed = true
      cleanupSubscription()
    }
    if (active) stop(active, 'REVOKED')
  }
  function changed(): void {
    if (initializing) unavailableSubscription = true
    revoke()
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    busy++
    try {
      revoke()
      cleanupSubscription()
    } finally {
      busy--
    }
  }
  function localGuard(op: Operation): boolean {
    if (!op.error) {
      if (disposed || active !== op || op.epoch !== epoch) stop(op, 'REVOKED')
      else if (Date.now() >= op.expiresAt || performance.now() >= op.monotonicDeadline)
        stop(op, 'EXPIRED')
      else if (op.external && signalAborted(op.external)) stop(op, 'CANCELLED')
    }
    return !op.error
  }
  function schedule(op: Operation): void {
    clearTimeout(op.timer)
    if (!localGuard(op)) return
    const remaining = Math.min(op.expiresAt - Date.now(), op.monotonicDeadline - performance.now())
    op.timer = setTimeout(
      () => {
        if (localGuard(op)) schedule(op)
      },
      Math.max(1, Math.ceil(remaining))
    )
    op.timer.unref?.()
  }
  function revision(data: unknown): string {
    // Process-local opaque SHA256, salted so public revisions are not credential guess oracles.
    return createHash('sha256')
      .update('MagicPot.LocalComfy.Config.v1\0')
      .update(revisionKey)
      .update(canonical(data))
      .digest('hex')
  }
  function read() {
    const raw = readConfig!()
    const data = snapshot(raw, MAX_CONFIG_BYTES)
    return { raw, data, revision: revision(data) }
  }
  function readback(op: Operation): unknown {
    const config = read()
    if (!localGuard(op)) return undefined
    if (config.revision !== op.candidate!.configurationRevision) stop(op, 'REVOKED')
    return config.raw
  }
  function unchangedReadback(op: Operation, raw: unknown): boolean {
    if (!localGuard(op)) return false
    if (revision(snapshot(raw, MAX_CONFIG_BYTES)) !== op.candidate!.configurationRevision)
      stop(op, 'REVOKED')
    return localGuard(op)
  }
  function verifiedIdentity(op: Operation): boolean {
    if (!localGuard(op)) return false
    const raw = currentIdentity!(op.attestation!)
    if (!localGuard(op)) return false
    const value = exact(snapshot(raw, MAX_CONTRACT_BYTES), ['candidate', 'runtimeIdentity'])
    if (
      value.runtimeIdentity !== op.attestation!.runtimeIdentity ||
      canonical(value.candidate) !== canonical(op.candidate)
    ) {
      stop(op, 'REVOKED')
      return false
    }
    return true
  }

  try {
    const data = ownData(options, 6)
    if (
      Object.keys(data).some(
        (key) =>
          ![
            'readConfig',
            'onConfigCommitted',
            'onRuntimeChanged',
            'approvedManifest',
            'attest',
            'isAttestationCurrent'
          ].includes(key)
      )
    )
      invalid()
    const callable = (value: unknown): value is (...args: never[]) => unknown =>
      typeof value === 'function' && !types.isProxy(value)
    if (
      !callable(data.readConfig) ||
      !callable(data.onConfigCommitted) ||
      !callable(data.onRuntimeChanged)
    )
      invalid()
    readConfig = data.readConfig as typeof readConfig
    if (callable(data.attest)) attest = data.attest as typeof attest
    if (callable(data.isAttestationCurrent))
      currentIdentity = data.isAttestationCurrent as typeof currentIdentity
    try {
      manifest = approved(data.approvedManifest)
      manifestDigest = digest(manifest)
    } catch {
      /* No approved contract means acquire stays unavailable. */
    }
    for (const subscribe of [data.onConfigCommitted, data.onRuntimeChanged]) {
      const cleanup = (subscribe as TrustedLocalComfyCapabilityOptions['onConfigCommitted'])(
        changed,
        lifetime.signal
      )
      if (!callable(cleanup)) invalid()
      subscriptions.push(cleanup)
      if (unavailableSubscription) invalid()
    }
  } catch {
    unavailableSubscription = true
  } finally {
    initializing = false
    if (unavailableSubscription) cleanupSubscription()
    busy--
  }

  function status(reference: string): LocalComfyCapabilityStatus {
    if (
      busy ||
      active?.phase === 'acquiring' ||
      disposed ||
      unavailableSubscription ||
      !referenceId(reference)
    )
      return unavailable
    busy++
    const capturedEpoch = epoch
    try {
      select(read().data, reference)
      return !disposed && epoch === capturedEpoch ? configured : unavailable
    } catch {
      return unavailable
    } finally {
      busy--
    }
  }
  async function acquire(
    reference: string,
    deadline: TrustedBackgroundRemovalDeadline
  ): Promise<LocalComfyCapabilityResult> {
    if (busy || active) return failure('BUSY')
    if (
      disposed ||
      unavailableSubscription ||
      !manifest ||
      !manifestDigest ||
      !attest ||
      !currentIdentity
    )
      return failure('UNAVAILABLE')
    const op: Operation = {
      epoch,
      phase: 'acquiring',
      controller: new AbortController(),
      expiresAt: Infinity,
      monotonicDeadline: Infinity
    }
    active = op // Before read/config/attestor/currentness or any signal callback.
    try {
      if (!referenceId(reference)) return failure('INVALID_REQUEST')
      let captured: ReturnType<typeof captureDeadline>
      try {
        captured = captureDeadline(deadline)
      } catch {
        return failure('INVALID_REQUEST')
      }
      op.expiresAt = captured.expiresAt
      op.monotonicDeadline = captured.monotonicDeadline
      op.external = captured.signal
      if (!localGuard(op)) return failure(op.error!)
      if (op.external) {
        op.detach = listenForAbort(op.external, () => stop(op, 'CANCELLED'))
        if (!localGuard(op)) {
          detach(op)
          return failure(op.error!)
        }
      }
      schedule(op)
      const config = read()
      if (!localGuard(op)) return failure(op.error!)
      const instance = select(config.data, reference)
      op.candidate = Object.freeze({
        requestId: randomUUID(),
        reference,
        ...instance,
        configurationRevision: config.revision,
        epoch: op.epoch,
        adapterId: manifest.adapterId,
        adapterRevision: manifest.adapterRevision,
        manifestDigest,
        expiresAt: op.expiresAt,
        monotonicDeadline: op.monotonicDeadline
      })
      const pending = attest(op.candidate, op.controller.signal)
      // Refuse a raw Proxy/thenable without reading `then`; only trusted native work is awaited.
      if (types.isProxy(pending) || !types.isPromise(pending)) invalid()
      localGuard(op) // Always drain dispatched work, including synchronous callback revocation.
      const raw = await pending
      if (!localGuard(op)) return failure(op.error!)
      const data = exact(snapshot(raw, MAX_CONTRACT_BYTES), [
        'candidate',
        'runtimeIdentity',
        'expiresAt',
        'monotonicDeadline'
      ])
      if (
        canonical(data.candidate) !== canonical(op.candidate) ||
        !token(data.runtimeIdentity) ||
        !finite(data.expiresAt) ||
        !finite(data.monotonicDeadline) ||
        data.expiresAt > op.expiresAt ||
        data.monotonicDeadline > op.monotonicDeadline ||
        data.expiresAt - Date.now() > MAX_VALIDITY_MS ||
        data.monotonicDeadline - performance.now() > MAX_VALIDITY_MS
      )
        invalid()
      op.attestation = data as unknown as Readonly<LocalComfyAttestation>
      op.expiresAt = data.expiresAt
      op.monotonicDeadline = data.monotonicDeadline
      schedule(op)
      const readbackRaw = readback(op)
      if (!verifiedIdentity(op)) return failure(op.error!)
      // No more side-effectful hooks. Events revoke across this gap; draining queued/nested
      // microtasks alone cannot prove runtime identity. Recheck only native/local state and data.
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!unchangedReadback(op, readbackRaw)) return failure(op.error!)
      op.lease = Object.freeze({
        id: randomUUID(),
        reference,
        configurationRevision: config.revision,
        epoch: op.epoch,
        manifestDigest,
        expiresAt: op.expiresAt,
        monotonicDeadline: op.monotonicDeadline,
        signal: op.controller.signal
      })
      if (!localGuard(op)) return failure(op.error!)
      op.phase = 'leased'
      return Object.freeze({ status: 'lease', lease: op.lease })
    } catch {
      localGuard(op)
      return failure(op.error ?? 'UNAVAILABLE')
    } finally {
      if (op.phase === 'acquiring') {
        stop(op, op.error ?? 'UNAVAILABLE')
        if (active === op) active = undefined
      }
    }
  }
  function isCurrent(lease: unknown): boolean {
    const op = active
    if (busy || !op || op.phase !== 'leased' || op.lease !== lease) return false
    busy++
    try {
      const readbackRaw = readback(op)
      if (!verifiedIdentity(op)) return false
      // Guard after the LAST hook; either hook can synchronously change runtime or config.
      return unchangedReadback(op, readbackRaw)
    } catch {
      stop(op, 'REVOKED')
      return false
    } finally {
      busy--
    }
  }
  return Object.freeze({ status, acquire, isCurrent, revoke, dispose })
}
