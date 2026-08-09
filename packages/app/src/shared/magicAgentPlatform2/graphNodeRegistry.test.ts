import { describe, expect, it } from 'vitest'
import {
  GRAPH_V2_FIRST_PARTY_NODE_CATEGORIES,
  GRAPH_V2_FIRST_PARTY_NODE_REGISTRY,
  validateGraphV2FirstPartyNodeConfig
} from './graphNodeRegistry'

describe('Graph V2 first-party node registry', () => {
  it('represents every required first-party category', () => {
    expect(new Set(GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.map((item) => item.category))).toEqual(
      new Set(GRAPH_V2_FIRST_PARTY_NODE_CATEGORIES)
    )
  })

  it('has coherent execution, ports, schemas, and defaults', () => {
    expect(new Set(GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.map((item) => item.kind)).size).toBe(
      GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.length
    )
    for (const descriptor of GRAPH_V2_FIRST_PARTY_NODE_REGISTRY) {
      expect(descriptor.executable).toBe(descriptor.execution.mode !== 'unsupported')
      expect(
        validateGraphV2FirstPartyNodeConfig(descriptor.kind, descriptor.defaultConfig)
      ).toEqual(
        Object.values(descriptor.configSchema.properties).some((field) => field.required) &&
          Object.entries(descriptor.defaultConfig).some(([, value]) => value === '')
          ? expect.any(Array)
          : []
      )
      for (const [key, value] of Object.entries(descriptor.defaultConfig)) {
        const field = descriptor.configSchema.properties[key]
        expect(field).toBeDefined()
        expect(field.default).toEqual(value)
      }
      for (const port of descriptor.defaultInputs) expect(port.direction).toBe('input')
      for (const port of descriptor.defaultOutputs) expect(port.direction).toBe('output')
      expect(
        new Set(
          [...descriptor.defaultInputs, ...descriptor.defaultOutputs].map((port) => port.portId)
        ).size
      ).toBe(descriptor.defaultInputs.length + descriptor.defaultOutputs.length)
      if (descriptor.execution.mode === 'unsupported')
        expect(descriptor.execution.reason).not.toBe('')
    }
  })

  it('reports precise invalid and unconfigured config reasons', () => {
    expect(validateGraphV2FirstPartyNodeConfig('tool', { toolName: '' })).toEqual([
      'Required tool config field is unconfigured: toolName.'
    ])
    expect(validateGraphV2FirstPartyNodeConfig('input', { inputMode: 'bad' })).toEqual([
      'Invalid input config field value: inputMode.'
    ])
    expect(validateGraphV2FirstPartyNodeConfig('missing', {})).toEqual([
      'Unsupported first-party Graph V2 node kind: missing.'
    ])
  })
})
