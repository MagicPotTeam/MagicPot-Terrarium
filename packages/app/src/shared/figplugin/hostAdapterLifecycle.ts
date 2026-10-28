import { z } from 'zod'
import {
  hostContextSchema,
  hostExecutionCapabilitySchema,
  hostPlanSchema,
  validateHostPlanExecution,
  validateHostPlanReadback,
  normalizeHostPlan,
  type HostContext,
  type HostPlan,
  type HostPlanReadback
} from './hostPlan'
import {
  assertHostPlanCompatibility,
  FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION
} from './hostCompatibility'
import {
  figPluginPlanningAssetMetadataSchema,
  type FigPluginPlanningAssetMetadata
} from './hostPlanningAssets'
import {
  validateRecoveryExecutionImages,
  type FigPluginRecoveryExecutionImages
} from './hostImageRecovery'

/**
 * The common lifecycle used by native host adapters. This module deliberately
 * contains no host globals, IPC, permissions, or file/network access. Native
 * adapters remain responsible for claiming a document and performing writes.
 */
export const hostAdapterLifecycleStageSchema = z.enum([
  'validating',
  'preparing',
  'executing',
  'readback',
  'terminal'
])
export type HostAdapterLifecycleStage = z.output<typeof hostAdapterLifecycleStageSchema>

export const hostAdapterLifecycleErrorCodeSchema = z.enum([
  'CANCELLED',
  'INVALID_PLAN',
  'CAPABILITY_DISCOVERY_FAILED',
  'PREPARE_FAILED',
  'EXECUTE_FAILED',
  'READBACK_FAILED',
  'CONCURRENT_RUN',
  'STALE_CONTEXT',
  'UNSUPPORTED_CONTEXT_PROTOCOL',
  'UNSUPPORTED_PLAN_SCHEMA',
  'ADAPTER_HOST_MISMATCH',
  'ADAPTER_VERSION_UNSUPPORTED',
  'CAPABILITY_MISSING'
])
export type HostAdapterLifecycleErrorCode = z.output<typeof hostAdapterLifecycleErrorCodeSchema>

/**
 * The bounded capability snapshot shared by all host adapters.  Capability
 * discovery is metadata only: it does not grant write authority or establish
 * a document claim.  The native adapter still has to expose the same
 * capability set in the captured context before a plan can execute.
 */
export const hostAdapterLifecycleCapabilitiesSchema = z
  .object({
    host: z.enum(['figma', 'photoshop']),
    execution: hostExecutionCapabilitySchema
  })
  .strict()
export type HostAdapterLifecycleCapabilities = z.output<
  typeof hostAdapterLifecycleCapabilitiesSchema
>

export const hostAdapterLifecycleStatusSchema = z.enum(['completed', 'cancelled', 'failed'])
export type HostAdapterLifecycleStatus = z.output<typeof hostAdapterLifecycleStatusSchema>

export const hostAdapterLifecycleProgressSchema = z
  .object({
    stage: hostAdapterLifecycleStageSchema,
    completed: z.number().int().min(0).max(100_000),
    total: z.number().int().min(0).max(100_000),
    timestamp: z.number().finite()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.completed > value.total)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Progress exceeds total' })
  })
export type HostAdapterLifecycleProgress = z.output<typeof hostAdapterLifecycleProgressSchema>

export const hostAdapterLifecycleErrorSchema = z
  .object({
    code: hostAdapterLifecycleErrorCodeSchema,
    retryable: z.boolean()
  })
  .strict()
export type HostAdapterLifecycleError = z.output<typeof hostAdapterLifecycleErrorSchema>

export const hostAdapterResourceCleanupSchema = z
  .object({
    status: z.enum(['not-required', 'completed', 'failed']),
    failureCount: z.number().int().min(0).max(257)
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === 'failed') !== value.failureCount > 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Resource cleanup status mismatch' })
  })
export type HostAdapterResourceCleanup = z.output<typeof hostAdapterResourceCleanupSchema>

export const hostAdapterLifecycleResultSchema = z
  .object({
    runId: z.string().min(1).max(128),
    status: hostAdapterLifecycleStatusSchema,
    stage: hostAdapterLifecycleStageSchema,
    progress: z.array(hostAdapterLifecycleProgressSchema).max(512),
    execution: z.unknown().optional(),
    readback: z.unknown().optional(),
    error: hostAdapterLifecycleErrorSchema.optional(),
    resourceCleanup: hostAdapterResourceCleanupSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.stage !== 'terminal')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Result must be terminal' })
    if (value.progress.length === 0 || value.progress.at(-1)?.stage !== 'terminal')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal progress is missing' })
    if (value.status === 'completed' && (value.error !== undefined || value.readback === undefined))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed result is incomplete' })
    if (value.status !== 'completed' && value.error === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Non-completed result needs an error' })
  })
