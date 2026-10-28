import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FigPluginBridgeError,
  type FigPluginBridgePrepareRequest,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  figPluginPlanningAuditEventSchema,
  type FigPluginPlanningAuditEvent
} from '@shared/figplugin/planningAudit'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { ProviderCircuitBreaker } from './providerCircuitBreaker'

type Options = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
const binding: FigPluginRuntimeBinding = {
  pluginId: 'owned.figma',
  host: 'figma',
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'owned-project',
  profileId: 'owned-profile',
  profileRevision: 'd'.repeat(64)
}
const request = (): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  sequence: 1,
  requestId: 'client-request',
  prompt: 'Private design instructions',
  context: {
    selectionRevision: 'private-selection',
    nodes: [{ id: '1:2', type: 'TEXT', name: 'Private design label', locked: false }]
  }
})
const runtimes: FigPluginBridgeRuntime[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  vi.useRealTimers()
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const fixture = async (options: Partial<Options> = {}) => {
  const events: FigPluginPlanningAuditEvent[] = []
  const invoke = vi
    .fn<Options['invoke']>()
    .mockImplementation(async (_b, _p, _s, _c, dispatch, check) => {
      check()
      dispatch()
      return { content: 'Private response text', reportedTotalTokens: 12 }
    })
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: async () => true,
    planningAudit: (event) => events.push(structuredClone(event)),
    planningProfile: () => ({ provider: 'openai', modelName: 'Bound model' }),
    invoke,
    ...options
  })
  runtimes.push(runtime)
  const ticket = await runtime.createPairing(binding)
  const session = await runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host: ticket.host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'e'.repeat(32)
  })
  const prepare = (input = request()) =>
    runtime.prepare(session.sessionId, session.sessionToken, input)
  const approve = async () => {
    const preview = runtime.listPreviews()[0]
    await runtime.approve(preview.callId, preview.payloadSha256)
    await vi.advanceTimersByTimeAsync(0)
  }
  const cancel = (callId: string) => runtime.cancel(session.sessionId, session.sessionToken, callId)
  return { runtime, events, invoke, session, ticket, prepare, approve, cancel }
}
const expectValid = (events: FigPluginPlanningAuditEvent[]) => {
  expect(events.length).toBeGreaterThan(0)
  for (const event of events) expect(figPluginPlanningAuditEventSchema.parse(event)).toEqual(event)
}

