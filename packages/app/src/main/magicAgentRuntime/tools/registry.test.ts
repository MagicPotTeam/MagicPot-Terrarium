import { describe, expect, it, vi } from 'vitest'
import { createMagicAgentCreativeToolRegistry } from './registry'
import type { MagicAgentCreativeToolAdapter } from './types'

const availableAdapter: MagicAgentCreativeToolAdapter = {
  definitions: () => [
    {
      name: 'demo.available',
      category: 'image',
      description: 'Available demo tool.',
      inputSchema: { type: 'object' },
      status: 'available',
      permissionLevel: 'read',
      requiresConfirmation: false,
      disabledByDefault: false
    }
  ],
  callTool: async (name, args) =>
    name === 'demo.available'
      ? {
          ok: true,
          toolName: name,
          category: 'image',
          status: 'available',
          data: { echoed: args.prompt }
        }
      : null
}

describe('MagicAgentCreativeToolRegistry', () => {
  it('returns structured unavailable responses for unknown tools', async () => {
    const registry = createMagicAgentCreativeToolRegistry({ adapters: [availableAdapter] })

    await expect(registry.dispatch('missing.tool')).resolves.toMatchObject({
      ok: false,
      toolName: 'missing.tool',
      status: 'unavailable',
      unavailableReason: 'Unknown MagicAgent creative tool: missing.tool'
    })
  })

  it('returns structured unavailable responses when no adapter accepts a listed tool', async () => {
    const registry = createMagicAgentCreativeToolRegistry({
      adapters: [
        {
          definitions: () => [
            {
              name: 'demo.orphan',
              category: 'asset',
              description: 'Listed but not callable.',
              inputSchema: { type: 'object' },
              status: 'unavailable',
              permissionLevel: 'read',
              requiresConfirmation: false,
              disabledByDefault: false,
              unavailableReason: 'Adapter is not loaded.'
            }
          ],
          callTool: async () => null
        }
      ]
    })

    await expect(registry.dispatch('demo.orphan')).resolves.toMatchObject({
      ok: false,
      toolName: 'demo.orphan',
      category: 'asset',
      status: 'unavailable',
      unavailableReason: 'Adapter is not loaded.'
    })
  })

  it('dispatches available tools through their adapter', async () => {
    const registry = createMagicAgentCreativeToolRegistry({ adapters: [availableAdapter] })

    await expect(registry.dispatch('demo.available', { prompt: 'hello' })).resolves.toMatchObject({
      ok: true,
      toolName: 'demo.available',
      category: 'image',
      status: 'available',
      data: { echoed: 'hello' }
    })
  })

  it('enforces confirmation/default-disabled metadata at the registry boundary', async () => {
    const callTool = vi.fn(async () => ({
      ok: true,
      toolName: 'demo.dangerous',
      category: 'terminal' as const,
      status: 'available' as const,
      data: { executed: true }
    }))
    const registry = createMagicAgentCreativeToolRegistry({
      adapters: [
        {
          definitions: () => [
            {
              name: 'demo.dangerous',
              category: 'terminal',
              description: 'Dangerous demo tool.',
              inputSchema: { type: 'object' },
              status: 'available',
              permissionLevel: 'destructive',
              requiresConfirmation: true,
              disabledByDefault: true
            }
          ],
          callTool
        }
      ]
    })

    await expect(registry.dispatch('demo.dangerous', { confirm: true })).resolves.toMatchObject({
      ok: false,
      permissionDenied: true,
      error: expect.stringContaining('trusted main-process confirmation')
    })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('marks mutating built-in tools as disabled by default and blocks self-confirmed calls', async () => {
    const registry = createMagicAgentCreativeToolRegistry({
      adapters: []
    })
    const terminalRegistry = createMagicAgentCreativeToolRegistry()
    const terminalTool = terminalRegistry.listTools().find((tool) => tool.name === 'terminal.run')

    expect(terminalTool).toMatchObject({
      permissionLevel: 'destructive',
      requiresConfirmation: true,
      disabledByDefault: true
    })
    await expect(
      terminalRegistry.dispatch(
        'terminal.run',
        { command: 'git', args: ['status'], confirm: true },
        {
          dependencies: {
            terminalRun: async () => ({ stdout: 'should-not-run' })
          }
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      permissionDenied: true,
      error: expect.stringContaining('trusted main-process confirmation')
    })
    expect(registry.listTools()).toEqual([])
  })
})
