import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatResp, LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import { FigPluginBridgeError } from '@shared/figplugin/bridge'
import { FIGPLUGIN_ASSET_MAX_BYTES } from '@shared/figplugin/hostAssets'
import {
  FIGPLUGIN_IMAGE_GENERATION_MAX_MS,
  FIGPLUGIN_IMAGE_GENERATION_OPTIONS,
  figPluginImageGenerationOutputSchema,
  figPluginImageGenerationStateSchema,
  type FigPluginImageGenerationAccept,
  type FigPluginImageGenerationKey,
  type FigPluginImageGenerationOutput,
  type FigPluginImageGenerationRequest,
  type FigPluginImageGenerationState
} from '@shared/figplugin/imageGeneration'
import type { FigPluginAssetSelection } from './bridgeRuntime'
import {
  FigPluginImageGenerationCoordinator,
  type FigPluginImageGenerationContext,
  type FigPluginImageGenerationModel
} from './imageGenerationCoordinator'
import type {
  MaterializedProviderImageOutput,
  ProviderImageOutputMaterializer
} from './providerImageOutput'

const NOW = 1_800_000_000_000
const PROFILE = 'synthetic-image-profile'
const REVISION = 'e'.repeat(64)
const SHA256 = 'f'.repeat(64)
const target = {
  sessionId: 'a'.repeat(32),
  pluginId: 'synthetic.figma',
  projectId: 'synthetic_project'
}
const key = (seed = 1): FigPluginImageGenerationKey => ({
  ...target,
  requestId: seed.toString(16).padStart(32, '0')
})
const request = (seed = 1): FigPluginImageGenerationRequest => ({
  ...key(seed),
  prompt: 'PRIVATE-PROMPT: generate a synthetic green square.'
})
const profile = (): LLMListProfilesResp['profiles'][number] => ({
  id: PROFILE,
  model_name: 'synthetic-image-model',
  provider: 'openai',
  model_use: 'image',
  api_mode: 'images',
  call_type: 'api',
  configurationRevision: REVISION
})
const listing = (): LLMListProfilesResp => ({
  comparisonDestination: { kind: 'local' },
  profiles: [profile()]
})
const response = (): LLMChatResp => ({
  content: 'PRIVATE-PROVIDER-CONTENT',
  imageUrl: 'https://example.invalid/PRIVATE-PROVIDER-IMAGE.png',
  finishReason: 'stop'
})
const selection = (): FigPluginAssetSelection =>
  Object.freeze({
    target: Object.freeze({ ...target }),
    host: 'figma',
    bindingSha256: 'b'.repeat(64),
    maxBytes: 4096,
    expiresAt: NOW + FIGPLUGIN_IMAGE_GENERATION_MAX_MS
  })
