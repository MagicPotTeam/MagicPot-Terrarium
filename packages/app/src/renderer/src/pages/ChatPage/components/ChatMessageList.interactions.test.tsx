import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import ChatMessageList from './ChatMessageList'
import type { ChatSession } from '../chatStorage'

// Real list, bubbles and edit form. Only translation/notification boundaries are mocked.
// Clipboard is a jsdom unit double, not OS clipboard, Electron, provider or native-drag evidence.
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
const theme = createTheme()
const originalText = '# 雪 🪴 e\u0301\n\n**bold** — العربية\nline\twith  spaces'
const writeTextMock = vi.fn<(text: string) => Promise<void>>()
let clipboardDescriptor: PropertyDescriptor | undefined

const freeze = <T,>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

const renderSession = (
  session: ChatSession,
  options: Pick<ListProps, 'onDropImageAttachments'> = {}
) => {
  const onSendEditedMessage = vi.fn<ListProps['onSendEditedMessage']>()
  const onSetEditingIndex = vi.fn<ListProps['onSetEditingIndex']>()
  const onSetEditingContent = vi.fn<ListProps['onSetEditingContent']>()
  const Harness = () => {
    const [editingMessageIndex, setEditingMessageIndex] = React.useState<number | null>(null)
    const [editingContent, setEditingContent] = React.useState('')
    const chatContainerRef = React.useRef<HTMLDivElement>(null)
    const messagesEndRef = React.useRef<HTMLDivElement>(null)
    return (
      <ThemeProvider theme={theme}>
        <ChatMessageList
          currentSession={session}
          isLoading={false}
          editingMessageIndex={editingMessageIndex}
          editingContent={editingContent}
          onSetEditingIndex={(index) => {
            onSetEditingIndex(index)
            setEditingMessageIndex(index)
          }}
          onSetEditingContent={(content) => {
            onSetEditingContent(content)
            setEditingContent(content)
          }}
          onSendEditedMessage={onSendEditedMessage}
          onDropImageAttachments={options.onDropImageAttachments}
          onPreviewImage={vi.fn()}
          onImageContextMenu={vi.fn()}
          onDownloadAttachment={vi.fn()}
          onSendModelToDcc={vi.fn()}
          chatContainerRef={chatContainerRef}
          messagesEndRef={messagesEndRef}
        />
      </ThemeProvider>
    )
  }
  render(<Harness />)
  return { onSendEditedMessage, onSetEditingIndex, onSetEditingContent }
}

const editingSession = (): ChatSession =>
  freeze({
    id: 'interactions-edit',
    title: 'Edit without implicit send',
    messages: [
      { role: 'user', content: 'Earlier prompt' },
      { role: 'assistant', content: 'Earlier reply' },
      {
        role: 'user',
        content: originalText,
        hiddenContext: 'hidden canvas context: 雪',
        attachments: [
          { type: 'file', url: 'local-media:///remove.txt', fileName: 'remove.txt' },
          { type: 'file', url: 'local-media:///keep.txt', fileName: 'keep.txt' },
          {
            type: 'file',
            url: 'local-media:///hidden.txt',
            fileName: 'hidden.txt',
            hiddenFromChatView: true
          }
        ]
      },
      { role: 'assistant', content: 'Later reply must not become rerun context' }
    ]
  })

const startEditing = () => {
  // jsdom does not implement hover layout; dispatch to the real bubble's edit button.
  const actions = screen.getAllByTestId('user-message-actions')[1]
  fireEvent.click(within(actions).getByRole('button', { name: 'chat.edit_message' }))
  return screen.getByRole('textbox')
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const dropImage = (fileName: string) => {
  const file = new File(['image'], fileName, { type: 'image/png' })
  fireEvent.drop(screen.getByTestId('edit-message-composer'), {
    dataTransfer: { types: ['Files'], files: [file] }
  })
  return file
}

const imageAttachment = (fileName: string): ChatAttachment => ({
  type: 'image',
  url: `local-media:///${fileName}`,
  fileName
})

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
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  vi.restoreAllMocks()
})

