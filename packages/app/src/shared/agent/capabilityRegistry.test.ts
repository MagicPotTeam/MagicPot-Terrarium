import { describe, expect, it } from 'vitest'
import {
  AgentCapabilityRegistry,
  normalizeAgentCapabilityDescriptor,
  type AgentCapabilityDescriptor
} from './capabilityRegistry'

const baseCapability: AgentCapabilityDescriptor = {
  capabilityId: ' cap.demo ',
  name: ' Demo Capability ',
  kind: 'tool',
  description: ' Demo description ',
  version: ' 1.2.3 ',
  scope: 'session',
  transport: ['internal', 'internal', 'mcp'],
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  metadata: { source: 'test' }
}

describe('AgentCapabilityRegistry', () => {
  it('normalizes descriptors while preserving optional schemas and metadata', () => {
    expect(normalizeAgentCapabilityDescriptor(baseCapability)).toEqual({
      capabilityId: 'cap.demo',
      name: 'Demo Capability',
      kind: 'tool',
      description: 'Demo description',
      version: '1.2.3',
      scope: 'session',
      transport: ['internal', 'mcp'],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      metadata: { source: 'test' }
    })
  })

  it('falls back to stable descriptor defaults', () => {
    expect(
      normalizeAgentCapabilityDescriptor({
        capabilityId: '',
        name: '',
        kind: 'resource',
        description: '',
        version: '',
        scope: 'global',
        transport: []
      })
    ).toMatchObject({
      capabilityId: 'unknown',
      name: 'unknown',
      description: '',
      version: '0.0.0',
      transport: ['internal']
    })
  })

  it('registers, filters, snapshots, removes, and clears capabilities', () => {
    const registry = new AgentCapabilityRegistry()
    const [tool, resource] = registry.registerMany([
      baseCapability,
      {
        capabilityId: 'resource.demo',
        name: 'Resource Demo',
        kind: 'resource',
        description: 'Resource description',
        version: '1.0.0',
        scope: 'workspace',
        transport: ['http']
      }
    ])

    expect(registry.get(' cap.demo ')).toEqual(tool)
    expect(registry.get(undefined as unknown as string)).toBeUndefined()
    expect(registry.has('resource.demo')).toBe(true)
    expect(registry.has(undefined as unknown as string)).toBe(false)
    expect(registry.list({ kind: 'tool' })).toEqual([tool])
    expect(registry.list({ scope: 'workspace' })).toEqual([resource])
    expect(registry.snapshot()).toHaveLength(2)

    expect(registry.remove(' cap.demo ')).toBe(true)
    expect(registry.has('cap.demo')).toBe(false)
    expect(registry.remove(undefined as unknown as string)).toBe(false)
    expect(registry.remove('missing')).toBe(false)

    registry.clear()
    expect(registry.list()).toEqual([])
  })
})
