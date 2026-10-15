import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import {
  FIGPLUGIN_NATIVE_TOTAL_WIRE_BYTES,
  figPluginNativeProposalSchema,
  parseFigPluginNativeCommandValue
} from '@shared/figplugin/nativeCommand'
import {
  FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES,
  checkFigPluginSelectionSnapshot,
  type FigPluginSelectionSnapshot
} from '@shared/figplugin/selectionSnapshot'

type NodeMetadata = FigPluginSelectionSnapshot['nodes'][number]
export type NativeRenameReview = Readonly<{
  domain: 'figplugin-native-rename-metadata-review/v1'
  evidence: 'unverified-host-metadata'
  writeAvailable: false
  host: FigPluginSelectionSnapshot['host']
  document: FigPluginSelectionSnapshot['document']
  observation: FigPluginSelectionSnapshot['observation']
  observationReference: string
  snapshotSha256: string
  reviewSha256: string
  rows: readonly Readonly<{
    targetId: string
    kind: string
    oldName: string
    newName: string
    wouldChange: boolean
    ancestors: readonly NodeMetadata[]
  }>[]
}>
export type NativeRenameReviewCode =
  | 'INVALID_SNAPSHOT'
  | 'SNAPSHOT_TOO_LARGE'
  | 'INVALID_PROPOSAL'
  | 'HOST_MISMATCH'
  | 'STALE_OBSERVATION'
  | 'OUT_OF_SCOPE'
  | 'LOCKED_TARGET'
  | 'HIDDEN_TARGET'
  | 'REVIEW_TOO_LARGE'
export type NativeRenameReviewResult =
  { ok: true; review: NativeRenameReview } | { ok: false; code: NativeRenameReviewCode }

const digest = (value: unknown) =>
  createHash('sha256').update(canonicalFigPluginJson(value), 'utf8').digest('hex')
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Main-only data preparation for a future local review. No transport, model, live
 * host read/write, grant, approval or executor is registered here. Snapshot JSON
 * must be bounded BEFORE parsing; unlike the legacy dialogue context, the shared
 * snapshot validates the complete selected metadata and ancestor lock graph.
 *
 * The independently supplied observation reference is not a native revision.
 * A matching reference/hash never proves host identity, freshness or permission.
 * Old/new names remain exact data, not HTML; a future UI must display controls
 * visibly and escape markup without changing these approval-relevant bytes.
 */
export const createNativeRenameReview = (
  proposalInput: unknown,
  snapshotJson: unknown,
  observationReference: unknown
): NativeRenameReviewResult => {
  if (typeof snapshotJson !== 'string') return { ok: false, code: 'INVALID_SNAPSHOT' }
  if (
    snapshotJson.length > FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES ||
    Buffer.byteLength(snapshotJson, 'utf8') > FIGPLUGIN_SELECTION_SNAPSHOT_MAX_BYTES
  )
    return { ok: false, code: 'SNAPSHOT_TOO_LARGE' }
  let decoded: unknown
  try {
    decoded = JSON.parse(snapshotJson)
  } catch {
    return { ok: false, code: 'INVALID_SNAPSHOT' }
  }
  const checked = checkFigPluginSelectionSnapshot(decoded)
  if (!checked.ok) return { ok: false, code: 'INVALID_SNAPSHOT' }
  const parsed = parseFigPluginNativeCommandValue(
    figPluginNativeProposalSchema,
    proposalInput,
    types.isProxy
  )
  if (!parsed.ok) return { ok: false, code: 'INVALID_PROPOSAL' }
  const { snapshot } = checked,
    { data: proposal } = parsed
  if (proposal.host !== snapshot.host) return { ok: false, code: 'HOST_MISMATCH' }
  if (
    typeof observationReference !== 'string' ||
    !observationReference ||
    proposal.plan.selectionRevision !== observationReference
  )
    return { ok: false, code: 'STALE_OBSERVATION' }

  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const selected = new Map(snapshot.selected.map((node) => [node.id, node]))
  const rows: NativeRenameReview['rows'][number][] = []
  for (const step of proposal.plan.steps) {
    const selection = selected.get(step.targetId),
      node = nodes.get(step.targetId)
    if (!selection || !node || node.role !== 'scene') return { ok: false, code: 'OUT_OF_SCOPE' }
    if (selection.effectiveLocked) return { ok: false, code: 'LOCKED_TARGET' }
    if (!selection.effectiveVisible) return { ok: false, code: 'HIDDEN_TARGET' }
    // Reject lone surrogates rather than hash TextEncoder's replacement glyph.
    if (Buffer.from(step.name, 'utf8').toString('utf8') !== step.name)
      return { ok: false, code: 'INVALID_PROPOSAL' }
    rows.push({
      targetId: node.id,
      kind: node.kind,
      oldName: node.name,
      newName: step.name,
      wouldChange: node.name !== step.name,
      ancestors: selection.ancestors.map((id) => ({ ...nodes.get(id)! }))
    })
  }
  const payload = {
    domain: 'figplugin-native-rename-metadata-review/v1' as const,
    evidence: 'unverified-host-metadata' as const,
    writeAvailable: false as const,
    host: snapshot.host,
    document: snapshot.document,
    observation: snapshot.observation,
    observationReference,
    snapshotSha256: digest(snapshot),
    rows
  }
  const review = { ...payload, reviewSha256: digest(payload) }
  if (Buffer.byteLength(canonicalFigPluginJson(review), 'utf8') > FIGPLUGIN_NATIVE_TOTAL_WIRE_BYTES)
    return { ok: false, code: 'REVIEW_TOO_LARGE' }
  return { ok: true, review: freeze(review) }
}
