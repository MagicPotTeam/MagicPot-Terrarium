import { describe, expect, it } from 'vitest'
import {
  buildAssistantAttachmentsOnlyText,
  buildAssistantEmptyReplyText,
  buildAssistantFinalText,
  buildAssistantHelpText,
  buildAssistantProgressText,
  splitAssistantTextChunks
} from './assistantOutputPresenter'
import type { AssistantRunEvent } from './types'

const buildEvent = (
  type: AssistantRunEvent['type'],
  message?: string,
  metadata?: Record<string, unknown>
): AssistantRunEvent => ({
  eventId: `event-${type}`,
  runId: 'run-1',
  sessionKey: 'session-1',
  route: {
    channel: 'telegram',
    scopeType: 'dm',
    scopeId: 'scope-1'
  },
  type,
  level: 'info',
  message: message || '',
  createdAt: Date.now(),
  ...(metadata ? { metadata } : {})
})

describe('buildAssistantProgressText', () => {
  it('formats queued and error progress text with shared defaults', () => {
    expect(buildAssistantProgressText(buildEvent('queued', '', { queuePosition: 3 }))).toBe(
      'MagicPot queued your request. Position: 3.'
    )
    expect(buildAssistantProgressText(buildEvent('started'))).toBe(
      'MagicPot is working on your request...'
    )
    expect(buildAssistantProgressText(buildEvent('failed', 'upstream timeout'))).toBe(
      'MagicPot error: upstream timeout'
    )
  })

  it('supports channel-specific acknowledgement variants', () => {
    expect(
      buildAssistantProgressText(buildEvent('queued'), {
        queueLeadText: 'accepted'
      })
    ).toBe('MagicPot accepted your request and is starting it now.')
    expect(
      buildAssistantProgressText(buildEvent('acknowledged'), {
        acknowledgedText: 'MagicPot acknowledged your request.'
      })
    ).toBe('MagicPot acknowledged your request.')
  })
})

describe('buildAssistantHelpText', () => {
  it('includes onboarding guidance and command help', () => {
    const help = buildAssistantHelpText('telegram')
    expect(help).toContain('Onboarding:')
    expect(help).toContain('Use this bot from the external chat channel or relay entrypoint')
    expect(help).toContain('Trigger rule: In private chats, send anything.')
    expect(help).toContain('First message to try: /help')
    expect(help).toContain('/status - show current chat session status')
    expect(help).toContain('/tools [name] - list available tools or inspect one tool')
  })
})

describe('reply helpers', () => {
  it('formats final-status fallbacks and empty-reply text', () => {
    expect(buildAssistantFinalText('completed')).toBe('MagicPot finished your request.')
    expect(buildAssistantFinalText('failed')).toBe('MagicPot could not complete this request.')
    expect(buildAssistantAttachmentsOnlyText()).toBe('MagicPot sent attachments.')
    expect(buildAssistantEmptyReplyText()).toBe('MagicPot returned an empty reply.')
  })
})

describe('splitAssistantTextChunks', () => {
  it('splits long text into bounded chunks with paragraph preference', () => {
    const chunks = splitAssistantTextChunks('alpha beta\n\ngamma delta\nepsilon zeta', 12)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true)
  })
})
