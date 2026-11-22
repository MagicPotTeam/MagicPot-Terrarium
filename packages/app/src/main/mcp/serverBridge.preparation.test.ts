import { DEFAULT_CONFIG } from '@shared/config/config'
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const runtime = vi.hoisted(() => ({ access: vi.fn(() => { throw new Error('Preparation must not enter runtime') }) }))
vi.mock('./status', () => ({ getMcpRuntimeStatus: vi.fn(() => { throw new Error('Preparation must not query status') }) }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: runtime.access }))
import { createMagicPotMcpServer } from './serverBridge'

describe('canonical server preparation registration', () => {
  it('discovers and invokes offline preparation without runtime reads or extra config reads during invocation', async () => {
    const configProvider = vi.fn(() => structuredClone(DEFAULT_CONFIG))
    const server = createMagicPotMcpServer({ configProvider })
    const configReadsAfterConstruction = configProvider.mock.calls.length
    const client = new Client({ name: 'owned-memory-fixture', version: '1' })
    const [left, right] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(right), client.connect(left)])
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toContain('magicpot_validate_execution_preparation')
      const result = await client.callTool({ name: 'magicpot_validate_execution_preparation', arguments: { preparation: { backend: 'docker', label: 'fixture', context: 'local', container: 'existing' } } })
      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('executionEnabled')
      expect(runtime.access).not.toHaveBeenCalled()
      expect(configProvider).toHaveBeenCalledTimes(configReadsAfterConstruction)
    } finally { await client.close(); await server.close() }
  })
})