describe.each([
  { role: 'user' as const, copyLabel: 'chat.copy_prompt', copiedLabel: 'chat.prompt_copied' },
  { role: 'assistant' as const, copyLabel: 'Copy reply', copiedLabel: 'Reply copied' }
])(
  'ChatMessageList $role copy (mocked clipboard, unit-only)',
  ({ role, copyLabel, copiedLabel }) => {
    const renderCopy = () =>
      renderSession(
        freeze({
          id: `interactions-copy-${role}`,
          title: 'Exact Unicode and multiline copy',
          messages: [{ role, content: originalText, hiddenContext: 'not clipboard content' }]
        })
      )

    const expectNoSuccess = () => {
      expect.soft(notifySuccessMock).not.toHaveBeenCalled()
      expect.soft(screen.queryByRole('button', { name: copiedLabel })).not.toBeInTheDocument()
      expect.soft(screen.queryByTestId('copy-done-icon')).not.toBeInTheDocument()
      expect.soft(screen.queryByRole('tooltip', { name: copiedLabel })).not.toBeInTheDocument()
    }

    it('copies the original Unicode, combining mark, Markdown and multiline text exactly once', async () => {
      const { onSendEditedMessage } = renderCopy()
      fireEvent.click(screen.getByRole('button', { name: copyLabel }))

      await waitFor(() => expect(notifySuccessMock).toHaveBeenCalledWith(copiedLabel))
      expect(writeTextMock).toHaveBeenCalledExactlyOnceWith(originalText)
      expect(notifySuccessMock).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: copiedLabel })).toBeInTheDocument()
      expect(screen.getByTestId('copy-done-icon')).toBeInTheDocument()
      expect(onSendEditedMessage).not.toHaveBeenCalled()
    })

    it('does not announce success until the clipboard write resolves', async () => {
      let resolveWrite!: () => void
      const pendingWrite = new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
      writeTextMock.mockReturnValue(pendingWrite)
      const { onSendEditedMessage } = renderCopy()
      fireEvent.click(screen.getByRole('button', { name: copyLabel }))

      expect(writeTextMock).toHaveBeenCalledExactlyOnceWith(originalText)
      expectNoSuccess()
      await act(async () => {
        resolveWrite()
        await pendingWrite
      })
      await waitFor(() => expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith(copiedLabel))
      expect(screen.getByRole('button', { name: copiedLabel })).toBeInTheDocument()
      expect(onSendEditedMessage).not.toHaveBeenCalled()
    })

    it('does not show a success notification, copied label or icon when clipboard permission rejects', async () => {
      const failure = new DOMException('Clipboard permission denied', 'NotAllowedError')
      const failedWrite = Promise.reject(failure)
      // Observe the test-owned rejection to avoid contaminating other tests with an unhandled
      // promise. This does not change the promise returned to production or its feedback path.
      const observedFailure = failedWrite.catch((error: unknown) => error)
      writeTextMock.mockReturnValue(failedWrite)
      const { onSendEditedMessage } = renderCopy()
      fireEvent.click(screen.getByRole('button', { name: copyLabel }))

      await act(async () => {
        expect(await observedFailure).toBe(failure)
      })
      expect(writeTextMock).toHaveBeenCalledExactlyOnceWith(originalText)
      expectNoSuccess()
      expect(notifyErrorMock).toHaveBeenCalledExactlyOnceWith('Failed to copy text. Try again.')
      expect(onSendEditedMessage).not.toHaveBeenCalled()
    })
  }
)

