import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginPlanningAuditEvent } from '@shared/figplugin/planningAudit'
import type { FigPluginBridgeController } from '../figplugin/bridgeController'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { FigPluginCenterSvcImpl, disposeFigPluginBridges } from './svcFigPluginCenterImpl'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  showMessageBox: vi.fn(),
  createController: vi.fn(),
  createModel: vi.fn(),
  executionStore: vi.fn(),
  planningStore: vi.fn(),
  recordPlanning: vi.fn(),
  recordExecution: vi.fn(),
  flushPlanning: vi.fn(),
  flushExecution: vi.fn(),
  list: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: mocks.getPath, isPackaged: false },
  dialog: { showMessageBox: mocks.showMessageBox },
  clipboard: {},
  shell: {}
}))
vi.mock('../figplugin/executionAudit', () => ({
  getFigPluginExecutionAuditStore: mocks.executionStore,
  flushFigPluginExecutionAuditStores: mocks.flushExecution
}))
vi.mock('../figplugin/planningAudit', () => ({
  getFigPluginPlanningAuditStore: mocks.planningStore,
  flushFigPluginPlanningAuditStores: mocks.flushPlanning
}))
vi.mock('./svcLLMProxyImpl', () => ({
  LLMProxySvcImpl: class {
    constructor() {
      mocks.createModel()
    }
  }
}))
vi.mock('../figplugin/bridgeController', () => ({
  FigPluginBridgeController: class {
    constructor(...args: unknown[]) {
      mocks.createController(...args)
    }
    resolveBinding = vi.fn(async () => ({
      pluginId: 'owned.figma',
      host: 'figma',
      projectId: 'owned-project',
      profileId: 'owned-profile',
      bridgeOrigin: 'http://127.0.0.1:41234',
      signerFingerprint: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64)
    }))
    dispose = mocks.dispose
  }
}))
const URL = 'file:///app/index.html#/workshop/plugins'
const root = path.join(os.tmpdir(), 'figplugin-planning-wiring-fixture')
const invocation = (method: string) => ({
  methodName: `svcFigPluginCenter.${method}`,
  senderId: 42,
  senderUrl: URL,
  frameUrl: URL,
  isMainFrame: true
})
const event: FigPluginPlanningAuditEvent = {
  schemaVersion: 1,
  kind: 'planning',
  at: 1000,
  callId: 'a'.repeat(32),
  correlationId: 'b'.repeat(32),
  sequence: 1,
  requestId: 'owned-request',
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'owned-project',
  profileId: 'owned-profile',
  profileRevision: 'c'.repeat(64),
  featureId: 'plan-preview',
  state: 'awaiting-approval',
  durationMs: 0,
  inputBytes: 1024,
  estimatedInputTokens: 256,
  nodeCount: 1,
  imageCount: 0,
  imageBytes: 0
}
const fixture = () => {
  const window = {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: () => false,
      getURL: () => URL
    })
  }
  registerMagicAgentTrustedRouteBinding(42, undefined, {
    trustedUrl: URL,
    trustedWebContents: window.webContents
  })
  return new FigPluginCenterSvcImpl(undefined, () => window as unknown as BrowserWindow)
}
const controllerOptions = () =>
  mocks.createController.mock.calls[0][2] as NonNullable<
    ConstructorParameters<typeof FigPluginBridgeController>[2]
  >

beforeEach(() => {
  vi.resetAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  mocks.getPath.mockReturnValue(root)
  mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
  mocks.list.mockResolvedValue([])
  mocks.executionStore.mockReturnValue({ record: mocks.recordExecution })
  mocks.planningStore.mockReturnValue({
    record: mocks.recordPlanning,
    list: mocks.list,
    writeFailed: false
  })
  mocks.flushPlanning.mockResolvedValue(undefined)
  mocks.flushExecution.mockResolvedValue(undefined)
  mocks.dispose.mockResolvedValue(undefined)
})
afterEach(async () => {
  await disposeFigPluginBridges()
  clearMagicAgentTrustedRouteBindingsForTest()
})

describe('production planning audit wiring', () => {
  it('only opens the bounded planning store for explicit history reads, without lazy runtime construction', async () => {
    const service = fixture()
    expect(mocks.getPath).not.toHaveBeenCalled()
    expect(await service.planningHistory({}, invocation('planningHistory'))).toMatchObject({
      records: []
    })
    expect(mocks.planningStore).toHaveBeenCalledExactlyOnceWith(path.join(root, 'figplugin-center'))
    expect(mocks.executionStore).not.toHaveBeenCalled()
    expect(mocks.createController).not.toHaveBeenCalled()
    expect(mocks.createModel).not.toHaveBeenCalled()
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })

  it('passes a separate planning-audit sink into the production Bridge factory', async () => {
    const service = fixture()
    await expect(
      service.createPairing(
        {
          pluginId: 'owned.figma',
          expectedGeneration: 1,
          projectId: 'owned-project'
        },
        invocation('createPairing')
      )
    ).resolves.toBeNull()
    expect(mocks.createController).toHaveBeenCalledTimes(1)
    expect(mocks.createModel).toHaveBeenCalledTimes(1)
    expect(mocks.planningStore).toHaveBeenCalledExactlyOnceWith(path.join(root, 'figplugin-center'))
    controllerOptions().planningAudit?.(event)
    expect(mocks.recordPlanning).toHaveBeenCalledExactlyOnceWith(event)
    expect(mocks.recordExecution).not.toHaveBeenCalled()
  })

  it('awaits controller terminal events before flushing both audit stores at desktop shutdown', async () => {
    const service = fixture()
    await service.createPairing(
      {
        pluginId: 'owned.figma',
        expectedGeneration: 1,
        projectId: 'owned-project'
      },
      invocation('createPairing')
    )
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    mocks.dispose.mockImplementation(async () => {
      await finished
      controllerOptions().planningAudit?.({
        ...event,
        sequence: 2,
        state: 'cancelled',
        errorCode: 'CANCELLED'
      })
    })
    const shutdown = disposeFigPluginBridges()
    expect(mocks.flushPlanning).not.toHaveBeenCalled()
    expect(mocks.flushExecution).not.toHaveBeenCalled()
    finish()
    await shutdown
    expect(mocks.recordPlanning).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'cancelled' })
    )
    expect(mocks.flushPlanning).toHaveBeenCalledTimes(1)
    expect(mocks.flushExecution).toHaveBeenCalledTimes(1)
    expect(mocks.recordPlanning.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.flushPlanning.mock.invocationCallOrder[0]
    )
  })
})
