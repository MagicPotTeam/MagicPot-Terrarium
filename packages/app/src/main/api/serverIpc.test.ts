import { describe, expect, it, vi } from 'vitest'
import { apiDef } from '@shared/api'
import { createServer } from './serverIpc'

const { createServiceClass } = vi.hoisted(() => ({
  createServiceClass: () => class {}
}))

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0')
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
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

describe('serverIpc createServer', () => {
  it('creates the remaining service registry', () => {
    const api = createServer()

    expect(api.svcTargetScheme).toBeDefined()
    expect(apiDef.svcTargetScheme).toBeDefined()
    expect(api.svcAppUpdate).toBeDefined()
    expect(apiDef.svcAppUpdate).toBeDefined()
  })
})