export type HostAdapterLifecycleResult<TExecution = unknown> = Omit<
  z.output<typeof hostAdapterLifecycleResultSchema>,
  'execution' | 'readback'
> & {
  execution?: TExecution
  readback?: HostPlanReadback
}

export const hostAdapterLifecycleTransitionSchema = z
  .object({
    from: hostAdapterLifecycleStageSchema,
    to: hostAdapterLifecycleStageSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!canTransitionHostAdapterLifecycle(value.from, value.to))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid lifecycle transition' })
  })

// Keep the longer alias available for callers that prefer an explicit name.
export const hostAdapterLifecycleStageTransitionSchema = hostAdapterLifecycleTransitionSchema

const allowedTransitions: Record<HostAdapterLifecycleStage, readonly HostAdapterLifecycleStage[]> =
  {
    validating: ['validating', 'preparing', 'terminal'],
    preparing: ['preparing', 'executing', 'terminal'],
    executing: ['executing', 'readback', 'terminal'],
    readback: ['readback', 'terminal'],
    terminal: ['terminal']
  }

export function canTransitionHostAdapterLifecycle(
  from: HostAdapterLifecycleStage,
  to: HostAdapterLifecycleStage
): boolean {
  return allowedTransitions[from]?.includes(to) === true
}

const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const captureScopeSchema = z
  .array(z.string().min(1).max(128))
  .max(100)
  .superRefine((value, ctx) => {
    if (new Set(value).size !== value.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate capture scope ID' })
  })

export type HostAdapterLifecycleOptions<TResources = unknown, TExecution = unknown> = {
  host: HostContext['host']
  adapterVersion: string
  /** Maximum number of active runs this adapter may own at once. Native hosts default to one. */
  maxConcurrentRuns?: number
  /** Optional for legacy adapters; new adapters should expose this explicitly. */
  discoverCapabilities?: () => HostAdapterLifecycleCapabilities | unknown
  /**
   * Require capability discovery before validating or executing a plan. Keep
   * this disabled for legacy adapters that still rely on captured context
   * alone; native adapters should enable it so a missing descriptor fails
   * closed instead of silently bypassing capability negotiation.
   */
  requireCapabilityDiscovery?: boolean
  captureContext: (captureId: string, scope?: readonly string[]) => HostContext | unknown
  validatePlan?: (
    plan: HostPlan,
    context: HostContext,
    resources?: readonly FigPluginPlanningAssetMetadata[],
    imageRecovery?: FigPluginRecoveryExecutionImages
  ) => void
  prepareResources?: (args: {
    runId: string
    context: HostContext
    plan: HostPlan
    imageRecovery?: FigPluginRecoveryExecutionImages
    signal: AbortSignal
    /** Register ownership immediately, including before a later preparation step can fail. */
    deferRelease: (release: () => void | Promise<void>) => void
  }) => Promise<TResources> | TResources
  execute: (args: {
    runId: string
    context: HostContext
    plan: HostPlan
    imageRecovery?: FigPluginRecoveryExecutionImages
    resources?: TResources
    signal: AbortSignal
    onProgress?: (completed: number, total: number) => void
  }) => Promise<TExecution> | TExecution
  readback: (args: {
    runId: string
    context: HostContext
    plan: HostPlan
    imageRecovery?: FigPluginRecoveryExecutionImages
    execution: TExecution
    signal: AbortSignal
  }) => Promise<unknown> | unknown
  /** Advisory only. Native code still owns write cancellation and rollback. */
  cancel?: (runId: string, signal?: AbortSignal) => Promise<void> | void
  /** After native work, readback and cancellation settle; never a document rollback hook. */
  releaseResources?: (args: {
    runId: string
    resources?: TResources
    execution?: TExecution
    status: HostAdapterLifecycleStatus
  }) => Promise<void> | void
  /** Legacy callers retain opaque execution results by default; native adapters opt out. */
  retainExecution?: boolean
  now?: () => number
}

export type HostAdapterLifecycleRunInput = {
  runId: string
  plan: unknown
  context?: unknown
  resources?: readonly FigPluginPlanningAssetMetadata[]
  imageRecovery?: FigPluginRecoveryExecutionImages
  signal?: AbortSignal
}

export type HostAdapterLifecycleDiagnosticsRun = {
  runId: string
  status: HostAdapterLifecycleStatus | 'active'
  stage: HostAdapterLifecycleStage
  errorCode?: HostAdapterLifecycleErrorCode
  resourceCleanup?: HostAdapterResourceCleanup
}

export const hostAdapterLifecycleDiagnosticsSchema = z
  .object({
    activeRunIds: z.array(z.string().min(1).max(128)).max(256),
    activeCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    cancelledCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    runs: z
      .array(
        z
          .object({
            runId: z.string().min(1).max(128),
            status: z.enum(['active', 'completed', 'cancelled', 'failed']),
            stage: hostAdapterLifecycleStageSchema,
            errorCode: hostAdapterLifecycleErrorCodeSchema.optional(),
            resourceCleanup: hostAdapterResourceCleanupSchema.optional()
          })
          .strict()
      )
      .max(256)
  })
  .strict()
export type HostAdapterLifecycleDiagnostics = z.output<typeof hostAdapterLifecycleDiagnosticsSchema>

export type HostAdapterLifecycle<TResources = unknown, TExecution = unknown> = {
  /** Validate and return a bounded, host-scoped capability snapshot. */
  discoverCapabilities: () => HostAdapterLifecycleCapabilities
  captureContext: (captureId: string, scope?: readonly string[]) => HostContext
  validatePlan: (
    plan: unknown,
    context: unknown,
    resources?: readonly FigPluginPlanningAssetMetadata[],
    imageRecovery?: FigPluginRecoveryExecutionImages
  ) => HostPlan
  run: {
    (input: HostAdapterLifecycleRunInput): Promise<HostAdapterLifecycleResult<TExecution>>
    (
      runId: string,
      plan: unknown,
      context?: unknown,
      signal?: AbortSignal,
      resources?: readonly FigPluginPlanningAssetMetadata[],
      imageRecovery?: FigPluginRecoveryExecutionImages
    ): Promise<HostAdapterLifecycleResult<TExecution>>
  }
  /** Alias for integrations that model a lifecycle as an explicit start. */
  start: HostAdapterLifecycle<TResources, TExecution>['run']
  execute: HostAdapterLifecycle<TResources, TExecution>['run']
  cancel: (runId: string, signal?: AbortSignal) => Promise<boolean>
  diagnostics: () => HostAdapterLifecycleDiagnostics
  getResult: (runId: string) => HostAdapterLifecycleResult<TExecution> | undefined
}

type RunState<TResources, TExecution> = {
  runId: string
  controller?: AbortController
  status: 'active' | HostAdapterLifecycleStatus
  stage: HostAdapterLifecycleStage
  progress: HostAdapterLifecycleProgress[]
  plan?: HostPlan
  context?: HostContext
  cancellationRequested: boolean
  cancelCallbackPromise?: Promise<void>
  executionStarted: boolean
  executionCompleted: boolean
  preparationStarted: boolean
  finalizing: boolean
  releaseCallbacks: (() => void | Promise<void>)[]
  contextIdentity?: string
  pendingResult?: HostAdapterLifecycleResult<TExecution>
  result?: HostAdapterLifecycleResult<TExecution>
  resources?: TResources
  execution?: TExecution
  createdAt: number
}

const MAX_RETAINED_RUNS = 256
const MAX_RESOURCE_RELEASE_CALLBACKS = 256
// Run IDs are normally random and only need a bounded tombstone window to
// prevent an in-flight/just-completed replay. Keeping every historical ID
// forever would turn a long-running host session into an unbounded memory sink.
const MAX_RETAINED_RUN_TOMBSTONES = 4096

/**
 * Figma/CEP runtimes do not all expose the browser AbortController global. Keep
 * cancellation part of the shared lifecycle contract without making an older
 * host VM fail before validation starts. The fallback intentionally implements
 * only the AbortSignal surface used by this module.
 */
const createLifecycleAbortController = (): AbortController => {
  if (typeof globalThis.AbortController === 'function') return new globalThis.AbortController()

  let aborted = false
  const listeners = new Set<() => void>()
  const signal = {
    get aborted() {
      return aborted
    },
    addEventListener(type: string, listener: () => void) {
      if (type === 'abort') listeners.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === 'abort') listeners.delete(listener)
    }
  } as unknown as AbortSignal

  return {
    signal,
    abort() {
      if (aborted) return
      aborted = true
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // Abort notification must not prevent the remaining listeners.
        }
      }
      listeners.clear()
    }
  } as unknown as AbortController
}

