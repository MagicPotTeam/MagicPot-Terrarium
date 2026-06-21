import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiDef } from '@shared/api'
import { createServer, initServerIpc } from './serverIpc'

const CANVAS_THUMBNAIL_METHODS = [
  'getSourceFileMetadata',
  'getThumbnailCacheRoot',
  'readThumbnailManifest',
  'writeThumbnailSet',
  'generateThumbnailSet',
  'createNativeThumbnail'
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
  ipcMain: {
    handle: handleMock,
    on: onMock
  },
  MessagePortMain: class {}
}))

vi.mock('./svcAdobeBridgeImpl', () => ({ AdobeBridgeSvcImpl: createServiceClass() }))
vi.mock('./svcStateImpl', () => ({ StateSvcImpl: createServiceClass() }))
vi.mock('./svcComfyImpl', () => ({ ComfySvcImpl: createServiceClass() }))
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
