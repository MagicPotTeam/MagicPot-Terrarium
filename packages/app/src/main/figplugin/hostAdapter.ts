import { randomBytes } from 'node:crypto'
import { types } from 'node:util'
import { z } from 'zod'
import {
  FIGPLUGIN_PLAN_MAX_BYTES,
  FIGPLUGIN_PLAN_MAX_STEPS,
  figPluginPlanSchema,
  snapshotFigPluginPlanData,
  type FigPluginPlan,
  type FigPluginPlanErrorCode
} from '@shared/figplugin/plan'

// Main-owned contract only. Adapters are registered by the main process, never by the bearer
// transport. A descriptor is a trusted implementation contract, never authentication of a host.
const id = z.string().min(1).max(128)
type FigPluginAdapterCommand = FigPluginPlan['steps'][number]['command']
const adapterCommands = ['node.rename'] as const satisfies readonly FigPluginAdapterCommand[]
const descriptorFields = {
  contractVersion: z.literal(1),
  implementationVersion: z.string().min(1).max(64),
  instanceEpoch: z.string().regex(/^[a-f0-9]{32}$(?![\s\S])/)
}
const descriptorSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...descriptorFields, kind: z.literal('unavailable'), capabilities: z.tuple([]) })
    .strict(),
  z
    .object({
      ...descriptorFields,
      kind: z.literal('synthetic'),
      capabilities: z.tuple([z.literal('node.rename')]),
      isolation: z.literal('compare-acquire-through-readback'),
      rollback: z.literal('transaction-only'),
      revision: z.literal('all-relevant-mutations')
    })
    .strict(),
  // Production adapters must identify the real host they own. The registry below accepts only
  // this branch; synthetic and unavailable descriptors remain useful for tests and fail closed
  // at the production boundary.
  z
    .object({
      ...descriptorFields,
      kind: z.literal('native'),
      host: z.enum(['figma', 'photoshop']),
      capabilities: z
        .array(z.enum(adapterCommands))
        .min(1)
        .max(adapterCommands.length)
        .refine((values) => new Set(values).size === values.length),
      isolation: z.literal('compare-acquire-through-readback'),
      rollback: z.literal('transaction-only'),
      revision: z.literal('all-relevant-mutations')
    })
    .strict()
])
export type FigPluginAdapterDescriptor = z.output<typeof descriptorSchema>
export type FigPluginNativeAdapterDescriptor = Extract<
  FigPluginAdapterDescriptor,
  { kind: 'native' }
>
export type FigPluginAdapterCapabilityError = 'ADAPTER_UNAVAILABLE' | 'UNSUPPORTED_COMMAND'
export type FigPluginAdapterCapabilityState =
  | { state: 'unavailable'; code: 'ADAPTER_UNAVAILABLE' }
  | { state: 'unsupported'; code: 'UNSUPPORTED_COMMAND'; missing: readonly string[] }
  | { state: 'ready'; capabilities: readonly FigPluginPlan['steps'][number]['command'][] }

/**
 * Normalize a capability declaration before it is compared with a plan. Unknown and repeated
 * entries are rejected rather than deduplicated: a malformed declaration must never become a
 * broader authority by normalization. The returned list is detached, sorted and immutable.
 */
export const normalizeFigPluginAdapterCapabilities = (
  raw: unknown
): readonly FigPluginAdapterCommand[] | undefined => {
  try {
    if (!Array.isArray(raw) || raw.length > adapterCommands.length) return undefined
    const result: FigPluginAdapterCommand[] = []
    const seen = new Set<string>()
    for (const value of raw) {
      if (
        typeof value !== 'string' ||
        !(adapterCommands as readonly string[]).includes(value) ||
        seen.has(value)
      )
        return undefined
      seen.add(value)
      result.push(value as FigPluginAdapterCommand)
    }
    result.sort()
    return Object.freeze(result)
  } catch {
    return undefined
  }
}

/**
 * Return an explicit capability state for a plan/adapter boundary. This is intentionally
 * separate from host-context command declarations: a plan may execute only when the main-owned
 * adapter itself is available and declares every command. Any malformed input fails closed.
 */
