import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiDef } from '@shared/api'
import { createServer, initServerIpc } from './serverIpc'
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

const { createServiceClass, handleMock, onMock } = vi.hoisted(() => {
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
    onMock: vi.fn()
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
vi.mock('./svcStateImpl', () => ({ StateSvcImpl: createServiceClass() }))
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
vi.mock('./svcMagicAgentPlatformImpl', () => ({ MagicAgentPlatformSvcImpl: createServiceClass() }))
vi.mock('./svcManagedMediaImpl', () => ({ ManagedMediaSvcImpl: createServiceClass() }))
describe('serverIpc createServer', () => {
  beforeEach(() => {
    handleMock.mockClear()
    onMock.mockClear()
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
