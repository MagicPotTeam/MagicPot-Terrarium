import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList, { type ChatAnchoredTailGroup } from './ChatMessageList'
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
  tailEnd?: React.ReactNode
  anchoredTail?: readonly ChatAnchoredTailGroup[]
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
      tailEnd={options.tailEnd}
      anchoredTail={options.anchoredTail}
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

  it('keeps an empty live region for the tail in the column and renders none outside it', () => {
    const view = render(list(short))
    // The region is there before the first card, so that a card that arrives is announced.
    const tail = screen.getByTestId('chat-transcript-tail')
    expect(tail).toHaveAttribute('aria-live', 'polite')
    expect(tail).toBeEmptyDOMElement()
    expect(screen.queryByTestId('chat-transcript-working-line')).toBeNull()
    view.rerender(list(short, { tail: card }))
    expect(screen.getByTestId('chat-transcript-tail')).toBe(tail)
    expect(tail).toContainElement(screen.getByTestId('card'))
    view.rerender(list(short, { tail: null }))
    expect(screen.getByTestId('chat-transcript-tail')).toBe(tail)
    expect(tail).toBeEmptyDOMElement()
    view.rerender(list(short, { columnStyle: false, tail: card }))
    expect(screen.queryByTestId('chat-transcript-tail')).toBeNull()
    expect(screen.queryByTestId('card')).toBeNull()
  })

  it('keeps a card after the message it followed when newer messages arrive, so the reply is the last row', () => {
    const status = <div data-testid="status-card">status</div>
    const view = render(list(short, { tail: status, tailScrollToken: 1 }))
    expect(screen.getByTestId('chat-transcript-tail')).toContainElement(
      screen.getByTestId('status-card')
    )

    // The person sends a message and gets the reply: the page now hands the card over with the
    // place it was made at (after two messages).
    const longer: ChatSession = {
      ...short,
      messages: [
        ...short.messages,
        { role: 'user', content: 'Next question' },
        { role: 'assistant', content: 'Next answer' }
      ]
    }
    view.rerender(list(longer, { anchoredTail: [{ after: 2, node: status }], tailScrollToken: 1 }))
    const scroller = screen.getByTestId('chat-message-list')
    const rows = [...scroller.querySelectorAll('[data-chat-message-index]')]
    expect(rows).toHaveLength(4)
    const kept = screen.getByTestId('status-card')
    // Inside the row of the second message, after the message itself.
    expect(kept.closest('[data-chat-message-index]')).toBe(rows[1])
    const group = kept.closest('[data-testid="chat-transcript-anchored-cards"]')!
    expect(group).toHaveAttribute('data-placement', 'after')
    expect(group).toHaveStyle({
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      marginTop: '12px'
    })
    expect(
      screen.getByText('Hi').compareDocumentPosition(kept) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // The new exchange follows the card; the reply is the last thing of the transcript.
    expect(
      kept.compareDocumentPosition(screen.getByText('Next question')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(rows[3]).toHaveTextContent('Next answer')
    expect(screen.getByTestId('chat-transcript-tail')).toBeEmptyDOMElement()
    expect(screen.queryByTestId('chat-transcript-working-line')).toBeNull()
    const after = [...scroller.querySelectorAll('*')].filter(
      (element) =>
        rows[3].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING &&
        !rows[3].contains(element) &&
        (element.textContent ?? '').trim() !== ''
    )
    expect(after).toEqual([])
  })

  it('puts a card of an empty conversation before the first message and newer cards in the tail', () => {
    const first = <div data-testid="first-card">first</div>
    const view = render(
      list(short, {
        anchoredTail: [{ after: 0, node: first }],
        tail: card
      })
    )
    const rows = [...view.container.querySelectorAll('[data-chat-message-index]')]
    const kept = screen.getByTestId('first-card')
    expect(kept.closest('[data-chat-message-index]')).toBe(rows[0])
    expect(kept.closest('[data-testid="chat-transcript-anchored-cards"]')).toHaveAttribute(
      'data-placement',
      'before'
    )
    expect(
      kept.compareDocumentPosition(screen.getByText('Hello')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByTestId('chat-transcript-tail')).toContainElement(screen.getByTestId('card'))
    // Outside the column nothing of it is drawn.
    view.rerender(list(short, { columnStyle: false, anchoredTail: [{ after: 0, node: first }] }))
    expect(screen.queryByTestId('first-card')).toBeNull()
  })

  it('draws a kept card only while its row is inside the window of a long transcript', () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${index}`
    }))
    const kept = <div data-testid="kept-card">kept</div>
    const view = render(
      list(
        { id: 'long', title: 'Long', messages },
        {
          anchoredTail: [
            { after: 1, node: kept },
            { after: 58, node: card }
          ]
        }
      )
    )
    const rows = [...view.container.querySelectorAll('[data-chat-message-index]')]
    expect(rows.length).toBeLessThan(60)
    // The list stands at its start: the first row is drawn with its card, row 57 is not.
    expect(screen.getByTestId('kept-card').closest('[data-chat-message-index]')).toBe(rows[0])
    expect(view.container.querySelector('[data-chat-message-index="57"]')).toBeNull()
    expect(screen.queryByTestId('card')).toBeNull()
    expect(screen.getByTestId('chat-virtual-bottom-spacer')).toBeInTheDocument()
  })

  it('replaces the empty state when a conversation without messages has a tail row', () => {
    const empty: ChatSession = { id: 'empty', title: 'Empty', messages: [] }
    const view = render(list(empty))
    expect(screen.getByTestId('chat-empty-state')).toBeInTheDocument()
    view.rerender(list(empty, { tail: card }))
    expect(screen.queryByTestId('chat-empty-state')).toBeNull()
    expect(screen.getByTestId('card')).toBeInTheDocument()
  })

  it('draws the element after the tail without replacing the empty state, in the column only', () => {
    const host = <div data-testid="approval-host" />
    const empty: ChatSession = { id: 'empty', title: 'Empty', messages: [] }
    const view = render(list(empty, { tailEnd: host }))
    expect(screen.getByTestId('chat-empty-state')).toBeInTheDocument()
    expect(screen.getByTestId('approval-host')).toBeInTheDocument()
    view.rerender(list(short, { tail: card, tailEnd: host }))
    const tail = screen.getByTestId('chat-transcript-tail')
    const after = screen.getByTestId('approval-host')
    // After the tail (outside its live region), inside the scroll content.
    expect(tail.contains(after)).toBe(false)
    expect(tail.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('chat-message-list').contains(after)).toBe(true)
    view.rerender(list(short, { columnStyle: false, tailEnd: host }))
    expect(screen.queryByTestId('approval-host')).toBeNull()
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

  it('follows a tail row that grows while the list stands at its end, and not when the person scrolled away', () => {
    // jsdom has no ResizeObserver: the double hands out the callback of the tail's observer.
    const observers: { target: Element | null; notify: () => void }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private entry: { target: Element | null; notify: () => void }
        constructor(callback: () => void) {
          this.entry = { target: null, notify: callback }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.target = target
        }
        unobserve() {
          this.entry.target = null
        }
        disconnect() {
          this.entry.target = null
        }
      }
    )
    try {
      const view = render(list(short, { tailScrollToken: 0 }))
      const scroller = layOut(900, 300)
      view.rerender(list(short, { tail: card, tailScrollToken: 1 }))
      expect(scroller.scrollTop).toBe(600)
      const tail = screen.getByTestId('chat-transcript-tail')
      const observer = observers.find((entry) => entry.target === tail)!
      const tailHeight = (height: number) =>
        vi.spyOn(tail, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect)
      tailHeight(40)
      observer.notify()

      // The row grows by 200px (its content arrived); the scroll event of that frame has already
      // seen the taller content, so the list no longer looks "near the end".
      layOut(1100, 300)
      scroller.dispatchEvent(new Event('scroll'))
      tailHeight(240)
      observer.notify()
      expect(scroller.scrollTop).toBe(800)

      // The person scrolled up before the row grew again: the list stays where it is.
      scroller.scrollTop = 100
      scroller.dispatchEvent(new Event('scroll'))
      layOut(1300, 300)
      tailHeight(440)
      observer.notify()
      expect(scroller.scrollTop).toBe(100)

      // A row that shrinks moves nothing.
      scroller.scrollTop = 1000
      tailHeight(300)
      observer.notify()
      expect(scroller.scrollTop).toBe(1000)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('follows a card that arrives after the tail while the list stands at its end', () => {
    const observers: { target: Element | null; notify: () => void }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private entry: { target: Element | null; notify: () => void }
        constructor(callback: () => void) {
          this.entry = { target: null, notify: callback }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.target = target
        }
        unobserve() {
          this.entry.target = null
        }
        disconnect() {
          this.entry.target = null
        }
      }
    )
    try {
      render(list(short, { tailEnd: <div data-testid="approval-host" /> }))
      const scroller = layOut(900, 300)
      scroller.scrollTop = 600
      scroller.dispatchEvent(new Event('scroll'))
      const wrapper = screen.getByTestId('approval-host').parentElement!
      const observer = observers.find((entry) => entry.target === wrapper)!
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ height: 150 } as DOMRect)
      layOut(1050, 300)
      observer.notify()
      expect(scroller.scrollTop).toBe(750)
    } finally {
      vi.unstubAllGlobals()
    }
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
