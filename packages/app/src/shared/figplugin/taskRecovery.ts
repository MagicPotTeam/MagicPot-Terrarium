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
import {
  figPluginRecoveryExecutionImagesSchema,
  type FigPluginRecoveryExecutionImages
} from './hostImageRecovery'
import type { FigPluginPlanningAssetMetadata } from './hostPlanningAssets'

const hex32 = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
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
const photoshopDocumentId = z
  .string()
  .max(16)
  .regex(/^[1-9][0-9]*$(?![\s\S])/)
  .refine((value) => Number.isSafeInteger(Number(value)), 'Invalid Photoshop document ID')
export const taskRecoveryDocumentRebindSchema = z
  .object({
    host: z.literal('photoshop'),
    previousDocumentId: photoshopDocumentId,
    nextDocumentId: photoshopDocumentId
  })
  .strict()
  .refine(
    (value) => value.previousDocumentId !== value.nextDocumentId,
    'Unchanged Photoshop document ID'
  )

export const taskRecoveryRebindSchema = z
  .object({
    previousIdentity: hex32,
    nextIdentity: hex32,
    document: taskRecoveryDocumentRebindSchema.optional()
  })
  .strict()
  .refine((value) => value.previousIdentity !== value.nextIdentity, 'Unchanged recovery identity')
export type TaskRecoveryRebind = z.output<typeof taskRecoveryRebindSchema>

// Read-only summaries for the trusted desktop. No saved property values or credentials.
export const savedTaskCheckpointSchema = z
  .object({
    baselineId: hex32,
    pluginId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(160),
    host: z.enum(['figma', 'photoshop']),
    documentId: z.string().min(1).max(128),
    scopeId: z.string().min(1).max(128),
    targetIds: ids,
    acceptedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    correctionRoundsUsed: z.number().int().min(0).max(3),
    maxCorrectionRounds: z.literal(3)
  })
  .strict()
  .refine((value) => value.expiresAt > value.acceptedAt, 'Invalid checkpoint expiry')
export const savedTaskCheckpointsSchema = z.array(savedTaskCheckpointSchema).max(16)
export type SavedTaskCheckpoint = z.output<typeof savedTaskCheckpointSchema>

export const figPluginTaskRecoverySchema = z
  .object({
    baselineId: hex32,
    sourceExecutionId: hex32,
    requestId: hex32,
    round: z.number().int().min(1).max(3),
    maxCorrectionRounds: z.literal(3),
    targetIds: ids,
    rebind: taskRecoveryRebindSchema.optional(),
    images: figPluginRecoveryExecutionImagesSchema.optional()
  })
  .strict()
