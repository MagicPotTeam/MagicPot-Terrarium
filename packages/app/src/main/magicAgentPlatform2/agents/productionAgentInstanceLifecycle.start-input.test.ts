import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { MagicAgentPlatformRunReq, MagicAgentPlatformRunResp } from '../../../shared/api/svcMagicAgentPlatform'
import { canonicalPolicyJson } from '../../../shared/magicAgentPlatform2/policy'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import { ProductionAgentInstanceLifecycleService } from './productionAgentInstanceLifecycle'

const completed: MagicAgentPlatformRunResp = { runId: 'fixture-run', agentId: 'worker', status: 'completed', content: 'ok', messages: [], toolCalls: [], events: [], startedAt: 10, finishedAt: 11 }
const makeInput = () => ({
  instanceId: 'input-worker', expectedRevision: 0, actor: { kind: 'user' as const, id: 'owner', labels: { source: 'trusted' } }, idempotencyKey: 'start',
  request: { text: 'work', agentId: 'caller-value', route: { channel: 'fixture', scopeType: 'dm' as const, scopeId: 'original' }, allowedToolNames: ['read'], memory: { allowHistory: true, contextMessageLimit: 5, scope: 'session' as const }, metadata: { traceLabel: 'original', nested: { value: 'original' } } }
})
const setup = () => {
  const events = new MagicAgentEventStore(':memory:'), store = new PersistentAgentInstanceStore(events)
  store.create({ instance: { id: 'input-worker', name: 'Worker', definitionId: 'worker', configVersion: 'v1', depth: 0, status: 'created', limits: { maxChildren: 1, maxDepth: 1, maxConcurrency: 1, maxRuntimeMs: 100, allowedToolNames: ['read'], workspaceRoots: [] } }, createdAt: 1, idempotencyKey: 'create' })
  const authorize = vi.fn((_value: unknown) => ({ status: 'authorized', permit: {} })), consume = vi.fn(), run = vi.fn(async (_request: MagicAgentPlatformRunReq) => completed)
  const lifecycle = new ProductionAgentInstanceLifecycleService(store, { authorize, consumeExecutionPermit: consume } as never, run, () => 10)
  return { events, store, authorize, consume, run, lifecycle }
}