const syntheticOutput = (runId: string) => {
  const relativePath = `user-output/figplugin-${runId}/ab/generated.png`
  return {
    reference: {
      version: 1 as const,
      kind: 'managed' as const,
      relativePath,
      sha256: SHA256,
      sizeBytes: 70,
      mimeType: 'image/png' as const,
      originalFileName: 'generated.png'
    },
    localMediaUrl: `local-media:///synthetic/.chat_media/${relativePath}`,
    width: 1,
    height: 1,
    discard: vi.fn<MaterializedProviderImageOutput['discard']>().mockResolvedValue(undefined)
  }
}
const accept = (output: FigPluginImageGenerationOutput): FigPluginImageGenerationAccept => ({
  sessionId: output.sessionId,
  pluginId: output.pluginId,
  projectId: output.projectId,
  requestId: output.requestId,
  jobId: output.jobId,
  resultId: output.resultId,
  sha256: output.reference.sha256
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
const flush = async () => {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve()
}
const coordinators: FigPluginImageGenerationCoordinator[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose()
  await flush()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const fixture = () => {
  const owner = {}
  let selected = selection()
  let authorityFailure: Error | undefined
  let current = true
  let revisionCurrent = true
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn(() => listeners.clear())
  const model = {
    listProfiles: vi
      .fn<FigPluginImageGenerationModel['listProfiles']>()
      .mockResolvedValue(listing()),
    chat: vi.fn<FigPluginImageGenerationModel['chat']>().mockResolvedValue(response()),
    cancelConversation: vi
      .fn<FigPluginImageGenerationModel['cancelConversation']>()
      .mockResolvedValue({ cancelled: true }),
    isProfileRevisionCurrent: vi.fn(() => revisionCurrent),
    onProfileConfigurationChanged: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return unsubscribe
    })
  }
  const outputs: ReturnType<typeof syntheticOutput>[] = []
  const materialize = vi
    .fn<ProviderImageOutputMaterializer>()
    .mockImplementation(async (_value, options) => {
      const result = syntheticOutput(options.runId)
      outputs.push(result)
      return result
    })
  const makeModel = vi.fn(async () => model)
  const configuredProfile = vi.fn(async () => PROFILE)
  const context = {
    owner,
    sessionExpiresAt: NOW + 10 * 60_000,
    check: vi.fn(() => {
      if (authorityFailure) throw authorityFailure
    }),
    capture: vi
      .fn<FigPluginImageGenerationContext['capture']>()
      .mockImplementation(async () => selected),
    isCurrent: vi.fn(() => current),
    validate: vi.fn<FigPluginImageGenerationContext['validate']>().mockResolvedValue(undefined),
    confirm: vi.fn<FigPluginImageGenerationContext['confirm']>().mockResolvedValue(true)
  }
  const coordinator = new FigPluginImageGenerationCoordinator({
    makeModel,
    configuredProfile,
    materialize
  })
  coordinators.push(coordinator)
  return {
    coordinator,
    owner,
    model,
    makeModel,
    configuredProfile,
    context,
    materialize,
    outputs,
    unsubscribe,
    select(value: FigPluginAssetSelection) {
      selected = value
    },
    setCurrent(value: boolean) {
      current = value
    },
    setRevisionCurrent(value: boolean) {
      revisionCurrent = value
    },
    failAuthority(error: Error = new FigPluginBridgeError('CONFIGURATION_CHANGED')) {
      authorityFailure = error
    },
    notifyConfigurationChanged() {
      for (const listener of listeners) listener()
    }
  }
}

const requireOutput = (
  value: FigPluginImageGenerationOutput | null
): FigPluginImageGenerationOutput => {
  expect(value).not.toBeNull()
  return value!
}
const assertSanitizedState = (
  value: FigPluginImageGenerationState | null,
  phase: FigPluginImageGenerationState['phase']
) => {
  expect(value).not.toBeNull()
  expect(value!.phase).toBe(phase)
  expect(figPluginImageGenerationStateSchema.parse(value)).toEqual(value)
  const fields = [
    'sessionId',
    'pluginId',
    'projectId',
    'requestId',
    'jobId',
    'phase',
    'createdAt',
    'updatedAt',
    'expiresAt',
    ...(value!.error ? ['error'] : [])
  ]
  expect(Object.keys(value!).sort()).toEqual(fields.sort())
  expect(JSON.stringify(value)).not.toMatch(/PRIVATE-|https:|local-media:|data:image/)
}

describe('Desktop generation coordinator: exact provider dispatch', () => {
  it('uses one model instance, the consented revision and fixed options without overriding configured routing', async () => {
    const f = fixture()
    const result = requireOutput(await f.coordinator.generate(request(), f.context))
    expect(figPluginImageGenerationOutputSchema.parse(result)).toEqual(result)
    expect(f.configuredProfile).toHaveBeenCalledExactlyOnceWith(key())
    expect(f.makeModel).toHaveBeenCalledTimes(1)
    expect(f.model.listProfiles).toHaveBeenCalledExactlyOnceWith({
      comparisonRouting: 'configured',
      includeConfigurationRevision: true
    })
    expect(f.context.confirm).toHaveBeenCalledTimes(1)
    const [consent, consentSignal] = f.context.confirm.mock.calls[0]
    expect(consent).toEqual({
      ...request(),
      jobId: result.jobId,
      profileId: PROFILE,
      profileRevision: REVISION,
      modelName: profile().model_name,
      provider: 'openai',
      apiMode: 'images',
      selection: selection(),
      expiresAt: NOW + FIGPLUGIN_IMAGE_GENERATION_MAX_MS
    })
    const [chat, options] = f.model.chat.mock.calls[0]
    expect(chat).toEqual({
      messages: [{ role: 'user', content: request().prompt }],
      profileId: PROFILE,
      expectedProfileRevision: REVISION,
      comparisonRouting: 'configured',
      conversationId: expect.stringMatching(/^figplugin-image-[a-f0-9-]{36}$/),
      cancellationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      imageGenerationOptions: FIGPLUGIN_IMAGE_GENERATION_OPTIONS
    })
    expect(options).toEqual({ signal: consentSignal })
    expect(chat.imageGenerationOptions).not.toBe(FIGPLUGIN_IMAGE_GENERATION_OPTIONS)
    expect(consentSignal.aborted).toBe(false)
    expect(f.model.isProfileRevisionCurrent).toHaveBeenCalledWith(PROFILE, REVISION)
    expect(f.materialize).toHaveBeenCalledTimes(1)
    const [providerResult, materialization] = f.materialize.mock.calls[0]
    expect(providerResult).toEqual(response())
    expect(materialization).toEqual({
      runId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      check: expect.any(Function),
      signal: consentSignal,
      maxBytes: selection().maxBytes,
      deadlineAt: result.expiresAt
    })
    expect(result.reference.relativePath).toContain(
      `user-output/figplugin-${materialization.runId}/`
    )
    expect(result).not.toHaveProperty('discard')
    expect(result).not.toHaveProperty('assetId')
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'awaiting-acceptance')
    expect(await f.coordinator.accept(accept(result), f.owner)).toBe(true)

    const second = requireOutput(await f.coordinator.generate(request(2), f.context))
    expect(f.makeModel).toHaveBeenCalledTimes(1)
    expect(f.model.onProfileConfigurationChanged).toHaveBeenCalledTimes(1)
    expect(f.model.listProfiles).toHaveBeenCalledTimes(2)
    expect(f.model.chat).toHaveBeenCalledTimes(2)
    expect(second.jobId).not.toBe(result.jobId)
    expect(second.resultId).not.toBe(result.resultId)
    expect(second.reference.relativePath).not.toBe(result.reference.relativePath)
    expect(f.model.chat.mock.calls[1][0].conversationId).not.toBe(chat.conversationId)
    expect(f.outputs[0].discard).not.toHaveBeenCalled()
  })

  it('declines native consent without dispatch and retains the request tombstone', async () => {
    const f = fixture()
    f.context.confirm.mockResolvedValue(false)
    expect(await f.coordinator.generate(request(), f.context)).toBeNull()
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'declined')
    expect(f.model.chat).not.toHaveBeenCalled()
    expect(f.materialize).not.toHaveBeenCalled()
    expect(f.model.cancelConversation).not.toHaveBeenCalled()
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    await expect(
      f.coordinator.generate({ ...request(), prompt: 'Changed prompt cannot recharge.' }, f.context)
    ).rejects.toMatchObject({ code: 'BUSY' })
    expect(await f.coordinator.generate(request(2), f.context)).toBeNull()
    expect(f.context.confirm).toHaveBeenCalledTimes(2)
    expect(f.makeModel).toHaveBeenCalledTimes(1)
  })

  const invalidListings: [string, LLMListProfilesResp][] = [
    [
      'remote',
      { ...listing(), comparisonDestination: { kind: 'remote', origin: 'https://example.invalid' } }
    ],
    ['missing profile', { ...listing(), profiles: [] }],
    ['different profile', { ...listing(), profiles: [{ ...profile(), id: 'other-profile' }] }],
    ['duplicate profile', { ...listing(), profiles: [profile(), profile()] }],
    ['wrong provider', { ...listing(), profiles: [{ ...profile(), provider: 'gemini' }] }],
    ['wrong model use', { ...listing(), profiles: [{ ...profile(), model_use: 'agent' }] }],
    ['missing API mode', { ...listing(), profiles: [{ ...profile(), api_mode: undefined }] }],
    [
      'unsupported API mode',
      { ...listing(), profiles: [{ ...profile(), api_mode: 'chat-completions' }] }
    ],
    ['non-API call type', { ...listing(), profiles: [{ ...profile(), call_type: 'local' }] }],
    ['OCR profile', { ...listing(), profiles: [{ ...profile(), is_ocr_model: true }] }],
    [
      'missing revision',
      { ...listing(), profiles: [{ ...profile(), configurationRevision: undefined }] }
    ],
    [
      'uppercase revision',
      { ...listing(), profiles: [{ ...profile(), configurationRevision: 'E'.repeat(64) }] }
    ],
    [
      'short revision',
      { ...listing(), profiles: [{ ...profile(), configurationRevision: 'e'.repeat(63) }] }
    ],
    [
      'newline revision',
      { ...listing(), profiles: [{ ...profile(), configurationRevision: REVISION + '\n' }] }
    ]
  ]
  it.each(invalidListings)(
    'refuses %s metadata before native consent or charging',
    async (_name, metadata) => {
      const f = fixture()
      f.model.listProfiles.mockResolvedValue(metadata)
      await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
        code: 'CONFIGURATION_CHANGED'
      })
      expect(f.context.confirm).not.toHaveBeenCalled()
      expect(f.model.chat).not.toHaveBeenCalled()
      expect(f.materialize).not.toHaveBeenCalled()
      assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
    }
  )

  it('refuses missing configured profile and a stale revision without falling back to another profile', async () => {
    const missing = fixture()
    missing.configuredProfile.mockResolvedValue('')
    await expect(missing.coordinator.generate(request(), missing.context)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    expect(missing.model.chat).not.toHaveBeenCalled()
    expect(missing.context.confirm).not.toHaveBeenCalled()
    const stale = fixture()
    stale.setRevisionCurrent(false)
    await expect(stale.coordinator.generate(request(), stale.context)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    expect(stale.context.confirm).not.toHaveBeenCalled()
    expect(stale.model.chat).not.toHaveBeenCalled()
  })

  it('exposes sanitized phases and returns defensive state copies at every asynchronous boundary', async () => {
    const f = fixture()
    const configured = deferred<string>()
    const confirmation = deferred<boolean>()
    const provider = deferred<LLMChatResp>()
    const materialization = deferred<MaterializedProviderImageOutput>()
    f.configuredProfile.mockReturnValue(configured.promise)
    f.context.confirm.mockReturnValue(confirmation.promise)
    f.model.chat.mockReturnValue(provider.promise)
    f.materialize.mockReturnValue(materialization.promise)
    const running = observe(f.coordinator.generate(request(), f.context))
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'preparing')
    expect(f.coordinator.state(key(), {})).toBeNull()
    configured.resolve(PROFILE)
    await flush()
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'awaiting-approval')
    confirmation.resolve(true)
    await flush()
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'generating')
    provider.resolve(response())
    await flush()
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'materializing')
    const generated = syntheticOutput(f.materialize.mock.calls[0][1].runId)
    materialization.resolve(generated)
    const settled = await running
    expect(settled).toHaveProperty('value')
    const output = requireOutput(
      (settled as { value: FigPluginImageGenerationOutput | null }).value
    )
    const snapshot = f.coordinator.state(key(), f.owner)!
    snapshot.phase = 'accepted'
    snapshot.expiresAt = NOW + 1
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'awaiting-acceptance')
    expect(await f.coordinator.accept(accept(output), f.owner)).toBe(true)
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'accepted')
    expect(generated.discard).not.toHaveBeenCalled()
  })
})

