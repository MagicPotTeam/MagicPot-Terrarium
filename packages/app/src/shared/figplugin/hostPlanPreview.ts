import {
  hostContextSchema,
  parseHostPlan,
  nodeValue,
  stepValue,
  utf8Size,
  validateHostPlanExecution,
  type HostContext,
  type HostPlan
} from './hostPlan'
import type { FigPluginPlanningAssetMetadata } from './hostPlanningAssets'
import { recoveryImageTarget, type FigPluginRecoveryExecutionImages } from './hostImageRecovery'

export type HostPlanningPreview = {
  kind: 'host-plan-preview'
  executable: boolean
  plan: HostPlan
  risk: 'low' | 'medium' | 'high'
  differences: Array<{ targetId: string; command: string; before: unknown; after: unknown }>
  execution?: {
    mode: 'native-write'
    adapterVersion: string
    rollback: 'verified-in-place' | 'native-history' | 'none'
    visualAudit: 'hash-only' | 'unavailable'
    requiresWriteApproval: true
  }
}

/** Stateless planning only. The host must revalidate any future execution separately. */
export function createHostPlanningPreview(
  content: string,
  rawContext: HostContext,
  resources?: readonly FigPluginPlanningAssetMetadata[],
  imageRecovery?: FigPluginRecoveryExecutionImages
): HostPlanningPreview {
  const context = hostContextSchema.parse(rawContext)
  const plan = parseHostPlan(content, context, resources, imageRecovery)
  const differences = plan.steps.map((step) => {
    const node = context.nodes.find((item) => item.id === step.targetId)!
    const before = nodeValue(node, step.command)
    const desired =
      step.command === 'image.pixels'
        ? recoveryImageTarget(imageRecovery, step.targetId, step.command)
        : undefined
    const after =
      desired?.command === 'image.pixels'
        ? { ...(stepValue(step) as object), acceptedPixels: desired.acceptedEvidence }
        : stepValue(step)
    if (before === undefined || after === undefined) throw new Error('INCOMPLETE_CONTEXT')
    return { targetId: node.id, command: step.command, before, after }
  })
  if (differences.every((row) => JSON.stringify(row.before) === JSON.stringify(row.after)))
    throw new Error('NO_CHANGES')
  const executable = context.execution?.mode === 'native-write'
  if (executable) validateHostPlanExecution(plan, context, resources, imageRecovery)
  const preview: HostPlanningPreview = {
    kind: 'host-plan-preview',
    executable,
    plan,
    risk:
      differences.some((row) =>
        ['layout.flow', 'image.fill', 'image.pixels'].includes(row.command)
      ) || differences.length > 3
        ? 'high'
        : differences.length > 1 || differences.some((row) => row.command !== 'node.rename')
          ? 'medium'
          : 'low',
    differences,
    ...(context.execution
      ? {
          execution: {
            mode: context.execution.mode,
            adapterVersion: context.execution.adapterVersion,
            rollback: plan.steps.some((step) => step.command === 'image.pixels')
              ? 'native-history'
              : context.execution.rollback,
            visualAudit: context.execution.visualAudit,
            requiresWriteApproval: true as const
          }
        }
      : {})
  }
  if (utf8Size(JSON.stringify(preview)) > 32 * 1024) throw new Error('PREVIEW_TOO_LARGE')
  return preview
}