describe('managed lifecycle start input capture prerequisite (not ledger admission)', () => {
  it('detaches nested request and actor before authorization can mutate caller data', async () => {
    const s = setup(), input = makeInput(), initial = structuredClone(input)
    const digest = createHash('sha256').update(canonicalPolicyJson(initial.request as never)).digest('hex')
    s.authorize.mockImplementationOnce(() => {
      input.request.route.scopeId = 'changed'
      input.request.memory.allowHistory = false
      input.request.metadata.nested.value = 'changed'
      input.request.allowedToolNames.push('write')
      input.actor.id = 'changed-owner'
      input.actor.labels.source = 'changed'
      return { status: 'authorized', permit: {} }
    })
    try {
      await s.lifecycle.start(input)
      expect(s.run).toHaveBeenCalledTimes(1)
      expect(s.run.mock.calls[0][0]).toMatchObject({ ...initial.request, agentId: 'worker' })
      expect(s.consume.mock.calls[0][0].request.actor).toEqual(initial.actor)
      expect(s.consume.mock.calls[0][0].request.input.requestDigest).toBe(digest)
      expect(input.request.route.scopeId).toBe('changed')
      expect(input.actor.id).toBe('changed-owner')
    } finally { await s.lifecycle.close(); s.events.close() }
  })

  it.each(['command-proxy', 'field-accessor', 'request-proxy', 'route-accessor', 'actor-proxy', 'actor-accessor', 'metadata-toJSON'] as const)('rejects %s before execution or accessor evaluation', async shape => {
    const s = setup(), touched = vi.fn(() => 'original')
    let input = makeInput()
    if (shape === 'command-proxy') input = new Proxy(input, { ownKeys() { touched(); throw new Error('not data') } })
    if (shape === 'field-accessor') Object.defineProperty(input, 'request', { enumerable: true, get() { touched(); return makeInput().request } })
    if (shape === 'request-proxy') input.request = new Proxy(input.request, { ownKeys() { touched(); throw new Error('not data') } })
    if (shape === 'route-accessor') Object.defineProperty(input.request.route, 'scopeId', { enumerable: true, get: touched })
    if (shape === 'actor-proxy') input.actor = new Proxy(input.actor, { ownKeys() { touched(); throw new Error('not data') } })
    if (shape === 'actor-accessor') Object.defineProperty(input.actor, 'id', { enumerable: true, get: touched })
    if (shape === 'metadata-toJSON') Object.assign(input.request.metadata, { toJSON() { touched(); return {} } })
    try {
      await expect(s.lifecycle.start(input)).rejects.toThrow(/plain|data|proxy|proxies|getter|json|field/i)
      expect(touched).not.toHaveBeenCalled()
      expect(s.authorize).not.toHaveBeenCalled()
      expect(s.consume).not.toHaveBeenCalled()
      expect(s.run).not.toHaveBeenCalled()
      expect(s.store.get('input-worker')?.state.status).toBe('created')
    } finally { await s.lifecycle.close(); s.events.close() }
  })

  it.each(['store-read', 'clock', 'permit-consumption'] as const)('captures before the first %s callout can change nested request', async stage => {
    const s = setup(), input = makeInput(), initial = structuredClone(input)
    const mutate = () => { input.request.route.scopeId = 'changed'; input.actor.labels.source = 'changed' }
    if (stage === 'store-read') {
      const get = s.store.get.bind(s.store)
      vi.spyOn(s.store, 'get').mockImplementationOnce(id => { mutate(); return get(id) })
    } else if (stage === 'clock') {
      // This is the actual injected lifecycle clock, not a dispatch-side observer.
      const clocked = new ProductionAgentInstanceLifecycleService(s.store, { authorize: s.authorize, consumeExecutionPermit: s.consume } as never, s.run, () => { mutate(); return 10 })
      try {
        await clocked.start(input)
        expect(s.run.mock.calls[0][0].route).toEqual(initial.request.route)
        expect(s.consume.mock.calls[0][0].request.actor).toEqual(initial.actor)
      } finally { await clocked.close(); await s.lifecycle.close(); s.events.close() }
      return
    } else s.consume.mockImplementationOnce(mutate)
    try {
      await s.lifecycle.start(input)
      expect(s.run.mock.calls[0][0].route).toEqual(initial.request.route)
      expect(s.consume.mock.calls[0][0].request.actor).toEqual(initial.actor)
    } finally { await s.lifecycle.close(); s.events.close() }
  })

  it('preserves the existing exact request digest for explicitly undefined optional object fields', async () => {
    const s = setup(), input = makeInput()
    Object.assign(input.request, { profileId: undefined, timeoutMs: undefined })
    const digest = createHash('sha256').update(canonicalPolicyJson(input.request as never)).digest('hex')
    try {
      await s.lifecycle.start(input)
      expect(s.consume.mock.calls[0][0].request.input.requestDigest).toBe(digest)
      expect(Object.hasOwn(s.run.mock.calls[0][0], 'profileId')).toBe(true)
    } finally { await s.lifecycle.close(); s.events.close() }
  })

  it('detaches attachment data and base64 binary frames before policy callouts', async () => {
    const s = setup(), input = makeInput()
    const attachment = { type: 'file' as const, url: 'data:text/plain;base64,YQ==', fileName: 'original.txt', metadata: { nested: { value: 'original' } }, binary: { transport: 'chunked-binary-v1' as const, reference: { version: 1 as const, kind: 'content-addressed-binary' as const, sha256: 'a'.repeat(64), sizeBytes: 1, mimeType: 'text/plain', chunkSize: 1, chunkCount: 1 }, chunks: [{ version: 1 as const, kind: 'content-addressed-binary-chunk' as const, sha256: 'a'.repeat(64), index: 0, chunkCount: 1, bytesBase64: 'YQ==' }] } }
    Object.assign(input.request, { attachments: [attachment] })
    const initial = structuredClone(attachment)
    s.authorize.mockImplementationOnce(() => {
      attachment.fileName = 'changed.txt'; attachment.metadata.nested.value = 'changed'; attachment.binary.chunks[0].bytesBase64 = 'Yg=='
      return { status: 'authorized', permit: {} }
    })
    try {
      await s.lifecycle.start(input)
      expect(s.run.mock.calls[0][0].attachments).toEqual([initial])
      expect(attachment.fileName).toBe('changed.txt')
      expect(Object.isFrozen(attachment)).toBe(false)
      expect(Object.isFrozen(s.run.mock.calls[0][0].attachments?.[0].binary?.chunks)).toBe(true)
    } finally { await s.lifecycle.close(); s.events.close() }
  })

  it('accepts frozen data and null-prototype metadata without freezing shared caller data', async () => {
    const s = setup(), input = makeInput()
    const shared = { label: 'original' }, metadata = Object.assign(Object.create(null), { first: shared, second: shared })
    Object.assign(input.request, { metadata })
    Object.freeze(input.request.route)
    Object.freeze(input.request.allowedToolNames)
    try {
      await s.lifecycle.start(input)
      expect(s.run.mock.calls[0][0].metadata).toEqual(metadata)
      expect(Object.getPrototypeOf(s.run.mock.calls[0][0].metadata)).toBe(null)
      shared.label = 'changed'
      expect((s.run.mock.calls[0][0].metadata?.first as { label: string }).label).toBe('original')
      expect(Object.isFrozen(shared)).toBe(false)
    } finally { await s.lifecycle.close(); s.events.close() }
  })

  it.each(['array-accessor', 'sparse-array', 'named-array', 'undefined-array-item', 'symbol-key', 'hidden-field', 'cycle', 'exotic-prototype', 'revoked-proxy', '__proto__', 'constructor'] as const)('rejects nested %s before policy or dispatch', async shape => {
    const s = setup(), input = makeInput(), touched = vi.fn(() => 'read')
    if (shape === 'array-accessor') Object.defineProperty(input.request.allowedToolNames, '0', { enumerable: true, get: touched })
    if (shape === 'sparse-array') delete (input.request.allowedToolNames as unknown[])[0]
    if (shape === 'named-array') Object.assign(input.request.allowedToolNames, { extra: 'value' })
    if (shape === 'undefined-array-item') (input.request.allowedToolNames as unknown[])[0] = undefined
    if (shape === 'exotic-prototype') Object.assign(input.request.metadata, { date: new Date(0) })
    if (shape === 'revoked-proxy') { const p = Proxy.revocable({}, {}); p.revoke(); Object.assign(input.request.metadata, { revoked: p.proxy }) }
    if (shape === '__proto__' || shape === 'constructor') Object.defineProperty(input.request.metadata, shape, { enumerable: true, value: { polluted: true } })
    if (shape === 'symbol-key') Object.assign(input.request.metadata, { [Symbol('hidden')]: 'value' })
    if (shape === 'hidden-field') Object.defineProperty(input.request.metadata, 'hidden', { value: 'value' })
    if (shape === 'cycle') Object.assign(input.request.metadata, { self: input.request.metadata })
    try {
      await expect(s.lifecycle.start(input)).rejects.toThrow(/plain|data|getter|array|field|symbol|cycl|json/i)
      expect(touched).not.toHaveBeenCalled()
      expect(s.authorize).not.toHaveBeenCalled()
      expect(s.consume).not.toHaveBeenCalled()
      expect(s.run).not.toHaveBeenCalled()
    } finally { await s.lifecycle.close(); s.events.close() }
  })

  it('keeps optional absent values compatible without freezing caller-owned request', async () => {
    const s = setup(), input = makeInput()
    Object.assign(input, { grantId: undefined, expectedGrantUseCount: undefined })
    Object.assign(input.request, { profileId: undefined, timeoutMs: undefined, metadata: undefined })
    try {
      await s.lifecycle.start(input)
      expect(s.run).toHaveBeenCalledTimes(1)
      expect(Object.isFrozen(input.request)).toBe(false)
      expect(Object.isFrozen(input.request.route)).toBe(false)
    } finally { await s.lifecycle.close(); s.events.close() }
  })
})