describe('one active charged operation and replay ownership', () => {
  it('holds admission until an abort-ignoring provider actually settles, then discards its late response', async () => {
    const f = fixture()
    const provider = deferred<LLMChatResp>()
    f.model.chat.mockReturnValueOnce(provider.promise)
    const running = observe(f.coordinator.generate(request(), f.context))
    await flush()
    expect(f.model.chat).toHaveBeenCalledTimes(1)
    await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    expect(f.coordinator.cancel(key(), {})).toBe(false)
    expect(f.coordinator.cancel(key(), f.owner)).toBe(true)
    expect(await running).toMatchObject({ error: { code: 'CANCELLED' } })
    const [chat, options] = f.model.chat.mock.calls[0]
    expect(options?.signal?.aborted).toBe(true)
    expect(f.model.cancelConversation).toHaveBeenCalledExactlyOnceWith({
      conversationId: chat.conversationId,
      cancellationId: chat.cancellationId
    })
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'cancelled')
    await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    provider.resolve(response())
    await flush()
    expect(f.materialize).not.toHaveBeenCalled()
    f.context.confirm.mockResolvedValue(false)
    expect(await f.coordinator.generate(request(2), f.context)).toBeNull()
    expect(f.model.chat).toHaveBeenCalledTimes(1)
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
  })

  it('holds admission for an abort-ignoring materializer and its late-output rollback', async () => {
    const f = fixture()
    const materialization = deferred<MaterializedProviderImageOutput>()
    const cleanup = deferred<void>()
    f.materialize.mockReturnValueOnce(materialization.promise)
    const running = observe(f.coordinator.generate(request(), f.context))
    await flush()
    expect(f.materialize).toHaveBeenCalledTimes(1)
    const options = f.materialize.mock.calls[0][1]
    expect(f.coordinator.cancel(key(), f.owner)).toBe(true)
    expect(await running).toMatchObject({ error: { code: 'CANCELLED' } })
    expect(options.signal.aborted).toBe(true)
    expect(() => options.check()).toThrow(FigPluginBridgeError)
    await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    const late = syntheticOutput(options.runId)
    late.discard.mockReturnValue(cleanup.promise)
    materialization.resolve(late)
    await flush()
    expect(late.discard).toHaveBeenCalledTimes(1)
    await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    cleanup.resolve(undefined)
    await flush()
    f.context.confirm.mockResolvedValue(false)
    expect(await f.coordinator.generate(request(2), f.context)).toBeNull()
    expect(f.model.chat).toHaveBeenCalledTimes(1)
    expect(late.discard).toHaveBeenCalledTimes(1)
  })

  it('cannot convert a late positive native-dialog answer into a charged request after cancellation', async () => {
    const f = fixture()
    const confirmation = deferred<boolean>()
    f.context.confirm.mockReturnValueOnce(confirmation.promise)
    const running = observe(f.coordinator.generate(request(), f.context))
    await flush()
    expect(f.context.confirm).toHaveBeenCalledTimes(1)
    expect(f.coordinator.cancel(key(), f.owner)).toBe(true)
    expect(await running).toMatchObject({ error: { code: 'CANCELLED' } })
    expect(f.context.confirm.mock.calls[0][1].aborted).toBe(true)
    await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    confirmation.resolve(true)
    await flush()
    expect(f.model.chat).not.toHaveBeenCalled()
    expect(f.materialize).not.toHaveBeenCalled()
    expect(f.model.cancelConversation).not.toHaveBeenCalled()
  })

  it('keeps pending-result ownership and cleanup admission separate from provider completion', async () => {
    const f = fixture()
    const result = requireOutput(await f.coordinator.generate(request(), f.context))
    const cleanup = deferred<void>()
    f.outputs[0].discard.mockReturnValue(cleanup.promise)
    await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    expect(f.coordinator.cancel(key(), f.owner)).toBe(true)
    await flush()
    expect(f.outputs[0].discard).toHaveBeenCalledTimes(1)
    expect(await f.coordinator.accept(accept(result), f.owner)).toBe(false)
    await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    cleanup.resolve(undefined)
    await flush()
    f.context.confirm.mockResolvedValue(false)
    expect(await f.coordinator.generate(request(2), f.context)).toBeNull()
    expect(f.outputs[0].discard).toHaveBeenCalledTimes(1)
  })

  it('does not recharge failed request IDs or expose arbitrary provider failure detail', async () => {
    const f = fixture()
    f.model.chat.mockRejectedValue(new Error('PRIVATE-PROVIDER-KEY https://secret.invalid'))
    const result = await observe(f.coordinator.generate(request(), f.context))
    expect(result).toMatchObject({ error: { code: 'UPSTREAM_FAILED' } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE-')
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
    expect(f.coordinator.state(key(), f.owner)?.error).toBe('UPSTREAM_FAILED')
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    await expect(
      f.coordinator.generate({ ...request(), prompt: 'Different' }, f.context)
    ).rejects.toMatchObject({ code: 'BUSY' })
    expect(f.model.chat).toHaveBeenCalledTimes(1)
    expect(f.materialize).not.toHaveBeenCalled()
  })

  it.each(['throw', 'reject'] as const)(
    'keeps abort ownership when best-effort cancellation can %s',
    async (failure) => {
      const f = fixture()
      const provider = deferred<LLMChatResp>()
      f.model.chat.mockReturnValue(provider.promise)
      if (failure === 'throw')
        f.model.cancelConversation.mockImplementation(() => {
          throw new Error('PRIVATE-CANCEL')
        })
      else f.model.cancelConversation.mockRejectedValue(new Error('PRIVATE-CANCEL'))
      const running = observe(f.coordinator.generate(request(), f.context))
      await flush()
      expect(f.coordinator.cancel(key(), f.owner)).toBe(true)
      expect(await running).toMatchObject({ error: { code: 'CANCELLED' } })
      await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
        code: 'BUSY'
      })
      provider.resolve(response())
      await flush()
      expect(f.materialize).not.toHaveBeenCalled()
    }
  )
})

