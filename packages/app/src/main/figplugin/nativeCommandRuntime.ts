import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { types } from 'node:util'
import { z } from 'zod'
import type { FigPluginRuntimeBinding } from '@shared/figplugin/bridge'
import { canonicalFigPluginJson, type FigPluginHost } from '@shared/figplugin/manifest'
import {
  FIGPLUGIN_NATIVE_COMMAND,
  FIGPLUGIN_NATIVE_COMMAND_DOMAIN,
  FIGPLUGIN_NATIVE_MAX_PROGRESS_EVENTS,
  FIGPLUGIN_NATIVE_TOTAL_WIRE_BYTES,
  figPluginNativeGuaranteeSchema,
  figPluginNativeIntentSchema,
  figPluginNativeProposalSchema,
  figPluginNativeRuntimeBindingSchema,
  figPluginNativeStatusSchema,
  parseFigPluginNativeCommandValue,
  type FigPluginNativeGuarantee,
  type FigPluginNativeIntent,
  type FigPluginNativeProposal,
  type FigPluginNativeStatus
} from '@shared/figplugin/nativeCommand'
import { snapshotFigPluginPlanData, type FigPluginPlan } from '@shared/figplugin/plan'

export const FIGPLUGIN_NATIVE_RUNTIME_MAX_ACTIONS = 8
export const FIGPLUGIN_NATIVE_RUNTIME_CAPTURE_TIMEOUT_MS = 30_000
export const FIGPLUGIN_NATIVE_RUNTIME_PREVIEW_TTL_MS = 60_000
export const FIGPLUGIN_NATIVE_RUNTIME_DOMAIN = 'figplugin-native-preview/v1' as const

export type FigPluginNativeRuntimeCode =
  | 'UNAVAILABLE'
  | 'BUSY'
  | 'INVALID_SESSION'
  | 'INVALID_ACTION'
  | 'INVALID_COMMAND'
  | 'TOO_LARGE'
  | 'INVALID_CAPTURE'
  | 'CANCELLED'
  | 'REVOKED'
  | 'TIMEOUT'
  | 'EXPIRED'
  | 'DENIED'
  | 'ALREADY_DECIDED'
  | 'NO_ACTION'
  | 'ERROR'

/** Opaque process-local handles. Their fields are intentionally not part of the API. */
export type FigPluginNativeSession = object
export type FigPluginNativeAction = object

export type FigPluginNativeAuthority = Readonly<{
  binding: FigPluginRuntimeBinding
  authorityEpoch: string
  instanceEpoch: string
  guarantee: FigPluginNativeGuarantee
}>

export type FigPluginNativeFixtureCapture = Readonly<{
  captureType: 'fixture'
  completeHostSnapshot?: false
  range: unknown
  before: unknown
}>

export type FigPluginNativeReaderRequest = Readonly<{
  captureType: 'fixture'
  actionId: string
  binding: FigPluginRuntimeBinding
  authorityEpoch: string
  instanceEpoch: string
  guarantee: FigPluginNativeGuarantee
  plan: FigPluginPlan
}>

export type FigPluginNativeApprovalRequest = Readonly<{
  domain: typeof FIGPLUGIN_NATIVE_COMMAND_DOMAIN
  version: 1
  purpose: 'native-write-consent'
  actionId: string
  payloadSha256: string
}>

export type FigPluginNativeRuntimeDependencies = Readonly<{
  authority?: Readonly<{
    resolve: (
      registeredBinding: FigPluginRuntimeBinding,
      signal: AbortSignal
    ) => FigPluginNativeAuthority | undefined | Promise<FigPluginNativeAuthority | undefined>
    isCurrent: (authority: FigPluginNativeAuthority) => boolean
  }>
  reader?: Readonly<{
    capture: (
      request: FigPluginNativeReaderRequest,
      signal: AbortSignal
    ) => FigPluginNativeFixtureCapture | unknown | Promise<FigPluginNativeFixtureCapture | unknown>
  }>
  /** Fixture reader alias; there is deliberately no native dispatch dependency. */
  capture?: Readonly<{
    capture: (
      request: FigPluginNativeReaderRequest,
      signal: AbortSignal
    ) => FigPluginNativeFixtureCapture | unknown | Promise<FigPluginNativeFixtureCapture | unknown>
  }>
  approval?: Readonly<{
    decide: (request: FigPluginNativeApprovalRequest) => boolean | Promise<boolean>
  }>
  /** Main-owned invalidation callback. It must synchronously revoke the generation. */
  subscribe?: (onInvalidated: () => void) => (() => void) | void
  now?: () => number
}>

