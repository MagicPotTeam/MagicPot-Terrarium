export {
  figmaTypography,
  photoshopTypography,
  typographyFontKey,
  requiredFigmaFonts
} from './hostTypography'
export { figmaAppearance, photoshopTextAppearance } from './hostAppearance'
export {
  validateRecoveryExecutionImages,
  recoveryImageTarget,
  recoveryImagesManifestContent
} from './hostImageRecovery'
export {
  validateNativeImageGenerationReceipt,
  validateNativeImageGenerationStatus,
  type NativeImageGenerationReceiptIdentity,
  type NativeImageGenerationStatusIdentity
} from './hostImageGenerationClient'
import { checkFigPluginSelectionSnapshot } from './selectionSnapshot'
import {
  createHostPlanReadback,
  escapePlanningDisplay,
  hostContextSchema,
  hostPlanSchema,
  utf8Size,
  validateHostPlanExecution,
  validateHostPlanReadback,
  type HostContext,
  type HostPlan
} from './hostPlan'
import { createHostPlanningPreview } from './hostPlanPreview'
import { assertHostPlanCompatibility } from './hostCompatibility'
import type { FigPluginPlanningAssetMetadata } from './hostPlanningAssets'
import type { FigPluginRecoveryExecutionImages } from './hostImageRecovery'

/** Converts an existing local read-only observation into a name-planning request.
 * It does not mint native capabilities: every returned preview stays non-executable.
 * No geometry, opacity, child list, font, text or image content is invented. */
export function fromSelectionSnapshot(input: unknown, captureId: string): HostContext {
  const checked = checkFigPluginSelectionSnapshot(input)
  if (!checked.ok) throw new Error('INVALID_SNAPSHOT')
  const source = checked.snapshot
  const nodes = new Map(source.nodes.map((node) => [node.id, node]))
  return hostContextSchema.parse({
    version: 1,
    host: source.host,
    documentId: source.document.id,
    scopeId: source.document.pageId ?? source.document.id,
    captureId,
    nodes: source.selected.map((selection) => {
      const node = nodes.get(selection.id)!
      return {
        id: node.id,
        type: node.kind,
        name: node.name,
        parentId: node.parentId,
        ancestors: selection.ancestors.map((id) => {
          const ancestor = nodes.get(id)!
          return { id, type: ancestor.kind, locked: ancestor.locked === true }
        }),
        locked: node.locked === true,
        visible: selection.effectiveVisible,
        // Planning vocabulary only; the actual host executor is not enabled.
        commands: selection.effectiveLocked ? [] : ['node.rename']
      }
    })
  })
}

export function reviewPlanningResult(
  content: string,
  context: HostContext,
  resources?: readonly FigPluginPlanningAssetMetadata[]
): string {
  if (typeof content !== 'string' || content.length > 32 * 1024 || utf8Size(content) > 32 * 1024)
    throw new Error('INVALID_PREVIEW')
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // Model output is untrusted input; keep malformed JSON on the bounded preview error path.
    throw new Error('INVALID_PREVIEW')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('INVALID_PREVIEW')
  const result = parsed as Record<string, unknown>
  const keys = Object.keys(result).sort().join(',')
  if (
    ![
      'differences,executable,kind,plan,risk',
      'differences,executable,execution,kind,plan,risk'
    ].includes(keys) ||
    result.kind !== 'host-plan-preview' ||
    typeof result.executable !== 'boolean'
  )
    throw new Error('INVALID_PREVIEW')
  const checked = createHostPlanningPreview(JSON.stringify(result.plan), context, resources)
  if (
    checked.executable !== result.executable ||
    checked.risk !== result.risk ||
    JSON.stringify(checked.differences) !== JSON.stringify(result.differences) ||
    JSON.stringify(checked.execution) !== JSON.stringify(result.execution)
  )
    throw new Error('INVALID_PREVIEW')
  return (
    (checked.executable
      ? 'PLAN READY — waiting for separate desktop write approval. No document changes were made.\n'
      : 'PLAN PREVIEW ONLY — no document changes were made.\n') +
    'Risk: ' +
    checked.risk +
    (checked.executable && checked.execution
      ? '\nRollback: ' +
        checked.execution.rollback +
        '\nVisual audit: ' +
        checked.execution.visualAudit
      : '') +
    '\n\n' +
    escapePlanningDisplay(JSON.stringify(checked.differences, null, 2))
  )
}