export const inspectFigPluginAdapterCapabilityState = (
  descriptor: FigPluginAdapterDescriptor,
  plan: FigPluginPlan
): FigPluginAdapterCapabilityState => {
  try {
    if (!descriptor || !['synthetic', 'native'].includes(descriptor.kind))
      return { state: 'unavailable', code: 'ADAPTER_UNAVAILABLE' }
    const capabilities = normalizeFigPluginAdapterCapabilities(descriptor.capabilities)
    if (!capabilities?.length) return { state: 'unavailable', code: 'ADAPTER_UNAVAILABLE' }
    const steps = plan && typeof plan === 'object' ? plan.steps : undefined
    if (!Array.isArray(steps) || !steps.length)
      return { state: 'unavailable', code: 'ADAPTER_UNAVAILABLE' }
    const missing = new Set<string>()
    for (const step of steps) {
      let command: unknown
      try {
        command =
          step && typeof step === 'object' ? (step as { command?: unknown }).command : undefined
      } catch {
        return { state: 'unavailable', code: 'ADAPTER_UNAVAILABLE' }
      }
      if (
        typeof command !== 'string' ||
        !(adapterCommands as readonly string[]).includes(command) ||
        !capabilities.includes(command as FigPluginAdapterCommand)
      )
        missing.add(typeof command === 'string' ? command : '<invalid-command>')
    }
    if (missing.size)
      return {
        state: 'unsupported',
        code: 'UNSUPPORTED_COMMAND',
        missing: Object.freeze([...missing].sort())
      }
    return { state: 'ready', capabilities }
  } catch {
    return { state: 'unavailable', code: 'ADAPTER_UNAVAILABLE' }
  }
}
const ancestorSchema = z.object({ id, parentId: id.nullable(), locked: z.boolean() }).strict()
const targetSchema = z
  .object({
    id,
    type: z.string().min(1).max(64),
    // Full value, not a v1 display label. Overflow rejects the whole snapshot, never truncates.
    name: z
      .string()
      .max(4096)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 4096),
    parentId: id.nullable(),
    locked: z.boolean(),
    ancestors: z.array(ancestorSchema).max(32),
    effectiveLocked: z.boolean(),
    renameAllowed: z.boolean()
  })
  .strict()
const snapshotSchema = z
  .object({
    complete: z.literal(true),
    document: z.object({ id, openEpoch: id, revision: id }).strict(),
    selection: z
      .object({
        revision: id,
        ids: z
          .array(id)
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length)
      })
      .strict(),
    targets: z
      .array(targetSchema)
      .max(FIGPLUGIN_PLAN_MAX_STEPS)
      .refine((targets) => new Set(targets.map((target) => target.id)).size === targets.length)
  })
  .strict()
export type FigPluginRenameSnapshot = z.output<typeof snapshotSchema>
export type FigPluginRenameSnapshotError =
  FigPluginPlanErrorCode | 'INVALID_SNAPSHOT' | 'TARGET_NOT_WRITABLE'

/**
 * Main-owned transaction lifecycle.  Host implementations may perform their own finer-grained
 * work, but the bridge only permits this bounded order of operations.  In particular, recovery
 * is a distinct phase and closing is terminal; an aborted signal alone is not a recovery proof.
 */
export type FigPluginRenameTransactionPhase =
  | 'acquired'
  | 'applying'
  | 'committing'
  | 'committed'
  | 'reading'
  | 'recovering'
  | 'closing'
  | 'closed'

const transactionTransitions: Readonly<
  Record<FigPluginRenameTransactionPhase, readonly FigPluginRenameTransactionPhase[]>
> = Object.freeze({
  acquired: Object.freeze(['applying', 'recovering', 'closing'] as const),
  applying: Object.freeze(['applying', 'committing', 'recovering', 'closing'] as const),
  committing: Object.freeze(['committed', 'recovering', 'closing'] as const),
  committed: Object.freeze(['reading', 'recovering', 'closing'] as const),
  reading: Object.freeze(['reading', 'recovering', 'closing'] as const),
  recovering: Object.freeze(['reading', 'recovering', 'closing'] as const),
  closing: Object.freeze(['closed'] as const),
  closed: Object.freeze([] as const)
})

/** Return whether a transaction phase transition is valid at the bridge boundary. */
export const isFigPluginRenameTransactionTransition = (
  from: FigPluginRenameTransactionPhase,
  to: FigPluginRenameTransactionPhase
): boolean => transactionTransitions[from]?.includes(to) ?? false

