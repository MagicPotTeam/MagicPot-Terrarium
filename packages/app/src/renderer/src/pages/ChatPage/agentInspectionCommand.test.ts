import { describe, expect, it } from 'vitest'
import { formatAgentEnvironment, isAgentInspectionCommand, parseAgentInspectionCommand } from './agentInspectionCommand'

describe('user-only inspection command grammar and environment whitelist', () => {
  it('accepts exact case-insensitive commands and never matches prefixes or quoted content', () => {
    expect(parseAgentInspectionCommand(' /ENV ')).toBe('env')
    expect(parseAgentInspectionCommand('/system_prompt')).toBe('system_prompt')
    for (const text of ['/environment', '/envx', 'quote /env', '```\n/env\n```']) {
      expect(isAgentInspectionCommand(text)).toBe(false)
      expect(parseAgentInspectionCommand(text)).toBeUndefined()
    }
    for (const text of ['/env all', '/system_prompt set secret']) expect(() => parseAgentInspectionCommand(text)).toThrow()
  })
  it('projects only explicit context fields without accessing extra secret getters', () => {
    const value = { conversationId: 'session', profileId: 'profile', skillId: null, storageScope: 'scope', remote: false,
      route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } }
    Object.defineProperty(value, 'api_key', { get() { throw new Error('secret read') } })
    Object.defineProperty(value.route, 'token', { get() { throw new Error('secret route read') } })
    expect(JSON.parse(formatAgentEnvironment(value))).toEqual(value)
    expect(formatAgentEnvironment(value)).not.toMatch(/api_key|token|base_url|process/)
  })
})