describe('ChatMessageList real edit-form interactions', () => {
  it('clears the drag highlight when a non-image file is dropped without importing it', () => {
    const onDropImageAttachments = vi.fn().mockResolvedValue([])
    renderSession(editingSession(), { onDropImageAttachments })
    startEditing()
    const composer = screen.getByTestId('edit-message-composer')
    const dataTransfer = {
      types: ['Files'],
      files: [new File(['document'], 'notes.pdf', { type: 'application/pdf' })]
    }
    fireEvent.dragOver(composer, { dataTransfer })
    expect(composer).toHaveStyle({ outline: '2px dashed' })

    expect(fireEvent.drop(composer, { dataTransfer })).toBe(true)

    expect(composer).toHaveStyle({ outline: 'none' })
    expect(onDropImageAttachments).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save & Rerun' })).toBeEnabled()
  })

  it('waits for a dropped image before allowing Save & Rerun', async () => {
    const imported = deferred<ChatAttachment[]>()
    const onDropImageAttachments = vi.fn().mockReturnValue(imported.promise)
    const session = editingSession()
    const { onSendEditedMessage } = renderSession(session, { onDropImageAttachments })
    startEditing()
    const file = dropImage('pending.png')
    expect(onDropImageAttachments).toHaveBeenCalledExactlyOnceWith([file])
    const submit = screen.getByRole('button', { name: 'Save & Rerun' })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(onSendEditedMessage).not.toHaveBeenCalled()

    const attachment = imageAttachment('pending.png')
    await act(async () => {
      imported.resolve([attachment])
      await imported.promise
    })
    expect(submit).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Remove pending.png' })).toBeInTheDocument()
    fireEvent.click(submit)
    expect(onSendEditedMessage).toHaveBeenCalledExactlyOnceWith(
      originalText,
      [...session.messages[2].attachments!, attachment],
      session.messages[2].hiddenContext,
      session.messages.slice(0, 2)
    )
  })

  it('keeps Save & Rerun disabled until all concurrent image drops finish', async () => {
    const first = deferred<ChatAttachment[]>()
    const second = deferred<ChatAttachment[]>()
    const onDropImageAttachments = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const session = editingSession()
    const { onSendEditedMessage } = renderSession(session, { onDropImageAttachments })
    startEditing()
    dropImage('first.png')
    dropImage('second.png')
    const submit = screen.getByRole('button', { name: 'Save & Rerun' })
    expect(submit).toBeDisabled()
    await act(async () => {
      first.resolve([imageAttachment('first.png')])
      await first.promise
    })
    expect(submit).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove first.png' })).toBeInTheDocument()
    await act(async () => {
      second.resolve([imageAttachment('second.png')])
      await second.promise
    })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(onSendEditedMessage.mock.calls[0][1]).toEqual([
      ...session.messages[2].attachments!,
      imageAttachment('first.png'),
      imageAttachment('second.png')
    ])
  })

  it('allows retry after a failed image import without losing existing attachments', async () => {
    const imported = deferred<ChatAttachment[]>()
    const onDropImageAttachments = vi.fn().mockReturnValue(imported.promise)
    const session = editingSession()
    const { onSendEditedMessage } = renderSession(session, { onDropImageAttachments })
    startEditing()
    dropImage('failed.png')
    const submit = screen.getByRole('button', { name: 'Save & Rerun' })
    expect(submit).toBeDisabled()
    await act(async () => {
      imported.reject(new Error('Image import failed'))
      await imported.promise.catch(() => undefined)
    })
    expect(screen.getByText('Image import failed')).toBeInTheDocument()
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(onSendEditedMessage.mock.calls[0][1]).toEqual(session.messages[2].attachments)
  })

  it.each(['resolve', 'reject'] as const)(
    'keeps Cancel available and ignores a late %s after reopening the editor',
    async (outcome) => {
      const oldImport = deferred<ChatAttachment[]>()
      const currentImport = deferred<ChatAttachment[]>()
      const onDropImageAttachments = vi
        .fn()
        .mockReturnValueOnce(oldImport.promise)
        .mockReturnValueOnce(currentImport.promise)
      const { onSendEditedMessage } = renderSession(editingSession(), {
        onDropImageAttachments
      })
      startEditing()
      dropImage('old.png')
      const cancel = screen.getByRole('button', { name: 'Cancel' })
      expect(cancel).toBeEnabled()
      fireEvent.click(cancel)
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      startEditing()
      dropImage('current.png')
      await act(async () => {
        if (outcome === 'resolve') oldImport.resolve([imageAttachment('old.png')])
        else oldImport.reject(new Error('Stale import failure'))
        await oldImport.promise.catch(() => undefined)
      })
      expect(screen.queryByRole('button', { name: 'Remove old.png' })).not.toBeInTheDocument()
      expect(screen.queryByText('Stale import failure')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save & Rerun' })).toBeDisabled()
      expect(onSendEditedMessage).not.toHaveBeenCalled()
      await act(async () => {
        currentImport.resolve([imageAttachment('current.png')])
        await currentImport.promise
      })
      expect(screen.getByRole('button', { name: 'Save & Rerun' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Remove current.png' })).toBeInTheDocument()
    }
  )

  it.each(['Cancel', 'Escape'] as const)(
    '%s discards typed text and attachment removal without sending or mutating the original',
    async (action) => {
      const user = userEvent.setup()
      const session = editingSession()
      const before = JSON.stringify(session)
      const originalMessage = session.messages[2]
      const originalAttachments = originalMessage.attachments
      const { onSendEditedMessage, onSetEditingIndex, onSetEditingContent } = renderSession(session)
      const editor = startEditing()
      expect(editor).toHaveValue(originalText)
      await user.clear(editor)
      await user.type(editor, 'Discard this draft 雪')
      expect(editor).toHaveValue('Discard this draft 雪')
      await user.click(screen.getByRole('button', { name: 'Remove remove.txt' }))
      expect(screen.queryByRole('button', { name: 'Remove remove.txt' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Remove keep.txt' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Remove hidden.txt' })).not.toBeInTheDocument()
      expect(onSendEditedMessage).not.toHaveBeenCalled()
      expect(JSON.stringify(session)).toBe(before)

      if (action === 'Cancel') {
        await user.click(screen.getByRole('button', { name: 'Cancel' }))
      } else {
        await user.click(editor)
        await user.keyboard('{Escape}')
      }

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(onSetEditingIndex.mock.calls).toEqual([[2], [null]])
      expect(onSetEditingContent).toHaveBeenLastCalledWith('')
      expect(onSendEditedMessage).not.toHaveBeenCalled()
      expect(session.messages[2]).toBe(originalMessage)
      expect(session.messages[2].attachments).toBe(originalAttachments)
      expect(JSON.stringify(session)).toBe(before)
      expect(screen.getByText('remove.txt')).toBeInTheDocument()
      expect(screen.getByText('keep.txt')).toBeInTheDocument()
      expect(screen.getByText('Later reply must not become rerun context')).toBeInTheDocument()

      expect(startEditing()).toHaveValue(originalText)
      expect(screen.getByRole('button', { name: 'Remove remove.txt' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Remove keep.txt' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onSendEditedMessage).not.toHaveBeenCalled()
      expect(JSON.stringify(session)).toBe(before)
    }
  )

  it('sends once only on explicit Save & Rerun, with edited attachments and preceding context', async () => {
    const user = userEvent.setup()
    const session = editingSession()
    const before = JSON.stringify(session)
    const { onSendEditedMessage, onSetEditingIndex, onSetEditingContent } = renderSession(session)
    const editor = startEditing()
    const draft = '  Revised 雪 🪴\nsecond e\u0301 line  '
    fireEvent.change(editor, { target: { value: draft } })
    expect(editor).toHaveValue(draft)
    await user.click(screen.getByRole('button', { name: 'Remove remove.txt' }))
    expect(screen.queryByRole('button', { name: 'Remove remove.txt' })).not.toBeInTheDocument()
    for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', ...modifiers })
    }
    fireEvent.blur(editor)
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    expect(JSON.stringify(session)).toBe(before)

    // The controlled harness unmounts the editor on the first activation.
    await user.dblClick(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(onSendEditedMessage).toHaveBeenCalledExactlyOnceWith(
      'Revised 雪 🪴\nsecond e\u0301 line',
      session.messages[2].attachments?.slice(1),
      session.messages[2].hiddenContext,
      session.messages.slice(0, 2)
    )
    expect(onSendEditedMessage.mock.calls[0][3]).not.toBe(session.messages)
    expect(onSendEditedMessage.mock.calls[0][3][0]).toBe(session.messages[0])
    expect(onSetEditingIndex).toHaveBeenLastCalledWith(null)
    expect(onSetEditingContent).toHaveBeenLastCalledWith('')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(JSON.stringify(session)).toBe(before)
  })

  it('permits an unchanged nonempty prompt to rerun once with its original attachments and context', async () => {
    const user = userEvent.setup()
    const session = editingSession()
    const before = JSON.stringify(session)
    const { onSendEditedMessage } = renderSession(session)
    expect(startEditing()).toHaveValue(originalText)
    const submit = screen.getByRole('button', { name: 'Save & Rerun' })
    expect(submit).toBeEnabled()
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    await user.click(submit)

    expect(onSendEditedMessage).toHaveBeenCalledExactlyOnceWith(
      originalText,
      session.messages[2].attachments,
      session.messages[2].hiddenContext,
      session.messages.slice(0, 2)
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(JSON.stringify(session)).toBe(before)
  })

  it('passes undefined attachments after explicitly saving removal of the last attachment', async () => {
    const user = userEvent.setup()
    const source = editingSession()
    const session = freeze({
      ...source,
      messages: source.messages.map((message, index) =>
        index === 2 ? { ...message, attachments: message.attachments?.slice(0, 1) } : message
      )
    })
    const before = JSON.stringify(session)
    const { onSendEditedMessage } = renderSession(session)
    startEditing()
    await user.click(screen.getByRole('button', { name: 'Remove remove.txt' }))
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Save & Rerun' }))

    expect(onSendEditedMessage).toHaveBeenCalledExactlyOnceWith(
      originalText,
      undefined,
      session.messages[2].hiddenContext,
      session.messages.slice(0, 2)
    )
    expect(JSON.stringify(session)).toBe(before)
  })

  it.each(['', ' \n\t  '])(
    'does not submit empty or whitespace-only text (%j), even with attachments',
    (draft) => {
      const session = editingSession()
      const before = JSON.stringify(session)
      const { onSendEditedMessage } = renderSession(session)
      const editor = startEditing()
      fireEvent.change(editor, { target: { value: draft } })
      const submit = screen.getByRole('button', { name: 'Save & Rerun' })
      expect(submit).toBeDisabled()
      // Direct dispatch probes the disabled guard; user-event correctly refuses pointer access.
      fireEvent.click(submit)
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', ctrlKey: true })

      expect(onSendEditedMessage).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox')).toHaveValue(draft)
      expect(screen.getByRole('button', { name: 'Remove remove.txt' })).toBeInTheDocument()
      expect(JSON.stringify(session)).toBe(before)
    }
  )
})
