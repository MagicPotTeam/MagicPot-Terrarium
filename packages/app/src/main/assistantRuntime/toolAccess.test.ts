import { describe, expect, it } from 'vitest'
import {
  assertAssistantToolAllowed,
  filterAssistantToolsByAllowlist,
  normalizeAllowedToolNames
} from './toolAccess'

describe('toolAccess', () => {
  it('normalizes allowlists into trimmed unique names', () => {
    expect(
      normalizeAllowedToolNames([' session.status ', 'session.status', '', 'mcp.tool'])
    ).toEqual(['session.status', 'mcp.tool'])
    expect(normalizeAllowedToolNames(undefined)).toBeNull()
  })

  it('filters tool definitions against an allowlist when provided', () => {
    const tools = [
      { name: 'session.status', description: 'Status', inputSchema: {} },
      { name: 'context.pinned', description: 'Pins', inputSchema: {} }
    ]

    expect(filterAssistantToolsByAllowlist(tools, ['context.pinned'])).toEqual([
      { name: 'context.pinned', description: 'Pins', inputSchema: {} }
    ])
    expect(filterAssistantToolsByAllowlist(tools, undefined)).toEqual(tools)
  })

  it('rejects unbound tool names when an allowlist is active', () => {
    expect(() => assertAssistantToolAllowed('session.status', ['session.status'])).not.toThrow()
    expect(() => assertAssistantToolAllowed('context.pinned', ['session.status'])).toThrow(
      'Tool "context.pinned" is not bound to the current skill.'
    )
  })
})