type Failure = { ok: false; code: FigPluginNativeRuntimeCode }
type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  settled: boolean
}
type State =
  'capturing' | 'awaiting-write-consent' | 'approved' | 'cancelled' | 'failed' | 'expired'
type TerminalState = Extract<State, 'cancelled' | 'failed' | 'expired'>
type ProgressPhase = 'capturing' | 'awaiting-write-consent' | 'approved'
type Fixture = {
  captureType: 'fixture'
  completeHostSnapshot: false
  range: unknown
  before: unknown
}
type FinalPayload = {
  domain: typeof FIGPLUGIN_NATIVE_RUNTIME_DOMAIN
  state: 'awaiting-write-consent'
  expiresAt: number
  intent: FigPluginNativeIntent
  binding: FigPluginRuntimeBinding
  authorityEpoch: string
  instanceEpoch: string
  guarantee: FigPluginNativeGuarantee
  range: unknown
  before: unknown
}
type Preview = Readonly<{
  domain: typeof FIGPLUGIN_NATIVE_RUNTIME_DOMAIN
  actionId: string
  payloadSha256: string
  state: 'awaiting-write-consent'
  createdAt: number
  expiresAt: number
  intent: FigPluginNativeIntent
  captureType: 'fixture'
  completeHostSnapshot: false
  range: unknown
  before: unknown
}>
type ProgressEvent = {
  sequence: number
  ordinal: number
  index: number
  phase: ProgressPhase
  completed: 0
  total: number
  effect: 'none'
}
type SessionRecord = {
  readonly handle: FigPluginNativeSession
  readonly binding: FigPluginRuntimeBinding
  generation: number
  revoked: boolean
  current?: Slot
}
type ActionRecord = {
  readonly session: SessionRecord
  readonly handle: FigPluginNativeAction
  readonly actionId: string
  readonly total: number
  preview?: Preview
  payload?: FinalPayload
  payloadSha256?: string
  status?: FigPluginNativeStatus
  code?: FigPluginNativeRuntimeCode
  state?: State
  cursor: number
  progress: ProgressEvent[]
  slot?: Slot
}
type Slot = {
  readonly session: SessionRecord
  readonly action: ActionRecord
  readonly generation: number
  readonly abort: AbortController
  readonly captureResult: Deferred<PreviewResult>
  state: State
  code?: FigPluginNativeRuntimeCode
  capturePending: boolean
  decisionPending: boolean
  decisionResult?: Deferred<DecisionResult>
  timer?: ReturnType<typeof setTimeout>
  callerResolved: boolean
  expiresAt?: number
}

export type FigPluginNativePreview = Preview
export type FigPluginNativeStatusResult = { ok: true; status: FigPluginNativeStatus } | Failure
export type FigPluginNativeProgress = Readonly<{
  domain: typeof FIGPLUGIN_NATIVE_COMMAND_DOMAIN
  version: 1
  actionId: string
  payloadSha256: string
  host: FigPluginHost
  command: typeof FIGPLUGIN_NATIVE_COMMAND
  purpose: 'native-command-progress'
  total: number
  cursor: number
  events: readonly ProgressEvent[]
}>
export type FigPluginNativeProgressResult =
  { ok: true; progress: FigPluginNativeProgress } | Failure
export type PreviewResult =
  | {
      ok: true
      action: FigPluginNativeAction
      preview: FigPluginNativePreview
      status: FigPluginNativeStatus
    }
  | Failure
export type DecisionResult = { ok: true; status: FigPluginNativeStatus } | Failure
export type ControlResult = { ok: true; status?: FigPluginNativeStatus } | Failure