describe('exact output acceptance and retained-result ownership', () => {
  it('binds acceptance and status/cancellation to the exact owner, target, request, job, result and hash', async () => {
    const f = fixture()
    const result = requireOutput(await f.coordinator.generate(request(), f.context))
    const exact = accept(result)
    expect(f.coordinator.state(key(), {})).toBeNull()
    expect(f.coordinator.cancel(key(), {})).toBe(false)
    expect(await f.coordinator.accept(exact, {})).toBe(false)
    for (const patch of [
      { sessionId: 'b'.repeat(32) },
      { pluginId: 'foreign.figma' },
      { projectId: 'foreign-project' },
      { requestId: 'c'.repeat(32) },
      { jobId: 'd'.repeat(32) },
      { resultId: 'e'.repeat(32) },
      { sha256: 'a'.repeat(64) }
    ])
      expect(await f.coordinator.accept({ ...exact, ...patch }, f.owner)).toBe(false)
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'awaiting-acceptance')
    expect(f.outputs[0].discard).not.toHaveBeenCalled()
    expect(await f.coordinator.accept(exact, f.owner)).toBe(true)
    expect(await f.coordinator.accept(exact, f.owner)).toBe(true)
    expect(await f.coordinator.accept({ ...exact, sha256: 'a'.repeat(64) }, f.owner)).toBe(false)
    expect(await f.coordinator.accept(exact, {})).toBe(false)
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    expect(f.model.chat).toHaveBeenCalledTimes(1)
  })

  it('does not let mutation of the returned object rewrite its retained acceptance identity', async () => {
    const f = fixture()
    const result = requireOutput(await f.coordinator.generate(request(), f.context))
    const exact = accept(result)
    result.reference.sha256 = 'a'.repeat(64)
    result.resultId = 'b'.repeat(32)
    result.localMediaUrl = 'https://example.invalid/PRIVATE-MUTATION'
    expect(await f.coordinator.accept(accept(result), f.owner)).toBe(false)
    expect(await f.coordinator.accept(exact, f.owner)).toBe(true)
    expect(f.outputs[0].discard).not.toHaveBeenCalled()
  })

  it('rechecks authority after asynchronous acceptance validation and rolls back instead of accepting stale output', async () => {
    const f = fixture()
    const result = requireOutput(await f.coordinator.generate(request(), f.context))
    const validation = deferred<void>()
    f.context.validate.mockReturnValueOnce(validation.promise)
    const accepting = f.coordinator.accept(accept(result), f.owner)
    await flush()
    f.setCurrent(false)
    validation.resolve(undefined)
    expect(await accepting).toBe(false)
    await flush()
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
    expect(f.coordinator.state(key(), f.owner)?.error).toBe('CONFIGURATION_CHANGED')
    expect(f.outputs[0].discard).toHaveBeenCalledTimes(1)
  })

  it('never deletes an accepted app result on cancel, configuration change, expiry or disposal', async () => {
    const f = fixture()
    const result = requireOutput(await f.coordinator.generate(request(), f.context))
    const exact = accept(result)
    expect(await f.coordinator.accept(exact, f.owner)).toBe(true)
    expect(f.coordinator.cancel(key(), f.owner)).toBe(false)
    f.coordinator.cancelPlugin(target.pluginId)
    f.coordinator.cancelAll()
    f.notifyConfigurationChanged()
    f.setCurrent(false)
    f.setRevisionCurrent(false)
    f.failAuthority()
    await vi.advanceTimersByTimeAsync(FIGPLUGIN_IMAGE_GENERATION_MAX_MS + 1)
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'accepted')
    expect(await f.coordinator.accept(exact, f.owner)).toBe(true)
    f.coordinator.dispose()
    await flush()
    expect(f.outputs[0].discard).not.toHaveBeenCalled()
    expect(f.model.cancelConversation).not.toHaveBeenCalled()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it.each([
    'cancel',
    'plugin',
    'all',
    'configuration',
    'revision',
    'selection',
    'authority',
    'dispose'
  ] as const)('discards a still-pending output exactly once on %s invalidation', async (reason) => {
    const f = fixture()
    const result = requireOutput(await f.coordinator.generate(request(), f.context))
    if (reason === 'cancel') f.coordinator.cancel(key(), f.owner)
    if (reason === 'plugin') f.coordinator.cancelPlugin(target.pluginId)
    if (reason === 'all') f.coordinator.cancelAll()
    if (reason === 'configuration') f.notifyConfigurationChanged()
    if (reason === 'revision') f.setRevisionCurrent(false)
    if (reason === 'selection') f.setCurrent(false)
    if (reason === 'authority') f.failAuthority()
    if (reason === 'dispose') f.coordinator.dispose()
    if (['revision', 'selection', 'authority'].includes(reason))
      await vi.advanceTimersByTimeAsync(250)
    await flush()
    expect(f.outputs[0].discard).toHaveBeenCalledTimes(1)
    expect(await f.coordinator.accept(accept(result), f.owner)).toBe(false)
    assertSanitizedState(
      f.coordinator.state(key(), f.owner),
      reason === 'cancel' ? 'cancelled' : 'failed'
    )
    f.coordinator.cancelAll()
    await flush()
    expect(f.outputs[0].discard).toHaveBeenCalledTimes(1)
  })

  it('ignores another plugin revocation and never accepts an image before materialization completes', async () => {
    const f = fixture()
    const provider = deferred<LLMChatResp>()
    f.model.chat.mockReturnValue(provider.promise)
    const running = observe(f.coordinator.generate(request(), f.context))
    await flush()
    f.coordinator.cancelPlugin('foreign.figma')
    const snapshot = f.coordinator.state(key(), f.owner)!
    assertSanitizedState(snapshot, 'generating')
    expect(
      await f.coordinator.accept(
        { ...key(), jobId: snapshot.jobId, resultId: 'd'.repeat(32), sha256: SHA256 },
        f.owner
      )
    ).toBe(false)
    expect(f.model.chat.mock.calls[0][1]?.signal?.aborted).toBe(false)
    provider.resolve(response())
    const result = await running
    expect(result).toHaveProperty('value')
  })
})

