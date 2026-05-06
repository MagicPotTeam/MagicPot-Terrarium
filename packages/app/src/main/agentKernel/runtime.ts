import { buildMagicPotAppCatalogSnapshot } from '@shared/app/catalog'
import { getAssistantRuntime } from '../assistantRuntime/runtime'
import { getConfig } from '../config/config'
import { getAgentKernel } from './agentKernel'
import { initializeMagicPotMcpPlatformRuntime } from '../mcp/platform/runtime'

class AgentKernelRuntime {
  private readonly managedCapabilityIds = new Set<string>()

  initialize(): void {
    this.refresh()
  }

  refresh(): void {
    const config = getConfig()
    const kernel = getAgentKernel()
    const runtime = getAssistantRuntime()
    const toolCatalog = runtime.listTools()

    initializeMagicPotMcpPlatformRuntime(config, {
      toolCatalog
    })

    for (const capabilityId of this.managedCapabilityIds) {
      kernel.removeCapability(capabilityId)
    }
    this.managedCapabilityIds.clear()

    const appSnapshot = buildMagicPotAppCatalogSnapshot(config)
    for (const app of appSnapshot.apps) {
      const surfaceCapabilityId = `surface.${app.id}`
      kernel.registerCapability({
        capabilityId: surfaceCapabilityId,
        name: app.name,
        kind: 'session',
        description: app.description,
        version: '1.0.0',
        scope: 'route',
        transport: ['internal'],
        metadata: {
          appId: app.id,
          appSource: app.source,
          appTransport: app.transport,
          appStatus: app.status
        }
      })
      this.managedCapabilityIds.add(surfaceCapabilityId)
    }
  }

  describeStatus() {
    const kernel = getAgentKernel()
    return {
      sessionCount: kernel.listSessions().length,
      capabilityCount: kernel.listCapabilities().length,
      runCount: kernel.listRuns().length,
      eventCount: kernel.listEvents().length
    }
  }
}

let runtimeSingleton: AgentKernelRuntime | null = null

export const getAgentKernelRuntime = (): AgentKernelRuntime => {
  if (!runtimeSingleton) {
    runtimeSingleton = new AgentKernelRuntime()
  }
  return runtimeSingleton
}

export const initializeAgentKernelRuntime = (): void => {
  getAgentKernelRuntime().initialize()
}

export const refreshAgentKernelRuntime = (): void => {
  getAgentKernelRuntime().refresh()
}

export const describeAgentKernelRuntimeStatus = () => getAgentKernelRuntime().describeStatus()