const hex32 = /^[a-f0-9]{32}$/
const fixtureSchema = z
  .object({
    captureType: z.literal('fixture'),
    completeHostSnapshot: z.literal(false).optional(),
    range: z.unknown(),
    before: z.unknown()
  })
  .strict()
const authoritySchema = z
  .object({
    binding: figPluginNativeRuntimeBindingSchema,
    authorityEpoch: z.string().length(32).regex(hex32),
    instanceEpoch: z.string().length(32).regex(hex32),
    guarantee: figPluginNativeGuaranteeSchema
  })
  .strict()

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve, settled: false }
}

const failure = (code: FigPluginNativeRuntimeCode): Failure => ({ ok: false, code })
const isFailure = (value: object | Failure): value is Failure =>
  'ok' in value && (value as { ok?: unknown }).ok === false

const sameJson = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalFigPluginJson(left) === canonicalFigPluginJson(right)
  } catch {
    return false
  }
}

const equalHash = (left: string, right: string): boolean => {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return timingSafeEqual(leftBytes, rightBytes)
}

const parseBinding = (value: unknown): FigPluginRuntimeBinding | undefined => {
  const parsed = parseFigPluginNativeCommandValue(
    figPluginNativeRuntimeBindingSchema,
    value,
    types.isProxy
  )
  return parsed.ok ? freeze(parsed.data) : undefined
}

const parseAuthority = (value: unknown): FigPluginNativeAuthority | undefined => {
  const parsed = parseFigPluginNativeCommandValue(authoritySchema, value, types.isProxy)
  return parsed.ok ? freeze(parsed.data) : undefined
}