describe('generation deadline, session bounds and invalidation', () => {
  it.each([
    ['fixed generation budget', 600_000, 600_000, 120_000],
    ['session expiry', 30_000, 120_000, 30_000],
    ['selected asset authority expiry', 120_000, 25_000, 25_000]
  ] as const)(
    'uses the earliest %s without releasing an abort-ignoring provider',
    async (_name, sessionMs, selectionMs, deadlineMs) => {
      const f = fixture()
      f.context.sessionExpiresAt = NOW + sessionMs
      f.select({ ...selection(), expiresAt: NOW + selectionMs })
      const provider = deferred<LLMChatResp>()
      f.model.chat.mockReturnValue(provider.promise)
      const running = observe(f.coordinator.generate(request(), f.context))
      await flush()
      expect(f.coordinator.state(key(), f.owner)?.expiresAt).toBe(NOW + deadlineMs)
      await vi.advanceTimersByTimeAsync(deadlineMs - 1)
      expect(f.model.chat.mock.calls[0][1]?.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await running).toMatchObject({ error: { code: 'TIMEOUT' } })
      expect(f.model.chat.mock.calls[0][1]?.signal?.aborted).toBe(true)
      assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
      await expect(f.coordinator.generate(request(2), f.context)).rejects.toMatchObject({
        code: 'BUSY'
      })
      provider.resolve(response())
      await flush()
      expect(f.materialize).not.toHaveBeenCalled()
    }
  )

  it.each([NOW, NOW - 1, NOW + 600_001, NOW + 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid session expiry %j before allocating model or native consent',
    async (sessionExpiresAt) => {
      const f = fixture()
      f.context.sessionExpiresAt = sessionExpiresAt
      await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
        code: 'EXPIRED'
      })
      expect(f.configuredProfile).not.toHaveBeenCalled()
      expect(f.makeModel).not.toHaveBeenCalled()
      expect(f.context.confirm).not.toHaveBeenCalled()
      expect(f.model.chat).not.toHaveBeenCalled()
      expect(f.coordinator.state(key(), f.owner)).toBeNull()
    }
  )

  it.each([
    { target: { ...target, sessionId: 'b'.repeat(32) } },
    { target: { ...target, pluginId: 'foreign.figma' } },
    { target: { ...target, projectId: 'foreign_project' } },
    { maxBytes: 0 },
    { maxBytes: 1.5 },
    { maxBytes: FIGPLUGIN_ASSET_MAX_BYTES + 1 },
    { expiresAt: NOW },
    { expiresAt: NOW - 1 },
    { expiresAt: NOW + 0.5 },
    { expiresAt: NaN },
    { expiresAt: Infinity }
  ])(
    'refuses invalid selected target/limits %j with valid sanitized failed state',
    async (patch) => {
      const f = fixture()
      f.select({ ...selection(), ...patch })
      await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
        code: 'INVALID_REQUEST'
      })
      expect(f.makeModel).not.toHaveBeenCalled()
      expect(f.context.confirm).not.toHaveBeenCalled()
      expect(f.model.chat).not.toHaveBeenCalled()
      assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
    }
  )

  it('invalidates configuration during native consent and rejects a later approval before charging', async () => {
    const f = fixture()
    const confirmation = deferred<boolean>()
    f.context.confirm.mockReturnValue(confirmation.promise)
    const running = observe(f.coordinator.generate(request(), f.context))
    await flush()
    f.notifyConfigurationChanged()
    expect(await running).toMatchObject({ error: { code: 'CONFIGURATION_CHANGED' } })
    confirmation.resolve(true)
    await flush()
    expect(f.model.chat).not.toHaveBeenCalled()
    expect(f.materialize).not.toHaveBeenCalled()
  })

  it('checks authority after provider completion before materialization and sanitizes arbitrary failures', async () => {
    const f = fixture()
    const provider = deferred<LLMChatResp>()
    f.model.chat.mockReturnValue(provider.promise)
    const running = observe(f.coordinator.generate(request(), f.context))
    await flush()
    f.failAuthority(new Error('PRIVATE-WINDOW-DETAIL https://private.invalid'))
    provider.resolve(response())
    expect(await running).toMatchObject({ error: { code: 'UPSTREAM_FAILED' } })
    expect(f.materialize).not.toHaveBeenCalled()
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
  })

  it('rolls back a late materializer result after configuration invalidation instead of offering acceptance', async () => {
    const f = fixture()
    const materialization = deferred<MaterializedProviderImageOutput>()
    f.materialize.mockReturnValue(materialization.promise)
    const running = observe(f.coordinator.generate(request(), f.context))
    await flush()
    const late = syntheticOutput(f.materialize.mock.calls[0][1].runId)
    f.notifyConfigurationChanged()
    expect(await running).toMatchObject({ error: { code: 'CONFIGURATION_CHANGED' } })
    materialization.resolve(late)
    await flush()
    expect(late.discard).toHaveBeenCalledTimes(1)
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
  })

  it('expires an unaccepted output and retains replay tombstones only through the bounded session lifetime', async () => {
    const f = fixture()
    const result = requireOutput(await f.coordinator.generate(request(), f.context))
    await vi.advanceTimersByTimeAsync(FIGPLUGIN_IMAGE_GENERATION_MAX_MS)
    expect(f.outputs[0].discard).toHaveBeenCalledTimes(1)
    expect(await f.coordinator.accept(accept(result), f.owner)).toBe(false)
    assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    await vi.advanceTimersByTimeAsync(600_000 - FIGPLUGIN_IMAGE_GENERATION_MAX_MS)
    expect(f.coordinator.state(key(), f.owner)).toBeNull()
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'EXPIRED'
    })
    expect(f.model.chat).toHaveBeenCalledTimes(1)
  })

  it('bounds replay records without evicting unexpired request identities', async () => {
    const f = fixture()
    f.context.confirm.mockResolvedValue(false)
    for (let seed = 1; seed <= 64; seed += 1)
      expect(await f.coordinator.generate(request(seed), f.context)).toBeNull()
    await expect(f.coordinator.generate(request(65), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    expect(f.context.confirm).toHaveBeenCalledTimes(64)
    expect(f.model.chat).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(f.coordinator.state(key(), f.owner)).toBeNull()
    f.context.sessionExpiresAt = Date.now() + 120_000
    f.select({ ...selection(), expiresAt: Date.now() + 120_000 })
    expect(await f.coordinator.generate(request(65), f.context)).toBeNull()
    expect(f.context.confirm).toHaveBeenCalledTimes(65)
  })

  it('disposes a lazy coordinator without creating a model and refuses future work', async () => {
    const f = fixture()
    f.coordinator.dispose()
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    expect(f.makeModel).not.toHaveBeenCalled()
    expect(f.configuredProfile).not.toHaveBeenCalled()
    expect(f.context.confirm).not.toHaveBeenCalled()
    expect(f.materialize).not.toHaveBeenCalled()
  })
})

