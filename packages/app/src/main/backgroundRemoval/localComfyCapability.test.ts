import { addAbortListener, getEventListeners } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../shared/config/config'
import {
  createLocalComfyCapabilityRegistry,
  type ApprovedLocalComfyAdapterManifest,
  type LocalComfyAttestation,
  type LocalComfyCandidate,
  type LocalComfyCapabilityRegistry,
  type TrustedLocalComfyCapabilityOptions
} from './localComfyCapability'
import type { TrustedBackgroundRemovalDeadline } from './runner'

// Deliberately synthetic: these fingerprints assert nothing about any actual installation.
const manifest: ApprovedLocalComfyAdapterManifest = {
  schemaVersion: 1,
  adapterId: 'synthetic-test-only',
  adapterRevision: 'test-v1',
  nodes: [{ id: 'synthetic-node', sha256: 'a'.repeat(64) }],
  dependencies: [{ id: 'synthetic-dependency', sha256: 'b'.repeat(64) }],
  checkpoint: { sha256: 'c'.repeat(64), sizeBytes: 123 },
  loader: {
    revision: 'synthetic-loader-v1',
    sha256: 'd'.repeat(64),
    offlineOnly: true,
    enforcesCheckpointHashAndSize: true
  },
  output: { revision: 'synthetic-output-v1', format: 'RGBA8', metadata: 'none' },
  cancellation: { revision: 'synthetic-cancel-v1', scope: 'job', atomic: true }
}
const ref = 'local-comfy-rembg:cutout'
const fake = <T>(value: unknown): T => value as T
const fixture = () => ({
  background_removal_capability: { id: 'cutout', enabled: true, comfy_instance_id: 'local-1' },
  comfy_batch_profiles: [
    { id: 'local-1', baseUrl: 'http://127.0.0.1:8188', enabled: true, maxConcurrency: 1 }
  ],
  unrelated: { syntheticSentinel: 'not-a-real-secret', enabled: false }
})
const deadline = (signal?: AbortSignal, duration = 10_000): TrustedBackgroundRemovalDeadline => ({
  expiresAt: Date.now() + duration,
  monotonicDeadline: performance.now() + duration,
  ...(signal ? { signal } : {})
})
const attestation = (candidate: LocalComfyCandidate): LocalComfyAttestation => ({
  candidate,
  runtimeIdentity: 'synthetic-runtime-1',
  expiresAt: candidate.expiresAt,
  monotonicDeadline: candidate.monotonicDeadline
})
const identity = (value: LocalComfyAttestation) => ({
  candidate: value.candidate,
  runtimeIdentity: value.runtimeIdentity
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const registries: LocalComfyCapabilityRegistry[] = []
function setup(
  overrides: Partial<TrustedLocalComfyCapabilityOptions> = {},
  createRegistry = createLocalComfyCapabilityRegistry
) {
  const state = { config: fake<unknown>(fixture()), runtimeIdentity: 'synthetic-runtime-1' }
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn()
  const readConfig = vi.fn(() => state.config)
  const onConfigCommitted = vi.fn((listener: () => void, signal: AbortSignal) => {
    listeners.add(listener)
    const remove = () => listeners.delete(listener)
    signal.addEventListener('abort', remove, { once: true })
    return () => {
      unsubscribe()
      remove()
      signal.removeEventListener('abort', remove)
    }
  })
  const runtimeListeners = new Set<() => void>()
  const unsubscribeRuntime = vi.fn()
  const onRuntimeChanged = vi.fn((listener: () => void, signal: AbortSignal) => {
    runtimeListeners.add(listener)
    const remove = () => runtimeListeners.delete(listener)
    const subscription = addAbortListener(signal, remove)
    return () => {
      unsubscribeRuntime()
      remove()
      subscription[Symbol.dispose]()
    }
  })
  const attest = vi.fn(async (candidate: LocalComfyCandidate, _signal: AbortSignal) => ({
    ...attestation(candidate),
    runtimeIdentity: state.runtimeIdentity
  }))
  const isAttestationCurrent = vi.fn((a: LocalComfyAttestation) => ({
    ...identity(a),
    runtimeIdentity: state.runtimeIdentity
  }))
  const registry = createRegistry({
    readConfig,
    onConfigCommitted,
    onRuntimeChanged,
    approvedManifest: structuredClone(manifest),
    attest,
    isAttestationCurrent,
    ...overrides
  })
  registries.push(registry)
  return {
    registry,
    state,
    readConfig,
    onConfigCommitted,
    onRuntimeChanged,
    attest,
    isAttestationCurrent,
    unsubscribe,
    unsubscribeRuntime,
    listeners,
    runtimeListeners,
    changeRuntime: (runtimeIdentity: string) => {
      // Trusted producer notifies BEFORE exposing a transition, even when an identity is reused.
      for (const listener of [...runtimeListeners]) listener()
      state.runtimeIdentity = runtimeIdentity
    },
    commit: () => [...listeners].forEach((listener) => listener())
  }
}
async function leaseOf(registry: LocalComfyCapabilityRegistry, input = deadline()) {
  const result = await registry.acquire(ref, input)
  expect(result.status).toBe('lease')
  if (result.status !== 'lease') throw new Error('Expected synthetic test lease')
  return result.lease
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('configuration-only exact authority', () => {
  it('does not enable or migrate defaults, probe status, or reinterpret generic profiles', async () => {
    const h = setup()
    h.state.config = DEFAULT_CONFIG
    expect(Object.hasOwn(DEFAULT_CONFIG, 'background_removal_capability')).toBe(false)
    expect(h.registry.status(ref)).toEqual({ status: 'unavailable', ready: false })
    expect(await h.registry.acquire(ref, deadline())).toEqual({
      status: 'error',
      error: 'UNAVAILABLE'
    })
    h.state.config = {
      ...fixture(),
      background_removal_capability: undefined,
      backgroundRemovalProfileId: 'cutout',
      imageLLM: 'cutout'
    }
    expect(h.registry.status(ref).status).toBe('unavailable')
    expect(h.attest).not.toHaveBeenCalled()
  })
  it.each([
    '',
    'default',
    'imageLLM',
    'cutout',
    'local-1',
    'local-comfy-rembg:',
    'local-comfy-rembg:../cutout',
    'local-comfy-rembg:cutout ',
    'local-comfy-rembg:cutout\n',
    `local-comfy-rembg:${'x'.repeat(129)}`
  ])('rejects non-exact reference %s', async (value) => {
    const h = setup()
    expect(h.registry.status(value).status).toBe('unavailable')
    expect((await h.registry.acquire(value, deadline())).status).toBe('error')
    expect(h.attest).not.toHaveBeenCalled()
  })
  it('defines the bounded namespaced reference and accepts its maximum id', async () => {
    const h = setup()
    const config = fixture()
    config.background_removal_capability.id = 'x'.repeat(128)
    h.state.config = config
    const value = `local-comfy-rembg:${config.background_removal_capability.id}`
    expect(h.registry.status(value)).toEqual({ status: 'configured-but-unattested', ready: false })
    expect((await h.registry.acquire(value, deadline())).status).toBe('lease')
  })
  it.each([
    'missing',
    'disabled',
    'deleted',
    'instance-disabled',
    'duplicate',
    'disabled-duplicate',
    'bad-concurrency',
    'fractional-concurrency',
    'unsafe-concurrency'
  ])('has no first/default/failover for %s', async (mode) => {
    const h = setup()
    const config = fixture()
    if (mode === 'missing')
      delete fake<Record<string, unknown>>(config).background_removal_capability
    if (mode === 'disabled') config.background_removal_capability.enabled = false
    if (mode === 'deleted') config.comfy_batch_profiles = []
    if (mode === 'instance-disabled') config.comfy_batch_profiles[0].enabled = false
    if (mode.includes('duplicate'))
      config.comfy_batch_profiles.push({
        ...config.comfy_batch_profiles[0],
        enabled: mode === 'duplicate'
      })
    if (mode === 'bad-concurrency') config.comfy_batch_profiles[0].maxConcurrency = 0
    if (mode === 'fractional-concurrency') config.comfy_batch_profiles[0].maxConcurrency = 1.5
    if (mode === 'unsafe-concurrency')
      config.comfy_batch_profiles[0].maxConcurrency = Number.MAX_SAFE_INTEGER + 1
    h.state.config = config
    expect(h.registry.status(ref).status).toBe('unavailable')
    expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
    expect(h.attest).not.toHaveBeenCalled()
  })
  it.each([
    'https://127.0.0.1:8188',
    'http://localhost:8188',
    'http://127.1:8188',
    'http://127.0.0.2:8188',
    'http://0177.0.0.1:8188',
    'http://0x7f000001:8188',
    'http://2130706433:8188',
    'http://127.0.0.1.:8188',
    'HTTP://127.0.0.1:8188',
    'http://127.0.0.1',
    'http://127.0.0.1:08188',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://user@127.0.0.1:8188',
    'http://127.0.0.1:8188/?x=1',
    'http://127.0.0.1:8188/#x',
    'http://127.0.0.1:8188/path',
    'http://127.0.0.1:8188//',
    'http://127.0.0.1:8188/..',
    'http://[0:0:0:0:0:0:0:1]:8188',
    'http://[::ffff:127.0.0.1]:8188',
    ' http://127.0.0.1:8188',
    'http://127.0.0.1:8188\n'
  ])('rejects URL spelling %j without normalization', (url) => {
    const h = setup()
    const config = fixture()
    config.comfy_batch_profiles[0].baseUrl = url
    h.state.config = config
    expect(h.registry.status(ref).status).toBe('unavailable')
    expect(h.attest).not.toHaveBeenCalled()
  })
  it.each(['http://127.0.0.1:1', 'http://127.0.0.1:80/', 'http://[::1]:65535/'])(
    'passes only exact numeric loopback origin %s to trusted main',
    async (url) => {
      const h = setup()
      const config = fixture()
      config.comfy_batch_profiles[0].baseUrl = url
      h.state.config = config
      await leaseOf(h.registry)
      expect(h.attest.mock.calls[0][0].origin).toBe(url.replace(/\/$/, ''))
    }
  )
  it.each(['attest', 'isAttestationCurrent', 'approvedManifest'] as const)(
    'is configured but never ready without %s',
    async (key) => {
      const h = setup({ [key]: undefined })
      expect(h.registry.status(ref)).toEqual({ status: 'configured-but-unattested', ready: false })
      expect(h.attest).not.toHaveBeenCalled()
      expect(await h.registry.acquire(ref, deadline())).toEqual({
        status: 'error',
        error: 'UNAVAILABLE'
      })
      expect(h.attest).not.toHaveBeenCalled()
    }
  )
})

describe('descriptor-only complete snapshots and approved contracts', () => {
  it.each([
    'proxy',
    'getter',
    'cycle',
    'dangerous',
    'symbol',
    'hidden',
    'prototype',
    'function',
    'sparse',
    'wide',
    'deep',
    'large'
  ])('rejects %s anywhere in config without invoking hooks', async (kind) => {
    const h = setup()
    const hook = vi.fn(() => {
      throw new Error('synthetic-private-detail')
    })
    let value: unknown = {}
    if (kind === 'proxy') value = new Proxy({}, { ownKeys: hook, get: hook, getPrototypeOf: hook })
    if (kind === 'getter') value = Object.defineProperty({}, 'x', { get: hook, enumerable: true })
    if (kind === 'cycle') {
      const cycle: Record<string, unknown> = {}
      cycle.self = cycle
      value = cycle
    }
    if (kind === 'dangerous') value = JSON.parse('{"constructor":{}}')
    if (kind === 'symbol') value = { [Symbol('x')]: 1 }
    if (kind === 'hidden') value = Object.defineProperty({}, 'x', { value: 1 })
    if (kind === 'prototype') value = new Date()
    if (kind === 'function') value = { toJSON: hook }
    if (kind === 'sparse') value = new Array(3)
    if (kind === 'wide')
      value = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`x${i}`, i]))
    if (kind === 'deep') for (let i = 0; i < 40; i++) value = { value }
    if (kind === 'large') value = 'x'.repeat(1024 * 1024 + 1)
    h.state.config = { ...fixture(), nonselected: value }
    expect(h.registry.status(ref).status).toBe('unavailable')
    expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
    expect(hook).not.toHaveBeenCalled()
    expect(h.attest).not.toHaveBeenCalled()
  })
  it.each([
    'nodes',
    'dependencies',
    'checkpoint',
    'loader',
    'output',
    'cancellation',
    'adapterRevision'
  ])('requires the manifest %s contract', async (key) => {
    const broken = fake<Record<string, unknown>>(structuredClone(manifest))
    delete broken[key]
    const h = setup({ approvedManifest: fake(broken) })
    expect(await h.registry.acquire(ref, deadline())).toEqual({
      status: 'error',
      error: 'UNAVAILABLE'
    })
    expect(h.attest).not.toHaveBeenCalled()
  })
  it.each([
    { nodes: [] },
    { dependencies: [] },
    { checkpoint: { sha256: 'bad', sizeBytes: 1 } },
    { checkpoint: { sha256: 'c'.repeat(64), sizeBytes: 0 } },
    { loader: { ...manifest.loader, offlineOnly: false } },
    { loader: { ...manifest.loader, enforcesCheckpointHashAndSize: false } },
    { output: { ...manifest.output, metadata: 'retain' } },
    { output: { ...manifest.output, format: 'RGB8' } },
    { cancellation: { ...manifest.cancellation, atomic: false } },
    { cancellation: { ...manifest.cancellation, scope: 'global' } }
  ])('rejects incomplete/unsafe manifest %#', async (patch) => {
    const h = setup({ approvedManifest: fake({ ...manifest, ...patch }) })
    expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
  })
  it('snapshots the manifest without getter hooks and binds its exact digest', async () => {
    const mutable = structuredClone(manifest)
    const h = setup({ approvedManifest: mutable })
    mutable.checkpoint.sizeBytes++
    const first = await leaseOf(h.registry)
    const other = setup({ approvedManifest: mutable })
    expect((await leaseOf(other.registry)).manifestDigest).not.toBe(first.manifestDigest)
    const hook = vi.fn()
    const bad = setup({
      approvedManifest: fake(Object.defineProperty({}, 'nodes', { get: hook, enumerable: true }))
    })
    expect((await bad.registry.acquire(ref, deadline())).status).toBe('error')
    expect(hook).not.toHaveBeenCalled()
  })
  it('binds all config fields, preserves snapshot identity across key order, and salts public revisions', async () => {
    const h = setup()
    const first = await leaseOf(h.registry)
    h.registry.revoke()
    h.state.config = {
      ...fixture(),
      unrelated: { syntheticSentinel: 'changed-synthetic-value', enabled: false }
    }
    const second = await leaseOf(h.registry)
    expect(second.configurationRevision).not.toBe(first.configurationRevision)
    h.registry.revoke()
    h.state.config = Object.fromEntries(Object.entries(h.state.config as object).reverse())
    const third = await leaseOf(h.registry)
    expect(third.configurationRevision).toBe(second.configurationRevision)
    const other = setup()
    other.state.config = h.state.config
    expect((await leaseOf(other.registry)).configurationRevision).not.toBe(
      third.configurationRevision
    )
  })
  it.each(['nonselected', 'concurrency', 'url'])(
    'detects in-place %s mutation without commit before settlement',
    async (kind) => {
      const h = setup()
      h.isAttestationCurrent.mockImplementation((a) => {
        const config = h.state.config as ReturnType<typeof fixture>
        if (kind === 'nonselected') config.unrelated.enabled = true
        if (kind === 'concurrency') config.comfy_batch_profiles[0].maxConcurrency = 2
        if (kind === 'url') config.comfy_batch_profiles[0].baseUrl = 'http://127.0.0.1:8189'
        return identity(a)
      })
      expect(await h.registry.acquire(ref, deadline())).toEqual({
        status: 'error',
        error: 'REVOKED'
      })
    }
  )
})

