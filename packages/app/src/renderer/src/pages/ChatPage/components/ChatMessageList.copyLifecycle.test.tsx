import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList from './ChatMessageList'
import type { ChatSession } from '../chatStorage'

// Real list, Markdown, code renderer and copy buttons; only translation/notification boundaries
// and the jsdom clipboard are doubles. This is unit evidence, not OS clipboard acceptance.
const { notifySuccessMock, notifyErrorMock } = vi.hoisted(() => ({
  notifySuccessMock: vi.fn(),
  notifyErrorMock: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifySuccess: notifySuccessMock, notifyError: notifyErrorMock })
}))

type ListProps = React.ComponentProps<typeof ChatMessageList>
type CopyKind = 'user' | 'assistant' | 'code'
type Outcome = 'resolve' | 'reject'
const theme = createTheme()
const originalText = '# 雪 🪴 e\u0301\n\n**bold** — العربية\nline\twith  spaces'
const changedText = 'Changed 雪 🪴 e\u0301\n\nsecond\tline — العربية'
const copyError = 'Failed to copy text. Try again.'
const writeTextMock = vi.fn<(text: string) => Promise<void>>()
let clipboardDescriptor: PropertyDescriptor | undefined

const deferredWrite = () => {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const settle = async (write: ReturnType<typeof deferredWrite>, outcome: Outcome = 'resolve') => {
  await act(async () => {
    if (outcome === 'resolve') {
      write.resolve()
      await write.promise
    } else {
      write.reject(new DOMException('Clipboard permission denied', 'NotAllowedError'))
      // Do not attach a test-owned catch/then to the rejected clipboard promise. Production
      // must consume the rejection; Vitest's normal unhandled-rejection reporting stays on.
      await Promise.resolve()
    }
  })
}

const makeSession = (kind: CopyKind, text = originalText, id = 'copy-session'): ChatSession => {
  const message = {
    messageId: 'stable-message-id',
    role: kind === 'user' ? ('user' as const) : ('assistant' as const),
    content: kind === 'code' ? `\`\`\`text\n${text}\n\`\`\`` : text,
    hiddenContext: 'Never copy this hidden context'
  }
  return { id, title: 'Copy lifecycle', messages: [message] }
}

const renderSession = (session: ChatSession) => {
  const callbacks = {
    onSetEditingIndex: vi.fn<ListProps['onSetEditingIndex']>(),
    onSetEditingContent: vi.fn<ListProps['onSetEditingContent']>(),
    onSendEditedMessage: vi.fn<ListProps['onSendEditedMessage']>(),
    onPreviewImage: vi.fn<ListProps['onPreviewImage']>(),
    onImageContextMenu: vi.fn<ListProps['onImageContextMenu']>(),
    onDownloadAttachment: vi.fn<ListProps['onDownloadAttachment']>(),
    onSendModelToDcc: vi.fn<ListProps['onSendModelToDcc']>()
  }
  const chatContainerRef = React.createRef<HTMLDivElement>()
  const messagesEndRef = React.createRef<HTMLDivElement>()
  const build = (currentSession: ChatSession, active = true) => (
    <ThemeProvider theme={theme}>
      <ChatMessageList
        currentSession={currentSession}
        active={active}
        isLoading={false}
        editingMessageIndex={null}
        editingContent=""
        {...callbacks}
        chatContainerRef={chatContainerRef}
        messagesEndRef={messagesEndRef}
      />
    </ThemeProvider>
  )
  const view = render(build(session))
  return {
    ...view,
    rerenderSession: (next: ChatSession, active = true) => view.rerender(build(next, active)),
    onSendEditedMessage: callbacks.onSendEditedMessage
  }
}

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
  vi.clearAllTimers()
  vi.useRealTimers()
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  vi.restoreAllMocks()
})

