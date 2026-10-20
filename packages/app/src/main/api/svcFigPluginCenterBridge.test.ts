import { EventEmitter, once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import type { LLMChatResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  figPluginBridgeDesktopStateSchema,
  figPluginBridgePrepareResponseSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginDesktopPairTicketSchema,
  figPluginPairResponseSchema,
  type FigPluginBridgePrepareRequest,
  type FigPluginDesktopApproval,
  type FigPluginDesktopPairRequest,
  type FigPluginDesktopPairTicket,
  type FigPluginPairResponse
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
  figPluginExecutionClaimResponseSchema,
  figPluginExecutionDesktopStateSchema,
  figPluginExecutionResultResponseSchema,
  figPluginExecutionStatusSchema,
  type FigPluginDesktopExecutionApproval,
  type FigPluginDesktopVisualBaselineAcceptance
} from '@shared/figplugin/execution'
import { createHostPlanReadback, type HostContext, type HostPlan } from '@shared/figplugin/hostPlan'
import { FIGPLUGIN_MANAGEMENT_ERRORS } from '@shared/figplugin/management'
import { FigPluginBridgeController } from '../figplugin/bridgeController'
import { startFigPluginBridgeServer } from '../figplugin/bridgeServer'
import type { FigPluginRuntimeDescriptor } from '../figplugin/centerStore'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { disposeFigPluginBridges, FigPluginCenterSvcImpl } from './svcFigPluginCenterImpl'

const native = vi.hoisted(() => ({
  getPath: vi.fn(),
  showMessageBox:
    vi.fn<(parent: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(),
  showOpenDialog: vi.fn(),
  writeText: vi.fn(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
  openExternal: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: native.getPath },
  dialog: { showMessageBox: native.showMessageBox, showOpenDialog: native.showOpenDialog },
  clipboard: { writeText: native.writeText },
  shell: {
    showItemInFolder: native.showItemInFolder,
    openPath: native.openPath,
    openExternal: native.openExternal
  }
}))

type BridgeMethod =
  | 'createPairing'
  | 'bridgeState'
  | 'approveBridge'
  | 'denyBridge'
  | 'revokeBridge'
  | 'planState'
  | 'approvePlanExecution'
  | 'acceptVisualBaseline'
  | 'denyPlanExecution'
  | 'cancelPlanExecution'
type Store = ConstructorParameters<typeof FigPluginBridgeController>[0]
type Model = ConstructorParameters<typeof FigPluginBridgeController>[1]
type Runtime = Parameters<typeof startFigPluginBridgeServer>[0]['runtime']
type Server = Awaited<ReturnType<typeof startFigPluginBridgeServer>>
const TRUSTED_URL = 'file:///app/index.html#/workshop/plugins'
const PROFILE_REVISION = 'd'.repeat(64)
const UNKNOWN_CALL = 'e'.repeat(32)
const UNKNOWN_HASH = 'f'.repeat(64)
const approved: MessageBoxReturnValue = { response: 0, checkboxChecked: true }
const cancelled: MessageBoxReturnValue = { response: 1, checkboxChecked: false }
const pairRequest: FigPluginDesktopPairRequest = {
  pluginId: 'synthetic.figma',
  expectedGeneration: 7,
  projectId: 'synthetic_project'
}
const modelResult: LLMChatResp = {
  content: 'Synthetic read-only design analysis.',
  finishReason: 'stop',
  usage: { totalTokens: 27 }
}
const errors = { ...FIGPLUGIN_MANAGEMENT_ERRORS, ...FIGPLUGIN_BRIDGE_ERRORS }
const controllers: FigPluginBridgeController[] = []
const network = vi.fn(() => {
  throw new Error('Provider/external fetch is forbidden in this synthetic fixture')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => TRUSTED_URL)
    })
  }
}

function registerWindow(window: ReturnType<typeof makeWindow>): void {
  registerMagicAgentTrustedRouteBinding(window.webContents.id, undefined, {
    trustedUrl: TRUSTED_URL,
    trustedWebContents: window.webContents
  })
}

function invocation(
  method: BridgeMethod,
  overrides: Partial<ServiceInvocationContext> = {}
): ServiceInvocationContext {
  return {
    methodName: `svcFigPluginCenter.${method}`,
    senderId: 42,
    senderUrl: TRUSTED_URL,
    frameUrl: TRUSTED_URL,
    isMainFrame: true,
    ...overrides
  }
}

// Stub boundaries: native modal/window, verified-store descriptor and model metadata/inference.
// These are not installed-package verification, a real Electron window, or native-host attestation.
// Controller, runtime, schemas and trusted-route authorization are the product implementations.
function fixture(options: { origin?: string; realHttp?: boolean } = {}) {
  const descriptor: FigPluginRuntimeDescriptor = {
    pluginId: pairRequest.pluginId,
    host: 'figma',
    generation: pairRequest.expectedGeneration,
    artifactSha256: 'a'.repeat(64),
    signerFingerprint: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64),
    bridgeOrigin: options.origin ?? 'http://127.0.0.1:41234',
    profileId: 'synthetic-provider::synthetic-model',
    capabilities: ['dialogue', 'asset-transfer', 'result-transfer'],
    limits: {
      maxPayloadBytes: 64 * 1024,
      maxResultBytes: 32 * 1024,
      maxConfigBytes: 1024,
      maxCallTimeoutMs: 30_000,
      maxConcurrentCalls: 1
    }
  }
  const invalidations = new Set<(pluginId: string) => void>()
  const profileChanges = new Set<() => void>()
  const unsubscribeStore = vi.fn()
  const unsubscribeProfiles = vi.fn()
  const store = {
    getRuntimeDescriptor: vi
      .fn<Store['getRuntimeDescriptor']>()
      .mockImplementation(async () => structuredClone(descriptor)),
    onRuntimeInvalidated: vi.fn<Store['onRuntimeInvalidated']>().mockImplementation((listener) => {
      invalidations.add(listener)
      unsubscribeStore.mockImplementation(() => invalidations.delete(listener))
      return unsubscribeStore
    })
  }
  const chatStarted = deferred<void>()
  const model = {
    listProfiles: vi.fn<LLMProxySvc['listProfiles']>().mockResolvedValue({
      profiles: [
        {
          id: descriptor.profileId,
          model_name: 'Synthetic model',
          model_use: 'chat',
          configurationRevision: PROFILE_REVISION,
          context_budget_tokens: 8192
        }
      ]
    }),
    chat: vi.fn<LLMProxySvc['chat']>().mockImplementation(async () => {
      chatStarted.resolve()
      return structuredClone(modelResult)
    }),
    cancelConversation: vi
      .fn<LLMProxySvc['cancelConversation']>()
      .mockResolvedValue({ cancelled: true }),
    isProfileRevisionCurrent: vi
      .fn<Model['isProfileRevisionCurrent']>()
      .mockImplementation(
        (id, revision) => id === descriptor.profileId && revision === PROFILE_REVISION
      ),
    onProfileConfigurationChanged: vi
      .fn<Model['onProfileConfigurationChanged']>()
      .mockImplementation((listener) => {
        profileChanges.add(listener)
        unsubscribeProfiles.mockImplementation(() => profileChanges.delete(listener))
        return unsubscribeProfiles
      })
  }
  let runtime!: Runtime
  const close = vi.fn<Server['close']>().mockResolvedValue(undefined)
  const startServer = vi
    .fn<typeof startFigPluginBridgeServer>()
    .mockImplementation(async (input) => {
      runtime = input.runtime
      if (options.realHttp) {
        const server = await startFigPluginBridgeServer(input)
        close.mockImplementation(server.close)
      }
      // Most tests stub only the listener, retaining the real runtime supplied by the controller.
      return { origin: input.origin, close }
    })
  const controller = new FigPluginBridgeController(store, model, { startServer })
  controllers.push(controller)
  const issueTicket = controller.createPairing.bind(controller)
  const pairing = vi.spyOn(controller, 'createPairing')
  const resolveBinding = vi.spyOn(controller, 'resolveBinding')
  const approve = vi.spyOn(controller, 'approve')
  const deny = vi.spyOn(controller, 'deny')
  const revoke = vi.spyOn(controller, 'revokePlugin')
  const dispose = vi.spyOn(controller, 'dispose')
  const factory = vi.fn().mockResolvedValue(controller)
  const window = makeWindow()
  let mainWindow: ReturnType<typeof makeWindow> | null = window
  registerWindow(window)
  const service = new FigPluginCenterSvcImpl(
    store as unknown as ConstructorParameters<typeof FigPluginCenterSvcImpl>[0],
    () => mainWindow as unknown as BrowserWindow | null,
    factory
  )
  return {
    service,
    controller,
    descriptor,
    store,
    model,
    window,
    factory,
    startServer,
    close,
    pairing,
    issueTicket,
    resolveBinding,
    approve,
    deny,
    revoke,
    dispose,
    unsubscribeStore,
    unsubscribeProfiles,
    chatStarted,
    get runtime() {
      return runtime
    },
    setWindow(value: ReturnType<typeof makeWindow> | null) {
      mainWindow = value
    },
    changeProfiles() {
      for (const listener of profileChanges) listener()
    }
  }
}
type Fixture = ReturnType<typeof fixture>