describe('attestation, current identity and private leases', () => {
  it('mints only a frozen non-runnable exact-identity lease; status remains unattested', async () => {
    const h = setup()
    const result = await h.registry.acquire(ref, deadline())
    expect(result.status).toBe('lease')
    if (result.status !== 'lease') throw new Error('Expected lease')
    const lease = result.lease
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(lease)).toBe(true)
    expect(Object.isFrozen(h.attest.mock.calls[0][0])).toBe(true)
    expect(Object.isFrozen(h.isAttestationCurrent.mock.calls[0][0])).toBe(true)
    expect(h.registry.isCurrent(lease)).toBe(true)
    expect(h.registry.isCurrent({ ...lease })).toBe(false)
    expect(h.registry.isCurrent(JSON.parse(JSON.stringify(lease)))).toBe(false)
    expect(setup().registry.isCurrent(lease)).toBe(false)
    expect(h.registry.status(ref)).toEqual({ status: 'configured-but-unattested', ready: false })
    const publicData = JSON.stringify([result, h.registry.status(ref)])
    for (const text of [
      'http',
      'not-a-real-secret',
      'synthetic-runtime',
      'checkpoint',
      'dependency',
      'baseUrl'
    ])
      expect(publicData).not.toContain(text)
    expect(Object.keys(lease).sort()).toEqual(
      [
        'id',
        'reference',
        'configurationRevision',
        'epoch',
        'manifestDigest',
        'expiresAt',
        'monotonicDeadline',
        'signal'
      ].sort()
    )
    h.registry.revoke()
    expect(lease.signal.aborted).toBe(true)
    expect(h.registry.isCurrent(lease)).toBe(false)
    expect(h.registry.isCurrent(await leaseOf(h.registry))).toBe(true)
    expect(h.registry.isCurrent(lease)).toBe(false)
  })
  it.each([
    'absent',
    'boolean',
    'epoch',
    'revision',
    'manifest',
    'origin',
    'request',
    'runtime',
    'expired-wall',
    'expired-mono',
    'long-wall',
    'long-mono',
    'extra',
    'getter',
    'proxy'
  ])('rejects %s attestation', async (mode) => {
    const h = setup()
    const hook = vi.fn()
    h.attest.mockImplementation(async (candidate) => {
      const a = structuredClone(attestation(candidate))
      if (mode === 'absent') return fake(undefined)
      if (mode === 'boolean') return fake(true)
      if (mode === 'epoch') a.candidate = { ...a.candidate, epoch: a.candidate.epoch + 1 }
      if (mode === 'revision')
        a.candidate = { ...a.candidate, configurationRevision: 'e'.repeat(64) }
      if (mode === 'manifest') a.candidate = { ...a.candidate, manifestDigest: 'f'.repeat(64) }
      if (mode === 'origin') a.candidate = { ...a.candidate, origin: 'http://127.0.0.1:8190' }
      if (mode === 'request') a.candidate = { ...a.candidate, requestId: 'forged-request' }
      if (mode === 'runtime') a.runtimeIdentity = ''
      if (mode === 'expired-wall') a.expiresAt = Date.now()
      if (mode === 'expired-mono') a.monotonicDeadline = performance.now()
      if (mode === 'long-wall') a.expiresAt++
      if (mode === 'long-mono') a.monotonicDeadline++
      if (mode === 'extra') return fake({ ...a, hiddenContract: true })
      if (mode === 'getter')
        return fake(Object.defineProperty({}, 'candidate', { get: hook, enumerable: true }))
      // Native promises necessarily assimilate a top-level then property at their producer.
      // A nested Proxy reaches this boundary without invoking that producer-side JS behavior.
      if (mode === 'proxy') a.candidate = new Proxy(a.candidate, { get: hook, ownKeys: hook })
      return a
    })
    expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
    expect(hook).not.toHaveBeenCalled()
  })
  it('rejects raw Proxy/thenable callback results before invoking their hooks', async () => {
    const hook = vi.fn()
    const h = setup({ attest: () => fake(new Proxy({}, { get: hook })) })
    expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
    const other = setup({ attest: () => fake(Object.defineProperty({}, 'then', { get: hook })) })
    expect((await other.registry.acquire(ref, deadline())).status).toBe('error')
    expect(hook).not.toHaveBeenCalled()
  })
  it('rejects reused attestation even for identical config and deadline', async () => {
    const h = setup()
    const time = deadline()
    await leaseOf(h.registry, time)
    const old = h.attest.mock.results[0].value
    h.registry.revoke()
    h.attest.mockImplementation(() => old)
    expect((await h.registry.acquire(ref, time)).status).toBe('error')
  })
  it.each(['boolean', 'identity', 'candidate', 'throw'])(
    'requires live exact identity, not %s readiness',
    async (mode) => {
      const h = setup()
      h.isAttestationCurrent.mockImplementation((a) => {
        if (mode === 'throw') throw { syntheticDetail: 'private' }
        if (mode === 'boolean') return fake(true)
        if (mode === 'identity') return { ...identity(a), runtimeIdentity: 'another-process' }
        return { ...identity(a), candidate: { ...a.candidate, epoch: 999 } }
      })
      expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
    }
  )
  it('revokes an issued lease when live runtime identity or full config changes', async () => {
    const h = setup()
    const lease = await leaseOf(h.registry)
    h.isAttestationCurrent.mockImplementation((a) => ({
      ...identity(a),
      runtimeIdentity: 'replacement'
    }))
    expect(h.registry.isCurrent(lease)).toBe(false)
    expect(lease.signal.aborted).toBe(true)
    h.isAttestationCurrent.mockImplementation(identity)
    const next = await leaseOf(h.registry)
    ;(h.state.config as ReturnType<typeof fixture>).unrelated.enabled = true
    expect(h.registry.isCurrent(next)).toBe(false)
    expect(next.signal.aborted).toBe(true)
  })
})

