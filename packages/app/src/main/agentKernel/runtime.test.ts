import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentKernel } from './agentKernel'
import { buildMagicPotAppCatalogSnapshot } from '@shared/app/catalog'
import { getAssistantRuntime } from '../assistantRuntime/runtime'
import { getConfig } from '../config/config'
import { initializeMagicPotMcpPlatformRuntime } from '../mcp/platform/runtime'

vi.mock('@shared/app/catalog', () => ({
  buildMagicPotAppCatalogSnapshot: vi.fn()
}))

vi.mock('../assistantRuntime/runtime', () => ({
  getAssistantRuntime: vi.fn()
}))

vi.mock('../config/config', () => ({
  getConfig: vi.fn()
}))

vi.mock('../mcp/platform/runtime', () => ({
  initializeMagicPotMcpPlatformRuntime: vi.fn()
}))

describe('AgentKernelRuntime', () => {
  beforeEach(() => {
    getAgentKernel().clear()
    vi.mocked(getConfig).mockReturnValue({ client_id: 'client-1' } as ReturnType<typeof getConfig>)
    vi.mocked(getAssistantRuntime).mockReturnValue({
      listTools: () => [{ name: 'tool.one' }]
    } as ReturnType<typeof getAssistantRuntime>)
    vi.mocked(initializeMagicPotMcpPlatformRuntime).mockReset()
    vi.mocked(buildMagicPotAppCatalogSnapshot).mockReset()
  })

  it('initializes MCP runtime, registers app surface capabilities, and refreshes stale surfaces', async () => {
    vi.mocked(buildMagicPotAppCatalogSnapshot)
      .mockReturnValueOnce({
        schemaVersion: 1,
        generatedAt: '2026-05-14T00:00:00.000Z',
        apps: [
          {
            id: 'chat',
            name: 'Chat',
            description: 'Chat surface',
            enabled: true,
            source: 'builtin',
            transport: 'local',
            status: 'ready',
            capabilities: { tools: [], resources: [] }
          }
        ]
      } as ReturnType<typeof buildMagicPotAppCatalogSnapshot>)
      .mockReturnValueOnce({
        schemaVersion: 1,
        generatedAt: '2026-05-14T00:01:00.000Z',
        apps: [
          {
            id: 'canvas',
            name: 'Canvas',
            description: 'Canvas surface',
            enabled: true,
            source: 'builtin',
            transport: 'local',
            status: 'ready',
            capabilities: { tools: [], resources: [] }
          }
        ]
      } as ReturnType<typeof buildMagicPotAppCatalogSnapshot>)

    const {
      describeAgentKernelRuntimeStatus,
      initializeAgentKernelRuntime,
      refreshAgentKernelRuntime
    } = await import('./runtime')

    initializeAgentKernelRuntime()

    expect(initializeMagicPotMcpPlatformRuntime).toHaveBeenCalledWith(
      { client_id: 'client-1' },
      { toolCatalog: [{ name: 'tool.one' }] }
    )
    expect(
      getAgentKernel()
        .listCapabilities()
        .map((capability) => capability.capabilityId)
    ).toEqual(['surface.chat'])

    refreshAgentKernelRuntime()

    expect(
      getAgentKernel()
        .listCapabilities()
        .map((capability) => capability.capabilityId)
    ).toEqual(['surface.canvas'])
    expect(describeAgentKernelRuntimeStatus()).toEqual({
      sessionCount: 0,
      capabilityCount: 1,
      runCount: 0,
      eventCount: 2
    })
  })
})
