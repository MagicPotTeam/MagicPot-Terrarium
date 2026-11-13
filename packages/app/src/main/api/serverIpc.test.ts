import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiDef } from '@shared/api'
import { createServer, initServerIpc } from './serverIpc'
import { parseStartupStorageMetadataRequest, parseStartupStorageMetadataResponse, startupStorageMetadataUnavailable } from '@shared/api/startupStorageMetadata'
import { FigPluginCenterSvcImpl } from './svcFigPluginCenterImpl'
import { AgentLocalFilesSvcImpl } from './svcAgentLocalFilesImpl'

const CANVAS_THUMBNAIL_METHODS = [
  'getSourceFileMetadata',
  'getThumbnailCacheRoot',
  'readThumbnailManifest',
  'writeThumbnailSet',
  'generateThumbnailSet',
  'createNativeThumbnail',
  'createNativeRegion'
] as const

const { createServiceClass, handleMock, onMock, catalogDelegateFactory, platformConstructor, storageDelegateFactory, stateConstructor } = vi.hoisted(() => {
  const createServiceClass = () =>
    class {
      [methodName: string]: unknown

      constructor() {
        return new Proxy(this, {
          get(target, property, receiver) {
            if (typeof property !== 'string') {
              return Reflect.get(target, property, receiver)
            }
            if (!(property in target)) {
              target[property] = async () => undefined
            }
            return Reflect.get(target, property, receiver)
          }
        })
      }
    }

  return {
    createServiceClass,
    handleMock: vi.fn(),
    onMock: vi.fn(),
    catalogDelegateFactory: vi.fn((_getMainWindow: () => Electron.BrowserWindow | null) => vi.fn(async () => ({ status: 'unavailable', reason: 'unavailable' }))),
    platformConstructor: vi.fn(),
    storageDelegateFactory: vi.fn((_getMainWindow: () => Electron.BrowserWindow | null) => vi.fn(async () => ({ status: 'unavailable', reason: 'unavailable' }))),
    stateConstructor: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0')
  },
  utilityProcess: {},
  ipcMain: {
    handle: handleMock,
    on: onMock
  },
  MessagePortMain: class {}
}))