describe('synchronous revocation, deadlines and retained capacity', () => {
  it('increments epoch for every commit including A-B-A and unrelated changes', async () => {
    const h = setup()
    const first = await leaseOf(h.registry)
    h.state.config = { ...fixture(), other: 'B' }
    h.commit()
    expect(first.signal.aborted).toBe(true)
    h.state.config = fixture()
    h.commit()
    const second = await leaseOf(h.registry)
    expect(second.epoch).toBe(first.epoch + 2)
    expect(second.configurationRevision).toBe(first.configurationRevision)
    h.commit()
    expect(second.signal.aborted).toBe(true)
  })
  it.each(['commit', 'revoke', 'dispose', 'abort', 'timeout', 'failure'])(
    'retains one dispatched slot through ignored %s until callback settlement',
    async (mode) => {
      const h = setup()
      const wait = deferred<LocalComfyAttestation>()
      h.attest.mockImplementationOnce(() => wait.promise)
      const external = new AbortController()
      const pending = h.registry.acquire(ref, deadline(external.signal))
      const [candidate, signal] = h.attest.mock.calls[0]
      if (mode === 'commit') h.commit()
      if (mode === 'revoke') h.registry.revoke()
      if (mode === 'dispose') h.registry.dispose()
      if (mode === 'abort') external.abort()
      if (mode === 'timeout') vi.advanceTimersByTime(10_000)
      if (mode !== 'failure') expect(signal.aborted).toBe(true)
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
      expect(h.attest).toHaveBeenCalledTimes(1)
      if (mode === 'failure') wait.reject('synthetic-private-error')
      else wait.resolve(attestation(candidate))
      expect((await pending).status).toBe('error')
      expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
      if (mode !== 'dispose') await leaseOf(h.registry)
    }
  )
  it.each([
    'missing',
    'getter',
    'long-wall',
    'long-mono',
    'nan',
    'preabort',
    'expired',
    'fake-signal',
    'proxy-signal'
  ])('requires explicit bounded dual deadline: %s', async (mode) => {
    const h = setup()
    const c = new AbortController()
    let input = deadline(c.signal)
    const hook = vi.fn()
    if (mode === 'missing') input = fake(undefined)
    if (mode === 'getter')
      input = fake(Object.defineProperty({}, 'expiresAt', { get: hook, enumerable: true }))
    if (mode === 'long-wall') input = { ...input, expiresAt: Date.now() + 120_001 }
    if (mode === 'long-mono') input = { ...input, monotonicDeadline: performance.now() + 120_001 }
    if (mode === 'nan') input = { ...input, expiresAt: NaN }
    if (mode === 'expired') input = deadline(undefined, 0)
    if (mode === 'preabort') c.abort()
    if (mode === 'fake-signal')
      input = { ...input, signal: fake({ aborted: false, addEventListener: hook }) }
    if (mode === 'proxy-signal') input = { ...input, signal: new Proxy(c.signal, { get: hook }) }
    expect((await h.registry.acquire(ref, input)).status).toBe('error')
    expect(h.attest).not.toHaveBeenCalled()
    expect(h.readConfig).not.toHaveBeenCalled()
    expect(hook).not.toHaveBeenCalled()
    expect(getEventListeners(c.signal, 'abort')).toHaveLength(0)
  })
  it('preserves the precise preexisting deadline, honors shorter attestation and detaches terminal listeners', async () => {
    const h = setup()
    const external = new AbortController()
    const input = deadline(external.signal, 120_000)
    vi.advanceTimersByTime(1234)
    h.attest.mockImplementation(async (candidate) => ({
      ...attestation(candidate),
      expiresAt: Date.now() + 17,
      monotonicDeadline: performance.now() + 17
    }))
    const lease = await leaseOf(h.registry, input)
    expect(h.attest.mock.calls[0][0].expiresAt).toBe(input.expiresAt)
    expect(h.attest.mock.calls[0][0].monotonicDeadline).toBe(input.monotonicDeadline)
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(1)
    vi.advanceTimersByTime(16)
    expect(h.registry.isCurrent(lease)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(lease.signal.aborted).toBe(true)
    expect(h.registry.isCurrent(lease)).toBe(false)
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(1_000_000)
    expect(h.registry.isCurrent(lease)).toBe(false)
  })
  it.each(['wall', 'mono'])(
    'checks independent %s clock without relying on timer dispatch',
    async (clock) => {
      const h = setup()
      const lease = await leaseOf(h.registry)
      if (clock === 'wall') vi.setSystemTime(lease.expiresAt)
      else vi.spyOn(performance, 'now').mockReturnValue(lease.monotonicDeadline)
      expect(h.registry.isCurrent(lease)).toBe(false)
      expect(lease.signal.aborted).toBe(true)
    }
  )
  it.each(['abort', 'revoke', 'dispose'])(
    'detaches an issued lease on %s and never revives clones',
    async (mode) => {
      const h = setup()
      const external = new AbortController()
      const lease = await leaseOf(h.registry, deadline(external.signal))
      if (mode === 'abort') external.abort()
      if (mode === 'revoke') h.registry.revoke()
      if (mode === 'dispose') h.registry.dispose()
      expect(lease.signal.aborted).toBe(true)
      expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(h.registry.isCurrent(lease)).toBe(false)
      h.registry.dispose()
      h.registry.dispose()
      expect(h.unsubscribe).toHaveBeenCalledTimes(1)
      expect(h.listeners.size).toBe(0)
      expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
    }
  )
})

describe('callback and event reentrancy', () => {
  it.each(['read', 'attest', 'current'])(
    'reserves before %s callback and checks synchronous invalidation',
    async (phase) => {
      const h = setup()
      const nested: Promise<unknown>[] = []
      let nestedStatus: unknown
      const reenter = () => {
        nestedStatus = h.registry.status(ref)
        nested.push(h.registry.acquire(ref, deadline()))
        h.registry.revoke()
      }
      if (phase === 'read')
        h.readConfig.mockImplementationOnce(() => {
          reenter()
          return h.state.config
        })
      if (phase === 'attest')
        h.attest.mockImplementationOnce(async (c) => {
          reenter()
          return attestation(c)
        })
      if (phase === 'current')
        h.isAttestationCurrent.mockImplementationOnce((a) => {
          reenter()
          return identity(a)
        })
      expect(await h.registry.acquire(ref, deadline())).toEqual({
        status: 'error',
        error: 'REVOKED'
      })
      expect(await nested[0]).toEqual({ status: 'error', error: 'BUSY' })
      expect(nestedStatus).toEqual({ status: 'unavailable', ready: false })
      await leaseOf(h.registry)
    }
  )
  it('aborts before replacement and blocks reentrant acquisition from lease abort listeners', async () => {
    const h = setup()
    const lease = await leaseOf(h.registry)
    let nested: Promise<unknown> | undefined
    lease.signal.addEventListener('abort', () => {
      nested = h.registry.acquire(ref, deadline())
    })
    h.commit()
    expect(await nested).toEqual({ status: 'error', error: 'BUSY' })
    await leaseOf(h.registry)
  })
  it.each(['read', 'current', 'nested-current'])(
    'allows no lease after %s microtask revocation',
    async (phase) => {
      const h = setup()
      if (phase === 'read')
        h.readConfig.mockImplementation(() => {
          queueMicrotask(() => h.registry.revoke())
          return h.state.config
        })
      else
        h.isAttestationCurrent.mockImplementation((a) => {
          if (phase === 'nested-current')
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => h.registry.revoke())))
          else queueMicrotask(() => h.registry.revoke())
          return identity(a)
        })
      expect(await h.registry.acquire(ref, deadline())).toEqual({
        status: 'error',
        error: 'REVOKED'
      })
    }
  )
  it('detects in-place microtask mutation after final readback without invoking another callback', async () => {
    const h = setup()
    h.isAttestationCurrent.mockImplementation((a) => {
      queueMicrotask(() => {
        ;(h.state.config as ReturnType<typeof fixture>).unrelated.enabled = true
      })
      return identity(a)
    })
    expect(await h.registry.acquire(ref, deadline())).toEqual({ status: 'error', error: 'REVOKED' })
  })
  it('guards status read reentry and disposal after readConfig', async () => {
    const h = setup()
    let nestedStatus: unknown
    h.readConfig.mockImplementationOnce(() => {
      nestedStatus = h.registry.status(ref)
      h.registry.dispose()
      return h.state.config
    })
    expect(h.registry.status(ref).status).toBe('unavailable')
    expect(nestedStatus).toEqual({ status: 'unavailable', ready: false })
    expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
  })
  it.each(['event', 'throw', 'invalid-unsubscribe'])(
    'fails closed and tears down initialization subscription on %s',
    async (mode) => {
      let count = 0
      const unsubscribe = vi.fn(() => {
        count = 0
      })
      let lifetime!: AbortSignal
      const h = setup({
        onConfigCommitted: (listener, signal) => {
          lifetime = signal
          count++
          signal.addEventListener(
            'abort',
            () => {
              count = 0
            },
            { once: true }
          )
          if (mode === 'event') listener()
          if (mode === 'throw') throw 'synthetic-subscribe-failure'
          if (mode === 'invalid-unsubscribe') return fake(undefined)
          return unsubscribe
        }
      })
      expect(h.registry.status(ref).status).toBe('unavailable')
      expect((await h.registry.acquire(ref, deadline())).status).toBe('error')
      expect(lifetime.aborted).toBe(true)
      expect(count).toBe(0)
      if (mode === 'event') expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(h.readConfig).not.toHaveBeenCalled()
    }
  )
  it('rejects option getters/proxies without executing them', () => {
    const hook = vi.fn()
    for (const options of [
      new Proxy({}, { get: hook }),
      Object.defineProperty({}, 'readConfig', { get: hook, enumerable: true })
    ]) {
      const registry = createLocalComfyCapabilityRegistry(fake(options))
      registries.push(registry)
      expect(registry.status(ref).status).toBe('unavailable')
    }
    expect(hook).not.toHaveBeenCalled()
  })
  it('sanitizes non-Error failures and currentness reentry cannot revive a revoked lease', async () => {
    const h = setup()
    h.readConfig.mockImplementationOnce(() => {
      throw { endpoint: 'synthetic-private-endpoint' }
    })
    expect(await h.registry.acquire(ref, deadline())).toEqual({
      status: 'error',
      error: 'UNAVAILABLE'
    })
    const lease = await leaseOf(h.registry)
    let reentered: unknown
    h.isAttestationCurrent.mockImplementationOnce((a) => {
      reentered = h.registry.isCurrent(lease)
      h.registry.revoke()
      return identity(a)
    })
    expect(h.registry.isCurrent(lease)).toBe(false)
    expect(reentered).toBe(false)
    expect(lease.signal.aborted).toBe(true)
  })
})

