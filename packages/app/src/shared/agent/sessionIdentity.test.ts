import { describe, expect, it } from 'vitest'
import {
  buildAgentRoute,
  buildAgentSessionIdentity,
  getAgentSessionKey,
  normalizeAgentRoute,
  resolveAgentRouteScopeId
} from './sessionIdentity'

describe('agent session identity helpers', () => {
  it('resolves scope ids from the first non-empty candidate', () => {
    expect(resolveAgentRouteScopeId(['', '  ', 'conversation-1', 'profile-1'], 'fallback-1')).toBe(
      'conversation-1'
    )
    expect(resolveAgentRouteScopeId(['', undefined], ' fallback-2 ')).toBe('fallback-2')
    expect(resolveAgentRouteScopeId([null, ''], '')).toBe('default')
  })

  it('builds normalized routes from candidate scope ids', () => {
    expect(buildAgentRoute()).toEqual({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'default'
    })

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

  it('preserves optional sender fields when normalizing routes', () => {
    expect(
      normalizeAgentRoute({
        channel: '',
        scopeType: 'topic',
        scopeId: '',
        senderId: ' user-1 ',
        senderName: ' Alice '
      })
    ).toEqual({
      channel: 'generic',
      scopeType: 'topic',
      scopeId: 'default',
      senderId: 'user-1',
      senderName: 'Alice'
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

  it('deduplicates aliases and accepts explicit timestamps and workspace ids', () => {
    const identity = buildAgentSessionIdentity(
      buildAgentRoute({
        channel: 'discord',
        scopeType: 'thread',
        scopeId: 'thread-room',
        senderId: 'user-2',
        senderName: 'Bob'
      }),
      {
        workspaceId: ' workspace-2 ',
        aliases: ['discord:thread:thread-room', 'alt-room', 'alt-room', ''],
        createdAt: 10,
        updatedAt: 20
      }
    )

    expect(identity).toMatchObject({
      sessionKey: 'discord:thread:thread-room',
      workspaceId: 'workspace-2',
      senderId: 'user-2',
      senderName: 'Bob',
      createdAt: 10,
      updatedAt: 20
    })
    expect(identity.aliases).toEqual(['discord:thread:thread-room', 'alt-room'])
  })
})
