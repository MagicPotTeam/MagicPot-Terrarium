import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { beforeShow } from './lifeCycle'
import { createMainWindow } from './mainWindow'
import * as controls from './winControls'

const h = vi.hoisted(() => ({
  server: vi.fn(), storageInstall: vi.fn((_window: unknown, _url: string, _getMainWindow: () => Electron.BrowserWindow | null) => () => {}), catalogInstall: vi.fn((_window: unknown, _url: string, _getMainWindow: () => Electron.BrowserWindow | null) => () => {}),
  calls: vi.fn(), init: vi.fn(async () => {}), heavy: vi.fn(), stop: new Error('stop at IPC injection fixture'),
  scheduler: { restorePersistedSnapshot: vi.fn(async () => {}), submitSnapshot: vi.fn(), stop: vi.fn(async () => {}) }
}))
class FakeContents extends EventEmitter {
  readonly id = 57
  setWindowOpenHandler = vi.fn()
}
class FakeWindow extends EventEmitter {
  destroyed = false
  readonly webContents = new FakeContents()
  loadURL = vi.fn()
  isDestroyed() { return this.destroyed }
}
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/mock-only' }, ipcMain: { handle: h.calls }, BrowserWindow: vi.fn(function () { return new FakeWindow() }), nativeImage: {}, screen: {}, shell: {} }))
vi.mock('../../../runtime-assets/resources/icon.png?asset', () => ({ default: 'mock-icon' }))
vi.mock('./unsavedChanges', () => ({ unsavedChangesController: { attach: h.calls, registerIpc: h.calls, confirm: h.calls } }))
vi.mock('./config/buildEnv', () => ({ isDev: () => false }))
vi.mock('./testUiPolicy', () => ({ resolveTestArtifactPath: h.heavy }))
vi.mock('./testWindowRuntime', () => ({ getTestWindowPolicy: () => ({ noFocus: false, suppressTaskbar: false, hideWindow: false }), resolveConfiguredTestWindowPlacement: () => null, showWindowForTestPolicy: h.calls }))
vi.mock('./rendererDiagnostics', () => ({ attachRendererDiagnostics: h.calls }))
vi.mock('./windowState', () => ({ attachWindowStatePersistence: h.calls, readWindowState: () => ({ state: { width: 800, height: 600, x: 0, y: 0, isMaximized: false }, hasSavedState: false }) }))
vi.mock('./utils/externalUrl', () => ({ normalizeAllowedExternalUrl: h.heavy }))
vi.mock('./utils/rendererNavigation', () => ({ isTrustedRendererNavigation: h.heavy }))
vi.mock('./localMediaAccess', () => ({ authorizeScopedLocalMediaPath: h.heavy }))
vi.mock('./magicAgentRuntime/trustedRouteBinding', () => ({ registerMagicAgentTrustedRouteBinding: h.calls, unregisterMagicAgentTrustedRouteBinding: h.calls }))
vi.mock('./storageMetadata/startupStorageReadBinding', () => ({ installStartupStorageReadBinding: h.storageInstall }))
vi.mock('./magicAgentRuntime/installedCatalogReadBinding', () => ({ installInstalledCatalogReadBinding: h.catalogInstall }))
vi.mock('./api/serverIpc', () => ({ initServerIpc: h.server }))
vi.mock('./api/magicAgentSdkHttpServer', () => ({ startMagicAgentSdkHttpServer: h.heavy }))
vi.mock('./api/svcMagicAgentPlatformImpl', () => ({ MagicAgentPlatformSvcImpl: h.heavy }))
vi.mock('./llmProxy/managedMediaCleanupScheduler', () => ({ createManagedMediaCleanupScheduler: () => h.scheduler }))
vi.mock('./llmProxy/managedMediaCleanup', () => ({ cleanupManagedMediaStagingOnShutdown: h.heavy }))
vi.mock('./llmProxy/managedMediaReferenceSnapshotStore', () => ({ loadManagedMediaReferenceSnapshot: h.heavy, persistManagedMediaReferenceSnapshot: h.heavy }))
vi.mock('./llmProxy/chatMediaDir', () => ({ getChatMediaDir: () => '/mock-only/media' }))
vi.mock('./agentKernel/runtime', () => ({ initializeAgentKernelRuntime: h.heavy, refreshAgentKernelRuntime: h.heavy }))
vi.mock('./comfy/state', () => ({ initComfyStateListener: h.calls, stopComfyStateListener: h.heavy }))
vi.mock('./config/config', () => ({ getConfig: h.heavy, initConfig: h.init, listenConfig: h.heavy }))
vi.mock('./llmProxy/server', () => ({ startLLMProxyServer: h.heavy, stopLLMProxyServer: h.heavy }))
vi.mock('./mcp/platform/runtime', () => ({ readMagicPotMcpPlatformEnv: () => ({ enableStdioServer: false }), syncMagicPotMcpPlatformDesktopTransports: h.heavy, stopMagicPotMcpPlatformRuntime: h.heavy }))
vi.mock('./magicAgentPlatform2/productionRuntime', () => ({ closeAssistantTerminalPolicyRuntime: h.heavy, getAssistantTerminalPolicyRuntime: h.heavy }))
vi.mock('./magicAgentPlatform2/channels/runtimeChannelAgentWakeAdapter', () => ({ createRuntimeChannelAgentWakeAdapter: h.heavy }))
vi.mock('./magicAgentPlatform2/channels/runtimeChannelGraphWakeAdapter', () => ({ createRuntimeChannelGraphWakeAdapter: h.heavy }))
vi.mock('./magicAgentPlatform2/channels/runtimeChannelWakeRouter', () => ({ RuntimeChannelWakeRouter: h.heavy }))
vi.mock('./magicAgentPlatform2/channels/productionRuntimeChannelLifecycle', () => ({ closeProductionRuntimeChannelLifecycle: h.heavy, startProductionRuntimeChannelLifecycle: h.heavy }))
vi.mock('./magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner', () => ({ closeProductionAgentInstanceLifecycle: h.heavy, startProductionAgentInstanceLifecycle: h.heavy }))
vi.mock('./magicAgentPlatform2/drives/productionDriveLifecycle', () => ({ closeProductionDriveLifecycle: h.heavy, createProductionDriveDelivery: h.heavy, startProductionDriveLifecycle: h.heavy }))
vi.mock('./magicAgentPlatform2/triggers/productionTriggerLifecycle', () => ({ closeProductionTriggerLifecycle: h.heavy, startProductionTriggerLifecycle: h.heavy }))
vi.mock('./mcp/platform/httpBridge', () => ({ closeMagicPotMcpLegacySseSessions: h.heavy }))
vi.mock('./mcp/runtime', () => ({ stopMcpClientManager: h.heavy, syncMcpClientManager: h.heavy }))
vi.mock('./queue/taskQueue', () => ({ initTaskQueue: h.init, stopTaskQueue: h.heavy }))
vi.mock('./subprocess/subprocess', () => ({ cleanupSubProcesses: h.heavy }))
vi.mock('./api/svcFigPluginCenterImpl', () => ({ disposeFigPluginBridges: h.heavy }))
vi.mock('./utils/loggingOverride', () => ({ setConsoleTransportEnabled: h.heavy }))
vi.mock('./figplugin/checkpointEncryption', () => ({ createCheckpointStore: h.heavy }))
vi.mock('./figplugin/checkpointCleanupScheduler', () => ({ createCheckpointCleanupScheduler: () => ({ start: h.calls, stop: h.heavy }) }))

