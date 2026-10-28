import { randomBytes, randomUUID } from 'node:crypto'
import type { LLMListProfilesResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
import {
  FigPluginBridgeError,
  figPluginBridgeHashSchema,
  type FigPluginBridgeErrorCode
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_IMAGE_GENERATION_MAX_MS,
  FIGPLUGIN_IMAGE_GENERATION_OPTIONS,
  figPluginImageGenerationOutputSchema,
  figPluginImageGenerationStateSchema,
  supportsFigPluginImageGenerationProfile,
  type FigPluginImageGenerationAccept,
  type FigPluginImageGenerationKey,
  type FigPluginImageGenerationOutput,
  type FigPluginImageGenerationRequest,
  type FigPluginImageGenerationState
} from '@shared/figplugin/imageGeneration'
import { FIGPLUGIN_ASSET_MAX_BYTES } from '@shared/figplugin/hostAssets'
import type { FigPluginAssetSelection } from './bridgeRuntime'
import type {
  MaterializedProviderImageOutput,
  ProviderImageOutputMaterializer
} from './providerImageOutput'

export type FigPluginImageGenerationModel = Pick<
  LLMProxySvc,
  'listProfiles' | 'chat' | 'cancelConversation'
> & {
  isProfileRevisionCurrent: (id: string, revision: string) => boolean
  onProfileConfigurationChanged: (listener: () => void) => () => void
}
export type FigPluginImageGenerationConsent = FigPluginImageGenerationRequest & {
  jobId: string
  profileId: string
  profileRevision: string
  modelName: string
  provider: string
  apiMode: string
  selection: FigPluginAssetSelection
  expiresAt: number
}
export type FigPluginImageGenerationContext = {
  owner: object
  /** Main-observed session lifetime; tombstones outlive the generation deadline. */
  sessionExpiresAt: number
  deadlineAt?: number
  /** Main-only observation; this callback cannot grant execution or output ownership. */
  onState?: (state: Readonly<FigPluginImageGenerationState>) => void
  check: () => void
  capture: () => Promise<FigPluginAssetSelection>
  isCurrent: (selection: FigPluginAssetSelection) => boolean
  validate: (selection: FigPluginAssetSelection) => Promise<void>
  confirm: (preview: FigPluginImageGenerationConsent, signal: AbortSignal) => Promise<boolean>
}
type Dependencies = {
  makeModel: () => Promise<FigPluginImageGenerationModel>
  configuredProfile: (key: FigPluginImageGenerationKey) => Promise<string>
  materialize: ProviderImageOutputMaterializer
}
type Job = {
  key: FigPluginImageGenerationKey
  owner: object
  context?: FigPluginImageGenerationContext
  state: FigPluginImageGenerationState
  sessionExpiresAt: number
  abort: AbortController
  stop: Promise<never>
  rejectStop: (error: FigPluginBridgeError) => void
  stopped?: FigPluginBridgeErrorCode
  selection?: FigPluginAssetSelection
  model?: FigPluginImageGenerationModel
  profileId?: string
  profileRevision?: string
  conversationId: string
  cancellationId: string
  dispatched: boolean
  settled: boolean
  cleanup?: Promise<void>
  materialized?: MaterializedProviderImageOutput
  output?: FigPluginImageGenerationOutput
  accepted?: { jobId: string; resultId: string; sha256: string }
  timer?: ReturnType<typeof setTimeout>
  guard?: ReturnType<typeof setInterval>
}
const keyOf = (key: FigPluginImageGenerationKey): string =>
  JSON.stringify([key.sessionId, key.pluginId, key.projectId, key.requestId])
const errorCode = (error: unknown): FigPluginBridgeErrorCode =>
  error instanceof FigPluginBridgeError ? error.code : 'UPSTREAM_FAILED'
const terminal = (phase: FigPluginImageGenerationState['phase']): boolean =>
  ['accepted', 'declined', 'cancelled', 'failed'].includes(phase)
const id = (): string => randomBytes(16).toString('hex')
const MAX_JOBS = 64
const MAX_SESSION_LIFETIME_MS = 10 * 60_000

/** Desktop-only operation ownership. This class cannot publish assets or authorize host writes. */
export class FigPluginImageGenerationCoordinator {
  private readonly jobs = new Map<string, Job>()
  private modelPending?: Promise<FigPluginImageGenerationModel>
  private unsubscribeModel?: () => void
  private closed = false

  constructor(private readonly deps: Dependencies) {}

  async generate(
    request: FigPluginImageGenerationRequest,
    context: FigPluginImageGenerationContext
  ): Promise<FigPluginImageGenerationOutput | null> {
    if (this.closed) throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    context.check()
    this.prune()
    // Reusing a request ID never dispatches a second charged call, even after failure/cancel.
    if (this.jobs.has(keyOf(request))) throw new FigPluginBridgeError('BUSY')
    if (
      this.jobs.size >= MAX_JOBS ||
      [...this.jobs.values()].some(
        (job) => !job.settled || job.cleanup || job.state.phase === 'awaiting-acceptance'
      )
    )
      throw new FigPluginBridgeError('BUSY')
    const now = Date.now()
    if (
      !Number.isSafeInteger(context.sessionExpiresAt) ||
      context.sessionExpiresAt <= now ||
      context.sessionExpiresAt > now + MAX_SESSION_LIFETIME_MS ||
      (context.deadlineAt !== undefined &&
        (!Number.isSafeInteger(context.deadlineAt) ||
          context.deadlineAt <= now ||
          context.deadlineAt > context.sessionExpiresAt))
    )
      throw new FigPluginBridgeError('EXPIRED')
    const key: FigPluginImageGenerationKey = {
      sessionId: request.sessionId,
      pluginId: request.pluginId,
      projectId: request.projectId,
      requestId: request.requestId
    }
    let rejectStop!: Job['rejectStop']
    const stop = new Promise<never>((_resolve, reject) => {
      rejectStop = reject
    })
    void stop.catch(() => undefined)
    const runId = randomUUID()
    const job: Job = {
      key,
      owner: context.owner,
      context,
      state: {
        ...key,
        jobId: id(),
        phase: 'preparing',
        createdAt: now,
        updatedAt: now,
        expiresAt: Math.min(
          now + FIGPLUGIN_IMAGE_GENERATION_MAX_MS,
          context.sessionExpiresAt,
          context.deadlineAt ?? context.sessionExpiresAt
        )
      },
      sessionExpiresAt: context.sessionExpiresAt,
      abort: new AbortController(),
      stop,
      rejectStop,
      conversationId: `figplugin-image-${randomUUID()}`,
      cancellationId: randomUUID(),
      dispatched: false,
      settled: false
    }
    this.jobs.set(keyOf(key), job)
    this.scheduleDeadline(job)
    job.guard = setInterval(() => {
      try {
        this.check(job)
      } catch (error) {
        this.stopJob(job, errorCode(error))
      }
    }, 250)
    job.guard.unref()
    this.observe(job)
    const work = this.run(job, request.prompt, runId)
      .catch((error: unknown) => {
        this.stopJob(job, errorCode(error))
        throw new FigPluginBridgeError(job.stopped ?? errorCode(error))
      })
      .finally(async () => {
        if (job.stopped) await this.discard(job)
        // A race returning to IPC does not release admission while Provider work ignores abort.
        job.settled = true
        if (terminal(job.state.phase)) job.context = undefined
        this.prune()
      })
    const output = await Promise.race([work, stop])
    if (output) {
      try {
        this.check(job)
      } catch (error) {
        this.stopJob(job, errorCode(error))
        throw new FigPluginBridgeError(errorCode(error))
      }
    }
    return output
  }

  state(key: FigPluginImageGenerationKey, owner: object): FigPluginImageGenerationState | null {
    this.prune()
    const job = this.jobs.get(keyOf(key))
    if (!job || job.owner !== owner) return null
    if (!terminal(job.state.phase)) {
      try {
        this.check(job)
      } catch (error) {
        this.stopJob(job, errorCode(error))
      }
    }
    return figPluginImageGenerationStateSchema.parse(job.state)
  }

  cancel(key: FigPluginImageGenerationKey, owner: object): boolean {
    const job = this.jobs.get(keyOf(key))
    return !!job && job.owner === owner && this.stopJob(job, 'CANCELLED')
  }

  async accept(request: FigPluginImageGenerationAccept, owner: object): Promise<boolean> {
    const job = this.jobs.get(keyOf(request))
    if (!job || job.owner !== owner) return false
    const exact = (value: { jobId: string; resultId: string; sha256: string }) =>
      value.jobId === request.jobId &&
      value.resultId === request.resultId &&
      value.sha256 === request.sha256
    if (job.accepted) return exact(job.accepted)
    const output = job.output
    if (
      job.state.phase !== 'awaiting-acceptance' ||
      !output ||
      !exact({ ...output, sha256: output.reference.sha256 })
    )
      return false
    try {
      this.check(job)
      await job.context!.validate(job.selection!)
      this.check(job)
      if (job.output !== output || job.state.phase !== 'awaiting-acceptance') return false
      // Ownership transfers synchronously after the final authority check. Future cancel
      // may invalidate a session, but cannot delete an already accepted app result.
      job.accepted = {
        jobId: output.jobId,
        resultId: output.resultId,
        sha256: output.reference.sha256
      }
      job.materialized = undefined
      job.output = undefined
      this.phase(job, 'accepted')
      this.clearTimers(job)
      job.context = undefined
      return true
    } catch (error) {
      this.stopJob(job, errorCode(error))
      return false
    }
  }

  cancelPlugin(pluginId: string): void {
    for (const job of this.jobs.values())
      if (job.key.pluginId === pluginId) this.stopJob(job, 'CONFIGURATION_CHANGED')
  }

  cancelAll(code: FigPluginBridgeErrorCode = 'CONFIGURATION_CHANGED'): void {
    for (const job of this.jobs.values()) this.stopJob(job, code)
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.cancelAll()
    const unsubscribe = this.unsubscribeModel
    this.unsubscribeModel = undefined
    try {
      unsubscribe?.()
    } catch {
      // A failed subscription detach must not skip already-owned output cleanup.
    }
    await Promise.all([...this.jobs.values()].map((job) => job.cleanup))
  }

  private async model(): Promise<FigPluginImageGenerationModel> {
    this.modelPending ??= this.deps.makeModel().then((model) => {
      if (this.closed) throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      const unsubscribe = model.onProfileConfigurationChanged(() => this.cancelAll())
      if (typeof unsubscribe !== 'function') throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      this.unsubscribeModel = unsubscribe
      return model
    })
    return this.modelPending
  }

  private async run(
    job: Job,
    prompt: string,
    runId: string
  ): Promise<FigPluginImageGenerationOutput | null> {
    this.check(job)
    const context = job.context!
    const profileId = await this.deps.configuredProfile(job.key)
    this.check(job)
    job.selection = await context.capture()
    this.check(job)
    if (
      keyOf({ ...job.selection.target, requestId: job.key.requestId }) !== keyOf(job.key) ||
      !Number.isSafeInteger(job.selection.maxBytes) ||
      job.selection.maxBytes < 1 ||
      job.selection.maxBytes > FIGPLUGIN_ASSET_MAX_BYTES ||
      !Number.isSafeInteger(job.selection.expiresAt) ||
      job.selection.expiresAt <= Date.now()
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    job.state.expiresAt = Math.min(job.state.expiresAt, job.selection.expiresAt)
    this.scheduleDeadline(job)
    this.check(job)
    const model = await this.model()
    this.check(job)
    job.model = model
    const metadata = await model.listProfiles({
      comparisonRouting: 'configured',
      includeConfigurationRevision: true
    })
    this.check(job)
    const matches = metadata.profiles.filter((profile) => profile.id === profileId)
    const profile: LLMListProfilesResp['profiles'][number] | undefined = matches[0]
    if (
      metadata.comparisonDestination?.kind === 'remote' ||
      matches.length !== 1 ||
      !profile ||
      !supportsFigPluginImageGenerationProfile(profile) ||
      !figPluginBridgeHashSchema.safeParse(profile.configurationRevision).success
    )
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    job.profileId = profileId
    job.profileRevision = profile.configurationRevision!
    await context.validate(job.selection)
    this.check(job)
    this.phase(job, 'awaiting-approval')
    const approved = await context.confirm(
      {
        ...job.key,
        prompt,
        jobId: job.state.jobId,
        profileId,
        profileRevision: job.profileRevision,
        modelName: profile.model_name,
        provider: profile.provider!,
        apiMode: profile.api_mode!,
        selection: job.selection,
        expiresAt: job.state.expiresAt
      },
      job.abort.signal
    )
    this.check(job)
    if (!approved) {
      this.phase(job, 'declined')
      this.clearTimers(job)
      return null
    }
    await context.validate(job.selection)
    this.check(job)
    this.phase(job, 'generating')
    job.dispatched = true
    const response = await model.chat(
      {
        messages: [{ role: 'user', content: prompt }],
        profileId,
        expectedProfileRevision: job.profileRevision,
        comparisonRouting: 'configured',
        conversationId: job.conversationId,
        cancellationId: job.cancellationId,
        correlationId: randomUUID(),
        imageGenerationOptions: { ...FIGPLUGIN_IMAGE_GENERATION_OPTIONS }
      },
      { signal: job.abort.signal }
    )
    this.check(job)
    await context.validate(job.selection)
    this.check(job)
    this.phase(job, 'materializing')
    const materialized = await this.deps.materialize(response, {
      runId,
      check: () => this.check(job),
      signal: job.abort.signal,
      maxBytes: job.selection.maxBytes,
      deadlineAt: job.state.expiresAt
    })
    job.materialized = materialized
    this.check(job)
    await context.validate(job.selection)
    this.check(job)
    const output = figPluginImageGenerationOutputSchema.parse({
      ...job.key,
      jobId: job.state.jobId,
      resultId: id(),
      profileId,
      profileRevision: job.profileRevision,
      createdAt: job.state.createdAt,
      expiresAt: job.state.expiresAt,
      reference: materialized.reference,
      localMediaUrl: materialized.localMediaUrl,
      width: materialized.width,
      height: materialized.height
    })
    if (
      !output.reference.relativePath.startsWith(`user-output/figplugin-${runId}/`) ||
      output.reference.sizeBytes > job.selection.maxBytes
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    job.output = structuredClone(output)
    this.phase(job, 'awaiting-acceptance')
    return output
  }

  private check(job: Job): void {
    if (job.stopped) throw new FigPluginBridgeError(job.stopped)
    if (this.closed || !job.context) throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    if (Date.now() >= job.state.expiresAt) throw new FigPluginBridgeError('TIMEOUT')
    job.context.check()
    if (job.selection && !job.context.isCurrent(job.selection))
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    if (
      job.profileId &&
      job.profileRevision &&
      job.model?.isProfileRevisionCurrent(job.profileId, job.profileRevision) !== true
    )
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
  }

  private phase(job: Job, phase: FigPluginImageGenerationState['phase']): void {
    job.state = { ...job.state, phase, updatedAt: Math.max(Date.now(), job.state.createdAt) }
    this.observe(job)
  }

  private observe(job: Job): void {
    try {
      job.context?.onState?.(Object.freeze({ ...job.state }))
    } catch {
      // Authority is checked separately before dispatch/acceptance; an observer
      // failure must not interrupt cancellation or accepted-output ownership.
    }
  }

  private stopJob(job: Job, code: FigPluginBridgeErrorCode): boolean {
    if (terminal(job.state.phase)) return false
    job.stopped = code
    job.state.error = code
    this.phase(job, code === 'CANCELLED' ? 'cancelled' : 'failed')
    this.clearTimers(job)
    job.abort.abort()
    if (job.dispatched) {
      try {
        void job.model
          ?.cancelConversation({
            conversationId: job.conversationId,
            cancellationId: job.cancellationId
          })
          .catch(() => undefined)
      } catch {
        // Cancellation is best effort; admission stays held until actual work settles.
      }
    }
    void this.discard(job)
    job.rejectStop(new FigPluginBridgeError(code))
    if (job.settled) job.context = undefined
    return true
  }

  private discard(job: Job): Promise<void> {
    if (job.cleanup) return job.cleanup
    const materialized = job.materialized
    job.materialized = undefined
    job.output = undefined
    if (!materialized) return Promise.resolve()
    const cleanup = Promise.resolve()
      .then(() => materialized.discard())
      .catch(() => undefined)
    job.cleanup = cleanup
    void cleanup.finally(() => {
      if (job.cleanup === cleanup) job.cleanup = undefined
    })
    return cleanup
  }

  private clearTimers(job: Job): void {
    if (job.timer) clearTimeout(job.timer)
    if (job.guard) clearInterval(job.guard)
    job.timer = undefined
    job.guard = undefined
  }

  private scheduleDeadline(job: Job): void {
    if (job.timer) clearTimeout(job.timer)
    job.timer = setTimeout(
      () => this.stopJob(job, 'TIMEOUT'),
      Math.max(0, job.state.expiresAt - Date.now())
    )
    job.timer.unref()
  }

  private prune(): void {
    for (const [key, job] of this.jobs) {
      if (
        job.settled &&
        !job.cleanup &&
        terminal(job.state.phase) &&
        job.sessionExpiresAt <= Date.now()
      ) {
        this.clearTimers(job)
        this.jobs.delete(key)
      }
    }
  }
}