describe('coordinator defense against an invalid materializer result', () => {
  it.each([
    'foreign-run',
    'session-byte-limit',
    'mismatched-local-url',
    'oversized-image'
  ] as const)(
    'rejects and rolls back %s rather than returning a durable image',
    async (invalid) => {
      const f = fixture()
      let materialized: ReturnType<typeof syntheticOutput> | undefined
      f.materialize.mockImplementation(async (_value, options) => {
        materialized = syntheticOutput(invalid === 'foreign-run' ? 'foreign' : options.runId)
        if (invalid === 'session-byte-limit')
          materialized.reference.sizeBytes = options.maxBytes + 1
        if (invalid === 'mismatched-local-url')
          materialized.localMediaUrl = 'local-media:///synthetic/other.png'
        if (invalid === 'oversized-image') materialized.width = 4097
        return materialized
      })
      const result = await observe(f.coordinator.generate(request(), f.context))
      expect(result).toMatchObject({
        error: {
          code:
            invalid === 'foreign-run' || invalid === 'session-byte-limit'
              ? 'INVALID_REQUEST'
              : 'UPSTREAM_FAILED'
        }
      })
      await flush()
      expect(materialized!.discard).toHaveBeenCalledTimes(1)
      assertSanitizedState(f.coordinator.state(key(), f.owner), 'failed')
      await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
        code: 'BUSY'
      })
      expect(f.model.chat).toHaveBeenCalledTimes(1)
    }
  )
})

