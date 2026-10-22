import { z } from 'zod'
import {
  hostContextSchema,
  hostPlanSchema,
  nodeValue,
  stepValue,
  validateHostPlanExecution,
  type HostContext,
  type HostPlan
} from './hostPlan'
import { canonicalFigPluginJson } from './manifest'

const hex32 = z.string().regex(/^[a-f0-9]{32}$/)
const ids = z
  .array(z.string().min(1).max(128))
  .min(1)
  .max(20)
  .refine(
    (values) =>
      new Set(values).size === values.length &&
      values.every((value, index) => [...values].sort()[index] === value),
    'Recovery targets must be sorted and unique'
  )
export const figPluginTaskRecoverySchema = z
  .object({
    baselineId: hex32,
    sourceExecutionId: hex32,
    requestId: hex32,
    round: z.number().int().min(1).max(3),
    maxCorrectionRounds: z.literal(3),
    targetIds: ids
  })
  .strict()
export type FigPluginTaskRecovery = z.output<typeof figPluginTaskRecoverySchema>
export const figPluginTaskRecoveryPrepareRequestSchema = z
  .object({
    protocol: z.literal(1),
    requestId: hex32,
    sequence: z.number().int().min(1).max(1_000_000_000),
    hostContext: hostContextSchema
  })
  .strict()
  .refine((value) => value.hostContext.captureId === value.requestId, 'Recovery capture mismatch')
export const figPluginTaskRecoveryPrepareResponseSchema = z.discriminatedUnion('status', [
  z.object({ protocol: z.literal(1), status: z.literal('unchanged'), baselineId: hex32 }).strict(),
  z
    .object({
      protocol: z.literal(1),
      status: z.literal('prepared'),
      callId: hex32,
      executionId: hex32,
      expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      recovery: figPluginTaskRecoverySchema
    })
    .strict()
])
export type FigPluginTaskRecoveryPrepareResponse = z.output<
  typeof figPluginTaskRecoveryPrepareResponseSchema
>

/** Identity constraints only: never claim this is a full document snapshot. */
export type TaskRecoveryScope = {
  host: HostContext['host']
  documentId: string
  scopeId: string
  adapterVersion: string
  targetIds: string[]
  recoveryIdentity?: string
  anchors: Array<{
    id: string
    type: string
    parentId: string | null
    ancestors: Array<{ id: string; type: string }>
    children?: string[]
    fontKey?: string
  }>
}
export function captureTaskRecoveryScope(
  plan: HostPlan,
  rawContext: HostContext
): TaskRecoveryScope {
  const context = hostContextSchema.parse(rawContext)
  validateHostPlanExecution(hostPlanSchema.parse(plan), context)
  const targetIds = [...new Set(plan.steps.map((step) => step.targetId))].sort()
  const byId = new Map(context.nodes.map((node) => [node.id, node]))
  const included = new Set(targetIds)
  const layout = new Set<string>()
  const visit = (id: string) => {
    // Each layout subtree was validated above; overlapping accepted targets share anchors.
    if (layout.has(id)) return
    layout.add(id)
    included.add(id)
    const node = byId.get(id)
    if (!node?.children) throw new Error('INVALID_RECOVERY_SCOPE')
    for (const child of node.children) visit(child)
  }
  for (const step of plan.steps) if (step.command === 'layout.flow') visit(step.targetId)
  return {
    host: context.host,
    documentId: context.documentId,
    scopeId: context.scopeId,
    adapterVersion: context.execution!.adapterVersion,
    targetIds,
    ...(context.recoveryIdentity ? { recoveryIdentity: context.recoveryIdentity } : {}),
    anchors: [...included].sort().map((id) => {
      const node = byId.get(id)!
      return {
        id,
        type: node.type,
        parentId: node.parentId,
        ancestors: node.ancestors.map(({ id, type }) => ({ id, type })),
        ...(layout.has(id) ? { children: [...node.children!] } : {}),
        ...(plan.steps.some((step) => step.targetId === id && step.command === 'text.content')
          ? { fontKey: node.fontKey }
          : {})
      }
    })
  }
}

/** Reapply only properties changed by the accepted task. Current unrelated fields are preserved. */
export function prepareTaskRecoveryPlan(
  savedPlan: HostPlan,
  scope: TaskRecoveryScope,
  rawContext: HostContext
): { plan: HostPlan; unchanged: boolean } {
  const context = hostContextSchema.parse(rawContext)
  const equal = (a: unknown, b: unknown) => canonicalFigPluginJson(a) === canonicalFigPluginJson(b)
  if (
    !scope.recoveryIdentity ||
    context.recoveryIdentity !== scope.recoveryIdentity ||
    context.host !== scope.host ||
    context.documentId !== scope.documentId ||
    context.scopeId !== scope.scopeId ||
    context.execution?.adapterVersion !== scope.adapterVersion ||
    context.execution?.visualAudit !== 'hash-only' ||
    !equal([...(context.selectedIds ?? [])].sort(), scope.targetIds)
  )
    throw new Error('INVALID_RECOVERY_SCOPE')
  const byId = new Map(context.nodes.map((node) => [node.id, node]))
  for (const anchor of scope.anchors) {
    const node = byId.get(anchor.id)
    if (
      !node ||
      node.type !== anchor.type ||
      node.parentId !== anchor.parentId ||
      !equal(
        node.ancestors.map(({ id, type }) => ({ id, type })),
        anchor.ancestors
      ) ||
      (anchor.children !== undefined && !equal(node.children, anchor.children)) ||
      (Object.hasOwn(anchor, 'fontKey') && node.fontKey !== anchor.fontKey)
    )
      throw new Error('STALE_RECOVERY_SCOPE')
  }
  const plan = hostPlanSchema.parse({ ...savedPlan, captureId: context.captureId })
  validateHostPlanExecution(plan, context)
  if (!equal([...new Set(plan.steps.map((step) => step.targetId))].sort(), scope.targetIds))
    throw new Error('INVALID_RECOVERY_SCOPE')
  return {
    plan,
    unchanged: plan.steps.every((step) =>
      equal(nodeValue(byId.get(step.targetId)!, step.command), stepValue(step))
    )
  }
}
