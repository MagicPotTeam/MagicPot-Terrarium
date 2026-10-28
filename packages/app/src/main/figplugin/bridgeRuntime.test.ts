import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  FigPluginBridgeError,
  figPluginBridgePreviewSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginPairResponseSchema,
  type FigPluginBridgePrepareRequest,
  type FigPluginPairRequest,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { ProviderCircuitBreaker } from './providerCircuitBreaker'

type Options = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
type Pairing = Awaited<ReturnType<FigPluginBridgeRuntime['createPairing']>>
const binding: FigPluginRuntimeBinding = {
  pluginId: 'demo.figma',
  host: 'figma',
  generation: 7,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'native_project',
  profileId: 'provider::model',
  profileRevision: 'd'.repeat(64)
}
const request = (sequence = 1): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  sequence,
  requestId: `request_${sequence}`,
  prompt: 'Describe 界\u{1f331}',
  context: {
    nodes: [{ id: '1:2', type: 'FRAME', name: 'Visible label', locked: false }],
    selectionRevision: 'revision-1',
    documentLabel: 'Explicit document label'
  }
})
const envelope = (ticket: Pairing): FigPluginPairRequest => ({
  protocol: 1,
  ticketId: ticket.ticketId,
  pairingSecret: ticket.pairingSecret,
  pluginId: ticket.pluginId,
  host: ticket.host,
  artifactSha256: ticket.artifactSha256,
  clientNonce: 'e'.repeat(32)
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
const runtimes: FigPluginBridgeRuntime[] = []
const make = (options: Partial<Options> = {}) => {
  const validate = vi.fn<Options['validateBinding']>().mockResolvedValue(true)
  const invoke = vi
    .fn<Options['invoke']>()
    .mockResolvedValue({ content: '  Plain output\n', reportedTotalTokens: 12 })
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: validate,
    // The default stand-in models a service handoff, not Controller preflight.
    invoke: (...args) => {
      args[5]()
      const response = (async () => invoke(...args))()
      args[4]()
      return response
    },
    ...options
  })
  runtimes.push(runtime)
  return { runtime, validate, invoke }
}
const pair = async (
  runtime: FigPluginBridgeRuntime,
  value = binding
): Promise<FigPluginPairResponse> => runtime.redeem(envelope(await runtime.createPairing(value)))
const prepare = (
  runtime: FigPluginBridgeRuntime,
  session: FigPluginPairResponse,
  value = request()
) => runtime.prepare(session.sessionId, session.sessionToken, value)
const status = (runtime: FigPluginBridgeRuntime, session: FigPluginPairResponse, callId: string) =>
  runtime.status(session.sessionId, session.sessionToken, callId)
const cancel = (runtime: FigPluginBridgeRuntime, session: FigPluginPairResponse, callId: string) =>
  runtime.cancel(session.sessionId, session.sessionToken, callId)
const fixture = async (options: Partial<Options> = {}) => {
  const value = make(options)
  const session = await pair(value.runtime)
  const prepared = await prepare(value.runtime, session)
  const preview = value.runtime.listPreviews()[0]
  return { ...value, session, prepared, preview }
}
const settle = () => vi.advanceTimersByTimeAsync(0)
const errorCode = (code: keyof typeof FIGPLUGIN_BRIDGE_ERRORS) => ({
  code,
  message: FIGPLUGIN_BRIDGE_ERRORS[code]
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  vi.useRealTimers()
})

