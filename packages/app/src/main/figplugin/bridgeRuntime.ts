import {
  MemoryNativeWriteCoordinator,
  type NativeWriteCoordinator,
  type NativeWriteReservation
} from './nativeWriteCoordinator'
import type {
  RecoveryCheckpointStore,
  RecoveryClaimLease,
  SavedCheckpoint
} from './checkpointStore'
import {
  captureTaskRecoveryScope,
  createTaskRecoveryRebind,
  applyTaskRecoveryRebind,
  prepareTaskRecoveryPlan,
  figPluginTaskRecoveryPrepareRequestSchema,
  figPluginTaskRecoveryPrepareResponseSchema,
  type TaskRecoveryScope,
  type FigPluginTaskRecovery,
  type FigPluginTaskRecoveryPrepareResponse
} from '@shared/figplugin/taskRecovery'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  figPluginPixelAuditRequestSchema,
  figPluginPixelAuditSchema,
  pixelAuditMatchesComparison,
  summarizePixelTargets,
  type FigPluginPixelAudit
} from '@shared/figplugin/pixelAudit'
import {
  FIGPLUGIN_BRIDGE_PROTOCOL,
  FigPluginBridgeError,
  figPluginBridgePrepareRequestSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginPairRequestSchema,
  figPluginRuntimeBindingSchema,
  parseFigPluginBridgeValue,
  type FigPluginBridgePrepareRequest,
  type FigPluginBridgePrepareResponse,
  type FigPluginBridgePreview,
  type FigPluginBridgeErrorCode,
  type FigPluginBridgeStatusResponse,
  type FigPluginPairRequest,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  figPluginBridgeReadinessResponseSchema,
  figPluginBridgeReadinessRequestSchema,
  type FigPluginBridgeReadinessRequest,
  type FigPluginHostReadinessProbe,
  type FigPluginBridgeReadinessResponse
} from '@shared/figplugin/bridgeReadiness'
import {
  FIGPLUGIN_EXECUTION_MAX_EVENTS,
  FIGPLUGIN_EXECUTION_PROTOCOL,
  FIGPLUGIN_VISUAL_BASELINE_TTL_MS,
  FIGPLUGIN_VISUAL_CORRECTION_AUTHORIZATION_TTL_MS,
  FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
  figPluginExecutionClaimResponseSchema,
  figPluginExecutionIntentSchema,
  figPluginExecutionPreviewSchema,
  figPluginExecutionProgressRequestSchema,
  figPluginExecutionResultRequestSchema,
  figPluginExecutionResultResponseSchema,
  figPluginExecutionStateSchema,
  figPluginExecutionStatusSchema,
  figPluginExecutionClaimRequestSchema,
  figPluginExecutionStatusRequestSchema,
  figPluginVisualBaselineComparisonSchema,
  figPluginVisualBaselineSchema,
  figPluginVisualCorrectionAuthorizationSchema,
  figPluginVisualCorrectionPrepareRequestSchema,
  figPluginVisualCorrectionPrepareResponseSchema,
  type FigPluginExecutionClaimResponse,
  type FigPluginExecutionIntent,
  type FigPluginExecutionPreview,
  type FigPluginExecutionProgressRequest,
  type FigPluginExecutionResultRequest,
  type FigPluginExecutionResultResponse,
  type FigPluginExecutionState,
  type FigPluginExecutionStatusRequest,
  type FigPluginExecutionStatus,
  type FigPluginVisualBaseline,
  type FigPluginVisualBaselineComparison,
  type FigPluginVisualCorrectionAttempt,
  type FigPluginVisualCorrectionAuthorization,
  type FigPluginVisualCorrectionPrepareResponse,
  type FigPluginVisualEvidence
} from '@shared/figplugin/execution'
import {
  createHostPlanningPreview,
  type HostPlanningPreview
} from '@shared/figplugin/hostPlanPreview'
import {
  validateHostPlanReadback,
  stepValue,
  type HostContext,
  type HostCommand,
  type HostPlan,
  type HostImageEvidence
} from '@shared/figplugin/hostPlan'
import {
  figPluginRecoveryImagesSchema,
  recoveryImagesManifestContent,
  validateRecoveryImagePlanBinding,
  type FigPluginRecoveryImages,
  type FigPluginRecoveryExecutionImages
} from '@shared/figplugin/hostImageRecovery'
import { FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION } from '@shared/figplugin/hostCompatibility'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import {
  contextImageSummary,
  HOST_CONTEXT_IMAGE_TOKEN_BUDGET
} from '@shared/figplugin/hostContextImage'
import { validateHostContextImageBytes } from './hostContextImage'
import {
  figPluginPlanningAssetCatalogSchema,
  planningAssetMetadata,
  type FigPluginPlanningAssetCatalog,
  type FigPluginPlanningAssetReference
} from '@shared/figplugin/hostPlanningAssets'
import type { FigPluginExecutionAuditEvent } from './executionAudit'
import {
  figPluginPlanningModelMetadataSchema,
  type FigPluginPlanningAuditEvent,
  type FigPluginPlanningModelMetadata
} from '@shared/figplugin/planningAudit'
import {
  ProviderCircuitBreaker,
  ProviderCircuitOpenError,
  type ProviderCircuitFailureClass,
  type ProviderCircuitOutcome
} from './providerCircuitBreaker'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_MAX_PER_SESSION,
  FIGPLUGIN_ASSET_MAX_TOTAL,
  FIGPLUGIN_ASSET_MAX_TOTAL_BYTES,
  FIGPLUGIN_ASSET_TTL_MS,
  figPluginAssetChunkSchema,
  figPluginAssetListRequestSchema,
  figPluginAssetListSchema,
  figPluginAssetReadRequestSchema,
  figPluginDesktopAssetRevokeSchema,
  figPluginDesktopAssetTargetSchema,
  figPluginSessionAssetSchema,
  type FigPluginAssetChunk,
  type FigPluginAssetList,
  type FigPluginAssetMime,
  type FigPluginDesktopAssetRevoke,
  type FigPluginDesktopAssetTarget,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import { inspectSessionAssetImage } from './sessionAssetImage'
import {
  executionAssetFromSessionAsset,
  executionAssetMetadata,
  figPluginExecutionAssetSchema,
  figPluginExecutionAssetChunkSchema,
  figPluginExecutionAssetReadRequestSchema,
  type FigPluginExecutionAsset,
  type FigPluginExecutionAssetChunk
} from '@shared/figplugin/hostExecutionAssets'
import {
  figPluginImageGenerationStateSchema,
  type FigPluginImageGenerationRequest,
  type FigPluginImageGenerationState
} from '@shared/figplugin/imageGeneration'
import {
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_MAX_MS,
  figPluginImageGenerationProposalPrepareRequestSchema,
  figPluginImageGenerationProposalPrepareResponseSchema,
  figPluginImageGenerationProposalStatusRequestSchema,
  figPluginImageGenerationProposalStatusSchema,
  figPluginNativeImageGenerationDesktopKeySchema,
  figPluginNativeImageGenerationDesktopProposalSchema,
  type FigPluginImageGenerationProposalPrepareResponse,
  type FigPluginImageGenerationProposalStatus,
  type FigPluginNativeImageGenerationDesktopKey,
  type FigPluginNativeImageGenerationDesktopProposal
} from '@shared/figplugin/nativeImageGeneration'

const TICKET_TTL = 120_000
const SESSION_TTL = 600_000
const IDLE_TTL = 120_000
const CALL_TTL = 120_000
const MAX_CALL_TIMEOUT = 90_000
const FAILURE_WINDOW = 60_000
// Provider readiness is evidence from a real, approved invocation rather than a
// configuration probe. Keep it short-lived so an old successful request cannot
// make a later diagnostics screen claim that the provider is currently usable.
const PROVIDER_READINESS_TTL_MS = 60_000
const dummySecret = '0'.repeat(64)
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 32 && /^[a-f0-9]{32}$/.test(value)

// Even missing IDs and malformed credentials perform a fixed-size comparison.
const secretEquals = (value: unknown, expected: string | undefined): boolean => {
  const valid = typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
  const equal = timingSafeEqual(
    Buffer.from(valid ? value : dummySecret, 'hex'),
    Buffer.from(expected || dummySecret, 'hex')
  )
  return valid && expected !== undefined && expected !== '' && equal
}
const resultSchema = figPluginBridgeStatusResponseSchema.options[2].pick({
  content: true,
  reportedTotalTokens: true
})

const expectedHostCommands: Record<FigPluginHostReadinessProbe['host'], readonly HostCommand[]> = {
  figma: ['node.rename', 'node.opacity', 'node.visibility', 'text.content', 'layout.flow'],
  photoshop: ['node.rename', 'node.opacity', 'node.visibility', 'text.content']
}
const adapterPrefix: Record<FigPluginHostReadinessProbe['host'], string> = {
  figma: 'figma-native-',
  photoshop: 'photoshop-uxp-native-'
}
const readinessState = (state: 'ready' | 'not-ready' | 'unknown', code: string) => ({
  state,
  code
})

const readinessFromHostProbe = (
  host: FigPluginHostReadinessProbe | undefined,
  pairedHost: FigPluginHostReadinessProbe['host']
): {
  host: { state: 'ready' | 'not-ready' | 'unknown'; code: string }
  capabilities: { state: 'ready' | 'not-ready' | 'unknown'; code: string }
  resources: { state: 'ready' | 'not-ready' | 'unknown'; code: string }
} => {
  if (!host) {
    return {
      // Pairing authenticates the plugin binding, not a currently connected
      // native document. A host probe is required before diagnostics can
      // claim that the host process is reachable.
      host: readinessState('unknown', 'host-not-probed'),
      capabilities: readinessState('unknown', 'capabilities-not-probed'),
      resources: readinessState('unknown', 'resources-not-probed')
    }
  }
  if (host.host !== pairedHost) {
    return {
      host: readinessState('not-ready', 'host-mismatch'),
      capabilities: readinessState('not-ready', 'host-mismatch'),
      resources: readinessState('not-ready', 'host-mismatch')
    }
  }
  const missing = expectedHostCommands[pairedHost].filter(
    (command) => !host.supports.includes(command)
  )
  const adapterPrefixValue = adapterPrefix[pairedHost]
  const otherAdapterPrefix = pairedHost === 'figma' ? adapterPrefix.photoshop : adapterPrefix.figma
  const adapterSuffix = host.adapterVersion.startsWith(adapterPrefixValue)
    ? host.adapterVersion.slice(adapterPrefixValue.length)
    : undefined
  const adapterState = host.adapterVersion.startsWith(otherAdapterPrefix)
    ? 'mismatch'
    : adapterSuffix === undefined
      ? 'unrecognized'
      : adapterSuffix === String(FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION)
        ? 'current'
        : 'unsupported'
  const hostState =
    host.document.state === 'not-ready'
      ? readinessState('not-ready', 'document-unavailable')
      : host.document.state === 'unknown'
        ? readinessState('unknown', host.document.code || 'document-unknown')
        : readinessState('ready', 'host-observed')
  const capabilityState =
    adapterState === 'mismatch'
      ? readinessState('not-ready', 'adapter-host-mismatch')
      : adapterState === 'unrecognized'
        ? readinessState('not-ready', 'adapter-unrecognized')
        : adapterState === 'unsupported'
          ? readinessState('not-ready', 'adapter-version-unsupported')
          : missing.length > 0
            ? readinessState('not-ready', 'capabilities-incomplete')
            : host.rollback === 'none'
              ? readinessState('not-ready', 'rollback-unavailable')
              : readinessState('ready', 'capabilities-observed')
  const checks = [host.document, host.resources.fonts, host.resources.visual]
  const unavailable = checks.find((check) => check.state === 'not-ready')
  const pending = checks.find((check) => check.state === 'unknown')
  const resourceState = unavailable
    ? readinessState('not-ready', unavailable.code)
    : pending
      ? readinessState('unknown', pending.code)
      : readinessState('ready', 'resources-observed')
  return { host: hostState, capabilities: capabilityState, resources: resourceState }
}

type Options = {
  validateBinding: (binding: FigPluginRuntimeBinding) => Promise<boolean>
  invoke: (
    binding: FigPluginRuntimeBinding,
    preview: FigPluginBridgePreview,
    signal: AbortSignal,
    correlationId: string,
    onProviderDispatch: () => void,
    checkProviderDispatch: () => void
  ) => Promise<{ content: string; reportedTotalTokens?: number }>
  now?: () => number
  callTimeoutMs?: number
  audit?: (event: FigPluginExecutionAuditEvent) => void
  planningAudit?: (event: FigPluginPlanningAuditEvent) => void
  planningProfile?: (binding: FigPluginRuntimeBinding) => FigPluginPlanningModelMetadata
  allowNativeWrite?: (binding: FigPluginRuntimeBinding) => boolean
  allowAssetTransfer?: (binding: FigPluginRuntimeBinding) => boolean
  assetByteLimit?: (binding: FigPluginRuntimeBinding) => number
  imageGenerationTimeoutMs?: (binding: FigPluginRuntimeBinding) => number
  checkpoints?: RecoveryCheckpointStore
  writes?: NativeWriteCoordinator
  providerCircuit?: ProviderCircuitBreaker
}
type Ticket = {
  binding: FigPluginRuntimeBinding
  secret: string
  expiresAt: number
  failures: number
  state: 'issuing' | 'ready' | 'redeeming'
}
type Receipt = {
  sequence: number
  requestId: string
  // Server-owned lineage ID; requestId remains client replay identity and may be reused
  // by a client across independent sessions, so it is not suitable for audit correlation.
  correlationId: string
  digest: string
  response: FigPluginBridgePrepareResponse
  recoveryResponse?: FigPluginTaskRecoveryPrepareResponse
}
type Session = {
  id: string
  token: string
  binding: FigPluginRuntimeBinding
  expiresAt: number
  idleAt: number
  highWater: number
  requests: Map<string, Receipt>
  imageGenerationRequests: Map<string, NativeImageGeneration>
  preparing: number
  validation?: Promise<boolean>
  providerObservation?: ProviderReadinessObservation
  assets: Map<string, SessionAssetRecord>
  preparingAssets: number
}
type SessionAssetRecord = { value: FigPluginSessionAsset; bytes: Buffer }
export type FigPluginAssetSelection = Readonly<{
  target: Readonly<FigPluginDesktopAssetTarget>
  host: FigPluginRuntimeBinding['host']
  bindingSha256: string
  expiresAt: number
  maxBytes: number
}>
export type FigPluginMaterializedAsset = {
  mimeType: FigPluginAssetMime
  width: number
  height: number
  bytes: Uint8Array
}
export type FigPluginNativeImageGenerationReceipt = Readonly<{
  proposalId: string
  nativeRequestId: string
  payloadSha256: string
  request: Readonly<FigPluginImageGenerationRequest>
  expiresAt: number
  sessionExpiresAt: number
  signal: AbortSignal
}>
export type FigPluginNativeImageGenerationOutcome = {
  phase: 'declined' | 'cancelled' | 'failed'
  error?: FigPluginBridgeErrorCode
}
type NativeImageGeneration = {
  session: Session
  sequence: number
  digest: string
  maxBytes: number
  timeoutMs: number
  response: FigPluginImageGenerationProposalPrepareResponse
  status: FigPluginImageGenerationProposalStatus
  preview?: FigPluginNativeImageGenerationDesktopProposal
  receipt?: FigPluginNativeImageGenerationReceipt
  abort: AbortController
  claimed: boolean
  jobId?: string
  observed?: FigPluginImageGenerationState
}
const nativeGenerationTerminal = (phase: FigPluginImageGenerationProposalStatus['phase']) =>
  ['accepted', 'declined', 'cancelled', 'failed'].includes(phase)
type ProviderReadinessObservation = {
  profileId: string
  profileRevision: string
  state: 'ready' | 'not-ready'
  code: 'provider-observed' | 'provider-unavailable'
  observedAt: number
  correlationId: string
}
type Call = {
  session: Session
  receipt: Receipt
  status: FigPluginBridgeStatusResponse
  preview?: FigPluginBridgePreview
  hostContext?: HostContext
  planningAssets?: FigPluginPlanningAssetCatalog
  controller?: AbortController
  deadline?: number
  execution?: PlanExecution
  planningAudit?: {
    startedAt: number
    sequence: number
    state?: FigPluginPlanningAuditEvent['state']
    terminal: boolean
    summary: Omit<
      FigPluginPlanningAuditEvent,
      | 'schemaVersion'
      | 'kind'
      | 'at'
      | 'sequence'
      | 'state'
      | 'durationMs'
      | 'resultBytes'
      | 'reportedTotalTokens'
      | 'errorCode'
    >
  }
}
type PlanProgress = {
  sequence: number
  phase: 'claimed' | 'executing' | 'readback'
  index?: number
  completed: number
  effect: 'none' | 'applied' | 'rolled-back' | 'partial' | 'unknown'
  at: number
}
const PLAN_PROGRESS_PHASE_ORDER: Readonly<Record<PlanProgress['phase'], number>> = {
  claimed: 0,
  executing: 1,
  readback: 2
}
type VisualBaselineRecord = {
  value: FigPluginVisualBaseline
  binding: FigPluginRuntimeBinding
  recoveryPlan: HostPlan
  recoveryScope: TaskRecoveryScope
  recoveryImages?: FigPluginRecoveryImages
}
type VisualCorrectionAuthorizationRecord = {
  value: FigPluginVisualCorrectionAuthorization
  binding: FigPluginRuntimeBinding
  preparedExecutionId?: string
}

type PlanExecution = {
  executionId: string
  // A recovery/correction attempt keeps the source execution as its run ID so a
  // single user-authorized operation is queryable across retries.
  runId: string
  auditSequence: number
  actionId: string
  call: Call
  plan: HostPlan
  context: HostContext
  preview: FigPluginExecutionPreview
  planSha256: string
  contextSha256: string
  previewSha256: string
  executionAssets?: FigPluginExecutionAsset[]
  recoveryAssetBytes?: Map<string, Buffer>
  acceptedImageEvidence?: Array<{
    targetId: string
    command: 'image.fill' | 'image.pixels'
    imageEvidence: HostImageEvidence
  }>
  state: FigPluginExecutionState
  completed: number
  effect: PlanProgress['effect']
  cursor: number
  progress: PlanProgress[]
  /** Bounded request fingerprints make transport retries idempotent without retaining payloads. */
  progressFingerprints: Map<number, string>
  intent?: FigPluginExecutionIntent
  claimedAt?: number
  writeReservation?: NativeWriteReservation
  resultFingerprint?: string
  visualEvidence?: FigPluginVisualEvidence[]
  visualBaselineComparison?: FigPluginVisualBaselineComparison
  pixelAudit?: FigPluginPixelAudit
  pixelAuditFingerprint?: string
  visualTargetIds?: string[]
  visualCorrection?: FigPluginVisualCorrectionAttempt
  recovery?: FigPluginTaskRecovery
  updatedAt: number
  errorCode?: NonNullable<FigPluginExecutionStatus['errorCode']>
}
type TerminalCode =
  'DENIED' | 'EXPIRED' | 'CONFIGURATION_CHANGED' | 'CANCELLED' | 'TIMEOUT' | 'UPSTREAM_FAILED'
const active = (call: Call): boolean =>
  call.status.status === 'awaiting-approval' || call.status.status === 'running'
const terminalExecution = new Set<FigPluginExecutionState>([
  'completed',
  'cancelled',
  'denied',
  'failed',
  'expired'
])
const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalFigPluginJson(value), 'utf8').digest('hex')
const visualBaselineScopeKey = (
  value: Pick<FigPluginVisualBaseline, 'pluginId' | 'host' | 'projectId' | 'documentId' | 'scopeId'>
): string =>
  JSON.stringify([value.pluginId, value.host, value.projectId, value.documentId, value.scopeId])

/** Memory-only main-process authority. Never expose createPairing/approve/deny to the host.
 * The caller supplies trusted native consent and validates the entire current store binding.
 */