const errorCodeFrom = (
  error: unknown,
  fallback: HostAdapterLifecycleErrorCode
): HostAdapterLifecycleErrorCode => {
  const message = error instanceof Error ? error.message : ''
  return hostAdapterLifecycleErrorCodeSchema.safeParse(message).success
    ? (message as HostAdapterLifecycleErrorCode)
    : fallback
}

const retryableFor = (code: HostAdapterLifecycleErrorCode): boolean =>
  code === 'PREPARE_FAILED' || code === 'EXECUTE_FAILED' || code === 'READBACK_FAILED'

/**
 * Classify an explicitly supplied plan version before the full Zod parse.  The
 * lifecycle can receive a raw plan without a context (in which case it must
 * capture one), so the normal compatibility gate cannot run until after the
 * plan has been parsed.  Keep malformed/missing versions on the generic
 * INVALID_PLAN path; only an explicit, known-to-be-different version is a
 * schema negotiation failure.
 */
const rawPlanSchemaCompatibilityError = (
  rawPlan: unknown
): HostAdapterLifecycleErrorCode | undefined => {
  if (rawPlan === null || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) return undefined
  try {
    if (!Object.prototype.hasOwnProperty.call(rawPlan, 'schemaVersion')) return undefined
    const schemaVersion = (rawPlan as { schemaVersion?: unknown }).schemaVersion
    return schemaVersion === undefined || schemaVersion === FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION
      ? undefined
      : 'UNSUPPORTED_PLAN_SCHEMA'
  } catch {
    // Let hostPlanSchema.parse classify hostile/proxy objects as INVALID_PLAN.
    return undefined
  }
}