beforeEach(() => { vi.clearAllMocks(); h.server.mockImplementation(() => { throw h.stop }) })
describe('actual lifecycle and MainWindow share one lazy authoritative getter callable — mocked stop at IPC injection', () => {
  it('uses the SAME exported callable across both consumers without booting runtime/provider or capturing a window', async () => {
    const getter = (controls as unknown as { getAuthoritativeMainWindow: () => Electron.BrowserWindow | null }).getAuthoritativeMainWindow
    expect(getter).toBeTypeOf('function')
    const read = vi.spyOn(controls.winController, 'getMainWindow')
    const first = createMainWindow() as unknown as FakeWindow
    expect(h.storageInstall).toHaveBeenCalledOnce(); expect(h.storageInstall.mock.calls[0]?.[2]).toBe(getter)
    expect(read).not.toHaveBeenCalled()
    await expect(beforeShow()).rejects.toBe(h.stop) // Mock halts before runtime/kernel/MCP/provider steps.
    expect(h.server).toHaveBeenCalledExactlyOnceWith(h.scheduler, getter)
    expect(h.server.mock.calls[0]?.[1]).toBe(h.storageInstall.mock.calls[0]?.[2])
    expect(read).not.toHaveBeenCalled(); expect(h.heavy).not.toHaveBeenCalled()
    expect(getter()).toBe(first)
    const second = createMainWindow() as unknown as FakeWindow; expect(getter()).toBe(second)
    second.destroyed = true; expect(getter()).toBeNull()
    first.emit('closed'); second.emit('closed'); read.mockRestore()
  })
})
