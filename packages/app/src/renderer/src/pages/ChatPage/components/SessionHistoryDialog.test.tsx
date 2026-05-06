import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import type { ChatSession } from '../chatStorage'
import SessionHistoryDialog from './SessionHistoryDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.history_title') return 'History'
      if (key === 'chat.new_conversation') return 'New conversation'
      if (key === 'chat.search_placeholder') return 'Search'
      if (key === 'chat.messages') return 'messages'
      if (key === 'chat.no_conversations') return 'No conversations'
      if (key === 'chat.no_results') return 'No results'
      if (key === 'chat.history_yesterday_time') return String(options?.time || 'Yesterday')
      return key
    }
  })
}))

const visibleSessions: ChatSession[] = [
  {
    id: 'session-1',
    title: 'First session',
    createdAt: Date.parse('2026-04-22T10:00:00.000Z'),
    messages: [{ role: 'user', content: 'hello' } satisfies ChatMessage]
  }
]

const baseProps = {
  open: true,
  onClose: vi.fn(),
  visibleSessions,
  currentSessionId: 'session-1',
  searchKeyword: '',
  onSearchChange: vi.fn(),
  onCreateSession: vi.fn(),
  onSelectSession: vi.fn(),
  onDeleteSession: vi.fn(),
  getDisplaySessionTitle: (title?: string | null) => title || 'Untitled'
}

describe('SessionHistoryDialog', () => {
  it('uses readable title text in light mode', () => {
    render(
      <ThemeProvider theme={createTheme({ palette: { mode: 'light' } })}>
        <SessionHistoryDialog {...baseProps} />
      </ThemeProvider>
    )

    expect(window.getComputedStyle(screen.getByText('History')).color).toBe('rgba(0, 0, 0, 0.87)')
  })

  it('keeps bright title text in dark mode', () => {
    render(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <SessionHistoryDialog {...baseProps} />
      </ThemeProvider>
    )

    expect(window.getComputedStyle(screen.getByText('History')).color).toBe(
      'rgba(255, 255, 255, 0.85)'
    )
  })
})
