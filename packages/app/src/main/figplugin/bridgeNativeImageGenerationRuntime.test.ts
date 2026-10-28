import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import type {
  FigPluginBridgePrepareRequest,
  FigPluginPairResponse,
  FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import type { FigPluginImageGenerationState } from '@shared/figplugin/imageGeneration'
import {
  figPluginImageGenerationProposalStatusSchema,
  type FigPluginImageGenerationProposalPrepareResponse
} from '@shared/figplugin/nativeImageGeneration'
import { FigPluginBridgeController } from './bridgeController'
import { FigPluginBridgeRuntime, type FigPluginNativeImageGenerationReceipt } from './bridgeRuntime'
import type { FigPluginRuntimeDescriptor } from './centerStore'

type Options = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
const binding: FigPluginRuntimeBinding = {
  pluginId: 'owned.native-image',
  host: 'figma',
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'owned_native_generation',
  profileId: 'metadata-model',
  profileRevision: 'd'.repeat(64)
}
const request = (sequence = 1) => ({
  protocol: 1 as const,
  requestId: sequence.toString(16).padStart(32, '0'),
  sequence,
  prompt: 'Generate a private emerald square.'
})
const planning = (
  sequence: number,
  requestId = `planning_${sequence}`
): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  sequence,
  requestId,
  prompt: 'Read selected metadata.',
  context: { selectionRevision: '1', nodes: [] }
})
const key = (response: FigPluginImageGenerationProposalPrepareResponse) => ({
  protocol: 1 as const,
  requestId: response.requestId,
  proposalId: response.proposalId
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const runtimes: FigPluginBridgeRuntime[] = []
const controllers: FigPluginBridgeController[] = []
const make = (options: Partial<Options> = {}) => {
  const validate = vi.fn<Options['validateBinding']>().mockResolvedValue(true)
  const invoke = vi.fn<Options['invoke']>().mockResolvedValue({ content: 'Never invoked.' })
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: validate,
    invoke,
    allowAssetTransfer: () => true,
    assetByteLimit: () => 65536,
    ...options
  })
  runtimes.push(runtime)
  return { runtime, validate, invoke }
}
const pair = async (runtime: FigPluginBridgeRuntime, value = binding) => {
  const ticket = await runtime.createPairing(value)
  return runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host: ticket.host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'e'.repeat(32)
  })
}
const propose = (
  runtime: FigPluginBridgeRuntime,
  session: FigPluginPairResponse,
  value: unknown = request()
) => runtime.prepareImageGeneration(session.sessionId, session.sessionToken, value)
const status = (
  runtime: FigPluginBridgeRuntime,
  session: FigPluginPairResponse,
  response: FigPluginImageGenerationProposalPrepareResponse
) => runtime.imageGenerationStatus(session.sessionId, session.sessionToken, key(response))
const cancel = (
  runtime: FigPluginBridgeRuntime,
  session: FigPluginPairResponse,
  response: FigPluginImageGenerationProposalPrepareResponse
) => runtime.cancelImageGeneration(session.sessionId, session.sessionToken, key(response))
const fixture = async (options: Partial<Options> = {}, scope = binding) => {
  const f = make(options)
  const session = await pair(f.runtime, scope)
  const response = await propose(f.runtime, session)
  const preview = f.runtime.nativeImageGenerationProposals()[0]
  const desktopKey = { proposalId: preview.proposalId, payloadSha256: preview.payloadSha256 }
  return { ...f, session, response, preview, desktopKey }
}
const state = (
  receipt: FigPluginNativeImageGenerationReceipt,
  phase: FigPluginImageGenerationState['phase'],
  changes: Partial<FigPluginImageGenerationState> = {}
): FigPluginImageGenerationState => ({
  sessionId: receipt.request.sessionId,
  pluginId: receipt.request.pluginId,
  projectId: receipt.request.projectId,
  requestId: receipt.request.requestId,
  jobId: 'f'.repeat(32),
  phase,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  expiresAt: receipt.expiresAt,
  ...changes
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  vi.useRealTimers()
})

