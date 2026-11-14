import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ThemeProvider, alpha, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList from './ChatMessageList'
import type { ChatSession } from '../chatStorage'
import type { ChatLoadingStatus } from '../chatLoadingStatus'

// The real list; only translation, notifications and the jsdom clipboard are doubles.
const { notifySuccessMock, notifyErrorMock } = vi.hoisted(() => ({
  notifySuccessMock: vi.fn(),
  notifyErrorMock: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`
  })
}))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifySuccess: notifySuccessMock, notifyError: notifyErrorMock })
}))

const theme = createTheme({ palette: { mode: 'dark', warning: { main: '#ddaa00' } } })
const writeTextMock = vi.fn<(text: string) => Promise<void>>()
let clipboardDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  notifySuccessMock.mockReset()
  notifyErrorMock.mockReset()
  writeTextMock.mockReset().mockResolvedValue(undefined)
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

const renderList = (
  session: ChatSession | undefined,
  options: {
    columnStyle?: boolean
    isLoading?: boolean
    loadingStatus?: ChatLoadingStatus
    editingMessageIndex?: number
  } = {}
) =>
  render(
    <ThemeProvider theme={theme}>
      <ChatMessageList
        columnStyle={options.columnStyle ?? true}
        currentSession={session}
        isLoading={options.isLoading ?? false}
        loadingStatus={options.loadingStatus}
        editingMessageIndex={options.editingMessageIndex ?? null}
        editingContent={options.editingMessageIndex === undefined ? '' : 'Edited text'}
        onSetEditingIndex={vi.fn()}
        onSetEditingContent={vi.fn()}
        onSendEditedMessage={vi.fn()}
        onPreviewImage={vi.fn()}
        onImageContextMenu={vi.fn()}
        onDownloadAttachment={vi.fn()}
        onSendModelToDcc={vi.fn()}
        chatContainerRef={React.createRef<HTMLDivElement>()}
        messagesEndRef={React.createRef<HTMLDivElement>()}
      />
    </ThemeProvider>
  )

const tool = (id: string, toolName: string) => ({
  runId: 'run',
  toolCallId: id,
  toolName,
  args: { path: `src/${id}.ts` },
  status: 'completed' as const,
  content: `RESULT_${id}`
})
const conversation: ChatSession = {
  id: 'column-rows',
  title: 'Column rows',
  messages: [
    { role: 'user', content: 'Why does the picker forget the effort?' },
    {
      role: 'assistant',
      content: [
        'I traced it to `restoreSession()`.',
        '',
        '```TS',
        'const parsed = parseSelector(saved.model)',
        '```',
        '',
        '```',
        'plain fenced text',
        '```',
        '',
        '| Check | Before |',
        '| --- | --- |',
        '| effort kept | no |',
        '',
        '- first item'
      ].join('\n'),
      toolHistory: [tool('a', 'grep'), tool('b', 'read')]
    }
  ]
}

