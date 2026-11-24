import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import {
  formatAgentThreadEventForModel,
  threadEventDisplayText
} from '@shared/api/agentThreadInbox'
import { formatAgentGoalEventSource } from '@shared/api/agentThreadGoal'
import zhRenderer from '@shared/locales/zh-CN/renderer.json'
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

  it("shows a goal step like KT's goal event: the goal title and step n / max turns", () => {
    const interpolate = (template: string, options: Record<string, unknown>) =>
      template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ''))
    const english = ((key: string, options: { defaultValue: string } & Record<string, unknown>) =>
      interpolate(options.defaultValue, options)) as unknown as TFunction<'translation'>
    const chinese = ((key: string, options: { defaultValue: string } & Record<string, unknown>) =>
      interpolate(
        key === 'chat.thread_event_goal_step'
          ? zhRenderer.chat.thread_event_goal_step
          : options.defaultValue,
        options
      )) as unknown as TFunction<'translation'>
    const origin = {
      kind: 'thread-event' as const,
      type: 'drive_ready' as const,
      source: formatAgentGoalEventSource(2, 10, 'Tidy the notes')
    }
    const page = render(<ThreadEventMessage origin={origin} content="step" isLight t={english} />)
    expect(screen.getByTestId('chat-thread-event-title').textContent).toBe(
      'Triggered by goal Tidy the notes · step 2 / 10'
    )
    page.rerender(<ThreadEventMessage origin={origin} content="step" isLight t={chinese} />)
    expect(screen.getByTestId('chat-thread-event-title').textContent).toBe(
      '由目标 Tidy the notes 触发 · 第 2 / 10 步'
    )
    // Any other drive_ready source (not a MAIN goal step) keeps the plain banner.
    page.rerender(
      <ThreadEventMessage
        origin={{ ...origin, source: 'synthetic-drive' }}
        content="step"
        isLight
        t={english}
      />
    )
    expect(screen.getByTestId('chat-thread-event-title').textContent).toBe(
      'Triggered by synthetic-drive'
    )
  })

  it('strips only the prefix line', () => {
    expect(threadEventDisplayText('[prefix]\nline 1\nline 2')).toBe('line 1\nline 2')
    expect(threadEventDisplayText('plain')).toBe('plain')
  })
})
