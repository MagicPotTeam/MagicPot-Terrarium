import { SqliteNativeWriteCoordinator } from '../figplugin/nativeWriteCoordinator'
import { createCheckpointStore } from '../figplugin/checkpointEncryption'
import {
  savedTaskCheckpointsSchema,
  type SavedTaskCheckpoint
} from '@shared/figplugin/taskRecovery'
import {
  buildBridgeApprovalDetails,
  buildPlanExecutionApprovalDetails,
  buildVisualBaselineApprovalDetails,
  buildVisualCorrectionAuthorizationDetails
} from '../figplugin/bridgeApprovalDetails'
import path from 'node:path'
import fs from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { TextDecoder } from 'node:util'
import {
  app,
  dialog,
  clipboard,
  shell,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import { authorizeMagicAgentApprovalRenderer as authorizeTrustedDesktopRenderer } from '../magicAgentRuntime/trustedRouteBinding'
import type { FigPluginCenterOperation, FigPluginCenterResponse } from '@shared/figplugin/center'
import { FigPluginCenterStore } from '../figplugin/centerStore'
import { verifyNativePluginManifest } from '../figplugin/nativeManifest'
import { FigPluginBridgeController } from '../figplugin/bridgeController'
import { createFigPluginBridgeChildLauncher } from '../figplugin/bridgeChildLauncher'
import { createParentOwnedFigPluginBridgeChildTransport } from '../figplugin/bridgeTransport'
import {
  createFigPluginProductionHostAdapterSessions,
  type FigPluginProductionHostAdapterSessions,
  type FigPluginProductionPlanScopeResolver
} from '../figplugin/hostAdapterRegistry'
import {
  materializeSessionAsset,
  materializeManagedSessionAsset,
  type SessionAssetMaterializer,
  type ManagedSessionAssetMaterializer,
  type MaterializedSessionAsset
} from '../figplugin/hostAssetMaterialization'
import {
  figPluginDesktopManagedAssetRequestSchema,
  type FigPluginDesktopManagedAssetRequest
} from '@shared/figplugin/managedSessionAsset'
import {
  FIGPLUGIN_IMAGE_GENERATION_OPTIONS,
  figPluginImageGenerationRequestSchema,
  figPluginImageGenerationKeySchema,
  figPluginImageGenerationAcceptSchema,
  type FigPluginImageGenerationRequest,
  type FigPluginImageGenerationKey,
  type FigPluginImageGenerationOutput,
  type FigPluginImageGenerationState,
  type FigPluginImageGenerationAccept
} from '@shared/figplugin/imageGeneration'
import {
  figPluginNativeImageGenerationDesktopKeySchema,
  figPluginNativeImageGenerationDesktopStateSchema,
  type FigPluginNativeImageGenerationDesktopKey,
  type FigPluginNativeImageGenerationDesktopState
} from '@shared/figplugin/nativeImageGeneration'
import type { FigPluginNativeImageGenerationReceipt } from '../figplugin/bridgeRuntime'
import {
  FigPluginImageGenerationCoordinator,
  type FigPluginImageGenerationModel
} from '../figplugin/imageGenerationCoordinator'
import {
  materializeProviderImageOutput,
  type ProviderImageOutputMaterializer
} from '../figplugin/providerImageOutput'
import {
  FIGPLUGIN_ASSET_TTL_MS,
  figPluginDesktopAssetTargetSchema,
  figPluginDesktopAssetRevokeSchema,
  figPluginSessionAssetSchema,
  figPluginAssetListSchema,
  type FigPluginDesktopAssetTarget,
  type FigPluginDesktopAssetRevoke,
  type FigPluginSessionAsset,
  type FigPluginAssetList
} from '@shared/figplugin/hostAssets'
import {
  getFigPluginExecutionAuditStore,
  flushFigPluginExecutionAuditStores,
  type FigPluginExecutionAuditStore
} from '../figplugin/executionAudit'
import {
  getFigPluginPlanningAuditStore,
  flushFigPluginPlanningAuditStores,
  type FigPluginPlanningAuditStore
} from '../figplugin/planningAudit'
import {
  figPluginPlanningHistoryRequestSchema,
  figPluginPlanningHistorySchema,
  type FigPluginPlanningHistoryRequest,
  type FigPluginPlanningHistory
} from '@shared/figplugin/planningAudit'
import {
  FIGPLUGIN_AUDIT_TTL_MS,
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  figPluginExecutionHistoryRequestSchema,
  figPluginExecutionHistorySchema,
  type FigPluginExecutionHistoryRequest,
  type FigPluginExecutionHistory
} from '@shared/figplugin/executionAudit'
import {
  FigPluginBridgeError,
  figPluginDesktopPairRequestSchema,
  figPluginDesktopApprovalSchema,
  figPluginDesktopCallSchema,
  parseFigPluginBridgeValue,
  type FigPluginDesktopPairRequest,
  type FigPluginDesktopPairTicket,
  type FigPluginDesktopApproval,
  type FigPluginBridgeDesktopState
} from '@shared/figplugin/bridge'
import {
  figPluginDesktopExecutionApprovalSchema,
  figPluginDesktopExecutionSchema,
  figPluginDesktopVisualBaselineAcceptanceSchema,
  figPluginDesktopVisualCorrectionAuthorizationRequestSchema,
  figPluginDesktopVisualCorrectionAuthorizationSchema,
  type FigPluginDesktopExecution,
  type FigPluginDesktopExecutionApproval,
  type FigPluginDesktopVisualBaselineAcceptance,
  type FigPluginDesktopVisualCorrectionAuthorization,
  type FigPluginDesktopVisualCorrectionAuthorizationRequest,
  type FigPluginExecutionDesktopState,
  type FigPluginVisualBaseline,
  type FigPluginVisualCorrectionAuthorization
} from '@shared/figplugin/execution'
import {
  readAndVerifyFigPluginPackageFile,
  type VerifiedFigPluginPackage
} from '../figplugin/packageVerifier'
import {
  FigPluginManagementError,
  FIGPLUGIN_MANAGEMENT_ERRORS,
  figPluginPackagePreviewSchema,
  figPluginManagementEmptyRequestSchema,
  figPluginPackageInstallRequestSchema,
  figPluginManagedConfigureRequestSchema,
  figPluginManagedRemoveRequestSchema,
  figPluginManagedTargetSchema,
  figPluginManagedListSchema,
  parseFigPluginManagementValue,
  type FigPluginManagementErrorCode,
  type FigPluginPackagePreview,
  type FigPluginPackageInstallRequest,
  type FigPluginManagedConfigureRequest,
  type FigPluginManagedRemoveRequest,
  type FigPluginManagedTarget,
  type FigPluginManagedMutation,
  type FigPluginManagedList
} from '@shared/figplugin/management'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'

const PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEWS = 4
const CHOOSER_TIMEOUT_MS = 5 * 60_000
type NativeImageGenerationControl = Pick<
  FigPluginBridgeController,
  | 'nativeImageGenerationProposals'
  | 'claimNativeImageGeneration'
  | 'isNativeImageGenerationCurrent'
  | 'validateNativeImageGeneration'
  | 'observeNativeImageGeneration'
  | 'finishNativeImageGeneration'
  | 'cancelNativeImageGeneration'
>
type BridgeControl = Pick<
  FigPluginBridgeController,
  | 'resolveBinding'
  | 'createPairing'
  | 'desktopState'
  | 'approve'
  | 'deny'
  | 'revokePlugin'
  | 'beginSessionAssetSelection'
  | 'publishSessionAsset'
  | 'listSessionAssets'
  | 'revokeSessionAsset'
  | 'planState'
  | 'approvePlanExecution'
  | 'acceptVisualBaseline'
  | 'authorizeVisualCorrection'
  | 'cancelVisualCorrectionAuthorization'
  | 'denyPlanExecution'
  | 'cancelPlanExecution'
  | 'dispose'
> &
  Partial<
    Pick<
      FigPluginBridgeController,
      'isSessionAssetSelectionCurrent' | 'validateSessionAssetSelection'
    >
  > &
  Partial<NativeImageGenerationControl>
const activeBridges = new Set<BridgeControl>()
const activeImageGenerations = new Map<FigPluginImageGenerationCoordinator, () => void>()
const activeHostAdapterSessions = new Set<FigPluginProductionHostAdapterSessions>()
let bridgeShutdownEpoch = 0
export async function disposeFigPluginBridges(): Promise<void> {
  bridgeShutdownEpoch++
  const generationCleanup: Promise<void>[] = []
  for (const [coordinator, unsubscribe] of activeImageGenerations) {
    generationCleanup.push(coordinator.dispose())
    try {
      unsubscribe()
    } catch {
      // Keep other generation/Bridge cleanup reachable if one detach fails.
    }
  }
  activeImageGenerations.clear()
  const hostAdapterSessions = [...activeHostAdapterSessions]
  activeHostAdapterSessions.clear()
  const controllers = [...activeBridges]
  activeBridges.clear()
  await Promise.all([
    ...generationCleanup,
    ...hostAdapterSessions.map((sessions) => sessions.dispose().catch(() => undefined)),
    ...controllers.map((controller) => controller.dispose().catch(() => undefined))
  ])
  await Promise.all([flushFigPluginExecutionAuditStores(), flushFigPluginPlanningAuditStores()])
}

type PackagePreview = {
  senderId: number
  window: BrowserWindow
  documentUrl: string
  documentGeneration: number
  expiresAt: number
  verified: VerifiedFigPluginPackage
  generation: number
}

/**
 * Sort retained execution evidence deterministically, even when several state
 * transitions share the same clock tick. The audit file is append-only, but
 * its append order is not a stable API, so equal timestamp/sequence records
 * need immutable tie-breakers rather than relying on Array#sort's input order.
 */
const compareExecutionHistory = (
  left: FigPluginExecutionHistory['records'][number],
  right: FigPluginExecutionHistory['records'][number]
): number => {
  if (left.at !== right.at) return right.at - left.at
  const leftSequence = left.sequence ?? 0
  const rightSequence = right.sequence ?? 0
  if (leftSequence !== rightSequence) return rightSequence - leftSequence
  const textFields = [
    left.correlationId ?? '',
    right.correlationId ?? '',
    left.runId ?? '',
    right.runId ?? '',
    left.executionId,
    right.executionId,
    left.callId,
    right.callId,
    left.requestId,
    right.requestId,
    left.pluginId,
    right.pluginId,
    left.projectId,
    right.projectId
  ]
  for (let index = 0; index < textFields.length; index += 2) {
    const a = textFields[index]
    const b = textFields[index + 1]
    if (a < b) return -1
    if (a > b) return 1
  }
  // A malformed/legacy store can still contain distinct records with the same
  // lineage identifiers. Canonicalizing the bounded record gives those entries
  // a final deterministic key instead of falling back to append order.
  const leftKey = canonicalFigPluginJson(left)
  const rightKey = canonicalFigPluginJson(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

const comparePlanningHistory = (
  left: FigPluginPlanningHistory['records'][number],
  right: FigPluginPlanningHistory['records'][number]
): number => {
  if (left.at !== right.at) return right.at - left.at
  if (left.sequence !== right.sequence) return right.sequence - left.sequence
  for (const key of ['correlationId', 'callId', 'requestId', 'pluginId', 'projectId'] as const) {
    if (left[key] < right[key]) return -1
    if (left[key] > right[key]) return 1
  }
  const leftKey = canonicalFigPluginJson(left)
  const rightKey = canonicalFigPluginJson(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

function sanitizedManagementError(error: unknown): FigPluginManagementError | FigPluginBridgeError {
  if (error instanceof FigPluginBridgeError) return new FigPluginBridgeError(error.code)
  if (error instanceof ServiceError && Object.hasOwn(FIGPLUGIN_MANAGEMENT_ERRORS, error.code)) {
    return new FigPluginManagementError(error.code as FigPluginManagementErrorCode)
  }
  return new FigPluginManagementError('IO_ERROR')
}

/** Native-chooser-authorized public key only. Never accepts a path from renderer IPC. */
async function readSelectedPublicKey(filename: string, check: () => void): Promise<string> {
  check()
  if (
    !path.isAbsolute(filename) ||
    /^[\\\\/]{2}/.test(filename) ||
    filename.includes('\0') ||
    filename.length > 4096 ||
    (process.platform === 'win32' ? !/^[A-Za-z]:[\\\\/]/.test(filename) : filename.includes('\\'))
  )
    throw new FigPluginManagementError('INVALID_SIGNER')
  const absolute = path.resolve(filename)
  const segments = absolute.slice(path.parse(absolute).root.length).split(path.sep)
  if (segments.length > 64) throw new FigPluginManagementError('INVALID_SIGNER')
  const inspect = async () => {
    let current = path.parse(absolute).root
    const infos: BigIntStats[] = []
    for (const [index, segment] of ['', ...segments].entries()) {
      check()
      current = path.join(current, segment)
      const info = await fs.lstat(current, { bigint: true })
      check()
      if (info.isSymbolicLink() || (index < segments.length && !info.isDirectory()))
        throw new FigPluginManagementError('INVALID_SIGNER')
      infos.push(info)
    }
    const real = await fs.realpath(absolute)
    check()
    if (
      (process.platform === 'win32' ? real.toLowerCase() : real) !==
      (process.platform === 'win32' ? absolute.toLowerCase() : absolute)
    )
      throw new FigPluginManagementError('INVALID_SIGNER')
    return infos
  }
  const chain = await inspect()
  const before = chain[chain.length - 1]
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 4096n)
    throw new FigPluginManagementError('INVALID_SIGNER')
  const handle = await fs.open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    check()
    const opened = await handle.stat({ bigint: true })
    check()
    if (
      !opened.isFile() ||
      opened.mode !== before.mode ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.nlink !== 1n ||
      opened.size !== before.size
    )
      throw new FigPluginManagementError('INVALID_SIGNER')
    const buffer = Buffer.alloc(4097)
    let bytes = 0
    while (bytes < buffer.length) {
      check()
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      check()
      if (!result.bytesRead) break
      bytes += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      BigInt(bytes) !== opened.size ||
      bytes > 4096 ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.nlink !== 1n
    )
      throw new FigPluginManagementError('INVALID_SIGNER')
    const finalChain = await inspect()
    if (
      !chain.every(
        (info, index) =>
          info.ino === finalChain[index].ino &&
          info.dev === finalChain[index].dev &&
          info.mode === finalChain[index].mode
      )
    )
      throw new FigPluginManagementError('INVALID_SIGNER')
    const last = finalChain[finalChain.length - 1]
    if (
      last.nlink !== 1n ||
      last.size !== after.size ||
      last.mtimeNs !== after.mtimeNs ||
      last.ctimeNs !== after.ctimeNs
    )
      throw new FigPluginManagementError('INVALID_SIGNER')
    check()
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))
  } finally {
    await handle.close()
  }
}

const checkpointStore = () =>
  createCheckpointStore(path.join(app.getPath('userData'), 'figplugin-center'))

/**
 * Packaged builds cross the fixed utility-process boundary. An unbuilt
 * development checkout keeps the listener in-process so `npm run dev` remains
 * usable without a generated child bundle.
 */
export function createProductionBridgeTransport():
  ReturnType<typeof createParentOwnedFigPluginBridgeChildTransport> | undefined {
  if (app.isPackaged !== true) return undefined
  return createParentOwnedFigPluginBridgeChildTransport({
    launch: createFigPluginBridgeChildLauncher()
  })
}

export type FigPluginProductionBridgeContext = Readonly<{
  hostAdapterSessions: FigPluginProductionHostAdapterSessions
}>

export async function createProductionBridge(
  store: FigPluginCenterStore,
  context?: FigPluginProductionBridgeContext
): Promise<BridgeControl> {
  const { LLMProxySvcImpl } = await import('./svcLLMProxyImpl')
  const audit = getFigPluginExecutionAuditStore(
    path.join(app.getPath('userData'), 'figplugin-center')
  )
  const planningAudit = getFigPluginPlanningAuditStore(
    path.join(app.getPath('userData'), 'figplugin-center')
  )
  // Packaged builds ship a hash-pinned utility-process entry. Keep the
  // development listener in-process so an unbuilt checkout remains usable;
  // production must cross the supervised child boundary before exposing HTTP.
  const bridgeTransport = createProductionBridgeTransport()
  const hostAdapterSessions = context?.hostAdapterSessions
  return new FigPluginBridgeController(store, new LLMProxySvcImpl(), {
    audit: (event) => audit.record(event),
    planningAudit: (event) => planningAudit.record(event),
    checkpoints: checkpointStore(),
    writes: new SqliteNativeWriteCoordinator(
      path.join(app.getPath('userData'), 'figplugin-center')
    ),
    ...(hostAdapterSessions
      ? {
          hostAdapterRegistry: hostAdapterSessions.registry,
          planExecution: {
            // The scope resolver is main-owned and selects the registered
            // host session; no bearer/HTTP field can choose an adapter epoch.
            captureScope: (signal: AbortSignal) => hostAdapterSessions.captureScope(signal)
          }
        }
      : {}),
    ...(bridgeTransport ? { bridgeTransport } : {})
  })
}

async function createProductionImageGenerationModel(): Promise<FigPluginImageGenerationModel> {
  const { LLMProxySvcImpl } = await import('./svcLLMProxyImpl')
  return new LLMProxySvcImpl({ retryModelCapacity: false })
}

export class FigPluginCenterSvcImpl implements FigPluginCenterSvc {
  private readonly previews = new Map<string, PackagePreview>()
  private pending = false
  private readonly watchedWindows = new WeakSet<BrowserWindow>()
  private readonly documentGenerations = new WeakMap<BrowserWindow, number>()
  private bridge?: BridgeControl
  private bridgePending?: Promise<BridgeControl>
  private bridgeEpoch = 0
  /** Main-only host adapter authority; never exposed through the IPC service sheet. */
  private readonly hostAdapterSessions = createFigPluginProductionHostAdapterSessions()
  private pairingOperation?: { pluginId: string; revoked: boolean }
  private assetSelectionOperation?: { pluginId: string; sessionId: string; revoked: boolean }
  private imageGeneration?: FigPluginImageGenerationCoordinator
  private readonly imageGenerationOwners = new WeakMap<
    BrowserWindow,
    { generation: number; documentUrl: string; token: object }
  >()

  private stopBridge(): void {
    this.bridgeEpoch++
    this.imageGeneration?.cancelAll()
    const controller = this.bridge
    this.bridge = undefined
    this.bridgePending = undefined
    if (controller) {
      activeBridges.delete(controller)
      void controller.dispose().catch(() => undefined)
    }
    // A navigation/configuration boundary invalidates host object handles. The
    // next Bridge must receive a fresh host registration rather than reusing a
    // stale document/session scope.
    void this.hostAdapterSessions.clear()
  }

  private async getBridge(): Promise<BridgeControl> {
    if (this.bridge) return this.bridge
    if (this.bridgePending) return this.bridgePending
    const epoch = this.bridgeEpoch
    const shutdownEpoch = bridgeShutdownEpoch
    const pending = this.makeBridge(this.store, {
      hostAdapterSessions: this.hostAdapterSessions
    }).then(async (controller) => {
      if (this.bridgeEpoch !== epoch || shutdownEpoch !== bridgeShutdownEpoch) {
        await controller.dispose()
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      }
      this.bridge = controller
      activeBridges.add(controller)
      return controller
    })
    this.bridgePending = pending
    try {
      return await pending
    } finally {
      if (this.bridgePending === pending) this.bridgePending = undefined
    }
  }

  private watchWindow(parent: BrowserWindow): void {
    if (this.watchedWindows.has(parent)) return
    this.watchedWindows.add(parent)
    this.documentGenerations.set(parent, 0)
    const invalidate = () => {
      this.stopBridge()
      this.documentGenerations.set(parent, (this.documentGenerations.get(parent) ?? 0) + 1)
      for (const [id, preview] of this.previews) {
        if (preview.window === parent) this.previews.delete(id)
      }
    }
    parent.webContents.on('did-start-navigation', invalidate)
    parent.webContents.once('destroyed', invalidate)
  }

  private async confirm(
    parent: BrowserWindow,
    options: MessageBoxOptions
  ): Promise<MessageBoxReturnValue> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FigPluginManagementError('TIMEOUT')), CHOOSER_TIMEOUT_MS)
      timer.unref()
    })
    try {
      return await Promise.race([dialog.showMessageBox(parent, options), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  constructor(
    private readonly store = new FigPluginCenterStore(() =>
      path.join(app.getPath('userData'), 'figplugin-center')
    ),
    private readonly getMainWindow: () => BrowserWindow | null = () => null,
    private readonly makeBridge: (
      store: FigPluginCenterStore,
      context?: FigPluginProductionBridgeContext
    ) => Promise<BridgeControl> = createProductionBridge,
    private readonly getAuditStore: () => Pick<
      FigPluginExecutionAuditStore,
      'list' | 'writeFailed'
    > = () =>
      getFigPluginExecutionAuditStore(path.join(app.getPath('userData'), 'figplugin-center')),
    private readonly getCheckpointSummaries: () => SavedTaskCheckpoint[] = () =>
      createCheckpointStore(path.join(app.getPath('userData'), 'figplugin-center')).listSummaries(),
    private readonly getPlanningAuditStore: () => Pick<
      FigPluginPlanningAuditStore,
      'list' | 'writeFailed'
    > = () =>
      getFigPluginPlanningAuditStore(path.join(app.getPath('userData'), 'figplugin-center')),
    private readonly materializeAsset: SessionAssetMaterializer = materializeSessionAsset,
    private readonly materializeManagedAsset: ManagedSessionAssetMaterializer = materializeManagedSessionAsset,
    private readonly makeImageGenerationModel: () => Promise<FigPluginImageGenerationModel> = createProductionImageGenerationModel,
    private readonly materializeGeneratedImage: ProviderImageOutputMaterializer = materializeProviderImageOutput
  ) {
    activeHostAdapterSessions.add(this.hostAdapterSessions)
  }

  /**
   * Main-only registration hook for a real Figma/Photoshop adapter. Host plugin
   * transport code may call this directly; the shared IPC sheet intentionally
   * has no route that can register or replace an adapter.
   */
  registerProductionHostAdapter(
    adapter: unknown,
    captureScope: FigPluginProductionPlanScopeResolver
  ) {
    return this.hostAdapterSessions.register(adapter, captureScope)
  }

  unregisterProductionHostAdapter(
    instanceEpoch: unknown,
    adapter?: Parameters<FigPluginProductionHostAdapterSessions['unregister']>[1]
  ): boolean {
    return this.hostAdapterSessions.unregister(instanceEpoch, adapter)
  }

  listProductionHostAdapters() {
    return this.hostAdapterSessions.list()
  }

  private imageGenerationOwner(parent: BrowserWindow): object {
    const generation = this.documentGenerations.get(parent) ?? 0
    const documentUrl = parent.webContents.getURL()
    let owner = this.imageGenerationOwners.get(parent)
    if (!owner || owner.generation !== generation || owner.documentUrl !== documentUrl) {
      owner = { generation, documentUrl, token: {} }
      this.imageGenerationOwners.set(parent, owner)
    }
    return owner.token
  }

  private getImageGeneration(): FigPluginImageGenerationCoordinator {
    if (this.imageGeneration) return this.imageGeneration
    const coordinator = new FigPluginImageGenerationCoordinator({
      makeModel: this.makeImageGenerationModel,
      materialize: this.materializeGeneratedImage,
      configuredProfile: async (key) => {
        const managed = figPluginManagedListSchema.parse(await this.store.listManaged())
        const matches = managed.items.filter((item) => item.pluginId === key.pluginId)
        const item = matches[0]
        if (
          matches.length !== 1 ||
          !item ||
          item.materialization !== 'verified-package' ||
          !item.configured ||
          item.cleanupPending ||
          !item.capabilities.includes('asset-transfer') ||
          !item.settings.imageGenerationProfileId
        )
          throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
        return item.settings.imageGenerationProfileId
      }
    })
    const unsubscribe = this.store.onRuntimeInvalidated((pluginId) =>
      coordinator.cancelPlugin(pluginId)
    )
    if (typeof unsubscribe !== 'function') {
      void coordinator.dispose()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    activeImageGenerations.set(coordinator, unsubscribe)
    this.imageGeneration = coordinator
    return coordinator
  }

  private nativeImageBridge(): BridgeControl & NativeImageGenerationControl {
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    const methods: (keyof NativeImageGenerationControl)[] = [
      'nativeImageGenerationProposals',
      'claimNativeImageGeneration',
      'isNativeImageGenerationCurrent',
      'validateNativeImageGeneration',
      'observeNativeImageGeneration',
      'finishNativeImageGeneration',
      'cancelNativeImageGeneration'
    ]
    if (methods.some((method) => typeof controller[method] !== 'function'))
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    return controller as BridgeControl & NativeImageGenerationControl
  }

  private authorizeManagement(
    method: keyof FigPluginCenterSvc,
    invocation?: ServiceInvocationContext
  ): BrowserWindow {
    try {
      if (
        !invocation ||
        invocation.methodName !== `svcFigPluginCenter.${method}` ||
        !Number.isSafeInteger(invocation.senderId)
      )
        throw new Error()
      authorizeTrustedDesktopRenderer(invocation)
      const parent = this.getMainWindow()
      if (
        !parent ||
        parent.isDestroyed() ||
        parent.webContents.isDestroyed() ||
        parent.webContents.id !== invocation.senderId
      )
        throw new Error()
      const url = parent.webContents.getURL()
      authorizeTrustedDesktopRenderer({ ...invocation, senderUrl: url, frameUrl: url })
      if (new URL(url).hash.split('?')[0] !== '#/workshop/plugins') throw new Error()
      this.watchWindow(parent)
      return parent
    } catch {
      throw new FigPluginManagementError('PERMISSION_DENIED')
    }
  }

  private prunePreviews(): void {
    for (const [id, item] of this.previews) {
      if (
        item.expiresAt <= Date.now() ||
        item.window.isDestroyed() ||
        item.window.webContents.isDestroyed() ||
        item.window.webContents.getURL() !== item.documentUrl
      )
        this.previews.delete(id)
    }
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending) throw new FigPluginManagementError('BUSY')
    this.pending = true
    try {
      return await work()
    } catch (error) {
      throw sanitizedManagementError(error)
    } finally {
      this.pending = false
    }
  }

  listPackages = async (
    req: Record<string, never>,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginManagedList> => {
    parseFigPluginManagementValue(figPluginManagementEmptyRequestSchema, req)
    this.authorizeManagement('listPackages', invocation)
    try {
      const result = await this.store.listManaged()
      this.authorizeManagement('listPackages', invocation)
      return result
    } catch (error) {
      throw sanitizedManagementError(error)
    }
  }

  listSavedCheckpoints = async (
    req: Record<string, never>,
    invocation?: ServiceInvocationContext
  ): Promise<SavedTaskCheckpoint[]> => {
    parseFigPluginManagementValue(figPluginManagementEmptyRequestSchema, req)
    this.authorizeManagement('listSavedCheckpoints', invocation)
    try {
      // Read retained data only: do not create a Bridge, session or write permission.
      return savedTaskCheckpointsSchema.parse(this.getCheckpointSummaries())
    } catch (error) {
      throw sanitizedManagementError(error)
    }
  }

  executionHistory = async (
    req: FigPluginExecutionHistoryRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginExecutionHistory> => {
    const request = parseFigPluginManagementValue(figPluginExecutionHistoryRequestSchema, req)
    const parent = this.authorizeManagement('executionHistory', invocation)
    const url = parent.webContents.getURL()
    const generation = this.documentGenerations.get(parent)
    try {
      // History must work without pairing, constructing a Bridge, or starting a Provider.
      const audit = this.getAuditStore()
      const records = await audit.list()
      if (
        this.authorizeManagement('executionHistory', invocation) !== parent ||
        parent.webContents.getURL() !== url ||
        this.documentGenerations.get(parent) !== generation
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      const matching = records
        .filter(
          (record) =>
            (request.pluginId === undefined || record.pluginId === request.pluginId) &&
            (request.projectId === undefined || record.projectId === request.projectId) &&
            (request.correlationId === undefined ||
              record.correlationId === request.correlationId) &&
            (request.runId === undefined || record.runId === request.runId)
        )
        .slice()
        .sort(compareExecutionHistory)
      const limit = request.limit ?? 50
      return figPluginExecutionHistorySchema.parse({
        records: matching.slice(0, limit),
        truncated: matching.length > limit,
        recordedAt: Date.now(),
        retentionMs: FIGPLUGIN_AUDIT_TTL_MS,
        maxRecords: FIGPLUGIN_AUDIT_MAX_RECORDS,
        maxBytes: FIGPLUGIN_AUDIT_MAX_BYTES,
        writeFailed: audit.writeFailed
      })
    } catch (error) {
      throw sanitizedManagementError(error)
    }
  }

  planningHistory = async (
    req: FigPluginPlanningHistoryRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginPlanningHistory> => {
    const request = parseFigPluginManagementValue(figPluginPlanningHistoryRequestSchema, req)
    const parent = this.authorizeManagement('planningHistory', invocation)
    const url = parent.webContents.getURL()
    const generation = this.documentGenerations.get(parent)
    try {
      // Persisted observation only: no Bridge, session, provider or retry authority is created.
      const audit = this.getPlanningAuditStore()
      const records = await audit.list()
      if (
        this.authorizeManagement('planningHistory', invocation) !== parent ||
        parent.webContents.getURL() !== url ||
        this.documentGenerations.get(parent) !== generation
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      const matching = records
        .filter(
          (record) =>
            (request.pluginId === undefined || record.pluginId === request.pluginId) &&
            (request.projectId === undefined || record.projectId === request.projectId) &&
            (request.callId === undefined || record.callId === request.callId) &&
            (request.correlationId === undefined || record.correlationId === request.correlationId)
        )
        .slice()
        .sort(comparePlanningHistory)
      const limit = request.limit ?? 50
      return figPluginPlanningHistorySchema.parse({
        records: matching.slice(0, limit),
        truncated: matching.length > limit,
        recordedAt: Date.now(),
        retentionMs: FIGPLUGIN_AUDIT_TTL_MS,
        maxRecords: FIGPLUGIN_AUDIT_MAX_RECORDS,
        maxBytes: FIGPLUGIN_AUDIT_MAX_BYTES,
        writeFailed: audit.writeFailed
      })
    } catch (error) {
      throw sanitizedManagementError(error)
    }
  }

  choosePackage = async (
    req: Record<string, never>,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginPackagePreview | null> => {
    parseFigPluginManagementValue(figPluginManagementEmptyRequestSchema, req)
    const parent = this.authorizeManagement('choosePackage', invocation)
    return this.exclusive(async () => {
      this.prunePreviews()
      if (this.previews.size >= MAX_PREVIEWS) throw new FigPluginManagementError('BUSY')
      const documentUrl = parent.webContents.getURL()
      const documentGeneration = this.documentGenerations.get(parent)
      let stopped = false
      const check = () => {
        if (stopped) throw new FigPluginManagementError('TIMEOUT')
        if (
          this.authorizeManagement('choosePackage', invocation) !== parent ||
          parent.webContents.getURL() !== documentUrl ||
          this.documentGenerations.get(parent) !== documentGeneration
        )
          throw new FigPluginManagementError('PERMISSION_DENIED')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stopped = true
          reject(new FigPluginManagementError('TIMEOUT'))
        }, CHOOSER_TIMEOUT_MS)
        timer.unref()
      })
      const selectAndVerify = async () => {
        const selection = await dialog.showOpenDialog(parent, {
          title: 'Choose a signed FIGPLUGIN package (files will not run)',
          properties: ['openFile'],
          filters: [{ name: 'FIGPLUGIN package', extensions: ['figplugin', 'json'] }]
        })
        check()
        if (selection.canceled) return null
        if (selection.filePaths.length !== 1) throw new FigPluginManagementError('INVALID_PACKAGE')
        const keySelection = await dialog.showOpenDialog(parent, {
          title: 'Choose the Ed25519 PUBLIC key obtained from the package publisher',
          properties: ['openFile'],
          filters: [{ name: 'Public key', extensions: ['pem', 'pub'] }]
        })
        check()
        if (keySelection.canceled) return null
        if (keySelection.filePaths.length !== 1)
          throw new FigPluginManagementError('INVALID_SIGNER')
        const key = await readSelectedPublicKey(keySelection.filePaths[0], check)
        check()
        const verified = await readAndVerifyFigPluginPackageFile(selection.filePaths[0], key)
        check()
        verifyNativePluginManifest(verified.package)
        check()
        const generation = await this.store.getManagedGeneration(verified.package.manifest.id)
        check()
        const receiptId = randomBytes(24).toString('hex')
        const expiresAt = Date.now() + PREVIEW_TTL_MS
        const manifest = verified.package.manifest
        const result = figPluginPackagePreviewSchema.parse({
          receiptId,
          expiresAt,
          pluginId: manifest.id,
          name: manifest.name,
          version: manifest.version,
          host: manifest.host,
          expectedGeneration: generation,
          capabilities: manifest.capabilities,
          signerFingerprint: verified.keyFingerprint,
          artifactSha256: verified.artifactSha256,
          ...(manifest.bridge ? { bridgeOrigin: manifest.bridge.origin } : {}),
          fileCount: verified.files.length,
          contentBytes: verified.files.reduce((total, file) => total + file.data.byteLength, 0),
          signatureVerified: true,
          publisherTrusted: false,
          executesInDesktop: false
        })
        this.previews.set(receiptId, {
          senderId: parent.webContents.id,
          window: parent,
          documentUrl,
          documentGeneration: documentGeneration ?? 0,
          expiresAt,
          verified,
          generation
        })
        return result
      }
      try {
        return await Promise.race([selectAndVerify(), timeout])
      } finally {
        stopped = true
        if (timer) clearTimeout(timer)
      }
    })
  }

  installPackage = async (
    req: FigPluginPackageInstallRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginManagedMutation> => {
    const request = parseFigPluginManagementValue(figPluginPackageInstallRequestSchema, req)
    const parent = this.authorizeManagement('installPackage', invocation)
    return this.exclusive(async () => {
      this.prunePreviews()
      const item = this.previews.get(request.receiptId)
      if (
        !item ||
        item.window !== parent ||
        item.senderId !== parent.webContents.id ||
        item.documentUrl !== parent.webContents.getURL()
      )
        throw new FigPluginManagementError('STALE_PREVIEW')
      if (item.generation !== request.expectedGeneration)
        throw new FigPluginManagementError('CONFIGURATION_CHANGED')
      const manifest = item.verified.package.manifest
      const confirmed = await this.confirm(parent, {
        type: 'warning',
        title: 'Install verified plugin files',
        message: `${manifest.name} ${manifest.version} (${manifest.host})`,
        detail: `Signer SHA-256: ${item.verified.keyFingerprint}\nPackage SHA-256: ${item.verified.artifactSha256}\nCapabilities: ${manifest.capabilities.join(', ')}\nVerify this fingerprint independently with the publisher. A valid signature does not prove the publisher is official or the code is safe. This installs only a managed copy; nothing runs in MagicPot. Importing it into a host may execute code there.`,
        buttons: ['Install this exact package', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        checkboxLabel: 'I have verified the signer fingerprint and approve this exact package',
        checkboxChecked: false,
        noLink: true
      })
      if (confirmed.response !== 0 || !confirmed.checkboxChecked)
        return { completed: false, generation: request.expectedGeneration, cleanupPending: false }
      if (
        this.authorizeManagement('installPackage', invocation) !== parent ||
        parent.webContents.getURL() !== item.documentUrl ||
        this.documentGenerations.get(parent) !== item.documentGeneration ||
        item.expiresAt <= Date.now() ||
        this.previews.get(request.receiptId) !== item
      )
        throw new FigPluginManagementError('STALE_PREVIEW')
      return this.store.installVerifiedPackage(
        item.verified,
        request.expectedGeneration,
        request.idempotencyKey
      )
    })
  }

  configurePackage = async (
    req: FigPluginManagedConfigureRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginManagedMutation> => {
    const request = parseFigPluginManagementValue(figPluginManagedConfigureRequestSchema, req)
    this.authorizeManagement('configurePackage', invocation)
    return this.exclusive(() => this.store.configureManaged(request))
  }

  removePackage = async (
    req: FigPluginManagedRemoveRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginManagedMutation> => {
    const request = parseFigPluginManagementValue(figPluginManagedRemoveRequestSchema, req)
    const parent = this.authorizeManagement('removePackage', invocation)
    const documentUrl = parent.webContents.getURL()
    const documentGeneration = this.documentGenerations.get(parent)
    return this.exclusive(async () => {
      const current = (await this.store.listManaged()).items.find(
        (item) => item.pluginId === request.pluginId
      )
      if (current && current.generation !== request.expectedGeneration)
        throw new FigPluginManagementError('CONFIGURATION_CHANGED')
      if (
        this.authorizeManagement('removePackage', invocation) !== parent ||
        parent.webContents.getURL() !== documentUrl ||
        this.documentGenerations.get(parent) !== documentGeneration
      )
        throw new FigPluginManagementError('PERMISSION_DENIED')
      const confirmed = await this.confirm(parent, {
        type: 'warning',
        title: 'Remove managed plugin files',
        message: current
          ? `${current.name} ${current.version} (${current.host})`
          : request.pluginId,
        detail:
          'Only the MagicPot-managed copy is removed. Copies imported or installed by a host are not deleted. Existing projects and model configuration are not removed.',
        buttons: ['Remove managed copy', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      if (confirmed.response !== 0)
        return { completed: false, generation: request.expectedGeneration, cleanupPending: false }
      if (
        this.authorizeManagement('removePackage', invocation) !== parent ||
        parent.webContents.getURL() !== documentUrl ||
        this.documentGenerations.get(parent) !== documentGeneration
      )
        throw new FigPluginManagementError('PERMISSION_DENIED')
      return this.store.removeManaged(request)
    })
  }

  copyPackagePath = async (
    req: FigPluginManagedTarget,
    invocation?: ServiceInvocationContext
  ): Promise<{ completed: boolean }> => {
    const request = parseFigPluginManagementValue(figPluginManagedTargetSchema, req)
    const parent = this.authorizeManagement('copyPackagePath', invocation)
    return this.exclusive(async () => {
      const entry = await this.store.getOwnedEntryPath(request)
      if (this.authorizeManagement('copyPackagePath', invocation) !== parent)
        throw new FigPluginManagementError('PERMISSION_DENIED')
      clipboard.writeText(entry)
      return { completed: true }
    })
  }

  revealPackage = async (
    req: FigPluginManagedTarget,
    invocation?: ServiceInvocationContext
  ): Promise<{ completed: boolean }> => {
    const request = parseFigPluginManagementValue(figPluginManagedTargetSchema, req)
    const parent = this.authorizeManagement('revealPackage', invocation)
    return this.exclusive(async () => {
      const entry = await this.store.getOwnedEntryPath(request)
      if (this.authorizeManagement('revealPackage', invocation) !== parent)
        throw new FigPluginManagementError('PERMISSION_DENIED')
      shell.showItemInFolder(entry)
      return { completed: true }
    })
  }

  discardPreview = async (
    req: { receiptId: string },
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const parent = this.authorizeManagement('discardPreview', invocation)
    if (
      !req ||
      typeof req.receiptId !== 'string' ||
      !/^[a-f0-9]{48}$/.test(req.receiptId) ||
      Object.keys(req).length !== 1
    )
      throw new FigPluginManagementError('STALE_PREVIEW')
    const item = this.previews.get(req.receiptId)
    if (item?.senderId === parent.webContents.id) this.previews.delete(req.receiptId)
  }

  createPairing = async (
    req: FigPluginDesktopPairRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginDesktopPairTicket | null> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopPairRequestSchema, req)
    const parent = this.authorizeManagement('createPairing', invocation)
    const epoch = this.documentGenerations.get(parent)
    const documentUrl = parent.webContents.getURL()
    const operation = { pluginId: request.pluginId, revoked: false }
    return this.exclusive(async () => {
      // This operation identity exists before asynchronous controller construction. A revoke
      // must not be lost just because the authority has not finished being created yet.
      this.pairingOperation = operation
      const controller = await this.getBridge()
      const check = () => {
        if (
          this.authorizeManagement('createPairing', invocation) !== parent ||
          parent.webContents.getURL() !== documentUrl ||
          this.documentGenerations.get(parent) !== epoch ||
          this.bridge !== controller ||
          operation.revoked
        )
          throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      }
      check()
      const binding = await controller.resolveBinding(
        { pluginId: request.pluginId, expectedGeneration: request.expectedGeneration },
        request.projectId
      )
      check()
      const approval = await this.confirm(parent, {
        type: 'warning',
        title: 'Pair a local plugin session',
        message: `${binding.pluginId} (${binding.host})`,
        detail: `Local bridge: ${binding.bridgeOrigin}\nProject scope: ${binding.projectId}\nModel reference: ${binding.profileId}\nSigner fingerprint: ${binding.signerFingerprint}\nPackage SHA-256: ${binding.artifactSha256}\nA one-use ticket expires in two minutes; sessions expire after ten minutes or two minutes idle. Keep this desktop page open. Anyone holding the ticket can impersonate this plugin: pairing does not prove native host identity. Each model request still needs separate desktop approval; no document writes are allowed.`,
        buttons: ['Create one-use ticket', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel:
          'I approve this exact package, model reference and project scope for a temporary local session',
        checkboxChecked: false
      })
      if (approval.response !== 0 || !approval.checkboxChecked) return null
      check()
      const ticket = await controller.createPairing(binding)
      try {
        check()
        return ticket
      } catch (error) {
        controller.revokePlugin(binding.pluginId)
        throw error
      }
    }).finally(() => {
      if (this.pairingOperation === operation) this.pairingOperation = undefined
    })
  }

  bridgeState = async (
    req: Record<string, never>,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginBridgeDesktopState> => {
    parseFigPluginManagementValue(figPluginManagementEmptyRequestSchema, req)
    this.authorizeManagement('bridgeState', invocation)
    return this.bridge?.desktopState() ?? { sessions: [], previews: [] }
  }

  chooseSessionAsset = async (
    req: FigPluginDesktopAssetTarget,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginSessionAsset | null> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopAssetTargetSchema, req)
    return this.shareSessionAsset(
      request,
      'chooseSessionAsset',
      invocation,
      async (parent, options) => {
        const chosen = await dialog.showOpenDialog(parent, {
          title: `Choose one image for a temporary local plugin preview (up to ${options.maxBytes} bytes)`,
          properties: ['openFile'],
          filters: [{ name: 'Static raster image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        })
        options.check()
        if (chosen.canceled) return null
        if (chosen.filePaths.length !== 1) throw new FigPluginBridgeError('INVALID_REQUEST')
        return this.materializeAsset(chosen.filePaths[0], options)
      }
    )
  }

  chooseManagedSessionAsset = async (
    req: FigPluginDesktopManagedAssetRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginSessionAsset | null> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopManagedAssetRequestSchema, req)
    const reference = Object.freeze({ ...request.source.reference })
    const target = parseFigPluginBridgeValue(figPluginDesktopAssetTargetSchema, {
      sessionId: request.sessionId,
      pluginId: request.pluginId,
      projectId: request.projectId
    })
    return this.shareSessionAsset(
      target,
      'chooseManagedSessionAsset',
      invocation,
      async (_parent, options) => {
        if (reference.sizeBytes > options.maxBytes)
          throw new FigPluginBridgeError('INVALID_REQUEST')
        const materialized = await this.materializeManagedAsset(reference, options)
        try {
          options.check()
          if (
            materialized.sha256 !== reference.sha256 ||
            materialized.bytes.byteLength !== reference.sizeBytes ||
            materialized.mimeType !== reference.mimeType
          )
            throw new FigPluginBridgeError('INVALID_REQUEST')
          return materialized
        } catch (error) {
          materialized.bytes.fill(0)
          throw error
        }
      }
    )
  }

  private async shareSessionAsset(
    request: FigPluginDesktopAssetTarget,
    method: 'chooseSessionAsset' | 'chooseManagedSessionAsset',
    invocation: ServiceInvocationContext | undefined,
    load: (
      parent: BrowserWindow,
      options: Parameters<SessionAssetMaterializer>[1]
    ) => Promise<MaterializedSessionAsset | null>
  ): Promise<FigPluginSessionAsset | null> {
    const parent = this.authorizeManagement(method, invocation)
    const documentUrl = parent.webContents.getURL()
    const generation = this.documentGenerations.get(parent)
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    const operation = { pluginId: request.pluginId, sessionId: request.sessionId, revoked: false }
    return this.exclusive(async () => {
      this.assetSelectionOperation = operation
      let stopped = false
      let retained: Uint8Array | undefined
      const abort = new AbortController()
      const check = () => {
        if (stopped) throw new FigPluginBridgeError('TIMEOUT')
        if (
          this.authorizeManagement(method, invocation) !== parent ||
          parent.webContents.getURL() !== documentUrl ||
          this.documentGenerations.get(parent) !== generation ||
          this.bridge !== controller ||
          operation.revoked
        )
          throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stopped = true
          abort.abort()
          reject(new FigPluginBridgeError('TIMEOUT'))
        }, FIGPLUGIN_ASSET_TTL_MS)
        timer.unref()
      })
      const selectAndPublish = async () => {
        check()
        // Capture the existing session/package/project binding before any user dialog.
        const selection = await controller.beginSessionAssetSelection(request)
        check()
        if (!Number.isSafeInteger(selection.maxBytes) || selection.maxBytes < 1)
          throw new FigPluginBridgeError('INVALID_REQUEST')
        const materialized = await load(parent, {
          check,
          signal: abort.signal,
          maxBytes: selection.maxBytes
        })
        if (!materialized) return null
        retained = materialized.bytes
        check()
        if (materialized.bytes.byteLength > selection.maxBytes)
          throw new FigPluginBridgeError('INVALID_REQUEST')
        const approval = await this.confirm(parent, {
          type: 'warning',
          title: 'Share exact image bytes for a local plugin preview',
          message: `${selection.target.pluginId} (${selection.host})`,
          detail: `Plugin: ${selection.target.pluginId} (${selection.host})\nProject: ${selection.target.projectId}\nSession: ${selection.target.sessionId}\nPurpose: local-preview only\n${method === 'chooseManagedSessionAsset' ? 'Source: existing app-managed original image. Its reference identifies content, not authorization; the generating task and source project are not attested.\n' : ''}Image: ${materialized.mimeType}, ${materialized.width} x ${materialized.height}, ${materialized.bytes.byteLength} bytes\nSigned plugin image limit: ${selection.maxBytes} bytes\nImage SHA-256: ${materialized.sha256}\nBinding SHA-256: ${selection.bindingSha256}\nThese exact original bytes will be available only to this temporary local plugin session for at most two minutes. Original file contents include any embedded metadata (such as EXIF, location and color profiles); no metadata is stripped. No model upload and no document-write permission. The source file is not modified. A copy already read by the plugin cannot be recalled.${method === 'chooseManagedSessionAsset' ? ' This grant is a separate temporary byte snapshot; deleting the source does not recall the published copy. Revoke the session asset to stop future reads.' : ''}`,
          buttons: ['Share exact bytes for local preview', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          checkboxLabel:
            'I approve this exact image hash, plugin and project for local preview only, with no model upload or document write',
          checkboxChecked: false
        })
        check()
        if (approval.response !== 0 || !approval.checkboxChecked) return null
        const published = await controller.publishSessionAsset(selection, {
          mimeType: materialized.mimeType,
          width: materialized.width,
          height: materialized.height,
          bytes: materialized.bytes
        })
        try {
          check()
          const asset = parseFigPluginBridgeValue(figPluginSessionAssetSchema, published)
          if (
            asset.sessionId !== request.sessionId ||
            asset.pluginId !== request.pluginId ||
            asset.projectId !== request.projectId ||
            asset.host !== selection.host ||
            asset.sha256 !== materialized.sha256 ||
            asset.sizeBytes !== materialized.bytes.byteLength ||
            asset.mimeType !== materialized.mimeType ||
            asset.width !== materialized.width ||
            asset.height !== materialized.height ||
            asset.expiresAt <= Date.now()
          )
            throw new FigPluginBridgeError('INVALID_REQUEST')
          return asset
        } catch (error) {
          // A publication that completes after navigation, revocation or timeout is not
          // authority to restore the old page. Remove its new grant before rejecting.
          await controller.revokeSessionAsset({
            ...request,
            assetId: published.assetId,
            sha256: published.sha256
          })
          throw error
        }
      }
      try {
        return await Promise.race([selectAndPublish().finally(() => retained?.fill(0)), timeout])
      } finally {
        stopped = true
        abort.abort()
        retained?.fill(0)
        if (timer) clearTimeout(timer)
        if (this.assetSelectionOperation === operation) this.assetSelectionOperation = undefined
      }
    })
  }

  generateSessionImage = async (
    req: FigPluginImageGenerationRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginImageGenerationOutput | null> => {
    const request = parseFigPluginBridgeValue(figPluginImageGenerationRequestSchema, req)
    return this.generateImageForDesktop(request, 'generateSessionImage', invocation)
  }

  nativeImageGenerationProposals = async (
    req: Record<string, never>,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginNativeImageGenerationDesktopState> => {
    parseFigPluginManagementValue(figPluginManagementEmptyRequestSchema, req)
    this.authorizeManagement('nativeImageGenerationProposals', invocation)
    if (!this.bridge) return { proposals: [] }
    return parseFigPluginBridgeValue(figPluginNativeImageGenerationDesktopStateSchema, {
      proposals: this.nativeImageBridge().nativeImageGenerationProposals()
    })
  }

  approveNativeImageGeneration = async (
    req: FigPluginNativeImageGenerationDesktopKey,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginImageGenerationOutput | null> => {
    const request = parseFigPluginBridgeValue(figPluginNativeImageGenerationDesktopKeySchema, req)
    const parent = this.authorizeManagement('approveNativeImageGeneration', invocation)
    const owner = this.imageGenerationOwner(parent)
    const controller = this.nativeImageBridge()
    let receipt: FigPluginNativeImageGenerationReceipt | undefined
    try {
      receipt = await controller.claimNativeImageGeneration(request)
      if (
        this.authorizeManagement('approveNativeImageGeneration', invocation) !== parent ||
        this.imageGenerationOwner(parent) !== owner ||
        this.bridge !== controller
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      return await this.generateImageForDesktop(
        receipt.request,
        'approveNativeImageGeneration',
        invocation,
        { controller, receipt }
      )
    } catch (error) {
      if (receipt)
        controller.finishNativeImageGeneration(receipt, {
          phase: receipt.signal.aborted ? 'cancelled' : 'failed',
          error: error instanceof FigPluginBridgeError ? error.code : 'UPSTREAM_FAILED'
        })
      throw sanitizedManagementError(error)
    }
  }

  cancelNativeImageGeneration = async (
    req: FigPluginNativeImageGenerationDesktopKey,
    invocation?: ServiceInvocationContext
  ): Promise<{ completed: boolean }> => {
    const request = parseFigPluginBridgeValue(figPluginNativeImageGenerationDesktopKeySchema, req)
    this.authorizeManagement('cancelNativeImageGeneration', invocation)
    if (!this.bridge) return { completed: false }
    this.nativeImageBridge().cancelNativeImageGeneration(request)
    return { completed: true }
  }

  private async generateImageForDesktop(
    request: FigPluginImageGenerationRequest,
    method: 'generateSessionImage' | 'approveNativeImageGeneration',
    invocation?: ServiceInvocationContext,
    native?: {
      controller: BridgeControl & NativeImageGenerationControl
      receipt: FigPluginNativeImageGenerationReceipt
    }
  ): Promise<FigPluginImageGenerationOutput | null> {
    const parent = this.authorizeManagement(method, invocation)
    const documentUrl = parent.webContents.getURL()
    const generation = this.documentGenerations.get(parent)
    const owner = this.imageGenerationOwner(parent)
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    if (native && native.controller !== controller)
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    if (
      typeof controller.validateSessionAssetSelection !== 'function' ||
      typeof controller.isSessionAssetSelectionCurrent !== 'function'
    )
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    try {
      const session = controller
        .desktopState()
        .sessions.find(
          (item) =>
            item.sessionId === request.sessionId &&
            item.pluginId === request.pluginId &&
            item.projectId === request.projectId
        )
      if (!session || session.expiresAt <= Date.now()) throw new FigPluginBridgeError('EXPIRED')
      const check = () => {
        if (
          this.authorizeManagement(method, invocation) !== parent ||
          parent.webContents.getURL() !== documentUrl ||
          this.documentGenerations.get(parent) !== generation ||
          this.imageGenerationOwner(parent) !== owner ||
          this.bridge !== controller ||
          (native &&
            (native.receipt.signal.aborted ||
              !native.controller.isNativeImageGenerationCurrent(native.receipt)))
        )
          throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      }
      const coordinator = this.getImageGeneration()
      const abort = () => coordinator.cancel(request, owner)
      const detach = () => native?.receipt.signal.removeEventListener('abort', abort)
      native?.receipt.signal.addEventListener('abort', abort, { once: true })
      try {
        check()
        return await coordinator.generate(request, {
          owner,
          check,
          sessionExpiresAt: session.expiresAt,
          ...(native
            ? {
                deadlineAt: native.receipt.expiresAt,
                onState: (state: Readonly<FigPluginImageGenerationState>) => {
                  try {
                    native.controller.observeNativeImageGeneration(native.receipt, state)
                  } finally {
                    if (['accepted', 'declined', 'cancelled', 'failed'].includes(state.phase))
                      detach()
                  }
                }
              }
            : {}),
          capture: () =>
            controller.beginSessionAssetSelection({
              sessionId: request.sessionId,
              pluginId: request.pluginId,
              projectId: request.projectId
            }),
          isCurrent: (selection) => controller.isSessionAssetSelectionCurrent!(selection),
          validate: async (selection) => {
            await controller.validateSessionAssetSelection!(selection)
            if (native) await native.controller.validateNativeImageGeneration(native.receipt)
          },
          confirm: async (preview, signal) => {
            check()
            // Match the existing built-in client: Responses generation uses a fixed
            // mainline model, with a GPT-Image name on its sole image-generation tool.
            const wireModels =
              preview.apiMode === 'responses'
                ? `Responses mainline model: gpt-5.4\nImage-generation tool model: ${/^gpt-image-/i.test(preview.modelName.trim()) ? preview.modelName.trim() : 'provider default (configured label is not an image-tool override)'}`
                : `Images API model: ${preview.modelName}`
            const approval = await this.confirm(parent, {
              type: 'warning',
              title: 'Generate one image with the configured model',
              message: `${preview.pluginId} (${preview.selection.host}) → ${preview.profileId}`,
              detail: `Plugin: ${preview.pluginId} (${preview.selection.host})\nProject: ${preview.projectId}\nSession: ${preview.sessionId}\nRequest: ${preview.requestId}\nJob: ${preview.jobId}\n${native ? `Native proposal: ${native.receipt.proposalId}\nNative request: ${native.receipt.nativeRequestId}\nProposal SHA-256: ${native.receipt.payloadSha256}\n` : ''}Profile: ${preview.profileId}\nProvider: ${preview.provider}\nConfigured model label: ${preview.modelName}\nAPI route: ${preview.apiMode}\n${wireModels}\nProfile revision: ${preview.profileRevision}\nBinding SHA-256: ${preview.selection.bindingSha256}\nFixed generation options: ${JSON.stringify(FIGPLUGIN_IMAGE_GENERATION_OPTIONS)}\nSigned plugin image byte limit: ${preview.selection.maxBytes}\nAbsolute deadline: ${new Date(preview.expiresAt).toISOString()}\n\nExact text-only prompt:\n${preview.prompt}\n\nThis sends only this prompt using the displayed image route and may incur a charge. No reference images, history, browsing/function tools, caller model overrides or arbitrary endpoints are sent. Responses declares only its built-in image-generation tool. Exactly one bounded PNG/JPEG/WebP result is stored as app-managed media. If the provider returns an image URL, main may download it over public HTTPS with guarded DNS/redirect, size, type and deadline checks, without auth headers.\nDesktop must separately validate and accept this result. You must then separately choose/share the image for the local plugin preview, approve model metadata transmission, and approve any native document write. This generation approval does not grant those permissions. Cancellation cannot undo an already dispatched Provider charge.`,
              buttons: ['Generate this image once', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
              checkboxLabel:
                'I approve sending this exact prompt to this configured image model once, without image sharing or document-write permission',
              checkboxChecked: false,
              signal
            })
            check()
            return approval.response === 0 && approval.checkboxChecked
          }
        })
      } catch (error) {
        detach()
        throw error
      }
    } catch (error) {
      throw sanitizedManagementError(error)
    }
  }

  sessionImageGenerationState = async (
    req: FigPluginImageGenerationKey,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginImageGenerationState | null> => {
    const request = parseFigPluginBridgeValue(figPluginImageGenerationKeySchema, req)
    const parent = this.authorizeManagement('sessionImageGenerationState', invocation)
    return this.imageGeneration?.state(request, this.imageGenerationOwner(parent)) ?? null
  }

  cancelSessionImageGeneration = async (
    req: FigPluginImageGenerationKey,
    invocation?: ServiceInvocationContext
  ): Promise<{ completed: boolean }> => {
    const request = parseFigPluginBridgeValue(figPluginImageGenerationKeySchema, req)
    const parent = this.authorizeManagement('cancelSessionImageGeneration', invocation)
    // Independent of the native chooser lane and the pending Provider promise.
    return {
      completed: this.imageGeneration?.cancel(request, this.imageGenerationOwner(parent)) ?? false
    }
  }

  acceptSessionImageGeneration = async (
    req: FigPluginImageGenerationAccept,
    invocation?: ServiceInvocationContext
  ): Promise<{ completed: boolean }> => {
    const request = parseFigPluginBridgeValue(figPluginImageGenerationAcceptSchema, req)
    const parent = this.authorizeManagement('acceptSessionImageGeneration', invocation)
    return {
      completed:
        (await this.imageGeneration?.accept(request, this.imageGenerationOwner(parent))) ?? false
    }
  }

  sessionAssets = async (
    req: FigPluginDesktopAssetTarget,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginAssetList> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopAssetTargetSchema, req)
    const parent = this.authorizeManagement('sessionAssets', invocation)
    const documentUrl = parent.webContents.getURL()
    const generation = this.documentGenerations.get(parent)
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    try {
      const catalog = await controller.listSessionAssets(request)
      if (
        this.authorizeManagement('sessionAssets', invocation) !== parent ||
        parent.webContents.getURL() !== documentUrl ||
        this.documentGenerations.get(parent) !== generation ||
        this.bridge !== controller
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      const result = parseFigPluginBridgeValue(figPluginAssetListSchema, catalog)
      if (
        result.sessionId !== request.sessionId ||
        result.assets.some(
          (asset) => asset.pluginId !== request.pluginId || asset.projectId !== request.projectId
        )
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return result
    } catch (error) {
      throw sanitizedManagementError(error)
    }
  }

  revokeSessionAsset = async (
    req: FigPluginDesktopAssetRevoke,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopAssetRevokeSchema, req)
    const parent = this.authorizeManagement('revokeSessionAsset', invocation)
    const documentUrl = parent.webContents.getURL()
    const generation = this.documentGenerations.get(parent)
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    try {
      // Revocation has no exclusive chooser lane so it remains reachable during consent.
      if (this.assetSelectionOperation?.sessionId === request.sessionId)
        this.assetSelectionOperation.revoked = true
      await controller.revokeSessionAsset(request)
      if (
        this.authorizeManagement('revokeSessionAsset', invocation) !== parent ||
        parent.webContents.getURL() !== documentUrl ||
        this.documentGenerations.get(parent) !== generation ||
        this.bridge !== controller
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    } catch (error) {
      throw sanitizedManagementError(error)
    }
  }

  planState = async (
    req: Record<string, never>,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginExecutionDesktopState> => {
    parseFigPluginManagementValue(figPluginManagementEmptyRequestSchema, req)
    this.authorizeManagement('planState', invocation)
    return (
      this.bridge?.planState() ?? {
        previews: [],
        statuses: [],
        baselines: [],
        correctionAuthorizations: []
      }
    )
  }

  approveBridge = async (
    req: FigPluginDesktopApproval,
    invocation?: ServiceInvocationContext
  ): Promise<{ completed: boolean }> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopApprovalSchema, req)
    const parent = this.authorizeManagement('approveBridge', invocation)
    const epoch = this.documentGenerations.get(parent)
    const documentUrl = parent.webContents.getURL()
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    const check = () => {
      if (
        this.authorizeManagement('approveBridge', invocation) !== parent ||
        parent.webContents.getURL() !== documentUrl ||
        this.documentGenerations.get(parent) !== epoch ||
        this.bridge !== controller
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    return this.exclusive(async () => {
      check()
      const preview = controller
        .desktopState()
        .previews.find(
          (item) => item.callId === request.callId && item.payloadSha256 === request.payloadSha256
        )
      if (!preview) throw new FigPluginBridgeError('EXPIRED')
      const approval = await this.confirm(parent, {
        type: 'warning',
        title: 'Approve one plugin model request',
        message: `${preview.pluginId} → ${preview.profileId}`,
        detail: buildBridgeApprovalDetails(preview),
        buttons: ['Approve and send once', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel:
          'I reviewed this exact content and authorize its transmission to the bound model',
        checkboxChecked: false
      })
      if (approval.response !== 0 || !approval.checkboxChecked) return { completed: false }
      check()
      await controller.approve(request.callId, request.payloadSha256)
      return { completed: true }
    })
  }

  approvePlanExecution = async (
    req: FigPluginDesktopExecutionApproval,
    invocation?: ServiceInvocationContext
  ): Promise<{ completed: boolean }> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopExecutionApprovalSchema, req)
    const parent = this.authorizeManagement('approvePlanExecution', invocation)
    const epoch = this.documentGenerations.get(parent)
    const documentUrl = parent.webContents.getURL()
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    const check = () => {
      if (
        this.authorizeManagement('approvePlanExecution', invocation) !== parent ||
        parent.webContents.getURL() !== documentUrl ||
        this.documentGenerations.get(parent) !== epoch ||
        this.bridge !== controller
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    return this.exclusive(async () => {
      check()
      const preview = controller
        .planState()
        .previews.find(
          (item) =>
            item.executionId === request.executionId &&
            item.planSha256 === request.planSha256 &&
            item.state === 'awaiting-approval'
        )
      if (!preview) throw new FigPluginBridgeError('EXPIRED')
      const approval = await this.confirm(parent, {
        type: 'warning',
        title: preview.recovery?.rebind?.document
          ? 'Restore into a reopened Photoshop document'
          : preview.recovery
            ? 'Restore accepted task properties'
            : preview.visualCorrection
              ? 'Approve one visual correction write'
              : 'Approve one native document write',
        message: `${preview.pluginId} (${preview.host})`,
        detail: buildPlanExecutionApprovalDetails(preview),
        buttons: [
          preview.recovery
            ? 'Restore these exact task properties once'
            : preview.visualCorrection
              ? 'Approve this correction plan once'
              : 'Approve this exact plan once',
          'Cancel'
        ],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel: preview.recovery?.rebind?.document
          ? 'I verified the original PSD and the old/new document IDs, and authorize restoring only the displayed unchanged layer IDs once'
          : preview.recovery?.rebind
            ? 'I verified the current host document and selected objects, choose this saved checkpoint for the new plugin instance, and authorize these exact changes once'
            : preview.visualCorrection
              ? 'I reviewed this correction round, its exact targets and changes, and authorize one native host write'
              : 'I reviewed the exact document changes and authorize one native host write',
        checkboxChecked: false
      })
      if (approval.response !== 0 || !approval.checkboxChecked) return { completed: false }
      check()
      if (preview.recovery?.rebind)
        await controller.approvePlanExecution(request.executionId, request.planSha256, true)
      else await controller.approvePlanExecution(request.executionId, request.planSha256)
      return { completed: true }
    })
  }

  acceptVisualBaseline = async (
    req: FigPluginDesktopVisualBaselineAcceptance,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginVisualBaseline | null> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopVisualBaselineAcceptanceSchema, req)
    const parent = this.authorizeManagement('acceptVisualBaseline', invocation)
    const epoch = this.documentGenerations.get(parent)
    const documentUrl = parent.webContents.getURL()
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    const check = () => {
      if (
        this.authorizeManagement('acceptVisualBaseline', invocation) !== parent ||
        parent.webContents.getURL() !== documentUrl ||
        this.documentGenerations.get(parent) !== epoch ||
        this.bridge !== controller
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    return this.exclusive(async () => {
      check()
      const state = controller.planState()
      const preview = state.previews.find(
        (item) =>
          item.executionId === request.executionId &&
          item.state === 'completed' &&
          item.visualAudit === 'hash-only' &&
          item.visualCorrection === undefined &&
          item.recovery === undefined
      )
      const status = state.statuses.find(
        (item) =>
          item.executionId === request.executionId &&
          item.state === 'completed' &&
          item.effect === 'applied' &&
          item.visualEvidenceSha256 === request.visualEvidenceSha256 &&
          item.visualEvidence !== undefined
      )
      if (!preview || !status) throw new FigPluginBridgeError('EXPIRED')
      const existing = state.baselines.find(
        (item) => item.sourceExecutionId === request.executionId
      )
      if (existing) {
        if (existing.visualEvidenceSha256 !== request.visualEvidenceSha256)
          throw new FigPluginBridgeError('EXPIRED')
        return existing
      }
      const approval = await this.confirm(parent, {
        type: 'warning',
        title: 'Accept a bounded visual checkpoint',
        message: `${preview.pluginId} (${preview.host})`,
        detail: buildVisualBaselineApprovalDetails(preview, status),
        buttons: ['Accept this exact checkpoint', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel: preview.executionAssets
          ? 'I reviewed this exact result and approve local encrypted retention of its original image files, accepted placement or fill mode, and task properties for up to 24 hours'
          : 'I reviewed this exact result and approve local encrypted retention of its task properties for up to 24 hours',
        checkboxChecked: false
      })
      if (approval.response !== 0 || !approval.checkboxChecked) return null
      check()
      return controller.acceptVisualBaseline(request.executionId, request.visualEvidenceSha256)
    })
  }

  authorizeVisualCorrection = async (
    req: FigPluginDesktopVisualCorrectionAuthorizationRequest,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginVisualCorrectionAuthorization | null> => {
    const request = parseFigPluginBridgeValue(
      figPluginDesktopVisualCorrectionAuthorizationRequestSchema,
      req
    )
    const parent = this.authorizeManagement('authorizeVisualCorrection', invocation)
    const epoch = this.documentGenerations.get(parent)
    const documentUrl = parent.webContents.getURL()
    const controller = this.bridge
    if (!controller) throw new FigPluginBridgeError('EXPIRED')
    const check = () => {
      if (
        this.authorizeManagement('authorizeVisualCorrection', invocation) !== parent ||
        parent.webContents.getURL() !== documentUrl ||
        this.documentGenerations.get(parent) !== epoch ||
        this.bridge !== controller
      )
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    return this.exclusive(async () => {
      check()
      const state = controller.planState()
      const preview = state.previews.find(
        (item) =>
          item.executionId === request.executionId &&
          item.state === 'completed' &&
          item.visualAudit === 'hash-only' &&
          item.executionAssets === undefined
      )
      const status = state.statuses.find(
        (item) =>
          item.executionId === request.executionId &&
          item.state === 'completed' &&
          item.effect === 'applied' &&
          item.visualEvidenceSha256 === request.visualEvidenceSha256 &&
          item.visualEvidence !== undefined &&
          item.visualBaselineComparison?.baselineId === request.baselineId &&
          item.visualBaselineComparison.visualEvidenceSha256 === request.visualEvidenceSha256 &&
          item.visualBaselineComparison.exactMatch === false &&
          item.visualBaselineComparison.changedCount > 0
      )
      const baseline = state.baselines.find(
        (item) =>
          item.baselineId === request.baselineId &&
          item.expiresAt > Date.now() &&
          item.visualEvidenceSha256 === status?.visualBaselineComparison?.baselineEvidenceSha256
      )
      if (!preview || !status || !baseline) throw new FigPluginBridgeError('EXPIRED')
      const existing = state.correctionAuthorizations.find(
        (item) => item.baselineId === request.baselineId && item.expiresAt > Date.now()
      )
      if (existing) {
        if (
          existing.sourceExecutionId !== request.executionId ||
          existing.visualEvidenceSha256 !== request.visualEvidenceSha256
        )
          throw new FigPluginBridgeError('BUSY')
        return existing
      }
      const approval = await this.confirm(parent, {
        type: 'warning',
        title: 'Authorize one correction round',
        message: `${preview.pluginId} (${preview.host})`,
        detail: buildVisualCorrectionAuthorizationDetails(preview, status, baseline),
        buttons: ['Authorize exact targets', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel:
          'I understand this only authorizes one future correction attempt and does not modify the document now',
        checkboxChecked: false
      })
      if (approval.response !== 0 || !approval.checkboxChecked) return null
      check()
      return controller.authorizeVisualCorrection(
        request.executionId,
        request.baselineId,
        request.visualEvidenceSha256
      )
    })
  }

  cancelVisualCorrectionAuthorization = async (
    req: FigPluginDesktopVisualCorrectionAuthorization,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const request = parseFigPluginBridgeValue(
      figPluginDesktopVisualCorrectionAuthorizationSchema,
      req
    )
    this.authorizeManagement('cancelVisualCorrectionAuthorization', invocation)
    this.bridge?.cancelVisualCorrectionAuthorization(request.authorizationId)
  }

  denyPlanExecution = async (
    req: FigPluginDesktopExecution,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopExecutionSchema, req)
    this.authorizeManagement('denyPlanExecution', invocation)
    this.bridge?.denyPlanExecution(request.executionId)
  }

  cancelPlanExecution = async (
    req: FigPluginDesktopExecution,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopExecutionSchema, req)
    this.authorizeManagement('cancelPlanExecution', invocation)
    this.bridge?.cancelPlanExecution(request.executionId)
  }

  denyBridge = async (
    req: { callId: string },
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const request = parseFigPluginBridgeValue(figPluginDesktopCallSchema, req)
    this.authorizeManagement('denyBridge', invocation)
    this.bridge?.deny(request.callId)
  }

  revokeBridge = async (
    req: { pluginId: string },
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const request = parseFigPluginManagementValue(
      figPluginManagedTargetSchema.pick({ pluginId: true }),
      req
    )
    this.authorizeManagement('revokeBridge', invocation)
    if (this.pairingOperation?.pluginId === request.pluginId) {
      this.pairingOperation.revoked = true
    }
    if (this.assetSelectionOperation?.pluginId === request.pluginId) {
      this.assetSelectionOperation.revoked = true
    }
    this.imageGeneration?.cancelPlugin(request.pluginId)
    this.bridge?.revokePlugin(request.pluginId)
    if (!this.bridge && this.makeBridge === createProductionBridge) {
      try {
        checkpointStore().removeWhere((record) => record.binding.pluginId === request.pluginId)
      } catch {
        throw new FigPluginBridgeError('UPSTREAM_FAILED')
      }
    }
  }

  execute = async (
    operation: FigPluginCenterOperation,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginCenterResponse> => {
    // IPC supplies this context from Electron, never from the request payload. Reuse the
    // main window's registered sender, exact renderer URL, and live main-frame binding.
    // As with existing core services, direct main-process calls have no IPC context.
    if (invocation) {
      try {
        if (invocation.methodName !== 'svcFigPluginCenter.execute') throw new Error('denied')
        authorizeTrustedDesktopRenderer(invocation)
      } catch {
        throw new ServiceError('FIGPLUGIN center access is not trusted for this renderer.', {
          code: 'PERMISSION_DENIED'
        })
      }
    }
    return this.store.execute(operation)
  }
}