describe('review2 trusted runtime/session revocation', () => {
  it('rejects synchronous readConfig session replacement in isCurrent, with immediate abort', async () => {
    const h = setup()
    const lease = await leaseOf(h.registry)
    h.readConfig.mockImplementationOnce(() => {
      h.changeRuntime('synthetic-runtime-2')
      expect(lease.signal.aborted).toBe(true)
      return h.state.config
    })
    expect(h.registry.isCurrent(lease)).toBe(false)
    expect(lease.signal.aborted).toBe(true)
    expect(h.registry.isCurrent(lease)).toBe(false)
    expect(h.registry.isCurrent(await leaseOf(h.registry))).toBe(true)
  })
  it('rejects synchronous runtime replacement during acquisition readback', async () => {
    const h = setup()
    h.readConfig.mockReturnValueOnce(h.state.config).mockImplementationOnce(() => {
      h.changeRuntime('synthetic-runtime-2')
      return h.state.config
    })
    expect(await h.registry.acquire(ref, deadline())).toEqual({ status: 'error', error: 'REVOKED' })
    expect(h.attest.mock.calls[0][1].aborted).toBe(true)
  })
  it.each(['read', 'nested-read', 'current', 'nested-current'])(
    'rejects %s queued runtime change before callback-free acquisition settlement',
    async (phase) => {
      const h = setup()
      const change = () => h.changeRuntime('synthetic-runtime-2')
      const queue = () => {
        queueMicrotask(
          phase.startsWith('nested') ? () => queueMicrotask(() => queueMicrotask(change)) : change
        )
      }
      if (phase.endsWith('read'))
        h.readConfig.mockReturnValueOnce(h.state.config).mockImplementationOnce(() => {
          queue()
          return h.state.config
        })
      else
        h.isAttestationCurrent.mockImplementationOnce((a) => {
          queue()
          return identity(a)
        })
      expect(await h.registry.acquire(ref, deadline())).toEqual({
        status: 'error',
        error: 'REVOKED'
      })
      expect(h.state.runtimeIdentity).toBe('synthetic-runtime-2')
      expect(h.attest.mock.calls[0][1].aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it.each(['runtime', 'commit', 'in-place-config'])(
    'guards after the last isCurrent callback invalidates %s',
    async (mode) => {
      const h = setup()
      const lease = await leaseOf(h.registry)
      const order: string[] = []
      h.readConfig.mockImplementationOnce(() => {
        order.push('read')
        return h.state.config
      })
      h.isAttestationCurrent.mockImplementationOnce((a) => {
        order.push('identity')
        if (mode === 'runtime') h.changeRuntime('synthetic-runtime-2')
        if (mode === 'commit') h.commit()
        if (mode === 'in-place-config')
          (h.state.config as ReturnType<typeof fixture>).unrelated.enabled = true
        return identity(a)
      })
      expect(h.registry.isCurrent(lease)).toBe(false)
      expect(order).toEqual(['read', 'identity'])
      expect(lease.signal.aborted).toBe(true)
    }
  )
  it('revokes A-B-A sessions without polling or duplicate aborts, even with unchanged config', async () => {
    const h = setup()
    const first = await leaseOf(h.registry)
    const aborted = vi.fn()
    first.signal.addEventListener('abort', aborted)
    h.changeRuntime('synthetic-runtime-2')
    expect(first.signal.aborted).toBe(true)
    h.changeRuntime('synthetic-runtime-1')
    expect(aborted).toHaveBeenCalledTimes(1)
    const next = await leaseOf(h.registry)
    expect(next.epoch).toBe(first.epoch + 2)
    expect(next.configurationRevision).toBe(first.configurationRevision)
    expect(h.registry.isCurrent(first)).toBe(false)
    expect(h.registry.isCurrent(next)).toBe(true)
    h.changeRuntime('synthetic-runtime-1')
    expect(next.signal.aborted).toBe(true)
  })
  it('retains ignored runtime abort through A-B-A and nested acquisition until attestor settlement', async () => {
    const h = setup()
    const wait = deferred<LocalComfyAttestation>()
    h.attest.mockImplementationOnce(() => wait.promise)
    const external = new AbortController()
    const pending = h.registry.acquire(ref, deadline(external.signal))
    const [candidate, signal] = h.attest.mock.calls[0]
    let nested: Promise<unknown> | undefined
    const aborted = vi.fn(() => {
      nested = h.registry.acquire(ref, deadline())
    })
    signal.addEventListener('abort', aborted)
    h.changeRuntime('synthetic-runtime-2')
    expect(signal.aborted).toBe(true)
    h.changeRuntime('synthetic-runtime-1')
    expect(aborted).toHaveBeenCalledTimes(1)
    expect(await nested).toEqual({ status: 'error', error: 'BUSY' })
    expect(await h.registry.acquire(ref, deadline())).toEqual({ status: 'error', error: 'BUSY' })
    expect(h.attest).toHaveBeenCalledTimes(1)
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
    wait.resolve(attestation(candidate))
    expect(await pending).toEqual({ status: 'error', error: 'REVOKED' })
    const next = await leaseOf(h.registry)
    expect(next.epoch).toBe(candidate.epoch + 2)
  })
  it.each(['missing', 'boolean', 'proxy', 'thenable'])(
    'requires a real synchronous runtime subscription, not %s',
    async (kind) => {
      const hook = vi.fn()
      let value: unknown
      if (kind === 'boolean') value = true
      if (kind === 'proxy') value = new Proxy(hook, { apply: hook, get: hook })
      if (kind === 'thenable') value = Object.defineProperty({}, 'then', { get: hook })
      const h = setup({ onRuntimeChanged: fake(value) })
      expect(await h.registry.acquire(ref, deadline())).toEqual({
        status: 'error',
        error: 'UNAVAILABLE'
      })
      expect(h.registry.status(ref)).toEqual({ status: 'unavailable', ready: false })
      expect(hook).not.toHaveBeenCalled()
      expect(h.readConfig).not.toHaveBeenCalled()
      expect(h.attest).not.toHaveBeenCalled()
      expect(h.listeners.size).toBe(0)
      expect(h.runtimeListeners.size).toBe(0)
    }
  )
  it('does not execute a runtime subscription accessor', async () => {
    const hook = vi.fn()
    const options = Object.defineProperty({}, 'onRuntimeChanged', { get: hook, enumerable: true })
    const registry = createLocalComfyCapabilityRegistry(fake(options))
    registries.push(registry)
    expect(await registry.acquire(ref, deadline())).toEqual({
      status: 'error',
      error: 'UNAVAILABLE'
    })
    expect(hook).not.toHaveBeenCalled()
  })
  it.each(['event', 'throw', 'invalid-cleanup', 'proxy-cleanup', 'thenable-cleanup'])(
    'aborts lifetime and cleans BOTH construction subscriptions on runtime %s',
    async (mode) => {
      const runtimeListeners = new Set<() => void>()
      const hook = vi.fn()
      const cleanup = vi.fn()
      let lifetime!: AbortSignal
      const h = setup({
        onRuntimeChanged: (listener, signal) => {
          lifetime = signal
          runtimeListeners.add(listener)
          const remove = () => runtimeListeners.delete(listener)
          const subscription = addAbortListener(signal, remove)
          if (mode === 'event') listener()
          if (mode === 'throw') throw 'synthetic-runtime-subscribe-failure'
          if (mode === 'invalid-cleanup') return fake(undefined)
          if (mode === 'proxy-cleanup') return fake(new Proxy(hook, { apply: hook, get: hook }))
          if (mode === 'thenable-cleanup')
            return fake(Object.defineProperty({}, 'then', { get: hook }))
          return () => {
            cleanup()
            remove()
            subscription[Symbol.dispose]()
          }
        }
      })
      expect(lifetime.aborted).toBe(true)
      expect(runtimeListeners.size).toBe(0)
      expect(h.listeners.size).toBe(0)
      expect(getEventListeners(lifetime, 'abort')).toHaveLength(0)
      expect(h.unsubscribe).toHaveBeenCalledTimes(1)
      expect(hook).not.toHaveBeenCalled()
      expect(cleanup).toHaveBeenCalledTimes(mode === 'event' ? 1 : 0)
      expect(await h.registry.acquire(ref, deadline())).toEqual({
        status: 'error',
        error: 'UNAVAILABLE'
      })
      expect(h.registry.status(ref).status).toBe('unavailable')
      expect(h.readConfig).not.toHaveBeenCalled()
      h.registry.dispose()
      h.registry.dispose()
      expect(h.unsubscribe).toHaveBeenCalledTimes(1)
      expect(cleanup).toHaveBeenCalledTimes(mode === 'event' ? 1 : 0)
    }
  )
  it.each(['config', 'runtime', 'both'])(
    'disposes both subscriptions once despite %s unsubscribe failure and reentry',
    async (failure) => {
      const listeners = new Set<() => void>()
      const lifetimes: AbortSignal[] = []
      const cleanups: ReturnType<typeof vi.fn>[] = []
      const subscribe = (kind: string) => (listener: () => void, lifetime: AbortSignal) => {
        listeners.add(listener)
        lifetimes.push(lifetime)
        const subscription = addAbortListener(lifetime, () => listeners.delete(listener))
        const cleanup = vi.fn(() => {
          listeners.delete(listener)
          subscription[Symbol.dispose]()
          h.registry.dispose()
          if (failure === kind || failure === 'both') throw 'synthetic-unsubscribe-failure'
        })
        cleanups.push(cleanup)
        return cleanup
      }
      const h = setup({
        onConfigCommitted: subscribe('config'),
        onRuntimeChanged: subscribe('runtime')
      })
      const external = new AbortController()
      const lease = await leaseOf(h.registry, deadline(external.signal))
      let nested: Promise<unknown> | undefined
      lease.signal.addEventListener('abort', () => {
        nested = h.registry.acquire(ref, deadline())
      })
      expect(() => h.registry.dispose()).not.toThrow()
      h.registry.dispose()
      h.registry.dispose()
      expect(await nested).toEqual({ status: 'error', error: 'BUSY' })
      expect(await h.registry.acquire(ref, deadline())).toEqual({
        status: 'error',
        error: 'UNAVAILABLE'
      })
      expect(lease.signal.aborted).toBe(true)
      expect(listeners.size).toBe(0)
      expect(cleanups).toHaveLength(2)
      for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledTimes(1)
      for (const lifetime of lifetimes) {
        expect(lifetime.aborted).toBe(true)
        expect(getEventListeners(lifetime, 'abort')).toHaveLength(0)
      }
      expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('never resubscribes or accumulates timers/abort listeners across runtime revocation cycles', async () => {
    const h = setup()
    const external = new AbortController()
    for (let index = 0; index < 3; index++) {
      const lease = await leaseOf(h.registry, deadline(external.signal))
      expect(h.registry.status(ref)).toEqual({ status: 'configured-but-unattested', ready: false })
      expect(getEventListeners(external.signal, 'abort')).toHaveLength(1)
      expect(h.listeners.size).toBe(1)
      expect(h.runtimeListeners.size).toBe(1)
      h.changeRuntime(`synthetic-runtime-${index}`)
      expect(lease.signal.aborted).toBe(true)
      expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
    h.registry.dispose()
    h.registry.dispose()
    expect(h.onConfigCommitted).toHaveBeenCalledTimes(1)
    expect(h.onRuntimeChanged).toHaveBeenCalledTimes(1)
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.unsubscribeRuntime).toHaveBeenCalledTimes(1)
    expect(h.listeners.size).toBe(0)
    expect(h.runtimeListeners.size).toBe(0)
    expect(getEventListeners(h.onRuntimeChanged.mock.calls[0][1], 'abort')).toHaveLength(0)
  })
  it.each(['wall', 'mono'])(
    'checks the original %s deadline after the final callback without resetting it',
    async (clock) => {
      const h = setup()
      const input = Object.freeze(deadline())
      h.isAttestationCurrent.mockImplementationOnce((a) => {
        if (clock === 'wall') vi.setSystemTime(input.expiresAt)
        else vi.spyOn(performance, 'now').mockReturnValue(input.monotonicDeadline)
        return identity(a)
      })
      expect(await h.registry.acquire(ref, input)).toEqual({ status: 'error', error: 'EXPIRED' })
      expect(h.attest.mock.calls[0][0].expiresAt).toBe(input.expiresAt)
      expect(h.attest.mock.calls[0][0].monotonicDeadline).toBe(input.monotonicDeadline)
      expect(h.attest.mock.calls[0][1].aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('review2 unsuppressible external cancellation', () => {
  it('aborts the attestor synchronously despite an earlier stopImmediatePropagation listener and retains its slot', async () => {
    const h = setup()
    const external = new AbortController()
    const suppress = vi.fn((event: Event) => event.stopImmediatePropagation())
    external.signal.addEventListener('abort', suppress, { once: true })
    const wait = deferred<LocalComfyAttestation>()
    h.attest.mockImplementationOnce(() => wait.promise)
    const pending = h.registry.acquire(ref, deadline(external.signal))
    const [candidate, signal] = h.attest.mock.calls[0]
    let settled = false
    void pending.then(() => {
      settled = true
    })
    external.abort()
    expect(suppress).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(true)
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(await h.registry.acquire(ref, deadline())).toEqual({ status: 'error', error: 'BUSY' })
    expect(h.attest).toHaveBeenCalledTimes(1)
    wait.resolve(attestation(candidate))
    expect(await pending).toEqual({ status: 'error', error: 'CANCELLED' })
    await leaseOf(h.registry)
  })
  it('immediately aborts an issued lease despite an earlier stopImmediatePropagation listener', async () => {
    const h = setup()
    const external = new AbortController()
    external.signal.addEventListener('abort', (event) => event.stopImmediatePropagation(), {
      once: true
    })
    const lease = await leaseOf(h.registry, deadline(external.signal))
    const aborted = vi.fn()
    lease.signal.addEventListener('abort', aborted)
    external.abort()
    external.abort()
    expect(lease.signal.aborted).toBe(true)
    expect(aborted).toHaveBeenCalledTimes(1)
    expect(h.registry.isCurrent(lease)).toBe(false)
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['aborted', 'addEventListener', 'removeEventListener'])(
    'rejects own %s accessors as invalid signal shape without invoking them',
    async (key) => {
      const h = setup()
      const external = new AbortController()
      const hook = vi.fn(() => {
        throw 'hostile-signal-accessor'
      })
      Object.defineProperty(external.signal, key, { get: hook })
      expect(await h.registry.acquire(ref, deadline(external.signal))).toEqual({
        status: 'error',
        error: 'INVALID_REQUEST'
      })
      h.registry.dispose()
      expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(h.attest).not.toHaveBeenCalled()
      expect(h.readConfig).not.toHaveBeenCalled()
      expect(hook).not.toHaveBeenCalled()
    }
  )
  it('rejects pre-aborted signals with shadow getters without executing them or installing a listener', async () => {
    const h = setup()
    const external = new AbortController()
    external.abort()
    const hook = vi.fn()
    for (const key of ['aborted', 'addEventListener', 'removeEventListener'])
      Object.defineProperty(external.signal, key, { get: hook })
    expect(await h.registry.acquire(ref, deadline(external.signal))).toEqual({
      status: 'error',
      error: 'INVALID_REQUEST'
    })
    expect(hook).not.toHaveBeenCalled()
    expect(h.attest).not.toHaveBeenCalled()
    expect(h.readConfig).not.toHaveBeenCalled()
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('captures the external signal once and ignores later deadline replacement/accessors', async () => {
    const h = setup()
    const external = new AbortController()
    const replacement = new AbortController()
    const input = deadline(external.signal)
    const wait = deferred<LocalComfyAttestation>()
    h.attest.mockImplementationOnce(() => wait.promise)
    const pending = h.registry.acquire(ref, input)
    const [candidate, signal] = h.attest.mock.calls[0]
    Object.assign(input, deadline(replacement.signal, 120_000))
    const hook = vi.fn()
    for (const key of ['expiresAt', 'monotonicDeadline', 'signal'])
      Object.defineProperty(input, key, { get: hook })
    replacement.abort()
    expect(signal.aborted).toBe(false)
    external.abort()
    expect(signal.aborted).toBe(true)
    wait.resolve(attestation(candidate))
    expect(await pending).toEqual({ status: 'error', error: 'CANCELLED' })
    expect(hook).not.toHaveBeenCalled()
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(replacement.signal, 'abort')).toHaveLength(0)
  })
})

describe('review3 native signal shape and partial registration ownership', () => {
  const kinds = ['controller', 'composite', 'timeout'] as const
  function external(kind: (typeof kinds)[number]) {
    const controller = new AbortController()
    const signal =
      kind === 'controller'
        ? controller.signal
        : kind === 'composite'
          ? AbortSignal.any([controller.signal])
          : AbortSignal.timeout(250)
    return {
      signal,
      settle: async () => {
        // Native AbortSignal.timeout is not driven by vi's fake global timers. Settle its
        // short real timer nonblockingly; fake timers independently track registry ownership.
        if (kind === 'timeout') await delay(260)
        else controller.abort()
      }
    }
  }
  it.each(kinds)(
    'rejects repeated %s shadow-aborted requests with prior listeners and no leak after disposal',
    async (kind) => {
      const h = setup()
      const source = external(kind)
      const prior = vi.fn()
      source.signal.addEventListener('abort', prior)
      const hook = vi.fn(() => {
        throw new Error('hostile aborted getter')
      })
      // Set up the prior listener BEFORE poisoning; setup must not execute the getter.
      Object.defineProperty(source.signal, 'aborted', { get: hook, configurable: true })
      const descriptor = Object.getOwnPropertyDescriptor(source.signal, 'aborted')
      try {
        for (let index = 0; index < 3; index++) {
          expect(await h.registry.acquire(ref, deadline(source.signal))).toEqual({
            status: 'error',
            error: 'INVALID_REQUEST'
          })
          expect(getEventListeners(source.signal, 'abort')).toEqual([prior])
          expect(vi.getTimerCount()).toBe(0)
        }
        expect(h.attest).not.toHaveBeenCalled()
        expect(h.readConfig).not.toHaveBeenCalled()
        // Failed validation must release the reservation, not poison future valid requests.
        await leaseOf(h.registry)
        expect(h.attest).toHaveBeenCalledTimes(1)
        h.registry.dispose()
        expect(getEventListeners(source.signal, 'abort')).toEqual([prior])
        expect(vi.getTimerCount()).toBe(0)
        expect(hook).not.toHaveBeenCalled()
        expect(Object.getOwnPropertyDescriptor(source.signal, 'aborted')).toEqual(descriptor)
        expect(Object.getPrototypeOf(source.signal)).toBe(AbortSignal.prototype)
      } finally {
        h.registry.dispose()
        Reflect.deleteProperty(source.signal, 'aborted')
        await source.settle()
        source.signal.removeEventListener('abort', prior)
      }
      expect(getEventListeners(source.signal, 'abort')).toHaveLength(0)
    }
  )
  it.each([
    'proxy',
    'revoked-proxy',
    'custom-prototype',
    'proxy-prototype',
    'null-prototype',
    'fake-native-prototype',
    'aborted',
    'addEventListener',
    'removeEventListener'
  ])('rejects %s shape before native registration without probing user hooks', async (kind) => {
    const h = setup()
    const source = new AbortController()
    const hook = vi.fn(() => {
      throw new Error('must not invoke a signal hook')
    })
    const traps = { get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook }
    let signal = source.signal
    if (kind === 'proxy') signal = new Proxy(signal, traps)
    if (kind === 'revoked-proxy') {
      const proxy = Proxy.revocable(signal, traps)
      proxy.revoke()
      signal = proxy.proxy
    }
    if (kind === 'custom-prototype')
      Object.setPrototypeOf(
        signal,
        Object.defineProperty(Object.create(AbortSignal.prototype), 'aborted', { get: hook })
      )
    if (kind === 'proxy-prototype')
      Object.setPrototypeOf(signal, new Proxy(AbortSignal.prototype, traps))
    if (kind === 'null-prototype') Object.setPrototypeOf(signal, null)
    if (kind === 'fake-native-prototype') signal = Object.create(AbortSignal.prototype)
    if (['aborted', 'addEventListener', 'removeEventListener'].includes(kind))
      Object.defineProperty(signal, kind, { value: kind === 'aborted' ? false : hook })
    for (let index = 0; index < 3; index++)
      expect(await h.registry.acquire(ref, deadline(signal))).toEqual({
        status: 'error',
        error: 'INVALID_REQUEST'
      })
    expect(hook).not.toHaveBeenCalled()
    expect(h.attest).not.toHaveBeenCalled()
    expect(h.readConfig).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    h.registry.dispose()
    expect(hook).not.toHaveBeenCalled()
    // Restore only the test fixture, after proving the registry did not probe its hooks.
    Object.setPrototypeOf(source.signal, AbortSignal.prototype)
    expect(getEventListeners(source.signal, 'abort')).toHaveLength(0)
  })
  it.each(kinds)(
    'supports pre-aborted native %s without registering or retaining capacity',
    async (kind) => {
      const h = setup()
      const source = external(kind)
      const prior = vi.fn()
      source.signal.addEventListener('abort', prior)
      await source.settle()
      expect(source.signal.aborted).toBe(true)
      for (let index = 0; index < 3; index++) {
        expect(await h.registry.acquire(ref, deadline(source.signal))).toEqual({
          status: 'error',
          error: 'CANCELLED'
        })
        expect(getEventListeners(source.signal, 'abort')).toEqual([prior])
        expect(vi.getTimerCount()).toBe(0)
      }
      expect(h.attest).not.toHaveBeenCalled()
      expect(h.readConfig).not.toHaveBeenCalled()
      await leaseOf(h.registry)
      h.registry.dispose()
      expect(getEventListeners(source.signal, 'abort')).toEqual([prior])
      expect(vi.getTimerCount()).toBe(0)
      source.signal.removeEventListener('abort', prior)
    }
  )
  it.each(kinds)(
    'keeps normal %s revocation, full-config binding and deadline cleanup leak-free',
    async (kind) => {
      const h = setup()
      const source = external(kind)
      const prior = vi.fn()
      source.signal.addEventListener('abort', prior)
      try {
        let count = 0
        for (const mode of ['revoke', 'commit', 'runtime', 'config', 'expiry', 'dispose']) {
          const lease = await leaseOf(h.registry, deadline(source.signal))
          count++
          expect(h.registry.isCurrent(lease)).toBe(true)
          expect(getEventListeners(source.signal, 'abort')).toHaveLength(2)
          expect(await h.registry.acquire(ref, deadline(source.signal))).toEqual({
            status: 'error',
            error: 'BUSY'
          })
          expect(h.attest).toHaveBeenCalledTimes(count)
          if (mode === 'revoke') h.registry.revoke()
          if (mode === 'commit') h.commit()
          if (mode === 'runtime') h.changeRuntime('synthetic-runtime-2')
          if (mode === 'config') {
            ;(h.state.config as ReturnType<typeof fixture>).unrelated.enabled = true
            expect(h.registry.isCurrent(lease)).toBe(false)
          }
          if (mode === 'expiry') vi.advanceTimersByTime(10_000)
          if (mode === 'dispose') h.registry.dispose()
          expect(lease.signal.aborted).toBe(true)
          expect(h.registry.isCurrent(lease)).toBe(false)
          expect(getEventListeners(source.signal, 'abort')).toEqual([prior])
          expect(vi.getTimerCount()).toBe(0)
        }
        expect(Object.getOwnPropertyNames(source.signal)).toEqual([])
        expect(Object.getPrototypeOf(source.signal)).toBe(AbortSignal.prototype)
      } finally {
        h.registry.dispose()
        await source.settle()
        source.signal.removeEventListener('abort', prior)
      }
      expect(getEventListeners(source.signal, 'abort')).toHaveLength(0)
    }
  )
  it.each(kinds)(
    'honors unsuppressible %s cancellation while retaining an ignored attestor slot',
    async (kind) => {
      const h = setup()
      const source = external(kind)
      const prior = vi.fn((event: Event) => event.stopImmediatePropagation())
      source.signal.addEventListener('abort', prior, { once: true })
      const wait = deferred<LocalComfyAttestation>()
      h.attest.mockImplementationOnce(() => wait.promise)
      const pending = h.registry.acquire(ref, deadline(source.signal))
      const [candidate, signal] = h.attest.mock.calls[0]
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await source.settle()
      expect(signal.aborted).toBe(true)
      expect(prior).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      expect(getEventListeners(source.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(await h.registry.acquire(ref, deadline())).toEqual({ status: 'error', error: 'BUSY' })
      expect(h.attest).toHaveBeenCalledTimes(1)
      wait.resolve(attestation(candidate))
      expect(await pending).toEqual({ status: 'error', error: 'CANCELLED' })
      await leaseOf(h.registry)
      h.registry.dispose()
      expect(getEventListeners(source.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it.each(kinds)(
    'honors unsuppressible %s cancellation of an issued lease immediately',
    async (kind) => {
      const h = setup()
      const source = external(kind)
      const prior = vi.fn((event: Event) => event.stopImmediatePropagation())
      source.signal.addEventListener('abort', prior, { once: true })
      const lease = await leaseOf(h.registry, deadline(source.signal))
      await source.settle()
      expect(lease.signal.aborted).toBe(true)
      expect(prior).toHaveBeenCalledTimes(1)
      expect(h.registry.isCurrent(lease)).toBe(false)
      expect(getEventListeners(source.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      h.registry.dispose()
      expect(getEventListeners(source.signal, 'abort')).toHaveLength(0)
    }
  )
  it.each(kinds)(
    'rolls back the exact %s wrapper/capture if trusted native add throws after linking',
    async (kind) => {
      const source = external(kind)
      const prior = vi.fn()
      source.signal.addEventListener('abort', prior)
      const nativeAdd = EventTarget.prototype.addEventListener
      const nativeRemove = EventTarget.prototype.removeEventListener
      const added: Parameters<typeof nativeAdd>[] = []
      const removed: Parameters<typeof nativeRemove>[] = []
      // Test-only fault injection BEFORE module capture, not a production adapter/bypass option.
      vi.resetModules()
      vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
        this: EventTarget,
        ...args
      ) {
        nativeAdd.call(this, ...args)
        if (this === source.signal) {
          added.push(args)
          expect(getEventListeners(source.signal, 'abort')).toHaveLength(2)
          throw new Error('synthetic trusted add failure after link')
        }
      })
      vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
        this: EventTarget,
        ...args
      ) {
        if (this === source.signal) removed.push(args)
        nativeRemove.call(this, ...args)
      })
      try {
        const isolated = await import('./localComfyCapability')
        const h = setup({}, isolated.createLocalComfyCapabilityRegistry)
        for (let index = 0; index < 3; index++) {
          expect(await h.registry.acquire(ref, deadline(source.signal))).toEqual({
            status: 'error',
            error: 'UNAVAILABLE'
          })
          expect(added).toHaveLength(index + 1)
          expect(removed).toHaveLength(index + 1)
          expect(removed[index][0]).toBe(added[index][0])
          expect(removed[index][1]).toBe(added[index][1])
          expect(removed[index][2]).toBe(added[index][2])
          expect(getEventListeners(source.signal, 'abort')).toEqual([prior])
          expect(vi.getTimerCount()).toBe(0)
        }
        expect(h.attest).not.toHaveBeenCalled()
        expect(h.readConfig).not.toHaveBeenCalled()
        await leaseOf(h.registry)
        expect(h.attest).toHaveBeenCalledTimes(1)
        h.registry.dispose()
        expect(getEventListeners(source.signal, 'abort')).toEqual([prior])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.restoreAllMocks()
        vi.resetModules()
        await source.settle()
        nativeRemove.call(source.signal, 'abort', prior)
      }
      expect(getEventListeners(source.signal, 'abort')).toHaveLength(0)
    }
  )
})
