import type { Config } from '@shared/config/config'
import { initServerIpc } from './api/serverIpc'
import {
  startMagicAgentSdkHttpServer,
  type MagicAgentSdkHttpServer
} from './api/magicAgentSdkHttpServer'
import { MagicAgentPlatformSvcImpl } from './api/svcMagicAgentPlatformImpl'
import {
  createManagedMediaCleanupScheduler,
  type ManagedMediaCleanupScheduler
} from './llmProxy/managedMediaCleanupScheduler'
import { initializeAgentKernelRuntime, refreshAgentKernelRuntime } from './agentKernel/runtime'
import { getComfyInstanceRegistry } from './comfy/instancePool'
import { closeComfyOutputRouteStore } from './comfy/outputRouteStore'
import { bootstrapManagedLocalComfyInstance } from './comfy/managedLocalInstance'
import { initComfyStateListener, stopComfyStateListener } from './comfy/state'
import { getBuildEnv } from './config/buildEnv'
import { getConfig, initConfig, listenConfig } from './config/config'
import { startLLMProxyServer, stopLLMProxyServer } from './llmProxy/server'
import {
  readMagicPotMcpPlatformEnv,
  syncMagicPotMcpPlatformDesktopTransports,
  stopMagicPotMcpPlatformRuntime
} from './mcp/platform/runtime'
import {
  closeAssistantTerminalPolicyRuntime,
  getAssistantTerminalPolicyRuntime
} from './magicAgentPlatform2/productionRuntime'
import { createRuntimeChannelAgentWakeAdapter } from './magicAgentPlatform2/channels/runtimeChannelAgentWakeAdapter'
import { createRuntimeChannelGraphWakeAdapter } from './magicAgentPlatform2/channels/runtimeChannelGraphWakeAdapter'
import { RuntimeChannelWakeRouter } from './magicAgentPlatform2/channels/runtimeChannelWakeRouter'
import {
  closeProductionRuntimeChannelLifecycle,
  startProductionRuntimeChannelLifecycle
} from './magicAgentPlatform2/channels/productionRuntimeChannelLifecycle'
import {
  closeProductionAgentInstanceLifecycle,
  startProductionAgentInstanceLifecycle
} from './magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner'
import {
  closeProductionDriveLifecycle,
  createProductionDriveDelivery,
  startProductionDriveLifecycle
} from './magicAgentPlatform2/drives/productionDriveLifecycle'
import {
  closeProductionTriggerLifecycle,
  startProductionTriggerLifecycle
} from './magicAgentPlatform2/triggers/productionTriggerLifecycle'
import { closeMagicPotMcpLegacySseSessions } from './mcp/platform/httpBridge'
import { stopMcpClientManager, syncMcpClientManager } from './mcp/runtime'
import { initTaskQueue, stopTaskQueue } from './queue/taskQueue'
import { cleanupSubProcesses } from './subprocess/subprocess'
import { setConsoleTransportEnabled } from './utils/loggingOverride'
import { winController } from './winControls'

let managedMediaCleanupScheduler: ManagedMediaCleanupScheduler | undefined
let magicAgentSdkHttpServer: MagicAgentSdkHttpServer | undefined

async function runLifecycleStep(
  stepName: string,
  action: () => void | Promise<void>
): Promise<boolean> {
  try {
    await action()
    console.log(`[App] ${stepName}`)
    return true
  } catch (error) {
    console.error(`[App] ${stepName} failed`, error)
    return false
  }
}

function syncRuntimeServices(config?: Config): Promise<void> {
  return syncMcpClientManager(config)
}

async function refreshRuntimeServices(
  config: Config,
  mcpPlatformEnv: ReturnType<typeof readMagicPotMcpPlatformEnv>
): Promise<void> {
  await syncRuntimeServices(config)
  refreshAgentKernelRuntime()
  await syncMagicPotMcpPlatformDesktopTransports(mcpPlatformEnv)
}

function syncLlmProxyServer(config: Config): void {
  stopLLMProxyServer()
  if (config.local_llm_server_config?.enable_server) {
    startLLMProxyServer()
  }
}

async function startBackgroundTasks(
  policyRuntime: ReturnType<typeof getAssistantTerminalPolicyRuntime>
): Promise<void> {
  // Hydration/reconciliation is a readiness prerequisite. Do not expose either renderer IPC or
  // the Comfy event stream while durable ordinary jobs are still being reconstructed.
  await initTaskQueue({ eventStore: policyRuntime.eventStore })
  initComfyStateListener()
  winController.initIpc()
  if (!managedMediaCleanupScheduler) {
    managedMediaCleanupScheduler = createManagedMediaCleanupScheduler()
  }
  initServerIpc(managedMediaCleanupScheduler)
}

function registerRuntimeServiceManager(
  mcpPlatformEnv: ReturnType<typeof readMagicPotMcpPlatformEnv>
): void {
  listenConfig({
    id: 'runtime-service-manager',
    onEvent: async (config) => {
      bootstrapManagedLocalComfyInstance({
        config,
        buildEnv: getBuildEnv(),
        registry: getComfyInstanceRegistry()
      })
      await refreshRuntimeServices(config, mcpPlatformEnv)
      syncLlmProxyServer(config)
    },
    onEnd: async () => {}
  })
}