export class FigPluginBridgeRuntime {
  private readonly checkpoints?: RecoveryCheckpointStore
  private readonly writes: NativeWriteCoordinator
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, Session>()
  private readonly calls = new Map<string, Call>()
  private readonly visualBaselines = new Map<string, VisualBaselineRecord>()
  private readonly visualCorrectionAuthorizations = new Map<
    string,
    VisualCorrectionAuthorizationRecord
  >()
  private readonly visualCorrectionExecutions = new Map<string, PlanExecution>()
  private readonly validateBinding: Options['validateBinding']
  private readonly invoke: Options['invoke']
  private readonly clock: () => number
  private readonly callTimeout: number
  private readonly audit?: Options['audit']
  private readonly planningAudit?: Options['planningAudit']
  private readonly planningProfile?: Options['planningProfile']
  private readonly allowNativeWrite: NonNullable<Options['allowNativeWrite']>
  private readonly allowAssetTransfer: NonNullable<Options['allowAssetTransfer']>
  private readonly assetByteLimit: NonNullable<Options['assetByteLimit']>
  private readonly imageGenerationTimeoutMs: NonNullable<Options['imageGenerationTimeoutMs']>
  private readonly nativeImageGenerations = new Map<string, NativeImageGeneration>()
  private readonly nativeImageGenerationReceipts = new WeakMap<
    FigPluginNativeImageGenerationReceipt,
    NativeImageGeneration
  >()
  private readonly assetSelections = new WeakMap<FigPluginAssetSelection, Session>()
  private assetCount = 0
  private assetBytes = 0
  private preparingAssets = 0
  private preparingAssetBytes = 0
  private readonly providerCircuit: ProviderCircuitBreaker
  private failures: number[] = []
  private timer?: ReturnType<typeof setTimeout>
  private preparing = 0
  private executing = 0
  private closed = false

  constructor(options: Options) {
    this.checkpoints = options.checkpoints
    this.validateBinding = options.validateBinding
    this.invoke = options.invoke
    this.clock = options.now ?? Date.now
    this.writes = options.writes ?? new MemoryNativeWriteCoordinator(this.clock)
    this.callTimeout = Number.isFinite(options.callTimeoutMs)
      ? Math.max(1, Math.min(MAX_CALL_TIMEOUT, Math.floor(options.callTimeoutMs!)))
      : MAX_CALL_TIMEOUT
    this.audit = options.audit
    this.planningAudit = options.planningAudit
    this.planningProfile = options.planningProfile
    this.allowNativeWrite = options.allowNativeWrite ?? (() => false)
    this.allowAssetTransfer = options.allowAssetTransfer ?? (() => false)
    this.assetByteLimit = options.assetByteLimit ?? (() => FIGPLUGIN_ASSET_MAX_BYTES)
    this.imageGenerationTimeoutMs =
      options.imageGenerationTimeoutMs ?? (() => FIGPLUGIN_NATIVE_IMAGE_GENERATION_MAX_MS)
    this.providerCircuit = options.providerCircuit ?? new ProviderCircuitBreaker()
  }