export const validateHostContext = (context: unknown): HostContext =>
  hostContextSchema.parse(context)

export const validateHostPlan = (
  plan: unknown,
  context: unknown,
  resources?: readonly FigPluginPlanningAssetMetadata[],
  imageRecovery?: FigPluginRecoveryExecutionImages
): HostPlan => {
  // Negotiate protocol/schema and the adapter capability set before invoking the
  // generic execution validator. This keeps incompatible native hosts from being
  // treated as merely malformed plans and gives callers a stable failure code.
  assertHostPlanCompatibility(context, plan)
  const checkedContext = hostContextSchema.parse(context)
  const parsed = hostPlanSchema.parse(plan)
  validateHostPlanExecution(parsed, checkedContext, resources, imageRecovery)
  return parsed
}

export { normalizeHostPlan } from './hostPlan'
export { spatialBounds, spatialEdges, canvasMetrics } from './hostSpatial'
export { createHostPlanReadback, validateHostPlanReadback }
export {
  assertHostPlanCompatibility,
  negotiateHostPlanCompatibility,
  FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION,
  FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION,
  FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION,
  type HostCompatibilityFailure,
  type HostCompatibilityResult,
  type HostCompatibilitySuccess,
  type HostCompatibilityErrorCode
} from './hostCompatibility'
export {
  canTransitionHostAdapterLifecycle,
  createHostAdapterLifecycle,
  hostAdapterLifecycleCapabilitiesSchema,
  hostAdapterLifecycleDiagnosticsSchema,
  hostAdapterLifecycleErrorSchema,
  hostAdapterLifecycleErrorCodeSchema,
  hostAdapterLifecycleProgressSchema,
  hostAdapterLifecycleResultSchema,
  hostAdapterLifecycleStageSchema,
  hostAdapterLifecycleStageTransitionSchema,
  hostAdapterLifecycleStatusSchema,
  hostAdapterLifecycleTransitionSchema,
  type HostAdapterLifecycle,
  type HostAdapterLifecycleCapabilities,
  type HostAdapterLifecycleDiagnostics,
  type HostAdapterLifecycleError,
  type HostAdapterLifecycleErrorCode,
  type HostAdapterLifecycleOptions,
  type HostAdapterLifecycleProgress,
  type HostAdapterLifecycleResult,
  type HostAdapterLifecycleRunInput,
  type HostAdapterLifecycleStage,
  type HostAdapterLifecycleStatus
} from './hostAdapterLifecycle'

export const formatContext = (context: HostContext): string =>
  escapePlanningDisplay(JSON.stringify(context, null, 2))

export {
  readSessionAsset,
  validateSessionAsset,
  validateSessionAssetCatalog,
  type SessionAssetIdentity,
  type SessionAssetReadOptions
} from './hostAssetClient'
export {
  selectPlanningAssetReferences,
  validatePlanningAssetReferences,
  planningAssetMetadata
} from './hostPlanningAssets'
export {
  readExecutionAsset,
  validateExecutionAsset,
  type ExecutionAssetReadOptions,
  type ExecutionAssetReadIntent
} from './hostExecutionAssetClient'
export {
  executionAssetMetadata,
  executionAssetFromSessionAsset,
  FIGPLUGIN_EXECUTION_ASSET_READ_PATH,
  figPluginExecutionAssetSchema,
  figPluginExecutionAssetReadRequestSchema,
  figPluginExecutionAssetChunkSchema,
  type FigPluginExecutionAsset
} from './hostExecutionAssets'
