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
  'createPairing' | 'bridgeState' | 'approveBridge' | 'denyBridge' | 'revokeBridge'
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
const desktopState = (value: Fixture) => value.service.bridgeState({}, invocation('bridgeState'))
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
    await expect(
      value.service.bridgeState(
        { sessionToken: UNKNOWN_HASH } as unknown as Record<string, never>,
        invocation('bridgeState')
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
    const { limits: _limits, ...identity } = value.descriptor
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