describe.each(['figma', 'photoshop'] as const)('%s native image generation Runtime', (host) => {
  it('queues only text, derives a separate main key, and grants no image or write authority', async () => {
    const f = await fixture({}, { ...binding, host })
    expect(f.response).toMatchObject({
      requestId: request().requestId,
      status: 'awaiting-approval'
    })
    expect(f.preview).toMatchObject({
      sessionId: f.session.sessionId,
      pluginId: binding.pluginId,
      host,
      prompt: request().prompt
    })
    expect(f.preview.generationRequestId).not.toBe(f.response.requestId)
    expect(f.runtime.listSessions()[0].activeCalls).toBe(1)
    expect(f.runtime.listPreviews()).toEqual([])
    expect(f.runtime.listPlanExecutions()).toEqual([])
    expect(
      (
        await f.runtime.assetList(f.session.sessionId, f.session.sessionToken, {
          protocol: 1,
          purpose: 'local-preview'
        })
      ).assets
    ).toEqual([])
    expect(f.invoke).not.toHaveBeenCalled()
    const native = await status(f.runtime, f.session, f.response)
    expect(figPluginImageGenerationProposalStatusSchema.parse(native)).toEqual(native)
    for (const secret of [
      f.preview.prompt,
      f.preview.generationRequestId,
      binding.profileId,
      'reference',
      'localMediaUrl',
      'jobId'
    ])
      expect(JSON.stringify(native)).not.toContain(secret)
    f.preview.prompt = 'Mutated renderer preview'
    expect(f.runtime.nativeImageGenerationProposals()[0].prompt).toBe(request().prompt)
  })

  it('claims once with identity-only frozen authority and projects exact job progress', async () => {
    const f = await fixture({}, { ...binding, host })
    const receipt = await f.runtime.claimNativeImageGeneration(f.desktopKey)
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.request)).toBe(true)
    expect(receipt.request).toEqual({
      sessionId: f.session.sessionId,
      pluginId: binding.pluginId,
      projectId: binding.projectId,
      requestId: f.preview.generationRequestId,
      prompt: request().prompt
    })
    expect(f.runtime.nativeImageGenerationProposals()).toEqual([])
    await expect(f.runtime.claimNativeImageGeneration(f.desktopKey)).rejects.toMatchObject({
      code: 'BUSY'
    })
    const copied = { ...receipt }
    expect(f.runtime.isNativeImageGenerationCurrent(copied)).toBe(false)
    await expect(f.runtime.validateNativeImageGeneration(copied)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    expect(() =>
      f.runtime.observeNativeImageGeneration(copied, state(receipt, 'preparing'))
    ).toThrow()
    expect(() => f.runtime.finishNativeImageGeneration(copied, { phase: 'failed' })).toThrow()
    await f.runtime.validateNativeImageGeneration(receipt)
    for (const phase of [
      'preparing',
      'awaiting-approval',
      'generating',
      'materializing',
      'awaiting-acceptance',
      'accepted'
    ] as const) {
      f.runtime.observeNativeImageGeneration(receipt, state(receipt, phase))
      expect(await status(f.runtime, f.session, f.response)).toMatchObject({
        phase,
        createdAt: f.response.createdAt,
        expiresAt: f.response.expiresAt
      })
    }
    await cancel(f.runtime, f.session, f.response)
    f.runtime.finishNativeImageGeneration(receipt, { phase: 'failed', error: 'UPSTREAM_FAILED' })
    expect((await status(f.runtime, f.session, f.response)).phase).toBe('accepted')
    expect(receipt.signal.aborted).toBe(false)
    expect(f.runtime.isNativeImageGenerationCurrent(receipt)).toBe(false)
    f.runtime.closeSession(f.session.sessionId, f.session.sessionToken)
    expect(receipt.signal.aborted).toBe(true)
    expect(f.invoke).not.toHaveBeenCalled()
  })
})