/**
 * Bind the main-owned adapter declaration to the already validated plan. An unavailable
 * descriptor never becomes executable, and a synthetic descriptor cannot imply commands that
 * are not explicitly declared. This check is deliberately narrow: it does not add commands or
 * treat a host context's advertised commands as proof of a live adapter.
 */
export const validateFigPluginAdapterCapabilities = (
  descriptor: FigPluginAdapterDescriptor,
  plan: FigPluginPlan
): { ok: true } | { ok: false; code: FigPluginAdapterCapabilityError } => {
  const state = inspectFigPluginAdapterCapabilityState(descriptor, plan)
  return state.state === 'ready' ? { ok: true } : { ok: false, code: state.code }
}

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

export const readFigPluginAdapterDescriptor = (
  raw: unknown
): FigPluginAdapterDescriptor | undefined => {
  const input = snapshotFigPluginPlanData(raw, 2048, types.isProxy)
  if (!input.ok) return undefined
  const parsed = descriptorSchema.safeParse(input.data)
  return parsed.success ? freeze(parsed.data) : undefined
}

/**
 * Structural/precondition validation of a supplied full snapshot. This cannot prove the adapter
 * actually observed a live document. Native revision/isolation/lock guarantees require separate
 * implementation and real-host evidence before any real adapter can be enabled.
 */
export const checkFigPluginRenameSnapshot = (
  raw: unknown,
  proposal: unknown
):
  | { ok: true; snapshot: FigPluginRenameSnapshot }
  | { ok: false; code: FigPluginRenameSnapshotError } => {
  const input = snapshotFigPluginPlanData(proposal, FIGPLUGIN_PLAN_MAX_BYTES, types.isProxy)
  if (!input.ok)
    return { ok: false, code: input.code === 'TOO_LARGE' ? 'PLAN_TOO_LARGE' : 'INVALID_PLAN' }
  const plan = figPluginPlanSchema.safeParse(input.data)
  if (!plan.success) return { ok: false, code: 'INVALID_PLAN' }
  if (new Set(plan.data.steps.map((step) => step.targetId)).size !== plan.data.steps.length)
    return { ok: false, code: 'DUPLICATE_TARGET' }
  const data = snapshotFigPluginPlanData(raw, 64 * 1024, types.isProxy)
  if (!data.ok) return { ok: false, code: 'INVALID_SNAPSHOT' }
  const parsed = snapshotSchema.safeParse(data.data)
  if (!parsed.success) return { ok: false, code: 'INVALID_SNAPSHOT' }
  const snapshot = parsed.data
  // Cross-target ancestor facts must agree; repeated ancestors cannot have contradictory locks.
  const facts = new Map<string, { parentId: string | null; locked: boolean }>()
  for (const target of snapshot.targets) {
    const seen = new Set([target.id])
    let expectedParent = target.parentId
    for (const ancestor of target.ancestors) {
      if (ancestor.id !== expectedParent || seen.has(ancestor.id))
        return { ok: false, code: 'INVALID_SNAPSHOT' }
      seen.add(ancestor.id)
      expectedParent = ancestor.parentId
    }
    if (
      expectedParent !== null ||
      target.effectiveLocked !==
        (target.locked || target.ancestors.some((ancestor) => ancestor.locked))
    )
      return { ok: false, code: 'INVALID_SNAPSHOT' }
    for (const node of [target, ...target.ancestors]) {
      const previous = facts.get(node.id)
      if (previous && (previous.parentId !== node.parentId || previous.locked !== node.locked))
        return { ok: false, code: 'INVALID_SNAPSHOT' }
      facts.set(node.id, { parentId: node.parentId, locked: node.locked })
    }
  }
  if (snapshot.selection.revision !== plan.data.selectionRevision)
    return { ok: false, code: 'STALE_CONTEXT' }
  if (snapshot.targets.length !== plan.data.steps.length) return { ok: false, code: 'OUT_OF_SCOPE' }
  const selection = new Set(snapshot.selection.ids)
  for (const [index, step] of plan.data.steps.entries()) {
    const target = snapshot.targets[index]
    if (target.id !== step.targetId || !selection.has(target.id))
      return { ok: false, code: 'OUT_OF_SCOPE' }
    if (target.effectiveLocked) return { ok: false, code: 'LOCKED_TARGET' }
    if (!target.renameAllowed) return { ok: false, code: 'TARGET_NOT_WRITABLE' }
  }
  return { ok: true, snapshot: freeze(snapshot) }
}

