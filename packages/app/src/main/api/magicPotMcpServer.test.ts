import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMagicPotPreparationMcpServer, MAGIC_POT_MCP_CAPABILITIES } from './magicPotMcpServer'

describe('minimal transport-neutral MCP server', () => {
  it('performs real SDK discovery/call over owned memory transport without desktop authority', async () => {
    const server = createMagicPotPreparationMcpServer()
    const client = new Client({ name: 'fixture', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const listed = await client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(['magicpot_capabilities', 'magicpot_validate_execution_preparation'])
      const result = await client.callTool({ name: 'magicpot_capabilities', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(MAGIC_POT_MCP_CAPABILITIES) }])
      const denied = await client.callTool({ name: 'magicpot_capabilities', arguments: { path: '/private' } })
      expect(denied.isError).toBe(true)
      const prepared = await client.callTool({ name: 'magicpot_validate_execution_preparation', arguments: { preparation: { backend: 'database', label: 'fixture', relativePath: 'data/fixture.sqlite', mode: 'read-only' } } })
      expect(prepared.isError).not.toBe(true)
      expect(JSON.stringify(prepared.content)).toContain('executionEnabled')
      const writeDenied = await client.callTool({ name: 'magicpot_validate_execution_preparation', arguments: { preparation: { backend: 'database', label: 'fixture', relativePath: '../private.db', mode: 'write' } } })
      expect(writeDenied.isError).toBe(true)
      const unknown = await client.callTool({ name: 'shell.execute', arguments: { code: 'never' } })
      expect(unknown.isError).toBe(true)
    } finally { await client.close(); await server.close() }
  })
})
