import { createHash } from 'node:crypto'
import { escapePlanningDisplay } from '@shared/figplugin/hostPlan'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import type { FigPluginBridgePreview } from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
  type FigPluginExecutionPreview,
  type FigPluginExecutionStatus,
  type FigPluginVisualBaseline
} from '@shared/figplugin/execution'

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

export function buildVisualBaselineApprovalDetails(
  preview: FigPluginExecutionPreview,
  status: FigPluginExecutionStatus
): string {
  const evidence = status.visualEvidence ?? []
  const targets = evidence.map((item) => ({
    targetId: item.targetId,
    accepted: item.after
  }))
  return [
    `Plugin: ${preview.pluginId} (${preview.host})`,
    `Project: ${preview.projectId}`,
    `Document: ${preview.documentId}`,
    `Scope: ${preview.scopeId}`,
    `Execution: ${preview.executionId}`,
    `Plan SHA-256: ${preview.planSha256}`,
    `Context SHA-256: ${preview.contextSha256}`,
    `Visual evidence SHA-256: ${status.visualEvidenceSha256 ?? 'unavailable'}`,
    `Maximum correction rounds recorded by this checkpoint: ${FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS}`,
    '',
    'Accepted bounded visual targets:',
    escapePlanningDisplay(JSON.stringify(targets, null, 2)),
    '',
    'Accepting records a temporary in-memory checkpoint containing target IDs, dimensions and SHA-256 hashes only. It stores no pixels or design text, does not restore the document, does not perform semantic visual review, and does not start automatic correction.'
  ].join('\n')
}

export function buildVisualCorrectionAuthorizationDetails(
  preview: FigPluginExecutionPreview,
  status: FigPluginExecutionStatus,
  baseline: FigPluginVisualBaseline
): string {
  const comparison = status.visualBaselineComparison
  if (!comparison) return 'Visual correction comparison is unavailable.'
  const changedTargets = comparison.targets
    .filter((target) => target.changed)
    .map((target) => ({
      targetId: target.targetId,
      accepted: target.baseline,
      current: target.current
    }))
  const comparisonSha256 = createHash('sha256')
    .update(canonicalFigPluginJson(comparison), 'utf8')
    .digest('hex')
  const nextRound = baseline.correctionRoundsUsed + 1
  return [
    `Plugin: ${preview.pluginId} (${preview.host})`,
    `Project: ${preview.projectId}`,
    `Document: ${preview.documentId}`,
    `Scope: ${preview.scopeId}`,
    `Execution: ${preview.executionId}`,
    `Accepted checkpoint: ${baseline.baselineId}`,
    `Accepted evidence SHA-256: ${baseline.visualEvidenceSha256}`,
    `Current evidence SHA-256: ${status.visualEvidenceSha256 ?? 'unavailable'}`,
    `Comparison SHA-256: ${comparisonSha256}`,
    `Requested correction round: ${nextRound} of ${baseline.maxCorrectionRounds}`,
    '',
    'Exact changed targets that may be used by one future correction attempt:',
    escapePlanningDisplay(JSON.stringify(changedTargets, null, 2)),
    '',
    'Authorizing creates one short-lived, in-memory capability for these exact target IDs and this exact comparison only. It does not call a model, modify or restore the document, consume a correction round, or start correction now.'
  ].join('\n')
}