export interface FigPluginRenameTransaction {
  /**
   * Best-effort host cancellation for modal or non-abortable work.  The bridge still verifies
   * readback after cancellation and never treats this callback as proof that no write happened.
   */
  cancel?(signal: AbortSignal): Promise<void>
  // Steps are fixed at acquisition. No arbitrary dispatch, new targets or scripts are accepted.
  applyNext(signal: AbortSignal): Promise<void>
  // Revisions must not be reused when state changes, including recovery. They are not
  // content hashes and undo must never restore an earlier revision along with earlier names.
  commit(signal: AbortSignal): Promise<{ revision: string }>
  undo(signal: AbortSignal): Promise<{ revision: string }>
  readback(signal: AbortSignal): Promise<FigPluginRenameSnapshot>
  close(): Promise<void>
}

/** Notify modal/non-abortable host work immediately, without racing it against recovery.
 * The execution still waits for the original operation and cancellation to settle before
 * undo/readback. Cancellation gets its own bounded, initially live signal. */
export const bindFigPluginRenameTransactionCancellation = (
  transaction: FigPluginRenameTransaction,
  signal: AbortSignal,
  timeoutMs = 10_000
): { dispose: () => void; wasRequested: () => boolean; settled: () => Promise<void> } => {
  let requested = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let pending = Promise.resolve()
  let resolvePending: (() => void) | undefined
  const request = (): void => {
    if (disposed || requested || !transaction.cancel) return
    requested = true
    controller = new AbortController()
    const cancelSignal = controller.signal
    pending = new Promise<void>((resolve) => {
      resolvePending = resolve
    })
    timer = setTimeout(
      () => {
        controller?.abort()
        resolvePending?.()
        resolvePending = undefined
      },
      Math.max(1, timeoutMs)
    )
    timer.unref?.()
    void (async () => {
      try {
        await transaction.cancel?.(cancelSignal)
      } catch {
        /* Host cancellation is advisory; execution readback remains authoritative. */
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        controller = undefined
        resolvePending?.()
        resolvePending = undefined
      }
    })()
  }
  if (signal.aborted) request()
  else signal.addEventListener('abort', request, { once: true })
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      signal.removeEventListener('abort', request)
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      controller?.abort()
      controller = undefined
      resolvePending?.()
      resolvePending = undefined
    },
    wasRequested: () => requested,
    settled: () => pending
  }
}

/** Close a host transaction without allowing a broken plugin teardown to hold the executor. */
export const closeFigPluginRenameTransaction = async (
  transaction: FigPluginRenameTransaction,
  timeoutMs = 10_000
): Promise<boolean> => {
  const closeWork = Promise.resolve()
    .then(() => transaction.close())
    .then(
      () => true,
      () => false
    )
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs))
    timer.unref?.()
  })
  try {
    return await Promise.race([closeWork, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
export interface FigPluginHostAdapter {
  readonly descriptor: FigPluginAdapterDescriptor
  /** Optional main-owned teardown invoked when a production adapter is unregistered. */
  dispose?(): Promise<void>
  // Requested IDs are not authorization: independently resolve the complete selected scope.
  capture(targetIds: readonly string[], signal: AbortSignal): Promise<FigPluginRenameSnapshot>
  // Must compare/acquire inside the transaction, deny interleaving, and recheck scope/locks.
  // Undo is scoped ONLY to this transaction. Capture nonces/global Undo are insufficient.
  beginRename(
    attemptId: string,
    expected: FigPluginRenameSnapshot,
    steps: readonly FigPluginPlan['steps'][number][],
    signal: AbortSignal
  ): Promise<FigPluginRenameTransaction>
}

export const createUnavailableFigPluginHostAdapter = (): FigPluginHostAdapter => {
  const unavailable = async (): Promise<never> => {
    throw new Error('HOST_ADAPTER_UNAVAILABLE')
  }
  return freeze({
    descriptor: {
      contractVersion: 1 as const,
      implementationVersion: 'unavailable-1',
      instanceEpoch: randomBytes(16).toString('hex'),
      kind: 'unavailable' as const,
      capabilities: [] as []
    },
    capture: unavailable,
    beginRename: unavailable
  })
}