export async function beforeShow() {
  const mcpPlatformEnv = readMagicPotMcpPlatformEnv()
  if (mcpPlatformEnv.enableStdioServer) {
    setConsoleTransportEnabled(false)
  }

  console.log('[App] beforeShow started')

  const configInitialized = await runLifecycleStep('Config initialized', () => initConfig())
  if (configInitialized) {
    await runLifecycleStep('Managed local ComfyUI registry bootstrapped', () => {
      bootstrapManagedLocalComfyInstance({
        config: getConfig(),
        buildEnv: getBuildEnv(),
        registry: getComfyInstanceRegistry()
      })
    })
  }

  console.log('[App] Launching background tasks...')

  const policyRuntime = getAssistantTerminalPolicyRuntime()
  const backgroundTasksInitialized = await runLifecycleStep('Background tasks initialized', () =>
    startBackgroundTasks(policyRuntime)
  )
  if (!backgroundTasksInitialized) {
    throw new Error('Background task readiness failed; IPC was not exposed.')
  }

  await runLifecycleStep('Runtime services synced', async () => {
    await syncRuntimeServices()
    initializeAgentKernelRuntime()
    await syncMagicPotMcpPlatformDesktopTransports(mcpPlatformEnv)
  })

  await runLifecycleStep('LLM server started', () => startLLMProxyServer())
  const platformService = new MagicAgentPlatformSvcImpl()
  startProductionTriggerLifecycle({
    policyRuntime,
    service: platformService
  })
  const channels = startProductionRuntimeChannelLifecycle({
    eventStore: policyRuntime.eventStore,
    authorization: policyRuntime.authorization
  })
  const agents = startProductionAgentInstanceLifecycle({
    eventStore: policyRuntime.eventStore,
    authorization: policyRuntime.authorization,
    platformService
  })
  const wakeRouter = new RuntimeChannelWakeRouter(
    channels.store,
    createRuntimeChannelAgentWakeAdapter(agents),
    createRuntimeChannelGraphWakeAdapter(platformService)
  )
  channels.subscribeWake((event) => void wakeRouter.route(event))
  startProductionDriveLifecycle({
    eventStore: policyRuntime.eventStore,
    deliver: createProductionDriveDelivery(platformService)
  })
  const sdkServerConfig = getConfig().magic_agent_sdk_server_config
  if (sdkServerConfig.enable_server) {
    if (!sdkServerConfig.access_token.trim())
      throw new Error('MagicAgent SDK server requires a non-empty access token.')
    if (!sdkServerConfig.actor_kind.trim() || !sdkServerConfig.actor_id.trim())
      throw new Error('MagicAgent SDK server requires a non-empty authenticated actor kind and id.')
    magicAgentSdkHttpServer = await startMagicAgentSdkHttpServer({
      token: sdkServerConfig.access_token,
      authenticatedActor: { kind: sdkServerConfig.actor_kind, id: sdkServerConfig.actor_id },
      port: sdkServerConfig.port,
      service: platformService
    })
    console.log(`[MagicAgent SDK] listening on ${magicAgentSdkHttpServer.baseUrl}`)
  }
  registerRuntimeServiceManager(mcpPlatformEnv)

  console.log('[App] beforeShow finished')
}

export async function beforeQuit() {
  await runLifecycleStep('LLM server stopped', () => stopLLMProxyServer())
  await runLifecycleStep('MCP legacy SSE sessions stopped', () =>
    closeMagicPotMcpLegacySseSessions()
  )
  await runLifecycleStep('MCP clients stopped', () => stopMcpClientManager())
  await runLifecycleStep('MCP platform stopped', () => stopMagicPotMcpPlatformRuntime())
  await runLifecycleStep('Comfy listener stopped', () => stopComfyStateListener())
  await runLifecycleStep('Managed media cleanup scheduler stopped', async () => {
    await managedMediaCleanupScheduler?.stop()
    managedMediaCleanupScheduler = undefined
  })
  await runLifecycleStep('MagicAgent SDK server stopped', async () => {
    await magicAgentSdkHttpServer?.close()
    magicAgentSdkHttpServer = undefined
  })
  await runLifecycleStep('Subprocess cleanup finished', async () => {
    console.log('[App] Cleaning subprocesses...')
    await cleanupSubProcesses()
  })
  await runLifecycleStep('Runtime Channel lifecycle stopped', () =>
    closeProductionRuntimeChannelLifecycle()
  )
  await runLifecycleStep('Agent instance lifecycle stopped', () =>
    closeProductionAgentInstanceLifecycle()
  )
  await runLifecycleStep('Drive lifecycle stopped', () => closeProductionDriveLifecycle())
  await runLifecycleStep('Trigger lifecycle stopped', () => closeProductionTriggerLifecycle())
  await runLifecycleStep('Task queue cleanup finished', () => stopTaskQueue())
  await runLifecycleStep('Policy runtime stopped', () => closeAssistantTerminalPolicyRuntime())
  await runLifecycleStep('Comfy output route store closed', () => closeComfyOutputRouteStore())
}
