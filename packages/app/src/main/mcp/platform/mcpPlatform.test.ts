import { describe, expect, it } from 'vitest'
import { type McpCapabilitySource } from '@shared/agent/mcpPlatform'
import { MagicPotMcpPlatform } from './mcpPlatform'
import { McpCapabilityRegistry } from './capabilityRegistry'

const buildSource = (overrides: Partial<McpCapabilitySource> = {}): McpCapabilitySource => ({
  id: 'core',
  label: 'MagicPot Core',
  scope: 'global',
  version: '1.0.0',
  bundle: {
    tools: [
      {
        name: 'platform.health',
        description: 'Health snapshot'
      }
    ],
    resources: [
      {
        uri: 'magicpot://mcp/platform/health',
        name: 'platform.health',
        description: 'Health snapshot'
      }
    ],
    prompts: [
      {
        name: 'platform.system',
        description: 'Summarize the platform'
      }
    ]
  },
  ...overrides
})

describe('McpCapabilityRegistry', () => {
  it('deduplicates capabilities across sources and records sessions', () => {
    const registry = new McpCapabilityRegistry({
      name: 'magicpot-mcp-platform',
      version: '1.0.0'
    })

    registry.registerSource(buildSource())
    registry.registerSource(
      buildSource({
        id: 'duplicate',
        label: 'Duplicate source',
        bundle: {
          tools: [
            {
              name: 'platform.health'
            }
          ],
          resources: [],
          prompts: []
        }
      })
    )
    registry.registerSession({
      sessionId: 'session-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'active'
    })

    const snapshot = registry.snapshot()
    expect(snapshot.capabilities.tools).toHaveLength(1)
    expect(snapshot.sessions).toHaveLength(1)
    expect(registry.negotiate().server.capabilities.health).toBe(true)
  })
})

describe('MagicPotMcpPlatform', () => {
  it('exposes inspection surfaces and lifecycle snapshots', () => {
    const platform = new MagicPotMcpPlatform({
      name: 'magicpot-mcp-platform',
      version: '1.0.0'
    })

    platform.registerSource(buildSource())

    expect(platform.negotiate().server.name).toBe('magicpot-mcp-platform')
    expect(platform.describeHealth().counts.tools).toBe(1)
    expect(platform.describeHealth().state).toBe('created')
    expect(platform.listAuditEntries()).toHaveLength(0)
  })

  it('tracks runtime-managed streamable http transport snapshots in the shared health model', () => {
    const platform = new MagicPotMcpPlatform({
      name: 'magicpot-mcp-platform',
      version: '1.0.0'
    })

    platform.updateTransportSnapshot({
      kind: 'streamable-http',
      status: 'ready',
      endpoint: '/api/mcp'
    })

    expect(platform.describeHealth().transports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'streamable-http',
          status: 'ready',
          endpoint: '/api/mcp'
        })
      ])
    )

    platform.updateTransportSnapshot({
      kind: 'streamable-http',
      status: 'stopped',
      endpoint: '/api/mcp'
    })

    expect(platform.describeHealth().transports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'streamable-http',
          status: 'stopped',
          endpoint: '/api/mcp'
        })
      ])
    )
  })
})
