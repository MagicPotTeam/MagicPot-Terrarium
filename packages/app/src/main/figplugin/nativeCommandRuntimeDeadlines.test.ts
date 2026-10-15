import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFigPluginNativeCommandRuntime,
  FIGPLUGIN_NATIVE_RUNTIME_CAPTURE_TIMEOUT_MS,
  FIGPLUGIN_NATIVE_RUNTIME_PREVIEW_TTL_MS,
  type FigPluginNativeAuthority,
  type FigPluginNativeCommandRuntime,
  type FigPluginNativeFixtureCapture,
  type PreviewResult
} from './nativeCommandRuntime'

// Owned injected fixtures only. Timers are virtual, no host/process/transport exists.
const authority: FigPluginNativeAuthority = {
  binding: {
    pluginId: 'deadline.rename',
    host: 'figma',
    generation: 1,
    artifactSha256: 'a'.repeat(64),
    signerFingerprint: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64),
    bridgeOrigin: 'http://127.0.0.1:12345',
    projectId: 'owned-project',
    profileId: 'owned-profile',
    profileRevision: 'd'.repeat(64)
  },
  authorityEpoch: 'e'.repeat(32),
  instanceEpoch: 'f'.repeat(32),
  guarantee: {
    host: 'figma',
    policy: 'proposed',
    availability: 'production-unavailable',
    profile: 'figma-synchronous-detectable',
    revision: 'none',
    exclusion: false,
    rollback: 'none',
    cancellation: 'before-dispatch-only'
  }
}
const proposal = {
  domain: 'figplugin-native-rename',
  version: 1,
  purpose: 'native-rename-proposal',
  host: 'figma',
  plan: {
    schemaVersion: 1,
    mode: 'plan-only',
    selectionRevision: 'observation-only',
    steps: [{ command: 'node.rename', targetId: '2:1', name: 'Never written' }]
  }
}
const fixture: FigPluginNativeFixtureCapture = Object.freeze({
  captureType: 'fixture',
  completeHostSnapshot: false,
  range: Object.freeze(['2:1']),
  before: Object.freeze({ '2:1': 'Original' })
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
const drain = async () => {
  for (let count = 0; count < 12; count++) await Promise.resolve()
}
const runtimes: FigPluginNativeCommandRuntime[] = []
const setup = () => {
  const resolve = vi.fn<() => FigPluginNativeAuthority | Promise<FigPluginNativeAuthority>>(
    () => authority
  )
  const capture = vi.fn<
    () => FigPluginNativeFixtureCapture | Promise<FigPluginNativeFixtureCapture>
  >(() => fixture)
  const decide = vi.fn<() => boolean | Promise<boolean>>(() => true)
  const unsubscribe = vi.fn(() => {})
  const signals: AbortSignal[] = []
  const runtime = createFigPluginNativeCommandRuntime({
    authority: {
      resolve: (_binding, signal) => {
        signals.push(signal)
        return resolve()
      },
      isCurrent: () => true
    },
    reader: {
      capture: (_request, signal) => {
        signals.push(signal)
        return capture()
      }
    },
    approval: { decide },
    subscribe: () => unsubscribe,
    now: () => Date.now()
  })
  runtimes.push(runtime)
  const session = runtime.registerSession(authority.binding)!
  return { runtime, session, resolve, capture, decide, unsubscribe, signals }
}
const ready = async (h: ReturnType<typeof setup>) => {
  const result = await h.runtime.capturePreview(h.session, proposal)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  return result
}
const failed = (code: string) => ({ ok: false, code })
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  expect(fixture.before).toEqual({ '2:1': 'Original' })
  vi.useRealTimers()
})