const identityOf = (context: HostContext, adapterVersion: string): string =>
  JSON.stringify([
    context.host,
    context.documentId,
    context.scopeId,
    context.captureId,
    context.recoveryIdentity ?? '',
    context.execution ?? '',
    adapterVersion
  ])

const capabilityFingerprint = (
  capabilities: HostAdapterLifecycleCapabilities | HostContext['execution']
): string => {
  const execution =
    capabilities && typeof capabilities === 'object' && 'execution' in capabilities
      ? capabilities.execution
      : capabilities
  return JSON.stringify({
    adapterVersion: execution?.adapterVersion ?? '',
    supports: [...(execution?.supports ?? [])].sort(),
    rollback: execution?.rollback ?? '',
    visualAudit: execution?.visualAudit ?? '',
    ...(execution?.opacityEncoding === undefined
      ? {}
      : { opacityEncoding: execution.opacityEncoding })
  })
}

export function createHostAdapterLifecycle<TResources = unknown, TExecution = unknown>(
  options: HostAdapterLifecycleOptions<TResources, TExecution>
): HostAdapterLifecycle<TResources, TExecution> {
  const checkedOptions = {
    ...options,
    host: z.enum(['figma', 'photoshop']).parse(options.host),
    adapterVersion: z.string().min(1).max(64).parse(options.adapterVersion)
  }
  // A native document adapter must not receive overlapping writes unless the
  // integration explicitly proves that it can isolate them. Keep the default
  // conservative while allowing a bounded host-owned override.
  const maxConcurrentRuns = z
    .number()
    .int()
    .min(1)
    .max(64)
    .parse(options.maxConcurrentRuns ?? 1)
  const runs = new Map<string, RunState<TResources, TExecution>>()
  // Keep a bounded-state tombstone set separate from retained metadata. This
  // prevents replay while a result is retained, and for a bounded window after
  // pruning. Older IDs are intentionally evicted to keep long-running hosts
  // bounded; callers must generate fresh random IDs for every run.
  const knownRunIds = new Set<string>()

  const now = (): number => {
    try {
      const value = checkedOptions.now?.() ?? Date.now()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  const captureContext = (captureId: string, scope?: readonly string[]): HostContext => {
    const checkedCaptureId = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(captureId)
    const checkedScope = scope === undefined ? undefined : captureScopeSchema.parse([...scope])
    const captured = checkedOptions.captureContext(checkedCaptureId, checkedScope)
    const context = hostContextSchema.parse(captured)
    if (context.host !== checkedOptions.host || context.captureId !== checkedCaptureId)
      throw new Error('STALE_CONTEXT')
    return context
  }

  const validatePlan = (
    rawPlan: unknown,
    rawContext: unknown,
    resources?: readonly FigPluginPlanningAssetMetadata[],
    imageRecovery?: FigPluginRecoveryExecutionImages
  ): HostPlan => {
    // Negotiate before parsing the concrete schemas so an unsupported version
    // produces the stable compatibility error instead of an opaque Zod error.
    assertHostPlanCompatibility(rawContext, rawPlan)
    const parsedPlan = hostPlanSchema.parse(rawPlan)
    const context = hostContextSchema.parse(rawContext)
    if (context.host !== checkedOptions.host) throw new Error('STALE_CONTEXT')
    if (context.execution?.adapterVersion !== checkedOptions.adapterVersion)
      throw new Error('STALE_CONTEXT')
    // Direct native integrations call validatePlan() rather than run(). Keep
    // capability discovery on that boundary too, so a plan cannot bypass the
    // adapter identity check simply by using the validation helper.
    if (checkedOptions.requireCapabilityDiscovery || checkedOptions.discoverCapabilities) {
      const discovered = discoverCapabilities()
      if (
        !context.execution ||
        capabilityFingerprint(discovered) !== capabilityFingerprint(context.execution)
      )
        throw new Error('STALE_CONTEXT')
    }
    // The capture ID ties a plan to one observation and prevents stale writes.
    if (parsedPlan.captureId !== context.captureId) throw new Error('STALE_CONTEXT')
    // Apply only precision explicitly advertised by the native adapter before
    // the plan reaches prepare/execute. This keeps host-side validation and
    // readback on the same representable values used by the native API.
    const plan = normalizeHostPlan(parsedPlan, context, resources, imageRecovery)
    validateHostPlanExecution(plan, context, resources, imageRecovery)
    checkedOptions.validatePlan?.(plan, context, resources, imageRecovery)
    return plan
  }

  const discoverCapabilities = (): HostAdapterLifecycleCapabilities => {
    if (!checkedOptions.discoverCapabilities) throw new Error('CAPABILITY_DISCOVERY_FAILED')
    let capabilities: HostAdapterLifecycleCapabilities
    try {
      capabilities = hostAdapterLifecycleCapabilitiesSchema.parse(
        checkedOptions.discoverCapabilities()
      )
    } catch {
      throw new Error('CAPABILITY_DISCOVERY_FAILED')
    }
    if (
      capabilities.host !== checkedOptions.host ||
      capabilities.execution.adapterVersion !== checkedOptions.adapterVersion
    )
      throw new Error('STALE_CONTEXT')
    return capabilities
  }

  const transition = (
    state: RunState<TResources, TExecution>,
    stage: HostAdapterLifecycleStage,
    completed: number
  ): void => {
    if (!canTransitionHostAdapterLifecycle(state.stage, stage)) throw new Error('INVALID_PLAN')
    const total = state.plan?.steps.length ?? 0
    const normalized = Number.isFinite(completed) ? Math.trunc(completed) : 0
    const bounded = Math.max(0, Math.min(total, normalized))
    // Progress is an observation of work already accepted by the lifecycle.
    // Do not let a late or hostile callback move it backwards; callers may
    // still report a lower value, but the terminal receipt remains monotonic.
    const previous = state.progress.at(-1)?.completed ?? 0
    const monotonic = Math.max(previous, bounded)
    state.stage = stage
    const entry = hostAdapterLifecycleProgressSchema.parse({
      stage,
      completed: monotonic,
      total,
      timestamp: now()
    })
    // A hostile adapter may report progress in a tight loop. Keep the result
    // schema bounded while retaining the newest progress observation.
    if (state.progress.length < 512) state.progress.push(entry)
    else state.progress[state.progress.length - 1] = entry
  }

  const terminal = (
    state: RunState<TResources, TExecution>,
    status: HostAdapterLifecycleStatus,
    error?: HostAdapterLifecycleError,
    readback?: HostPlanReadback
  ): HostAdapterLifecycleResult<TExecution> => {
    if (state.stage !== 'terminal')
      transition(state, 'terminal', state.progress.at(-1)?.completed ?? 0)
    const result: HostAdapterLifecycleResult<TExecution> = {
      runId: state.runId,
      status,
      stage: 'terminal',
      progress: state.progress.slice(),
      ...(checkedOptions.retainExecution !== false &&
      state.executionCompleted &&
      state.execution !== undefined
        ? { execution: state.execution }
        : {}),
      ...(readback === undefined ? {} : { readback }),
      ...(error === undefined ? {} : { error })
    }
    // Keep the terminal boundary just as strict as the input and readback
    // boundaries; opaque execution data is accepted but never interpreted.
    const checked = hostAdapterLifecycleResultSchema.parse(
      result
    ) as HostAdapterLifecycleResult<TExecution>
    // A terminal observation is not yet a released resource scope. Publish it
    // only after finalization, while duplicate run IDs remain unavailable.
    state.pendingResult = checked
    return checked
  }

  const requestCancellation = (state: RunState<TResources, TExecution>, signal?: AbortSignal) => {
    if (state.status !== 'active' || state.stage === 'terminal')
      return state.cancelCallbackPromise ?? Promise.resolve()
    const controller = state.controller
    if (!controller) return Promise.resolve()
    state.cancellationRequested = true
    if (!controller.signal.aborted) controller.abort()
    if (!state.cancelCallbackPromise) {
      state.cancelCallbackPromise = Promise.resolve()
        .then(() => checkedOptions.cancel?.(state.runId, signal ?? controller.signal))
        .then(
          () => undefined,
          () => undefined
        )
    }
    return state.cancelCallbackPromise
  }

  const releaseRunResources = async (state: RunState<TResources, TExecution>): Promise<void> => {
    state.finalizing = true
    const result = state.pendingResult
    let required = state.releaseCallbacks.length > 0
    let failureCount = 0
    try {
      // Cancellation is advisory and may still be using native resources after
      // execute/prepare settles. A timeout cannot stand in for actual disposal.
      await state.cancelCallbackPromise
      while (state.releaseCallbacks.length) {
        const release = state.releaseCallbacks.pop()!
        try {
          await release()
        } catch {
          failureCount++
        }
      }
      if (state.preparationStarted && checkedOptions.releaseResources) {
        required = true
        try {
          await checkedOptions.releaseResources({
            runId: state.runId,
            resources: state.resources,
            execution: state.execution,
            status: result?.status ?? 'failed'
          })
        } catch {
          failureCount++
        }
      }
    } finally {
      // Historical diagnostics retain observations, never the resource scope or
      // its cleanup closures. Explicit legacy result retention is separate.
      state.releaseCallbacks.length = 0
      delete state.resources
      delete state.execution
      delete state.plan
      delete state.context
      delete state.contextIdentity
      delete state.cancelCallbackPromise
      delete state.controller
      delete state.pendingResult
      if (result) {
        result.resourceCleanup = hostAdapterResourceCleanupSchema.parse({
          status: failureCount > 0 ? 'failed' : required ? 'completed' : 'not-required',
          failureCount
        })
        state.result = result
        state.status = result.status
      } else {
        state.stage = 'terminal'
        state.status = 'failed'
      }
      pruneRuns()
      pruneKnownRunIds()
    }
  }

  const pruneRuns = (): void => {
    if (runs.size <= MAX_RETAINED_RUNS) return
    for (const [runId, state] of runs) {
      if (state.status !== 'active') {
        runs.delete(runId)
        if (runs.size <= MAX_RETAINED_RUNS) break
      }
    }
  }

  const pruneKnownRunIds = (): void => {
    if (knownRunIds.size <= MAX_RETAINED_RUN_TOMBSTONES) return
    for (const runId of knownRunIds) {
      // Never evict an ID whose full state is still retained (active or
      // terminal); doing so would make a duplicate immediately executable.
      if (runs.has(runId)) continue
      knownRunIds.delete(runId)
      if (knownRunIds.size <= MAX_RETAINED_RUN_TOMBSTONES) break
    }
  }

  const activeRunCount = (): number =>
    [...runs.values()].reduce((count, state) => count + (state.status === 'active' ? 1 : 0), 0)

  const run = async (
    inputOrRunId: HostAdapterLifecycleRunInput | string,
    positionalPlan?: unknown,
    positionalContext?: unknown,
    positionalSignal?: AbortSignal,
    positionalResources?: readonly FigPluginPlanningAssetMetadata[],
    positionalImageRecovery?: FigPluginRecoveryExecutionImages
  ): Promise<HostAdapterLifecycleResult<TExecution>> => {
    const input: HostAdapterLifecycleRunInput =
      typeof inputOrRunId === 'string'
        ? {
            runId: inputOrRunId,
            plan: positionalPlan,
            context: positionalContext,
            signal: positionalSignal,
            resources: positionalResources,
            imageRecovery: positionalImageRecovery
          }
        : inputOrRunId
    const runIdResult = runIdSchema.safeParse(input?.runId)
    if (!runIdResult.success) throw new Error('INVALID_RUN_ID')
    const runId = runIdResult.data
    const existing = runs.get(runId)
    if (existing || knownRunIds.has(runId)) {
      const duplicate = {
        runId,
        status: 'failed',
        stage: 'terminal',
        progress: [{ stage: 'terminal', completed: 0, total: 0, timestamp: now() }],
        error: { code: 'CONCURRENT_RUN', retryable: false }
      }
      return hostAdapterLifecycleResultSchema.parse(
        duplicate
      ) as HostAdapterLifecycleResult<TExecution>
    }
    if (activeRunCount() >= maxConcurrentRuns) {
      const busy = {
        runId,
        status: 'failed',
        stage: 'terminal',
        progress: [{ stage: 'terminal', completed: 0, total: 0, timestamp: now() }],
        error: { code: 'CONCURRENT_RUN', retryable: false }
      }
      // Do not reserve the rejected ID. A caller may retry it after an active
      // run has settled, while duplicate IDs already accepted remain tombstoned.
      return hostAdapterLifecycleResultSchema.parse(busy) as HostAdapterLifecycleResult<TExecution>
    }

    const state: RunState<TResources, TExecution> = {
      runId,
      controller: createLifecycleAbortController(),
      status: 'active',
      stage: 'validating',
      progress: [],
      cancellationRequested: false,
      executionStarted: false,
      executionCompleted: false,
      preparationStarted: false,
      finalizing: false,
      releaseCallbacks: [],
      createdAt: now()
    }
    knownRunIds.add(runId)
    runs.set(runId, state)
    pruneRuns()
    pruneKnownRunIds()
    const signal = input.signal
    const onAbort = (): void => {
      void requestCancellation(state, signal)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      if (state.cancellationRequested) {
        await requestCancellation(state, signal)
        transition(state, 'validating', 0)
        return terminal(state, 'cancelled', { code: 'CANCELLED', retryable: false })
      }
      let plan: HostPlan
      try {
        plan = hostPlanSchema.parse(input.plan)
        state.plan = plan
      } catch {
        transition(state, 'validating', 0)
        const code = rawPlanSchemaCompatibilityError(input.plan) ?? 'INVALID_PLAN'
        return terminal(state, 'failed', { code, retryable: retryableFor(code) })
      }
      transition(state, 'validating', 0)

      let context: HostContext
      let resources: readonly FigPluginPlanningAssetMetadata[] | undefined
      let imageRecovery: FigPluginRecoveryExecutionImages | undefined
      try {
        imageRecovery =
          input.imageRecovery === undefined
            ? undefined
            : validateRecoveryExecutionImages(input.imageRecovery)
        resources =
          input.resources === undefined
            ? undefined
            : Object.freeze(
                input.resources.map((asset) =>
                  Object.freeze(figPluginPlanningAssetMetadataSchema.parse(asset))
                )
              )
        const rawContext =
          input.context === undefined ? captureContext(plan.captureId) : input.context
        // Run the compatibility gate before the generic context schema so
        // version drift is reported with a stable diagnostic code.
        assertHostPlanCompatibility(rawContext, plan)
        context = hostContextSchema.parse(rawContext)
        state.context = context
        state.contextIdentity = identityOf(context, checkedOptions.adapterVersion)
        // This intentionally runs before any resource preparation or write.
        plan = validatePlan(plan, context, resources, imageRecovery)
        state.plan = plan
      } catch (error) {
        const code = errorCodeFrom(error, 'INVALID_PLAN')
        return terminal(state, code === 'CANCELLED' ? 'cancelled' : 'failed', {
          code,
          retryable: retryableFor(code)
        })
      }

      if (state.cancellationRequested)
        return terminal(state, 'cancelled', { code: 'CANCELLED', retryable: false })

      transition(state, 'preparing', 0)
      state.preparationStarted = true
      try {
        state.resources = checkedOptions.prepareResources
          ? await checkedOptions.prepareResources({
              runId,
              context,
              plan,
              imageRecovery,
              signal: state.controller!.signal,
              deferRelease: (release) => {
                if (state.finalizing || state.stage === 'terminal')
                  throw new Error('RESOURCE_SCOPE_CLOSED')
                if (typeof release !== 'function') throw new Error('INVALID_RESOURCE_RELEASE')
                if (state.releaseCallbacks.length >= MAX_RESOURCE_RELEASE_CALLBACKS)
                  throw new Error('RESOURCE_RELEASE_LIMIT')
                state.releaseCallbacks.push(release)
              }
            })
          : undefined
      } catch (error) {
        if (state.cancellationRequested)
          return terminal(state, 'cancelled', { code: 'CANCELLED', retryable: false })
        const code = errorCodeFrom(error, 'PREPARE_FAILED')
        return terminal(state, 'failed', { code, retryable: retryableFor(code) })
      }
      if (state.cancellationRequested)
        return terminal(state, 'cancelled', { code: 'CANCELLED', retryable: false })

      transition(state, 'executing', 0)
      state.executionStarted = true
      try {
        state.execution = await checkedOptions.execute({
          runId,
          context,
          plan,
          imageRecovery,
          resources: state.resources,
          signal: state.controller!.signal,
          onProgress: (completed) => {
            if (state.status === 'active' && state.stage === 'executing')
              transition(state, 'executing', completed)
          }
        })
        state.executionCompleted = state.execution !== undefined
      } catch (error) {
        if (state.cancellationRequested)
          return terminal(state, 'cancelled', { code: 'CANCELLED', retryable: false })
        const code = errorCodeFrom(error, 'EXECUTE_FAILED')
        return terminal(state, 'failed', { code, retryable: retryableFor(code) })
      }
      if (state.cancellationRequested)
        return terminal(state, 'cancelled', { code: 'CANCELLED', retryable: false })
      if (!state.executionCompleted)
        return terminal(state, 'failed', { code: 'EXECUTE_FAILED', retryable: true })

      // A host callback must not mutate the observation identity while writing.
      if (identityOf(context, checkedOptions.adapterVersion) !== state.contextIdentity)
        return terminal(state, 'failed', { code: 'STALE_CONTEXT', retryable: false })

      transition(state, 'readback', plan.steps.length)
      let rawReadback: unknown
      try {
        rawReadback = await checkedOptions.readback({
          runId,
          context,
          plan,
          imageRecovery,
          execution: state.execution,
          signal: state.controller!.signal
        })
        const readback = validateHostPlanReadback(
          plan,
          context,
          rawReadback,
          resources,
          imageRecovery
        )
        if (state.cancellationRequested)
          return terminal(state, 'cancelled', { code: 'CANCELLED', retryable: false }, readback)
        return terminal(state, 'completed', undefined, readback)
      } catch (error) {
        if (state.cancellationRequested)
          return terminal(state, 'cancelled', { code: 'CANCELLED', retryable: false })
        const code = errorCodeFrom(error, 'READBACK_FAILED')
        return terminal(state, 'failed', { code, retryable: retryableFor(code) })
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      await releaseRunResources(state)
    }
  }

  const cancel = async (runId: string, signal?: AbortSignal): Promise<boolean> => {
    const parsed = runIdSchema.safeParse(runId)
    if (!parsed.success) return false
    const state = runs.get(parsed.data)
    if (!state || state.status !== 'active' || state.stage === 'terminal') return false
    await requestCancellation(state, signal)
    return true
  }

  const diagnostics = (): HostAdapterLifecycleDiagnostics => {
    const summary = [...runs.values()].map<HostAdapterLifecycleDiagnosticsRun>((state) => ({
      runId: state.runId,
      status: state.status,
      stage: state.stage,
      ...(state.result?.error ? { errorCode: state.result.error.code } : {}),
      ...(state.result?.resourceCleanup ? { resourceCleanup: state.result.resourceCleanup } : {})
    }))
    const activeRunIds = summary
      .filter((run) => run.status === 'active')
      .map((run) => run.runId)
      .slice(0, 256)
    return hostAdapterLifecycleDiagnosticsSchema.parse({
      activeRunIds,
      activeCount: activeRunIds.length,
      completedCount: summary.filter((run) => run.status === 'completed').length,
      cancelledCount: summary.filter((run) => run.status === 'cancelled').length,
      failedCount: summary.filter((run) => run.status === 'failed').length,
      runs: summary.slice(-256)
    })
  }

  const getResult = (runId: string): HostAdapterLifecycleResult<TExecution> | undefined =>
    runs.get(runId)?.result

  return {
    discoverCapabilities,
    captureContext,
    validatePlan,
    run: run as HostAdapterLifecycle<TResources, TExecution>['run'],
    start: run as HostAdapterLifecycle<TResources, TExecution>['run'],
    execute: run as HostAdapterLifecycle<TResources, TExecution>['run'],
    cancel,
    diagnostics,
    getResult
  }
}