vi.mock('./svcAdobeBridgeImpl', () => ({ AdobeBridgeSvcImpl: createServiceClass() }))
vi.mock('./svcStateImpl', () => ({ StateSvcImpl: vi.fn(function (deps?: unknown) { stateConstructor(deps); return new (createServiceClass())() }) }))
vi.mock('../storageMetadata/startupStorageReadBinding', () => ({ createStartupStorageReadDelegate: storageDelegateFactory }))
vi.mock('./svcComfyImpl', () => ({ ComfySvcImpl: createServiceClass() }))
vi.mock('./svcComfyBatchImpl', () => ({ ComfyBatchSvcImpl: createServiceClass() }))
vi.mock('./svcCanvasThumbnailImpl', () => ({ CanvasThumbnailSvcImpl: createServiceClass() }))
vi.mock('./svcTargetSchemeImpl', () => ({ TargetSchemeSvcImpl: createServiceClass() }))
vi.mock('./svcProjectTraceImpl', () => ({ ProjectTraceSvcImpl: createServiceClass() }))
vi.mock('./svcCustomSkillImpl', () => ({ CustomSkillSvcImpl: createServiceClass() }))
vi.mock('./svcDialogImpl', () => ({ DialogSvcImpl: createServiceClass() }))
vi.mock('./svcFigmaImpl', () => ({ FigmaSvcImpl: createServiceClass() }))
vi.mock('./svcShellImpl', () => ({ ShellSvcImpl: createServiceClass() }))
vi.mock('./svcQAppImpl', () => ({ QAppSvcImpl: createServiceClass() }))
vi.mock('./svcHyperImpl', () => ({ HyperSvcImpl: createServiceClass() }))
vi.mock('./svcPysssssImpl', () => ({ PysssssSvcImpl: createServiceClass() }))
vi.mock('./svcPhotoshopImpl', () => ({ PhotoshopSvcImpl: createServiceClass() }))
vi.mock('./svcLLMProxyImpl', () => ({ LLMProxySvcImpl: createServiceClass() }))
vi.mock('./svcLogImpl', () => ({ LogSvcImpl: createServiceClass() }))
vi.mock('./svcFsImpl', () => ({ FsSvcImpl: createServiceClass() }))
vi.mock('./svcDccBridgeImpl', () => ({ DccBridgeSvcImpl: createServiceClass() }))
vi.mock('./svcDuplicateCheckImpl', () => ({ DuplicateCheckSvcImpl: createServiceClass() }))
vi.mock('./svcAppUpdateImpl', () => ({ AppUpdateSvcImpl: createServiceClass() }))
vi.mock('./svcMagicAgentPlatformImpl', () => ({ MagicAgentPlatformSvcImpl: vi.fn(function (deps?: unknown) {
  platformConstructor(deps); return new (createServiceClass())()
}) }))
vi.mock('../magicAgentRuntime/installedCatalogReadBinding', () => ({ createInstalledCatalogReadDelegate: catalogDelegateFactory }))
vi.mock('./svcManagedMediaImpl', () => ({ ManagedMediaSvcImpl: createServiceClass() }))
describe('serverIpc createServer', () => {
  beforeEach(() => {
    handleMock.mockClear()
    onMock.mockClear(); catalogDelegateFactory.mockClear(); platformConstructor.mockClear(); storageDelegateFactory.mockClear(); stateConstructor.mockClear()
  })

  it('creates the remaining service registry', () => {
    const api = createServer()

    expect(api.svcTargetScheme).toBeDefined()
    expect(apiDef.svcTargetScheme).toBeDefined()
    expect(api.svcAppUpdate).toBeDefined()
    expect(apiDef.svcAppUpdate).toBeDefined()
    expect(api.svcMagicAgentPlatform).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform).toBeDefined()
    expect(api.svcManagedMedia).toBeDefined()
    expect(apiDef.svcManagedMedia.ensureDerivative.type).toBe('unary')
    expect(api.svcComfyBatch).toBeDefined()
    expect(apiDef.svcComfyBatch.start.type).toBe('unary')
  })

  it('injects only the MAIN catalog delegate made with the original authoritative window getter into the IPC-created constructor', () => {
    const firstWindow = {} as Electron.BrowserWindow, secondWindow = {} as Electron.BrowserWindow
    let current: Electron.BrowserWindow | null = firstWindow
    const getMainWindow = vi.fn(() => current)
    createServer(undefined, getMainWindow)
    expect(catalogDelegateFactory).toHaveBeenCalledExactlyOnceWith(getMainWindow)
    expect(getMainWindow).not.toHaveBeenCalled()
    const delegate = catalogDelegateFactory.mock.results[0]?.value
    expect(platformConstructor).toHaveBeenCalledExactlyOnceWith({ installedCatalogRead: delegate })
    expect(delegate).not.toHaveBeenCalled()
    expect(catalogDelegateFactory.mock.calls[0]?.[0]()).toBe(firstWindow)
    current = secondWindow; expect(catalogDelegateFactory.mock.calls[0]?.[0]()).toBe(secondWindow)
    current = null; expect(catalogDelegateFactory.mock.calls[0]?.[0]()).toBeNull()
  })
  it('default IPC constructor gets a null-window delegate rather than selecting or installing a window', () => {
    createServer()
    expect(catalogDelegateFactory).toHaveBeenCalledOnce()
    const getter = catalogDelegateFactory.mock.calls[0]?.[0]
    expect(getter).toBeTypeOf('function'); expect(getter!()).toBeNull()
    expect(platformConstructor).toHaveBeenCalledExactlyOnceWith({ installedCatalogRead: catalogDelegateFactory.mock.results[0]?.value })
  })
  it('registers the exact strict RAW catalog unary while the mocked constructor remains only an injection observer', async () => {
    const getter = vi.fn(() => null)
    initServerIpc(undefined, getter)
    expect(catalogDelegateFactory).toHaveBeenCalledExactlyOnceWith(getter)
    expect(platformConstructor).toHaveBeenCalledExactlyOnceWith({ installedCatalogRead: catalogDelegateFactory.mock.results[0]?.value })
    expect(apiDef.svcMagicAgentPlatform.readInstalledCatalog.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.readInstalledCatalog.ipcResult).toBeUndefined()
    const handler = handleMock.mock.calls.find(([name]) => name === 'svcMagicAgentPlatform.readInstalledCatalog')?.[1]
    expect(handler).toBeTypeOf('function')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try { await expect(handler({ sender: { id: 42, getURL: () => 'file:///app/index.html#/agent-management' }, senderFrame: { url: 'file:///app/index.html#/agent-management', parent: null } }, { path: 'PRIVATE' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }) }
    finally { errorLog.mockRestore() }
    expect(catalogDelegateFactory.mock.results[0]?.value).not.toHaveBeenCalled()
  })

  it('injects an independent storage delegate with the ORIGINAL getter callable and no eager access, retaining catalog injection', () => {
    const first = {} as Electron.BrowserWindow, second = {} as Electron.BrowserWindow
    let current: Electron.BrowserWindow | null = first
    const getter = vi.fn(() => current)
    createServer(undefined, getter)
    expect(storageDelegateFactory).toHaveBeenCalledExactlyOnceWith(getter)
    expect(catalogDelegateFactory).toHaveBeenCalledExactlyOnceWith(getter)
    expect(getter).not.toHaveBeenCalled()
    const delegate = storageDelegateFactory.mock.results[0]?.value
    expect(stateConstructor).toHaveBeenCalledExactlyOnceWith({ startupStorageRead: delegate })
    expect(platformConstructor).toHaveBeenCalledExactlyOnceWith({ installedCatalogRead: catalogDelegateFactory.mock.results[0]?.value })
    expect(delegate).not.toBe(catalogDelegateFactory.mock.results[0]?.value); expect(delegate).not.toHaveBeenCalled()
    const received = storageDelegateFactory.mock.calls[0]?.[0]
    expect(received!()).toBe(first); current = second; expect(received!()).toBe(second); current = null; expect(received!()).toBeNull()
  })
  it('keeps default storage IPC getter null and does not silently choose a global window', () => {
    createServer()
    expect(storageDelegateFactory).toHaveBeenCalledOnce()
    expect(storageDelegateFactory.mock.calls[0]?.[0]()).toBeNull()
    expect(stateConstructor).toHaveBeenCalledExactlyOnceWith({ startupStorageRead: storageDelegateFactory.mock.results[0]?.value })
    expect(storageDelegateFactory.mock.results[0]?.value).not.toHaveBeenCalled()
  })
  it('registers canonical storage raw unary with EXACT parser identities and malformed requests deny before the observer implementation', async () => {
    const getter = vi.fn(() => null)
    initServerIpc(undefined, getter)
    expect(storageDelegateFactory).toHaveBeenCalledExactlyOnceWith(getter)
    const definition = (apiDef.svcState as unknown as Record<string, { type: unknown; request?: unknown; response?: unknown }>).readStartupStorageMetadata
    expect(definition.type).toBe('unary'); expect(Object.hasOwn(definition, 'ipcResult')).toBe(false)
    expect(definition.request).toBe(parseStartupStorageMetadataRequest); expect(definition.response).toBe(parseStartupStorageMetadataResponse)
    const callback = handleMock.mock.calls.find(([name]) => name === 'svcState.readStartupStorageMetadata')?.[1]
    expect(callback).toBeTypeOf('function')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(callback({ sender: { id: 42, getURL: () => 'file:///app/index.html#/agent-management' }, senderFrame: { url: 'file:///app/index.html#/agent-management', parent: null } }, { path: 'PRIVATE' })).resolves.toBe(startupStorageMetadataUnavailable)
      expect(storageDelegateFactory.mock.results[0]?.value).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  it('registers the real manifest-only FIGPLUGIN core service without initializing storage', () => {
    expect(createServer().svcFigPluginCenter).toBeInstanceOf(FigPluginCenterSvcImpl)
    expect(apiDef.svcFigPluginCenter.execute.type).toBe('unary')
    initServerIpc()
    expect(handleMock).toHaveBeenCalledWith('svcFigPluginCenter.execute', expect.any(Function))
  })

  it('does not expose main-only synthetic plan execution methods through the service registry', () => {
    const service = createServer().svcFigPluginCenter
    initServerIpc()
    for (const method of ['preparePlan', 'executePlan', 'cancelPlan']) {
      expect(Object.prototype.hasOwnProperty.call(apiDef.svcFigPluginCenter, method)).toBe(false)
      expect(method in service).toBe(false)
      expect(handleMock.mock.calls.some(([name]) => name === `svcFigPluginCenter.${method}`)).toBe(
        false
      )
    }
  })

  it('registers read-only planning history and rejects a host frame through the actual IPC handler', async () => {
    const service = createServer().svcFigPluginCenter
    expect(service.planningHistory).toBeTypeOf('function')
    expect(apiDef.svcFigPluginCenter.planningHistory.type).toBe('unary')
    initServerIpc()
    const handler = handleMock.mock.calls.find(
      ([name]) => name === 'svcFigPluginCenter.planningHistory'
    )?.[1]
    expect(handler).toBeTypeOf('function')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(
        handler(
          {
            sender: { id: 9876, getURL: () => 'https://www.figma.com/' },
            senderFrame: { url: 'https://www.figma.com/', parent: null }
          },
          {}
        )
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await expect(
        handler(
          {
            sender: { id: 9876, getURL: () => 'https://www.figma.com/' },
            senderFrame: { url: 'https://www.figma.com/', parent: null }
          },
          { path: 'PRIVATE', retry: true }
        )
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    } finally {
      errorLog.mockRestore()
    }
  })

  it('denies an untrusted frame through the actual registered FIGPLUGIN IPC handler', async () => {
    initServerIpc()
    const handler = handleMock.mock.calls.find(
      ([name]) => name === 'svcFigPluginCenter.execute'
    )?.[1]
    expect(handler).toBeTypeOf('function')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(
        handler(
          {
            sender: { id: 9876, getURL: () => 'https://untrusted.invalid/' },
            senderFrame: { url: 'https://untrusted.invalid/', parent: {} }
          },
          {
            schemaVersion: 1,
            kind: 'uninstall',
            requestId: 'untrusted-request',
            idempotencyKey: 'untrusted-removal-key',
            requestedAt: '2026-01-01T00:00:00.000Z',
            pluginId: 'demo',
            host: 'figma',
            consent: {
              granted: true,
              permissions: ['uninstall'],
              source: 'system',
              grantedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        )
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    } finally {
      errorLog.mockRestore()
    }
  })

  it('registers the local file service without granting access or opening a chooser', async () => {
    expect(createServer().svcAgentLocalFiles).toBeInstanceOf(AgentLocalFilesSvcImpl)
    initServerIpc()
    for (const method of ['choose', 'read', 'list', 'revoke', 'cancel'] as const) {
      expect(apiDef.svcAgentLocalFiles[method].type).toBe('unary')
      expect(handleMock).toHaveBeenCalledWith(`svcAgentLocalFiles.${method}`, expect.any(Function))
    }
    const handler = handleMock.mock.calls.find(
      ([name]) => name === 'svcAgentLocalFiles.choose'
    )?.[1]
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(
        handler(
          {
            sender: { id: 991, getURL: () => 'https://untrusted.invalid' },
            senderFrame: { url: 'https://untrusted.invalid', parent: null }
          },
          {
            scope: { projectId: 'project-1', paneId: 'agent-1', sessionId: 'session-1' },
            requestId: 'selection-1',
            kind: 'file'
          }
        )
      ).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    } finally {
      errorLog.mockRestore()
    }
  })

  it('registers svcManagedMedia on ipcMain', () => {
    initServerIpc()
    expect(handleMock).toHaveBeenCalledWith(
      'svcManagedMedia.ensureDerivative',
      expect.any(Function)
    )
  })

  it('registers svcCanvasThumbnail unary methods on ipcMain', () => {
    initServerIpc()

    for (const methodName of CANVAS_THUMBNAIL_METHODS) {
      expect(apiDef.svcCanvasThumbnail[methodName].type).toBe('unary')
      expect(handleMock).toHaveBeenCalledWith(
        `svcCanvasThumbnail.${methodName}`,
        expect.any(Function)
      )
    }
  })
})
