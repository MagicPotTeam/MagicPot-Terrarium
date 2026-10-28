import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessageList from './ChatMessageList'
import type { ChatSession } from '../chatStorage'

// Real list and copy buttons; only translation/notification boundaries and the jsdom
// clipboard are doubles. This is unit evidence, not OS clipboard acceptance.
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

const theme = createTheme()
const nonemptyText = '  # 雪 🪴 e\u0301\n\n**bold** — العربية\nline\twith  spaces\n'
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
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  vi.restoreAllMocks()
})

describe('ChatMessageList empty user copy (jsdom clipboard unit)', () => {
  it('does not copy or notify for empty code or an attachment-only user but copies nonempty user text exactly', async () => {
    const session: ChatSession = {
      id: 'empty-user-copy-session',
      title: 'Empty user copy regression',
      messages: [
        {
          role: 'user',
          content: '',
          hiddenContext: 'Never copy this hidden context',
          attachments: [
            {
              type: 'file',
              url: 'local-media:///attachment-only.txt',
              fileName: 'attachment-only.txt'
            }
          ]
        },
        {
          role: 'user',
          content: nonemptyText,
          hiddenContext: 'Never copy this hidden context either'
        }
      ]
    }
    render(
      <ThemeProvider theme={theme}>
        <ChatMessageList
          currentSession={session}
          isLoading={false}
          editingMessageIndex={null}
          editingContent=""
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

    expect(screen.getByText('attachment-only.txt')).toBeInTheDocument()
    const actions = screen.getAllByTestId('user-message-actions')
    expect(actions).toHaveLength(2)
    const emptyCopyButton = within(actions[0]).getByRole('button', { name: 'chat.copy_prompt' })
    const nonemptyCopyButton = within(actions[1]).getByRole('button', { name: 'chat.copy_prompt' })

    expect(emptyCopyButton).toBeDisabled()
    await act(async () => {
      fireEvent.click(emptyCopyButton)
    })
    expect(writeTextMock).toHaveBeenCalledTimes(0)
    expect(notifySuccessMock).toHaveBeenCalledTimes(0)
    expect(notifyErrorMock).toHaveBeenCalledTimes(0)
    expect(emptyCopyButton).not.toHaveClass('MuiIconButton-colorSuccess')
    expect(screen.queryByTestId('copy-done-icon')).not.toBeInTheDocument()

    expect(nonemptyCopyButton).toBeEnabled()
    await act(async () => {
      fireEvent.click(nonemptyCopyButton)
    })
    expect(writeTextMock).toHaveBeenCalledExactlyOnceWith(nonemptyText)
    expect(notifySuccessMock).toHaveBeenCalledExactlyOnceWith('chat.prompt_copied')
    expect(notifyErrorMock).toHaveBeenCalledTimes(0)
    expect(nonemptyCopyButton).toHaveAccessibleName('chat.prompt_copied')
    expect(nonemptyCopyButton).toHaveClass('MuiIconButton-colorSuccess')
    expect(emptyCopyButton).toBeDisabled()
    expect(emptyCopyButton).toHaveAccessibleName('chat.copy_prompt')
    expect(emptyCopyButton).not.toHaveClass('MuiIconButton-colorSuccess')
  })

  it('does not copy or notify for an empty fenced code block', async () => {
    const session: ChatSession = {
      id: 'empty-code-copy-session',
      title: 'Empty code copy regression',
      messages: [{ role: 'assistant', content: '```text\n```' }]
    }

    render(
      <ThemeProvider theme={theme}>
        <ChatMessageList
          currentSession={session}
          isLoading={false}
          editingMessageIndex={null}
          editingContent=""
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

    const emptyCodeButton = screen.getByRole('button', { name: 'Copy code' })
    expect(emptyCodeButton).toBeDisabled()
    await act(async () => {
      fireEvent.click(emptyCodeButton)
    })
    expect(writeTextMock).not.toHaveBeenCalled()
    expect(notifySuccessMock).not.toHaveBeenCalled()
    expect(notifyErrorMock).not.toHaveBeenCalled()
    expect(emptyCodeButton).not.toHaveClass('MuiIconButton-colorSuccess')
  })
})
