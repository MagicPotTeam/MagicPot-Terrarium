import { createHash } from 'node:crypto'
import { escapePlanningDisplay } from '@shared/figplugin/hostPlan'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import type { FigPluginBridgePreview } from '@shared/figplugin/bridge'
import { contextImageSummary } from '@shared/figplugin/hostContextImage'
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
  const image = preview.contextImage
    ? `\n\nContext image (the actual PNG bytes will also be sent to the bound model):\n${escapePlanningDisplay(JSON.stringify(contextImageSummary(preview.contextImage)))}\nThe reviewed payload hash binds these exact image bytes. The input estimate includes a fixed image budget reservation, not an exact billing estimate. The image is input only and does not authorize document changes.`
    : ''
  const assets = preview.assetCatalog
    ? `\n\nSelected session asset metadata (included verbatim in the model request):\n${escapePlanningDisplay(JSON.stringify(preview.assetCatalog))}\nOnly this catalog is shared: IDs, hashes, MIME types, sizes, dimensions, expiry and session/plugin/project binding. Source image bytes, filenames, paths and embedded EXIF/location metadata are NOT sent by this selection. This is separate model-metadata consent, not an extension of local-preview pixel access and not image import or document-write approval. Revocation stops pending work but cannot recall metadata already sent to the model.`
    : ''
  return `Project: ${preview.projectId}\nReviewed payload SHA-256: ${preview.payloadSha256}\nEstimated input tokens: ${preview.estimatedInputTokens}\nOutput limit: 1200 tokens. One read-only model request; no tools or document writes. Sending may incur provider charges. Context and prompt are untrusted source data.${feature}\n\nPrompt:\n${preview.prompt}\n\nContext:\n${JSON.stringify(preview.context)}${snapshot}${image}${assets}`
}