  private executionStatus(execution: PlanExecution): FigPluginExecutionStatus {
    const visualEvidenceSha256 = execution.visualEvidence
      ? digest(execution.visualEvidence)
      : undefined
    return figPluginExecutionStatusSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId: execution.executionId,
      callId: execution.call.receipt.response.callId,
      requestId: execution.call.receipt.requestId,
      runId: execution.runId,
      correlationId: execution.call.receipt.correlationId,
      state: execution.state,
      completed: execution.completed,
      total: execution.plan.steps.length,
      effect: execution.effect,
      updatedAt: execution.updatedAt,
      ...(execution.visualEvidence
        ? { visualEvidence: execution.visualEvidence, visualEvidenceSha256 }
        : {}),
      ...(execution.visualBaselineComparison
        ? { visualBaselineComparison: execution.visualBaselineComparison }
        : {}),
      ...(execution.visualCorrection
        ? {
            visualCorrection: execution.visualCorrection,
            visualCorrectionConsumed: execution.claimedAt !== undefined
          }
        : {}),
      ...(execution.pixelAudit ? { pixelAudit: execution.pixelAudit } : {}),
      ...(execution.recovery
        ? { recovery: execution.recovery, recoveryConsumed: execution.claimedAt !== undefined }
        : {}),
      ...(execution.errorCode ? { errorCode: execution.errorCode } : {})
    })
  }

  private compareVisualBaseline(
    execution: PlanExecution,
    visualEvidence: FigPluginVisualEvidence[]
  ): FigPluginVisualBaselineComparison | undefined {
    // Property checkpoints cannot restore source pixels or authorize a replacement image.
    if (execution.executionAssets !== undefined) return undefined
    const scopeKey = visualBaselineScopeKey({
      pluginId: execution.call.session.binding.pluginId,
      host: execution.call.session.binding.host,
      projectId: execution.call.session.binding.projectId,
      documentId: execution.context.documentId,
      scopeId: execution.context.scopeId
    })
    const record = [...this.visualBaselines.values()].find(
      (record) => visualBaselineScopeKey(record.value) === scopeKey
    )
    const baseline = record?.value
    if (
      !baseline ||
      baseline.adapterVersion !== execution.preview.adapterVersion ||
      record?.recoveryScope.recoveryIdentity !== execution.context.recoveryIdentity
    )
      return undefined
    const currentByTarget = new Map(
      visualEvidence.map((item) => [item.targetId, item.after] as const)
    )
    if (
      currentByTarget.size !== baseline.targets.length ||
      baseline.targets.some((target) => !currentByTarget.has(target.targetId))
    )
      return undefined
    const targets = baseline.targets.map((target) => {
      const current = currentByTarget.get(target.targetId)!
      return {
        targetId: target.targetId,
        baseline: target.accepted,
        current,
        changed:
          target.accepted.sha256 !== current.sha256 ||
          target.accepted.width !== current.width ||
          target.accepted.height !== current.height
      }
    })
    const changedCount = targets.filter((target) => target.changed).length
    return figPluginVisualBaselineComparisonSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      baselineId: baseline.baselineId,
      executionId: execution.executionId,
      baselineEvidenceSha256: baseline.visualEvidenceSha256,
      visualEvidenceSha256: digest(visualEvidence),
      comparedAt: execution.updatedAt,
      targets,
      changedCount,
      exactMatch: changedCount === 0
    })
  }

  private executionPreview(execution: PlanExecution): FigPluginExecutionPreview {
    // Difference values are z.unknown(): parsing alone retains their nested object
    // references and would let a preview consumer change the reviewed image hashes.
    return structuredClone(
      figPluginExecutionPreviewSchema.parse({
        ...execution.preview,
        state: execution.state
      })
    )
  }

  private allPlanExecutions(): PlanExecution[] {
    return [
      ...[...this.calls.values()].flatMap((call) => (call.execution ? [call.execution] : [])),
      ...this.visualCorrectionExecutions.values()
    ]
  }

  private correctionAttempt(
    authorization: FigPluginVisualCorrectionAuthorization
  ): FigPluginVisualCorrectionAttempt {
    return {
      authorizationId: authorization.authorizationId,
      baselineId: authorization.baselineId,
      sourceExecutionId: authorization.sourceExecutionId,
      round: authorization.round,
      maxCorrectionRounds: authorization.maxCorrectionRounds,
      authorizedTargetIds: [...authorization.authorizedTargetIds]
    }
  }

  private executionForCall(call: Call, executionId?: string): PlanExecution {
    const execution = executionId ? this.findExecution(executionId) : call.execution
    if (!execution || execution.call !== call) throw new FigPluginBridgeError('INVALID_REQUEST')
    return execution
  }

  private correctionAuthority(execution: PlanExecution):
    | {
        authorizationRecord: VisualCorrectionAuthorizationRecord
        baselineRecord: VisualBaselineRecord
      }
    | undefined {
    const attempt = execution.visualCorrection
    if (!attempt) return undefined
    const authorizationRecord = this.visualCorrectionAuthorizations.get(attempt.authorizationId)
    const baselineRecord = this.visualBaselines.get(attempt.baselineId)
    const authorization = authorizationRecord?.value
    if (
      !authorizationRecord ||
      !authorization ||
      authorization.expiresAt <= this.clock() ||
      authorizationRecord.preparedExecutionId !== execution.executionId ||
      authorization.sourceExecutionId !== attempt.sourceExecutionId ||
      authorization.baselineId !== attempt.baselineId ||
      authorization.round !== attempt.round ||
      authorization.maxCorrectionRounds !== attempt.maxCorrectionRounds ||
      canonicalFigPluginJson(authorization.authorizedTargetIds) !==
        canonicalFigPluginJson(attempt.authorizedTargetIds) ||
      !baselineRecord ||
      baselineRecord.value.expiresAt <= this.clock() ||
      baselineRecord.value.correctionRoundsUsed + 1 !== attempt.round
    )
      throw new FigPluginBridgeError('EXPIRED')
    return { authorizationRecord, baselineRecord }
  }

  private registerPlanExecution(
    call: Call,
    content: string,
    context: HostContext,
    recovery?: FigPluginTaskRecovery,
    recoveredAssets?: { assets: FigPluginExecutionAsset[]; bytes: Map<string, Buffer> }
  ): PlanExecution | undefined {
    let checked: HostPlanningPreview
    try {
      const parsed = JSON.parse(content) as { plan?: unknown }
      checked = createHostPlanningPreview(
        JSON.stringify(parsed.plan),
        context,
        recoveredAssets?.assets.map(executionAssetMetadata) ?? call.planningAssets?.assets,
        recovery?.images
      )
    } catch {
      return undefined
    }
    if (
      checked.executable !== true ||
      !checked.execution ||
      !this.allowNativeWrite(call.session.binding)
    )
      return undefined
    const executionId = randomBytes(16).toString('hex')
    const planSha256 = digest(checked.plan)
    const contextSha256 = digest(context)
    const createdAt = this.clock()
    let expiresAt = call.receipt.response.expiresAt
    if (expiresAt <= createdAt) return undefined
    const imageSteps = checked.plan.steps.filter(
      (step) => step.command === 'image.fill' || step.command === 'image.pixels'
    )
    if (imageSteps.length && recovery && !recoveredAssets) return undefined
    let executionAssets: FigPluginExecutionAsset[] | undefined = recoveredAssets?.assets
    if (imageSteps.length && !recovery) {
      this.requirePlanningAssets(call.session, call.planningAssets)
      const seen = new Set<string>()
      executionAssets = []
      for (const step of imageSteps) {
        if (seen.has(step.assetId)) continue
        seen.add(step.assetId)
        const source = call.session.assets.get(step.assetId)
        if (!source || source.value.sha256 !== step.sha256)
          throw new FigPluginBridgeError('EXPIRED')
        executionAssets.push(
          executionAssetFromSessionAsset(
            source.value,
            {
              sessionId: call.session.id,
              pluginId: call.session.binding.pluginId,
              projectId: call.session.binding.projectId,
              host: call.session.binding.host
            },
            createdAt
          )
        )
      }
    }
    if (executionAssets)
      expiresAt = Math.min(expiresAt, ...executionAssets.map((asset) => asset.expiresAt))
    const preview = figPluginExecutionPreviewSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId,
      callId: call.receipt.response.callId,
      pluginId: call.session.binding.pluginId,
      host: call.session.binding.host,
      projectId: call.session.binding.projectId,
      documentId: context.documentId,
      scopeId: context.scopeId,
      captureId: context.captureId,
      plan: checked.plan,
      planSha256,
      contextSha256,
      adapterVersion: checked.execution.adapterVersion,
      rollback: checked.execution.rollback,
      visualAudit: checked.execution.visualAudit,
      risk: recovery?.rebind ? 'high' : checked.risk,
      differences: checked.differences,
      ...(executionAssets ? { executionAssets } : {}),
      ...(recovery ? { recovery } : {}),
      state: 'awaiting-approval',
      requiresWriteApproval: true,
      createdAt,
      expiresAt
    })
    const previewSha256 = digest({
      plan: checked.plan,
      differences: checked.differences,
      risk: recovery?.rebind ? 'high' : checked.risk,
      planSha256,
      contextSha256,
      adapterVersion: checked.execution.adapterVersion,
      rollback: checked.execution.rollback,
      visualAudit: checked.execution.visualAudit,
      ...(executionAssets ? { executionAssets } : {}),
      ...(recovery ? { recovery } : {})
    })
    const execution: PlanExecution = {
      executionId,
      runId: recovery?.sourceExecutionId ?? executionId,
      auditSequence: 0,
      actionId: executionId,
      call,
      plan: checked.plan,
      context,
      preview,
      planSha256,
      contextSha256,
      previewSha256,
      ...(executionAssets ? { executionAssets } : {}),
      ...(recoveredAssets ? { recoveryAssetBytes: recoveredAssets.bytes } : {}),
      state: 'awaiting-approval',
      completed: 0,
      effect: 'none',
      cursor: 0,
      progress: [],
      progressFingerprints: new Map(),
      ...(recovery ? { recovery } : {}),
      updatedAt: createdAt
    }
    if (execution.recoveryAssetBytes) {
      this.assetCount += execution.recoveryAssetBytes.size
      for (const bytes of execution.recoveryAssetBytes.values()) this.assetBytes += bytes.byteLength
    }
    call.execution = execution
    this.recordExecutionAudit(execution)
    return execution
  }

  private recordExecutionAudit(
    execution: PlanExecution,
    visualBaseline?: FigPluginVisualBaseline,
    visualCorrectionAuthorization?: FigPluginVisualCorrectionAuthorization
  ): void {
    if (terminalExecution.has(execution.state)) this.releaseRecoveryAssets(execution)
    if (!this.audit) return
    try {
      this.audit({
        schemaVersion: 1,
        at: this.clock(),
        executionId: execution.executionId,
        correlationId: execution.call.receipt.correlationId,
        runId: execution.runId,
        sequence: ++execution.auditSequence,
        callId: execution.call.receipt.response.callId,
        requestId: execution.call.receipt.requestId,
        pluginId: execution.call.session.binding.pluginId,
        host: execution.call.session.binding.host,
        projectId: execution.call.session.binding.projectId,
        state: execution.state,
        completed: execution.completed,
        total: execution.plan.steps.length,
        effect: execution.effect,
        risk: execution.preview.risk,
        planSha256: execution.planSha256,
        previewSha256: execution.previewSha256,
        adapterVersion: execution.preview.adapterVersion,
        rollback: execution.preview.rollback,
        visualAudit: execution.preview.visualAudit,
        durationMs: Math.max(0, execution.updatedAt - execution.preview.createdAt),
        ...(execution.visualEvidence
          ? {
              visualEvidenceCount: execution.visualEvidence.length,
              visualEvidenceSha256: digest(execution.visualEvidence)
            }
          : {}),
        ...(execution.pixelAudit
          ? {
              pixelAudit: {
                outcome: execution.pixelAudit.outcome,
                comparedTargets: execution.pixelAudit.comparedTargets,
                changedTargets: execution.pixelAudit.changedTargets,
                unavailableTargets: execution.pixelAudit.unavailableTargets,
                changedPixels: execution.pixelAudit.changedPixels
              }
            }
          : {}),
        ...(visualBaseline
          ? {
              visualBaselineId: visualBaseline.baselineId,
              visualBaselineEvidenceSha256: visualBaseline.visualEvidenceSha256,
              visualBaselineAcceptedAt: visualBaseline.acceptedAt,
              visualBaselineExpiresAt: visualBaseline.expiresAt,
              maxCorrectionRounds: visualBaseline.maxCorrectionRounds
            }
          : {}),
        ...(execution.visualBaselineComparison
          ? {
              visualComparisonBaselineId: execution.visualBaselineComparison.baselineId,
              visualComparisonTargetCount: execution.visualBaselineComparison.targets.length,
              visualComparisonChangedCount: execution.visualBaselineComparison.changedCount,
              visualComparisonSha256: digest(execution.visualBaselineComparison)
            }
          : {}),
        ...(execution.recovery
          ? {
              taskRecovery: {
                baselineId: execution.recovery.baselineId,
                sourceExecutionId: execution.recovery.sourceExecutionId,
                round: execution.recovery.round,
                maxCorrectionRounds: execution.recovery.maxCorrectionRounds,
                targetCount: execution.recovery.targetIds.length,
                consumed: execution.claimedAt !== undefined,
                ...(execution.recovery.rebind ? { reassociationRequested: true as const } : {}),
                ...(execution.recovery.rebind?.document
                  ? { documentReassociationRequested: true as const }
                  : {})
              }
            }
          : {}),
        ...(execution.visualCorrection
          ? {
              correctionAttempt: {
                authorizationId: execution.visualCorrection.authorizationId,
                baselineId: execution.visualCorrection.baselineId,
                sourceExecutionId: execution.visualCorrection.sourceExecutionId,
                round: execution.visualCorrection.round,
                maxCorrectionRounds: execution.visualCorrection.maxCorrectionRounds,
                targetCount: execution.visualCorrection.authorizedTargetIds.length,
                consumed: execution.claimedAt !== undefined
              }
            }
          : {}),
        ...(visualCorrectionAuthorization
          ? {
              visualCorrectionAuthorizationId: visualCorrectionAuthorization.authorizationId,
              visualCorrectionRound: visualCorrectionAuthorization.round,
              visualCorrectionMaxRounds: visualCorrectionAuthorization.maxCorrectionRounds,
              visualCorrectionTargetCount: visualCorrectionAuthorization.authorizedTargetIds.length,
              visualCorrectionComparisonSha256: visualCorrectionAuthorization.comparisonSha256,
              visualCorrectionExpiresAt: visualCorrectionAuthorization.expiresAt
            }
          : {}),
        ...(execution.errorCode ? { errorCode: execution.errorCode } : {})
      })
    } catch {
      // Audit cannot affect document-state transitions or leak host errors.
    }
  }

  async createPairing(binding: FigPluginRuntimeBinding): Promise<{
    ticketId: string
    pairingSecret: string
    expiresAt: number
    bridgeOrigin: string
    pluginId: string
    host: FigPluginRuntimeBinding['host']
    artifactSha256: string
  }> {
    this.enter()
    const snapshot = Object.freeze(
      parseFigPluginBridgeValue(figPluginRuntimeBindingSchema, binding)
    )
    if (this.tickets.size >= 32) throw new FigPluginBridgeError('BUSY')
    const ticketId = randomBytes(16).toString('hex')
    const ticket: Ticket = {
      binding: snapshot,
      secret: randomBytes(32).toString('hex'),
      expiresAt: this.clock() + TICKET_TTL,
      failures: 0,
      state: 'issuing'
    }
    // Reservation identity is a lifetime epoch: revoke/expiry/dispose removes it,
    // so an outstanding validator can never resurrect an old installation.
    this.tickets.set(ticketId, ticket)
    this.scheduleCleanup()
    const valid = await this.validate(snapshot)
    this.prune()
    if (this.closed || this.tickets.get(ticketId) !== ticket) {
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    if (!valid) {
      this.removeTicket(ticketId, ticket)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    ticket.state = 'ready'
    return {
      ticketId,
      pairingSecret: ticket.secret,
      expiresAt: ticket.expiresAt,
      bridgeOrigin: snapshot.bridgeOrigin,
      pluginId: snapshot.pluginId,
      host: snapshot.host,
      artifactSha256: snapshot.artifactSha256
    }
  }

  /** Main-only rollback for a ticket whose native-consent operation could not deliver it. */
  discardPairing(ticketId: string): void {
    if (this.closed) return
    const ticket = this.tickets.get(ticketId)
    if (ticket) this.removeTicket(ticketId, ticket)
    this.scheduleCleanup()
  }

  async redeem(input: FigPluginPairRequest): Promise<FigPluginPairResponse> {
    this.enter()
    let request: FigPluginPairRequest | undefined
    let ticket: Ticket | undefined
    try {
      // Count malformed secrets against a known ticket, without revealing its existence.
      if (isId(input?.ticketId)) ticket = this.tickets.get(input.ticketId)
      request = parseFigPluginBridgeValue(figPluginPairRequestSchema, input)
    } catch {
      // Authentication, schema failures and unknown IDs share one public error.
    }
    const matches = secretEquals(request?.pairingSecret, ticket?.secret)
    const authorized =
      request &&
      ticket &&
      ticket.state === 'ready' &&
      matches &&
      request.pluginId === ticket.binding.pluginId &&
      request.host === ticket.binding.host &&
      request.artifactSha256 === ticket.binding.artifactSha256
    if (this.failures.length >= 20 || !authorized || !ticket || !request) {
      if (this.failures.length < 20) this.failures.push(this.clock())
      if (!authorized && ticket?.state === 'ready' && ++ticket.failures >= 5) {
        // Locate by identity even if parsing the untrusted envelope failed.
        for (const [id, current] of this.tickets) {
          if (current === ticket) this.removeTicket(id, ticket)
        }
      }
      this.scheduleCleanup()
      throw new FigPluginBridgeError('UNAUTHORIZED')
    }
    const pending = [...this.tickets.values()].filter((item) => item.state === 'redeeming').length
    if (this.sessions.size + pending >= 16) throw new FigPluginBridgeError('BUSY')
    // Consume and reserve a session slot synchronously, before the first await.
    ticket.state = 'redeeming'
    const valid = await this.validate(ticket.binding)
    this.prune()
    if (this.closed || this.tickets.get(request.ticketId) !== ticket) {
      throw new FigPluginBridgeError('UNAUTHORIZED')
    }
    this.removeTicket(request.ticketId, ticket)
    if (!valid) {
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    const now = this.clock()
    const session: Session = {
      id: randomBytes(16).toString('hex'),
      token: randomBytes(32).toString('hex'),
      binding: ticket.binding,
      expiresAt: now + SESSION_TTL,
      idleAt: now + IDLE_TTL,
      highWater: 0,
      requests: new Map(),
      imageGenerationRequests: new Map(),
      preparing: 0,
      assets: new Map(),
      preparingAssets: 0
    }
    this.sessions.set(session.id, session)
    this.scheduleCleanup()
    return {
      protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
      sessionId: session.id,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      idleTimeoutMs: IDLE_TTL
    }
  }

  async prepareImageGeneration(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginImageGenerationProposalPrepareResponse> {
    const session = this.authenticate(sessionId, sessionToken, false)
    if (this.preparing >= 16 || session.preparing >= 2) throw new FigPluginBridgeError('BUSY')
    this.preparing++
    session.preparing++
    try {
      const request = parseFigPluginBridgeValue(
        figPluginImageGenerationProposalPrepareRequestSchema,
        input
      )
      await this.checkSession(session)
      const limits = this.nativeImageGenerationLimits(session)
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > limits.maxBytes)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      const fingerprint = digest({ purpose: 'image-generation', binding: session.binding, request })
      if (session.requests.has(request.requestId)) throw new FigPluginBridgeError('INVALID_REQUEST')
      const previous = session.imageGenerationRequests.get(request.requestId)
      if (previous) {
        if (previous.sequence !== request.sequence || previous.digest !== fingerprint)
          throw new FigPluginBridgeError('INVALID_REQUEST')
        return { ...previous.response }
      }
      if (request.sequence <= session.highWater) throw new FigPluginBridgeError('INVALID_REQUEST')
      if (
        this.sessionReceiptCount(session) >= 64 ||
        this.receiptCount() >= 256 ||
        [...this.nativeImageGenerations.values()].filter(
          (item) => !nativeGenerationTerminal(item.status.phase)
        ).length >= 32 ||
        this.hasActiveNativeGeneration(session) ||
        [...this.calls.values()].some((call) => call.session === session && active(call))
      )
        throw new FigPluginBridgeError('BUSY')
      const now = this.clock()
      const expiresAt = Math.min(now + limits.timeoutMs, session.expiresAt, session.idleAt)
      if (expiresAt <= now) throw new FigPluginBridgeError('EXPIRED')
      const proposalId = randomBytes(16).toString('hex')
      let generationRequestId = randomBytes(16).toString('hex')
      while (generationRequestId === request.requestId)
        generationRequestId = randomBytes(16).toString('hex')
      const response = figPluginImageGenerationProposalPrepareResponseSchema.parse({
        protocol: 1,
        requestId: request.requestId,
        proposalId,
        status: 'awaiting-approval',
        createdAt: now,
        expiresAt
      })
      const preview = figPluginNativeImageGenerationDesktopProposalSchema.parse({
        proposalId,
        requestId: request.requestId,
        generationRequestId,
        sessionId: session.id,
        pluginId: session.binding.pluginId,
        host: session.binding.host,
        projectId: session.binding.projectId,
        prompt: request.prompt,
        payloadSha256: fingerprint,
        createdAt: now,
        expiresAt
      })
      const proposal: NativeImageGeneration = {
        session,
        sequence: request.sequence,
        digest: fingerprint,
        ...limits,
        response,
        status: {
          protocol: 1,
          requestId: request.requestId,
          proposalId,
          phase: 'awaiting-approval',
          createdAt: now,
          updatedAt: now,
          expiresAt
        },
        preview,
        abort: new AbortController(),
        claimed: false
      }
      this.nativeImageGenerations.set(proposalId, proposal)
      session.imageGenerationRequests.set(request.requestId, proposal)
      session.highWater = request.sequence
      this.scheduleCleanup()
      return { ...response }
    } finally {
      this.preparing--
      session.preparing--
    }
  }

  async imageGenerationStatus(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginImageGenerationProposalStatus> {
    const session = this.authenticate(sessionId, sessionToken, false)
    const proposal = this.ownedNativeImageGeneration(session, input)
    await this.checkSession(session)
    if (!nativeGenerationTerminal(proposal.status.phase))
      this.checkNativeImageGenerationLimits(proposal)
    return figPluginImageGenerationProposalStatusSchema.parse(proposal.status)
  }

  async cancelImageGeneration(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<void> {
    const session = this.authenticate(sessionId, sessionToken, false)
    this.stopNativeImageGeneration(this.ownedNativeImageGeneration(session, input), 'CANCELLED')
    this.scheduleCleanup()
  }

  nativeImageGenerationProposals(): FigPluginNativeImageGenerationDesktopProposal[] {
    this.enter()
    return [...this.nativeImageGenerations.values()]
      .filter(
        (item) => !item.claimed && !!item.preview && !nativeGenerationTerminal(item.status.phase)
      )
      .map((item) => figPluginNativeImageGenerationDesktopProposalSchema.parse(item.preview))
  }

  async claimNativeImageGeneration(
    input: FigPluginNativeImageGenerationDesktopKey
  ): Promise<FigPluginNativeImageGenerationReceipt> {
    const proposal = this.mainNativeImageGeneration(input)
    await this.checkSession(proposal.session)
    this.checkNativeImageGenerationLimits(proposal)
    if (proposal.claimed || !proposal.preview || nativeGenerationTerminal(proposal.status.phase))
      throw new FigPluginBridgeError('BUSY')
    const preview = proposal.preview
    const receipt: FigPluginNativeImageGenerationReceipt = Object.freeze({
      proposalId: preview.proposalId,
      nativeRequestId: preview.requestId,
      payloadSha256: preview.payloadSha256,
      request: Object.freeze({
        sessionId: preview.sessionId,
        pluginId: preview.pluginId,
        projectId: preview.projectId,
        requestId: preview.generationRequestId,
        prompt: preview.prompt
      }),
      expiresAt: preview.expiresAt,
      sessionExpiresAt: proposal.session.expiresAt,
      signal: proposal.abort.signal
    })
    proposal.claimed = true
    proposal.receipt = receipt
    proposal.status = { ...proposal.status, phase: 'preparing', updatedAt: this.clock() }
    this.nativeImageGenerationReceipts.set(receipt, proposal)
    return receipt
  }

  isNativeImageGenerationCurrent(receipt: FigPluginNativeImageGenerationReceipt): boolean {
    try {
      this.enter()
      const proposal = this.nativeImageGenerationReceipts.get(receipt)
      return !!(
        proposal &&
        proposal.receipt === receipt &&
        this.nativeImageGenerations.get(receipt.proposalId) === proposal &&
        this.sessions.get(proposal.session.id) === proposal.session &&
        !proposal.abort.signal.aborted &&
        !nativeGenerationTerminal(proposal.status.phase) &&
        receipt.expiresAt > this.clock()
      )
    } catch {
      return false
    }
  }

  async validateNativeImageGeneration(
    receipt: FigPluginNativeImageGenerationReceipt
  ): Promise<void> {
    if (!this.isNativeImageGenerationCurrent(receipt))
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    const proposal = this.nativeImageGenerationReceipts.get(receipt)!
    await this.checkSession(proposal.session)
    this.checkNativeImageGenerationLimits(proposal)
    if (!this.isNativeImageGenerationCurrent(receipt))
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
  }

  observeNativeImageGeneration(
    receipt: FigPluginNativeImageGenerationReceipt,
    input: FigPluginImageGenerationState
  ): void {
    const proposal = this.nativeImageGenerationReceipts.get(receipt)
    if (!proposal || proposal.receipt !== receipt)
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    if (!this.isNativeImageGenerationCurrent(receipt)) return
    try {
      const state = figPluginImageGenerationStateSchema.parse(input)
      if (
        (['sessionId', 'pluginId', 'projectId', 'requestId'] as const).some(
          (key) => state[key] !== receipt.request[key]
        ) ||
        (proposal.jobId && proposal.jobId !== state.jobId) ||
        state.createdAt < proposal.response.createdAt ||
        state.updatedAt > this.clock() ||
        state.expiresAt > receipt.expiresAt ||
        (proposal.observed &&
          (state.updatedAt < proposal.observed.updatedAt ||
            state.createdAt !== proposal.observed.createdAt ||
            state.expiresAt > proposal.observed.expiresAt))
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      const phases: FigPluginImageGenerationState['phase'][] = [
        'preparing',
        'awaiting-approval',
        'generating',
        'materializing',
        'awaiting-acceptance',
        'accepted'
      ]
      if (
        proposal.observed &&
        phases.includes(state.phase) &&
        phases.indexOf(state.phase) < phases.indexOf(proposal.observed.phase)
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      proposal.jobId = state.jobId
      proposal.observed = state
      proposal.status = figPluginImageGenerationProposalStatusSchema.parse({
        ...proposal.status,
        phase: state.phase,
        updatedAt: state.updatedAt,
        ...(state.error ? { error: state.error } : {})
      })
      if (nativeGenerationTerminal(state.phase)) {
        proposal.preview = undefined
        if (state.phase !== 'accepted') proposal.abort.abort()
      }
      this.scheduleCleanup()
    } catch {
      this.stopNativeImageGeneration(proposal, 'CONFIGURATION_CHANGED')
    }
  }

  finishNativeImageGeneration(
    receipt: FigPluginNativeImageGenerationReceipt,
    outcome: FigPluginNativeImageGenerationOutcome
  ): void {
    const proposal = this.nativeImageGenerationReceipts.get(receipt)
    if (!proposal || proposal.receipt !== receipt)
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    if (nativeGenerationTerminal(proposal.status.phase)) return
    if (!['declined', 'cancelled', 'failed'].includes(outcome.phase))
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const status = figPluginImageGenerationProposalStatusSchema.parse({
      ...proposal.status,
      phase: outcome.phase,
      updatedAt: Math.max(this.clock(), proposal.response.createdAt),
      ...(outcome.error ? { error: outcome.error } : {})
    })
    proposal.status = status
    proposal.preview = undefined
    proposal.abort.abort()
    this.scheduleCleanup()
  }

  cancelNativeImageGeneration(input: FigPluginNativeImageGenerationDesktopKey): void {
    this.stopNativeImageGeneration(this.mainNativeImageGeneration(input), 'CANCELLED')
    this.scheduleCleanup()
  }

  invalidateNativeImageGenerationProposals(): void {
    this.enter()
    for (const proposal of this.nativeImageGenerations.values())
      this.stopNativeImageGeneration(proposal, 'CONFIGURATION_CHANGED')
    this.scheduleCleanup()
  }

  private mainNativeImageGeneration(input: FigPluginNativeImageGenerationDesktopKey) {
    this.enter()
    const key = parseFigPluginBridgeValue(figPluginNativeImageGenerationDesktopKeySchema, input)
    const proposal = this.nativeImageGenerations.get(key.proposalId)
    if (!proposal || !secretEquals(key.payloadSha256, proposal.digest))
      throw new FigPluginBridgeError('UNAUTHORIZED')
    return proposal
  }

  private ownedNativeImageGeneration(session: Session, input: unknown) {
    const key = parseFigPluginBridgeValue(
      figPluginImageGenerationProposalStatusRequestSchema,
      input
    )
    const proposal = session.imageGenerationRequests.get(key.requestId)
    if (!proposal || proposal.response.proposalId !== key.proposalId)
      throw new FigPluginBridgeError('UNAUTHORIZED')
    return proposal
  }

  private nativeImageGenerationLimits(session: Session) {
    const maxBytes = this.requireAssetTransfer(session)
    let timeoutMs = 0
    try {
      timeoutMs = this.imageGenerationTimeoutMs(Object.freeze({ ...session.binding }))
    } catch {
      /* deny */
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new FigPluginBridgeError('DENIED')
    return { maxBytes, timeoutMs: Math.min(FIGPLUGIN_NATIVE_IMAGE_GENERATION_MAX_MS, timeoutMs) }
  }

  private checkNativeImageGenerationLimits(proposal: NativeImageGeneration): void {
    this.requireCurrentSession(proposal.session)
    try {
      const current = this.nativeImageGenerationLimits(proposal.session)
      if (current.maxBytes !== proposal.maxBytes || current.timeoutMs !== proposal.timeoutMs)
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    } catch {
      this.stopNativeImageGeneration(proposal, 'CONFIGURATION_CHANGED')
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
  }

  private stopNativeImageGeneration(
    proposal: NativeImageGeneration,
    code: FigPluginBridgeErrorCode
  ) {
    if (nativeGenerationTerminal(proposal.status.phase)) return
    proposal.status = {
      ...proposal.status,
      phase: code === 'CANCELLED' ? 'cancelled' : 'failed',
      error: code,
      updatedAt: Math.max(this.clock(), proposal.response.createdAt)
    }
    proposal.preview = undefined
    // Publish the terminal state before firing reentrant coordinator cancellation observers.
    proposal.abort.abort()
  }

  private hasActiveNativeGeneration(session: Session): boolean {
    return [...session.imageGenerationRequests.values()].some(
      (item) => !nativeGenerationTerminal(item.status.phase)
    )
  }

  private sessionReceiptCount(session: Session): number {
    return session.requests.size + session.imageGenerationRequests.size
  }

  private receiptCount(): number {
    return [...this.sessions.values()].reduce(
      (sum, item) => sum + this.sessionReceiptCount(item),
      0
    )
  }

  async prepare(
    sessionId: string,
    sessionToken: string,
    input: FigPluginBridgePrepareRequest
  ): Promise<FigPluginBridgePrepareResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    if (this.preparing >= 16 || session.preparing >= 2) throw new FigPluginBridgeError('BUSY')
    // Bound retained inputs and coalesced validation waiters before parsing/stringifying.
    this.preparing += 1
    session.preparing += 1
    try {
      const request = parseFigPluginBridgeValue(figPluginBridgePrepareRequestSchema, input)
      if (request.hostContext && request.hostContext.host !== session.binding.host)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      if (request.hostContext?.execution && !this.allowNativeWrite(session.binding))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      if (request.contextImage) {
        try {
          validateHostContextImageBytes(request.contextImage)
        } catch {
          throw new FigPluginBridgeError('INVALID_REQUEST')
        }
      }
      const assetCatalog = request.assetReferences
        ? this.resolvePlanningAssets(session, request.assetReferences)
        : undefined
      const planning: Pick<
        FigPluginBridgePreview,
        'featureId' | 'hostContext' | 'contextImage' | 'assetReferences' | 'assetCatalog'
      > =
        request.featureId === 'plan-preview'
          ? {
              featureId: request.featureId,
              hostContext: request.hostContext!,
              ...(request.contextImage ? { contextImage: request.contextImage } : {}),
              ...(assetCatalog ? { assetReferences: request.assetReferences, assetCatalog } : {})
            }
          : {}
      let canonical: string
      try {
        canonical = canonicalFigPluginJson({
          binding: session.binding,
          prompt: request.prompt,
          context: request.context,
          ...planning
        })
      } catch {
        throw new FigPluginBridgeError('INVALID_REQUEST')
      }
      const payloadDigest = createHash('sha256').update(canonical, 'utf8').digest('hex')
      await this.checkSession(session)
      this.requireCurrentSession(session)
      this.requirePlanningAssets(session, assetCatalog)
      // All replay, ordering and admission decisions are atomic AFTER validation.
      if (session.imageGenerationRequests.has(request.requestId))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      const previous = session.requests.get(request.requestId)
      if (previous) {
        if (previous.sequence !== request.sequence || previous.digest !== payloadDigest) {
          throw new FigPluginBridgeError('INVALID_REQUEST')
        }
        // Replay the original prepare receipt; status() owns the current outcome.
        return { ...previous.response }
      }
      if (request.sequence <= session.highWater) throw new FigPluginBridgeError('INVALID_REQUEST')
      if (
        this.sessionReceiptCount(session) >= 64 ||
        this.receiptCount() >= 256 ||
        this.hasActiveNativeGeneration(session) ||
        this.calls.size >= 32 ||
        [...this.calls.values()].some((call) => call.session === session && active(call))
      ) {
        throw new FigPluginBridgeError('BUSY')
      }
      const callId = randomBytes(16).toString('hex')
      const expiresAt = Math.min(
        this.clock() + CALL_TTL,
        session.expiresAt,
        ...(assetCatalog?.assets.map((asset) => asset.expiresAt) ?? [])
      )
      const response: FigPluginBridgePrepareResponse = {
        protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
        callId,
        status: 'awaiting-approval',
        expiresAt
      }
      const receipt: Receipt = {
        sequence: request.sequence,
        requestId: request.requestId,
        correlationId: randomBytes(16).toString('hex'),
        digest: payloadDigest,
        response
      }
      const preview: FigPluginBridgePreview = {
        callId,
        pluginId: session.binding.pluginId,
        host: session.binding.host,
        projectId: session.binding.projectId,
        profileId: session.binding.profileId,
        profileRevision: session.binding.profileRevision,
        context: request.context,
        prompt: request.prompt,
        expiresAt,
        payloadSha256: payloadDigest,
        estimatedInputTokens: request.contextImage
          ? Math.ceil(
              Buffer.byteLength(
                canonicalFigPluginJson({
                  binding: session.binding,
                  prompt: request.prompt,
                  context: request.context,
                  ...planning,
                  contextImage: contextImageSummary(request.contextImage)
                }),
                'utf8'
              ) / 4
            ) + HOST_CONTEXT_IMAGE_TOKEN_BUDGET
          : Math.ceil(Buffer.byteLength(canonical, 'utf8') / 4),
        ...planning
      }
      const call: Call = {
        session,
        receipt,
        preview,
        ...(planning.hostContext ? { hostContext: planning.hostContext } : {}),
        ...(assetCatalog ? { planningAssets: assetCatalog } : {}),
        status: { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'awaiting-approval' }
      }
      if (this.planningAudit) {
        let profile: FigPluginPlanningModelMetadata = {}
        try {
          const snapshot = this.planningProfile?.(Object.freeze({ ...session.binding })) ?? {}
          const { provider, modelName } = figPluginPlanningModelMetadataSchema.shape
          const route = provider.safeParse(snapshot.provider)
          const label = modelName.safeParse(snapshot.modelName)
          profile = {
            ...(route.success && route.data !== undefined ? { provider: route.data } : {}),
            ...(label.success && label.data !== undefined ? { modelName: label.data } : {})
          }
        } catch {
          // Missing diagnostic metadata cannot prevent or authorize a request.
        }
        call.planningAudit = {
          startedAt: this.clock(),
          sequence: 0,
          terminal: false,
          summary: {
            callId,
            correlationId: receipt.correlationId,
            requestId: receipt.requestId,
            pluginId: session.binding.pluginId,
            host: session.binding.host,
            projectId: session.binding.projectId,
            profileId: session.binding.profileId,
            profileRevision: session.binding.profileRevision,
            featureId: request.featureId ?? 'read-only-analysis',
            inputBytes: Buffer.byteLength(JSON.stringify(request), 'utf8'),
            estimatedInputTokens: preview.estimatedInputTokens,
            nodeCount: request.hostContext?.nodes.length ?? request.context.nodes.length,
            imageCount: request.contextImage ? 1 : 0,
            imageBytes: request.contextImage?.sizeBytes ?? 0,
            ...(assetCatalog
              ? { assetCount: assetCatalog.assets.length, assetCatalogSha256: digest(assetCatalog) }
              : {}),
            ...(profile.provider === undefined ? {} : { provider: profile.provider }),
            ...(profile.modelName === undefined ? {} : { modelName: profile.modelName })
          }
        }
      }
      this.calls.set(callId, call)
      session.requests.set(request.requestId, receipt)
      session.highWater = request.sequence
      this.recordPlanningAudit(call, 'awaiting-approval')
      this.scheduleCleanup()
      return { ...response }
    } finally {
      // Revocation/expiry cannot free capacity while the old validation is still pending.
      session.preparing -= 1
      this.preparing -= 1
    }
  }

  async status(
    sessionId: string,
    sessionToken: string,
    callId: string
  ): Promise<FigPluginBridgeStatusResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    this.ownedReceipt(session, callId)
    await this.checkSession(session)
    this.requireCurrentSession(session)
    this.ownedReceipt(session, callId)
    const call = this.calls.get(callId)
    return call
      ? { ...call.status }
      : { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'failed', errorCode: 'EXPIRED' }
  }

  /**
   * Return bounded, authenticated readiness diagnostics without probing a Provider or host data.
   * Provider state uses recent approved calls for this session; host state uses the supplied
   * native probe. Missing evidence stays unknown and reachability never grants authority.
   */
  async readiness(
    sessionId: string,
    sessionToken: string,
    input: FigPluginBridgeReadinessRequest = { protocol: FIGPLUGIN_BRIDGE_PROTOCOL }
  ): Promise<FigPluginBridgeReadinessResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    await this.checkSession(session)
    this.requireCurrentSession(session)
    const request = parseFigPluginBridgeValue(figPluginBridgeReadinessRequestSchema, input)
    const observed = request.hostProbe
    if (observed && observed.host !== session.binding.host)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const diagnostics = readinessFromHostProbe(observed, session.binding.host)
    return figPluginBridgeReadinessResponseSchema.parse({
      protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
      kind: 'figplugin-bridge-readiness',
      checkedAt: this.clock(),
      bridge: { state: 'ready', code: 'bridge-reachable' },
      configuration: { state: 'ready', code: 'configuration-current' },
      provider: this.providerReadiness(session, request.includeDiagnostics === true),
      resources: diagnostics.resources,
      host: {
        ...diagnostics.host,
        host: session.binding.host,
        capabilities: diagnostics.capabilities
      }
    })
  }

  /** Main-only receipt. Possessing a pathname, catalog ID or copied receipt data is not a grant. */
  async beginSessionAssetSelection(
    input: FigPluginDesktopAssetTarget
  ): Promise<FigPluginAssetSelection> {
    const session = this.desktopAssetSession(input)
    await this.checkSession(session)
    const maxBytes = this.requireAssetTransfer(session)
    this.checkAssetCapacity(session, 0)
    const selection: FigPluginAssetSelection = Object.freeze({
      target: Object.freeze({
        sessionId: session.id,
        pluginId: session.binding.pluginId,
        projectId: session.binding.projectId
      }),
      host: session.binding.host,
      bindingSha256: digest(session.binding),
      expiresAt: Math.min(session.expiresAt, session.idleAt),
      maxBytes
    })
    this.assetSelections.set(selection, session)
    return selection
  }

  async publishSessionAsset(
    selection: FigPluginAssetSelection,
    input: FigPluginMaterializedAsset
  ): Promise<FigPluginSessionAsset> {
    this.enter()
    const session = this.assetSelections.get(selection)
    if (!session) throw new FigPluginBridgeError('UNAUTHORIZED')
    // A failed or cancelled materialization must obtain fresh selection/consent, not replay this receipt.
    this.assetSelections.delete(selection)
    this.requireAssetSelection(selection, session)
    let owned: Buffer | undefined
    let reserved = 0
    try {
      if (
        !input ||
        Object.keys(input).sort().join(',') !== 'bytes,height,mimeType,width' ||
        !(input.bytes instanceof Uint8Array) ||
        !input.bytes.byteLength ||
        input.bytes.byteLength > Math.min(selection.maxBytes, this.requireAssetTransfer(session))
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      this.checkAssetCapacity(session, input.bytes.byteLength)
      reserved = input.bytes.byteLength
      this.preparingAssets++
      this.preparingAssetBytes += reserved
      session.preparingAssets++
      // Copy before validation awaits: even an otherwise trusted caller cannot change granted bytes later.
      owned = Buffer.from(input.bytes)
      const image = inspectSessionAssetImage(owned)
      if (
        image.mimeType !== input.mimeType ||
        image.width !== input.width ||
        image.height !== input.height
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      await this.checkSession(session)
      this.requireAssetSelection(selection, session)
      if (owned.byteLength > this.requireAssetTransfer(session))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      const now = this.clock()
      if (now >= selection.expiresAt) throw new FigPluginBridgeError('EXPIRED')
      const value = figPluginSessionAssetSchema.parse({
        version: 1,
        kind: 'session-image-asset',
        purpose: 'local-preview',
        ...selection.target,
        host: selection.host,
        assetId: randomBytes(16).toString('hex'),
        ...image,
        sha256: createHash('sha256').update(owned).digest('hex'),
        sizeBytes: owned.byteLength,
        chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
        chunkCount: Math.ceil(owned.byteLength / FIGPLUGIN_ASSET_CHUNK_BYTES),
        createdAt: now,
        expiresAt: Math.min(
          now + FIGPLUGIN_ASSET_TTL_MS,
          selection.expiresAt,
          session.expiresAt,
          session.idleAt
        )
      })
      session.assets.set(value.assetId, { value: Object.freeze(value), bytes: owned })
      this.assetCount++
      this.assetBytes += owned.byteLength
      owned = undefined
      this.scheduleCleanup()
      return figPluginSessionAssetSchema.parse(value)
    } catch (error) {
      throw error instanceof FigPluginBridgeError
        ? error
        : new FigPluginBridgeError('INVALID_REQUEST')
    } finally {
      owned?.fill(0)
      if (reserved) {
        this.preparingAssets--
        this.preparingAssetBytes -= reserved
        session.preparingAssets--
      }
    }
  }

  async listSessionAssets(input: FigPluginDesktopAssetTarget): Promise<FigPluginAssetList> {
    const session = this.desktopAssetSession(input)
    await this.checkSession(session)
    this.requireAssetTransfer(session)
    return this.assetCatalog(session)
  }

  async revokeSessionAsset(input: FigPluginDesktopAssetRevoke): Promise<void> {
    const request = parseFigPluginBridgeValue(figPluginDesktopAssetRevokeSchema, input)
    const session = this.desktopAssetSession({
      sessionId: request.sessionId,
      pluginId: request.pluginId,
      projectId: request.projectId
    })
    const record = session.assets.get(request.assetId)
    if (!record) return
    if (record.value.sha256 !== request.sha256) throw new FigPluginBridgeError('INVALID_REQUEST')
    // Trusted main revocation only removes authority. Do not let a pending
    // asynchronous configuration check deliver one more chunk ahead of it.
    this.removeSessionAsset(session, request.assetId)
    this.scheduleCleanup()
  }

  async assetList(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginAssetList> {
    const session = this.authenticate(sessionId, sessionToken)
    parseFigPluginBridgeValue(figPluginAssetListRequestSchema, input)
    await this.checkSession(session)
    this.requireAssetTransfer(session)
    return this.assetCatalog(session)
  }

  async assetChunk(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginAssetChunk> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginAssetReadRequestSchema, input)
    await this.checkSession(session)
    this.requireAssetTransfer(session)
    const record = session.assets.get(request.assetId)
    if (!record) throw new FigPluginBridgeError('EXPIRED')
    if (request.sha256 !== record.value.sha256 || request.index >= record.value.chunkCount)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const start = request.index * FIGPLUGIN_ASSET_CHUNK_BYTES
    return figPluginAssetChunkSchema.parse({
      protocol: 1,
      purpose: 'local-preview',
      sessionId: session.id,
      assetId: record.value.assetId,
      chunk: {
        version: 1,
        kind: 'content-addressed-binary-chunk',
        sha256: record.value.sha256,
        index: request.index,
        chunkCount: record.value.chunkCount,
        bytesBase64: record.bytes
          .subarray(start, start + FIGPLUGIN_ASSET_CHUNK_BYTES)
          .toString('base64')
      }
    })
  }

  /** A model catalog or local-preview lease is not an execution byte grant. */
  async planAssetChunk(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginExecutionAssetChunk> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionAssetReadRequestSchema, input)
    this.ownedReceipt(session, request.callId)
    const execution = this.ownedExecution(session, request.executionId)
    const check = (): FigPluginExecutionAsset => {
      this.requireCurrentSession(session)
      this.expireExecution(execution)
      this.checkDocumentWrite(execution)
      if (
        this.ownedExecution(session, request.executionId) !== execution ||
        execution.call.receipt.response.callId !== request.callId ||
        !['claimed', 'executing', 'readback'].includes(execution.state) ||
        !execution.intent ||
        request.actionId !== execution.intent.actionId ||
        !secretEquals(request.planSha256, execution.planSha256)
      )
        throw new FigPluginBridgeError('DENIED')
      this.requireExecutionAssets(execution)
      const asset = execution.executionAssets?.find((item) => item.assetId === request.assetId)
      if (!asset || asset.sha256 !== request.sha256 || request.index >= asset.chunkCount)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return asset
    }
    check()
    await this.checkSession(session)
    const asset = check()
    const bytes =
      execution.recoveryAssetBytes?.get(asset.assetId) ?? session.assets.get(asset.assetId)?.bytes
    if (!bytes) throw new FigPluginBridgeError('EXPIRED')
    const start = request.index * FIGPLUGIN_ASSET_CHUNK_BYTES
    // No await after the last claim, source, revision and byte-ceiling check.
    return figPluginExecutionAssetChunkSchema.parse({
      protocol: 1,
      purpose: 'host-plan-execution',
      sessionId: session.id,
      callId: request.callId,
      executionId: request.executionId,
      actionId: request.actionId,
      planSha256: request.planSha256,
      assetId: asset.assetId,
      chunk: {
        version: 1,
        kind: 'content-addressed-binary-chunk',
        sha256: asset.sha256,
        index: request.index,
        chunkCount: asset.chunkCount,
        bytesBase64: bytes.subarray(start, start + FIGPLUGIN_ASSET_CHUNK_BYTES).toString('base64')
      }
    })
  }

  private desktopAssetSession(input: FigPluginDesktopAssetTarget): Session {
    this.enter()
    const target = parseFigPluginBridgeValue(figPluginDesktopAssetTargetSchema, input)
    const session = this.sessions.get(target.sessionId)
    if (
      !session ||
      session.binding.pluginId !== target.pluginId ||
      session.binding.projectId !== target.projectId
    )
      throw new FigPluginBridgeError('UNAUTHORIZED')
    return session
  }

  private requireAssetSelection(selection: FigPluginAssetSelection, session: Session): void {
    this.requireCurrentSession(session)
    if (selection.expiresAt <= this.clock()) throw new FigPluginBridgeError('EXPIRED')
    if (selection.bindingSha256 !== digest(session.binding))
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
  }

  private requireAssetTransfer(session: Session): number {
    this.requireCurrentSession(session)
    let allowed = false
    let maxBytes = 0
    try {
      allowed = this.allowAssetTransfer(Object.freeze({ ...session.binding })) === true
      maxBytes = this.assetByteLimit(Object.freeze({ ...session.binding }))
    } catch {
      /* deny */
    }
    if (!allowed || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      for (const id of session.assets.keys())
        this.removeSessionAsset(session, id, 'CONFIGURATION_CHANGED')
      throw new FigPluginBridgeError('DENIED')
    }
    const ceiling = Math.min(FIGPLUGIN_ASSET_MAX_BYTES, maxBytes)
    for (const [id, record] of session.assets) {
      if (record.value.sizeBytes > ceiling)
        this.removeSessionAsset(session, id, 'CONFIGURATION_CHANGED')
    }
    return ceiling
  }

  private checkAssetCapacity(session: Session, bytes: number): void {
    // No await separates this check from publication. Concurrent choices cannot overbook memory.
    if (
      session.assets.size + session.preparingAssets + this.sessionRecoveryAssetCount(session) >=
        FIGPLUGIN_ASSET_MAX_PER_SESSION ||
      this.assetCount + this.preparingAssets >= FIGPLUGIN_ASSET_MAX_TOTAL ||
      this.assetBytes + this.preparingAssetBytes + bytes > FIGPLUGIN_ASSET_MAX_TOTAL_BYTES
    )
      throw new FigPluginBridgeError('BUSY')
  }

  private sessionRecoveryAssetCount(session: Session): number {
    return this.allPlanExecutions().reduce(
      (count, execution) =>
        count +
        (execution.call.session === session ? (execution.recoveryAssetBytes?.size ?? 0) : 0),
      0
    )
  }

  private assetCatalog(session: Session): FigPluginAssetList {
    return figPluginAssetListSchema.parse({
      protocol: 1,
      purpose: 'local-preview',
      sessionId: session.id,
      assets: [...session.assets.values()].map((record) => record.value)
    })
  }

  private resolvePlanningAssets(
    session: Session,
    references: FigPluginPlanningAssetReference[]
  ): FigPluginPlanningAssetCatalog {
    this.requireAssetTransfer(session)
    const assets = references.map((reference) => {
      const record = session.assets.get(reference.assetId)
      if (!record) throw new FigPluginBridgeError('EXPIRED')
      if (record.value.sha256 !== reference.sha256)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return planningAssetMetadata(record.value)
    })
    return figPluginPlanningAssetCatalogSchema.parse({
      version: 1,
      kind: 'planning-asset-catalog',
      purpose: 'model-planning-metadata',
      sessionId: session.id,
      pluginId: session.binding.pluginId,
      projectId: session.binding.projectId,
      host: session.binding.host,
      assets
    })
  }

  private requirePlanningAssets(session: Session, catalog?: FigPluginPlanningAssetCatalog): void {
    if (!catalog) return
    const current = this.resolvePlanningAssets(
      session,
      catalog.assets.map(({ assetId, sha256 }) => ({ assetId, sha256 }))
    )
    if (canonicalFigPluginJson(current) !== canonicalFigPluginJson(catalog))
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
  }

  private requireExecutionAssets(execution: PlanExecution): void {
    if (!execution.executionAssets) return
    try {
      const session = execution.call.session
      if (execution.recovery?.images) {
        const ceiling = this.requireAssetTransfer(session)
        this.requireNativeWriteAuthority(execution)
        if (
          !execution.recoveryAssetBytes ||
          execution.recoveryAssetBytes.size !== execution.executionAssets.length
        )
          throw new FigPluginBridgeError('EXPIRED')
        const record = this.visualBaselines.get(execution.recovery.baselineId)
        if (
          !record?.recoveryImages ||
          record.value.expiresAt <= this.clock() ||
          canonicalFigPluginJson(record.recoveryImages) !==
            canonicalFigPluginJson(execution.recovery.images.manifest)
        )
          throw new FigPluginBridgeError('EXPIRED')
        for (const asset of execution.executionAssets) {
          const bytes = execution.recoveryAssetBytes.get(asset.assetId)
          if (
            !bytes ||
            bytes.byteLength !== asset.sizeBytes ||
            asset.sizeBytes > ceiling ||
            asset.expiresAt <= this.clock()
          )
            throw new FigPluginBridgeError('EXPIRED')
        }
        return
      }
      this.requirePlanningAssets(session, execution.call.planningAssets)
      this.requireNativeWriteAuthority(execution)
      const identity = {
        sessionId: session.id,
        pluginId: session.binding.pluginId,
        projectId: session.binding.projectId,
        host: session.binding.host
      }
      for (const approved of execution.executionAssets) {
        const record = session.assets.get(approved.assetId)
        if (!record || record.value.expiresAt <= this.clock())
          throw new FigPluginBridgeError('EXPIRED')
        const current = executionAssetFromSessionAsset(record.value, identity, this.clock())
        if (canonicalFigPluginJson(current) !== canonicalFigPluginJson(approved))
          throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      }
    } catch (error) {
      this.terminateExecution(
        execution,
        error instanceof FigPluginBridgeError && error.code === 'EXPIRED'
          ? 'EXPIRED'
          : error instanceof FigPluginBridgeError && error.code === 'DENIED'
            ? 'DENIED'
            : 'CONFIGURATION_CHANGED'
      )
      throw error instanceof FigPluginBridgeError
        ? error
        : new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
  }

  private releaseRecoveryAssets(execution: PlanExecution): void {
    if (!execution.recoveryAssetBytes) return
    for (const bytes of execution.recoveryAssetBytes.values()) {
      this.assetCount--
      this.assetBytes -= bytes.byteLength
      bytes.fill(0)
    }
    execution.recoveryAssetBytes.clear()
    execution.recoveryAssetBytes = undefined
  }

  private removeSessionAsset(
    session: Session,
    assetId: string,
    code: TerminalCode = 'CANCELLED'
  ): void {
    const record = session.assets.get(assetId)
    if (!record) return
    session.assets.delete(assetId)
    this.assetCount--
    this.assetBytes -= record.bytes.byteLength
    record.bytes.fill(0)
    // Revocation cannot unsend metadata, but prevents any pending handoff, late
    // result or still-unclaimed execution from reusing this selected snapshot.
    for (const call of this.calls.values()) {
      if (
        call.session !== session ||
        !call.planningAssets?.assets.some((asset) => asset.assetId === assetId)
      )
        continue
      if (active(call)) this.terminate(call, code)
      else if (call.execution) this.terminateExecution(call.execution, code)
    }
  }

  async cancel(sessionId: string, sessionToken: string, callId: string): Promise<void> {
    const session = this.authenticate(sessionId, sessionToken)
    this.ownedReceipt(session, callId)
    const call = this.calls.get(callId)
    if (call && active(call)) this.terminate(call, 'CANCELLED')
    else if (call?.execution) this.terminateExecution(call.execution, 'CANCELLED')
    if (call) {
      const children = this.allPlanExecutions().filter((execution) => execution.call === call)
      const ids = new Set(children.map((execution) => execution.executionId))
      for (const execution of children) this.terminateExecution(execution, 'CANCELLED')
      for (const [id, record] of [...this.visualCorrectionAuthorizations])
        if (ids.has(record.value.sourceExecutionId))
          this.removeVisualCorrectionAuthorization(id, 'CANCELLED')
    }
    this.scheduleCleanup()
  }

  closeSession(sessionId: string, sessionToken: string): void {
    const session = this.authenticate(sessionId, sessionToken)
    this.removeSession(session, 'CANCELLED')
    this.scheduleCleanup()
  }

  listPreviews(): FigPluginBridgePreview[] {
    this.enter()
    return [...this.calls.values()]
      .filter((call) => call.status.status === 'awaiting-approval' && call.preview)
      .map((call) => structuredClone(call.preview!))
  }

  listPlanExecutions(): FigPluginExecutionPreview[] {
    this.enter()
    return this.allPlanExecutions().map((execution) => this.executionPreview(execution))
  }

  listPlanStatuses(): FigPluginExecutionStatus[] {
    this.enter()
    return this.allPlanExecutions().map((execution) => this.executionStatus(execution))
  }

  listVisualBaselines(): FigPluginVisualBaseline[] {
    this.enter()
    return [...this.visualBaselines.values()]
      .map((record) => structuredClone(record.value))
      .sort((left, right) => right.acceptedAt - left.acceptedAt)
  }

  listVisualCorrectionAuthorizations(): FigPluginVisualCorrectionAuthorization[] {
    this.enter()
    return [...this.visualCorrectionAuthorizations.values()]
      .map((record) => structuredClone(record.value))
      .sort((left, right) => right.authorizedAt - left.authorizedAt)
  }

  private captureRecoveryImages(execution: PlanExecution): FigPluginRecoveryImages | undefined {
    const steps = execution.plan.steps.filter(
      (step) => step.command === 'image.fill' || step.command === 'image.pixels'
    )
    if (!steps.length) return undefined
    if (
      !this.checkpoints?.openRecoveryImages ||
      !execution.executionAssets ||
      !execution.acceptedImageEvidence
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    this.requireExecutionAssets(execution)
    const assets = execution.executionAssets
      .map(({ assetId, sha256, mimeType, sizeBytes, width, height }) => {
        const bytes = execution.call.session.assets.get(assetId)?.bytes
        if (
          !bytes ||
          bytes.byteLength !== sizeBytes ||
          createHash('sha256').update(bytes).digest('hex') !== sha256
        )
          throw new FigPluginBridgeError('EXPIRED')
        const inspected = inspectSessionAssetImage(bytes)
        if (
          inspected.mimeType !== mimeType ||
          inspected.width !== width ||
          inspected.height !== height
        )
          throw new FigPluginBridgeError('INVALID_REQUEST')
        return { assetId, sha256, mimeType, sizeBytes, width, height }
      })
      .sort((left, right) =>
        left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0
      )
    const targets = steps
      .map((step) => {
        const acceptedEvidence = execution.acceptedImageEvidence!.find(
          (item) => item.targetId === step.targetId && item.command === step.command
        )?.imageEvidence
        if (!acceptedEvidence) throw new FigPluginBridgeError('INVALID_REQUEST')
        return step.command === 'image.fill'
          ? { ...step, acceptedEvidence }
          : { ...step, pixelEncoding: 'rgba8-srgb-zero-alpha-v1' as const, acceptedEvidence }
      })
      .sort((left, right) => {
        const a = `${left.targetId}\u0000${left.command}`,
          b = `${right.targetId}\u0000${right.command}`
        return a < b ? -1 : a > b ? 1 : 0
      })
    const content = { version: 1 as const, sourcePlanSha256: execution.planSha256, assets, targets }
    return figPluginRecoveryImagesSchema.parse({ ...content, manifestSha256: digest(content) })
  }

  async acceptVisualBaseline(
    executionId: string,
    visualEvidenceSha256: string
  ): Promise<FigPluginVisualBaseline> {
    this.enter()
    const execution = this.findExecution(executionId)
    const check = (): { evidence: FigPluginVisualEvidence[]; sha256: string } => {
      const evidence = execution.visualEvidence
      const sha256 = evidence ? digest(evidence) : undefined
      if (
        this.calls.get(execution.call.receipt.response.callId) !== execution.call ||
        this.sessions.get(execution.call.session.id) !== execution.call.session ||
        execution.state !== 'completed' ||
        execution.effect !== 'applied' ||
        execution.preview.visualAudit !== 'hash-only' ||
        execution.visualCorrection !== undefined ||
        execution.recovery !== undefined ||
        !evidence ||
        !sha256 ||
        !secretEquals(visualEvidenceSha256, sha256)
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return { evidence, sha256 }
    }
    check()
    await this.checkSession(execution.call.session)
    const checked = check()
    const previous = [...this.visualBaselines.values()].find(
      (record) => record.value.sourceExecutionId === execution.executionId
    )
    if (previous) {
      if (!secretEquals(visualEvidenceSha256, previous.value.visualEvidenceSha256))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return structuredClone(previous.value)
    }
    const recoveryImages = this.captureRecoveryImages(execution)
    const recoveryScope = captureTaskRecoveryScope(
      execution.plan,
      execution.context,
      execution.executionAssets?.map(executionAssetMetadata)
    )
    const acceptedAt = this.clock()
    const baseline = figPluginVisualBaselineSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      baselineId: randomBytes(16).toString('hex'),
      sourceExecutionId: execution.executionId,
      pluginId: execution.call.session.binding.pluginId,
      host: execution.call.session.binding.host,
      projectId: execution.call.session.binding.projectId,
      documentId: execution.context.documentId,
      scopeId: execution.context.scopeId,
      captureId: execution.context.captureId,
      planSha256: execution.planSha256,
      contextSha256: execution.contextSha256,
      visualEvidenceSha256: checked.sha256,
      adapterVersion: execution.preview.adapterVersion,
      targets: checked.evidence.map((item) => ({
        targetId: item.targetId,
        accepted: item.after
      })),
      ...(this.checkpoints ? { storage: 'encrypted-local' } : {}),
      acceptedAt,
      expiresAt: acceptedAt + FIGPLUGIN_VISUAL_BASELINE_TTL_MS,
      correctionRoundsUsed: 0,
      maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS
    })
    const saved: VisualBaselineRecord = {
      value: baseline,
      binding: Object.freeze({ ...execution.call.session.binding }),
      recoveryPlan: structuredClone(execution.plan),
      recoveryScope,
      ...(recoveryImages ? { recoveryImages } : {})
    }
    // No await between durable commit and in-memory acceptance. Failure is not success.
    if (this.checkpoints) {
      try {
        this.checkpoints.save(
          saved as SavedCheckpoint,
          recoveryImages?.assets.map((asset) => ({
            assetId: asset.assetId,
            bytes: execution.call.session.assets.get(asset.assetId)!.bytes
          }))
        )
      } catch {
        throw new FigPluginBridgeError('UPSTREAM_FAILED')
      }
    }
    const scopeKey = visualBaselineScopeKey(baseline)
    for (const [id, record] of this.visualBaselines) {
      if (visualBaselineScopeKey(record.value) === scopeKey) this.removeVisualBaseline(id)
    }
    while (this.visualBaselines.size >= 16) {
      const oldest = this.visualBaselines.keys().next().value
      if (!oldest) break
      this.removeVisualBaseline(oldest)
    }
    this.visualBaselines.set(baseline.baselineId, saved)
    this.recordExecutionAudit(execution, baseline)
    this.scheduleCleanup()
    return structuredClone(baseline)
  }

  async authorizeVisualCorrection(
    executionId: string,
    baselineId: string,
    visualEvidenceSha256: string
  ): Promise<FigPluginVisualCorrectionAuthorization> {
    this.enter()
    const execution = this.findExecution(executionId)
    const check = (): {
      baseline: FigPluginVisualBaseline
      comparison: FigPluginVisualBaselineComparison
      comparisonSha256: string
    } => {
      const comparison = execution.visualBaselineComparison
      const baselineRecord = isId(baselineId) ? this.visualBaselines.get(baselineId) : undefined
      const baseline = baselineRecord?.value
      const evidenceSha256 = execution.visualEvidence ? digest(execution.visualEvidence) : undefined
      if (
        this.calls.get(execution.call.receipt.response.callId) !== execution.call ||
        this.sessions.get(execution.call.session.id) !== execution.call.session ||
        execution.state !== 'completed' ||
        execution.effect !== 'applied' ||
        execution.preview.visualAudit !== 'hash-only' ||
        execution.executionAssets !== undefined ||
        !comparison ||
        execution.pixelAudit?.outcome === 'match' ||
        comparison.exactMatch ||
        comparison.changedCount < 1 ||
        comparison.baselineId !== baselineId ||
        comparison.visualEvidenceSha256 !== evidenceSha256 ||
        !secretEquals(visualEvidenceSha256, evidenceSha256) ||
        !baseline ||
        baseline.expiresAt <= this.clock() ||
        baseline.visualEvidenceSha256 !== comparison.baselineEvidenceSha256 ||
        baseline.adapterVersion !== execution.preview.adapterVersion ||
        visualBaselineScopeKey(baseline) !==
          visualBaselineScopeKey({
            pluginId: execution.call.session.binding.pluginId,
            host: execution.call.session.binding.host,
            projectId: execution.call.session.binding.projectId,
            documentId: execution.context.documentId,
            scopeId: execution.context.scopeId
          })
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      // A consumed comparison cannot mint another attempt, even after the child ends.
      // A further round must be based on the completed child's new evidence.
      if (
        [...this.visualCorrectionExecutions.values()].some(
          (child) =>
            child.visualCorrection?.sourceExecutionId === execution.executionId &&
            child.claimedAt !== undefined
        )
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return { baseline, comparison, comparisonSha256: digest(comparison) }
    }
    let checked = check()
    await this.checkSession(execution.call.session)
    checked = check()
    if (
      this.allPlanExecutions().some(
        (child) =>
          child.recovery?.baselineId === checked.baseline.baselineId &&
          !terminalExecution.has(child.state)
      )
    )
      throw new FigPluginBridgeError('BUSY')
    const existing = [...this.visualCorrectionAuthorizations.values()].find(
      (record) => record.value.baselineId === checked.baseline.baselineId
    )
    if (existing) {
      if (
        existing.value.sourceExecutionId === execution.executionId &&
        existing.value.visualEvidenceSha256 === visualEvidenceSha256 &&
        existing.value.comparisonSha256 === checked.comparisonSha256
      )
        return structuredClone(existing.value)
      throw new FigPluginBridgeError('BUSY')
    }
    if (
      [...this.visualCorrectionExecutions.values()].some(
        (child) =>
          child.visualCorrection?.baselineId === checked.baseline.baselineId &&
          !terminalExecution.has(child.state)
      )
    )
      throw new FigPluginBridgeError('BUSY')
    const round = checked.baseline.correctionRoundsUsed + 1
    if (round > checked.baseline.maxCorrectionRounds) throw new FigPluginBridgeError('DENIED')
    const authorizedAt = this.clock()
    const expiresAt = Math.min(
      authorizedAt + FIGPLUGIN_VISUAL_CORRECTION_AUTHORIZATION_TTL_MS,
      checked.baseline.expiresAt,
      execution.preview.expiresAt,
      execution.call.session.expiresAt
    )
    if (expiresAt <= authorizedAt) throw new FigPluginBridgeError('EXPIRED')
    const authorization = figPluginVisualCorrectionAuthorizationSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      authorizationId: randomBytes(16).toString('hex'),
      baselineId: checked.baseline.baselineId,
      sourceExecutionId: execution.executionId,
      pluginId: execution.call.session.binding.pluginId,
      host: execution.call.session.binding.host,
      projectId: execution.call.session.binding.projectId,
      documentId: execution.context.documentId,
      scopeId: execution.context.scopeId,
      captureId: execution.context.captureId,
      adapterVersion: execution.preview.adapterVersion,
      baselineEvidenceSha256: checked.comparison.baselineEvidenceSha256,
      visualEvidenceSha256,
      comparisonSha256: checked.comparisonSha256,
      visualTargetIds: checked.baseline.targets.map((target) => target.targetId).sort(),
      authorizedTargetIds: checked.comparison.targets
        .filter((target) => target.changed)
        .map((target) => target.targetId)
        .sort(),
      round,
      maxCorrectionRounds: checked.baseline.maxCorrectionRounds,
      authorizedAt,
      expiresAt,
      state: 'authorized'
    })
    while (this.visualCorrectionAuthorizations.size >= 16) {
      const oldest = this.visualCorrectionAuthorizations.keys().next().value
      if (!oldest) break
      // Eviction is still a revocation boundary. A prepared child may hold the
      // only in-memory reference to this authorization; deleting the map entry
      // directly would leave that child awaiting approval forever and omit its
      // terminal audit event.
      this.removeVisualCorrectionAuthorization(oldest, 'CANCELLED')
    }
    this.visualCorrectionAuthorizations.set(authorization.authorizationId, {
      value: authorization,
      binding: Object.freeze({ ...execution.call.session.binding })
    })
    this.recordExecutionAudit(execution, undefined, authorization)
    this.scheduleCleanup()
    return structuredClone(authorization)
  }

  private recoveryAuthority(execution: PlanExecution): VisualBaselineRecord | undefined {
    if (!execution.recovery) return undefined
    const record = this.visualBaselines.get(execution.recovery.baselineId)
    if (
      !record ||
      record.value.expiresAt <= this.clock() ||
      record.value.sourceExecutionId !== execution.recovery.sourceExecutionId ||
      record.value.correctionRoundsUsed + 1 !== execution.recovery.round ||
      (record.recoveryImages !== undefined) !== (execution.recovery.images !== undefined) ||
      (record.recoveryImages !== undefined &&
        canonicalFigPluginJson(record.recoveryImages) !==
          canonicalFigPluginJson(execution.recovery.images!.manifest)) ||
      (execution.recovery.rebind
        ? record.recoveryScope.recoveryIdentity !== execution.recovery.rebind.previousIdentity ||
          execution.context.recoveryIdentity !== execution.recovery.rebind.nextIdentity
        : record.recoveryScope.recoveryIdentity !== execution.context.recoveryIdentity) ||
      canonicalFigPluginJson(record.binding) !==
        canonicalFigPluginJson(execution.call.session.binding)
    )
      throw new FigPluginBridgeError('EXPIRED')
    if (execution.recovery.rebind) {
      try {
        const expected = createTaskRecoveryRebind(
          record.recoveryScope,
          execution.context,
          execution.recovery.rebind.document !== undefined
        )
        if (canonicalFigPluginJson(expected) !== canonicalFigPluginJson(execution.recovery.rebind))
          throw new Error('STALE_RECOVERY_SCOPE')
      } catch {
        throw new FigPluginBridgeError('EXPIRED')
      }
    }
    if (execution.recovery.images) {
      try {
        validateRecoveryImagePlanBinding(execution.plan, execution.recovery.images)
      } catch {
        throw new FigPluginBridgeError('EXPIRED')
      }
    }
    return record
  }

  private createRecoveryImageBinding(
    record: VisualBaselineRecord
  ): FigPluginRecoveryExecutionImages | undefined {
    if (!record.recoveryImages) return undefined
    const manifest = figPluginRecoveryImagesSchema.parse(record.recoveryImages)
    if (
      manifest.sourcePlanSha256 !== record.value.planSha256 ||
      manifest.sourcePlanSha256 !== digest(record.recoveryPlan) ||
      createHash('sha256').update(recoveryImagesManifestContent(manifest)).digest('hex') !==
        manifest.manifestSha256
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    return {
      manifest,
      assetBindings: manifest.assets.map((asset) => ({
        sourceAssetId: asset.assetId,
        assetId: randomBytes(16).toString('hex')
      }))
    }
  }

  private openRecoveryExecutionAssets(
    session: Session,
    record: VisualBaselineRecord,
    images: FigPluginRecoveryExecutionImages,
    expiresAt: number
  ): { assets: FigPluginExecutionAsset[]; bytes: Map<string, Buffer> } {
    if (!this.checkpoints?.openRecoveryImages) throw new FigPluginBridgeError('UPSTREAM_FAILED')
    const ceiling = this.requireAssetTransfer(session)
    const sizeBytes = images.manifest.assets.reduce((total, asset) => total + asset.sizeBytes, 0)
    const sessionRecoveryCount = this.sessionRecoveryAssetCount(session)
    if (images.manifest.assets.some((asset) => asset.sizeBytes > ceiling))
      throw new FigPluginBridgeError('DENIED')
    if (
      session.assets.size +
        session.preparingAssets +
        sessionRecoveryCount +
        images.manifest.assets.length >
        FIGPLUGIN_ASSET_MAX_PER_SESSION ||
      this.assetCount + this.preparingAssets + images.manifest.assets.length >
        FIGPLUGIN_ASSET_MAX_TOTAL ||
      this.assetBytes + this.preparingAssetBytes + sizeBytes > FIGPLUGIN_ASSET_MAX_TOTAL_BYTES
    )
      throw new FigPluginBridgeError('BUSY')
    const createdAt = this.clock()
    const assets = images.manifest.assets.map((source) =>
      figPluginExecutionAssetSchema.parse({
        ...source,
        version: 1,
        kind: 'execution-image-asset',
        purpose: 'host-plan-execution',
        assetId: images.assetBindings.find((binding) => binding.sourceAssetId === source.assetId)!
          .assetId,
        sessionId: session.id,
        pluginId: session.binding.pluginId,
        projectId: session.binding.projectId,
        host: session.binding.host,
        chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
        chunkCount: Math.ceil(source.sizeBytes / FIGPLUGIN_ASSET_CHUNK_BYTES),
        createdAt,
        expiresAt: Math.min(expiresAt, createdAt + FIGPLUGIN_ASSET_TTL_MS)
      })
    )
    let owned: Array<{ assetId: string; bytes: Buffer }>
    try {
      owned = this.checkpoints.openRecoveryImages(
        session.binding,
        record.value.baselineId,
        images.manifest.manifestSha256
      )
    } catch {
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
    let transferred = false
    try {
      if (
        owned.length !== assets.length ||
        new Set(owned.map((item) => item.assetId)).size !== owned.length
      )
        throw new FigPluginBridgeError('UPSTREAM_FAILED')
      const bytes = new Map<string, Buffer>()
      for (const source of images.manifest.assets) {
        const buffer = owned.find((item) => item.assetId === source.assetId)?.bytes
        if (
          !Buffer.isBuffer(buffer) ||
          buffer.byteLength !== source.sizeBytes ||
          createHash('sha256').update(buffer).digest('hex') !== source.sha256
        )
          throw new FigPluginBridgeError('UPSTREAM_FAILED')
        const inspected = inspectSessionAssetImage(buffer)
        if (
          inspected.mimeType !== source.mimeType ||
          inspected.width !== source.width ||
          inspected.height !== source.height
        )
          throw new FigPluginBridgeError('UPSTREAM_FAILED')
        bytes.set(
          images.assetBindings.find((binding) => binding.sourceAssetId === source.assetId)!.assetId,
          buffer
        )
      }
      transferred = true
      return { assets, bytes }
    } finally {
      if (!transferred) for (const item of owned) item.bytes.fill(0)
    }
  }

  async prepareTaskRecovery(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginTaskRecoveryPrepareResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    if (this.preparing >= 16 || session.preparing >= 2) throw new FigPluginBridgeError('BUSY')
    this.preparing++
    session.preparing++
    try {
      const request = parseFigPluginBridgeValue(figPluginTaskRecoveryPrepareRequestSchema, input)
      const fingerprint = digest({ purpose: 'task-recovery', binding: session.binding, request })
      await this.checkSession(session)
      this.requireCurrentSession(session)
      if (session.imageGenerationRequests.has(request.requestId))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      const previous = session.requests.get(request.requestId)
      if (previous) {
        if (
          previous.sequence !== request.sequence ||
          previous.digest !== fingerprint ||
          !previous.recoveryResponse
        )
          throw new FigPluginBridgeError('INVALID_REQUEST')
        return structuredClone(previous.recoveryResponse)
      }
      if (request.sequence <= session.highWater || !this.allowNativeWrite(session.binding))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      const context = request.hostContext
      if (request.rebindBaselineId && !this.checkpoints) throw new FigPluginBridgeError('EXPIRED')
      if (this.checkpoints) {
        let persisted: SavedCheckpoint | undefined
        try {
          persisted = request.rebindBaselineId
            ? this.checkpoints.findForRebind(
                session.binding,
                context,
                request.rebindBaselineId,
                request.reopenDocument
              )
            : this.checkpoints.find(session.binding, context)
        } catch {
          throw new FigPluginBridgeError('UPSTREAM_FAILED')
        }
        if (persisted) {
          // A previous process may have consumed this correction round and died before the
          // host receipt arrived. The checkpoint store keeps a short crash fence so a fresh
          // runtime cannot mint a second executable intent during that ambiguity window.
          if (persisted.activeRecovery && persisted.activeRecovery.expiresAt > this.clock())
            throw new FigPluginBridgeError('BUSY')
          // Validate current selection, host identity, locks and capabilities before rehydration.
          try {
            const reassociation = request.rebindBaselineId
              ? createTaskRecoveryRebind(
                  persisted.recoveryScope,
                  context,
                  request.reopenDocument === true
                )
              : undefined
            prepareTaskRecoveryPlan(
              persisted.recoveryPlan,
              reassociation
                ? applyTaskRecoveryRebind(persisted.recoveryScope, reassociation)
                : persisted.recoveryScope,
              context,
              this.createRecoveryImageBinding(persisted)
            )
          } catch {
            throw new FigPluginBridgeError('INVALID_REQUEST')
          }
          const previous = this.visualBaselines.get(persisted.value.baselineId)
          if (
            previous &&
            previous.value.correctionRoundsUsed > persisted.value.correctionRoundsUsed
          )
            throw new FigPluginBridgeError('UPSTREAM_FAILED')
          if (!previous && this.visualBaselines.size >= 16) throw new FigPluginBridgeError('BUSY')
          this.visualBaselines.set(persisted.value.baselineId, persisted)
        } else {
          // An explicit ID must resolve exactly; never fall back to a different checkpoint.
          if (request.rebindBaselineId) throw new FigPluginBridgeError('EXPIRED')
          // Deletion/revocation on disk cannot fall back to a stale in-memory checkpoint.
          for (const [id, item] of this.visualBaselines)
            if (
              item.value.storage === 'encrypted-local' &&
              item.value.pluginId === session.binding.pluginId &&
              item.value.projectId === session.binding.projectId &&
              item.value.documentId === context.documentId &&
              item.value.scopeId === context.scopeId
            )
              this.removeVisualBaseline(id)
        }
      }
      const record = request.rebindBaselineId
        ? this.visualBaselines.get(request.rebindBaselineId)
        : [...this.visualBaselines.values()].find(
            (record) =>
              record.value.host === context.host &&
              record.value.documentId === context.documentId &&
              record.value.scopeId === context.scopeId &&
              record.value.projectId === session.binding.projectId &&
              record.value.pluginId === session.binding.pluginId &&
              canonicalFigPluginJson(record.binding) === canonicalFigPluginJson(session.binding)
          )
      if (!record || record.value.expiresAt <= this.clock())
        throw new FigPluginBridgeError('EXPIRED')
      if (
        this.sessionReceiptCount(session) >= 64 ||
        this.receiptCount() >= 256 ||
        this.hasActiveNativeGeneration(session) ||
        this.calls.size >= 32 ||
        [...this.calls.values()].some((call) => call.session === session && active(call)) ||
        this.allPlanExecutions().some(
          (execution) =>
            !terminalExecution.has(execution.state) &&
            (execution.recovery?.baselineId === record.value.baselineId ||
              execution.visualCorrection?.baselineId === record.value.baselineId)
        ) ||
        [...this.visualCorrectionAuthorizations.values()].some(
          (auth) => auth.value.baselineId === record.value.baselineId
        )
      )
        throw new FigPluginBridgeError('BUSY')
      const rebind = request.rebindBaselineId
        ? createTaskRecoveryRebind(record.recoveryScope, context, request.reopenDocument === true)
        : undefined
      if (request.rebindBaselineId && record.value.baselineId !== request.rebindBaselineId)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      let prepared: ReturnType<typeof prepareTaskRecoveryPlan>
      const images = this.createRecoveryImageBinding(record)
      try {
        prepared = prepareTaskRecoveryPlan(
          record.recoveryPlan,
          rebind ? applyTaskRecoveryRebind(record.recoveryScope, rebind) : record.recoveryScope,
          context,
          images
        )
      } catch {
        throw new FigPluginBridgeError('INVALID_REQUEST')
      }
      const callId = randomBytes(16).toString('hex')
      const expiresAt = Math.min(
        this.clock() + (images ? Math.min(CALL_TTL, FIGPLUGIN_ASSET_TTL_MS) : CALL_TTL),
        session.expiresAt,
        record.value.expiresAt
      )
      const receipt: Receipt = {
        sequence: request.sequence,
        requestId: request.requestId,
        correlationId: randomBytes(16).toString('hex'),
        digest: fingerprint,
        response: {
          protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
          callId,
          status: 'awaiting-approval',
          expiresAt
        }
      }
      let response: FigPluginTaskRecoveryPrepareResponse
      if (prepared.unchanged) {
        response = { protocol: 1, status: 'unchanged', baselineId: record.value.baselineId }
      } else {
        const round = record.value.correctionRoundsUsed + 1
        if (round > record.value.maxCorrectionRounds) throw new FigPluginBridgeError('DENIED')
        const recovery: FigPluginTaskRecovery = {
          baselineId: record.value.baselineId,
          sourceExecutionId: record.value.sourceExecutionId,
          requestId: request.requestId,
          round,
          maxCorrectionRounds: 3,
          targetIds: [...record.recoveryScope.targetIds],
          ...(images ? { images } : {}),
          ...(rebind ? { rebind } : {})
        }
        const call: Call = {
          session,
          receipt,
          hostContext: structuredClone(context),
          status: { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'completed', content: '' }
        }
        const recoveredAssets = images
          ? this.openRecoveryExecutionAssets(session, record, images, expiresAt)
          : undefined
        let execution: PlanExecution | undefined
        try {
          execution = this.registerPlanExecution(
            call,
            JSON.stringify({ plan: prepared.plan }),
            context,
            recovery,
            recoveredAssets
          )
        } finally {
          if (!execution && recoveredAssets)
            for (const bytes of recoveredAssets.bytes.values()) bytes.fill(0)
        }
        if (!execution) throw new FigPluginBridgeError('INVALID_REQUEST')
        response = {
          protocol: 1,
          status: 'prepared',
          callId,
          executionId: execution.executionId,
          expiresAt,
          recovery
        }
        this.calls.set(callId, call)
      }
      receipt.recoveryResponse = figPluginTaskRecoveryPrepareResponseSchema.parse(response)
      session.requests.set(request.requestId, receipt)
      session.highWater = request.sequence
      this.scheduleCleanup()
      return structuredClone(response)
    } finally {
      this.preparing--
      session.preparing--
    }
  }

  async prepareVisualCorrection(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginVisualCorrectionPrepareResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginVisualCorrectionPrepareRequestSchema, input)
    const source = this.ownedExecution(session, request.sourceExecutionId)
    await this.checkSession(session)
    this.requireCurrentSession(session)
    if (
      source.state !== 'completed' ||
      source.effect !== 'applied' ||
      source.preview.visualAudit !== 'hash-only' ||
      source.executionAssets !== undefined ||
      !source.visualBaselineComparison ||
      source.visualBaselineComparison.exactMatch ||
      source.visualBaselineComparison.changedCount < 1
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')

    const authorizationRecord = [...this.visualCorrectionAuthorizations.values()].find(
      (record) => record.value.sourceExecutionId === source.executionId
    )
    const prepared = [...this.visualCorrectionExecutions.values()].find(
      (execution) =>
        execution.visualCorrection?.sourceExecutionId === source.executionId &&
        (authorizationRecord
          ? execution.visualCorrection.authorizationId === authorizationRecord.value.authorizationId
          : execution.claimedAt !== undefined)
    )
    if (prepared) {
      if (request.hostContext && digest(request.hostContext) !== prepared.contextSha256)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      this.expireExecution(prepared)
      return figPluginVisualCorrectionPrepareResponseSchema.parse(
        terminalExecution.has(prepared.state)
          ? {
              protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
              status: 'terminal',
              state: prepared.state,
              ...(prepared.errorCode ? { errorCode: prepared.errorCode } : {})
            }
          : {
              protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
              status: 'prepared',
              executionId: prepared.executionId,
              callId: prepared.call.receipt.response.callId,
              state: prepared.state,
              expiresAt: prepared.preview.expiresAt
            }
      )
    }

    if (!authorizationRecord) {
      const baseline = this.visualBaselines.get(source.visualBaselineComparison.baselineId)?.value
      if (!baseline || baseline.expiresAt <= this.clock())
        return figPluginVisualCorrectionPrepareResponseSchema.parse({
          protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
          status: 'terminal',
          state: 'expired',
          errorCode: 'EXPIRED'
        })
      if (baseline.correctionRoundsUsed >= baseline.maxCorrectionRounds)
        return figPluginVisualCorrectionPrepareResponseSchema.parse({
          protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
          status: 'terminal',
          state: 'denied',
          errorCode: 'DENIED'
        })
      return figPluginVisualCorrectionPrepareResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: source.preview.expiresAt > this.clock() ? 'pending' : 'terminal',
        ...(source.preview.expiresAt > this.clock()
          ? { expiresAt: source.preview.expiresAt }
          : { state: 'expired', errorCode: 'EXPIRED' })
      })
    }
    const authorization = authorizationRecord.value
    const baselineRecord = this.visualBaselines.get(authorization.baselineId)
    if (
      authorization.expiresAt <= this.clock() ||
      authorization.sourceExecutionId !== source.executionId ||
      authorization.visualEvidenceSha256 !== source.visualBaselineComparison.visualEvidenceSha256 ||
      authorization.comparisonSha256 !== digest(source.visualBaselineComparison) ||
      authorization.baselineEvidenceSha256 !==
        source.visualBaselineComparison.baselineEvidenceSha256 ||
      !baselineRecord ||
      baselineRecord.value.expiresAt <= this.clock() ||
      baselineRecord.value.visualEvidenceSha256 !== authorization.baselineEvidenceSha256 ||
      canonicalFigPluginJson(authorization.visualTargetIds) !==
        canonicalFigPluginJson(
          baselineRecord.value.targets.map((target) => target.targetId).sort()
        ) ||
      baselineRecord.value.correctionRoundsUsed + 1 !== authorization.round ||
      canonicalFigPluginJson(authorizationRecord.binding) !==
        canonicalFigPluginJson(session.binding)
    ) {
      this.removeVisualCorrectionAuthorization(authorization.authorizationId, 'EXPIRED')
      return figPluginVisualCorrectionPrepareResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'terminal',
        state: 'expired',
        errorCode: 'EXPIRED'
      })
    }
    if (!request.hostContext)
      return figPluginVisualCorrectionPrepareResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'authorized',
        authorization: structuredClone(authorization)
      })

    const context = request.hostContext
    const baselineTargetIds = baselineRecord.value.targets.map((target) => target.targetId).sort()
    const selectedIds = [...(context.selectedIds ?? [])].sort()
    if (
      context.host !== session.binding.host ||
      context.documentId !== authorization.documentId ||
      context.scopeId !== authorization.scopeId ||
      context.captureId !== authorization.authorizationId ||
      context.recoveryIdentity !== baselineRecord.recoveryScope.recoveryIdentity ||
      context.execution?.mode !== 'native-write' ||
      context.execution.adapterVersion !== authorization.adapterVersion ||
      context.execution.visualAudit !== 'hash-only' ||
      !this.allowNativeWrite(session.binding) ||
      canonicalFigPluginJson(selectedIds) !== canonicalFigPluginJson(baselineTargetIds)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')

    const authorizedTargets = new Set(authorization.authorizedTargetIds)
    const correctionPlan: HostPlan = {
      ...structuredClone(baselineRecord.recoveryPlan),
      captureId: context.captureId,
      steps: baselineRecord.recoveryPlan.steps
        .filter((step) => authorizedTargets.has(step.targetId))
        .map((step) => structuredClone(step))
    }
    const planTargets = [...new Set(correctionPlan.steps.map((step) => step.targetId))].sort()
    if (
      correctionPlan.steps.length < 1 ||
      canonicalFigPluginJson(planTargets) !==
        canonicalFigPluginJson(authorization.authorizedTargetIds)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')

    let checked: HostPlanningPreview
    try {
      checked = createHostPlanningPreview(JSON.stringify(correctionPlan), context)
    } catch {
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    if (
      checked.executable !== true ||
      !checked.execution ||
      checked.execution.visualAudit !== 'hash-only' ||
      checked.execution.adapterVersion !== authorization.adapterVersion
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    if (this.visualCorrectionExecutions.size >= 16) throw new FigPluginBridgeError('BUSY')

    const createdAt = this.clock()
    const expiresAt = Math.min(authorization.expiresAt, source.preview.expiresAt, session.expiresAt)
    if (expiresAt <= createdAt) {
      this.removeVisualCorrectionAuthorization(authorization.authorizationId, 'EXPIRED')
      throw new FigPluginBridgeError('EXPIRED')
    }
    const visualCorrection = this.correctionAttempt(authorization)
    const executionId = randomBytes(16).toString('hex')
    const planSha256 = digest(checked.plan)
    const contextSha256 = digest(context)
    const preview = figPluginExecutionPreviewSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId,
      callId: source.call.receipt.response.callId,
      pluginId: session.binding.pluginId,
      host: session.binding.host,
      projectId: session.binding.projectId,
      documentId: context.documentId,
      scopeId: context.scopeId,
      captureId: context.captureId,
      plan: checked.plan,
      planSha256,
      contextSha256,
      adapterVersion: checked.execution.adapterVersion,
      rollback: checked.execution.rollback,
      visualAudit: checked.execution.visualAudit,
      risk: checked.risk,
      differences: checked.differences,
      visualCorrection,
      state: 'awaiting-approval',
      requiresWriteApproval: true,
      createdAt,
      expiresAt
    })
    const previewSha256 = digest({
      plan: checked.plan,
      differences: checked.differences,
      risk: checked.risk,
      planSha256,
      contextSha256,
      adapterVersion: checked.execution.adapterVersion,
      rollback: checked.execution.rollback,
      visualAudit: checked.execution.visualAudit,
      visualCorrection
    })
    const execution: PlanExecution = {
      executionId,
      runId: visualCorrection.sourceExecutionId,
      auditSequence: 0,
      actionId: executionId,
      call: source.call,
      plan: checked.plan,
      context: structuredClone(context),
      preview,
      planSha256,
      contextSha256,
      previewSha256,
      state: 'awaiting-approval',
      completed: 0,
      effect: 'none',
      cursor: 0,
      progress: [],
      progressFingerprints: new Map(),
      visualTargetIds: baselineTargetIds,
      visualCorrection,
      updatedAt: createdAt
    }
    authorizationRecord.preparedExecutionId = executionId
    this.visualCorrectionExecutions.set(executionId, execution)
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
    return figPluginVisualCorrectionPrepareResponseSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      status: 'prepared',
      executionId,
      callId: source.call.receipt.response.callId,
      state: execution.state,
      expiresAt
    })
  }

  cancelVisualCorrectionAuthorization(authorizationId: string): void {
    this.enter()
    if (!isId(authorizationId)) throw new FigPluginBridgeError('INVALID_REQUEST')
    this.removeVisualCorrectionAuthorization(authorizationId, 'CANCELLED')
    this.scheduleCleanup()
  }

  async approve(callId: string, payloadSha256: string): Promise<void> {
    this.enter()
    const call = this.mainCall(callId)
    this.checkApproval(call, payloadSha256)
    await this.checkSession(call.session)
    this.requireCurrentSession(call.session)
    this.checkApproval(call, payloadSha256)
    this.requirePlanningAssets(call.session, call.planningAssets)
    if (this.executing >= 8) throw new FigPluginBridgeError('BUSY')
    const preview = structuredClone(call.preview!)
    const controller = new AbortController()
    call.controller = controller
    call.deadline = this.clock() + this.callTimeout
    call.status = { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'running' }
    this.executing += 1
    this.recordPlanningAudit(call, 'running')
    this.scheduleCleanup()
    // No await between the last lifetime/state check, single-use transition and invoke.
    void this.execute(call, preview, controller)
  }

  async approvePlan(
    executionId: string,
    planSha256: string,
    acknowledgeRecoveryRebind = false
  ): Promise<void> {
    this.enter()
    const execution = this.findExecution(executionId)
    if (execution.recovery?.rebind && !acknowledgeRecoveryRebind)
      throw new FigPluginBridgeError('DENIED')
    const check = (): void => {
      if (
        this.calls.get(execution.call.receipt.response.callId) !== execution.call ||
        this.sessions.get(execution.call.session.id) !== execution.call.session ||
        execution.state !== 'awaiting-approval' ||
        execution.call.status.status !== 'completed' ||
        execution.preview.expiresAt <= this.clock() ||
        !secretEquals(planSha256, execution.planSha256)
      )
        throw new FigPluginBridgeError(
          execution.preview.expiresAt <= this.clock() ? 'EXPIRED' : 'INVALID_REQUEST'
        )
      if (execution.visualCorrection) this.correctionAuthority(execution)
      if (execution.recovery) this.recoveryAuthority(execution)
      this.requireExecutionAssets(execution)
    }
    check()
    await this.checkSession(execution.call.session)
    check()
    execution.state = 'approved'
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
  }

  denyPlan(executionId: string): void {
    this.enter()
    const execution = this.findExecution(executionId)
    if (terminalExecution.has(execution.state)) return
    execution.state = 'denied'
    execution.errorCode = 'DENIED'
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
    if (execution.visualCorrection)
      this.removeVisualCorrectionAuthorization(
        execution.visualCorrection.authorizationId,
        'CANCELLED'
      )
    this.scheduleCleanup()
  }

  cancelPlan(executionId: string): void {
    this.enter()
    const execution = this.findExecution(executionId)
    if (terminalExecution.has(execution.state)) return
    execution.state = 'cancelled'
    execution.errorCode = 'CANCELLED'
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
    if (execution.visualCorrection)
      this.removeVisualCorrectionAuthorization(
        execution.visualCorrection.authorizationId,
        'CANCELLED'
      )
    this.scheduleCleanup()
  }

  async planStatus(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginExecutionStatus> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionStatusRequestSchema, input)
    this.ownedReceipt(session, request.callId)
    await this.checkSession(session)
    const call = this.calls.get(request.callId)
    if (!call) throw new FigPluginBridgeError('INVALID_REQUEST')
    const execution = this.executionForCall(call, request.executionId)
    if (!this.matchesExecutionLineage(execution, request))
      throw new FigPluginBridgeError('INVALID_REQUEST')
    this.expireExecution(execution)
    this.checkDocumentWrite(execution)
    if (!terminalExecution.has(execution.state)) {
      try {
        this.requireNativeWriteAuthority(execution)
        this.requireExecutionAssets(execution)
      } catch {
        // Return the terminal revocation status to a host polling before its next write.
      }
    }
    return this.executionStatus(execution)
  }

  async claimPlan(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginExecutionClaimResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionClaimRequestSchema, input)
    this.ownedReceipt(session, request.callId)
    await this.checkSession(session)
    const call = this.calls.get(request.callId)
    if (!call) throw new FigPluginBridgeError('INVALID_REQUEST')
    const execution = this.executionForCall(call, request.executionId)
    this.expireExecution(execution)
    this.checkDocumentWrite(execution)
    // A pending claim is still an authority boundary. Revocation must terminalize
    // the image preview even before its separate native-write approval is granted.
    if (!terminalExecution.has(execution.state)) {
      try {
        this.requireNativeWriteAuthority(execution)
        this.requireExecutionAssets(execution)
      } catch (error) {
        // A synchronous policy revocation is observable as a terminal claim
        // response rather than an apparent transport failure. Do not issue an
        // intent or release a reservation that may already fence a host write.
        if (error instanceof FigPluginBridgeError && error.code === 'DENIED')
          return figPluginExecutionClaimResponseSchema.parse({
            protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
            status: 'terminal',
            state: execution.state,
            errorCode: execution.errorCode
          })
        throw error
      }
    }
    if (
      execution.state === 'claimed' ||
      execution.state === 'executing' ||
      execution.state === 'readback'
    ) {
      if (!execution.intent) throw new FigPluginBridgeError('UPSTREAM_FAILED')
      return figPluginExecutionClaimResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'ready',
        intent: execution.intent
      })
    }
    if (execution.state !== 'approved')
      return figPluginExecutionClaimResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: terminalExecution.has(execution.state) ? 'terminal' : 'pending',
        state: execution.state,
        ...(execution.errorCode ? { errorCode: execution.errorCode } : {})
      })

    let recoveryAuthority: VisualBaselineRecord | undefined
    let correctionAuthority:
      | {
          authorizationRecord: VisualCorrectionAuthorizationRecord
          baselineRecord: VisualBaselineRecord
        }
      | undefined
    try {
      correctionAuthority = this.correctionAuthority(execution)
      recoveryAuthority = this.recoveryAuthority(execution)
    } catch (error) {
      if (
        (!execution.visualCorrection && !execution.recovery) ||
        !(error instanceof FigPluginBridgeError)
      )
        throw error
      execution.state = 'expired'
      execution.errorCode = 'EXPIRED'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      return figPluginExecutionClaimResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'terminal',
        state: execution.state,
        errorCode: execution.errorCode
      })
    }

    const intent = figPluginExecutionIntentSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      purpose: 'execute-host-plan',
      executionId: execution.executionId,
      callId: call.receipt.response.callId,
      pluginId: session.binding.pluginId,
      host: session.binding.host,
      documentId: execution.context.documentId,
      scopeId: execution.context.scopeId,
      captureId: execution.context.captureId,
      requestId: execution.call.receipt.requestId,
      runId: execution.runId,
      correlationId: execution.call.receipt.correlationId,
      plan: execution.plan,
      planSha256: execution.planSha256,
      expiresAt: execution.preview.expiresAt,
      adapterVersion: execution.preview.adapterVersion,
      actionId: execution.actionId,
      ...(execution.executionAssets
        ? { executionAssets: structuredClone(execution.executionAssets) }
        : {}),
      ...(execution.recovery ? { recovery: structuredClone(execution.recovery) } : {}),
      ...(execution.visualTargetIds ? { visualTargetIds: [...execution.visualTargetIds] } : {}),
      ...(execution.visualCorrection
        ? { visualCorrection: structuredClone(execution.visualCorrection) }
        : {})
    })

    // Deliberately omit plugin/project/session/scope/instance from the exclusion key:
    // those can differ while the same native document is being changed. A collision
    // conservatively serializes (Figma root IDs are not globally unique file IDs).
    const reservation: NativeWriteReservation = {
      resourceKey: digest(['native-document-write-v1', intent.host, intent.documentId]),
      actionId: intent.actionId,
      fingerprint: digest(intent),
      expiresAt: intent.expiresAt
    }
    let acquired: boolean
    try {
      acquired = this.writes.reserve(reservation)
    } catch {
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
    if (!acquired)
      return figPluginExecutionClaimResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'pending',
        state: 'approved'
      })
    execution.writeReservation = reservation

    const durableRecord = recoveryAuthority ?? correctionAuthority?.baselineRecord
    const durableRound = execution.recovery?.round ?? execution.visualCorrection?.round
    if (durableRecord?.value.storage === 'encrypted-local') {
      // Consume before returning an executable intent. A crash can waste a round, never refund it.
      try {
        if (!this.checkpoints || durableRound === undefined) throw new Error('NO_STORE')
        const claimedAt = this.clock()
        const lease: RecoveryClaimLease = {
          executionId: execution.executionId,
          round: durableRound,
          claimedAt,
          // Keep the crash fence no longer than this intent could have been accepted.
          expiresAt: Math.min(execution.preview.expiresAt, claimedAt + CALL_TTL)
        }
        this.checkpoints.consume(
          durableRecord as SavedCheckpoint,
          durableRound,
          execution.recovery?.rebind,
          lease
        )
      } catch {
        // No executable intent escaped. Release only this exact reservation, never
        // another action's reservation. Failed persistence never consumes authority.
        this.releaseDocumentWrite(execution)
        throw new FigPluginBridgeError('UPSTREAM_FAILED')
      }
    }
    if (correctionAuthority && execution.visualCorrection) {
      correctionAuthority.baselineRecord.value = figPluginVisualBaselineSchema.parse({
        ...correctionAuthority.baselineRecord.value,
        correctionRoundsUsed: execution.visualCorrection.round
      })
      this.visualCorrectionAuthorizations.delete(
        correctionAuthority.authorizationRecord.value.authorizationId
      )
    }
    if (recoveryAuthority && execution.recovery) {
      recoveryAuthority.value = figPluginVisualBaselineSchema.parse({
        ...recoveryAuthority.value,
        correctionRoundsUsed: execution.recovery.round
      })
      if (execution.recovery.rebind) {
        recoveryAuthority.recoveryScope = applyTaskRecoveryRebind(
          recoveryAuthority.recoveryScope,
          execution.recovery.rebind
        )
        recoveryAuthority.value = figPluginVisualBaselineSchema.parse({
          ...recoveryAuthority.value,
          documentId: recoveryAuthority.recoveryScope.documentId,
          scopeId: recoveryAuthority.recoveryScope.scopeId
        })
      }
    }
    execution.intent = Object.freeze(intent)
    execution.state = 'claimed'
    execution.claimedAt = this.clock()
    execution.updatedAt = this.clock()
    this.appendPlanProgress(execution, {
      sequence: execution.cursor + 1,
      phase: 'claimed',
      completed: 0,
      effect: 'none',
      at: execution.updatedAt
    })
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
    return figPluginExecutionClaimResponseSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      status: 'ready',
      intent
    })
  }

  planProgress(sessionId: string, sessionToken: string, input: unknown): FigPluginExecutionStatus {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionProgressRequestSchema, input)
    const execution = this.ownedExecution(session, request.executionId)
    this.expireExecution(execution)
    this.checkDocumentWrite(execution)
    if (
      !execution.intent ||
      execution.intent.actionId !== request.actionId ||
      !this.matchesExecutionLineage(execution, request) ||
      !['claimed', 'executing', 'readback'].includes(execution.state)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    this.requireNativeWriteAuthority(execution)
    this.requireExecutionAssets(execution)
    const requestFingerprint = digest(request)
    if (request.sequence <= execution.cursor) {
      if (execution.progressFingerprints.get(request.sequence) === requestFingerprint)
        return this.executionStatus(execution)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    // Progress is an append-only journal. Do not let a host skip sequence numbers: accepting
    // a later event would make a lost or reordered phase indistinguishable from a valid state
    // transition and would leave the desktop history with an unverifiable gap.
    if (request.sequence !== execution.cursor + 1) throw new FigPluginBridgeError('INVALID_REQUEST')
    if (request.total !== execution.plan.steps.length)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const previous = execution.progress.at(-1)
    const previousPhase = previous?.phase ?? 'claimed'
    // The claim receipt already records the sole `claimed` transition. A host
    // must not mint a second claimed event (or smuggle an effect/completed
    // count through that phase) after the write authority has been issued.
    // This closes a state-machine hole where a forged event could keep the
    // execution looking pre-write while advancing its progress cursor.
    if (request.phase === 'claimed') throw new FigPluginBridgeError('INVALID_REQUEST')
    if (PLAN_PROGRESS_PHASE_ORDER[request.phase] < PLAN_PROGRESS_PHASE_ORDER[previousPhase])
      throw new FigPluginBridgeError('INVALID_REQUEST')
    if (
      request.phase === 'executing' &&
      ((request.completed < request.total && request.effect !== 'partial') ||
        (request.completed === request.total && request.effect !== 'applied'))
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    if (request.phase === 'executing' && request.index !== request.completed - 1)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    if (
      request.phase === 'executing' &&
      previous?.phase === 'executing' &&
      request.completed < previous.completed
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    // A host may retry an executing event with the same completion count, but
    // it must not report a weaker effect after an applied/partial observation.
    // The write receipt is append-only; allowing this downgrade would make a
    // previously applied step look uncertain without a new native operation.
    if (
      request.phase === 'executing' &&
      previous?.phase === 'executing' &&
      request.completed === previous.completed &&
      request.effect !== previous.effect
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    execution.state = request.phase
    execution.completed = request.completed
    execution.effect = request.effect
    execution.updatedAt = this.clock()
    this.appendPlanProgress(execution, {
      sequence: request.sequence,
      phase: request.phase,
      ...(request.index === undefined ? {} : { index: request.index }),
      completed: request.completed,
      effect: request.effect,
      at: request.at
    })
    execution.progressFingerprints.set(request.sequence, requestFingerprint)
    while (execution.progressFingerprints.size > FIGPLUGIN_EXECUTION_MAX_EVENTS) {
      const oldest = execution.progressFingerprints.keys().next().value
      if (oldest === undefined) break
      execution.progressFingerprints.delete(oldest)
    }
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
    return this.executionStatus(execution)
  }

  planResult(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): FigPluginExecutionResultResponse {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionResultRequestSchema, input)
    const execution = this.ownedExecution(session, request.executionId)
    const fingerprint = digest(request)
    this.expireExecution(execution)
    this.checkDocumentWrite(execution)
    if (terminalExecution.has(execution.state)) {
      if (
        execution.resultFingerprint === fingerprint &&
        execution.intent?.actionId === request.actionId
      )
        return figPluginExecutionResultResponseSchema.parse({
          protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
          executionId: execution.executionId,
          status: this.executionStatus(execution)
        })
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    if (
      !execution.intent ||
      execution.intent.actionId !== request.actionId ||
      !this.matchesExecutionLineage(execution, request) ||
      !['claimed', 'executing', 'readback'].includes(execution.state) ||
      request.total !== execution.plan.steps.length
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    this.requireNativeWriteAuthority(execution)
    this.requireExecutionAssets(execution)
    try {
      validateHostPlanReadback(
        execution.plan,
        execution.context,
        request.readback,
        execution.executionAssets?.map(executionAssetMetadata),
        execution.recovery?.images
      )
      if (execution.recovery && request.effect === 'applied') {
        for (const step of execution.plan.steps) {
          const observed = request.readback.steps.find(
            (item) => item.targetId === step.targetId && item.command === step.command
          )
          if (
            !observed ||
            observed.observation !== 'requested' ||
            !Object.hasOwn(observed, 'value') ||
            canonicalFigPluginJson(observed.value) !== canonicalFigPluginJson(stepValue(step))
          )
            throw new Error('INVALID_RECOVERY_READBACK')
        }
      }
    } catch (error) {
      execution.state = 'failed'
      // A structurally valid readback with an impossible value is evidence that the
      // host result cannot be trusted. Keep stale identity/context failures distinct
      // from this quarantine path so a forged `requested` value never looks successful.
      execution.errorCode =
        error instanceof Error &&
        (error.message === 'INVALID_READBACK' || error.message === 'INVALID_RECOVERY_READBACK')
          ? 'QUARANTINED'
          : 'STALE_CONTEXT'
      execution.effect = 'unknown'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    const observations = request.readback.steps.map((step) => step.observation)
    if (request.effect === 'applied' && observations.some((value) => value !== 'requested')) {
      execution.state = 'failed'
      execution.errorCode = 'QUARANTINED'
      execution.effect = 'unknown'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    if (request.effect === 'rolled-back' && observations.some((value) => value !== 'original')) {
      execution.state = 'failed'
      execution.errorCode = 'QUARANTINED'
      execution.effect = 'unknown'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    const expectedVisualTargets = new Set(
      execution.visualTargetIds ?? execution.plan.steps.map((step) => step.targetId)
    )
    const suppliedVisualTargets = new Set(
      (request.visualEvidence ?? []).map((item) => item.targetId)
    )
    const hasCompleteVisualEvidence = Boolean(
      request.visualEvidence &&
      request.visualEvidence.length === expectedVisualTargets.size &&
      suppliedVisualTargets.size === expectedVisualTargets.size &&
      [...expectedVisualTargets].every((targetId) => suppliedVisualTargets.has(targetId))
    )
    const successfulAppliedResult = request.status === 'completed' && request.effect === 'applied'
    const visualEvidenceInvalid =
      execution.preview.visualAudit === 'hash-only'
        ? successfulAppliedResult && !hasCompleteVisualEvidence
        : request.visualEvidence !== undefined
    if (visualEvidenceInvalid) {
      execution.state = 'failed'
      execution.errorCode = 'QUARANTINED'
      execution.effect = 'unknown'
      execution.visualEvidence = undefined
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    execution.completed = request.completed
    execution.effect = request.effect
    // A terminal host receipt must always carry a stable public error class. Older
    // hosts may omit the optional field, so normalize the omission at this authority
    // boundary instead of exposing a failed/cancelled execution with no diagnosis.
    execution.errorCode =
      request.errorCode ??
      (request.status === 'cancelled'
        ? 'CANCELLED'
        : request.effect === 'rolled-back'
          ? 'ROLLED_BACK'
          : request.effect === 'unknown'
            ? 'QUARANTINED'
            : request.status === 'failed'
              ? 'EXECUTION_FAILED'
              : undefined)
    execution.resultFingerprint = fingerprint
    execution.visualEvidence = request.visualEvidence
      ? structuredClone(request.visualEvidence)
      : undefined
    execution.acceptedImageEvidence = successfulAppliedResult
      ? request.readback.steps.flatMap((step) =>
          (step.command === 'image.fill' || step.command === 'image.pixels') && step.imageEvidence
            ? [
                {
                  targetId: step.targetId,
                  command: step.command,
                  imageEvidence: structuredClone(step.imageEvidence)
                }
              ]
            : []
        )
      : undefined
    execution.updatedAt = this.clock()
    execution.state =
      request.status === 'completed' && request.effect === 'applied'
        ? 'completed'
        : request.status === 'cancelled'
          ? 'cancelled'
          : 'failed'
    if (request.effect === 'unknown') execution.errorCode = 'QUARANTINED'
    if (request.effect === 'rolled-back') execution.errorCode = 'ROLLED_BACK'
    execution.visualBaselineComparison =
      execution.state === 'completed' && execution.visualEvidence
        ? this.compareVisualBaseline(execution, execution.visualEvidence)
        : undefined
    if (
      successfulAppliedResult ||
      ((request.effect === 'none' || request.effect === 'rolled-back') &&
        observations.every((value) => value === 'original'))
    )
      this.releaseDocumentWrite(execution)
    this.settleRecoveryLease(execution)
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
    return figPluginExecutionResultResponseSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId: execution.executionId,
      status: this.executionStatus(execution)
    })
  }

  /** A read-only report about a completed result. It cannot mint a write grant. */
  async planPixelAudit(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginExecutionResultResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginPixelAuditRequestSchema, input)
    const execution = this.ownedExecution(session, request.executionId)
    await this.checkSession(session)
    this.requireCurrentSession(session)
    const comparison = execution.visualBaselineComparison
    const baseline = this.visualBaselines.get(request.baselineId)
    if (
      this.ownedExecution(session, request.executionId) !== execution ||
      execution.state !== 'completed' ||
      execution.effect !== 'applied' ||
      execution.intent?.actionId !== request.actionId ||
      !this.matchesExecutionLineage(execution, request) ||
      execution.preview.expiresAt <= this.clock() ||
      !comparison ||
      !baseline ||
      baseline.value.expiresAt <= this.clock() ||
      baseline.value.visualEvidenceSha256 !== request.baselineEvidenceSha256 ||
      canonicalFigPluginJson(baseline.binding) !== canonicalFigPluginJson(session.binding) ||
      !pixelAuditMatchesComparison(request, comparison)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const fingerprint = digest(request)
    if (execution.pixelAuditFingerprint && execution.pixelAuditFingerprint !== fingerprint)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    if (!execution.pixelAuditFingerprint) {
      execution.pixelAudit = figPluginPixelAuditSchema.parse({
        policy: request.policy,
        baselineId: request.baselineId,
        baselineEvidenceSha256: request.baselineEvidenceSha256,
        visualEvidenceSha256: request.visualEvidenceSha256,
        targets: request.targets,
        checkedAt: this.clock(),
        ...summarizePixelTargets(request.targets)
      })
      execution.pixelAuditFingerprint = fingerprint
      if (execution.pixelAudit.outcome === 'match') {
        for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
          if (record.value.sourceExecutionId === execution.executionId)
            this.removeVisualCorrectionAuthorization(id, 'CANCELLED')
        }
      }
      this.recordExecutionAudit(execution)
    }
    return figPluginExecutionResultResponseSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId: execution.executionId,
      status: this.executionStatus(execution)
    })
  }

  deny(callId: string): void {
    this.enter()
    const call = this.mainCall(callId)
    if (active(call)) this.terminate(call, 'DENIED')
    this.scheduleCleanup()
  }

  revokePlugin(pluginId: string): void {
    this.enter()
    for (const [id, ticket] of this.tickets) {
      if (ticket.binding.pluginId === pluginId) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (session.binding.pluginId === pluginId)
        this.removeSession(session, 'CONFIGURATION_CHANGED')
    }
    for (const [id, record] of this.visualBaselines) {
      if (record.binding.pluginId === pluginId) this.removeVisualBaseline(id)
    }
    for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
      if (record.binding.pluginId === pluginId)
        this.removeVisualCorrectionAuthorization(id, 'CONFIGURATION_CHANGED')
    }
    this.scheduleCleanup()
    try {
      this.checkpoints?.removeWhere((record) => record.binding.pluginId === pluginId)
    } catch {
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
  }

  /**
   * Revoke all transport-scoped authority after a child listener disconnects.
   *
   * Pairing tickets, bearer sessions and in-flight calls are bound to the
   * listener epoch. Keeping them alive across a child crash would let a late
   * response from the old process race a replacement listener, so this path
   * deliberately clears only volatile transport state (durable checkpoints
   * remain available for an explicitly re-associated recovery flow).
   */
  revokeTransport(): void {
    this.enter()
    for (const [id, ticket] of this.tickets) this.removeTicket(id, ticket)
    for (const session of [...this.sessions.values()]) {
      this.removeSession(session, 'CONFIGURATION_CHANGED')
    }
    for (const [id] of this.visualBaselines) this.removeVisualBaseline(id)
    // Do not clear correction maps blindly. A child transport can disappear
    // while a prepared correction is still awaiting approval; revoke it through
    // the same terminal/audit path as every other authority loss.
    for (const [id] of [...this.visualCorrectionAuthorizations])
      this.removeVisualCorrectionAuthorization(id, 'CONFIGURATION_CHANGED')
    for (const [id, execution] of [...this.visualCorrectionExecutions]) {
      this.terminateExecution(execution, 'CONFIGURATION_CHANGED')
      this.visualCorrectionExecutions.delete(id)
    }
    this.scheduleCleanup()
  }

  /** Synchronous authority notification: no polling, metadata discovery or provider await. */
  revokeInvalidBindings(isCurrent: (binding: FigPluginRuntimeBinding) => boolean): void {
    this.enter()
    const valid = (binding: FigPluginRuntimeBinding): boolean => {
      try {
        return isCurrent(Object.freeze({ ...binding })) === true
      } catch {
        return false
      }
    }
    for (const [id, ticket] of this.tickets) {
      if (!valid(ticket.binding)) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (!valid(session.binding)) this.removeSession(session, 'CONFIGURATION_CHANGED')
    }
    for (const [id, record] of this.visualBaselines) {
      if (!valid(record.binding)) this.removeVisualBaseline(id)
    }
    for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
      if (!valid(record.binding))
        this.removeVisualCorrectionAuthorization(id, 'CONFIGURATION_CHANGED')
    }
    this.scheduleCleanup()
    try {
      this.checkpoints?.removeWhere((record) => !valid(record.binding))
    } catch {
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const [id, ticket] of this.tickets) this.removeTicket(id, ticket)
    for (const session of this.sessions.values()) this.removeSession(session, 'CANCELLED')
    this.visualBaselines.clear()
    this.visualCorrectionAuthorizations.clear()
    this.visualCorrectionExecutions.clear()
    this.failures = []
  }

  listSessions(): Array<{
    sessionId: string
    pluginId: string
    host: FigPluginRuntimeBinding['host']
    projectId: string
    expiresAt: number
    activeCalls: number
  }> {
    this.enter()
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      pluginId: session.binding.pluginId,
      host: session.binding.host,
      projectId: session.binding.projectId,
      expiresAt: session.expiresAt,
      activeCalls:
        [...this.calls.values()].filter((call) => call.session === session && active(call)).length +
        Number(this.hasActiveNativeGeneration(session))
    }))
  }

  private enter(): void {
    if (this.closed) throw new FigPluginBridgeError('UNAUTHORIZED')
    this.prune()
  }

  private findExecution(executionId: string): PlanExecution {
    if (!isId(executionId)) throw new FigPluginBridgeError('INVALID_REQUEST')
    const correction = this.visualCorrectionExecutions.get(executionId)
    if (correction) {
      this.expireExecution(correction)
      return correction
    }
    for (const call of this.calls.values()) {
      if (call.execution?.executionId === executionId) {
        this.expireExecution(call.execution)
        return call.execution
      }
    }
    throw new FigPluginBridgeError('EXPIRED')
  }

  private ownedExecution(session: Session, executionId: string): PlanExecution {
    const execution = this.findExecution(executionId)
    if (
      execution.call.session !== session ||
      this.sessions.get(session.id) !== session ||
      this.calls.get(execution.call.receipt.response.callId) !== execution.call
    )
      throw new FigPluginBridgeError('UNAUTHORIZED')
    return execution
  }

  private appendPlanProgress(execution: PlanExecution, event: PlanProgress): void {
    if (event.sequence <= execution.cursor) return
    execution.cursor = event.sequence
    execution.progress.push(event)
    if (execution.progress.length > FIGPLUGIN_EXECUTION_MAX_EVENTS) execution.progress.shift()
  }

  private matchesExecutionLineage(
    execution: PlanExecution,
    value: Pick<
      | FigPluginExecutionProgressRequest
      | FigPluginExecutionResultRequest
      | FigPluginExecutionStatusRequest,
      'requestId' | 'runId' | 'correlationId'
    >
  ): boolean {
    return (
      (value.requestId === undefined || value.requestId === execution.call.receipt.requestId) &&
      (value.runId === undefined || value.runId === execution.runId) &&
      (value.correlationId === undefined ||
        value.correlationId === execution.call.receipt.correlationId)
    )
  }

  private releaseDocumentWrite(execution: PlanExecution): void {
    if (!execution.writeReservation) return
    try {
      this.writes.release(execution.writeReservation)
      execution.writeReservation = undefined
    } catch {
      // Keep exclusion until its original deadline plus drain, never pretend a failed
      // cleanup permits another writer. The verified host result remains truthful.
    }
  }

  /**
   * Re-check the synchronous native-write gate at every execution authority
   * boundary. This intentionally does not release an existing reservation:
   * once an intent escaped, the runtime must keep the document excluded until
   * a host receipt or the reservation's bounded expiry closes the crash fence.
   * The progress/result APIs remain synchronous, so asynchronous binding
   * validation is still owned by the surrounding transport's revocation hook.
   */
  private requireNativeWriteAuthority(execution: PlanExecution): void {
    if (terminalExecution.has(execution.state)) return
    let allowed = false
    try {
      allowed = this.allowNativeWrite(Object.freeze({ ...execution.call.session.binding })) === true
    } catch {
      /* A throwing policy is a denial, never an implicit grant. */
    }
    if (allowed) return
    this.terminateExecution(execution, 'DENIED')
    throw new FigPluginBridgeError('DENIED')
  }

  /**
   * A terminal host receipt closes the short crash fence written at claim time. If the
   * process dies before this point the persisted lease remains until its bounded expiry,
   * preventing a restarted runtime from issuing a second intent for the same round.
   */
  private settleRecoveryLease(execution: PlanExecution): void {
    const baselineId = execution.recovery?.baselineId ?? execution.visualCorrection?.baselineId
    if (!baselineId || !this.checkpoints?.settleRecovery) return
    try {
      this.checkpoints.settleRecovery(baselineId, execution.executionId)
    } catch {
      // The round was already consumed. Keeping the lease is the safe fallback when the
      // receipt cannot be persisted; it expires naturally rather than reopening authority.
    }
  }

  private checkDocumentWrite(execution: PlanExecution): void {
    if (!['claimed', 'executing', 'readback'].includes(execution.state)) return
    let owned = false
    try {
      owned = !!execution.writeReservation && this.writes.owns(execution.writeReservation)
    } catch {
      /* Missing/corrupt/busy coordination state cannot grant further host steps. */
    }
    if (!owned) {
      execution.state = 'failed'
      execution.errorCode = 'QUARANTINED'
      execution.effect = 'unknown'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
    }
  }

  private expireExecution(execution: PlanExecution): void {
    if (terminalExecution.has(execution.state)) return
    if (execution.preview.expiresAt > this.clock()) return
    this.terminateExecution(execution, 'EXPIRED')
  }

  private terminateExecution(execution: PlanExecution, code: TerminalCode): void {
    if (terminalExecution.has(execution.state)) return
    execution.state =
      code === 'EXPIRED'
        ? 'expired'
        : code === 'DENIED'
          ? 'denied'
          : code === 'CANCELLED' || code === 'CONFIGURATION_CHANGED'
            ? 'cancelled'
            : 'failed'
    execution.errorCode =
      code === 'CONFIGURATION_CHANGED'
        ? 'HOST_UNAVAILABLE'
        : code === 'UPSTREAM_FAILED'
          ? 'EXECUTION_FAILED'
          : code
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
  }

  private authenticate(id: string, token: string, touch = true): Session {
    this.enter()
    const session = isId(id) ? this.sessions.get(id) : undefined
    const matches = secretEquals(token, session?.token)
    if (!session || !matches) throw new FigPluginBridgeError('UNAUTHORIZED')
    if (touch) session.idleAt = this.clock() + IDLE_TTL
    this.scheduleCleanup()
    return session
  }

  private requireCurrentSession(session: Session): void {
    this.enter()
    if (this.sessions.get(session.id) !== session) throw new FigPluginBridgeError('UNAUTHORIZED')
  }

  private async validate(binding: FigPluginRuntimeBinding): Promise<boolean> {
    try {
      return (await this.validateBinding(Object.freeze({ ...binding }))) === true
    } catch {
      return false
    }
  }

  private async checkSession(session: Session): Promise<void> {
    // Coalesce concurrent checks without allowing a result to outlive its session epoch.
    const validation = session.validation ?? this.validate(session.binding)
    session.validation = validation
    const valid = await validation
    if (session.validation === validation) session.validation = undefined

    // Validation can suspend long enough for the absolute or idle session deadline to
    // pass while the periodic cleanup timer is still pending. Do not let that late
    // continuation use the session; expire it at the same boundary as prune().
    if (
      this.sessions.get(session.id) === session &&
      Math.min(session.expiresAt, session.idleAt) <= this.clock()
    ) {
      this.removeSession(session, 'EXPIRED')
      this.scheduleCleanup()
      throw new FigPluginBridgeError('EXPIRED')
    }

    this.requireCurrentSession(session)
    if (!valid) {
      this.removeSession(session, 'CONFIGURATION_CHANGED')
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
  }

  /**
   * Provider readiness is deliberately derived from an approved invocation that
   * was observed by this exact session/profile binding. Configuration alone is
   * not proof that a model can be reached, and cancelled/expired work is not a
   * provider failure. A shared circuit can explain a fresh failure, but cannot
   * create session evidence or extend its lifetime after cancelled probes.
   */
  private providerReadiness(
    session: Session,
    includeDiagnostics = false
  ): {
    state: 'ready' | 'not-ready' | 'unknown'
    code: string
    diagnostics?: {
      circuitState: 'closed' | 'open' | 'half-open'
      failureCount: number
      retryAt?: number
      probeInFlight: boolean
      lastOutcome?: ProviderCircuitOutcome
      lastOutcomeAt?: number
      lastLatencyMs?: number
      lastFailureClass?: ProviderCircuitFailureClass
      lastCorrelationId?: string
      observedAt?: number
      observedCorrelationId?: string
    }
  } {
    const now = this.clock()
    const providerKey = `${session.binding.host}:${session.binding.profileId}:${session.binding.profileRevision}`
    const circuit = includeDiagnostics
      ? this.providerCircuit.snapshot(providerKey, { detailed: true })
      : undefined
    const details = includeDiagnostics
      ? {
          circuitState: circuit!.state,
          failureCount: circuit!.failureCount,
          ...(circuit!.retryAt === undefined ? {} : { retryAt: circuit!.retryAt }),
          probeInFlight: circuit!.probeInFlight,
          ...(circuit!.lastOutcome === undefined ? {} : { lastOutcome: circuit!.lastOutcome }),
          ...(circuit!.lastOutcomeAt === undefined
            ? {}
            : { lastOutcomeAt: circuit!.lastOutcomeAt }),
          ...(circuit!.lastLatencyMs === undefined
            ? {}
            : { lastLatencyMs: circuit!.lastLatencyMs }),
          ...(circuit!.lastFailureClass === undefined
            ? {}
            : { lastFailureClass: circuit!.lastFailureClass }),
          ...(circuit!.lastCorrelationId === undefined
            ? {}
            : { lastCorrelationId: circuit!.lastCorrelationId }),
          ...(session.providerObservation === undefined
            ? {}
            : {
                observedAt: session.providerObservation.observedAt,
                observedCorrelationId: session.providerObservation.correlationId
              })
        }
      : undefined
    const result = (state: 'ready' | 'not-ready' | 'unknown', code: string) => ({
      ...readinessState(state, code),
      ...(details === undefined ? {} : { diagnostics: details })
    })
    const observation = session.providerObservation
    if (!observation) return result('unknown', 'provider-not-probed')
    if (
      observation.profileId !== session.binding.profileId ||
      observation.profileRevision !== session.binding.profileRevision
    ) {
      session.providerObservation = undefined
      return result('unknown', 'provider-not-probed')
    }
    if (observation.observedAt + PROVIDER_READINESS_TTL_MS <= now) {
      session.providerObservation = undefined
      return result('unknown', 'provider-stale')
    }
    if (observation.state === 'not-ready') {
      const circuitState = circuit ?? this.providerCircuit.snapshot(providerKey)
      if (
        circuitState.state === 'open' &&
        circuitState.retryAt !== undefined &&
        circuitState.retryAt > now
      )
        return result('not-ready', 'provider-circuit-open')
    }
    return result(observation.state, observation.code)
  }

  private recordProviderObservation(
    session: Session,
    outcome: Extract<ProviderCircuitOutcome, 'success' | 'failure'>,
    correlationId: string
  ): void {
    if (this.sessions.get(session.id) !== session || this.closed) return
    session.providerObservation = {
      profileId: session.binding.profileId,
      profileRevision: session.binding.profileRevision,
      state: outcome === 'success' ? 'ready' : 'not-ready',
      code: outcome === 'success' ? 'provider-observed' : 'provider-unavailable',
      observedAt: this.clock(),
      correlationId
    }
    this.scheduleCleanup()
  }

  private ownedReceipt(session: Session, callId: string): Receipt {
    if (isId(callId)) {
      for (const receipt of session.requests.values()) {
        if (receipt.response.callId === callId) return receipt
      }
    }
    throw new FigPluginBridgeError('UNAUTHORIZED')
  }

  private mainCall(callId: string): Call {
    const call = isId(callId) ? this.calls.get(callId) : undefined
    if (call) return call
    for (const session of this.sessions.values()) {
      for (const receipt of session.requests.values()) {
        if (receipt.response.callId === callId) throw new FigPluginBridgeError('EXPIRED')
      }
    }
    throw new FigPluginBridgeError('INVALID_REQUEST')
  }

  private checkApproval(call: Call, digest: string): void {
    const matches = secretEquals(digest, call.receipt.digest)
    if (this.calls.get(call.receipt.response.callId) !== call)
      throw new FigPluginBridgeError('EXPIRED')
    if (call.status.status !== 'awaiting-approval' || !call.preview || !matches) {
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
  }

  private running(call: Call): boolean {
    this.prune()
    return (
      !this.closed &&
      this.sessions.get(call.session.id) === call.session &&
      this.calls.get(call.receipt.response.callId) === call &&
      call.status.status === 'running'
    )
  }

  private async execute(
    call: Call,
    preview: FigPluginBridgePreview,
    controller: AbortController
  ): Promise<void> {
    const providerKey = `${call.session.binding.host}:${call.session.binding.profileId}:${call.session.binding.profileRevision}`
    let providerAdmitted = false
    let providerAttempt = false
    let providerOutcome: ProviderCircuitOutcome | undefined
    let providerFailureClass: ProviderCircuitFailureClass | undefined
    try {
      const value = await this.invoke(
        Object.freeze({ ...call.session.binding }),
        preview,
        controller.signal,
        call.receipt.correlationId,
        () => {
          if (!providerAdmitted) return
          providerAttempt = true
          if (!this.running(call) || controller.signal.aborted) return
          this.recordPlanningAudit(call, 'provider-dispatched')
        },
        () => {
          if (!this.running(call) || controller.signal.aborted)
            throw new FigPluginBridgeError('CANCELLED')
          this.requirePlanningAssets(call.session, call.planningAssets)
          // Local preflight is not a provider probe and must not consume its cooldown.
          if (providerAdmitted) return
          if (!this.providerCircuit.allow(providerKey)) throw new ProviderCircuitOpenError()
          providerAdmitted = true
        }
      )
      if (!this.running(call)) return
      const result = parseFigPluginBridgeValue(resultSchema, value)
      // A provider/profile change while invoking also invalidates an otherwise good result.
      await this.checkSession(call.session)
      if (!this.running(call)) return
      this.requirePlanningAssets(call.session, call.planningAssets)
      providerOutcome = providerAttempt ? 'success' : 'unknown'
      if (providerOutcome === 'success')
        this.recordProviderObservation(call.session, providerOutcome, call.receipt.correlationId)
      if (call.preview?.featureId === 'plan-preview' && call.hostContext) {
        this.registerPlanExecution(call, result.content, call.hostContext)
      }
      call.status = {
        protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
        callId: call.receipt.response.callId,
        status: 'completed',
        ...result
      }
      this.recordPlanningAudit(call, 'completed', {
        resultBytes: Buffer.byteLength(result.content, 'utf8'),
        ...(result.reportedTotalTokens === undefined
          ? {}
          : { reportedTotalTokens: result.reportedTotalTokens })
      })
      call.preview = undefined
      call.hostContext = undefined
      call.controller = undefined
      call.deadline = undefined
      this.scheduleCleanup()
    } catch (error) {
      const active = this.running(call)
      if (providerAdmitted && providerOutcome === undefined) {
        const typedCode = error instanceof FigPluginBridgeError ? error.code : undefined
        providerFailureClass =
          typedCode === 'TIMEOUT'
            ? 'timeout'
            : typedCode === 'CANCELLED'
              ? 'cancelled'
              : typedCode === 'CONFIGURATION_CHANGED'
                ? 'configuration'
                : providerAttempt
                  ? 'upstream'
                  : 'unknown'
        providerOutcome =
          !providerAttempt ||
          !active ||
          typedCode === 'TIMEOUT' ||
          typedCode === 'CANCELLED' ||
          typedCode === 'CONFIGURATION_CHANGED'
            ? 'unknown'
            : 'failure'
      }
      if (providerAttempt && providerOutcome === 'failure' && this.running(call))
        this.recordProviderObservation(call.session, providerOutcome, call.receipt.correlationId)
      const reason =
        error instanceof FigPluginBridgeError &&
        ['TIMEOUT', 'CANCELLED', 'CONFIGURATION_CHANGED'].includes(error.code)
          ? (error.code as 'TIMEOUT' | 'CANCELLED' | 'CONFIGURATION_CHANGED')
          : 'UPSTREAM_FAILED'
      if (active) this.terminate(call, reason)
      this.scheduleCleanup()
    } finally {
      if (providerAdmitted)
        this.providerCircuit.complete(providerKey, providerOutcome ?? 'unknown', {
          failureClass: providerFailureClass,
          correlationId: call.receipt.correlationId
        })
      // An invoker ignoring abort still occupies a slot until it settles. Releasing
      // on cancellation/timeout would permit unbounded outstanding provider work.
      this.executing -= 1
    }
  }

  private terminate(call: Call, code: TerminalCode): void {
    // Audit before parent cleanup removes the only reference to an ordinary plan.
    // Cancellation/expiry never release native-write exclusion without readback.
    if (call.execution) this.terminateExecution(call.execution, code)
    const controller = call.controller
    call.status = {
      protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
      callId: call.receipt.response.callId,
      status: code === 'CANCELLED' || code === 'DENIED' ? 'cancelled' : 'failed',
      errorCode: code
    }
    this.recordPlanningAudit(
      call,
      code === 'CANCELLED'
        ? 'cancelled'
        : code === 'DENIED'
          ? 'denied'
          : code === 'EXPIRED'
            ? 'expired'
            : 'failed',
      { errorCode: code }
    )
    call.preview = undefined
    call.controller = undefined
    call.deadline = undefined
    controller?.abort()
  }

  private recordPlanningAudit(
    call: Call,
    state: FigPluginPlanningAuditEvent['state'],
    outcome: Pick<
      FigPluginPlanningAuditEvent,
      'errorCode' | 'resultBytes' | 'reportedTotalTokens'
    > = {}
  ): void {
    const record = call.planningAudit
    if (!this.planningAudit || !record || record.terminal || record.state === state) return
    record.state = state
    record.terminal = !['awaiting-approval', 'running', 'provider-dispatched'].includes(state)
    // Cleanup may terminate an already-completed call. Historical outcome is immutable,
    // and a late provider callback must never append a second terminal event.
    const at = this.clock()
    try {
      this.planningAudit({
        schemaVersion: 1,
        kind: 'planning',
        ...record.summary,
        at,
        sequence: ++record.sequence,
        state,
        durationMs: Math.max(0, at - record.startedAt),
        ...outcome
      })
    } catch {
      // Observability is not authority: a failed sink must not replay or undo work.
    }
  }

  private removeTicket(id: string, ticket: Ticket): void {
    this.tickets.delete(id)
    ticket.secret = ''
  }

  private removeVisualCorrectionAuthorization(
    authorizationId: string,
    reason: 'CANCELLED' | 'EXPIRED' | 'CONFIGURATION_CHANGED'
  ): void {
    const record = this.visualCorrectionAuthorizations.get(authorizationId)
    if (!record) return
    this.visualCorrectionAuthorizations.delete(authorizationId)
    const execution = record.preparedExecutionId
      ? this.visualCorrectionExecutions.get(record.preparedExecutionId)
      : undefined
    if (execution && !terminalExecution.has(execution.state)) {
      execution.state = reason === 'EXPIRED' ? 'expired' : 'cancelled'
      execution.errorCode =
        reason === 'EXPIRED'
          ? 'EXPIRED'
          : reason === 'CONFIGURATION_CHANGED'
            ? 'HOST_UNAVAILABLE'
            : 'CANCELLED'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
    }
  }

  private removeVisualBaseline(baselineId: string): void {
    this.visualBaselines.delete(baselineId)
    for (const execution of this.allPlanExecutions())
      if (execution.recovery?.baselineId === baselineId)
        this.terminateExecution(execution, 'CONFIGURATION_CHANGED')
    for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
      if (record.value.baselineId === baselineId)
        this.removeVisualCorrectionAuthorization(id, 'CONFIGURATION_CHANGED')
    }
    for (const [id, execution] of [...this.visualCorrectionExecutions]) {
      if (execution.visualCorrection?.baselineId === baselineId) {
        this.terminateExecution(execution, 'CONFIGURATION_CHANGED')
        this.visualCorrectionExecutions.delete(id)
      }
    }
  }

  private removeSession(session: Session, code: TerminalCode): void {
    this.sessions.delete(session.id)
    for (const proposal of session.imageGenerationRequests.values()) {
      this.stopNativeImageGeneration(proposal, code)
      proposal.abort.abort()
      this.nativeImageGenerations.delete(proposal.response.proposalId)
    }
    session.imageGenerationRequests.clear()
    for (const assetId of session.assets.keys()) this.removeSessionAsset(session, assetId, code)
    session.token = ''
    session.requests.clear()
    session.validation = undefined
    for (const [id, execution] of [...this.visualCorrectionExecutions]) {
      if (execution.call.session === session) {
        this.terminateExecution(
          execution,
          code === 'CANCELLED' ? 'CANCELLED' : 'CONFIGURATION_CHANGED'
        )
        this.visualCorrectionExecutions.delete(id)
      }
    }
    for (const [id, call] of this.calls) {
      if (call.session === session) {
        this.calls.delete(id)
        this.terminate(call, code)
      }
    }
  }

  private prune(): void {
    if (this.closed) return
    const now = this.clock()
    this.failures = this.failures.filter((time) => time + FAILURE_WINDOW > now)
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (Math.min(session.expiresAt, session.idleAt) <= now) this.removeSession(session, 'EXPIRED')
      else if (
        session.providerObservation &&
        session.providerObservation.observedAt + PROVIDER_READINESS_TTL_MS <= now
      )
        session.providerObservation = undefined
      for (const [assetId, record] of session.assets) {
        if (record.value.expiresAt <= now) this.removeSessionAsset(session, assetId, 'EXPIRED')
      }
    }
    for (const [id, call] of this.calls) {
      if (call.receipt.response.expiresAt <= now) {
        for (const [executionId, execution] of [...this.visualCorrectionExecutions]) {
          if (execution.call === call) {
            this.expireExecution(execution)
            this.visualCorrectionExecutions.delete(executionId)
          }
        }
        this.calls.delete(id)
        this.terminate(call, 'EXPIRED')
      } else if (call.deadline !== undefined && call.deadline <= now) {
        this.terminate(call, 'TIMEOUT')
      }
    }
    for (const proposal of this.nativeImageGenerations.values()) {
      if (proposal.response.expiresAt <= now) this.stopNativeImageGeneration(proposal, 'EXPIRED')
    }
    for (const [id, record] of this.visualBaselines) {
      if (record.value.expiresAt <= now) this.removeVisualBaseline(id)
    }
    for (const execution of this.visualCorrectionExecutions.values())
      this.expireExecution(execution)
    for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
      if (record.value.expiresAt <= now || !this.visualBaselines.has(record.value.baselineId))
        this.removeVisualCorrectionAuthorization(id, 'EXPIRED')
    }
    this.scheduleCleanup()
  }

  private scheduleCleanup(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.closed) return
    let next = Infinity
    for (const ticket of this.tickets.values()) next = Math.min(next, ticket.expiresAt)
    for (const session of this.sessions.values())
      next = Math.min(next, session.expiresAt, session.idleAt)
    for (const session of this.sessions.values())
      for (const record of session.assets.values()) next = Math.min(next, record.value.expiresAt)
    for (const session of this.sessions.values())
      if (session.providerObservation)
        next = Math.min(next, session.providerObservation.observedAt + PROVIDER_READINESS_TTL_MS)
    for (const call of this.calls.values())
      next = Math.min(next, call.receipt.response.expiresAt, call.deadline ?? Infinity)
    for (const proposal of this.nativeImageGenerations.values())
      if (!nativeGenerationTerminal(proposal.status.phase))
        next = Math.min(next, proposal.response.expiresAt)
    for (const record of this.visualBaselines.values())
      next = Math.min(next, record.value.expiresAt)
    for (const record of this.visualCorrectionAuthorizations.values())
      next = Math.min(next, record.value.expiresAt)
    for (const execution of this.visualCorrectionExecutions.values())
      if (!terminalExecution.has(execution.state))
        next = Math.min(next, execution.preview.expiresAt)
    if (this.failures.length) next = Math.min(next, this.failures[0] + FAILURE_WINDOW)
    if (next === Infinity) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.prune()
      },
      Math.max(1, next - this.clock())
    )
    this.timer.unref()
  }
}
