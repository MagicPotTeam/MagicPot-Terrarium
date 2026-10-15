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

// Main-owned contract only. No real/native adapter, registration, transport or write route exists.
// A descriptor is a trusted implementation contract, never authentication of a bearer host.
const id = z.string().min(1).max(128)
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
    .strict()
])
export type FigPluginAdapterDescriptor = z.output<typeof descriptorSchema>
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
  // Steps are fixed at acquisition. No arbitrary dispatch, new targets or scripts are accepted.
  applyNext(signal: AbortSignal): Promise<void>
  // Revisions must not be reused when state changes, including recovery. They are not
  // content hashes and undo must never restore an earlier revision along with earlier names.
  commit(signal: AbortSignal): Promise<{ revision: string }>
  undo(signal: AbortSignal): Promise<{ revision: string }>
  readback(signal: AbortSignal): Promise<FigPluginRenameSnapshot>
  close(): Promise<void>
}
export interface FigPluginHostAdapter {
  readonly descriptor: FigPluginAdapterDescriptor
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