describe('native proposal replay, admission and immutable lifetimes', () => {
  it('replays the original receipt after claim, cancel and terminal state without restarting', async () => {
    const f = await fixture()
    const initial = { ...f.response }
    expect(await propose(f.runtime, f.session)).toEqual(initial)
    const receipt = await f.runtime.claimNativeImageGeneration(f.desktopKey)
    await cancel(f.runtime, f.session, f.response)
    expect(receipt.signal.aborted).toBe(true)
    f.runtime.observeNativeImageGeneration(receipt, state(receipt, 'accepted'))
    expect((await status(f.runtime, f.session, f.response)).phase).toBe('cancelled')
    expect(await propose(f.runtime, f.session)).toEqual(initial)
    f.response.expiresAt += 100000
    expect(await propose(f.runtime, f.session)).toEqual(initial)
    await expect(
      propose(f.runtime, f.session, { ...request(), prompt: 'Different exact prompt' })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      propose(f.runtime, f.session, { ...request(), sequence: 2 })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('shares replay identities, ordering and active-call admission with planning', async () => {
    const f = make()
    const session = await pair(f.runtime)
    const read = await f.runtime.prepare(
      session.sessionId,
      session.sessionToken,
      planning(1, request().requestId)
    )
    await expect(propose(f.runtime, session, request(2))).rejects.toMatchObject({ code: 'BUSY' })
    await f.runtime.cancel(session.sessionId, session.sessionToken, read.callId)
    await expect(propose(f.runtime, session)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const generated = await propose(f.runtime, session, request(2))
    await expect(
      f.runtime.prepare(session.sessionId, session.sessionToken, planning(3))
    ).rejects.toMatchObject({ code: 'BUSY' })
    await cancel(f.runtime, session, generated)
    await expect(
      f.runtime.prepare(session.sessionId, session.sessionToken, planning(2, request(2).requestId))
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(propose(f.runtime, session, { ...request(3), sequence: 1 })).rejects.toMatchObject(
      { code: 'INVALID_REQUEST' }
    )
    expect(
      await f.runtime.prepare(session.sessionId, session.sessionToken, planning(3))
    ).toMatchObject({ status: 'awaiting-approval' })
  })

  it('counts mixed planning/native tombstones toward the 64-per-session ceiling', async () => {
    const f = make()
    const session = await pair(f.runtime)
    const read = await f.runtime.prepare(session.sessionId, session.sessionToken, planning(1))
    await f.runtime.cancel(session.sessionId, session.sessionToken, read.callId)
    for (let sequence = 2; sequence <= 64; sequence++)
      await cancel(f.runtime, session, await propose(f.runtime, session, request(sequence)))
    await expect(propose(f.runtime, session, request(65))).rejects.toMatchObject({ code: 'BUSY' })
    expect(await propose(f.runtime, session, request(2))).toMatchObject({
      requestId: request(2).requestId
    })
  })

  it('counts native tombstones toward the global 256-receipt ceiling', async () => {
    const f = make()
    for (let index = 0; index < 4; index++) {
      const session = await pair(f.runtime)
      for (let sequence = 1; sequence <= 64; sequence++)
        await cancel(f.runtime, session, await propose(f.runtime, session, request(sequence)))
    }
    const session = await pair(f.runtime)
    await expect(propose(f.runtime, session)).rejects.toMatchObject({ code: 'BUSY' })
    await expect(
      f.runtime.prepare(session.sessionId, session.sessionToken, planning(1))
    ).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('coalesces validation and admits concurrent exact replay only once', async () => {
    const f = make()
    const session = await pair(f.runtime)
    const gate = deferred<boolean>()
    f.validate.mockClear().mockImplementation(() => gate.promise)
    const first = propose(f.runtime, session)
    const second = propose(f.runtime, session)
    await expect(propose(f.runtime, session)).rejects.toMatchObject({ code: 'BUSY' })
    gate.resolve(true)
    const values = await Promise.all([first, second])
    expect(values[0]).toEqual(values[1])
    expect(f.validate).toHaveBeenCalledTimes(1)
    expect(f.runtime.nativeImageGenerationProposals()).toHaveLength(1)
  })

  it('serializes different request IDs that race with the same native sequence', async () => {
    const f = make()
    const session = await pair(f.runtime)
    const gate = deferred<boolean>()
    f.validate.mockImplementation(() => gate.promise)
    const pending = Promise.allSettled([
      propose(f.runtime, session),
      propose(f.runtime, session, { ...request(2), sequence: 1 })
    ])
    gate.resolve(true)
    const values = await pending
    expect(values.map((value) => value.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(f.runtime.nativeImageGenerationProposals()).toHaveLength(1)
  })

  it('holds all 16 validation slots after session close until the original work settles', async () => {
    const gate = deferred<boolean>()
    let blocked = false
    const f = make({
      validateBinding: (scope) =>
        blocked && scope.projectId.startsWith('blocked_') ? gate.promise : Promise.resolve(true)
    })
    const sessions: FigPluginPairResponse[] = []
    for (let index = 0; index < 16; index++)
      sessions.push(await pair(f.runtime, { ...binding, projectId: `blocked_${index}` }))
    blocked = true
    const pending = Promise.allSettled(sessions.map((session) => propose(f.runtime, session)))
    for (const session of sessions) f.runtime.closeSession(session.sessionId, session.sessionToken)
    const replacement = await pair(f.runtime)
    await expect(propose(f.runtime, replacement)).rejects.toMatchObject({ code: 'BUSY' })
    gate.resolve(true)
    expect((await pending).every((value) => value.status === 'rejected')).toBe(true)
    expect(f.runtime.nativeImageGenerationProposals()).toEqual([])
    expect(await propose(f.runtime, replacement)).toMatchObject({ status: 'awaiting-approval' })
  })

  it('pins the original idle deadline through prepare, status polling and Desktop claim', async () => {
    const f = make()
    const session = await pair(f.runtime)
    const initial = Date.now()
    await vi.advanceTimersByTimeAsync(30000)
    const response = await propose(f.runtime, session)
    expect(response.expiresAt).toBe(initial + 120000)
    for (let index = 0; index < 8; index++) {
      await vi.advanceTimersByTimeAsync(10000)
      expect((await status(f.runtime, session, response)).expiresAt).toBe(response.expiresAt)
    }
    const preview = f.runtime.nativeImageGenerationProposals()[0]
    const receipt = await f.runtime.claimNativeImageGeneration({
      proposalId: preview.proposalId,
      payloadSha256: preview.payloadSha256
    })
    expect(receipt.expiresAt).toBe(initial + 120000)
    await vi.advanceTimersByTimeAsync(10000)
    expect(receipt.signal.aborted).toBe(true)
    await expect(status(f.runtime, session, response)).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })

  it('caps proposal lifetime by signed timeout and retains replay tombstones after timeout', async () => {
    const f = await fixture({ imageGenerationTimeoutMs: () => 1000 })
    const receipt = await f.runtime.claimNativeImageGeneration(f.desktopKey)
    expect(receipt.expiresAt).toBe(Date.now() + 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(receipt.signal.aborted).toBe(true)
    expect(await status(f.runtime, f.session, f.response)).toMatchObject({
      phase: 'failed',
      error: 'EXPIRED'
    })
    expect(await propose(f.runtime, f.session)).toEqual(f.response)
    expect(await propose(f.runtime, f.session, request(2))).toMatchObject({
      status: 'awaiting-approval'
    })
  })

  it('atomically allows only one Desktop claim after coalesced validation', async () => {
    const f = await fixture()
    const gate = deferred<boolean>()
    f.validate.mockImplementation(() => gate.promise)
    const pending = Promise.allSettled([
      f.runtime.claimNativeImageGeneration(f.desktopKey),
      f.runtime.claimNativeImageGeneration(f.desktopKey)
    ])
    gate.resolve(true)
    const values = await pending
    expect(values.map((value) => value.status).sort()).toEqual(['fulfilled', 'rejected'])
  })
})

describe('native proposal authority and revocation boundaries', () => {
  it.each([
    'model',
    'profileId',
    'endpoint',
    'attachments',
    'context',
    'imageGenerationOptions',
    'outputPath'
  ])('rejects native override field %s', async (field) => {
    const f = make()
    const session = await pair(f.runtime)
    await expect(
      propose(f.runtime, session, { ...request(), [field]: 'untrusted' })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.runtime.nativeImageGenerationProposals()).toEqual([])
  })

  it.each(['', ' '.repeat(50), 'x'.repeat(8193)])('rejects invalid prompt %#', async (prompt) => {
    const f = make()
    const session = await pair(f.runtime)
    await expect(propose(f.runtime, session, { ...request(), prompt })).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
  })

  it.each([
    { allowAssetTransfer: () => false },
    { assetByteLimit: () => 0 },
    { assetByteLimit: () => 1.5 },
    { imageGenerationTimeoutMs: () => 0 },
    { imageGenerationTimeoutMs: () => NaN },
    {
      imageGenerationTimeoutMs: () => {
        throw new Error('private configuration')
      }
    }
  ])('fails closed for absent/invalid signed limits %#', async (options) => {
    const f = make(options)
    const session = await pair(f.runtime)
    await expect(propose(f.runtime, session)).rejects.toMatchObject({ code: 'DENIED' })
  })

  it('enforces signed input bytes on raw JSON, including trimmed whitespace', async () => {
    const raw = { ...request(), prompt: ' '.repeat(2000) + 'square' }
    const f = make({ assetByteLimit: () => 1024 })
    const session = await pair(f.runtime)
    await expect(propose(f.runtime, session, raw)).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    const bounded = make({ assetByteLimit: () => Buffer.byteLength(JSON.stringify(request())) })
    expect(await propose(bounded.runtime, await pair(bounded.runtime))).toMatchObject({
      status: 'awaiting-approval'
    })
  })

  it('requires both exact native IDs in the same authenticated session', async () => {
    const f = await fixture()
    const other = await pair(f.runtime)
    await expect(
      f.runtime.imageGenerationStatus(other.sessionId, other.sessionToken, key(f.response))
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      f.runtime.cancelImageGeneration(f.session.sessionId, f.session.sessionToken, {
        ...key(f.response),
        requestId: '9'.repeat(32)
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      f.runtime.imageGenerationStatus(f.session.sessionId, '0'.repeat(64), key(f.response))
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      f.runtime.claimNativeImageGeneration({ ...f.desktopKey, payloadSha256: '0'.repeat(64) })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(f.runtime.nativeImageGenerationProposals()).toHaveLength(1)
  })

  it.each([
    'close',
    'plugin',
    'transport',
    'binding',
    'dispose',
    'native-cancel',
    'desktop-cancel'
  ] as const)('synchronously aborts claimed work on %s', async (action) => {
    const f = await fixture()
    const receipt = await f.runtime.claimNativeImageGeneration(f.desktopKey)
    const observed = vi.fn(() =>
      f.runtime.observeNativeImageGeneration(
        receipt,
        state(receipt, 'cancelled', { error: 'CANCELLED' })
      )
    )
    receipt.signal.addEventListener('abort', observed)
    if (action === 'close') f.runtime.closeSession(f.session.sessionId, f.session.sessionToken)
    else if (action === 'plugin') f.runtime.revokePlugin(binding.pluginId)
    else if (action === 'transport') f.runtime.revokeTransport()
    else if (action === 'binding') f.runtime.revokeInvalidBindings(() => false)
    else if (action === 'dispose') f.runtime.dispose()
    else if (action === 'native-cancel') await cancel(f.runtime, f.session, f.response)
    else f.runtime.cancelNativeImageGeneration(f.desktopKey)
    expect(receipt.signal.aborted).toBe(true)
    expect(observed).toHaveBeenCalledTimes(1)
    expect(f.runtime.isNativeImageGenerationCurrent(receipt)).toBe(false)
  })

  it.each(['cancel', 'close', 'invalid-package'] as const)(
    'does not issue a claim after %s races asynchronous validation',
    async (action) => {
      const f = await fixture()
      const gate = deferred<boolean>()
      f.validate.mockImplementation(() => gate.promise)
      const pending = f.runtime.claimNativeImageGeneration(f.desktopKey).catch((error) => error)
      if (action === 'cancel') await cancel(f.runtime, f.session, f.response)
      else if (action === 'close')
        f.runtime.closeSession(f.session.sessionId, f.session.sessionToken)
      gate.resolve(action !== 'invalid-package')
      expect(await pending).toHaveProperty('code')
      expect(f.invoke).not.toHaveBeenCalled()
    }
  )

  it.each(['bytes', 'timeout', 'capability'] as const)(
    'revokes a claim when its signed %s policy changes',
    async (kind) => {
      let changed = false
      const f = await fixture({
        allowAssetTransfer: () => !(changed && kind === 'capability'),
        assetByteLimit: () => (changed && kind === 'bytes' ? 32768 : 65536),
        imageGenerationTimeoutMs: () => (changed && kind === 'timeout' ? 30000 : 60000)
      })
      const receipt = await f.runtime.claimNativeImageGeneration(f.desktopKey)
      changed = true
      await expect(f.runtime.validateNativeImageGeneration(receipt)).rejects.toMatchObject({
        code: 'CONFIGURATION_CHANGED'
      })
      expect(receipt.signal.aborted).toBe(true)
      expect(await status(f.runtime, f.session, f.response)).toMatchObject({ phase: 'failed' })
    }
  )

  it.each([
    { sessionId: '9'.repeat(32) },
    { pluginId: 'foreign.plugin' },
    { projectId: 'foreign_project' },
    { requestId: '8'.repeat(32) },
    { jobId: '7'.repeat(32) },
    { createdAt: 1_799_999_999_999 },
    { updatedAt: 1_800_000_000_001 },
    { expiresAt: 1_800_000_120_001 },
    { phase: 'preparing' as const }
  ])('rejects crossed/regressed coordinator state %# without leaking it', async (change) => {
    const f = await fixture()
    const receipt = await f.runtime.claimNativeImageGeneration(f.desktopKey)
    f.runtime.observeNativeImageGeneration(receipt, state(receipt, 'generating'))
    f.runtime.observeNativeImageGeneration(receipt, state(receipt, 'materializing', change))
    expect(receipt.signal.aborted).toBe(true)
    expect(await status(f.runtime, f.session, f.response)).toMatchObject({
      phase: 'failed',
      error: 'CONFIGURATION_CHANGED'
    })
    expect(JSON.stringify(await status(f.runtime, f.session, f.response))).not.toContain(
      request().prompt
    )
  })

  it('retains original proposal timestamps while coordinator starts later and shortens its deadline', async () => {
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(10000)
    const receipt = await f.runtime.claimNativeImageGeneration(f.desktopKey)
    f.runtime.observeNativeImageGeneration(
      receipt,
      state(receipt, 'preparing', { expiresAt: receipt.expiresAt - 1000 })
    )
    expect(await status(f.runtime, f.session, f.response)).toMatchObject({
      createdAt: f.response.createdAt,
      updatedAt: Date.now(),
      expiresAt: f.response.expiresAt,
      phase: 'preparing'
    })
  })

  it('finishes an admission failure without allowing fallback to impersonate accepted ownership', async () => {
    const f = await fixture()
    const receipt = await f.runtime.claimNativeImageGeneration(f.desktopKey)
    expect(() =>
      f.runtime.finishNativeImageGeneration(receipt, { phase: 'accepted' } as never)
    ).toThrow()
    f.runtime.finishNativeImageGeneration(receipt, { phase: 'failed', error: 'BUSY' })
    expect(receipt.signal.aborted).toBe(true)
    expect(await status(f.runtime, f.session, f.response)).toMatchObject({
      phase: 'failed',
      error: 'BUSY'
    })
    expect(await propose(f.runtime, f.session)).toEqual(f.response)
  })
})

async function controllerFixture() {
  const descriptor: FigPluginRuntimeDescriptor = {
    pluginId: binding.pluginId,
    host: binding.host,
    generation: binding.generation,
    artifactSha256: binding.artifactSha256,
    signerFingerprint: binding.signerFingerprint,
    manifestSha256: binding.manifestSha256,
    bridgeOrigin: binding.bridgeOrigin,
    profileId: binding.profileId,
    capabilities: ['dialogue', 'asset-transfer'],
    limits: {
      maxPayloadBytes: 16384,
      maxResultBytes: 8192,
      maxConfigBytes: 1024,
      maxCallTimeoutMs: 30000,
      maxConcurrentCalls: 1
    }
  }
  const invalidations = new Set<(pluginId: string) => void>()
  const profiles = new Set<() => void>()
  const store = {
    getRuntimeDescriptor: vi.fn(async () => structuredClone(descriptor)),
    onRuntimeInvalidated: (listener: (pluginId: string) => void) => {
      invalidations.add(listener)
      return () => {
        invalidations.delete(listener)
      }
    }
  }
  const model = {
    listProfiles: vi.fn<LLMProxySvc['listProfiles']>().mockResolvedValue({
      profiles: [
        {
          id: binding.profileId,
          model_name: 'Metadata only',
          model_use: 'chat',
          configurationRevision: binding.profileRevision,
          context_budget_tokens: 8192
        }
      ]
    }),
    chat: vi.fn<LLMProxySvc['chat']>(),
    cancelConversation: vi.fn<LLMProxySvc['cancelConversation']>(),
    isProfileRevisionCurrent: () => true,
    onProfileConfigurationChanged: (listener: () => void) => {
      profiles.add(listener)
      return () => {
        profiles.delete(listener)
      }
    }
  }
  let runtime!: FigPluginBridgeRuntime
  const controller = new FigPluginBridgeController(store, model, {
    startServer: async (options) => {
      runtime = options.runtime as FigPluginBridgeRuntime
      return { origin: options.origin, close: async () => undefined }
    }
  })
  controllers.push(controller)
  const resolved = await controller.resolveBinding(
    { pluginId: binding.pluginId, expectedGeneration: binding.generation },
    binding.projectId
  )
  const ticket = await controller.createPairing(resolved)
  const session = await runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host: ticket.host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'e'.repeat(32)
  })
  const response = await propose(runtime, session)
  const preview = controller.nativeImageGenerationProposals()[0]
  const desktopKey = { proposalId: preview.proposalId, payloadSha256: preview.payloadSha256 }
  return {
    controller,
    runtime,
    descriptor,
    store,
    model,
    invalidations,
    profiles,
    session,
    response,
    preview,
    desktopKey
  }
}

describe('Controller native proposal package epochs', () => {
  it('uses the signed timeout, validates original receipt identity and never calls planning model', async () => {
    const f = await controllerFixture()
    expect(f.response.expiresAt).toBe(Date.now() + 30000)
    const receipt = await f.controller.claimNativeImageGeneration(f.desktopKey)
    expect(f.controller.isNativeImageGenerationCurrent(receipt)).toBe(true)
    expect(f.controller.isNativeImageGenerationCurrent({ ...receipt })).toBe(false)
    await f.controller.validateNativeImageGeneration(receipt)
    await expect(f.controller.validateNativeImageGeneration({ ...receipt })).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    f.controller.observeNativeImageGeneration(receipt, state(receipt, 'generating'))
    expect((await status(f.runtime, f.session, f.response)).phase).toBe('generating')
    expect(f.model.chat).not.toHaveBeenCalled()
  })

  it.each(['artifact', 'limit'] as const)(
    'rejects signed %s mutation before Desktop claim',
    async (kind) => {
      const f = await controllerFixture()
      if (kind === 'artifact') f.descriptor.artifactSha256 = '9'.repeat(64)
      else f.descriptor.limits.maxPayloadBytes--
      await expect(f.controller.claimNativeImageGeneration(f.desktopKey)).rejects.toMatchObject({
        code: 'CONFIGURATION_CHANGED'
      })
      expect(f.controller.nativeImageGenerationProposals()).toEqual([])
    }
  )

  it.each(['package', 'profile', 'dispose'] as const)(
    'revokes a claimed receipt synchronously on %s authority change',
    async (kind) => {
      const f = await controllerFixture()
      const receipt = await f.controller.claimNativeImageGeneration(f.desktopKey)
      if (kind === 'package') for (const listener of f.invalidations) listener(binding.pluginId)
      else if (kind === 'profile') for (const listener of f.profiles) listener()
      else await f.controller.dispose()
      expect(receipt.signal.aborted).toBe(true)
      expect(f.controller.isNativeImageGenerationCurrent(receipt)).toBe(false)
      expect(f.model.chat).not.toHaveBeenCalled()
    }
  )
})