describe.each([
  { kind: 'user' as const, copyLabel: 'chat.copy_prompt', copiedLabel: 'chat.prompt_copied' },
  { kind: 'assistant' as const, copyLabel: 'Copy reply', copiedLabel: 'Reply copied' },
  { kind: 'code' as const, copyLabel: 'Copy code', copiedLabel: 'chat.code_copied' }
])(
  'ChatMessageList $kind copy lifecycle (jsdom clipboard unit)',
  ({ kind, copyLabel, copiedLabel }) => {
    const button = () => screen.getByRole('button', { name: copyLabel })
    const click = () => fireEvent.click(button())
    const expectIdle = () => {
      expect(button()).not.toHaveClass('MuiIconButton-colorSuccess')
      expect(screen.queryByRole('button', { name: copiedLabel })).not.toBeInTheDocument()
      expect(screen.queryByTestId('copy-done-icon')).not.toBeInTheDocument()
      expect(screen.queryByRole('tooltip', { name: copiedLabel })).not.toBeInTheDocument()
    }
    const expectNoFeedback = () => {
      expect(notifySuccessMock).not.toHaveBeenCalled()
      expect(notifyErrorMock).not.toHaveBeenCalled()
      expectIdle()
    }
    const expectCopied = () => {
      const copiedButton = screen.getByRole('button', { name: copiedLabel })
      expect(copiedButton).toHaveClass('MuiIconButton-colorSuccess')
      expect(within(copiedButton).getByTestId('copy-done-icon')).toBeInTheDocument()
    }

    it('catches the first denied write and retries the exact Unicode payload successfully', async () => {
      const first = deferredWrite()
      const retry = deferredWrite()
      writeTextMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
      const { onSendEditedMessage } = renderSession(makeSession(kind))
      click()
      await settle(first, 'reject')
      expect(writeTextMock).toHaveBeenCalledExactlyOnceWith(originalText)
      expect(notifyErrorMock).toHaveBeenCalledExactlyOnceWith(copyError)
      expect(notifySuccessMock).not.toHaveBeenCalled()
      expectIdle()

      click()
      expect(writeTextMock.mock.calls).toEqual([[originalText], [originalText]])
      expect(notifySuccessMock).not.toHaveBeenCalled()
      expectIdle()
      await settle(retry)
      expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
      expect(notifyErrorMock).toHaveBeenCalledTimes(1)
      expectCopied()
      expect(onSendEditedMessage).not.toHaveBeenCalled()
      // Fenced code intentionally omits only Markdown's final LF, not interior whitespace.
    })

    it('catches a synchronous clipboard throw and leaves retry available', async () => {
      writeTextMock.mockImplementationOnce(() => {
        throw new Error('Synchronous clipboard failure')
      })
      renderSession(makeSession(kind))
      await act(async () => {
        click()
      })
      expect(notifyErrorMock).toHaveBeenCalledExactlyOnceWith(copyError)
      expect(notifySuccessMock).not.toHaveBeenCalled()
      expectIdle()
      await act(async () => {
        click()
      })
      expect(writeTextMock.mock.calls).toEqual([[originalText], [originalText]])
      expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
      expectCopied()
    })

    it.each(['clipboard missing', 'writeText missing'])(
      'reports a useful error without success when %s',
      async (unavailable) => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: unavailable === 'clipboard missing' ? undefined : {}
        })
        renderSession(makeSession(kind))
        await act(async () => {
          click()
        })
        expect(writeTextMock).not.toHaveBeenCalled()
        expect(notifyErrorMock).toHaveBeenCalledExactlyOnceWith(copyError)
        expect(notifySuccessMock).not.toHaveBeenCalled()
        expectIdle()
      }
    )

    it('deduplicates two clicks while the write is pending and waits for actual resolution', async () => {
      const write = deferredWrite()
      writeTextMock.mockReturnValue(write.promise)
      renderSession(makeSession(kind))
      const copyButton = button()
      fireEvent.click(copyButton)
      fireEvent.click(copyButton)
      expect(writeTextMock).toHaveBeenCalledExactlyOnceWith(originalText)
      expectNoFeedback()
      await settle(write)
      expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
      expect(notifyErrorMock).not.toHaveBeenCalled()
      expectCopied()
    })

    it('clears the previous green indicator while a subsequent write is pending or fails', async () => {
      const next = deferredWrite()
      writeTextMock.mockResolvedValueOnce(undefined).mockReturnValueOnce(next.promise)
      renderSession(makeSession(kind))
      await act(async () => {
        click()
      })
      expectCopied()
      fireEvent.click(screen.getByRole('button', { name: copiedLabel }))
      expectIdle()
      expect(notifySuccessMock).toHaveBeenCalledTimes(1)
      await settle(next, 'reject')
      expectIdle()
      expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
      expect(notifyErrorMock).toHaveBeenCalledExactlyOnceWith(copyError)
      expect(writeTextMock.mock.calls).toEqual([[originalText], [originalText]])
    })

    it.each<Outcome>(['resolve', 'reject'])(
      'suppresses feedback and consumes pending %s after unmount',
      async (outcome) => {
        const write = deferredWrite()
        writeTextMock.mockReturnValue(write.promise)
        const { unmount } = renderSession(makeSession(kind))
        click()
        unmount()
        await settle(write, outcome)
        expect(writeTextMock).toHaveBeenCalledExactlyOnceWith(originalText)
        expect(notifySuccessMock).not.toHaveBeenCalled()
        expect(notifyErrorMock).not.toHaveBeenCalled()
        expect(screen.queryByTestId('copy-done-icon')).not.toBeInTheDocument()
        expect(screen.queryByRole('tooltip', { name: copiedLabel })).not.toBeInTheDocument()
      }
    )

    it.each<Outcome>(['resolve', 'reject'])(
      'ignores a stale %s after content changes with the same message identity',
      async (outcome) => {
        const write = deferredWrite()
        writeTextMock.mockReturnValueOnce(write.promise)
        const { rerenderSession } = renderSession(makeSession(kind))
        click()
        rerenderSession(makeSession(kind, changedText))
        await settle(write, outcome)
        expectNoFeedback()
        await act(async () => {
          click()
        })
        expect(writeTextMock.mock.calls).toEqual([[originalText], [changedText]])
        expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
        expectCopied()
      }
    )

    it.each([
      { text: originalText, content: 'same text', outcome: 'resolve' as const },
      { text: originalText, content: 'same text', outcome: 'reject' as const },
      { text: changedText, content: 'different text', outcome: 'resolve' as const },
      { text: changedText, content: 'different text', outcome: 'reject' as const }
    ])(
      'ignores stale $outcome after session change with $content and a reused message identity',
      async ({ text, outcome }) => {
        const write = deferredWrite()
        writeTextMock.mockReturnValueOnce(write.promise)
        const { rerenderSession } = renderSession(makeSession(kind))
        click()
        rerenderSession(makeSession(kind, text, 'other-session'))
        await settle(write, outcome)
        expectNoFeedback()
        await act(async () => {
          click()
        })
        expect(writeTextMock.mock.calls).toEqual([[originalText], [text]])
        expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
        expectCopied()
      }
    )

    it('preserves legitimate pending feedback across a same-session same-content rerender', async () => {
      const write = deferredWrite()
      writeTextMock.mockReturnValue(write.promise)
      const { rerenderSession } = renderSession(makeSession(kind))
      click()
      rerenderSession({ ...makeSession(kind), title: 'Unrelated title update' })
      expectNoFeedback()
      await settle(write)
      expect(writeTextMock).toHaveBeenCalledExactlyOnceWith(originalText)
      expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
      expect(notifyErrorMock).not.toHaveBeenCalled()
      expectCopied()
    })

    it.each<Outcome>(['resolve', 'reject'])(
      'suppresses a pending %s when the thread is hidden but kept mounted',
      async (outcome) => {
        const write = deferredWrite()
        writeTextMock.mockReturnValueOnce(write.promise)
        const session = makeSession(kind)
        const { rerenderSession } = renderSession(session)
        click()
        rerenderSession(session, false)
        expect(button()).toBeDisabled()
        await settle(write, outcome)
        expectNoFeedback()

        rerenderSession(session, true)
        await act(async () => {
          click()
        })
        expect(writeTextMock.mock.calls).toEqual([[originalText], [originalText]])
        expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
        expectCopied()
      }
    )

    it('does not let an obsolete completion release a newer pending write', async () => {
      const obsolete = deferredWrite()
      const current = deferredWrite()
      writeTextMock.mockReturnValueOnce(obsolete.promise).mockReturnValue(current.promise)
      const { rerenderSession } = renderSession(makeSession(kind))
      click()
      rerenderSession(makeSession(kind, changedText))
      click()
      await settle(obsolete)
      expectNoFeedback()
      click()
      expect(writeTextMock.mock.calls).toEqual([[originalText], [changedText]])
      await settle(current)
      expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel)
      expectCopied()
    })

    it('restarts the 1800ms feedback timer from the most recent successful completion', async () => {
      vi.useFakeTimers()
      renderSession(makeSession(kind))
      await act(async () => {
        click()
      })
      expectCopied()
      await act(async () => {
        vi.advanceTimersByTime(1200)
        fireEvent.click(screen.getByRole('button', { name: copiedLabel }))
      })
      expectCopied()
      act(() => vi.advanceTimersByTime(600))
      expectCopied()
      act(() => vi.advanceTimersByTime(1199))
      expectCopied()
      act(() => vi.advanceTimersByTime(1))
      expect(button()).not.toHaveClass('MuiIconButton-colorSuccess')
      expect(screen.queryByTestId('copy-done-icon')).not.toBeInTheDocument()
      // MUI's exiting tooltip transition is independent of the copied-state deadline.
      act(() => vi.advanceTimersByTime(300))
      expectIdle()
      expect(writeTextMock.mock.calls).toEqual([[originalText], [originalText]])
      expect(notifySuccessMock.mock.calls).toEqual([[copiedLabel], [copiedLabel]])
      expect(notifyErrorMock).not.toHaveBeenCalled()
    })
  }
)