export type FigPluginTaskRecovery = z.output<typeof figPluginTaskRecoverySchema>
export const figPluginTaskRecoveryPrepareRequestSchema = z
  .object({
    protocol: z.literal(1),
    requestId: hex32,
    sequence: z.number().int().min(1).max(1_000_000_000),
    hostContext: hostContextSchema,
    // Explicitly selected by the user; never inferred from matching node IDs.
    rebindBaselineId: hex32.optional(),
    // Explicit user intent, never inferred from a newly captured document number.
    reopenDocument: z.literal(true).optional()
  })
  .strict()
  .refine((value) => value.hostContext.captureId === value.requestId, 'Recovery capture mismatch')
  .refine(
    (value) =>
      value.reopenDocument !== true ||
      (value.rebindBaselineId !== undefined &&
        value.hostContext.host === 'photoshop' &&
        value.hostContext.scopeId === value.hostContext.documentId),
    'Explicit Photoshop checkpoint selection required'
  )
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
  rawContext: HostContext,
  resources?: readonly FigPluginPlanningAssetMetadata[]
): TaskRecoveryScope {
  const context = hostContextSchema.parse(rawContext)
  validateHostPlanExecution(hostPlanSchema.parse(plan), context, resources)
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

/** Reassociation is explicit user selection, not a proof of file identity. Photoshop's
 * Document.id is valid only while open. The optional exception changes that root only;
 * layer IDs, parent chains, text/font and command checks remain exact. */
export function createTaskRecoveryRebind(
  scope: TaskRecoveryScope,
  context: HostContext,
  allowReopenedDocument = false
): TaskRecoveryRebind | undefined {
  if (!scope.recoveryIdentity || !context.recoveryIdentity)
    throw new Error('INVALID_RECOVERY_SCOPE')
  let document: z.output<typeof taskRecoveryDocumentRebindSchema> | undefined
  if (scope.documentId !== context.documentId || scope.scopeId !== context.scopeId) {
    if (
      !allowReopenedDocument ||
      scope.host !== 'photoshop' ||
      context.host !== 'photoshop' ||
      scope.scopeId !== scope.documentId ||
      context.scopeId !== context.documentId
    )
      throw new Error('INVALID_RECOVERY_SCOPE')
    document = taskRecoveryDocumentRebindSchema.parse({
      host: 'photoshop',
      previousDocumentId: scope.documentId,
      nextDocumentId: context.documentId
    })
  }
  if (scope.recoveryIdentity === context.recoveryIdentity) {
    if (document) throw new Error('INVALID_RECOVERY_SCOPE')
    return undefined
  }
  return taskRecoveryRebindSchema.parse({
    previousIdentity: scope.recoveryIdentity,
    nextIdentity: context.recoveryIdentity,
    ...(document ? { document } : {})
  })
}

/** Pure projection for preview/transaction validation; does not mutate persisted data. */
export function applyTaskRecoveryRebind(
  scope: TaskRecoveryScope,
  value: TaskRecoveryRebind
): TaskRecoveryScope {
  const rebind = taskRecoveryRebindSchema.parse(value)
  if (scope.recoveryIdentity !== rebind.previousIdentity) throw new Error('STALE_RECOVERY_SCOPE')
  if (
    rebind.document &&
    (scope.host !== 'photoshop' ||
      scope.documentId !== rebind.document.previousDocumentId ||
      scope.scopeId !== scope.documentId)
  )
    throw new Error('STALE_RECOVERY_SCOPE')
  return {
    ...scope,
    recoveryIdentity: rebind.nextIdentity,
    ...(rebind.document
      ? { documentId: rebind.document.nextDocumentId, scopeId: rebind.document.nextDocumentId }
      : {})
  }
}

/** Reapply only properties changed by the accepted task. Current unrelated fields are preserved. */
export function prepareTaskRecoveryPlan(
  savedPlan: HostPlan,
  scope: TaskRecoveryScope,
  rawContext: HostContext,
  imageRecovery?: FigPluginRecoveryExecutionImages
): { plan: HostPlan; unchanged: boolean } {
  const images = imageRecovery && figPluginRecoveryExecutionImagesSchema.parse(imageRecovery)
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
  const plan = hostPlanSchema.parse({
    ...savedPlan,
    captureId: context.captureId,
    steps: savedPlan.steps.map((step) => {
      if (step.command !== 'image.fill' && step.command !== 'image.pixels') return step
      const binding = images?.assetBindings.find(
        (binding) => binding.sourceAssetId === step.assetId
      )
      if (!binding) throw new Error('IMAGE_RECOVERY_UNBOUND')
      return { ...step, assetId: binding.assetId }
    })
  })
  const resources = images?.manifest.assets.map((asset) => ({
    ...asset,
    assetId: images.assetBindings.find((binding) => binding.sourceAssetId === asset.assetId)!
      .assetId,
    expiresAt: Number.MAX_SAFE_INTEGER
  }))
  validateHostPlanExecution(plan, context, resources, images)
  if (!equal([...new Set(plan.steps.map((step) => step.targetId))].sort(), scope.targetIds))
    throw new Error('INVALID_RECOVERY_SCOPE')
  return {
    plan,
    // History IDs, fingerprints and thumbnails do not prove exact accepted image state.
    unchanged: plan.steps.every(
      (step) =>
        step.command !== 'image.fill' &&
        step.command !== 'image.pixels' &&
        equal(nodeValue(byId.get(step.targetId)!, step.command), stepValue(step))
    )
  }
}