describe('main-only native proposal observation and deadline', () => {
  it('clears admission timers when the main observer synchronously cancels the new job', async () => {
    const f = fixture()
    await expect(
      f.coordinator.generate(request(), {
        ...f.context,
        onState: (state) => {
          if (state.phase === 'preparing') f.coordinator.cancel(key(), f.owner)
        }
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(f.makeModel).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('observes the actual immutable job from admission through acceptance without content', async () => {
    const f = fixture()
    const states: Readonly<FigPluginImageGenerationState>[] = []
    const output = requireOutput(
      await f.coordinator.generate(request(), {
        ...f.context,
        onState: (state) => states.push(state)
      })
    )
    expect(states.map((state) => state.phase)).toEqual([
      'preparing',
      'awaiting-approval',
      'generating',
      'materializing',
      'awaiting-acceptance'
    ])
    expect(await f.coordinator.accept(accept(output), f.owner)).toBe(true)
    expect(states.at(-1)?.phase).toBe('accepted')
    for (const state of states) {
      expect(Object.isFrozen(state)).toBe(true)
      expect(state).toMatchObject({ ...key(), jobId: output.jobId })
      expect(JSON.stringify(state)).not.toContain('PRIVATE-')
      expect(state).not.toHaveProperty('reference')
    }
  })

  it('reports cancellation with its error in the same terminal observation', async () => {
    const f = fixture()
    const pendingProvider = deferred<LLMChatResp>()
    f.model.chat.mockImplementationOnce(() => pendingProvider.promise)
    const onState = vi.fn()
    const pending = observe(f.coordinator.generate(request(), { ...f.context, onState }))
    await flush()
    expect(f.coordinator.cancel(key(), f.owner)).toBe(true)
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'cancelled', error: 'CANCELLED' })
    )
    expect(await pending).toMatchObject({ error: { code: 'CANCELLED' } })
    pendingProvider.resolve(response())
    await flush()
    expect(f.materialize).not.toHaveBeenCalled()
  })

  it('keeps the original session replay tombstone beyond a narrower proposal deadline', async () => {
    const f = fixture()
    const output = requireOutput(
      await f.coordinator.generate(request(), {
        ...f.context,
        deadlineAt: NOW + 100
      })
    )
    expect(output.expiresAt).toBe(NOW + 100)
    await vi.advanceTimersByTimeAsync(101)
    expect(f.coordinator.state(key(), f.owner)).toMatchObject({ phase: 'failed', error: 'TIMEOUT' })
    expect(await f.coordinator.accept(accept(output), f.owner)).toBe(false)
    await expect(f.coordinator.generate(request(), f.context)).rejects.toMatchObject({
      code: 'BUSY'
    })
    expect(f.model.chat).toHaveBeenCalledTimes(1)
    expect(f.outputs[0].discard).toHaveBeenCalledTimes(1)
  })

  it.each([NOW, NOW - 1, NOW + 600_001, Infinity, NOW + 1.5])(
    'rejects invalid main deadline %s before model admission',
    async (deadlineAt) => {
      const f = fixture()
      await expect(
        f.coordinator.generate(request(), { ...f.context, deadlineAt })
      ).rejects.toMatchObject({ code: 'EXPIRED' })
      expect(f.makeModel).not.toHaveBeenCalled()
      expect(f.model.chat).not.toHaveBeenCalled()
    }
  )

  it('does not let an observational failure interrupt cancellation or transfer ownership', async () => {
    const f = fixture()
    const output = requireOutput(
      await f.coordinator.generate(request(), {
        ...f.context,
        onState: () => {
          throw new Error('Broken main-only projection')
        }
      })
    )
    expect(await f.coordinator.accept(accept(output), f.owner)).toBe(true)
    expect(f.coordinator.cancel(key(), f.owner)).toBe(false)
    expect(f.outputs[0].discard).not.toHaveBeenCalled()
  })
})