describe('FigPluginBridgeRuntime pairing and authentication', () => {
  it('revokes volatile tickets and bearer sessions when the transport epoch is lost', async () => {
    const { runtime, session, prepared } = await fixture()
    expect(runtime.listSessions()).toHaveLength(1)

    runtime.revokeTransport()

    expect(runtime.listSessions()).toEqual([])
    await expect(status(runtime, session, prepared.callId)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    await expect(prepare(runtime, session)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
  })

  it('issues unpredictable, exact-width tickets and sessions only after validation', async () => {
    const { runtime, validate, invoke } = make()
    const ticket = await runtime.createPairing(binding)
    const other = await runtime.createPairing(binding)
    expect(ticket.ticketId).toMatch(/^[a-f0-9]{32}$/)
    expect(ticket.pairingSecret).toMatch(/^[a-f0-9]{64}$/)
    expect(other.ticketId).not.toBe(ticket.ticketId)
    expect(other.pairingSecret).not.toBe(ticket.pairingSecret)
    expect(ticket).toMatchObject({
      expiresAt: Date.now() + 120_000,
      bridgeOrigin: binding.bridgeOrigin
    })
    expect(Object.keys(ticket).sort()).toEqual([
      'artifactSha256',
      'bridgeOrigin',
      'expiresAt',
      'host',
      'pairingSecret',
      'pluginId',
      'ticketId'
    ])
    const session = await runtime.redeem(envelope(ticket))
    expect(figPluginPairResponseSchema.parse(session)).toEqual(session)
    expect(session.expiresAt).toBe(Date.now() + 600_000)
    expect(session.sessionToken).not.toBe(ticket.pairingSecret)
    expect(validate).toHaveBeenCalledTimes(3)
    expect(validate).toHaveBeenLastCalledWith(binding)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('clones and freezes the full native binding before awaiting validation', async () => {
    const gate = deferred<boolean>()
    const { runtime, validate, invoke } = make()
    validate.mockReturnValueOnce(gate.promise)
    const mutable = { ...binding }
    const issuing = runtime.createPairing(mutable)
    mutable.profileRevision = 'f'.repeat(64)
    mutable.manifestSha256 = 'f'.repeat(64)
    mutable.projectId = 'substituted'
    expect(Object.isFrozen(validate.mock.calls[0][0])).toBe(true)
    gate.resolve(true)
    const ticket = await issuing
    const session = await runtime.redeem(envelope(ticket))
    await prepare(runtime, session)
    expect(validate).toHaveBeenLastCalledWith(binding)
    expect(runtime.listPreviews()[0]).toMatchObject({
      profileRevision: binding.profileRevision,
      projectId: binding.projectId
    })
  })

  it('sanitizes invalid bindings and validator exceptions without causes or snapshots', async () => {
    const { runtime, validate } = make()
    const bad = { ...binding, apiKey: 'PRIVATE-FIXTURE' }
    await expect(runtime.createPairing(bad)).rejects.toMatchObject(errorCode('INVALID_REQUEST'))
    expect(validate).not.toHaveBeenCalled()
    validate.mockRejectedValue(new Error('PRIVATE-FIXTURE'))
    const error = await runtime.createPairing(binding).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(FigPluginBridgeError)
    expect(error).toMatchObject(errorCode('CONFIGURATION_CHANGED'))
    expect((error as FigPluginBridgeError).cause).toBeUndefined()
    expect((error as FigPluginBridgeError).payload).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain('PRIVATE-FIXTURE')
    expect(String(error)).not.toContain(binding.profileId)
  })

  it('atomically consumes a ticket before async redemption and never retries a failed binding', async () => {
    const { runtime, validate } = make()
    const input = envelope(await runtime.createPairing(binding))
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const first = runtime.redeem(input)
    await expect(runtime.redeem(input)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    gate.resolve(false)
    await expect(first).rejects.toMatchObject(errorCode('CONFIGURATION_CHANGED'))
    await expect(runtime.redeem(input)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    expect(runtime.listSessions()).toEqual([])
  })

  it.each([
    { pluginId: 'other.figma' },
    { host: 'photoshop' },
    { artifactSha256: 'f'.repeat(64) },
    { clientNonce: 'not-32-hex' },
    { sessionToken: 'f'.repeat(64) }
  ])('rejects substituted pairing fields uniformly: %j', async (override) => {
    const { runtime, validate } = make()
    const input = envelope(await runtime.createPairing(binding))
    await expect(
      runtime.redeem({ ...input, ...override } as FigPluginPairRequest)
    ).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    expect(validate).toHaveBeenCalledTimes(1)
    expect(runtime.listSessions()).toEqual([])
  })

  it('invalidates a ticket on exactly five wrong attempts, including malformed credentials', async () => {
    const { runtime } = make()
    const input = envelope(await runtime.createPairing(binding))
    for (let index = 0; index < 5; index++) {
      await expect(
        runtime.redeem({ ...input, pairingSecret: index % 2 ? 'f'.repeat(64) : 'malformed' })
      ).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    }
    await expect(runtime.redeem(input)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
  })

  it('bounds the global pairing failure window independently of attacker-controlled IDs', async () => {
    const { runtime } = make()
    const input = envelope(await runtime.createPairing(binding))
    for (let index = 0; index < 20; index++) {
      await expect(
        runtime.redeem({ ...input, ticketId: index.toString(16).padStart(32, '0') })
      ).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    }
    // Rate-limited correct secrets are not counted as wrong ticket attempts.
    for (let index = 0; index < 6; index++) {
      await expect(runtime.redeem(input)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    }
    await vi.advanceTimersByTimeAsync(59_999)
    await expect(runtime.redeem(input)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    await vi.advanceTimersByTimeAsync(1)
    await expect(runtime.redeem(input)).resolves.toHaveProperty('sessionToken')
  })

  it('limits issuing reservations to 32 and expires tickets on the cleanup timer', async () => {
    const gate = deferred<boolean>()
    const { runtime, validate } = make()
    validate.mockReturnValue(gate.promise)
    const pending = Array.from({ length: 32 }, () => runtime.createPairing(binding))
    await expect(runtime.createPairing(binding)).rejects.toMatchObject(errorCode('BUSY'))
    gate.resolve(true)
    const tickets = await Promise.all(pending)
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(runtime.redeem(envelope(tickets[0]))).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    validate.mockResolvedValue(true)
    await expect(runtime.createPairing(binding)).resolves.toHaveProperty('ticketId')
  })

  it('counts pending redemptions in the 16-session admission limit', async () => {
    const { runtime, validate } = make()
    const tickets = await Promise.all(
      Array.from({ length: 17 }, () => runtime.createPairing(binding))
    )
    const gate = deferred<boolean>()
    validate.mockReturnValue(gate.promise)
    const pending = tickets.slice(0, 16).map((ticket) => runtime.redeem(envelope(ticket)))
    await expect(runtime.redeem(envelope(tickets[16]))).rejects.toMatchObject(errorCode('BUSY'))
    gate.resolve(true)
    const sessions = await Promise.all(pending)
    expect(runtime.listSessions()).toHaveLength(16)
    runtime.closeSession(sessions[0].sessionId, sessions[0].sessionToken)
    validate.mockResolvedValue(true)
    await expect(runtime.redeem(envelope(tickets[16]))).resolves.toHaveProperty('sessionId')
  })

  it('returns the same fixed unauthorized error for wrong, malformed and unknown credentials', async () => {
    const { runtime, session, prepared } = await fixture()
    for (const [id, token] of [
      [session.sessionId, 'f'.repeat(64)],
      [session.sessionId, session.sessionToken.toUpperCase()],
      [session.sessionId, `${session.sessionToken}\n`],
      [session.sessionId, ''],
      ['0'.repeat(32), session.sessionToken],
      ['malformed', session.sessionToken]
    ]) {
      await expect(runtime.status(id, token, prepared.callId)).rejects.toMatchObject(
        errorCode('UNAUTHORIZED')
      )
      await expect(runtime.prepare(id, token, request())).rejects.toMatchObject(
        errorCode('UNAUTHORIZED')
      )
      await expect(runtime.cancel(id, token, prepared.callId)).rejects.toMatchObject(
        errorCode('UNAUTHORIZED')
      )
      expect(() => runtime.closeSession(id, token)).toThrow(FIGPLUGIN_BRIDGE_ERRORS.UNAUTHORIZED)
    }
    await expect(status(runtime, session, '0'.repeat(32))).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    const other = await pair(runtime)
    await expect(status(runtime, other, prepared.callId)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    await expect(cancel(runtime, other, prepared.callId)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
  })

  it('expires idle sessions without traffic and does not refresh them on failed authentication', async () => {
    const { runtime, session, prepared } = await fixture()
    await vi.advanceTimersByTimeAsync(119_999)
    await expect(runtime.status(session.sessionId, 'bad', prepared.callId)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.listSessions()).toEqual([])
    expect(runtime.listPreviews()).toEqual([])
    await expect(status(runtime, session, prepared.callId)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
  })

  it('enforces ten-minute absolute expiry even when authenticated activity extends idle time', async () => {
    const { runtime, session, prepared } = await fixture()
    for (let index = 0; index < 5; index++) {
      await vi.advanceTimersByTimeAsync(100_000)
      await status(runtime, session, prepared.callId)
    }
    await vi.advanceTimersByTimeAsync(100_000)
    expect(runtime.listSessions()).toEqual([])
    await expect(prepare(runtime, session)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
  })
})

describe('FigPluginBridgeRuntime consent and replay', () => {
  it('reports layered readiness only after session authentication', async () => {
    const { runtime, session } = await fixture()
    await expect(runtime.readiness('not-a-session', session.sessionToken)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    const readiness = await runtime.readiness(session.sessionId, session.sessionToken)
    expect(readiness).toEqual({
      protocol: 1,
      kind: 'figplugin-bridge-readiness',
      checkedAt: Date.now(),
      bridge: { state: 'ready', code: 'bridge-reachable' },
      configuration: { state: 'ready', code: 'configuration-current' },
      provider: { state: 'unknown', code: 'provider-not-probed' },
      resources: { state: 'unknown', code: 'resources-not-probed' },
      host: {
        state: 'unknown',
        code: 'host-not-probed',
        host: binding.host,
        capabilities: { state: 'unknown', code: 'capabilities-not-probed' }
      }
    })
  })

  it('projects a paired host probe into diagnostics without granting execution authority', async () => {
    const { runtime, session } = await fixture()
    const before = runtime.listPreviews()
    const readiness = await runtime.readiness(session.sessionId, session.sessionToken, {
      protocol: 1,
      hostProbe: {
        host: 'figma',
        adapterVersion: 'figma-native-1',
        supports: ['node.rename', 'node.opacity', 'node.visibility', 'text.content', 'layout.flow'],
        rollback: 'verified-in-place',
        visualAudit: 'hash-only',
        document: { state: 'ready', code: 'document-open' },
        resources: {
          fonts: { state: 'ready', code: 'fonts-api-available' },
          visual: { state: 'ready', code: 'visual-api-available' }
        }
      }
    })
    expect(readiness.resources).toEqual({ state: 'ready', code: 'resources-observed' })
    expect(readiness.host).toEqual({
      state: 'ready',
      code: 'host-observed',
      host: 'figma',
      capabilities: { state: 'ready', code: 'capabilities-observed' }
    })
    // A readiness probe is never an execution request or a write authorization.
    expect(runtime.listPreviews()).toEqual(before)
  })

  it('reports incomplete native observations as not-ready while keeping the session alive', async () => {
    const { runtime, session } = await fixture()
    const readiness = await runtime.readiness(session.sessionId, session.sessionToken, {
      protocol: 1,
      hostProbe: {
        host: 'figma',
        adapterVersion: 'figma-unknown-1',
        supports: ['node.rename'],
        rollback: 'none',
        visualAudit: 'unavailable',
        document: { state: 'not-ready', code: 'document-unavailable' },
        resources: {
          fonts: { state: 'unknown', code: 'fonts-unknown' },
          visual: { state: 'unknown', code: 'visual-unknown' }
        }
      }
    })
    expect(readiness.resources).toEqual({ state: 'not-ready', code: 'document-unavailable' })
    expect(readiness.host.capabilities).toEqual({
      state: 'not-ready',
      code: 'adapter-unrecognized'
    })
    await expect(
      runtime.readiness(session.sessionId, session.sessionToken)
    ).resolves.toHaveProperty('host.capabilities.state', 'unknown')
  })

  it('does not turn an unknown document observation into a connected host', async () => {
    const { runtime, session } = await fixture()
    const readiness = await runtime.readiness(session.sessionId, session.sessionToken, {
      protocol: 1,
      hostProbe: {
        host: 'figma',
        adapterVersion: 'figma-native-1',
        supports: ['node.rename', 'node.opacity', 'node.visibility', 'text.content', 'layout.flow'],
        rollback: 'verified-in-place',
        visualAudit: 'hash-only',
        document: { state: 'unknown', code: 'document-probe-pending' },
        resources: {
          fonts: { state: 'ready', code: 'fonts-api-available' },
          visual: { state: 'ready', code: 'visual-api-available' }
        }
      }
    })
    expect(readiness.host).toEqual({
      state: 'unknown',
      code: 'document-probe-pending',
      host: 'figma',
      capabilities: { state: 'ready', code: 'capabilities-observed' }
    })
    expect(readiness.resources).toEqual({ state: 'unknown', code: 'document-probe-pending' })
  })

  it('fails closed for a native adapter major that is not negotiated', async () => {
    const { runtime, session } = await fixture()
    const readiness = await runtime.readiness(session.sessionId, session.sessionToken, {
      protocol: 1,
      hostProbe: {
        host: 'figma',
        adapterVersion: 'figma-native-2',
        supports: ['node.rename', 'node.opacity', 'node.visibility', 'text.content', 'layout.flow'],
        rollback: 'verified-in-place',
        visualAudit: 'hash-only',
        document: { state: 'ready', code: 'document-open' },
        resources: {
          fonts: { state: 'ready', code: 'fonts-api-available' },
          visual: { state: 'ready', code: 'visual-api-available' }
        }
      }
    })
    expect(readiness.host.capabilities).toEqual({
      state: 'not-ready',
      code: 'adapter-version-unsupported'
    })
  })

  it('does not accept an adapter from the other native host', async () => {
    const { runtime, session } = await fixture()
    const readiness = await runtime.readiness(session.sessionId, session.sessionToken, {
      protocol: 1,
      hostProbe: {
        host: 'figma',
        adapterVersion: 'photoshop-uxp-native-1',
        supports: ['node.rename', 'node.opacity', 'node.visibility', 'text.content', 'layout.flow'],
        rollback: 'verified-in-place',
        visualAudit: 'hash-only',
        document: { state: 'ready', code: 'document-open' },
        resources: {
          fonts: { state: 'ready', code: 'fonts-api-available' },
          visual: { state: 'ready', code: 'visual-api-available' }
        }
      }
    })
    expect(readiness.host.capabilities).toEqual({
      state: 'not-ready',
      code: 'adapter-host-mismatch'
    })
  })

  it('reports provider reachability only from an approved invocation', async () => {
    const { runtime, session, prepared, preview } = await fixture()
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()
    await expect(status(runtime, session, prepared.callId)).resolves.toHaveProperty(
      'status',
      'completed'
    )
    await expect(runtime.readiness(session.sessionId, session.sessionToken)).resolves.toMatchObject(
      { provider: { state: 'ready', code: 'provider-observed' } }
    )
  })

  it('returns bounded provider health diagnostics only when explicitly requested', async () => {
    const { runtime, session, prepared, preview } = await fixture()
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()

    const readiness = await runtime.readiness(session.sessionId, session.sessionToken, {
      protocol: 1,
      includeDiagnostics: true
    })
    expect(readiness.provider).toMatchObject({
      state: 'ready',
      code: 'provider-observed',
      diagnostics: {
        circuitState: 'closed',
        failureCount: 0,
        probeInFlight: false,
        lastOutcome: 'success',
        lastOutcomeAt: Date.now(),
        lastLatencyMs: 0,
        lastCorrelationId: expect.stringMatching(/^[a-f0-9]{32}$/),
        observedAt: Date.now(),
        observedCorrelationId: expect.stringMatching(/^[a-f0-9]{32}$/)
      }
    })
    expect(readiness.provider.diagnostics?.lastCorrelationId).toBe(
      readiness.provider.diagnostics?.observedCorrelationId
    )
  })

  it('records an approved provider failure without exposing provider error details', async () => {
    const { runtime, session, prepared, preview, invoke } = await fixture()
    invoke.mockRejectedValueOnce(new FigPluginBridgeError('UPSTREAM_FAILED'))
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()
    await expect(runtime.readiness(session.sessionId, session.sessionToken)).resolves.toMatchObject(
      { provider: { state: 'not-ready', code: 'provider-unavailable' } }
    )
    await expect(
      runtime.readiness(session.sessionId, session.sessionToken, {
        protocol: 1,
        includeDiagnostics: true
      })
    ).resolves.toMatchObject({
      provider: {
        diagnostics: {
          circuitState: 'closed',
          lastOutcome: 'failure',
          lastFailureClass: 'upstream',
          lastCorrelationId: expect.stringMatching(/^[a-f0-9]{32}$/)
        }
      }
    })
  })

  it('does not classify an approved invocation cancelled by the caller as provider failure', async () => {
    const outcome = deferred<{ content: string }>()
    const { runtime, session, prepared, preview, invoke } = await fixture()
    invoke.mockReturnValue(outcome.promise)
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()
    await runtime.cancel(session.sessionId, session.sessionToken, prepared.callId)
    await expect(runtime.readiness(session.sessionId, session.sessionToken)).resolves.toMatchObject(
      {
        provider: { state: 'unknown' }
      }
    )
    outcome.resolve({ content: 'late result' })
    await settle()
  })

  it('expires provider observations and keeps them isolated by session and profile revision', async () => {
    const first = await fixture()
    await first.runtime.approve(first.prepared.callId, first.preview.payloadSha256)
    await settle()
    await expect(
      first.runtime.readiness(first.session.sessionId, first.session.sessionToken)
    ).resolves.toMatchObject({ provider: { state: 'ready' } })

    await vi.advanceTimersByTimeAsync(60_001)
    await expect(
      first.runtime.readiness(first.session.sessionId, first.session.sessionToken)
    ).resolves.toMatchObject({ provider: { state: 'unknown' } })

    const sameProfile = await pair(first.runtime)
    await expect(
      first.runtime.readiness(sameProfile.sessionId, sameProfile.sessionToken)
    ).resolves.toMatchObject({ provider: { state: 'unknown', code: 'provider-not-probed' } })

    const newerProfile = await pair(first.runtime, {
      ...binding,
      profileRevision: 'e'.repeat(64)
    })
    await expect(
      first.runtime.readiness(newerProfile.sessionId, newerProfile.sessionToken)
    ).resolves.toMatchObject({ provider: { state: 'unknown', code: 'provider-not-probed' } })
  })

  it('uses an open circuit only to explain fresh failure evidence from the same session', async () => {
    const circuit = new ProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 })
    const { runtime, session, prepared, preview, invoke } = await fixture({
      providerCircuit: circuit
    })
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()

    const failedSession = await pair(runtime)
    const failed = await prepare(runtime, failedSession)
    const failedPreview = runtime.listPreviews().find((value) => value.callId === failed.callId)!
    invoke.mockRejectedValueOnce(new FigPluginBridgeError('UPSTREAM_FAILED'))
    await runtime.approve(failed.callId, failedPreview.payloadSha256)
    await settle()
    const providerKey = `${binding.host}:${binding.profileId}:${binding.profileRevision}`
    expect(circuit.snapshot(providerKey)).toMatchObject({ state: 'open', failureCount: 1 })
    expect(
      (await runtime.readiness(failedSession.sessionId, failedSession.sessionToken)).provider
    ).toEqual({ state: 'not-ready', code: 'provider-circuit-open' })
    expect((await runtime.readiness(session.sessionId, session.sessionToken)).provider).toEqual({
      state: 'ready',
      code: 'provider-observed'
    })

    const freshSession = await pair(runtime)
    expect(
      (await runtime.readiness(freshSession.sessionId, freshSession.sessionToken)).provider
    ).toEqual({ state: 'unknown', code: 'provider-not-probed' })
    const blocked = await prepare(runtime, freshSession)
    const blockedPreview = runtime.listPreviews().find((value) => value.callId === blocked.callId)!
    await runtime.approve(blocked.callId, blockedPreview.payloadSha256)
    await settle()
    expect(await status(runtime, freshSession, blocked.callId)).toMatchObject({
      status: 'failed',
      errorCode: 'UPSTREAM_FAILED'
    })
    expect(
      (await runtime.readiness(freshSession.sessionId, freshSession.sessionToken)).provider
    ).toEqual({ state: 'unknown', code: 'provider-not-probed' })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('does not renew expired failure evidence when cancelled half-open probes extend the circuit', async () => {
    const circuit = new ProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 })
    const { runtime, session, prepared, preview, invoke } = await fixture({
      providerCircuit: circuit
    })
    const observedAt = Date.now()
    const providerKey = `${binding.host}:${binding.profileId}:${binding.profileRevision}`
    invoke.mockRejectedValueOnce(new FigPluginBridgeError('UPSTREAM_FAILED'))
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()

    const cancelProbe = async (sequence: number) => {
      const outcome = deferred<{ content: string }>()
      invoke.mockReturnValueOnce(outcome.promise)
      const probe = await prepare(runtime, session, request(sequence))
      const probePreview = runtime.listPreviews().find((value) => value.callId === probe.callId)!
      await runtime.approve(probe.callId, probePreview.payloadSha256)
      await settle()
      expect(circuit.snapshot(providerKey)).toMatchObject({
        state: 'half-open',
        probeInFlight: true
      })
      await cancel(runtime, session, probe.callId)
      outcome.reject(new Error('Late provider error after caller cancellation'))
      await settle()
      expect(circuit.snapshot(providerKey)).toMatchObject({
        state: 'open',
        retryAt: Date.now() + 30_000,
        failureCount: 1,
        probeInFlight: false
      })
      expect(await status(runtime, session, probe.callId)).toMatchObject({
        status: 'cancelled',
        errorCode: 'CANCELLED'
      })
    }

    await vi.advanceTimersByTimeAsync(30_000)
    await cancelProbe(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect((await runtime.readiness(session.sessionId, session.sessionToken)).provider).toEqual({
      state: 'not-ready',
      code: 'provider-circuit-open'
    })

    await vi.advanceTimersByTimeAsync(1)
    expect(Date.now()).toBe(observedAt + 60_000)
    await cancelProbe(3)
    expect((await runtime.readiness(session.sessionId, session.sessionToken)).provider.state).toBe(
      'unknown'
    )
    const freshSession = await pair(runtime)
    expect(
      (await runtime.readiness(freshSession.sessionId, freshSession.sessionToken)).provider
    ).toEqual({ state: 'unknown', code: 'provider-not-probed' })
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('previews canonical UTF-8 payloads including every integrity reference without secrets', async () => {
    const { runtime, validate, invoke, session, preview } = await fixture()
    const value = request()
    const canonical = canonicalFigPluginJson({
      binding,
      prompt: value.prompt,
      context: value.context
    })
    expect(preview.payloadSha256).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'))
    expect(preview.estimatedInputTokens).toBe(Math.ceil(Buffer.byteLength(canonical, 'utf8') / 4))
    expect(figPluginBridgePreviewSchema.parse(preview)).toEqual(preview)
    for (const key of [
      'profileRevision',
      'manifestSha256',
      'generation',
      'profileId',
      'projectId'
    ] as const) {
      const changed = { ...binding, [key]: key === 'generation' ? 8 : 'f'.repeat(64) }
      expect(
        createHash('sha256')
          .update(
            canonicalFigPluginJson({
              binding: changed,
              prompt: value.prompt,
              context: value.context
            })
          )
          .digest('hex')
      ).not.toBe(preview.payloadSha256)
    }
    const views = JSON.stringify([runtime.listSessions(), runtime.listPreviews()])
    expect(views).not.toContain(session.sessionToken)
    expect(views).not.toMatch(/sessionToken|pairingSecret|clientNonce/)
    expect(validate).toHaveBeenCalledTimes(3)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('clones incoming requests and returned previews deeply and excludes the pairing nonce from invocation', async () => {
    const { runtime, invoke } = make()
    const session = await pair(runtime)
    const input = request()
    const preparing = prepare(runtime, session, input)
    input.context.nodes[0].name = 'Caller mutation'
    input.prompt = 'Caller mutation'
    const prepared = await preparing
    const preview = runtime.listPreviews()[0]
    const hash = preview.payloadSha256
    preview.context.nodes[0].name = 'Preview mutation'
    preview.prompt = 'Preview mutation'
    preview.profileId = 'Other profile'
    const listed = runtime.listSessions()
    listed[0].projectId = 'Other project'
    await runtime.approve(prepared.callId, hash)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][0]).toEqual(binding)
    expect(invoke.mock.calls[0][1]).toMatchObject({
      prompt: request().prompt,
      context: request().context
    })
    expect(invoke.mock.calls[0][3]).toMatch(/^[a-f0-9]{32}$/)
    expect(JSON.stringify(invoke.mock.calls[0])).not.toMatch(
      /clientNonce|sessionToken|pairingSecret/
    )
    expect(runtime.listSessions()[0].projectId).toBe(binding.projectId)
  })

  it.each([
    { protocol: 2 },
    { tools: [] },
    {
      prompt: '界'.repeat(16_384),
      context: {
        ...request().context,
        nodes: Array.from({ length: 100 }, (_, index) => ({
          id: String(index),
          type: 'FRAME',
          name: '界'.repeat(120),
          locked: false
        }))
      }
    },
    { context: { ...request().context, attachments: [] } }
  ])('rejects unapproved or UTF-8-oversized prepare input (%#)', async (override) => {
    const { runtime, invoke } = make()
    const session = await pair(runtime)
    await expect(
      prepare(runtime, session, { ...request(), ...override } as FigPluginBridgePrepareRequest)
    ).rejects.toMatchObject(errorCode('INVALID_REQUEST'))
    expect(runtime.listPreviews()).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('coalesces duplicate concurrent prepare validation and admits exactly one immutable call', async () => {
    const { runtime, validate } = make()
    const session = await pair(runtime)
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const first = prepare(runtime, session)
    const second = prepare(runtime, session)
    expect(validate).toHaveBeenCalledTimes(3)
    gate.resolve(true)
    expect(await first).toEqual(await second)
    expect(runtime.listPreviews()).toHaveLength(1)
    expect(runtime.listSessions()[0].activeCalls).toBe(1)
  })

  it('checks the session epoch again in the caller continuation after validation resolves', async () => {
    const { runtime, validate } = make()
    const session = await pair(runtime)
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const preparing = prepare(runtime, session)
    const rejected = expect(preparing).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    gate.resolve(true)
    // Interleave revocation between the validation helper and prepare's continuation.
    void Promise.resolve().then(() => {
      void Promise.resolve().then(() => runtime.revokePlugin(binding.pluginId))
    })
    await rejected
    expect(runtime.listPreviews()).toEqual([])
    expect(runtime.listSessions()).toEqual([])
  })

  it('expires a session when async validation resolves after its deadline', async () => {
    const { runtime, validate, invoke } = make()
    const session = await pair(runtime)
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const preparing = prepare(runtime, session)

    // Move the clock without running the cleanup timer. The in-flight validation must
    // still observe the absolute session boundary before admitting the request.
    vi.setSystemTime(Date.now() + 600_001)
    gate.resolve(true)

    await expect(preparing).rejects.toMatchObject(errorCode('EXPIRED'))
    expect(runtime.listSessions()).toEqual([])
    expect(runtime.listPreviews()).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rechecks sequence and active-call admission after async validation', async () => {
    const { runtime, validate } = make()
    const session = await pair(runtime)
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const high = prepare(runtime, session, request(2))
    const low = prepare(runtime, session, request(1))
    const rejection = expect(low).rejects.toMatchObject(errorCode('INVALID_REQUEST'))
    gate.resolve(true)
    const prepared = await high
    await rejection
    await expect(prepare(runtime, session, request(3))).rejects.toMatchObject(errorCode('BUSY'))
    runtime.deny(prepared.callId)
    await expect(prepare(runtime, session, request(3))).resolves.toHaveProperty('callId')
  })

  it('replays canonical-equivalent requests after completion, but rejects substitutions and reused sequences', async () => {
    const { runtime, session, prepared, preview, invoke } = await fixture()
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()
    const reordered = request()
    reordered.context = {
      documentLabel: reordered.context.documentLabel,
      selectionRevision: reordered.context.selectionRevision,
      nodes: reordered.context.nodes
    }
    reordered.prompt = `  ${reordered.prompt}  `
    expect(await prepare(runtime, session, reordered)).toEqual(prepared)
    await expect(
      prepare(runtime, session, { ...request(), prompt: 'Substitute' })
    ).rejects.toMatchObject(errorCode('INVALID_REQUEST'))
    await expect(prepare(runtime, session, { ...request(), sequence: 2 })).rejects.toMatchObject(
      errorCode('INVALID_REQUEST')
    )
    await expect(
      prepare(runtime, session, { ...request(), requestId: 'another' })
    ).rejects.toMatchObject(errorCode('INVALID_REQUEST'))
    await expect(runtime.approve(prepared.callId, preview.payloadSha256)).rejects.toMatchObject(
      errorCode('INVALID_REQUEST')
    )
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('binds approval to the exact payload and invokes at most once under double approval', async () => {
    const outcome = deferred<{ content: string }>()
    const { runtime, prepared, preview, invoke, validate, session } = await fixture()
    invoke.mockReturnValue(outcome.promise)
    await expect(runtime.approve(prepared.callId, 'f'.repeat(64))).rejects.toMatchObject(
      errorCode('INVALID_REQUEST')
    )
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const approvals = Promise.allSettled([
      runtime.approve(prepared.callId, preview.payloadSha256),
      runtime.approve(prepared.callId, preview.payloadSha256)
    ])
    gate.resolve(true)
    expect((await approvals).map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected'
    ])
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await status(runtime, session, prepared.callId)).toMatchObject({ status: 'running' })
    expect(runtime.listPreviews()).toEqual([])
    outcome.resolve({ content: 'done' })
    await settle()
  })

  it('cancellation while approval validates prevents invocation', async () => {
    const { runtime, prepared, preview, session, validate, invoke } = await fixture()
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const approving = runtime.approve(prepared.callId, preview.payloadSha256)
    await cancel(runtime, session, prepared.callId)
    gate.resolve(true)
    await expect(approving).rejects.toMatchObject(errorCode('INVALID_REQUEST'))
    expect(invoke).not.toHaveBeenCalled()
    expect(await status(runtime, session, prepared.callId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'CANCELLED'
    })
  })

  it('denial is terminal and leaves an idempotent receipt rather than reopening consent', async () => {
    const { runtime, session, prepared, preview, invoke } = await fixture()
    runtime.deny(prepared.callId)
    expect(await prepare(runtime, session)).toEqual(prepared)
    expect(await status(runtime, session, prepared.callId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'DENIED'
    })
    await expect(runtime.approve(prepared.callId, preview.payloadSha256)).rejects.toMatchObject(
      errorCode('INVALID_REQUEST')
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('retains request receipts and high-water ordering after call TTL, without exposing old content', async () => {
    const { runtime, session, prepared, preview, invoke } = await fixture()
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()
    await vi.advanceTimersByTimeAsync(100_000)
    await status(runtime, session, prepared.callId)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await status(runtime, session, prepared.callId)).toEqual({
      protocol: 1,
      callId: prepared.callId,
      status: 'failed',
      errorCode: 'EXPIRED'
    })
    expect(await prepare(runtime, session)).toEqual(prepared)
    await expect(
      prepare(runtime, session, { ...request(), requestId: 'reexecute' })
    ).rejects.toMatchObject(errorCode('INVALID_REQUEST'))
    await expect(runtime.approve(prepared.callId, preview.payloadSha256)).rejects.toMatchObject(
      errorCode('EXPIRED')
    )
    await expect(prepare(runtime, session, request(2))).resolves.toHaveProperty('callId')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not evict finished calls to bypass the global 32-call bound', async () => {
    const { runtime } = make()
    const session = await pair(runtime)
    let first = ''
    for (let sequence = 1; sequence <= 32; sequence++) {
      const prepared = await prepare(runtime, session, request(sequence))
      if (sequence === 1) first = prepared.callId
      runtime.deny(prepared.callId)
    }
    await expect(prepare(runtime, session, request(33))).rejects.toMatchObject(errorCode('BUSY'))
    expect((await prepare(runtime, session)).callId).toBe(first)
    expect(await status(runtime, session, first)).toMatchObject({ errorCode: 'DENIED' })
    await vi.advanceTimersByTimeAsync(100_000)
    await status(runtime, session, first)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(prepare(runtime, session, request(33))).resolves.toHaveProperty('callId')
    expect((await prepare(runtime, session)).callId).toBe(first)
  })

  it('limits persisted request IDs to 64 per session even after call expiry', async () => {
    const { runtime } = make()
    const session = await pair(runtime)
    let first = ''
    for (let batch = 0; batch < 2; batch++) {
      for (let offset = 1; offset <= 32; offset++) {
        const prepared = await prepare(runtime, session, request(batch * 32 + offset))
        first ||= prepared.callId
        runtime.deny(prepared.callId)
      }
      await vi.advanceTimersByTimeAsync(100_000)
      await status(runtime, session, first)
      await vi.advanceTimersByTimeAsync(20_000)
    }
    await expect(prepare(runtime, session, request(65))).rejects.toMatchObject(errorCode('BUSY'))
    expect((await prepare(runtime, session)).callId).toBe(first)
  })

  it('shares call admission across sessions and releases closed-session receipts without cross-session replay', async () => {
    const { runtime } = make()
    const first = await pair(runtime)
    const second = await pair(runtime)
    for (let sequence = 1; sequence <= 16; sequence++) {
      for (const session of [first, second]) {
        const prepared = await prepare(runtime, session, request(sequence))
        runtime.deny(prepared.callId)
      }
    }
    await expect(prepare(runtime, second, request(17))).rejects.toMatchObject(errorCode('BUSY'))
    runtime.closeSession(first.sessionId, first.sessionToken)
    for (let sequence = 17; sequence <= 32; sequence++) {
      const prepared = await prepare(runtime, second, request(sequence))
      runtime.deny(prepared.callId)
    }
    await expect(prepare(runtime, second, request(33))).rejects.toMatchObject(errorCode('BUSY'))
    await expect(prepare(runtime, first)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
  })

  it('caps concurrent invocations at eight even if a cancelled invoker ignores abort', async () => {
    const outcome = deferred<{ content: string }>()
    const firstOutcome = deferred<{ content: string }>()
    const { runtime, invoke } = make()
    invoke.mockReturnValue(outcome.promise).mockReturnValueOnce(firstOutcome.promise)
    const sessions = await Promise.all(Array.from({ length: 9 }, () => pair(runtime)))
    const prepared = await Promise.all(sessions.map((session) => prepare(runtime, session)))
    const previews = runtime.listPreviews()
    const approvals = await Promise.allSettled(
      previews.map((preview) => runtime.approve(preview.callId, preview.payloadSha256))
    )
    expect(approvals.filter((result) => result.status === 'fulfilled')).toHaveLength(8)
    expect(approvals.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: errorCode('BUSY') }
    ])
    expect(invoke).toHaveBeenCalledTimes(8)
    await cancel(runtime, sessions[0], prepared[0].callId)
    await expect(
      runtime.approve(previews[8].callId, previews[8].payloadSha256)
    ).rejects.toMatchObject(errorCode('BUSY'))
    firstOutcome.resolve({ content: 'discarded' })
    await settle()
    await runtime.approve(previews[8].callId, previews[8].payloadSha256)
    expect(invoke).toHaveBeenCalledTimes(9)
    outcome.resolve({ content: 'finished' })
    await settle()
  })
})

describe('bounded prepare validation waiters', () => {
  it('admits only two prepares per session and rejects floods before parsing or invocation', async () => {
    const { runtime, validate, invoke } = make()
    const session = await pair(runtime)
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const high = prepare(runtime, session, request(2))
    const low = prepare(runtime, session, request(1))
    const rejected = expect(low).rejects.toMatchObject(errorCode('INVALID_REQUEST'))
    const readInput = vi.fn(() => {
      throw new Error('Input must not be read')
    })
    const input = new Proxy(request(), { get: readInput })
    await expect(runtime.prepare(session.sessionId, 'bad', input)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    await Promise.all(
      Array.from({ length: 128 }, () =>
        expect(prepare(runtime, session, input)).rejects.toMatchObject(errorCode('BUSY'))
      )
    )
    expect(readInput.mock.calls.length).toBe(0)
    expect(validate.mock.calls.length).toBe(3)
    expect(invoke.mock.calls.length).toBe(0)
    expect(runtime.listPreviews()).toEqual([])
    gate.resolve(true)
    const prepared = await high
    await rejected
    expect(
      await Promise.all([
        prepare(runtime, session, request(2)),
        prepare(runtime, session, request(2))
      ])
    ).toEqual([prepared, prepared])
    expect(runtime.listPreviews()).toHaveLength(1)
  })

  it('admits only 16 prepare waiters globally and reuses a slot only after settlement', async () => {
    const { runtime, validate, invoke } = make()
    const sessions = await Promise.all(Array.from({ length: 16 }, () => pair(runtime)))
    const gates = sessions.map(() => deferred<boolean>())
    validate.mockClear()
    const pending = sessions.map((session, index) => {
      validate.mockReturnValueOnce(gates[index].promise)
      return prepare(runtime, session)
    })
    const readInput = vi.fn(() => {
      throw new Error('Input must not be read')
    })
    const input = new Proxy(request(), { get: readInput })
    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        expect(prepare(runtime, sessions[index % 16], input)).rejects.toMatchObject(
          errorCode('BUSY')
        )
      )
    )
    expect(readInput.mock.calls.length).toBe(0)
    expect(validate.mock.calls.length).toBe(16)
    expect(invoke.mock.calls.length).toBe(0)
    gates[0].resolve(true)
    const first = await pending[0]
    const replacement = deferred<boolean>()
    validate.mockReturnValueOnce(replacement.promise)
    const replay = prepare(runtime, sessions[0])
    await expect(prepare(runtime, sessions[1], input)).rejects.toMatchObject(errorCode('BUSY'))
    expect(readInput.mock.calls.length).toBe(0)
    expect(validate.mock.calls.length).toBe(17)
    for (const gate of gates) gate.resolve(true)
    replacement.resolve(true)
    await Promise.all(pending)
    expect(await replay).toEqual(first)
    expect(runtime.listPreviews()).toHaveLength(16)
    expect(runtime['preparing']).toBe(0)
    expect(invoke.mock.calls.length).toBe(0)
  })

  it('releases both prepare reservations on schema and call-admission failures', async () => {
    const { runtime, validate, invoke } = make()
    const session = await pair(runtime)
    for (let index = 0; index < 4; index++) {
      await expect(prepare(runtime, session, { ...request(), sequence: 0 })).rejects.toMatchObject(
        errorCode('INVALID_REQUEST')
      )
    }
    expect(validate.mock.calls.length).toBe(2)
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const pending = Promise.all([prepare(runtime, session), prepare(runtime, session)])
    await expect(prepare(runtime, session)).rejects.toMatchObject(errorCode('BUSY'))
    gate.resolve(true)
    const [first, second] = await pending
    expect(second).toEqual(first)
    for (let index = 0; index < 4; index++) {
      await expect(prepare(runtime, session, request(2))).rejects.toMatchObject(errorCode('BUSY'))
    }
    await cancel(runtime, session, first.callId)
    await expect(prepare(runtime, session, request(2))).resolves.toHaveProperty('callId')
    expect(runtime['preparing']).toBe(0)
    expect(runtime['sessions'].get(session.sessionId)?.preparing).toBe(0)
    expect(invoke.mock.calls.length).toBe(0)
  })

  it.each(['close', 'revoke', 'expiry', 'dispose', 'validation-error'] as const)(
    'retains reservations through %s and releases them without resurrecting the session',
    async (ending) => {
      const { runtime, validate, invoke } = make()
      const session = await pair(runtime)
      const epoch = runtime['sessions'].get(session.sessionId)!
      const gate = deferred<boolean>()
      validate.mockReturnValueOnce(gate.promise)
      const pending = Promise.allSettled([prepare(runtime, session), prepare(runtime, session)])
      if (ending === 'close') runtime.closeSession(session.sessionId, session.sessionToken)
      if (ending === 'revoke') runtime.revokePlugin(binding.pluginId)
      if (ending === 'expiry') await vi.advanceTimersByTimeAsync(120_000)
      if (ending === 'dispose') runtime.dispose()
      expect(runtime['preparing']).toBe(2)
      expect(epoch.preparing).toBe(2)
      if (ending === 'validation-error') gate.reject(new Error('PRIVATE validator failure'))
      else gate.resolve(true)
      const results = await pending
      expect(results).toMatchObject([
        {
          status: 'rejected',
          reason: errorCode(
            ending === 'validation-error' ? 'CONFIGURATION_CHANGED' : 'UNAUTHORIZED'
          )
        },
        { status: 'rejected', reason: errorCode('UNAUTHORIZED') }
      ])
      expect(runtime['preparing']).toBe(0)
      expect(epoch.preparing).toBe(0)
      expect(runtime['sessions'].size).toBe(0)
      expect(runtime['calls'].size).toBe(0)
      expect(invoke.mock.calls.length).toBe(0)
      if (ending === 'dispose') {
        await expect(prepare(runtime, session)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
        expect(vi.getTimerCount()).toBe(0)
      } else {
        const next = await pair(runtime)
        const receipts = await Promise.all([prepare(runtime, next), prepare(runtime, next)])
        expect(receipts[0]).toEqual(receipts[1])
        expect(runtime.listPreviews()).toHaveLength(1)
      }
    }
  )
})

describe('FigPluginBridgeRuntime outcomes and lifetime races', () => {
  it('starts in the background, returns before upstream completion and preserves plain content verbatim', async () => {
    const outcome = deferred<{ content: string; reportedTotalTokens?: number }>()
    const { runtime, session, prepared, preview, invoke } = await fixture()
    invoke.mockReturnValue(outcome.promise)
    await runtime.approve(prepared.callId, preview.payloadSha256)
    expect(await status(runtime, session, prepared.callId)).toMatchObject({ status: 'running' })
    const content = '  \n<plain> 界\u{1f331}\u0000 \n'
    outcome.resolve({ content, reportedTotalTokens: 0 })
    await settle()
    const result = await status(runtime, session, prepared.callId)
    expect(result).toEqual({
      protocol: 1,
      callId: prepared.callId,
      status: 'completed',
      content,
      reportedTotalTokens: 0
    })
    expect(figPluginBridgeStatusResponseSchema.parse(result)).toEqual(result)
    if (result.status === 'completed') result.content = 'mutated'
    expect(await status(runtime, session, prepared.callId)).toHaveProperty('content', content)
  })

  it.each([
    { content: '' },
    { content: 'x'.repeat(32 * 1024 + 1) },
    { content: '界'.repeat(10_923) },
    { content: 'valid', attachments: [] },
    { content: 'valid', toolCalls: [] },
    { content: 'valid', reportedTotalTokens: -1 },
    { content: 'valid', reportedTotalTokens: 1.5 },
    { content: 'valid', reportedTotalTokens: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects invalid upstream outcomes without leaking their fields (%#)', async (value) => {
    const { runtime, session, prepared, preview, invoke } = await fixture()
    invoke.mockResolvedValue(value)
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()
    expect(await status(runtime, session, prepared.callId)).toEqual({
      protocol: 1,
      callId: prepared.callId,
      status: 'failed',
      errorCode: 'UPSTREAM_FAILED'
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it.each(['x'.repeat(32 * 1024), '界'.repeat(10_922) + 'ab'])(
    'accepts exactly 32 KiB of output (%#)',
    async (content) => {
      const { runtime, session, prepared, preview, invoke } = await fixture()
      invoke.mockResolvedValue({ content })
      await runtime.approve(prepared.callId, preview.payloadSha256)
      await settle()
      expect(await status(runtime, session, prepared.callId)).toHaveProperty('content', content)
    }
  )

  it.each(['TIMEOUT', 'CANCELLED', 'CONFIGURATION_CHANGED'] as const)(
    'preserves trusted typed invocation failure %s without raw details',
    async (code) => {
      const { runtime, session, prepared, preview, invoke } = await fixture()
      invoke.mockRejectedValue(new FigPluginBridgeError(code))
      await runtime.approve(prepared.callId, preview.payloadSha256)
      await settle()
      expect(await status(runtime, session, prepared.callId)).toMatchObject({
        status: code === 'CANCELLED' ? 'cancelled' : 'failed',
        errorCode: code
      })
      expect(invoke).toHaveBeenCalledOnce()
    }
  )

  it('sanitizes synchronous and asynchronous invoker errors without retrying or retaining causes', async () => {
    for (const synchronous of [true, false]) {
      const { runtime, session, prepared, preview, invoke } = await fixture()
      const error = new Error('SECRET-PROMPT-SNAPSHOT', { cause: { apiKey: 'SECRET-KEY' } })
      if (synchronous)
        invoke.mockImplementation(() => {
          throw error
        })
      else invoke.mockRejectedValue(error)
      await runtime.approve(prepared.callId, preview.payloadSha256)
      await settle()
      expect(await status(runtime, session, prepared.callId)).toEqual({
        protocol: 1,
        callId: prepared.callId,
        status: 'failed',
        errorCode: 'UPSTREAM_FAILED'
      })
      expect(invoke).toHaveBeenCalledTimes(1)
    }
  })

  it('opens a provider circuit after classified failures and recovers with one cooldown probe', async () => {
    const circuit = new ProviderCircuitBreaker({ failureThreshold: 2, cooldownMs: 100 })
    const { runtime, session, prepared, invoke } = await fixture({ providerCircuit: circuit })
    const providerKey = `${binding.host}:${binding.profileId}:${binding.profileRevision}`
    invoke.mockRejectedValue(new FigPluginBridgeError('UPSTREAM_FAILED'))
    const run = async (receipt: Awaited<ReturnType<typeof prepare>>) => {
      const current = runtime.listPreviews().find((value) => value.callId === receipt.callId)
      if (!current) throw new Error('missing preview fixture')
      await runtime.approve(receipt.callId, current.payloadSha256)
      await settle()
      return status(runtime, session, receipt.callId)
    }

    expect(await run(prepared)).toMatchObject({ status: 'failed', errorCode: 'UPSTREAM_FAILED' })
    const second = await prepare(runtime, session, request(2))
    expect(await run(second)).toMatchObject({ status: 'failed', errorCode: 'UPSTREAM_FAILED' })
    expect(circuit.snapshot(providerKey)).toMatchObject({ state: 'open', failureCount: 2 })

    const blocked = await prepare(runtime, session, request(3))
    expect(await run(blocked)).toMatchObject({ status: 'failed', errorCode: 'UPSTREAM_FAILED' })
    expect(invoke).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(100)
    invoke.mockResolvedValue({ content: 'recovered' })
    const probe = await prepare(runtime, session, request(4))
    expect(await run(probe)).toMatchObject({ status: 'completed', content: 'recovered' })
    expect(circuit.snapshot(providerKey)).toMatchObject({
      state: 'closed',
      failureCount: 0,
      probeInFlight: false
    })
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('does not inherit an open circuit when the bound profile revision changes', async () => {
    const circuit = new ProviderCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 })
    const { runtime, invoke } = await fixture({ providerCircuit: circuit })
    const oldSession = await pair(runtime)
    const oldPrepared = await prepare(runtime, oldSession, request(2))
    const oldPreview = runtime.listPreviews().find((value) => value.callId === oldPrepared.callId)
    if (!oldPreview) throw new Error('missing old revision preview fixture')
    invoke.mockRejectedValueOnce(new FigPluginBridgeError('UPSTREAM_FAILED'))
    await runtime.approve(oldPrepared.callId, oldPreview.payloadSha256)
    await settle()
    expect(
      circuit.snapshot(`${binding.host}:${binding.profileId}:${binding.profileRevision}`)
    ).toMatchObject({
      state: 'open'
    })

    const newerBinding = { ...binding, profileRevision: 'e'.repeat(64) }
    const newSession = await pair(runtime, newerBinding)
    const newPrepared = await prepare(runtime, newSession, request(1))
    const newPreview = runtime.listPreviews().find((value) => value.callId === newPrepared.callId)
    if (!newPreview) throw new Error('missing new revision preview fixture')
    invoke.mockResolvedValueOnce({ content: 'new revision succeeds' })
    await runtime.approve(newPrepared.callId, newPreview.payloadSha256)
    await settle()
    expect(await status(runtime, newSession, newPrepared.callId)).toMatchObject({
      status: 'completed',
      content: 'new revision succeeds'
    })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it.each(['CANCELLED', 'TIMEOUT', 'CONFIGURATION_CHANGED'] as const)(
    'does not count %s as a provider failure',
    async (code) => {
      const circuit = new ProviderCircuitBreaker({ failureThreshold: 1 })
      const { runtime, session, prepared, preview, invoke } = await fixture({
        providerCircuit: circuit
      })
      invoke.mockRejectedValue(new FigPluginBridgeError(code))
      await runtime.approve(prepared.callId, preview.payloadSha256)
      await settle()
      expect(await status(runtime, session, prepared.callId)).toMatchObject({
        status: code === 'CANCELLED' ? 'cancelled' : 'failed',
        errorCode: code
      })
      expect(
        circuit.snapshot(`${binding.host}:${binding.profileId}:${binding.profileRevision}`)
      ).toMatchObject({
        state: 'closed',
        failureCount: 0,
        probeInFlight: false
      })
    }
  )

  it('does not count a hard timeout when the provider resolves after cancellation', async () => {
    const circuit = new ProviderCircuitBreaker({ failureThreshold: 1 })
    const outcome = deferred<{ content: string }>()
    const { runtime, session, prepared, preview, invoke } = await fixture({
      providerCircuit: circuit,
      callTimeoutMs: 5
    })
    invoke.mockReturnValue(outcome.promise)
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await vi.advanceTimersByTimeAsync(5)
    expect(await status(runtime, session, prepared.callId)).toMatchObject({
      status: 'failed',
      errorCode: 'TIMEOUT'
    })
    outcome.resolve({ content: 'late' })
    await settle()
    expect(
      circuit.snapshot(`${binding.host}:${binding.profileId}:${binding.profileRevision}`)
    ).toMatchObject({
      state: 'closed',
      failureCount: 0,
      probeInFlight: false
    })
  })

  it.each([undefined, 900_001, 0, 5])(
    'enforces a hard timeout, shortened only by options (%s), even when abort is ignored',
    async (callTimeoutMs) => {
      const outcome = deferred<{ content: string }>()
      const { runtime, session, prepared, preview, invoke } = await fixture({ callTimeoutMs })
      invoke.mockReturnValue(outcome.promise)
      await runtime.approve(prepared.callId, preview.payloadSha256)
      const limit = callTimeoutMs === 0 ? 1 : callTimeoutMs === 5 ? 5 : 90_000
      await vi.advanceTimersByTimeAsync(limit - 1)
      expect(await status(runtime, session, prepared.callId)).toHaveProperty('status', 'running')
      await vi.advanceTimersByTimeAsync(1)
      expect(invoke.mock.calls[0][2].aborted).toBe(true)
      outcome.resolve({ content: 'LATE-SECRET' })
      await settle()
      expect(await status(runtime, session, prepared.callId)).toEqual({
        protocol: 1,
        callId: prepared.callId,
        status: 'failed',
        errorCode: 'TIMEOUT'
      })
    }
  )

  it('includes pending outcome validation in the hard deadline', async () => {
    const { runtime, session, prepared, preview, invoke, validate } = await fixture({
      callTimeoutMs: 5
    })
    const outcome = deferred<{ content: string }>()
    invoke.mockReturnValue(outcome.promise)
    await runtime.approve(prepared.callId, preview.payloadSha256)
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    outcome.resolve({ content: 'SECRET' })
    await settle()
    await vi.advanceTimersByTimeAsync(5)
    gate.resolve(true)
    await settle()
    expect(await status(runtime, session, prepared.callId)).toHaveProperty('errorCode', 'TIMEOUT')
  })

  it('aborts cancellation immediately and discards late provider fulfillment', async () => {
    const outcome = deferred<{ content: string }>()
    const { runtime, session, prepared, preview, invoke } = await fixture()
    invoke.mockReturnValue(outcome.promise)
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await cancel(runtime, session, prepared.callId)
    expect(invoke.mock.calls[0][2].aborted).toBe(true)
    outcome.resolve({ content: 'LATE' })
    await settle()
    expect(await status(runtime, session, prepared.callId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'CANCELLED'
    })
    expect(await prepare(runtime, session)).toEqual(prepared)
    expect(runtime.listSessions()[0].activeCalls).toBe(0)
  })

  it('aborts a running call at preview expiry and strips its receipt content', async () => {
    const outcome = deferred<{ content: string }>()
    const { runtime, session, prepared, preview, invoke } = await fixture()
    await vi.advanceTimersByTimeAsync(100_000)
    await status(runtime, session, prepared.callId)
    invoke.mockReturnValue(outcome.promise)
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(invoke.mock.calls[0][2].aborted).toBe(true)
    outcome.resolve({ content: 'LATE' })
    await settle()
    expect(await status(runtime, session, prepared.callId)).toHaveProperty('errorCode', 'EXPIRED')
  })

  it('invalidates cached completed content when a profile revision changes', async () => {
    const { runtime, session, prepared, preview, validate } = await fixture()
    await runtime.approve(prepared.callId, preview.payloadSha256)
    await settle()
    expect(await status(runtime, session, prepared.callId)).toHaveProperty('status', 'completed')
    validate.mockImplementation(async (current) => current.profileRevision === 'f'.repeat(64))
    await expect(status(runtime, session, prepared.callId)).rejects.toMatchObject(
      errorCode('CONFIGURATION_CHANGED')
    )
    expect(runtime.listSessions()).toEqual([])
    expect(runtime.listPreviews()).toEqual([])
    await expect(status(runtime, session, prepared.callId)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
  })

  it.each(['issue', 'redeem', 'prepare', 'status', 'approve'] as const)(
    'revocation during %s validation cannot resurrect an old generation',
    async (stage) => {
      const { runtime, validate, invoke } = make()
      let session: FigPluginPairResponse | undefined
      let ticket: Pairing | undefined
      let preview: ReturnType<FigPluginBridgeRuntime['listPreviews']>[number] | undefined
      if (stage === 'redeem') ticket = await runtime.createPairing(binding)
      if (stage === 'prepare' || stage === 'status' || stage === 'approve')
        session = await pair(runtime)
      if (stage === 'status' || stage === 'approve') {
        await prepare(runtime, session!)
        preview = runtime.listPreviews()[0]
      }
      const gate = deferred<boolean>()
      validate.mockReturnValueOnce(gate.promise)
      const pending =
        stage === 'issue'
          ? runtime.createPairing(binding)
          : stage === 'redeem'
            ? runtime.redeem(envelope(ticket!))
            : stage === 'prepare'
              ? prepare(runtime, session!)
              : stage === 'status'
                ? status(runtime, session!, preview!.callId)
                : runtime.approve(preview!.callId, preview!.payloadSha256)
      runtime.revokePlugin(binding.pluginId)
      const newSession = await pair(runtime, { ...binding, generation: 8 })
      gate.resolve(true)
      await expect(pending).rejects.toBeInstanceOf(FigPluginBridgeError)
      expect(runtime.listSessions()).toHaveLength(1)
      expect(runtime.listSessions()[0].sessionId).toBe(newSession.sessionId)
      expect(runtime.listPreviews()).toEqual([])
      expect(invoke).not.toHaveBeenCalled()
    }
  )

  it('revalidates immediately before approval and before publishing an upstream result', async () => {
    const { runtime, session, prepared, preview, validate, invoke } = await fixture()
    validate.mockResolvedValueOnce(false)
    await expect(runtime.approve(prepared.callId, preview.payloadSha256)).rejects.toMatchObject(
      errorCode('CONFIGURATION_CHANGED')
    )
    expect(invoke).not.toHaveBeenCalled()
    await expect(prepare(runtime, session)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    const next = await fixture()
    const outcome = deferred<{ content: string }>()
    next.invoke.mockReturnValue(outcome.promise)
    await next.runtime.approve(next.prepared.callId, next.preview.payloadSha256)
    next.validate.mockResolvedValue(false)
    outcome.resolve({ content: 'PRIVATE' })
    await settle()
    expect(next.runtime.listSessions()).toEqual([])
  })

  it('revokes running and completed calls, aborts the former and never publishes late results', async () => {
    const { runtime, invoke } = make()
    const first = await pair(runtime)
    const second = await pair(runtime)
    const done = await prepare(runtime, first)
    let preview = runtime.listPreviews()[0]
    await runtime.approve(done.callId, preview.payloadSha256)
    await settle()
    const pending = await prepare(runtime, second)
    preview = runtime.listPreviews()[0]
    const outcome = deferred<{ content: string }>()
    invoke.mockReturnValue(outcome.promise)
    await runtime.approve(pending.callId, preview.payloadSha256)
    runtime.revokePlugin(binding.pluginId)
    expect(invoke.mock.calls[1][2].aborted).toBe(true)
    outcome.resolve({ content: 'LATE' })
    await settle()
    await expect(status(runtime, first, done.callId)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    await expect(status(runtime, second, pending.callId)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    expect(runtime.listSessions()).toEqual([])
  })

  it('dispose clears timers, invalidates pending validators and refuses future APIs', async () => {
    const { runtime, session, prepared, preview, invoke, validate } = await fixture()
    const outcome = deferred<{ content: string }>()
    invoke.mockReturnValue(outcome.promise)
    await runtime.approve(prepared.callId, preview.payloadSha256)
    const gate = deferred<boolean>()
    validate.mockReturnValueOnce(gate.promise)
    const issuing = runtime.createPairing(binding)
    runtime.dispose()
    runtime.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(invoke.mock.calls[0][2].aborted).toBe(true)
    gate.resolve(true)
    await expect(issuing).rejects.toBeInstanceOf(FigPluginBridgeError)
    outcome.resolve({ content: 'LATE' })
    await settle()
    await expect(prepare(runtime, session)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    await expect(runtime.createPairing(binding)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
    await expect(runtime.approve(prepared.callId, preview.payloadSha256)).rejects.toMatchObject(
      errorCode('UNAUTHORIZED')
    )
    expect(() => runtime.listPreviews()).toThrow(FIGPLUGIN_BRIDGE_ERRORS.UNAUTHORIZED)
    expect(() => runtime.listSessions()).toThrow(FIGPLUGIN_BRIDGE_ERRORS.UNAUTHORIZED)
    expect(() => runtime.deny(prepared.callId)).toThrow(FIGPLUGIN_BRIDGE_ERRORS.UNAUTHORIZED)
    expect(() => runtime.revokePlugin(binding.pluginId)).toThrow(
      FIGPLUGIN_BRIDGE_ERRORS.UNAUTHORIZED
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the injected clock for expiry without needing a timer tick', async () => {
    let now = Date.now()
    const { runtime } = make({ now: () => now })
    const session = await pair(runtime)
    now += 120_000
    expect(runtime.listSessions()).toEqual([])
    await expect(prepare(runtime, session)).rejects.toMatchObject(errorCode('UNAUTHORIZED'))
  })
})
