import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import {
  formatAgentThreadEventForModel,
  threadEventDisplayText
} from '@shared/api/agentThreadInbox'
import ThreadEventMessage from './ThreadEventMessage'

const t = ((key: string, options: { defaultValue: string; source?: string }) =>
  options.defaultValue.replace(
    '{{source}}',
    options.source ?? ''
  )) as unknown as TFunction<'translation'>

describe('ThreadEventMessage', () => {
  it('shows the KT trigger banner "Triggered by {source}" with the content, without the model prefix', () => {
    const event = {
      type: 'trigger_fire' as const,
      source: 'synthetic-timer',
      text: 'yes, approved'
    }
    const content = formatAgentThreadEventForModel(event)
    render(
      <ThreadEventMessage
        origin={{ kind: 'thread-event', type: event.type, source: event.source }}
        content={content}
        isLight
        t={t}
      />
    )
    expect(screen.getByTestId('chat-thread-event-title').textContent).toBe(
      'Triggered by synthetic-timer'
    )
    const row = screen.getByTestId('chat-thread-event-message')
    expect(row.textContent).toContain('yes, approved')
    expect(row.textContent).not.toContain('不可信数据')
    expect(row.textContent).not.toMatch(/\bYou\b|你/)
    expect(row.querySelector('button')).toBeNull()
  })

  it('strips only the prefix line', () => {
    expect(threadEventDisplayText('[prefix]\nline 1\nline 2')).toBe('line 1\nline 2')
    expect(threadEventDisplayText('plain')).toBe('plain')
  })
})
