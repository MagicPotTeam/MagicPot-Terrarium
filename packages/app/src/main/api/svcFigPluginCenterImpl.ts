import {
  buildBridgeApprovalDetails,
  buildPlanExecutionApprovalDetails
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
import { FigPluginExecutionAuditStore } from '../figplugin/executionAudit'
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
  type FigPluginDesktopExecution,
  type FigPluginDesktopExecutionApproval,
  type FigPluginExecutionDesktopState
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

const PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEWS = 4
const CHOOSER_TIMEOUT_MS = 5 * 60_000
type BridgeControl = Pick<
  FigPluginBridgeController,
  | 'resolveBinding'
  | 'createPairing'
  | 'desktopState'
  | 'approve'
  | 'deny'
  | 'revokePlugin'
  | 'planState'
  | 'approvePlanExecution'
  | 'denyPlanExecution'
  | 'cancelPlanExecution'
  | 'dispose'
>
const activeBridges = new Set<BridgeControl>()
let bridgeShutdownEpoch = 0
export async function disposeFigPluginBridges(): Promise<void> {
  bridgeShutdownEpoch++
  const controllers = [...activeBridges]
  activeBridges.clear()
  await Promise.all(controllers.map((controller) => controller.dispose().catch(() => undefined)))
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

export class FigPluginCenterSvcImpl implements FigPluginCenterSvc {
  private readonly previews = new Map<string, PackagePreview>()
  private pending = false
  private readonly watchedWindows = new WeakSet<BrowserWindow>()
  private readonly documentGenerations = new WeakMap<BrowserWindow, number>()
  private bridge?: BridgeControl
  private bridgePending?: Promise<BridgeControl>
  private bridgeEpoch = 0
  private pairingOperation?: { pluginId: string; revoked: boolean }

  private stopBridge(): void {
    this.bridgeEpoch++
    const controller = this.bridge
    this.bridge = undefined
    this.bridgePending = undefined
    if (controller) {
      activeBridges.delete(controller)
      void controller.dispose().catch(() => undefined)
    }
  }

  private async getBridge(): Promise<BridgeControl> {
    if (this.bridge) return this.bridge
    if (this.bridgePending) return this.bridgePending
    const epoch = this.bridgeEpoch
    const shutdownEpoch = bridgeShutdownEpoch
    const pending = this.makeBridge(this.store).then(async (controller) => {
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
    private readonly makeBridge: (store: FigPluginCenterStore) => Promise<BridgeControl> = async (
      store
    ) => {
      const { LLMProxySvcImpl } = await import('./svcLLMProxyImpl')
      const audit = new FigPluginExecutionAuditStore(
        path.join(app.getPath('userData'), 'figplugin-center')
      )
      return new FigPluginBridgeController(store, new LLMProxySvcImpl(), {
        audit: (event) => audit.record(event)
      })
    }
  ) {}

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

  planState = async (
    req: Record<string, never>,
    invocation?: ServiceInvocationContext
  ): Promise<FigPluginExecutionDesktopState> => {
    parseFigPluginManagementValue(figPluginManagementEmptyRequestSchema, req)
    this.authorizeManagement('planState', invocation)
    return this.bridge?.planState() ?? { previews: [], statuses: [] }
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
        title: 'Approve one native document write',
        message: `${preview.pluginId} (${preview.host})`,
        detail: buildPlanExecutionApprovalDetails(preview),
        buttons: ['Approve this exact plan once', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel: 'I reviewed the exact document changes and authorize one native host write',
        checkboxChecked: false
      })
      if (approval.response !== 0 || !approval.checkboxChecked) return { completed: false }
      check()
      await controller.approvePlanExecution(request.executionId, request.planSha256)
      return { completed: true }
    })
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
    this.bridge?.revokePlugin(request.pluginId)
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
