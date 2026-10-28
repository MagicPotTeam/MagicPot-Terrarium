import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_NATIVE_PRODUCTION_AVAILABLE,
  figPluginNativeGuaranteeSchema,
  figPluginNativeIntentSchema,
  figPluginNativeProgressSchema,
  figPluginNativeProposalSchema,
  figPluginNativeRuntimeBindingSchema,
  figPluginNativeStatusSchema,
  figPluginNativeWriteConsentSchema
} from '@shared/figplugin/nativeCommand'
import {
  createFigPluginNativeCommandRuntime,
  FIGPLUGIN_NATIVE_RUNTIME_MAX_ACTIONS,
  type FigPluginNativeAuthority,
  type FigPluginNativeCommandRuntime,
  type FigPluginNativeRuntimeDependencies,
  type PreviewResult
} from './nativeCommandRuntime'

// Same inert contract fixtures as shared/figplugin/nativeCommand.test.ts; no host adapter.
const binding = figPluginNativeRuntimeBindingSchema.parse({
  pluginId: 'native.rename',
  host: 'figma',
  generation: 1,
  artifactSha256: 'c'.repeat(64),
  signerFingerprint: 'd'.repeat(64),
  manifestSha256: 'e'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:12345',
  projectId: 'project_1',
  profileId: 'profile-e\u0301',
  profileRevision: 'f'.repeat(64)
})
const guarantee = figPluginNativeGuaranteeSchema.parse({
  host: 'figma',
  policy: 'proposed',
  availability: 'production-unavailable',
  profile: 'figma-synchronous-detectable',
  revision: 'none',
  exclusion: false,
  rollback: 'none',
  cancellation: 'before-dispatch-only'
})
const photoshopGuarantee = figPluginNativeGuaranteeSchema.parse({
  host: 'photoshop',
  policy: 'proposed',
  availability: 'production-unavailable',
  profile: 'photoshop-modal-history',
  revision: 'none',
  exclusion: 'modal-scope',
  rollback: 'scoped-history',
  cancellation: 'modal-cooperative'
})
const proposal = figPluginNativeProposalSchema.parse({
  domain: 'figplugin-native-rename',
  version: 1,
  purpose: 'native-rename-proposal',
  host: 'figma',
  plan: {
    schemaVersion: 1,
    mode: 'plan-only',
    selectionRevision: 'observation-only',
    steps: [{ command: 'node.rename', targetId: 'target-0', name: 'Renamed' }]
  }
})
const fixture = Object.freeze({
  captureType: 'fixture' as const,
  completeHostSnapshot: false as const,
  range: Object.freeze(['target-0']),
  before: Object.freeze({ 'target-0': 'Original' })
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
const drain = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}
const runtimes: FigPluginNativeCommandRuntime[] = []
const makeRuntime = (dependencies: FigPluginNativeRuntimeDependencies = {}) => {
  const runtime = createFigPluginNativeCommandRuntime(dependencies)
  runtimes.push(runtime)
  return runtime
}
const harness = () => {
  let live: FigPluginNativeAuthority = {
    binding,
    guarantee,
    authorityEpoch: '1'.repeat(32),
    instanceEpoch: '2'.repeat(32)
  }
  let invalidate!: () => void
  const resolve = vi.fn<NonNullable<FigPluginNativeRuntimeDependencies['authority']>['resolve']>(
    () => live
  )
  const isCurrent = vi.fn(
    (value: FigPluginNativeAuthority) =>
      value.authorityEpoch === live.authorityEpoch &&
      value.instanceEpoch === live.instanceEpoch &&
      JSON.stringify(value.guarantee) === JSON.stringify(live.guarantee)
  )
  const capture = vi.fn<NonNullable<FigPluginNativeRuntimeDependencies['reader']>['capture']>(
    () => fixture
  )
  const decide = vi.fn<NonNullable<FigPluginNativeRuntimeDependencies['approval']>['decide']>(
    () => true
  )
  const runtime = makeRuntime({
    authority: { resolve, isCurrent },
    reader: { capture },
    approval: { decide },
    subscribe: (callback) => {
      invalidate = callback
    },
    now: () => 1000
  })
  const session = runtime.registerSession(binding)!
  return {
    runtime,
    session,
    resolve,
    capture,
    decide,
    invalidate: () => invalidate(),
    change: (patch: Partial<FigPluginNativeAuthority>) => {
      live = { ...live, ...patch }
    },
    authority: () => live
  }
}
const ready = async (h: ReturnType<typeof harness>) => {
  const result = await h.runtime.capturePreview(h.session, proposal)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  return result
}
const failed = (code: string) => ({ ok: false, code })
const assertNoEffect = (
  h: ReturnType<typeof harness>,
  result: Extract<PreviewResult, { ok: true }>
) => {
  expect(fixture.before).toEqual({ 'target-0': 'Original' })
  expect(result.preview).toMatchObject({ captureType: 'fixture', completeHostSnapshot: false })
  expect(h.runtime.getStatus(h.session, result.action)).toMatchObject({
    ok: true,
    status: { completed: 0, effect: 'none' }
  })
  const progress = h.runtime.getProgress(h.session, result.action)
  expect(progress.ok).toBe(true)
  if (progress.ok) {
    expect(figPluginNativeProgressSchema.safeParse(progress.progress).success).toBe(true)
    for (const event of progress.progress.events)
      expect(event).toMatchObject({ completed: 0, effect: 'none' })
  }
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

describe('fixture-only native preview runtime (no native writes)', () => {
  it.each(['neither', 'authority only', 'reader only'] as const)(
    'stays UNAVAILABLE with %s',
    async (mode) => {
      const capture = vi.fn(() => fixture)
      const resolve = vi.fn(() => ({
        binding,
        guarantee,
        authorityEpoch: '1'.repeat(32),
        instanceEpoch: '2'.repeat(32)
      }))
      const runtime = makeRuntime({
        ...(mode === 'authority only' ? { authority: { resolve, isCurrent: () => true } } : {}),
        ...(mode === 'reader only' ? { reader: { capture } } : {})
      })
      expect(FIGPLUGIN_NATIVE_PRODUCTION_AVAILABLE).toBe(false)
      expect(await runtime.capturePreview(runtime.registerSession(binding), proposal)).toEqual(
        failed('UNAVAILABLE')
      )
      expect(capture).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
      expect(Object.keys(runtime).sort()).toEqual(
        [
          'cancel',
          'capturePreview',
          'dispose',
          'getProgress',
          'getStatus',
          'preparePreview',
          'registerSession',
          'requestDecision',
          'revoke'
        ].sort()
      )
    }
  )

  it('roundtrips the returned action through status, progress, approval and cancellation', async () => {
    const h = harness()
    const result = await ready(h)
    expect(Object.isFrozen(result.action)).toBe(true)
    expect(Object.isFrozen(result.preview.intent.plan.steps[0])).toBe(true)
    expect(figPluginNativeIntentSchema.safeParse(result.preview.intent).success).toBe(true)
    expect(figPluginNativeStatusSchema.safeParse(result.status).success).toBe(true)
    expect(h.runtime.getStatus(h.session, result.action)).toEqual({
      ok: true,
      status: result.status
    })
    expect(h.runtime.getProgress(h.session, result.action)).toMatchObject({
      ok: true,
      progress: { cursor: 1, events: [{ phase: 'awaiting-write-consent' }] }
    })
    expect(await h.runtime.requestDecision(h.session, result.action)).toMatchObject({
      ok: true,
      status: { status: 'approved' }
    })
    expect(figPluginNativeWriteConsentSchema.safeParse(h.decide.mock.calls[0][0]).success).toBe(
      true
    )
    expect(h.decide.mock.calls[0][0]).toMatchObject({
      actionId: result.preview.actionId,
      payloadSha256: result.preview.payloadSha256
    })
    assertNoEffect(h, result)
    expect(h.runtime.cancel(h.session, result.action)).toEqual(failed('CANCELLED'))
    expect(h.runtime.getStatus(h.session, result.action)).toMatchObject({
      ok: true,
      status: { status: 'cancelled' }
    })
  })

  it('rejects forged, cloned, proxied and cross-session handles without consuming the action', async () => {
    const h = harness()
    const result = await ready(h)
    const other = h.runtime.registerSession(binding)!
    for (const [session, action, code] of [
      [{}, result.action, 'INVALID_SESSION'],
      [new Proxy(h.session, {}), result.action, 'INVALID_SESSION'],
      [other, result.action, 'INVALID_ACTION'],
      [h.session, {}, 'INVALID_ACTION'],
      [h.session, { ...result.action }, 'INVALID_ACTION'],
      [h.session, new Proxy(result.action, {}), 'INVALID_ACTION'],
      [
        h.session,
        { actionId: result.preview.actionId, payloadSha256: result.preview.payloadSha256 },
        'INVALID_ACTION'
      ]
    ] as const) {
      expect(h.runtime.getStatus(session, action)).toEqual(failed(code))
      expect(h.runtime.getProgress(session, action)).toEqual(failed(code))
      expect(h.runtime.cancel(session, action)).toEqual(failed(code))
      expect(await h.runtime.requestDecision(session, action)).toEqual(failed(code))
    }
    expect(h.decide).not.toHaveBeenCalled()
    expect(await h.runtime.requestDecision(h.session, result.action)).toMatchObject({ ok: true })
    assertNoEffect(h, result)
  })

  it('approves at most once, blocks duplicate pending decisions and retains the approved slot', async () => {
    const h = harness()
    const gate = deferred<boolean>()
    h.decide.mockReturnValue(gate.promise)
    const result = await ready(h)
    const decision = h.runtime.requestDecision(h.session, result.action)
    expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(failed('BUSY'))
    await drain()
    expect(h.decide).toHaveBeenCalledTimes(1)
    gate.resolve(true)
    expect(await decision).toMatchObject({ ok: true, status: { status: 'approved' } })
    expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(
      failed('ALREADY_DECIDED')
    )
    expect(await h.runtime.capturePreview(h.session, proposal)).toEqual(failed('BUSY'))
    assertNoEffect(h, result)
  })

  it('preserves cancellation as a failure result and releases a settled preview', async () => {
    const h = harness()
    const result = await ready(h)
    expect(h.runtime.cancel(h.session)).toEqual(failed('CANCELLED'))
    expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(failed('CANCELLED'))
    expect(h.runtime.cancel(h.session, result.action)).toEqual(failed('CANCELLED'))
    expect(h.decide).not.toHaveBeenCalled()
    assertNoEffect(h, result)
    expect((await ready(h)).action).not.toBe(result.action)
  })

  it.each(['session', 'all', 'subscription'] as const)(
    'revokes through %s without approval or writes',
    async (mode) => {
      const h = harness()
      const result = await ready(h)
      if (mode === 'subscription') h.invalidate()
      else
        expect(h.runtime.revoke(mode === 'session' ? h.session : undefined)).toEqual(
          failed('REVOKED')
        )
      expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(failed('REVOKED'))
      expect(await h.runtime.capturePreview(h.session, proposal)).toEqual(failed('REVOKED'))
      expect(h.decide).not.toHaveBeenCalled()
      assertNoEffect(h, result)
    }
  )

  it.each(['authorityEpoch', 'instanceEpoch', 'guarantee', 'binding'] as const)(
    'rejects a current but differently pinned %s before consent',
    async (field) => {
      const h = harness()
      const result = await ready(h)
      if (field === 'guarantee') h.change({ guarantee: photoshopGuarantee })
      else if (field === 'binding')
        h.change({ binding: { ...binding, profileRevision: '0'.repeat(64) } })
      else h.change({ [field]: '3'.repeat(32) })
      expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(failed('REVOKED'))
      expect(h.decide).not.toHaveBeenCalled()
      assertNoEffect(h, result)
    }
  )

  it.each(['authorityEpoch', 'instanceEpoch', 'guarantee'] as const)(
    'rechecks %s after asynchronous consent',
    async (field) => {
      const h = harness()
      const gate = deferred<boolean>()
      h.decide.mockReturnValue(gate.promise)
      const result = await ready(h)
      const decision = h.runtime.requestDecision(h.session, result.action)
      await drain()
      expect(h.decide).toHaveBeenCalledTimes(1)
      if (field === 'guarantee') h.change({ guarantee: photoshopGuarantee })
      else h.change({ [field]: '3'.repeat(32) })
      gate.resolve(true)
      expect(await decision).toEqual(failed('REVOKED'))
      assertNoEffect(h, result)
    }
  )

  it.each(['authority', 'approval'] as const)(
    'keeps an aborted %s slot until its pending callback settles, then releases it',
    async (phase) => {
      const h = harness()
      const result = await ready(h)
      const authorityGate = deferred<FigPluginNativeAuthority>()
      const approvalGate = deferred<boolean>()
      if (phase === 'authority') h.resolve.mockReturnValueOnce(authorityGate.promise)
      else h.decide.mockReturnValueOnce(approvalGate.promise)
      const decision = h.runtime.requestDecision(h.session, result.action)
      await drain()
      expect(h.runtime.cancel(h.session, result.action)).toEqual(failed('CANCELLED'))
      expect(await decision).toEqual(failed('CANCELLED'))
      expect(h.resolve.mock.calls.at(-1)![1].aborted).toBe(true)
      expect(await h.runtime.capturePreview(h.session, proposal)).toEqual(failed('BUSY'))
      authorityGate.resolve(h.authority())
      approvalGate.resolve(true)
      await drain()
      expect(await decision).toEqual(failed('CANCELLED'))
      expect(h.decide).toHaveBeenCalledTimes(phase === 'approval' ? 1 : 0)
      assertNoEffect(h, result)
      expect((await ready(h)).action).not.toBe(result.action)
    }
  )

  it('keeps revoked pending consent in the global bound until the callback settles', async () => {
    const h = harness()
    const gate = deferred<boolean>()
    h.decide.mockReturnValueOnce(gate.promise)
    const result = await ready(h)
    const decision = h.runtime.requestDecision(h.session, result.action)
    await drain()
    h.runtime.revoke(h.session)
    expect(await decision).toEqual(failed('REVOKED'))
    for (let index = 1; index < FIGPLUGIN_NATIVE_RUNTIME_MAX_ACTIONS; index += 1) {
      expect(
        (await h.runtime.capturePreview(h.runtime.registerSession(binding), proposal)).ok
      ).toBe(true)
    }
    const waiting = h.runtime.registerSession(binding)!
    expect(await h.runtime.capturePreview(waiting, proposal)).toEqual(failed('BUSY'))
    gate.resolve(true)
    await drain()
    expect((await h.runtime.capturePreview(waiting, proposal)).ok).toBe(true)
    expect(await decision).toEqual(failed('REVOKED'))
    assertNoEffect(h, result)
  })

  it('aborts a pending fixture capture without releasing its slot early or reviving its result', async () => {
    const h = harness()
    const gate = deferred<typeof fixture>()
    h.capture.mockReturnValueOnce(gate.promise)
    const preview = h.runtime.capturePreview(h.session, proposal)
    await drain()
    expect(h.runtime.cancel(h.session)).toEqual(failed('CANCELLED'))
    expect(await preview).toEqual(failed('CANCELLED'))
    expect(h.capture.mock.calls[0][1].aborted).toBe(true)
    expect(await h.runtime.capturePreview(h.session, proposal)).toEqual(failed('BUSY'))
    gate.resolve(fixture)
    await drain()
    expect(await preview).toEqual(failed('CANCELLED'))
    expect(h.decide).not.toHaveBeenCalled()
    await ready(h)
  })

  it.each(['deny', 'throw'] as const)(
    'retains %s as DENIED and does not retry the same action',
    async (mode) => {
      const h = harness()
      h.decide.mockImplementation(() => {
        if (mode === 'throw') throw new Error('fixture refusal')
        return false
      })
      const result = await ready(h)
      expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(failed('DENIED'))
      expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(failed('DENIED'))
      expect(h.decide).toHaveBeenCalledTimes(1)
      assertNoEffect(h, result)
      await ready(h)
    }
  )
})
