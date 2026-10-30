import { describe, expect, it } from 'vitest'
import { normalizeAgentDiagnosticsRequest } from './agentDiagnostics'

describe('diagnostic request boundary', () => {
  it('strips prompts, secrets, query, URLs, resources and arbitrary properties', () => {
    const input = {
      messages: [{ content: 'PRIVATE' }],
      url: 'https://PRIVATE',
      checkDns: true,
      profileId: 'model',
      token: 'PRIVATE',
      skillRuntime: {
        skillId: 'skill',
        instructions: { systemPrompt: 'PRIVATE' },
        resources: ['PRIVATE'],
        bindings: [
          {
            appId: 'app',
            source: 'assistant-runtime',
            toolNames: [],
            appName: 'PRIVATE',
            resourceUris: ['PRIVATE']
          }
        ]
      }
    }
    const result = normalizeAgentDiagnosticsRequest(input)
    expect(result).toEqual({
      profileId: 'model',
      checkDns: true,
      skillRuntime: {
        skillId: 'skill',
        bindings: [{ appId: 'app', source: 'assistant-runtime', toolNames: [] }]
      }
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('preserves omitted versus explicitly empty runtime policy', () => {
    expect(normalizeAgentDiagnosticsRequest({})).not.toHaveProperty('skillRuntime')
    expect(normalizeAgentDiagnosticsRequest({ skillRuntime: {} })).toEqual({ skillRuntime: {} })
    expect(normalizeAgentDiagnosticsRequest({ skillRuntime: { bindings: [] } })).toEqual({
      skillRuntime: { bindings: [] }
    })
  })
  it.each([
    null,
    [],
    { checkDns: 'true' },
    { profileId: 'x'.repeat(257) },
    { conversationId: 'bad\nvalue' },
    { skillRuntime: { bindings: Array(33).fill({ appId: 'a' }) } },
    { skillRuntime: { bindings: [{ appId: 'a', toolNames: Array(129).fill('web_search') }] } },
    { skillRuntime: { bindings: [{ appId: 'a', toolNames: null }] } }
  ])('rejects invalid or oversized input', (input) => {
    expect(() => normalizeAgentDiagnosticsRequest(input)).toThrow()
  })
})