describe('fixture native runtime deadlines and disposal', () => {
  it.each(['authority', 'reader'] as const)(
    'times out pending %s but reserves its slot until settled',
    async (phase) => {
      const h = setup(),
        authorityGate = deferred<FigPluginNativeAuthority>(),
        readerGate = deferred<FigPluginNativeFixtureCapture>()
      if (phase === 'authority') h.resolve.mockReturnValueOnce(authorityGate.promise)
      else h.capture.mockReturnValueOnce(readerGate.promise)
      const waiting = h.runtime.capturePreview(h.session, proposal)
      await drain()
      await vi.advanceTimersByTimeAsync(FIGPLUGIN_NATIVE_RUNTIME_CAPTURE_TIMEOUT_MS)
      expect(await waiting).toEqual(failed('TIMEOUT'))
      expect(h.signals.every((signal) => signal.aborted)).toBe(true)
      expect(await h.runtime.capturePreview(h.session, proposal)).toEqual(failed('BUSY'))
      authorityGate.resolve(authority)
      readerGate.resolve(fixture)
      await drain()
      expect(await waiting).toEqual(failed('TIMEOUT'))
      expect(h.decide).not.toHaveBeenCalled()
      await ready(h)
    }
  )

  it('expires a settled preview without asking for consent and permits a fresh capture', async () => {
    const h = setup(),
      result = await ready(h)
    await vi.advanceTimersByTimeAsync(FIGPLUGIN_NATIVE_RUNTIME_PREVIEW_TTL_MS)
    expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(failed('EXPIRED'))
    expect(h.runtime.getStatus(h.session, result.action)).toMatchObject({
      ok: true,
      status: { status: 'expired', completed: 0, effect: 'none' }
    })
    expect(h.decide).not.toHaveBeenCalled()
    expect((await ready(h)).action).not.toBe(result.action)
  })

  it.each(['authority', 'consent'] as const)(
    'expiry while waiting for %s never revives approval',
    async (phase) => {
      const h = setup(),
        result = await ready(h),
        authorityGate = deferred<FigPluginNativeAuthority>(),
        consentGate = deferred<boolean>()
      if (phase === 'authority') h.resolve.mockReturnValueOnce(authorityGate.promise)
      else h.decide.mockReturnValueOnce(consentGate.promise)
      const waiting = h.runtime.requestDecision(h.session, result.action)
      await drain()
      await vi.advanceTimersByTimeAsync(FIGPLUGIN_NATIVE_RUNTIME_PREVIEW_TTL_MS)
      expect(await waiting).toEqual(failed('EXPIRED'))
      expect(await h.runtime.capturePreview(h.session, proposal)).toEqual(failed('BUSY'))
      authorityGate.resolve(authority)
      consentGate.resolve(true)
      await drain()
      expect(await waiting).toEqual(failed('EXPIRED'))
      expect(h.decide).toHaveBeenCalledTimes(phase === 'consent' ? 1 : 0)
      expect(h.runtime.getStatus(h.session, result.action)).toMatchObject({
        ok: true,
        status: { status: 'expired', effect: 'none', completed: 0 }
      })
      await ready(h)
    }
  )

  it.each(['reader', 'consent'] as const)(
    'dispose during pending %s settles and refuses late success',
    async (phase) => {
      const h = setup(),
        readerGate = deferred<FigPluginNativeFixtureCapture>(),
        consentGate = deferred<boolean>()
      let result: Extract<PreviewResult, { ok: true }> | undefined
      let waiting: Promise<unknown>
      if (phase === 'reader') {
        h.capture.mockReturnValueOnce(readerGate.promise)
        waiting = h.runtime.capturePreview(h.session, proposal)
      } else {
        result = await ready(h)
        h.decide.mockReturnValueOnce(consentGate.promise)
        waiting = h.runtime.requestDecision(h.session, result.action)
      }
      await drain()
      h.runtime.dispose()
      h.runtime.dispose()
      expect(await waiting).toEqual(failed('REVOKED'))
      expect(h.unsubscribe).toHaveBeenCalledTimes(1)
      expect(h.runtime.registerSession(authority.binding)).toBeUndefined()
      expect(h.signals.every((signal) => signal.aborted)).toBe(true)
      readerGate.resolve(fixture)
      consentGate.resolve(true)
      await drain()
      expect(await waiting).toEqual(failed('REVOKED'))
      expect(vi.getTimerCount()).toBe(0)
      // New calls on a disposed runtime are UNAVAILABLE; the in-flight result
      // above remains the original REVOKED outcome.
      if (result)
        expect(await h.runtime.requestDecision(h.session, result.action)).toEqual(
          failed('UNAVAILABLE')
        )
    }
  )

  it('a throwing unsubscribe cannot bypass pending caller settlement or abort', async () => {
    const h = setup(),
      gate = deferred<FigPluginNativeFixtureCapture>()
    h.capture.mockReturnValueOnce(gate.promise)
    h.unsubscribe.mockImplementation(() => {
      throw new Error('Owned subscription cleanup error')
    })
    const waiting = h.runtime.capturePreview(h.session, proposal)
    let settled: unknown
    void waiting.then((result) => {
      settled = result
    })
    await drain()
    expect(() => h.runtime.dispose()).not.toThrow()
    await drain()
    expect(settled).toEqual(failed('REVOKED'))
    expect(h.signals.every((signal) => signal.aborted)).toBe(true)
    gate.resolve(fixture)
    await drain()
    expect(settled).toEqual(failed('REVOKED'))
    expect(vi.getTimerCount()).toBe(0)
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