function holdModal() {
  const opened = deferred<MessageBoxOptions>()
  const result = deferred<MessageBoxReturnValue>()
  native.showMessageBox.mockImplementationOnce(async (_parent, options) => {
    opened.resolve(options)
    return result.promise
  })
  return { opened: opened.promise, resolve: result.resolve }
}

function expectDefaultCancel(options: MessageBoxOptions): void {
  expect(options).toMatchObject({
    type: 'warning',
    defaultId: 1,
    cancelId: 1,
    checkboxChecked: false,
    noLink: true,
    buttons: [expect.any(String), 'Cancel'],
    checkboxLabel: expect.any(String)
  })
}

async function rejectsSafely(work: Promise<unknown>, code: keyof typeof errors): Promise<void> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ServiceError)
  expect(JSON.parse(JSON.stringify(error))).toEqual({ code, message: errors[code] })
  expect(error).toMatchObject({ cause: undefined, payload: undefined })
}

const envelope = (ticket: FigPluginDesktopPairTicket) => ({
  protocol: 1 as const,
  ticketId: ticket.ticketId,
  pairingSecret: ticket.pairingSecret,
  pluginId: ticket.pluginId,
  host: ticket.host,
  artifactSha256: ticket.artifactSha256,
  clientNonce: '0'.repeat(32)
})
const request = (sequence = 1): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  requestId: `synthetic_request_${sequence}`,
  sequence,
  prompt: 'Describe this synthetic selection without modifying it.',
  context: {
    nodes: [{ id: '1:2', type: 'FRAME', name: 'Synthetic untrusted label', locked: false }],
    selectionRevision: 'synthetic-selection-1',
    documentLabel: 'Synthetic fixture, not a user document'
  }
})
const executionContext: HostContext = {
  version: 1,
  host: 'figma',
  documentId: 'synthetic-execution-document',
  scopeId: 'synthetic-execution-page',
  captureId: '4'.repeat(32),
  nodes: [
    {
      id: '1:2',
      type: 'FRAME',
      name: 'Synthetic untrusted label',
      parentId: null,
      ancestors: [],
      locked: false,
      visible: true,
      opacity: 1,
      commands: ['node.rename'],
      children: []
    }
  ],
  selectedIds: ['1:2'],
  execution: {
    mode: 'native-write',
    adapterVersion: 'synthetic-figma-adapter-1',
    supports: ['node.rename'],
    rollback: 'verified-in-place',
    visualAudit: 'unavailable'
  }
}
const visualExecutionContext: HostContext = {
  ...structuredClone(executionContext),
  execution: { ...executionContext.execution!, visualAudit: 'hash-only' }
}
const executionPlan: HostPlan = {
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: executionContext.captureId,
  steps: [{ command: 'node.rename', targetId: '1:2', name: 'Synthetic approved label' }]
}
const executionRequest = (sequence = 1): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  requestId: `synthetic_execution_request_${sequence}`,
  sequence,
  prompt: 'Rename the selected layer to the approved synthetic label.',
  context: {
    selectionRevision: executionContext.captureId,
    nodes: [
      {
        id: '1:2',
        type: 'FRAME',
        name: 'Synthetic untrusted label',
        locked: false
      }
    ],
    documentLabel: 'Synthetic fixture, not a user document'
  },
  featureId: 'plan-preview',
  hostContext: structuredClone(executionContext)
})
const visualExecutionRequest = (sequence = 1): FigPluginBridgePrepareRequest => ({
  ...executionRequest(sequence),
  requestId: `synthetic_visual_execution_request_${sequence}`,
  hostContext: structuredClone(visualExecutionContext)
})
const executedContext = (context: HostContext = executionContext): HostContext => ({
  ...structuredClone(context),
  nodes: context.nodes.map((node) => ({
    ...structuredClone(node),
    name: 'Synthetic approved label'
  }))
})
const visualEvidence = [
  {
    targetId: '1:2',
    before: { sha256: '1'.repeat(64), width: 64, height: 32 },
    after: { sha256: '2'.repeat(64), width: 64, height: 32 },
    changed: true
  }
]
const desktopState = (value: Fixture) => value.service.bridgeState({}, invocation('bridgeState'))
const planDesktopState = (value: Fixture) => value.service.planState({}, invocation('planState'))
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

async function ticketFor(value: Fixture): Promise<FigPluginDesktopPairTicket> {
  native.showMessageBox.mockResolvedValueOnce(approved)
  return figPluginDesktopPairTicketSchema.parse(
    await value.service.createPairing(pairRequest, invocation('createPairing'))
  )
}

async function prepare(value: Fixture) {
  const ticket = await ticketFor(value)
  const session = await value.runtime.redeem(envelope(ticket))
  const prepared = await value.runtime.prepare(session.sessionId, session.sessionToken, request())
  const preview = (await desktopState(value)).previews.find(
    (item) => item.callId === prepared.callId
  )!
  expect(preview).toBeDefined()
  expect(value.model.chat).not.toHaveBeenCalled()
  return {
    ticket,
    session,
    preview,
    approval: { callId: preview.callId, payloadSha256: preview.payloadSha256 },
    status: () => value.runtime.status(session.sessionId, session.sessionToken, prepared.callId)
  }
}

const staleDocuments: Array<{
  name: string
  code: keyof typeof errors
  disposes: boolean
  change: (value: Fixture) => void
}> = [
  {
    name: 'route left the plugin page',
    code: 'PERMISSION_DENIED',
    disposes: false,
    change: (value) =>
      value.window.webContents.getURL.mockReturnValue('file:///app/index.html#/settings')
  },
  {
    name: 'same-route document URL changed',
    code: 'CONFIGURATION_CHANGED',
    disposes: false,
    change: (value) => value.window.webContents.getURL.mockReturnValue(`${TRUSTED_URL}?scope=other`)
  },
  {
    name: 'same-URL reload epoch changed',
    code: 'CONFIGURATION_CHANGED',
    disposes: true,
    change: (value) => {
      value.window.webContents.emit('did-start-navigation', {}, TRUSTED_URL, false, true)
    }
  },
  {
    name: 'navigation left and returned to the identical URL',
    code: 'CONFIGURATION_CHANGED',
    disposes: true,
    change: (value) => {
      value.window.webContents.getURL.mockReturnValue('file:///app/index.html#/settings')
      value.window.webContents.emit(
        'did-start-navigation',
        {},
        value.window.webContents.getURL(),
        true,
        true
      )
      value.window.webContents.getURL.mockReturnValue(TRUSTED_URL)
      value.window.webContents.emit('did-start-navigation', {}, TRUSTED_URL, true, true)
    }
  },
  {
    name: 'registered main window replaced',
    code: 'CONFIGURATION_CHANGED',
    disposes: false,
    change: (value) => {
      const replacement = makeWindow()
      registerWindow(replacement)
      value.setWindow(replacement)
    }
  }
]

beforeEach(() => {
  vi.resetAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  native.showMessageBox.mockResolvedValue(cancelled)
  native.getPath.mockImplementation(() => {
    throw new Error('App data is outside this fixture')
  })
  vi.stubGlobal('fetch', network)
})