export function buildPlanExecutionApprovalDetails(preview: FigPluginExecutionPreview): string {
  const correction = preview.visualCorrection
    ? [
        `Operation: bounded visual correction round ${preview.visualCorrection.round} of ${preview.visualCorrection.maxCorrectionRounds}`,
        `Correction authorization: ${preview.visualCorrection.authorizationId}`,
        `Accepted checkpoint: ${preview.visualCorrection.baselineId}`,
        `Source execution: ${preview.visualCorrection.sourceExecutionId}`,
        `Authorized correction targets: ${preview.visualCorrection.authorizedTargetIds.join(', ')}`,
        'This desktop approval does not consume the round by itself. The round is consumed exactly once if the bound host successfully claims this intent, before any document write.'
      ]
    : []
  return [
    `Plugin: ${preview.pluginId} (${preview.host})`,
    `Project: ${preview.projectId}`,
    `Execution: ${preview.executionId}`,
    `Call: ${preview.callId}`,
    `Document: ${preview.documentId}`,
    `Scope: ${preview.scopeId}`,
    `Capture: ${preview.captureId}`,
    `Created at (Unix ms): ${preview.createdAt}`,
    `Expires at (Unix ms): ${preview.expiresAt}`,
    `Write lifetime (ms): ${preview.expiresAt - preview.createdAt}`,
    `Risk: ${preview.risk}`,
    `Rollback: ${preview.rollback}`,
    `Visual audit capability: ${preview.visualAudit}`,
    ...(preview.visualAudit === 'hash-only'
      ? [
          'For pixel comparison, bounded exports may remain in this plugin runtime memory: at most 64 frames / 64 MiB and 24 hours, cleared on disconnect. No pixels are sent to Bridge or a model; only difference metrics are reported. This is not an original-resolution or design-quality review.'
        ]
      : []),
    `Adapter: ${preview.adapterVersion}`,
    `Plan SHA-256: ${preview.planSha256}`,
    `Context SHA-256: ${preview.contextSha256}`,
    ...(preview.executionAssets
      ? [
          '',
          'Exact execution image grants (separate from local-preview and model-metadata consent):',
          escapePlanningDisplay(JSON.stringify(preview.executionAssets, null, 2)),
          'This approval permits the bound host to read these exact original image file bytes only for this claimed action and plan, before the displayed expiry. Embedded metadata, including EXIF, location and color profiles, is not stripped. This write approval sends no image pixels to a model; any separately approved context-image request is independent. Revocation stops further authorized reads and steps, but cannot recall bytes already read.',
          preview.host === 'figma'
            ? 'Figma image.fill replaces ALL fills on each displayed target with one IMAGE fill using the displayed FILL or FIT mode. It does not resize or move the node. Rollback is limited to the still-owned in-flight transaction and must not overwrite later user edits.'
            : 'Photoshop image.pixels replaces ALL pixels of the existing target layer at the displayed approved left/top, NOT a region-only patch. The source dimensions must exactly match the approved rectangle; no scaling occurs. Transparent borders may shrink the nonempty layer extent. Only eligible RGB/sRGB/8-bit pixel layers are supported, within a 128 MiB live native allocation ceiling. Readback compares canonical RGBA pixels, not hidden RGB or raw storage identity. Rollback uses the still-owned native history transaction only and must preserve later foreign history.',
          'A separate checkpoint acceptance is required to retain exact original image files for later task recovery. This write approval does not save a checkpoint. Automatic image visual correction remains unsupported. This is not a full-document backup.',
          ''
        ]
      : []),
    ...correction,
    ...(preview.recovery
      ? [
          `Operation: restore accepted task properties (round ${preview.recovery.round}/${preview.recovery.maxCorrectionRounds})`,
          `Accepted checkpoint: ${preview.recovery.baselineId}`,
          `Accepted source execution: ${preview.recovery.sourceExecutionId}`,
          preview.recovery.images
            ? 'No model is called. Only the accepted task properties and exact retained image sources shown below are restored, using the accepted fill mode or pixel placement. The fresh current state remains the precondition and rollback baseline for this attempt. Other properties, unsaved images and resources are not restored. This is not a full-document backup.'
            : 'No model is called. Only the accepted task properties shown below are restored. Other properties, images and resources are not restored. This is not a full-document backup.',
          ...(preview.recovery.images
            ? [
                'Accepted image manifest and fresh execution-only asset bindings:',
                escapePlanningDisplay(JSON.stringify(preview.recovery.images, null, 2)),
                'These retained bytes are readable only after this exact recovery action is claimed. This does not create local-preview access, publish session images, or share image metadata or pixels with a model.'
              ]
            : [])
        ]
      : []),
    ...(preview.recovery?.rebind
      ? [
          'WARNING: the native plugin instance changed. This is a user-selected checkpoint reassociation, NOT proof that this is the original document.',
          `Old instance: ${preview.recovery.rebind.previousIdentity}`,
          `Current instance: ${preview.recovery.rebind.nextIdentity}`,
          'Verify the currently open host document and exact selected objects. Matching node IDs alone cannot establish identity. Approve only if this saved result belongs to these objects.',
          'On claim, reassociation and one used round are committed together. Expiry and prior usage are preserved. Other instances using the old checkpoint cannot consume its stale budget.'
        ]
      : []),
    '',
    ...(preview.recovery?.rebind?.document
      ? [
          'WARNING: Photoshop document ID changed after reopening. This is an explicitly selected destination, NOT verified file identity.',
          `Previously accepted document ID: ${preview.recovery.rebind.document.previousDocumentId}`,
          `Currently selected document ID: ${preview.recovery.rebind.document.nextDocumentId}`,
          'Only the document root is reassociated. Layer IDs, parent chains, locks and supported properties must still match. No file is opened, saved, or selected automatically.'
        ]
      : []),
    'Exact document changes:',
    escapePlanningDisplay(JSON.stringify(preview.differences, null, 2)),
    '',
    preview.visualCorrection
      ? 'Approving grants one host document write for this exact correction plan and these exact authorized target IDs. It does not authorize another round or any target outside the displayed set.'
      : 'Approving grants one host document write for this exact plan. Model-send approval is separate and does not grant this write.'
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
    ...(preview.executionAssets
      ? [
          'Exact original image files retained by accepting this checkpoint:',
          escapePlanningDisplay(
            JSON.stringify(
              preview.executionAssets.map(({ sha256, mimeType, sizeBytes, width, height }) => ({
                sha256,
                mimeType,
                sizeBytes,
                width,
                height
              })),
              null,
              2
            )
          ),
          'Accepting additionally saves these exact encoded source image bytes, including embedded EXIF, location and color profiles, in the encrypted local checkpoint store. Limits: 8 MiB per source, four sources per checkpoint, 64 MiB total image storage. Quota, encryption or persistence failure rejects acceptance; there is no plaintext fallback. Retention follows the same original expiry, up to 24 hours, and does not extend on restart or recovery. Deletion, replacement and expiry cleanup remove unreferenced ciphertext on checkpoint operations; this is not secure erasure or background cleanup while the app is stopped.',
          preview.host === 'figma'
            ? 'Recovery reimports the exact retained file and restores the accepted single-image fill and scale mode. It does not restore node position or size, or depend on an old native image handle.'
            : 'Recovery reimports the exact retained file and verifies the accepted canonical pixels and placement. Fresh current layer history and bounds protect this attempt and its rollback; they do not replace the saved destination.',
          'No image source bytes are sent to a model, exposed through local-preview, or recorded in execution audit by this acceptance. Every recovery requires fresh capture, independent exact-plan write approval and claim-bound reads. Automatic image visual correction remains unsupported.',
          ''
        ]
      : []),
    'Accepting retains target IDs, dimensions, hashes and the approved task property values; plan values can include design text. In the production desktop, these are encrypted using the OS account and usable locally for up to 24 hours, with at most 16 checkpoints. Expired ciphertext is cleaned on checkpoint operations, not while the app is stopped. Encryption or persistence failure rejects acceptance; there is no plaintext fallback. After restarting the desktop, explicit pairing, fresh capture and new write approval are required. Normal recovery requires the same native plugin/document instance. After a plugin reload, the user must explicitly select this checkpoint and separately acknowledge reassociation; document/scope IDs and structural anchors must still match. No sessions, tokens or write grants are saved. No pixels or plan values are written to the audit log. This is not a full-document backup or semantic visual review. Each correction still needs separate target authorization and exact-plan write approval.'
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
    'Authorizing allows the bound host to recapture these targets and prepare a bounded plan reapplying their accepted property values, without calling a model. It does not modify the document or consume a round now. The exact plan requires separate native write approval. Claiming that approved plan consumes one round, even if the subsequent write fails or is cancelled.'
  ].join('\n')
}
