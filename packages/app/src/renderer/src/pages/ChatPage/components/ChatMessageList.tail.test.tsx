import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList from './ChatMessageList'
import type { ChatSession } from '../chatStorage'
import type { ChatLoadingStatus } from '../chatLoadingStatus'

// The real list; only translation and notifications are doubles.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() })
}))

const theme = createTheme({ palette: { mode: 'dark' } })
afterEach(cleanup)

type Options = {
  columnStyle?: boolean
  tail?: React.ReactNode
  tailScrollToken?: number
  isLoading?: boolean
  loadingStatus?: ChatLoadingStatus
}
const containerRef = React.createRef<HTMLDivElement>()
const list = (session: ChatSession, options: Options = {}): React.ReactElement => (
  <ThemeProvider theme={theme}>
    <ChatMessageList
      columnStyle={options.columnStyle ?? true}
      tail={options.tail}
      tailScrollToken={options.tailScrollToken}
      currentSession={session}
      isLoading={options.isLoading ?? false}
      loadingStatus={options.loadingStatus}
      editingMessageIndex={null}
      editingContent=""
      onSetEditingIndex={vi.fn()}
      onSetEditingContent={vi.fn()}
      onSendEditedMessage={vi.fn()}
      onPreviewImage={vi.fn()}
      onImageContextMenu={vi.fn()}
      onDownloadAttachment={vi.fn()}
      onSendModelToDcc={vi.fn()}
      chatContainerRef={containerRef}
      messagesEndRef={React.createRef<HTMLDivElement>()}
    />
  </ThemeProvider>
)

const short: ChatSession = {
  id: 'tail',
  title: 'Tail',
  messages: [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' }
  ]
}
const card = <div data-testid="card">card</div>

/** jsdom has no layout: give the scroller a height and a content height. */
const layOut = (scrollHeight: number, clientHeight: number): HTMLElement => {
  const scroller = screen.getByTestId('chat-message-list')
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: clientHeight })
  return scroller
}

describe('the transcript tail of the Agent column', () => {
  it('renders the tail as the last rows of the scroll content, after the last message', () => {
    render(list(short, { tail: card }))
    const scroller = screen.getByTestId('chat-message-list')
    const tail = screen.getByTestId('chat-transcript-tail')
    expect(scroller.contains(tail)).toBe(true)
    expect(tail).toContainElement(screen.getByTestId('card'))
    expect(tail).toHaveStyle({ display: 'flex', flexDirection: 'column', gap: '12px' })
    const rows = [...scroller.querySelectorAll('[data-chat-message-index]')]
    expect(
      rows[rows.length - 1].compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('renders no tail element without tail rows and none outside the column', () => {
    const view = render(list(short))
    expect(screen.queryByTestId('chat-transcript-tail')).toBeNull()
    expect(screen.queryByTestId('chat-transcript-working-line')).toBeNull()
    view.rerender(list(short, { tail: null }))
    expect(screen.queryByTestId('chat-transcript-tail')).toBeNull()
    view.rerender(list(short, { columnStyle: false, tail: card }))
    expect(screen.queryByTestId('chat-transcript-tail')).toBeNull()
    expect(screen.queryByTestId('card')).toBeNull()
  })

  it('replaces the empty state when a conversation without messages has a tail row', () => {
    const empty: ChatSession = { id: 'empty', title: 'Empty', messages: [] }
    const view = render(list(empty))
    expect(screen.getByTestId('chat-empty-state')).toBeInTheDocument()
    view.rerender(list(empty, { tail: card }))
    expect(screen.queryByTestId('chat-empty-state')).toBeNull()
    expect(screen.getByTestId('card')).toBeInTheDocument()
  })

  it('scrolls to the end when a row was just added, and only then', () => {
    const view = render(list(short, { tailScrollToken: 0 }))
    const scroller = layOut(900, 300)
    scroller.scrollTop = 120

    view.rerender(list(short, { tail: card, tailScrollToken: 1 }))
    expect(scroller.scrollTop).toBe(600)

    // The person scrolls up; an unrelated re-render with the same token leaves the list there.
    scroller.scrollTop = 40
    view.rerender(list(short, { tail: <div data-testid="card">changed</div>, tailScrollToken: 1 }))
    expect(scroller.scrollTop).toBe(40)

    view.rerender(list(short, { tail: card, tailScrollToken: 2 }))
    expect(scroller.scrollTop).toBe(600)
  })

  it('keeps a long transcript virtualised with the tail after the bottom spacer', () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${index}`
    }))
    const view = render(list({ id: 'long', title: 'Long', messages }, { tail: card }))
    const rows = view.container.querySelectorAll('[data-chat-message-index]')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(60)
    const spacer = screen.getByTestId('chat-virtual-bottom-spacer')
    const tail = screen.getByTestId('chat-transcript-tail')
    expect(spacer.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tail.closest('[data-chat-message-index]')).toBeNull()
  })

  it('draws the working line below the tail while the last message is being written', () => {
    const running: ChatSession = {
      ...short,
      messages: [
        ...short.messages,
        { role: 'user', content: 'Go on' },
        { role: 'assistant', content: '' }
      ]
    }
    const loading = { isLoading: true, loadingStatus: { label: 'Running a tool' } }
    const view = render(list(running, loading))
    // Without a tail the line belongs to the last message row.
    const inline = screen.getByTestId('assistant-loading-status')
    expect(inline.closest('[data-chat-message-index]')).not.toBeNull()

    view.rerender(list(running, { ...loading, tail: card }))
    const status = screen.getByTestId('assistant-loading-status')
    expect(screen.getAllByTestId('assistant-loading-status')).toHaveLength(1)
    expect(status).toHaveTextContent('Running a tool')
    expect(status.closest('[data-chat-message-index]')).toBeNull()
    expect(screen.getByTestId('chat-transcript-working-line')).toContainElement(status)
    const tail = screen.getByTestId('chat-transcript-tail')
    expect(tail.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
