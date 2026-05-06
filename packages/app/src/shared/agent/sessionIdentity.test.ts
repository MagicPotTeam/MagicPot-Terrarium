import { describe, expect, it } from 'vitest'
import {
  buildAgentRoute,
  buildAgentSessionIdentity,
  getAgentSessionKey,
  resolveAgentRouteScopeId
} from './sessionIdentity'

describe('agent session identity helpers', () => {
  it('resolves scope ids from the first non-empty candidate', () => {
    expect(resolveAgentRouteScopeId(['', '  ', 'conversation-1', 'profile-1'], 'fallback-1')).toBe(
      'conversation-1'
    )
  })

  it('builds normalized routes from candidate scope ids', () => {
    expect(
      buildAgentRoute({
        channel: ' generic ',
        scopeType: 'invalid-scope',
        scopeIdCandidates: ['', ' conversation-2 ', 'profile-2'],
        threadId: ' thread-7 '
      })
    ).toEqual({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'conversation-2',
      threadId: 'thread-7'
    })
  })

  it('reuses the same normalized session key across helper layers', () => {
    const identity = buildAgentSessionIdentity(
      buildAgentRoute({
        channel: 'telegram',
        scopeType: 'group',
        scopeIdCandidates: ['room-9'],
        threadId: 'thread-2'
      })
    )

    expect(getAgentSessionKey(identity.route)).toBe('telegram:group:room-9:thread:thread-2')
    expect(identity.sessionKey).toBe('telegram:group:room-9:thread:thread-2')
  })
})