describe('planning lifecycle audit', () => {
  it('records read-only success without inventing native execution evidence or leaking content', async () => {
    const f = await fixture()
    expect(f.events).toEqual([])
    const input = request()
    const receipt = await f.prepare(input)
    expect(f.events).toHaveLength(1)
    expect(f.events[0]).toMatchObject({
      callId: receipt.callId,
      requestId: input.requestId,
      kind: 'planning',
      state: 'awaiting-approval',
      featureId: 'read-only-analysis',
      sequence: 1,
      inputBytes: Buffer.byteLength(JSON.stringify(input)),
      nodeCount: 1,
      imageCount: 0,
      imageBytes: 0,
      provider: 'openai',
      modelName: 'Bound model',
      profileRevision: binding.profileRevision
    })
    expect(await f.prepare()).toEqual(receipt)
    expect(f.events).toHaveLength(1)
    input.prompt = 'Later mutable input'
    await vi.advanceTimersByTimeAsync(25)
    await f.approve()
    expect(f.events.map((event) => event.state)).toEqual([
      'awaiting-approval',
      'running',
      'provider-dispatched',
      'completed'
    ])
    expect(f.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(new Set(f.events.map((event) => event.correlationId)).size).toBe(1)
    expect(f.invoke.mock.calls[0][3]).toBe(f.events[0].correlationId)
    expect(f.events.at(-1)).toMatchObject({
      durationMs: 25,
      resultBytes: Buffer.byteLength('Private response text'),
      reportedTotalTokens: 12
    })
    expect(f.runtime.listPlanExecutions()).toEqual([])
    const serialized = JSON.stringify(f.events)
    for (const secret of [
      input.prompt,
      'Private design instructions',
      'Private design label',
      'private-selection',
      'Private response text',
      f.session.sessionToken,
      f.ticket.pairingSecret,
      'executionId',
      'planSha256',
      'context',
      'prompt'
    ])
      expect(serialized).not.toContain(secret)
    expectValid(f.events)
  })

  it.each(['denied', 'cancelled', 'expired', 'configuration-changed', 'dispose'] as const)(
    'records %s before dispatch exactly once',
    async (action) => {
      const f = await fixture()
      const receipt = await f.prepare()
      if (action === 'denied') f.runtime.deny(receipt.callId)
      else if (action === 'cancelled') await f.cancel(receipt.callId)
      else if (action === 'expired') await vi.advanceTimersByTimeAsync(120_001)
      else if (action === 'configuration-changed') f.runtime.revokePlugin(binding.pluginId)
      else f.runtime.dispose()
      expect(f.invoke).not.toHaveBeenCalled()
      expect(f.events).toHaveLength(2)
      expect(f.events.at(-1)).toMatchObject({
        state:
          action === 'configuration-changed'
            ? 'failed'
            : action === 'dispose'
              ? 'cancelled'
              : action,
        errorCode:
          action === 'configuration-changed'
            ? 'CONFIGURATION_CHANGED'
            : action === 'dispose'
              ? 'CANCELLED'
              : action === 'denied'
                ? 'DENIED'
                : action === 'expired'
                  ? 'EXPIRED'
                  : 'CANCELLED'
      })
      f.runtime.dispose()
      expect(f.events).toHaveLength(2)
      expectValid(f.events)
    }
  )

  it('distinguishes pre-dispatch validation failure from a model handoff', async () => {
    const f = await fixture({
      invoke: async () => {
        throw new Error('credential=private')
      }
    })
    await f.prepare()
    await f.approve()
    expect(f.events.map((event) => event.state)).toEqual(['awaiting-approval', 'running', 'failed'])
    expect(f.events.at(-1)?.errorCode).toBe('UPSTREAM_FAILED')
    expect(JSON.stringify(f.events)).not.toContain('credential')
    expectValid(f.events)
  })

  it('does not let local rejection consume a half-open probe or refresh old provider evidence', async () => {
    const circuit = new ProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 50 })
    const providerKey = `${binding.host}:${binding.profileId}:${binding.profileRevision}`
    let mode: 'upstream-failure' | 'local-failure' | 'success' = 'upstream-failure'
    let lastCheck!: () => void
    const f = await fixture({
      providerCircuit: circuit,
      invoke: async (_b, _p, _s, _c, dispatch, check) => {
        if (mode === 'local-failure') throw new Error('Private local preflight failure')
        lastCheck = check
        check()
        check()
        dispatch()
        if (mode === 'upstream-failure') throw new Error('Private service failure')
        return { content: 'Recovered model result' }
      }
    })
    const run = async (sequence: number) => {
      await f.prepare({ ...request(), sequence, requestId: `request-${sequence}` })
      await f.approve()
    }
    await run(1)
    const failed = circuit.snapshot(providerKey)
    expect(failed).toMatchObject({ state: 'open', failureCount: 1, probeInFlight: false })
    expect(
      (await f.runtime.readiness(f.session.sessionId, f.session.sessionToken)).provider
    ).toEqual({ state: 'not-ready', code: 'provider-circuit-open' })
    mode = 'local-failure'
    await vi.advanceTimersByTimeAsync(50)
    await run(2)
    expect(circuit.snapshot(providerKey)).toEqual(failed)
    await vi.advanceTimersByTimeAsync(60_000)
    await run(3)
    expect(circuit.snapshot(providerKey)).toEqual(failed)
    expect(
      (await f.runtime.readiness(f.session.sessionId, f.session.sessionToken)).provider
    ).toEqual({ state: 'unknown', code: 'provider-not-probed' })
    expect(f.events.filter((event) => event.state === 'provider-dispatched')).toHaveLength(1)
    mode = 'success'
    await run(4)
    const recovered = circuit.snapshot(providerKey)
    expect(recovered).toMatchObject({ state: 'closed', failureCount: 0, probeInFlight: false })
    expect(
      (await f.runtime.readiness(f.session.sessionId, f.session.sessionToken)).provider
    ).toEqual({ state: 'ready', code: 'provider-observed' })
    expect(() => lastCheck()).toThrow()
    expect(circuit.snapshot(providerKey)).toEqual(recovered)
    expectValid(f.events)
  })

  it('releases an acquired half-open permit when cancellation wins before the model handoff', async () => {
    const circuit = new ProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 50 })
    const providerKey = `${binding.host}:${binding.profileId}:${binding.profileRevision}`
    expect(circuit.allow(providerKey)).toBe(true)
    circuit.complete(providerKey, 'failure')
    await vi.advanceTimersByTimeAsync(50)
    const f = await fixture({
      providerCircuit: circuit,
      invoke: async (_b, preview, _s, _c, _dispatch, check) => {
        check()
        expect(circuit.snapshot(providerKey)).toMatchObject({
          state: 'half-open',
          probeInFlight: true
        })
        await f.cancel(preview.callId)
        check()
        throw new Error('Unreachable model handoff')
      }
    })
    await f.prepare()
    await f.approve()
    expect(circuit.snapshot(providerKey)).toMatchObject({
      state: 'open',
      failureCount: 1,
      probeInFlight: false,
      retryAt: Date.now() + 50
    })
    expect(f.events.map((event) => event.state)).toEqual([
      'awaiting-approval',
      'running',
      'cancelled'
    ])
    expect(
      (await f.runtime.readiness(f.session.sessionId, f.session.sessionToken)).provider
    ).toEqual({ state: 'unknown', code: 'provider-not-probed' })
    expectValid(f.events)
  })

  it.each(['cancel', 'timeout', 'transport-revocation'] as const)(
    'keeps the terminal %s outcome when a dispatched provider later settles',
    async (action) => {
      const pending = deferred<{ content: string }>()
      let dispatch!: () => void
      const f = await fixture({
        invoke: async (_b, _p, _s, _c, notify, check) => {
          check()
          dispatch = notify
          notify()
          notify()
          return pending.promise
        }
      })
      const receipt = await f.prepare()
      await f.approve()
      if (action === 'cancel') await f.cancel(receipt.callId)
      else if (action === 'timeout') await vi.advanceTimersByTimeAsync(90_001)
      else f.runtime.revokeTransport()
      expect(f.events.map((event) => event.state)).toEqual([
        'awaiting-approval',
        'running',
        'provider-dispatched',
        action === 'cancel' ? 'cancelled' : 'failed'
      ])
      expect(f.events.at(-1)?.errorCode).toBe(
        action === 'cancel'
          ? 'CANCELLED'
          : action === 'timeout'
            ? 'TIMEOUT'
            : 'CONFIGURATION_CHANGED'
      )
      expect(() => dispatch()).not.toThrow()
      pending.resolve({ content: 'Late private result' })
      await vi.advanceTimersByTimeAsync(0)
      expect(f.events).toHaveLength(4)
      expect(JSON.stringify(f.events)).not.toContain('Late private result')
      expectValid(f.events)
    }
  )

  it('does not rewrite a completed audit outcome when TTL or session cleanup runs', async () => {
    const f = await fixture()
    await f.prepare()
    await f.approve()
    const before = structuredClone(f.events)
    await vi.advanceTimersByTimeAsync(600_001)
    f.runtime.dispose()
    expect(f.events).toEqual(before)
    expect(f.events.at(-1)?.state).toBe('completed')
  })

  it('retains only safe snapshot metadata and never reads changed profile labels for later events', async () => {
    const metadata = { provider: 'openai', modelName: 'Original model' }
    const profile = vi.fn(() => metadata)
    const f = await fixture({ planningProfile: profile })
    await f.prepare()
    metadata.modelName = 'New model'
    metadata.provider = 'other'
    await f.approve()
    expect(profile).toHaveBeenCalledOnce()
    for (const event of f.events)
      expect(event).toMatchObject({ provider: 'openai', modelName: 'Original model' })
    const invalid = await fixture({
      planningProfile: () => ({ provider: 'https://secret.invalid', modelName: 'bad\nsecret' })
    })
    await invalid.prepare()
    await invalid.approve()
    expect(invalid.events).toHaveLength(4)
    for (const event of invalid.events) {
      expect(event).not.toHaveProperty('provider')
      expect(event).not.toHaveProperty('modelName')
    }
    expectValid(invalid.events)
  })

  it('rejects invalid/unowned input without creating audit authority', async () => {
    const f = await fixture()
    await expect(f.prepare({ ...request(), prompt: '' })).rejects.toBeDefined()
    await expect(
      f.runtime.prepare('0'.repeat(32), f.session.sessionToken, request())
    ).rejects.toBeDefined()
    expect(f.events).toEqual([])
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('records provider rejection only as the bounded error code', async () => {
    const f = await fixture({
      invoke: async (_b, _p, _s, _c, dispatch, check) => {
        check()
        dispatch()
        throw new FigPluginBridgeError('TIMEOUT')
      }
    })
    await f.prepare()
    await f.approve()
    expect(f.events.at(-1)).toMatchObject({ state: 'failed', errorCode: 'TIMEOUT' })
    expect(f.events.at(-1)).not.toHaveProperty('resultBytes')
    expectValid(f.events)
  })

  it('does not let a throwing audit sink turn an approved call into a retry or failed result', async () => {
    const audit = vi.fn(() => {
      throw new Error('disk unavailable')
    })
    const f = await fixture({ planningAudit: audit })
    const receipt = await f.prepare()
    await f.approve()
    expect(
      await f.runtime.status(f.session.sessionId, f.session.sessionToken, receipt.callId)
    ).toMatchObject({ status: 'completed' })
    expect(f.invoke).toHaveBeenCalledOnce()
    expect(audit).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(600_001)
    expect(audit).toHaveBeenCalledTimes(4)
  })
})