describe('ChatMessageList in the Agent column', () => {
  it('shows the empty state as a tile, a title and a hint without a heading', () => {
    const view = renderList({ id: 'empty', title: 'Empty', messages: [] })
    const empty = screen.getByTestId('chat-empty-state')
    expect(within(empty).getByText('chat.transcript.empty_title')).toHaveStyle({ fontSize: '14px' })
    expect(within(empty).getByText('chat.transcript.empty_hint')).toHaveStyle({
      fontSize: '12px',
      opacity: '0.75'
    })
    expect(empty.firstElementChild).toHaveStyle({
      width: '48px',
      height: '48px',
      borderRadius: '16px'
    })
    expect(empty.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.welcome_message')).not.toBeInTheDocument()
    expect(view.container.textContent).not.toContain('@')
  })

  it('insets the scroller by 8px and 16px and spaces every row 12px apart', () => {
    const view = renderList(conversation)
    expect(screen.getByTestId('chat-message-list')).toHaveStyle({
      paddingLeft: '8px',
      paddingRight: '8px',
      paddingTop: '16px',
      paddingBottom: '4px'
    })
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-chat-message-index]')]
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.style.paddingBottom)).toEqual(['12px', '12px'])
  })

  it('draws the user message as a neutral right-aligned bubble with a caption and 22px action buttons', () => {
    renderList(conversation)
    const bubble = screen.getByTestId('user-message-bubble')
    expect(bubble).toHaveStyle({
      maxWidth: '80%',
      borderRadius: '12px',
      padding: '9px 14px 12px',
      backgroundColor: 'rgba(255,255,255,0.08)'
    })
    expect(bubble.parentElement).toHaveStyle({ alignItems: 'flex-end' })
    const caption = within(bubble).getByTestId('user-message-caption')
    expect(caption).toHaveTextContent('chat.transcript.you')
    expect(caption).toHaveStyle({ fontSize: '12px', marginBottom: '4px' })
    expect(bubble.firstElementChild).toBe(caption)
    expect(within(bubble).getByText('Why does the picker forget the effort?')).toHaveStyle({
      fontSize: '13px',
      lineHeight: '1.65'
    })
    const actions = screen.getByTestId('user-message-actions')
    expect(bubble.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const buttons = within(actions).getAllByRole('button')
    expect(
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)
    ).toHaveLength(3)
    for (const button of buttons) {
      expect(button).toHaveStyle({
        width: '22px',
        height: '22px',
        borderRadius: '4px',
        borderStyle: 'solid'
      })
    }
  })

  it('keeps the bubble and its caption while a message is edited, 92% wide', () => {
    renderList(conversation, { editingMessageIndex: 0 })
    expect(screen.queryByTestId('user-message-bubble')).toBeNull()
    const bubble = screen.getByTestId('edit-message-bubble')
    expect(bubble).toHaveStyle({
      maxWidth: '92%',
      width: '100%',
      boxSizing: 'border-box',
      borderRadius: '12px',
      padding: '9px 14px 12px',
      backgroundColor: 'rgba(255,255,255,0.08)'
    })
    expect(bubble.parentElement).toHaveStyle({ justifyContent: 'flex-end' })
    const caption = within(bubble).getByTestId('user-message-caption')
    expect(caption).toHaveTextContent('chat.transcript.you')
    expect(bubble.firstElementChild).toBe(caption)
    expect(within(bubble).getByRole('textbox')).toHaveValue('Edited text')
    expect(within(bubble).getAllByRole('button')).toHaveLength(2)
  })

  it('draws the assistant answer without a bubble: parts 6px apart, at most 90% wide, 13px text', () => {
    renderList(conversation)
    const parts = screen.getByTestId('assistant-message-parts')
    expect(parts).toHaveStyle({
      maxWidth: '90%',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px'
    })
    expect(getComputedStyle(parts).backgroundColor).toMatch(/^(|transparent|rgba\(0, 0, 0, 0\))$/)
    expect(screen.getByTestId('assistant-markdown-content')).toHaveStyle({
      fontSize: '13px',
      lineHeight: '1.65'
    })
    // Tool receipts use the column lines and come before the text.
    const lines = [...parts.querySelectorAll('[data-chat-tool-line]')]
    expect(lines).toHaveLength(2)
    expect(
      lines[1].compareDocumentPosition(screen.getByTestId('assistant-markdown-content')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    const actions = screen.getByTestId('assistant-reply-actions')
    for (const button of within(actions).getAllByRole('button')) {
      expect(button).toHaveStyle({ width: '22px', height: '22px', borderRadius: '4px' })
    }
  })

  it('gives a fenced block a header with the lower-case language and a text Copy button', async () => {
    vi.useFakeTimers()
    renderList(conversation)
    const blocks = screen.getAllByTestId('chat-code-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toHaveStyle({ borderRadius: '8px', overflow: 'hidden' })
    expect(blocks[0].firstElementChild?.firstElementChild).toHaveTextContent(/^ts$/)
    // A block without a language is labelled "text".
    expect(blocks[1].firstElementChild?.firstElementChild).toHaveTextContent(/^text$/)
    expect(blocks[1]).toHaveTextContent('plain fenced text')
    const copy = within(blocks[0]).getByRole('button', { name: 'chat.copy_code' })
    expect(copy).toHaveTextContent('chat.transcript.copy_code')
    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })
    expect(writeTextMock).toHaveBeenCalledWith('const parsed = parseSelector(saved.model)')
    expect(within(blocks[0]).getByRole('button')).toHaveTextContent('chat.transcript.code_copied')
    act(() => {
      vi.advanceTimersByTime(1499)
    })
    expect(within(blocks[0]).getByRole('button')).toHaveTextContent('chat.transcript.code_copied')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(within(blocks[0]).getByRole('button')).toHaveTextContent('chat.transcript.copy_code')
  })

  it('lets a table scroll inside itself and keeps list bullets', () => {
    const view = renderList(conversation)
    const table = screen.getByRole('table')
    expect(table.parentElement).toHaveClass('chat-md-table-scroll')
    expect(table.parentElement).toHaveStyle({ overflowX: 'auto', maxWidth: '100%' })
    expect(view.container.querySelector('.chat-md-body ul')).toHaveStyle({ listStyleType: 'disc' })
    expect(view.container.querySelector('.chat-md-p')).not.toHaveAttribute('style')
  })

  it('shows a task item with its checkbox in place of the bullet', () => {
    const view = renderList({
      ...conversation,
      messages: [
        { role: 'user', content: 'Plan' },
        { role: 'assistant', content: '- [ ] open task\n- [x] done task\n- plain item' }
      ]
    })
    const items = [...view.container.querySelectorAll('.chat-md-body li')]
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveClass('task-list-item')
    expect(items[0]).toHaveStyle({ listStyleType: 'none' })
    expect(items[1]).toHaveStyle({ listStyleType: 'none' })
    expect(items[0].querySelector('input[type="checkbox"]')).toHaveStyle({ marginLeft: '-1.4em' })
    // An ordinary item of the same list keeps its bullet.
    expect(items[2]).not.toHaveClass('task-list-item')
    expect(getComputedStyle(items[2]).listStyleType).not.toBe('none')
  })

  it('shows the working line as a dot and a label without a box, with the detail below', () => {
    const session: ChatSession = {
      ...conversation,
      messages: [
        ...conversation.messages,
        { role: 'user', content: 'Go on' },
        { role: 'assistant', content: '' }
      ]
    }
    renderList(session, {
      isLoading: true,
      loadingStatus: { label: 'Running a tool', detail: 'Step detail', step: 1, totalSteps: 3 }
    })
    const status = screen.getByTestId('assistant-loading-status')
    expect(status).toHaveStyle({ padding: '8px 4px', color: '#ddaa00' })
    expect(getComputedStyle(status).borderTopStyle).not.toBe('solid')
    expect(getComputedStyle(status).backgroundColor).toMatch(/^(|transparent|rgba\(0, 0, 0, 0\))$/)
    const dot = within(status).getByTestId('assistant-loading-dot')
    expect(dot).toHaveStyle({ width: '8px', height: '8px', borderRadius: '50%' })
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(within(status).getByText('Running a tool 1/3')).toHaveStyle({
      color: alpha('#ddaa00', 0.8)
    })
    expect(within(status).getByText('Step detail')).toHaveStyle({ fontSize: '12px' })
    expect(status.querySelector('[role="progressbar"]')).toBeNull()
    // It belongs to the last row of the list.
    const rows = [...document.querySelectorAll('[data-chat-message-index]')]
    expect(rows[rows.length - 1].contains(status)).toBe(true)
  })

  it('shows the context summary as a one-line banner that opens a capped box', () => {
    renderList({
      ...conversation,
      contextCompression: {
        summary: 'Kept **facts**',
        coveredMessageCount: 4,
        sourceHash: 'hash',
        estimatedSourceTokens: 10,
        estimatedSummaryTokens: 2,
        updatedAt: 0
      }
    })
    const card = screen.getByTestId('chat-context-summary-card')
    expect(card).toHaveStyle({ borderRadius: '10px', borderStyle: 'solid' })
    const toggle = screen.getByTestId('chat-context-summary-toggle')
    expect(toggle).toHaveStyle({ padding: '6px 12px' })
    // Title and number of messages only: no trigger word, no time.
    expect(toggle).toHaveTextContent(
      /^chat\.context_summary_titlechat\.context_summary_message_count:4$/
    )
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('chat-context-summary-content')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('chat-context-summary-content')).toHaveStyle({
      maxHeight: '12rem',
      overflowY: 'auto'
    })
    expect(screen.getByText('facts').tagName).toBe('STRONG')
  })

  it('keeps long transcripts virtualised with the same 12px row spacing', () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${index}`
    }))
    const view = renderList({ id: 'long', title: 'Long', messages })
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-chat-message-index]')]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(60)
    expect(new Set(rows.map((row) => row.style.paddingBottom))).toEqual(new Set(['12px']))
    expect(screen.getByTestId('chat-virtual-bottom-spacer')).toBeInTheDocument()
  })

  it('keeps the full-page look when the column style is off', () => {
    const view = renderList(conversation, { columnStyle: false })
    expect(screen.queryByTestId('user-message-caption')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-bubble')).toHaveStyle({
      maxWidth: '85%',
      borderRadius: '18px'
    })
    expect(screen.queryAllByTestId('chat-code-block')).toHaveLength(0)
    expect(screen.getByRole('table').parentElement).not.toHaveClass('chat-md-table-scroll')
    expect(view.container.querySelectorAll('[data-chat-tool-line]')).toHaveLength(0)
    expect(view.container.querySelector('pre')).not.toBeNull()
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-chat-message-index]')]
    expect(rows.map((row) => row.style.paddingBottom)).toEqual(['0px', '16px'])
    cleanup()
    renderList({ id: 'empty', title: 'Empty', messages: [] }, { columnStyle: false })
    expect(screen.getByRole('heading', { name: 'chat.welcome_message' })).toBeInTheDocument()
    expect(screen.queryByTestId('chat-empty-state')).not.toBeInTheDocument()
  })
})
