import { describe, expect, it } from 'vitest'
import { getAssistantSessionKey, normalizeAssistantRoute } from './types'

describe('assistant route types', () => {
  it('normalizes routes with the shared agent session helper', () => {
    expect(
      normalizeAssistantRoute({
        channel: ' generic ',
        scopeType: 'invalid' as never,
        scopeId: ' room-1 ',
        threadId: ' thread-4 '
      })
    ).toEqual({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'room-1',
      threadId: 'thread-4'
    })
  })

  it('keeps extended scope types for future channels', () => {
    expect(
      normalizeAssistantRoute({
        channel: 'discord',
        scopeType: 'channel',
        scopeId: 'guild-1/channel-1'
      })
    ).toMatchObject({
      channel: 'discord',
      scopeType: 'channel',
      scopeId: 'guild-1/channel-1'
    })
  })

  it('includes thread identifiers in the session key', () => {
    expect(
      getAssistantSessionKey({
        channel: 'feishu',
        scopeType: 'topic',
        scopeId: 'chat-1',
        threadId: 'thread-1'
      })
    ).toBe('feishu:topic:chat-1:thread:thread-1')
  })
})