afterEach(async () => {
  try {
    await disposeFigPluginBridges()
    await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
    expect(network).not.toHaveBeenCalled()
    for (const method of [
      native.getPath,
      native.showOpenDialog,
      native.writeText,
      native.showItemInFolder,
      native.openPath,
      native.openExternal
    ]) {
      expect(method).not.toHaveBeenCalled()
    }
  } finally {
    clearMagicAgentTrustedRouteBindingsForTest()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

describe('FigPluginCenterSvcImpl desktop authority and pairing consent', () => {
  const methods: Array<{
    name: BridgeMethod
    call: (value: Fixture, context?: ServiceInvocationContext) => Promise<unknown>
  }> = [
    { name: 'createPairing', call: (v, c) => v.service.createPairing(pairRequest, c) },
    { name: 'bridgeState', call: (v, c) => v.service.bridgeState({}, c) },
    {
      name: 'approveBridge',
      call: (v, c) =>
        v.service.approveBridge({ callId: UNKNOWN_CALL, payloadSha256: UNKNOWN_HASH }, c)
    },
    { name: 'denyBridge', call: (v, c) => v.service.denyBridge({ callId: UNKNOWN_CALL }, c) },
    {
      name: 'revokeBridge',
      call: (v, c) => v.service.revokeBridge({ pluginId: pairRequest.pluginId }, c)
    },
    { name: 'planState', call: (v, c) => v.service.planState({}, c) },
    {
      name: 'approvePlanExecution',
      call: (v, c) =>
        v.service.approvePlanExecution({ executionId: UNKNOWN_CALL, planSha256: UNKNOWN_HASH }, c)
    },
    {
      name: 'acceptVisualBaseline',
      call: (v, c) =>
        v.service.acceptVisualBaseline(
          { executionId: UNKNOWN_CALL, visualEvidenceSha256: UNKNOWN_HASH },
          c
        )
    },
    {
      name: 'denyPlanExecution',
      call: (v, c) => v.service.denyPlanExecution({ executionId: UNKNOWN_CALL }, c)
    },
    {
      name: 'cancelPlanExecution',
      call: (v, c) => v.service.cancelPlanExecution({ executionId: UNKNOWN_CALL }, c)
    }
  ]
  it.each(methods)(
    '$name rejects direct, host-like and unregistered authority before effects',
    async ({ name, call }) => {
      const value = fixture()
      await rejectsSafely(call(value), 'PERMISSION_DENIED')
      for (const override of [
        { senderId: 99 },
        { senderId: undefined },
        { methodName: 'svcOther.execute' },
        { isMainFrame: false },
        { isMainFrame: undefined },
        { frameUrl: 'https://www.figma.com/file/synthetic' },
        { frameUrl: 'file:///other/index.html#/workshop/plugins' },
        { senderUrl: 'https://host.invalid/', frameUrl: 'https://host.invalid/' }
      ]) {
        await rejectsSafely(call(value, invocation(name, override)), 'PERMISSION_DENIED')
      }
      value.window.webContents.getURL.mockReturnValue('file:///app/index.html#/settings')
      await rejectsSafely(call(value, invocation(name)), 'PERMISSION_DENIED')
      value.window.webContents.getURL.mockReturnValue(TRUSTED_URL)
      value.window.isDestroyed.mockReturnValue(true)
      await rejectsSafely(call(value, invocation(name)), 'PERMISSION_DENIED')
      value.window.isDestroyed.mockReturnValue(false)
      value.window.webContents.isDestroyed.mockReturnValue(true)
      await rejectsSafely(call(value, invocation(name)), 'PERMISSION_DENIED')
      value.window.webContents.isDestroyed.mockReturnValue(false)
      value.setWindow(null)
      await rejectsSafely(call(value, invocation(name)), 'PERMISSION_DENIED')
      value.setWindow(value.window)
      unregisterMagicAgentTrustedRouteBinding(42)
      await rejectsSafely(call(value, invocation(name)), 'PERMISSION_DENIED')
      expect(value.factory).not.toHaveBeenCalled()
      expect(value.store.getRuntimeDescriptor).not.toHaveBeenCalled()
      expect(value.model.listProfiles).not.toHaveBeenCalled()
      expect(value.model.chat).not.toHaveBeenCalled()
      expect(native.showMessageBox).not.toHaveBeenCalled()
      expect(value.startServer).not.toHaveBeenCalled()
      expect(value.approve).not.toHaveBeenCalled()
      expect(value.deny).not.toHaveBeenCalled()
      expect(value.revoke).not.toHaveBeenCalled()
    }
  )

  it('strictly rejects renderer-supplied model, secret and approval authority fields', async () => {
    const value = fixture()
    for (const extra of [
      { profileId: 'host::override' },
      { pairingSecret: UNKNOWN_HASH },
      { checkboxChecked: true }
    ]) {
      await rejectsSafely(
        value.service.createPairing({ ...pairRequest, ...extra }, invocation('createPairing')),
        'INVALID_REQUEST'
      )
    }
    await rejectsSafely(
      value.service.approveBridge(
        {
          callId: UNKNOWN_CALL,
          payloadSha256: UNKNOWN_HASH,
          checkboxChecked: true
        } as FigPluginDesktopApproval,
        invocation('approveBridge')
      ),
      'INVALID_REQUEST'
    )
    await rejectsSafely(
      value.service.denyBridge(
        { callId: UNKNOWN_CALL, sessionToken: UNKNOWN_HASH } as { callId: string },
        invocation('denyBridge')
      ),
      'INVALID_REQUEST'
    )
    await rejectsSafely(
      value.service.approvePlanExecution(
        {
          executionId: UNKNOWN_CALL,
          planSha256: UNKNOWN_HASH,
          checkboxChecked: true
        } as FigPluginDesktopExecutionApproval,
        invocation('approvePlanExecution')
      ),
      'INVALID_REQUEST'
    )
    await rejectsSafely(
      value.service.acceptVisualBaseline(
        {
          executionId: UNKNOWN_CALL,
          visualEvidenceSha256: UNKNOWN_HASH,
          checkboxChecked: true
        } as FigPluginDesktopVisualBaselineAcceptance,
        invocation('acceptVisualBaseline')
      ),
      'INVALID_REQUEST'
    )
    await rejectsSafely(
      value.service.denyPlanExecution(
        { executionId: UNKNOWN_CALL, approved: true } as { executionId: string },
        invocation('denyPlanExecution')
      ),
      'INVALID_REQUEST'
    )
    await rejectsSafely(
      value.service.cancelPlanExecution(
        { executionId: UNKNOWN_CALL, evidence: 'forged' } as { executionId: string },
        invocation('cancelPlanExecution')
      ),
      'INVALID_REQUEST'
    )
    await expect(
      value.service.bridgeState(
        { sessionToken: UNKNOWN_HASH } as unknown as Record<string, never>,
        invocation('bridgeState')
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    await expect(
      value.service.planState(
        { executionId: UNKNOWN_CALL } as unknown as Record<string, never>,
        invocation('planState')
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    await expect(
      value.service.revokeBridge(
        { pluginId: pairRequest.pluginId, approved: true } as { pluginId: string },
        invocation('revokeBridge')
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    expect(value.factory).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(value.model.chat).not.toHaveBeenCalled()
  })

  it('state and harmless absent-bridge cancellation never initialize a bridge or prompt', async () => {
    const value = fixture()
    expect(await desktopState(value)).toEqual({ sessions: [], previews: [] })
    expect(await planDesktopState(value)).toEqual({ previews: [], statuses: [], baselines: [] })
    await value.service.denyBridge({ callId: UNKNOWN_CALL }, invocation('denyBridge'))
    await value.service.revokeBridge({ pluginId: pairRequest.pluginId }, invocation('revokeBridge'))
    await rejectsSafely(
      value.service.approveBridge(
        { callId: UNKNOWN_CALL, payloadSha256: UNKNOWN_HASH },
        invocation('approveBridge')
      ),
      'EXPIRED'
    )
    expect(value.factory).not.toHaveBeenCalled()
    expect(value.model.listProfiles).not.toHaveBeenCalled()
    expect(value.model.chat).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
  })

  it.each([
    cancelled,
    { response: 1, checkboxChecked: true },
    { response: 0, checkboxChecked: false }
  ])('pairing needs both native acceptance and checkbox: %j', async (answer) => {
    const value = fixture()
    native.showMessageBox.mockResolvedValueOnce(answer)
    expect(await value.service.createPairing(pairRequest, invocation('createPairing'))).toBeNull()
    const [parent, options] = native.showMessageBox.mock.calls[0]
    expect(parent).toBe(value.window)
    expectDefaultCancel(options)
    expect(options.detail).toContain('pairing does not prove native host identity')
    expect(options.detail).toContain('Each model request still needs separate desktop approval')
    expect(value.model.listProfiles).toHaveBeenCalledWith({ includeConfigurationRevision: true })
    expect(value.pairing).not.toHaveBeenCalled()
    expect(value.startServer).not.toHaveBeenCalled()
    expect(value.model.chat).not.toHaveBeenCalled()
  })

  it('binds native consent to the parsed request and main-owned exact package/model revision', async () => {
    const value = fixture()
    const modal = holdModal()
    const input = structuredClone(pairRequest)
    const pending = value.service.createPairing(input, invocation('createPairing'))
    const options = await modal.opened
    expect(value.resolveBinding).toHaveBeenCalledExactlyOnceWith(
      { pluginId: pairRequest.pluginId, expectedGeneration: pairRequest.expectedGeneration },
      pairRequest.projectId
    )
    for (const reviewed of [
      pairRequest.projectId,
      value.descriptor.profileId,
      value.descriptor.artifactSha256,
      value.descriptor.signerFingerprint,
      value.descriptor.bridgeOrigin
    ]) {
      expect(options.detail).toContain(reviewed)
    }
    input.projectId = 'changed_after_invocation'
    input.pluginId = 'other.plugin'
    input.expectedGeneration++
    expect(value.pairing).not.toHaveBeenCalled()
    expect(value.model.chat).not.toHaveBeenCalled()
    modal.resolve(approved)
    const ticket = figPluginDesktopPairTicketSchema.parse(await pending)
    const { limits: _limits, capabilities: _capabilities, ...identity } = value.descriptor
    expect(value.pairing).toHaveBeenCalledExactlyOnceWith({
      ...identity,
      projectId: pairRequest.projectId,
      profileRevision: PROFILE_REVISION
    })
    const session = await value.runtime.redeem(envelope(ticket))
    expect((await desktopState(value)).sessions).toEqual([
      {
        sessionId: session.sessionId,
        pluginId: pairRequest.pluginId,
        host: 'figma',
        projectId: pairRequest.projectId,
        expiresAt: session.expiresAt,
        activeCalls: 0
      }
    ])
    expect(value.model.chat).not.toHaveBeenCalled()
  })

  it.each(staleDocuments)(
    'rejects pairing while modal is open: $name',
    async ({ change, code, disposes }) => {
      const value = fixture()
      const modal = holdModal()
      const rejected = rejectsSafely(
        value.service.createPairing(pairRequest, invocation('createPairing')),
        code
      )
      await modal.opened
      change(value)
      modal.resolve(approved)
      await rejected
      expect(value.pairing).not.toHaveBeenCalled()
      expect(value.startServer).not.toHaveBeenCalled()
      expect(value.model.chat).not.toHaveBeenCalled()
      if (disposes) expect(value.dispose).toHaveBeenCalledTimes(1)
    }
  )

  it.each(staleDocuments)(
    'revokes a late real ticket without delivering its secret: $name',
    async ({ change, code, disposes }) => {
      const value = fixture()
      const issued = deferred<FigPluginDesktopPairTicket>()
      const release = deferred<void>()
      // Gate only delivery of the real runtime ticket, not ticket creation or revocation.
      value.pairing.mockImplementationOnce(async (binding) => {
        const ticket = await value.issueTicket(binding)
        issued.resolve(ticket)
        await release.promise
        return ticket
      })
      native.showMessageBox.mockResolvedValueOnce(approved)
      const rejected = rejectsSafely(
        value.service.createPairing(pairRequest, invocation('createPairing')),
        code
      )
      const ticket = await issued.promise
      change(value)
      release.resolve()
      await rejected
      expect(value.revoke).toHaveBeenCalledExactlyOnceWith(pairRequest.pluginId)
      await rejectsSafely(value.runtime.redeem(envelope(ticket)), 'UNAUTHORIZED')
      expect(value.model.chat).not.toHaveBeenCalled()
      if (disposes) expect(value.dispose).toHaveBeenCalledTimes(1)
    }
  )

  it('remembers same-plugin revocation before the asynchronous controller exists', async () => {
    const value = fixture()
    const gate = deferred<FigPluginBridgeController>()
    value.factory.mockReturnValueOnce(gate.promise)
    const pairing = value.service
      .createPairing(pairRequest, invocation('createPairing'))
      .catch((error: unknown) => error)
    expect(value.factory).toHaveBeenCalledTimes(1)
    await value.service.revokeBridge({ pluginId: pairRequest.pluginId }, invocation('revokeBridge'))
    gate.resolve(value.controller)
    expect(await pairing).toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    expect(value.resolveBinding).not.toHaveBeenCalled()
    expect(value.model.listProfiles).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(value.startServer).not.toHaveBeenCalled()
    expect(value.pairing).not.toHaveBeenCalled()
    // Explicitly starting over is allowed; a revoked operation does not poison its replacement.
    expect(await ticketFor(value)).toHaveProperty('ticketId')
  })

  it('does not revoke another plugin during asynchronous controller construction', async () => {
    const value = fixture()
    const gate = deferred<FigPluginBridgeController>()
    value.factory.mockReturnValueOnce(gate.promise)
    native.showMessageBox.mockResolvedValueOnce(approved)
    const pairing = value.service.createPairing(pairRequest, invocation('createPairing'))
    await value.service.revokeBridge({ pluginId: 'other.plugin' }, invocation('revokeBridge'))
    gate.resolve(value.controller)
    expect(await pairing).toHaveProperty('ticketId')
    expect(native.showMessageBox).toHaveBeenCalledTimes(1)
    expect(value.model.chat).not.toHaveBeenCalled()
  })

  it.each(['reload', 'shutdown'] as const)(
    'disposes an asynchronously constructed controller after %s',
    async (reason) => {
      const value = fixture()
      const gate = deferred<FigPluginBridgeController>()
      value.factory.mockReturnValueOnce(gate.promise)
      const rejected = rejectsSafely(
        value.service.createPairing(pairRequest, invocation('createPairing')),
        'CONFIGURATION_CHANGED'
      )
      expect(value.factory).toHaveBeenCalledTimes(1)
      if (reason === 'reload')
        value.window.webContents.emit('did-start-navigation', {}, TRUSTED_URL, false, true)
      else await disposeFigPluginBridges()
      gate.resolve(value.controller)
      await rejected
      expect(value.dispose).toHaveBeenCalledTimes(1)
      expect(value.unsubscribeStore).toHaveBeenCalledTimes(1)
      expect(value.unsubscribeProfiles).toHaveBeenCalledTimes(1)
      expect(value.model.listProfiles).not.toHaveBeenCalled()
      expect(value.model.chat).not.toHaveBeenCalled()
      expect(native.showMessageBox).not.toHaveBeenCalled()
    }
  )
})

describe('FigPluginCenterSvcImpl per-request native approval and cancellation', () => {
  it('exposes only schema-bounded session summaries and detached previews, never bearer secrets', async () => {
    const value = fixture()
    const prepared = await prepare(value)
    const state = await desktopState(value)
    expect(figPluginBridgeDesktopStateSchema.parse(state)).toEqual(state)
    for (const secret of [
      prepared.ticket.pairingSecret,
      prepared.session.sessionToken,
      prepared.ticket.ticketId
    ]) {
      expect(JSON.stringify(state)).not.toContain(secret)
    }
    expect(state.previews[0]).toMatchObject({
      context: request().context,
      prompt: request().prompt,
      projectId: pairRequest.projectId,
      profileId: value.descriptor.profileId,
      profileRevision: PROFILE_REVISION
    })
    state.previews[0].prompt = 'tampered renderer preview'
    state.previews[0].context.nodes[0].name = 'tampered renderer label'
    expect((await desktopState(value)).previews).toEqual([prepared.preview])
    expect(value.model.chat).not.toHaveBeenCalled()
  })

  it('requires the exact call ID and payload hash before even opening native confirmation', async () => {
    const value = fixture()
    const prepared = await prepare(value)
    native.showMessageBox.mockClear()
    for (const input of [
      { ...prepared.approval, callId: UNKNOWN_CALL },
      { ...prepared.approval, payloadSha256: UNKNOWN_HASH }
    ]) {
      await rejectsSafely(
        value.service.approveBridge(input, invocation('approveBridge')),
        'EXPIRED'
      )
    }
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(value.approve).not.toHaveBeenCalled()
    expect(value.model.chat).not.toHaveBeenCalled()
    expect(await prepared.status()).toMatchObject({ status: 'awaiting-approval' })
  })

  it.each([
    cancelled,
    { response: 1, checkboxChecked: true },
    { response: 0, checkboxChecked: false }
  ])('does not infer without both native request approvals: %j', async (answer) => {
    const value = fixture()
    const prepared = await prepare(value)
    native.showMessageBox.mockResolvedValueOnce(answer)
    expect(
      await value.service.approveBridge(prepared.approval, invocation('approveBridge'))
    ).toEqual({ completed: false })
    const options = native.showMessageBox.mock.calls[1][1]
    expectDefaultCancel(options)
    for (const content of [
      prepared.preview.payloadSha256,
      prepared.preview.prompt,
      JSON.stringify(prepared.preview.context),
      prepared.preview.projectId
    ]) {
      expect(options.detail).toContain(content)
    }
    expect(value.approve).not.toHaveBeenCalled()
    expect(value.model.chat).not.toHaveBeenCalled()
    expect(await prepared.status()).toMatchObject({ status: 'awaiting-approval' })
  })

  it.each(staleDocuments)(
    'does not send an approved payload from a stale modal: $name',
    async ({ change, code }) => {
      const value = fixture()
      const prepared = await prepare(value)
      const modal = holdModal()
      const rejected = rejectsSafely(
        value.service.approveBridge(prepared.approval, invocation('approveBridge')),
        code
      )
      await modal.opened
      change(value)
      modal.resolve(approved)
      await rejected
      expect(value.approve).not.toHaveBeenCalled()
      expect(value.model.chat).not.toHaveBeenCalled()
    }
  )

  it.each(['deny', 'revoke'] as const)(
    '%s remains available while a native approval is pending and prevents dispatch',
    async (action) => {
      const value = fixture()
      const prepared = await prepare(value)
      const modal = holdModal()
      const rejected = rejectsSafely(
        value.service.approveBridge(prepared.approval, invocation('approveBridge')),
        'INVALID_REQUEST'
      )
      await modal.opened
      if (action === 'deny')
        await value.service.denyBridge(
          { callId: prepared.preview.callId },
          invocation('denyBridge')
        )
      else
        await value.service.revokeBridge(
          { pluginId: pairRequest.pluginId },
          invocation('revokeBridge')
        )
      expect(native.showMessageBox).toHaveBeenCalledTimes(2)
      modal.resolve(approved)
      await rejected
      expect(value.model.chat).not.toHaveBeenCalled()
      if (action === 'deny') expect(await prepared.status()).toMatchObject({ errorCode: 'DENIED' })
      else await rejectsSafely(prepared.status(), 'UNAUTHORIZED')
    }
  )

  it('revokes only the requested plugin, invalidating both sessions and unused tickets', async () => {
    const value = fixture()
    const prepared = await prepare(value)
    const unusedTicket = await ticketFor(value)
    await value.service.revokeBridge({ pluginId: 'other.plugin' }, invocation('revokeBridge'))
    expect(await prepared.status()).toMatchObject({ status: 'awaiting-approval' })
    await value.service.revokeBridge({ pluginId: pairRequest.pluginId }, invocation('revokeBridge'))
    expect(await desktopState(value)).toEqual({ sessions: [], previews: [] })
    await rejectsSafely(prepared.status(), 'UNAUTHORIZED')
    await rejectsSafely(value.runtime.redeem(envelope(unusedTicket)), 'UNAUTHORIZED')
    expect(value.model.chat).not.toHaveBeenCalled()
    expect(native.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('invalidates consent after the required model profile subscription reports a revision change', async () => {
    const value = fixture()
    const prepared = await prepare(value)
    const modal = holdModal()
    const rejected = rejectsSafely(
      value.service.approveBridge(prepared.approval, invocation('approveBridge')),
      'INVALID_REQUEST'
    )
    await modal.opened
    expect(value.model.onProfileConfigurationChanged).toHaveBeenCalledTimes(1)
    value.model.isProfileRevisionCurrent.mockReturnValue(false)
    value.changeProfiles()
    expect(await desktopState(value)).toEqual({ sessions: [], previews: [] })
    modal.resolve(approved)
    await rejected
    expect(value.model.chat).not.toHaveBeenCalled()
  })

  it.each(['reload', 'destroy', 'shutdown', 'revoke'] as const)(
    '%s aborts approved work and suppresses a late model result',
    async (reason) => {
      const value = fixture()
      const prepared = await prepare(value)
      const result = deferred<LLMChatResp>()
      value.model.chat.mockImplementationOnce(async () => {
        value.chatStarted.resolve()
        return result.promise
      })
      native.showMessageBox.mockResolvedValueOnce(approved)
      expect(
        await value.service.approveBridge(prepared.approval, invocation('approveBridge'))
      ).toEqual({ completed: true })
      await value.chatStarted.promise
      const [input, options] = value.model.chat.mock.calls[0]
      expect(options?.signal?.aborted).toBe(false)
      if (reason === 'reload')
        value.window.webContents.emit('did-start-navigation', {}, TRUSTED_URL, false, true)
      else if (reason === 'destroy') {
        value.window.webContents.isDestroyed.mockReturnValue(true)
        value.window.webContents.emit('destroyed')
      } else if (reason === 'shutdown') await disposeFigPluginBridges()
      else
        await value.service.revokeBridge(
          { pluginId: pairRequest.pluginId },
          invocation('revokeBridge')
        )
      expect(options?.signal?.aborted).toBe(true)
      expect(value.model.cancelConversation).toHaveBeenCalledExactlyOnceWith({
        conversationId: input.conversationId
      })
      result.resolve({ content: 'Late synthetic output must never reach a revoked session' })
      if (reason !== 'revoke') {
        expect(value.dispose).toHaveBeenCalledTimes(1)
        expect(value.unsubscribeStore).toHaveBeenCalledTimes(1)
        expect(value.unsubscribeProfiles).toHaveBeenCalledTimes(1)
        // Window invalidation starts disposal without waiting for asynchronous transport closure.
        await value.dispose.mock.results[0].value
        expect(value.close).toHaveBeenCalledTimes(1)
      }
      await settle()
      await rejectsSafely(prepared.status(), 'UNAUTHORIZED')
      expect(value.model.chat).toHaveBeenCalledTimes(1)
    }
  )
})

// Only this fixture reserves an ephemeral OS port. Product HTTP still binds the exact descriptor
// origin, without scanning/fallback. The synthetic client holds bearer grants, not host identity.
async function freeLoopbackOrigin(): Promise<string> {
  const holder = createServer()
  holder.listen({ host: '127.0.0.1', port: 0 })
  await once(holder, 'listening')
  try {
    const address = holder.address()
    if (!address || typeof address === 'string') throw new Error('Invalid fixture address')
    return `http://127.0.0.1:${address.port}`
  } finally {
    await new Promise<void>((resolve, reject) =>
      holder.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

function post(origin: string, endpoint: string, body: unknown, session?: FigPluginPairResponse) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(origin))
    throw new Error('Non-loopback fixture request')
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const data = JSON.stringify(body)
    const request = httpRequest(
      origin,
      {
        method: 'POST',
        path: `/figplugin/v1/${endpoint}`,
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(session
            ? {
                Authorization: `Bearer ${session.sessionToken}`,
                'X-FigPlugin-Session': session.sessionId
              }
            : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({ status: response.statusCode!, body: text ? JSON.parse(text) : undefined })
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    request.on('error', reject)
    request.setTimeout(4_000, () =>
      request.destroy(new Error('Synthetic loopback request timed out'))
    )
    request.end(data)
  })
}

async function loopbackSession(value: Fixture) {
  const ticket = await ticketFor(value)
  const origin = ticket.bridgeOrigin
  const paired = await post(origin, 'pair', envelope(ticket))
  expect(paired.status).toBe(200)
  return {
    ticket,
    origin,
    session: figPluginPairResponseSchema.parse(paired.body)
  }
}

async function waitForCall(origin: string, session: FigPluginPairResponse, callId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await post(origin, 'status', { protocol: 1, callId }, session)
    expect(response.status).toBe(200)
    const status = figPluginBridgeStatusResponseSchema.parse(response.body)
    if (
      status.status === 'completed' ||
      status.status === 'failed' ||
      status.status === 'cancelled'
    )
      return status
    await settle()
  }
  throw new Error('Synthetic loopback planning call did not settle')
}

async function waitForExecution(value: Fixture, callId: string, executionId?: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = figPluginExecutionDesktopStateSchema.parse(await planDesktopState(value))
    const preview = state.previews.find(
      (item) =>
        item.callId === callId && (executionId === undefined || item.executionId === executionId)
    )
    if (preview) return { state, preview }
    await settle()
  }
  throw new Error('Synthetic native execution preview was not registered')
}

async function prepareExecutablePlan(
  value: Fixture,
  input: FigPluginBridgePrepareRequest = executionRequest()
) {
  const { origin, session } = await loopbackSession(value)
  const preparedResponse = await post(origin, 'prepare', input, session)
  expect(preparedResponse.status).toBe(200)
  const prepared = figPluginBridgePrepareResponseSchema.parse(preparedResponse.body)
  const modelPreview = (await desktopState(value)).previews.find(
    (item) => item.callId === prepared.callId
  )
  if (!modelPreview) throw new Error('Missing model-request preview')
  value.model.chat.mockResolvedValueOnce({
    content: JSON.stringify(executionPlan),
    finishReason: 'stop'
  })
  native.showMessageBox.mockResolvedValueOnce(approved)
  expect(
    await value.service.approveBridge(
      { callId: prepared.callId, payloadSha256: modelPreview.payloadSha256 },
      invocation('approveBridge')
    )
  ).toEqual({ completed: true })
  expect(await waitForCall(origin, session, prepared.callId)).toMatchObject({ status: 'completed' })
  const { preview: execution } = await waitForExecution(value, prepared.callId)
  return { origin, session, prepared, execution }
}

async function completeVisualExecution(value: Fixture) {
  const { origin, session, prepared, execution } = await prepareExecutablePlan(
    value,
    visualExecutionRequest()
  )
  expect(execution.visualAudit).toBe('hash-only')
  native.showMessageBox.mockResolvedValueOnce(approved)
  expect(
    await value.service.approvePlanExecution(
      { executionId: execution.executionId, planSha256: execution.planSha256 },
      invocation('approvePlanExecution')
    )
  ).toEqual({ completed: true })
  const claim = figPluginExecutionClaimResponseSchema.parse(
    (await post(origin, 'plan/claim', { protocol: 1, callId: prepared.callId }, session)).body
  )
  if (claim.status !== 'ready') throw new Error('Expected an approved execution intent')
  const resultResponse = await post(
    origin,
    'plan/result',
    {
      protocol: 1,
      executionId: execution.executionId,
      actionId: claim.intent.actionId,
      status: 'completed',
      effect: 'applied',
      completed: 1,
      total: 1,
      readback: createHostPlanReadback(
        visualExecutionContext,
        executedContext(visualExecutionContext),
        executionPlan
      ),
      visualEvidence
    },
    session
  )
  expect(resultResponse.status).toBe(200)
  const result = figPluginExecutionResultResponseSchema.parse(resultResponse.body)
  const visualEvidenceSha256 = result.status.visualEvidenceSha256
  if (!visualEvidenceSha256) throw new Error('Expected exact visual evidence digest')
  expect(result.status.visualEvidence).toEqual(visualEvidence)
  return { origin, session, prepared, execution, result, visualEvidenceSha256 }
}

it('real loopback: pair -> prepare -> native desktop approval -> one mock model result -> deny/cancel/revoke', async () => {
  const value = fixture({ origin: await freeLoopbackOrigin(), realHttp: true })
  const pairModal = holdModal()
  const pairing = value.service.createPairing(pairRequest, invocation('createPairing'))
  expectDefaultCancel(await pairModal.opened)
  expect(value.startServer).not.toHaveBeenCalled()
  expect(value.model.chat).not.toHaveBeenCalled()
  pairModal.resolve(approved)
  const ticket = figPluginDesktopPairTicketSchema.parse(await pairing)
  const origin = ticket.bridgeOrigin
  const unauthenticated = await post(origin, 'pair', {
    ...envelope(ticket),
    pairingSecret: '0'.repeat(64)
  })
  expect(unauthenticated).toEqual({
    status: 401,
    body: { code: 'UNAUTHORIZED', message: FIGPLUGIN_BRIDGE_ERRORS.UNAUTHORIZED }
  })
  const paired = await post(origin, 'pair', envelope(ticket))
  expect(paired.status).toBe(200)
  const session = figPluginPairResponseSchema.parse(paired.body)
  expect((await post(origin, 'pair', envelope(ticket))).status).toBe(401)
  expect((await post(origin, 'prepare', request())).status).toBe(401)
  const preparedResponse = await post(origin, 'prepare', request(), session)
  expect(preparedResponse.status).toBe(200)
  const prepared = figPluginBridgePrepareResponseSchema.parse(preparedResponse.body)
  const preview = (await desktopState(value)).previews[0]
  const approval = { callId: prepared.callId, payloadSha256: preview.payloadSha256 }
  for (const endpoint of ['approve', 'deny', 'revoke', 'createPairing']) {
    expect((await post(origin, endpoint, approval, session)).status).toBe(400)
  }
  await rejectsSafely(value.service.approveBridge(approval), 'PERMISSION_DENIED')
  await rejectsSafely(
    value.service.approveBridge(
      approval,
      invocation('approveBridge', { senderUrl: origin, frameUrl: origin })
    ),
    'PERMISSION_DENIED'
  )
  expect(value.model.chat).not.toHaveBeenCalled()
  const modal = holdModal()
  const approving = value.service.approveBridge(approval, invocation('approveBridge'))
  expectDefaultCancel(await modal.opened)
  const call = { protocol: 1, callId: prepared.callId }
  expect((await post(origin, 'status', call, session)).body).toMatchObject({
    status: 'awaiting-approval'
  })
  expect(value.model.chat).not.toHaveBeenCalled()
  modal.resolve(approved)
  expect(await approving).toEqual({ completed: true })
  await value.chatStarted.promise
  await settle()
  const result = await post(origin, 'status', call, session)
  expect(result.status).toBe(200)
  expect(figPluginBridgeStatusResponseSchema.parse(result.body)).toEqual({
    ...call,
    status: 'completed',
    content: modelResult.content,
    reportedTotalTokens: 27
  })
  expect(value.model.chat).toHaveBeenCalledTimes(1)
  expect(value.model.chat.mock.calls[0][0]).toEqual({
    profileId: value.descriptor.profileId,
    expectedProfileRevision: PROFILE_REVISION,
    profileScope: 'agent',
    conversationId: expect.any(String),
    temperature: 0.2,
    maxOutputTokens: 1200,
    messages: [
      { role: 'system', content: expect.stringContaining('Do not use tools') },
      {
        role: 'user',
        content: JSON.stringify({
          projectId: pairRequest.projectId,
          context: request().context,
          prompt: request().prompt
        })
      }
    ]
  })
  await rejectsSafely(value.service.approveBridge(approval, invocation('approveBridge')), 'EXPIRED')
  const denied = figPluginBridgePrepareResponseSchema.parse(
    (await post(origin, 'prepare', request(2), session)).body
  )
  await value.service.denyBridge({ callId: denied.callId }, invocation('denyBridge'))
  expect(
    (await post(origin, 'status', { protocol: 1, callId: denied.callId }, session)).body
  ).toMatchObject({ errorCode: 'DENIED' })
  const cancelledCall = figPluginBridgePrepareResponseSchema.parse(
    (await post(origin, 'prepare', request(3), session)).body
  )
  const cancel = { protocol: 1, callId: cancelledCall.callId }
  expect((await post(origin, 'cancel', cancel, session)).status).toBe(204)
  expect((await post(origin, 'status', cancel, session)).body).toMatchObject({
    status: 'cancelled',
    errorCode: 'CANCELLED'
  })
  await value.service.revokeBridge({ pluginId: pairRequest.pluginId }, invocation('revokeBridge'))
  expect((await post(origin, 'status', call, session)).status).toBe(401)
  expect(await desktopState(value)).toEqual({ sessions: [], previews: [] })
  expect(native.showMessageBox).toHaveBeenCalledTimes(2)
  expect(value.model.chat).toHaveBeenCalledTimes(1)
})

it('real loopback: planning snapshot is shown in native consent, then a non-executable diff returns once', async () => {
  const value = fixture({ origin: await freeLoopbackOrigin(), realHttp: true })
  const ticket = await ticketFor(value)
  const origin = ticket.bridgeOrigin
  const session = figPluginPairResponseSchema.parse(
    (await post(origin, 'pair', envelope(ticket))).body
  )
  const context = {
    version: 1 as const,
    host: 'figma' as const,
    documentId: 'owned-doc',
    scopeId: 'owned-page',
    captureId: '9'.repeat(32),
    nodes: [
      {
        id: '1:2',
        type: 'FRAME',
        name: 'Synthetic untrusted label',
        parentId: null,
        ancestors: [],
        locked: false,
        visible: true,
        commands: ['node.rename' as const],
        text: 'OWNED_REVIEWED_FULL_CONTEXT'
      }
    ]
  }
  const input: FigPluginBridgePrepareRequest = {
    ...request(),
    featureId: 'plan-preview',
    hostContext: context,
    context: { ...request().context, selectionRevision: context.captureId }
  }
  const prepared = figPluginBridgePrepareResponseSchema.parse(
    (await post(origin, 'prepare', input, session)).body
  )
  const preview = (await desktopState(value)).previews[0]
  const approval = { callId: prepared.callId, payloadSha256: preview.payloadSha256 }
  expect(value.model.chat).not.toHaveBeenCalled()
  for (const endpoint of ['execute', 'executePlan', 'approve'])
    expect((await post(origin, endpoint, approval, session)).status).toBe(400)
  const modal = holdModal()
  const approving = value.service.approveBridge(approval, invocation('approveBridge'))
  const options = await modal.opened
  expectDefaultCancel(options)
  expect(options.detail).toContain('OWNED_REVIEWED_FULL_CONTEXT')
  expect(options.detail).toContain('does not authorize any host or document changes')
  expect(options.detail).toContain(JSON.stringify(context))
  expect(value.model.chat).not.toHaveBeenCalled()
  const plan = {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: context.captureId,
    steps: [{ command: 'node.rename', targetId: '1:2', name: 'Proposed owned name' }]
  }
  value.model.chat.mockResolvedValueOnce({ content: JSON.stringify(plan), finishReason: 'stop' })
  modal.resolve(approved)
  await approving
  let result
  for (let attempt = 0; attempt < 30; attempt++) {
    result = figPluginBridgeStatusResponseSchema.parse(
      (await post(origin, 'status', { protocol: 1, callId: prepared.callId }, session)).body
    )
    if (result.status === 'completed' || result.status === 'failed') break
    await settle()
  }
  expect(result?.status).toBe('completed')
  if (result?.status !== 'completed') throw new Error('Expected validated planning result')
  expect(JSON.parse(result.content)).toMatchObject({
    kind: 'host-plan-preview',
    executable: false,
    plan,
    differences: [
      {
        targetId: '1:2',
        command: 'node.rename',
        before: 'Synthetic untrusted label',
        after: 'Proposed owned name'
      }
    ]
  })
  const replay = await post(origin, 'prepare', input, session)
  expect(replay.body).toMatchObject({ callId: prepared.callId })
  expect(value.model.chat).toHaveBeenCalledTimes(1)
  expect(value.model.chat.mock.calls[0][0]).not.toHaveProperty('skillRuntime')
  await rejectsSafely(value.service.approveBridge(approval, invocation('approveBridge')), 'EXPIRED')
  expect(context.nodes[0].name).toBe('Synthetic untrusted label')
})

it('real loopback: model send and exact native write use separate approvals and one claim', async () => {
  const value = fixture({ origin: await freeLoopbackOrigin(), realHttp: true })
  const { origin, session } = await loopbackSession(value)
  const preparedResponse = await post(origin, 'prepare', executionRequest(), session)
  expect(preparedResponse.status).toBe(200)
  const prepared = figPluginBridgePrepareResponseSchema.parse(preparedResponse.body)
  const modelPreview = (await desktopState(value)).previews.find(
    (item) => item.callId === prepared.callId
  )
  if (!modelPreview) throw new Error('Missing model-request preview')
  expect(native.showMessageBox).toHaveBeenCalledTimes(1)
  expect((await planDesktopState(value)).previews).toEqual([])

  value.model.chat.mockResolvedValueOnce({
    content: JSON.stringify(executionPlan),
    finishReason: 'stop'
  })
  const sendModal = holdModal()
  const sending = value.service.approveBridge(
    { callId: prepared.callId, payloadSha256: modelPreview.payloadSha256 },
    invocation('approveBridge')
  )
  const sendOptions = await sendModal.opened
  expectDefaultCancel(sendOptions)
  expect(sendOptions.title).toBe('Approve one plugin model request')
  expect(sendOptions.detail).toContain('does not authorize any host or document changes')
  expect(sendOptions.detail).toContain(JSON.stringify(executionContext))
  expect(value.model.chat).not.toHaveBeenCalled()
  expect((await planDesktopState(value)).previews).toEqual([])

  sendModal.resolve(approved)
  expect(await sending).toEqual({ completed: true })
  const modelStatus = await waitForCall(origin, session, prepared.callId)
  expect(modelStatus).toMatchObject({ status: 'completed' })
  if (modelStatus.status !== 'completed') throw new Error('Expected a completed plan preview')
  expect(JSON.parse(modelStatus.content)).toMatchObject({
    kind: 'host-plan-preview',
    executable: true,
    plan: executionPlan,
    execution: { requiresWriteApproval: true }
  })
  const { preview: execution } = await waitForExecution(value, prepared.callId)
  expect(execution).toMatchObject({
    callId: prepared.callId,
    state: 'awaiting-approval',
    host: 'figma',
    adapterVersion: 'synthetic-figma-adapter-1',
    rollback: 'verified-in-place',
    visualAudit: 'unavailable',
    risk: 'low'
  })
  expect(native.showMessageBox).toHaveBeenCalledTimes(2)
  expect(value.model.chat).toHaveBeenCalledTimes(1)

  const wrongPlanHash = execution.planSha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64)
  await rejectsSafely(
    value.service.approvePlanExecution(
      { executionId: execution.executionId, planSha256: wrongPlanHash },
      invocation('approvePlanExecution')
    ),
    'EXPIRED'
  )
  expect(native.showMessageBox).toHaveBeenCalledTimes(2)

  const writeModal = holdModal()
  const writing = value.service.approvePlanExecution(
    { executionId: execution.executionId, planSha256: execution.planSha256 },
    invocation('approvePlanExecution')
  )
  const writeOptions = await writeModal.opened
  expectDefaultCancel(writeOptions)
  expect(writeOptions.title).toBe('Approve one native document write')
  expect(writeOptions.detail).toContain(`Plan SHA-256: ${execution.planSha256}`)
  expect(writeOptions.detail).toContain(`Context SHA-256: ${execution.contextSha256}`)
  expect(writeOptions.detail).toContain('Exact document changes:')
  expect(writeOptions.detail).toContain('Synthetic approved label')
  expect(writeOptions.detail).toContain('Model-send approval is separate')
  expect((await waitForExecution(value, prepared.callId)).preview.state).toBe('awaiting-approval')
  expect(value.model.chat).toHaveBeenCalledTimes(1)

  writeModal.resolve(approved)
  expect(await writing).toEqual({ completed: true })
  expect((await waitForExecution(value, prepared.callId)).preview.state).toBe('approved')

  const claimRequest = { protocol: 1, callId: prepared.callId }
  const claimResponse = await post(origin, 'plan/claim', claimRequest, session)
  expect(claimResponse.status).toBe(200)
  const claimed = figPluginExecutionClaimResponseSchema.parse(claimResponse.body)
  if (claimed.status !== 'ready') throw new Error('Expected an approved execution intent')
  expect(claimed.intent).toMatchObject({
    purpose: 'execute-host-plan',
    executionId: execution.executionId,
    callId: prepared.callId,
    documentId: executionContext.documentId,
    scopeId: executionContext.scopeId,
    captureId: executionContext.captureId,
    plan: executionPlan,
    planSha256: execution.planSha256,
    adapterVersion: execution.adapterVersion
  })
  const replayClaim = await post(origin, 'plan/claim', claimRequest, session)
  expect(figPluginExecutionClaimResponseSchema.parse(replayClaim.body)).toEqual(claimed)

  const progress = {
    protocol: 1,
    executionId: execution.executionId,
    actionId: claimed.intent.actionId,
    sequence: 2,
    phase: 'executing',
    index: 0,
    completed: 1,
    total: 1,
    effect: 'applied',
    at: Date.now()
  }
  const progressResponse = await post(origin, 'plan/progress', progress, session)
  expect(progressResponse.status).toBe(200)
  expect(figPluginExecutionStatusSchema.parse(progressResponse.body)).toMatchObject({
    state: 'executing',
    completed: 1,
    total: 1,
    effect: 'applied'
  })
  expect((await post(origin, 'plan/progress', progress, session)).status).toBe(400)

  const result = {
    protocol: 1,
    executionId: execution.executionId,
    actionId: claimed.intent.actionId,
    status: 'completed',
    effect: 'applied',
    completed: 1,
    total: 1,
    readback: createHostPlanReadback(executionContext, executedContext(), executionPlan)
  }
  const resultResponse = await post(origin, 'plan/result', result, session)
  expect(resultResponse.status).toBe(200)
  const parsedResult = figPluginExecutionResultResponseSchema.parse(resultResponse.body)
  expect(parsedResult.status).toMatchObject({
    state: 'completed',
    completed: 1,
    total: 1,
    effect: 'applied'
  })
  expect(
    figPluginExecutionResultResponseSchema.parse(
      (await post(origin, 'plan/result', result, session)).body
    )
  ).toEqual(parsedResult)
  const statusResponse = await post(origin, 'plan/status', claimRequest, session)
  expect(statusResponse.status).toBe(200)
  expect(figPluginExecutionStatusSchema.parse(statusResponse.body)).toEqual(parsedResult.status)
  expect(value.model.chat).toHaveBeenCalledTimes(1)
  expect(executionContext.nodes[0].name).toBe('Synthetic untrusted label')
})

it('real loopback: exact user consent records one bounded visual checkpoint and revoke removes it', async () => {
  const value = fixture({ origin: await freeLoopbackOrigin(), realHttp: true })
  const { execution, visualEvidenceSha256 } = await completeVisualExecution(value)
  expect((await planDesktopState(value)).baselines).toEqual([])

  const modalCount = native.showMessageBox.mock.calls.length
  await rejectsSafely(
    value.service.acceptVisualBaseline(
      { executionId: execution.executionId, visualEvidenceSha256: UNKNOWN_HASH },
      invocation('acceptVisualBaseline')
    ),
    'EXPIRED'
  )
  expect(native.showMessageBox).toHaveBeenCalledTimes(modalCount)

  const cancelledModal = holdModal()
  const cancelledAcceptance = value.service.acceptVisualBaseline(
    { executionId: execution.executionId, visualEvidenceSha256 },
    invocation('acceptVisualBaseline')
  )
  const cancelledOptions = await cancelledModal.opened
  expectDefaultCancel(cancelledOptions)
  expect(cancelledOptions.title).toBe('Accept a bounded visual checkpoint')
  expect(cancelledOptions.detail).toContain(`Visual evidence SHA-256: ${visualEvidenceSha256}`)
  expect(cancelledOptions.detail).toContain('"targetId": "1:2"')
  expect(cancelledOptions.detail).toContain(
    `Maximum correction rounds recorded by this checkpoint: ${FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS}`
  )
  expect(cancelledOptions.detail).toContain('stores no pixels or design text')
  expect(cancelledOptions.detail).not.toContain('Synthetic approved label')
  expect(cancelledOptions.detail).not.toContain('Synthetic untrusted label')
  cancelledModal.resolve(cancelled)
  expect(await cancelledAcceptance).toBeNull()
  expect((await planDesktopState(value)).baselines).toEqual([])

  const approvedModal = holdModal()
  const accepting = value.service.acceptVisualBaseline(
    { executionId: execution.executionId, visualEvidenceSha256 },
    invocation('acceptVisualBaseline')
  )
  expectDefaultCancel(await approvedModal.opened)
  approvedModal.resolve(approved)
  const baseline = await accepting
  expect(baseline).toMatchObject({
    sourceExecutionId: execution.executionId,
    pluginId: pairRequest.pluginId,
    host: 'figma',
    projectId: pairRequest.projectId,
    documentId: visualExecutionContext.documentId,
    scopeId: visualExecutionContext.scopeId,
    captureId: visualExecutionContext.captureId,
    planSha256: execution.planSha256,
    contextSha256: execution.contextSha256,
    visualEvidenceSha256,
    targets: [{ targetId: '1:2', accepted: visualEvidence[0].after }],
    correctionRoundsUsed: 0,
    maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS
  })
  if (!baseline) throw new Error('Expected accepted baseline')
  expect((await planDesktopState(value)).baselines).toEqual([baseline])

  const promptCount = native.showMessageBox.mock.calls.length
  expect(
    await value.service.acceptVisualBaseline(
      { executionId: execution.executionId, visualEvidenceSha256 },
      invocation('acceptVisualBaseline')
    )
  ).toEqual(baseline)
  expect(native.showMessageBox).toHaveBeenCalledTimes(promptCount)

  await value.service.revokeBridge({ pluginId: pairRequest.pluginId }, invocation('revokeBridge'))
  expect((await planDesktopState(value)).baselines).toEqual([])
})

it('real loopback: visual checkpoint consent fails closed after the desktop document epoch changes', async () => {
  const value = fixture({ origin: await freeLoopbackOrigin(), realHttp: true })
  const { execution, visualEvidenceSha256 } = await completeVisualExecution(value)
  const modal = holdModal()
  const rejected = rejectsSafely(
    value.service.acceptVisualBaseline(
      { executionId: execution.executionId, visualEvidenceSha256 },
      invocation('acceptVisualBaseline')
    ),
    'CONFIGURATION_CHANGED'
  )
  expectDefaultCancel(await modal.opened)
  value.window.webContents.emit('did-start-navigation', {}, TRUSTED_URL, false, true)
  modal.resolve(approved)
  await rejected
  expect(await planDesktopState(value)).toEqual({ previews: [], statuses: [], baselines: [] })
  expect(value.dispose).toHaveBeenCalledTimes(1)
})

it('real loopback: a false applied readback is quarantined and cannot be claimed again', async () => {
  const value = fixture({ origin: await freeLoopbackOrigin(), realHttp: true })
  const { origin, session, prepared, execution } = await prepareExecutablePlan(value)
  native.showMessageBox.mockResolvedValueOnce(approved)
  expect(
    await value.service.approvePlanExecution(
      { executionId: execution.executionId, planSha256: execution.planSha256 },
      invocation('approvePlanExecution')
    )
  ).toEqual({ completed: true })

  const claim = figPluginExecutionClaimResponseSchema.parse(
    (await post(origin, 'plan/claim', { protocol: 1, callId: prepared.callId }, session)).body
  )
  if (claim.status !== 'ready') throw new Error('Expected an approved execution intent')

  const falseApplied = await post(
    origin,
    'plan/result',
    {
      protocol: 1,
      executionId: execution.executionId,
      actionId: claim.intent.actionId,
      status: 'completed',
      effect: 'applied',
      completed: 1,
      total: 1,
      readback: createHostPlanReadback(executionContext, executionContext, executionPlan)
    },
    session
  )
  expect(falseApplied).toEqual({
    status: 400,
    body: {
      code: 'INVALID_REQUEST',
      message: FIGPLUGIN_BRIDGE_ERRORS.INVALID_REQUEST
    }
  })
  const state = figPluginExecutionDesktopStateSchema.parse(await planDesktopState(value))
  expect(state.statuses).toContainEqual(
    expect.objectContaining({
      executionId: execution.executionId,
      state: 'failed',
      effect: 'unknown',
      errorCode: 'QUARANTINED'
    })
  )
  const terminal = figPluginExecutionClaimResponseSchema.parse(
    (await post(origin, 'plan/claim', { protocol: 1, callId: prepared.callId }, session)).body
  )
  expect(terminal).toEqual({
    protocol: 1,
    status: 'terminal',
    state: 'failed',
    errorCode: 'QUARANTINED'
  })
  expect(value.model.chat).toHaveBeenCalledTimes(1)
})

it.each(['deny', 'cancel'] as const)(
  'real loopback: desktop %s never releases a writable intent',
  async (action) => {
    const value = fixture({ origin: await freeLoopbackOrigin(), realHttp: true })
    const { origin, session, prepared, execution } = await prepareExecutablePlan(value)
    if (action === 'cancel') {
      native.showMessageBox.mockResolvedValueOnce(approved)
      expect(
        await value.service.approvePlanExecution(
          { executionId: execution.executionId, planSha256: execution.planSha256 },
          invocation('approvePlanExecution')
        )
      ).toEqual({ completed: true })
      await value.service.cancelPlanExecution(
        { executionId: execution.executionId },
        invocation('cancelPlanExecution')
      )
    } else {
      await value.service.denyPlanExecution(
        { executionId: execution.executionId },
        invocation('denyPlanExecution')
      )
    }

    const claim = figPluginExecutionClaimResponseSchema.parse(
      (await post(origin, 'plan/claim', { protocol: 1, callId: prepared.callId }, session)).body
    )
    expect(claim).toEqual({
      protocol: 1,
      status: 'terminal',
      state: action === 'deny' ? 'denied' : 'cancelled',
      errorCode: action === 'deny' ? 'DENIED' : 'CANCELLED'
    })
    expect((await waitForExecution(value, prepared.callId)).preview.state).toBe(
      action === 'deny' ? 'denied' : 'cancelled'
    )
    expect(value.model.chat).toHaveBeenCalledTimes(1)
  }
)