const parseFixture = (
  value: unknown
): { ok: true; fixture: Fixture } | { ok: false; code: 'TOO_LARGE' | 'INVALID_CAPTURE' } => {
  const snapshot = snapshotFigPluginPlanData(
    value,
    FIGPLUGIN_NATIVE_TOTAL_WIRE_BYTES,
    types.isProxy
  )
  if (!snapshot.ok)
    return { ok: false, code: snapshot.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID_CAPTURE' }
  try {
    const parsed = fixtureSchema.safeParse(snapshot.data)
    if (!parsed.success) return { ok: false, code: 'INVALID_CAPTURE' }
    return {
      ok: true,
      fixture: freeze({
        captureType: 'fixture',
        completeHostSnapshot: false,
        range: parsed.data.range,
        before: parsed.data.before
      })
    }
  } catch {
    return { ok: false, code: 'INVALID_CAPTURE' }
  }
}

const digest = (payload: FinalPayload): string | undefined => {
  try {
    const json = canonicalFigPluginJson(payload)
    if (Buffer.byteLength(json, 'utf8') > FIGPLUGIN_NATIVE_TOTAL_WIRE_BYTES) return undefined
    return createHash('sha256').update(json, 'utf8').digest('hex')
  } catch {
    return undefined
  }
}

export const createFigPluginNativeCommandRuntime = (
  dependencies: FigPluginNativeRuntimeDependencies = {}
) => {
  const now = dependencies.now ?? Date.now
  const authority =
    dependencies.authority &&
    typeof dependencies.authority.resolve === 'function' &&
    typeof dependencies.authority.isCurrent === 'function'
      ? dependencies.authority
      : undefined
  const reader =
    dependencies.reader && typeof dependencies.reader.capture === 'function'
      ? dependencies.reader
      : dependencies.capture && typeof dependencies.capture.capture === 'function'
        ? dependencies.capture
        : undefined
  const sessions = new WeakMap<object, SessionRecord>()
  const actions = new WeakMap<object, ActionRecord>()
  const unsettled = new Set<Slot>()
  const terminalCache = new Map<string, ActionRecord>()
  let generation = 0
  let disposed = false
  let unsubscribe: (() => void) | undefined

  const settle = <T>(target: Deferred<T>, value: T): void => {
    if (target.settled) return
    target.settled = true
    target.resolve(value)
  }

  const statusFor = (slot: Slot): FigPluginNativeStatus | undefined => {
    const preview = slot.action.preview
    const hash = slot.action.payloadSha256
    if (!preview || !hash) return undefined
    const candidate = {
      domain: FIGPLUGIN_NATIVE_COMMAND_DOMAIN,
      version: 1 as const,
      purpose: 'native-command-status' as const,
      actionId: preview.actionId,
      payloadSha256: hash,
      host: preview.intent.host,
      command: FIGPLUGIN_NATIVE_COMMAND,
      status:
        slot.state === 'cancelled'
          ? ('cancelled' as const)
          : slot.state === 'failed'
            ? ('failed' as const)
            : slot.state === 'expired'
              ? ('expired' as const)
              : slot.state,
      total: slot.action.total,
      completed: 0,
      effect: 'none' as const,
      updatedAt: now()
    }
    const parsed = figPluginNativeStatusSchema.safeParse(candidate)
    return parsed.success ? freeze(parsed.data) : undefined
  }

  const cacheTerminal = (slot: Slot): void => {
    const status = statusFor(slot)
    if (!status) return
    slot.action.status = status
    terminalCache.delete(slot.action.actionId)
    terminalCache.set(slot.action.actionId, slot.action)
    while (terminalCache.size > FIGPLUGIN_NATIVE_MAX_PROGRESS_EVENTS) {
      const oldest = terminalCache.keys().next().value as string | undefined
      if (!oldest) break
      terminalCache.delete(oldest)
    }
  }

  const release = (slot: Slot): void => {
    clearTimeout(slot.timer)
    slot.timer = undefined
    if (slot.session.current === slot) slot.session.current = undefined
    unsettled.delete(slot)
    slot.action.slot = undefined
    if (slot.state === 'cancelled' || slot.state === 'failed' || slot.state === 'expired')
      cacheTerminal(slot)
  }

  const maybeRelease = (slot: Slot): void => {
    if (
      slot.capturePending ||
      slot.decisionPending ||
      slot.state === 'awaiting-write-consent' ||
      slot.state === 'approved'
    )
      return
    release(slot)
  }

  const resolveCapture = (slot: Slot, result: PreviewResult): void => {
    if (slot.callerResolved) return
    slot.callerResolved = true
    settle(slot.captureResult, result)
  }

  const terminate = (slot: Slot, code: FigPluginNativeRuntimeCode, state?: TerminalState): void => {
    if (slot.state === 'cancelled' || slot.state === 'failed' || slot.state === 'expired') return
    slot.code = code
    slot.state =
      state ?? (code === 'EXPIRED' ? 'expired' : code === 'ERROR' ? 'failed' : 'cancelled')
    slot.action.code = code
    slot.action.state = slot.state
    slot.abort.abort()
    if (slot.decisionResult) settle(slot.decisionResult, failure(code))
    resolveCapture(slot, failure(code))
    maybeRelease(slot)
  }

  const active = (slot: Slot): boolean => {
    if (
      disposed ||
      slot.code ||
      slot.session.current !== slot ||
      !unsettled.has(slot) ||
      slot.generation !== generation ||
      slot.session.revoked ||
      slot.session.generation !== generation
    )
      return false
    if (
      (slot.state === 'awaiting-write-consent' || slot.state === 'approved') &&
      slot.expiresAt !== undefined &&
      now() >= slot.expiresAt
    ) {
      terminate(slot, 'EXPIRED', 'expired')
      return false
    }
    return true
  }

  const current = (slot: Slot, currentAuthority: FigPluginNativeAuthority): boolean => {
    if (!active(slot) || !authority) return false
    let result = false
    try {
      result = authority.isCurrent(currentAuthority)
    } catch {
      return false
    }
    // isCurrent is trusted main code but may synchronously revoke/re-enter this runtime.
    return result && active(slot)
  }

  const appendProgress = (slot: Slot, phase: ProgressPhase): void => {
    if (!slot.action.preview) return
    const event: ProgressEvent = {
      sequence: slot.action.cursor + 1,
      ordinal: 1,
      index: 0,
      phase,
      completed: 0,
      total: slot.action.total,
      effect: 'none'
    }
    slot.action.cursor = event.sequence
    slot.action.progress.push(event)
    if (slot.action.progress.length > FIGPLUGIN_NATIVE_MAX_PROGRESS_EVENTS)
      slot.action.progress.shift()
  }

  const finalHashIsCurrent = (slot: Slot): boolean => {
    if (!active(slot) || !slot.action.payload || !slot.action.payloadSha256) return false
    const actual = digest(slot.action.payload)
    return !!actual && equalHash(actual, slot.action.payloadSha256) && active(slot)
  }

  const createPreview = (
    slot: Slot,
    proposal: FigPluginNativeProposal,
    currentAuthority: FigPluginNativeAuthority,
    fixture: Fixture
  ): { ok: true; preview: Preview } | Failure => {
    const createdAt = now()
    const expiresAt = createdAt + FIGPLUGIN_NATIVE_RUNTIME_PREVIEW_TTL_MS
    const parsedIntent = figPluginNativeIntentSchema.safeParse({
      domain: FIGPLUGIN_NATIVE_COMMAND_DOMAIN,
      version: 1 as const,
      purpose: 'native-command-intent' as const,
      host: currentAuthority.binding.host,
      actionId: slot.action.actionId,
      binding: currentAuthority.binding,
      authorityEpoch: currentAuthority.authorityEpoch,
      instanceEpoch: currentAuthority.instanceEpoch,
      guarantee: currentAuthority.guarantee,
      plan: proposal.plan,
      expiresAt
    })
    if (!parsedIntent.success) return failure('INVALID_COMMAND')
    const payload = freeze({
      domain: FIGPLUGIN_NATIVE_RUNTIME_DOMAIN,
      state: 'awaiting-write-consent' as const,
      expiresAt,
      intent: parsedIntent.data,
      binding: currentAuthority.binding,
      authorityEpoch: currentAuthority.authorityEpoch,
      instanceEpoch: currentAuthority.instanceEpoch,
      guarantee: currentAuthority.guarantee,
      range: fixture.range,
      before: fixture.before
    })
    const bounded = snapshotFigPluginPlanData(
      payload,
      FIGPLUGIN_NATIVE_TOTAL_WIRE_BYTES,
      types.isProxy
    )
    if (!bounded.ok) return failure(bounded.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID_COMMAND')
    const payloadSha256 = digest(payload)
    if (!payloadSha256) return failure('TOO_LARGE')
    const preview = freeze({
      domain: FIGPLUGIN_NATIVE_RUNTIME_DOMAIN,
      actionId: slot.action.actionId,
      payloadSha256,
      state: 'awaiting-write-consent' as const,
      createdAt,
      expiresAt,
      intent: parsedIntent.data,
      captureType: 'fixture' as const,
      completeHostSnapshot: false as const,
      range: fixture.range,
      before: fixture.before
    })
    slot.action.preview = preview
    slot.action.payload = payload
    slot.action.payloadSha256 = payloadSha256
    slot.expiresAt = expiresAt
    return { ok: true, preview }
  }

  const runCapture = async (slot: Slot, proposal: FigPluginNativeProposal): Promise<void> => {
    try {
      if (!authority || !reader) {
        terminate(slot, 'UNAVAILABLE', 'failed')
        return
      }
      let resolved: FigPluginNativeAuthority | undefined
      try {
        resolved = parseAuthority(await authority.resolve(slot.session.binding, slot.abort.signal))
      } catch {
        terminate(slot, 'UNAVAILABLE', 'failed')
        return
      }
      if (!resolved || !active(slot)) {
        terminate(slot, 'REVOKED')
        return
      }
      if (
        resolved.binding.host !== proposal.host ||
        !sameJson(resolved.binding, slot.session.binding)
      ) {
        terminate(slot, 'REVOKED')
        return
      }
      if (!current(slot, resolved)) {
        terminate(slot, 'REVOKED')
        return
      }
      let raw: unknown
      try {
        raw = await reader.capture(
          freeze({
            captureType: 'fixture' as const,
            actionId: slot.action.actionId,
            binding: resolved.binding,
            authorityEpoch: resolved.authorityEpoch,
            instanceEpoch: resolved.instanceEpoch,
            guarantee: resolved.guarantee,
            plan: proposal.plan
          }),
          slot.abort.signal
        )
      } catch {
        terminate(slot, active(slot) ? 'ERROR' : (slot.code ?? 'REVOKED'), 'failed')
        return
      }
      if (!active(slot)) return
      const parsedFixture = parseFixture(raw)
      if (!parsedFixture.ok) {
        terminate(
          slot,
          parsedFixture.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID_CAPTURE',
          'failed'
        )
        return
      }
      if (!current(slot, resolved)) {
        terminate(slot, 'REVOKED')
        return
      }
      const preview = createPreview(slot, proposal, resolved, parsedFixture.fixture)
      if (isFailure(preview)) {
        terminate(slot, preview.code, 'failed')
        return
      }
      if (!finalHashIsCurrent(slot) || !current(slot, resolved)) {
        terminate(slot, 'REVOKED')
        return
      }
      slot.state = 'awaiting-write-consent'
      slot.action.state = slot.state
      appendProgress(slot, 'awaiting-write-consent')
      slot.capturePending = false
      clearTimeout(slot.timer)
      slot.timer = setTimeout(() => {
        if (slot.state === 'awaiting-write-consent' || slot.state === 'approved')
          terminate(slot, 'EXPIRED', 'expired')
      }, FIGPLUGIN_NATIVE_RUNTIME_PREVIEW_TTL_MS)
      slot.timer.unref?.()
      const status = statusFor(slot)
      if (!status) {
        terminate(slot, 'ERROR', 'failed')
        return
      }
      resolveCapture(slot, {
        ok: true,
        action: slot.action.handle,
        preview: preview.preview,
        status
      })
    } catch {
      terminate(slot, active(slot) ? 'ERROR' : (slot.code ?? 'REVOKED'), 'failed')
    } finally {
      slot.capturePending = false
      maybeRelease(slot)
    }
  }

  const runDecision = async (slot: Slot): Promise<void> => {
    const decide = dependencies.approval?.decide
    const preview = slot.action.preview
    const payloadSha256 = slot.action.payloadSha256
    if (typeof decide !== 'function') {
      slot.decisionPending = false
      if (slot.decisionResult) settle(slot.decisionResult, failure('UNAVAILABLE'))
      maybeRelease(slot)
      return
    }
    if (!preview || !payloadSha256 || !authority) {
      slot.decisionPending = false
      if (slot.decisionResult) settle(slot.decisionResult, failure('INVALID_ACTION'))
      maybeRelease(slot)
      return
    }
    let currentAuthority: FigPluginNativeAuthority | undefined
    try {
      currentAuthority = parseAuthority(
        await authority.resolve(slot.session.binding, slot.abort.signal)
      )
    } catch {
      currentAuthority = undefined
    }
    if (
      !currentAuthority ||
      !active(slot) ||
      !sameJson(currentAuthority.binding, slot.session.binding) ||
      currentAuthority.authorityEpoch !== preview.intent.authorityEpoch ||
      currentAuthority.instanceEpoch !== preview.intent.instanceEpoch ||
      !sameJson(currentAuthority.guarantee, preview.intent.guarantee)
    ) {
      slot.decisionPending = false
      terminate(slot, 'REVOKED')
      maybeRelease(slot)
      return
    }
    if (!current(slot, currentAuthority) || !finalHashIsCurrent(slot)) {
      slot.decisionPending = false
      terminate(slot, 'REVOKED')
      maybeRelease(slot)
      return
    }
    let approved = false
    try {
      approved =
        (await decide(
          freeze({
            domain: FIGPLUGIN_NATIVE_COMMAND_DOMAIN,
            version: 1 as const,
            purpose: 'native-write-consent' as const,
            actionId: preview.actionId,
            payloadSha256
          })
        )) === true
    } catch {
      approved = false
    }
    if (!active(slot) || !current(slot, currentAuthority) || !finalHashIsCurrent(slot)) {
      slot.decisionPending = false
      if (active(slot)) terminate(slot, 'REVOKED')
      else if (slot.decisionResult) settle(slot.decisionResult, failure(slot.code ?? 'REVOKED'))
      maybeRelease(slot)
      return
    }
    slot.decisionPending = false
    if (!approved) {
      terminate(slot, 'DENIED')
      return
    }
    slot.state = 'approved'
    slot.action.state = slot.state
    appendProgress(slot, 'approved')
    const status = statusFor(slot)
    if (slot.decisionResult) {
      if (status) {
        const decision: DecisionResult = { ok: true, status }
        settle(slot.decisionResult, decision)
      } else {
        settle(slot.decisionResult, failure('ERROR'))
      }
    }
    maybeRelease(slot)
  }

  const lookup = (
    sessionInput: unknown,
    actionInput: unknown
  ): { session: SessionRecord; action: ActionRecord } | Failure => {
    if (disposed) return failure('UNAVAILABLE')
    if (!sessionInput || typeof sessionInput !== 'object') return failure('INVALID_SESSION')
    const session = sessions.get(sessionInput)
    if (!session) return failure('INVALID_SESSION')
    if (!actionInput || typeof actionInput !== 'object') return failure('INVALID_ACTION')
    const action = actions.get(actionInput)
    if (!action || action.session !== session) return failure('INVALID_ACTION')
    return { session, action }
  }

  const invalidate = (): void => {
    generation += 1
    for (const slot of [...unsettled]) terminate(slot, 'REVOKED')
  }

  try {
    const remove = dependencies.subscribe?.(invalidate)
    if (typeof remove === 'function') unsubscribe = remove
  } catch {
    unsubscribe = undefined
  }

  const runtime = {
    registerSession(bindingInput: FigPluginRuntimeBinding): FigPluginNativeSession | undefined {
      if (disposed) return undefined
      const binding = parseBinding(bindingInput)
      if (!binding) return undefined
      const handle = Object.freeze(Object.create(null)) as FigPluginNativeSession
      sessions.set(handle, { handle, binding, generation, revoked: false })
      return handle
    },

    capturePreview(sessionInput: unknown, proposalInput: unknown): Promise<PreviewResult> {
      if (disposed) return Promise.resolve(failure('UNAVAILABLE'))
      if (!authority || !reader) return Promise.resolve(failure('UNAVAILABLE'))
      if (!sessionInput || typeof sessionInput !== 'object')
        return Promise.resolve(failure('INVALID_SESSION'))
      const session = sessions.get(sessionInput)
      if (!session) return Promise.resolve(failure('INVALID_SESSION'))
      if (session.revoked || session.generation !== generation)
        return Promise.resolve(failure('REVOKED'))
      // This is synchronous, before proposal parsing and before the first await.
      if (session.current || unsettled.size >= FIGPLUGIN_NATIVE_RUNTIME_MAX_ACTIONS)
        return Promise.resolve(failure('BUSY'))
      const proposal = parseFigPluginNativeCommandValue(
        figPluginNativeProposalSchema,
        proposalInput,
        types.isProxy
      )
      if (!proposal.ok)
        return Promise.resolve(
          failure(proposal.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID_COMMAND')
        )
      const actionId = randomBytes(16).toString('hex')
      const handle = Object.freeze(Object.create(null)) as FigPluginNativeAction
      const action: ActionRecord = {
        session,
        handle,
        actionId,
        total: proposal.data.plan.steps.length,
        cursor: 0,
        progress: []
      }
      actions.set(handle, action)
      const slot: Slot = {
        session,
        action,
        generation,
        abort: new AbortController(),
        captureResult: deferred<PreviewResult>(),
        state: 'capturing',
        capturePending: true,
        decisionPending: false,
        callerResolved: false
      }
      action.slot = slot
      session.current = slot
      unsettled.add(slot)
      slot.timer = setTimeout(() => {
        if (slot.capturePending) terminate(slot, 'TIMEOUT', 'failed')
      }, FIGPLUGIN_NATIVE_RUNTIME_CAPTURE_TIMEOUT_MS)
      slot.timer.unref?.()
      // runCapture invokes only trusted main callbacks and retains the slot synchronously first.
      void runCapture(slot, proposal.data)
      return slot.captureResult.promise
    },

    preparePreview(sessionInput: unknown, proposalInput: unknown): Promise<PreviewResult> {
      return runtime.capturePreview(sessionInput, proposalInput)
    },

    requestDecision(sessionInput: unknown, actionInput: unknown): Promise<DecisionResult> {
      const found = lookup(sessionInput, actionInput)
      if (isFailure(found)) return Promise.resolve(found)
      const { action } = found
      const slot = action.slot
      if (!slot) return Promise.resolve(failure(action.code ?? 'INVALID_ACTION'))
      if (!active(slot)) return Promise.resolve(failure(slot.code ?? 'REVOKED'))
      if (slot.state !== 'awaiting-write-consent')
        return Promise.resolve(
          failure(slot.state === 'approved' ? 'ALREADY_DECIDED' : 'INVALID_ACTION')
        )
      if (slot.decisionPending) return Promise.resolve(failure('BUSY'))
      slot.decisionPending = true
      slot.decisionResult = deferred<DecisionResult>()
      void runDecision(slot)
      return slot.decisionResult.promise
    },

    cancel(sessionInput: unknown, actionInput?: unknown): ControlResult {
      if (!sessionInput || typeof sessionInput !== 'object') return failure('INVALID_SESSION')
      const session = sessions.get(sessionInput)
      if (!session) return failure('INVALID_SESSION')
      const selected = actionInput ?? session.current?.action.handle
      if (!selected) return failure('NO_ACTION')
      const found = lookup(sessionInput, selected)
      if (isFailure(found)) return found
      const { action } = found
      if (!action.slot) return failure(action.code ?? 'INVALID_ACTION')
      if (!active(action.slot)) return failure(action.code ?? 'REVOKED')
      terminate(action.slot, 'CANCELLED', 'cancelled')
      return failure('CANCELLED')
    },

    revoke(sessionInput?: unknown): ControlResult {
      if (sessionInput === undefined) {
        invalidate()
        return failure('REVOKED')
      }
      if (!sessionInput || typeof sessionInput !== 'object') return failure('INVALID_SESSION')
      const session = sessions.get(sessionInput)
      if (!session) return failure('INVALID_SESSION')
      session.revoked = true
      session.generation = -1
      if (session.current) terminate(session.current, 'REVOKED')
      return failure('REVOKED')
    },

    getStatus(sessionInput: unknown, actionInput: unknown): FigPluginNativeStatusResult {
      const found = lookup(sessionInput, actionInput)
      if (isFailure(found)) return found
      const { action } = found
      const status = action.slot ? statusFor(action.slot) : action.status
      return status ? { ok: true, status } : failure('INVALID_ACTION')
    },

    getProgress(sessionInput: unknown, actionInput: unknown): FigPluginNativeProgressResult {
      const found = lookup(sessionInput, actionInput)
      if (isFailure(found)) return found
      const { action } = found
      if (!action.preview || !action.payloadSha256) return failure('INVALID_ACTION')
      const progress = freeze({
        domain: FIGPLUGIN_NATIVE_COMMAND_DOMAIN,
        version: 1 as const,
        actionId: action.actionId,
        payloadSha256: action.payloadSha256,
        host: action.preview.intent.host,
        command: FIGPLUGIN_NATIVE_COMMAND,
        purpose: 'native-command-progress' as const,
        total: action.total,
        cursor: action.cursor,
        events: [...action.progress]
      })
      return { ok: true, progress }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      generation += 1
      const removeSubscription = unsubscribe
      unsubscribe = undefined
      try {
        removeSubscription?.()
      } catch {
        // Subscription cleanup failure must not block revocation/abort of pending callers.
        // Do not expose a raw callback exception, which can contain private host metadata.
      } finally {
        for (const slot of [...unsettled]) terminate(slot, 'REVOKED')
      }
    }
  }

  return runtime
}

export type FigPluginNativeCommandRuntime = ReturnType<typeof createFigPluginNativeCommandRuntime>
