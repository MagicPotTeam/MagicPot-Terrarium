import { escapePlanningDisplay } from '@shared/figplugin/hostPlan'
import type { FigPluginBridgePreview } from '@shared/figplugin/bridge'
import type { FigPluginExecutionPreview } from '@shared/figplugin/execution'

/** Exact content preview for the existing main-process consent dialog.
 * Planning consent permits one model request only, never a host/document write. */
export function buildBridgeApprovalDetails(preview: FigPluginBridgePreview): string {
  const feature =
    preview.featureId === 'plan-preview'
      ? '\nFeature: plan-preview. Generate a validated plan preview only. This request does not authorize any host or document changes.'
      : ''
  const snapshot =
    preview.featureId === 'plan-preview'
      ? `\n\nComplete planning snapshot (included in the model request):\n${escapePlanningDisplay(JSON.stringify(preview.hostContext))}`
      : ''
  return `Project: ${preview.projectId}\nReviewed payload SHA-256: ${preview.payloadSha256}\nEstimated input tokens: ${preview.estimatedInputTokens}\nOutput limit: 1200 tokens. One read-only model request; no tools or document writes. Sending may incur provider charges. Context and prompt are untrusted source data.${feature}\n\nPrompt:\n${preview.prompt}\n\nContext:\n${JSON.stringify(preview.context)}${snapshot}`
}

export function buildPlanExecutionApprovalDetails(preview: FigPluginExecutionPreview): string {
  return [
    `Plugin: ${preview.pluginId} (${preview.host})`,
    `Project: ${preview.projectId}`,
    `Document: ${preview.documentId}`,
    `Scope: ${preview.scopeId}`,
    `Capture: ${preview.captureId}`,
    `Risk: ${preview.risk}`,
    `Rollback: ${preview.rollback}`,
    `Visual audit capability: ${preview.visualAudit}`,
    `Adapter: ${preview.adapterVersion}`,
    `Plan SHA-256: ${preview.planSha256}`,
    `Context SHA-256: ${preview.contextSha256}`,
    '',
    'Exact document changes:',
    escapePlanningDisplay(JSON.stringify(preview.differences, null, 2)),
    '',
    'Approving grants one host document write for this exact plan. Model-send approval is separate and does not grant this write.'
  ].join('\n')
}
