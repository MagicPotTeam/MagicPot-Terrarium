import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { ChatSession } from '../chatStorage'
import ChatMessageList from './ChatMessageList'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }) }))

type Props = React.ComponentProps<typeof ChatMessageList>
const report: ChatAttachment = { type: 'file', url: 'local-media:///report.txt', fileName: 'report.txt', reportBundleId: 'fixture', reportBundleManifestUrl: 'local-media:///manifest.json', reportBundleRole: 'primary-report' }
const fixedMessage = 'Report bundles are temporarily unavailable because their source cannot be verified. Remove the report from your current draft where possible, or start a new empty conversation without it. A new conversation does not carry over previous context.'
const theme = createTheme()
function setup(session: ChatSession, target: number) {
  const before = structuredClone(session)
  const onSendEditedMessage = vi.fn<Props['onSendEditedMessage']>()
  const Harness = () => {
    const [index, setIndex] = React.useState<number | null>(null)
    const [content, setContent] = React.useState('')
    const container = React.useRef<HTMLDivElement>(null), end = React.useRef<HTMLDivElement>(null)
    return <ThemeProvider theme={theme}><ChatMessageList currentSession={session} isLoading={false}
      editingMessageIndex={index} editingContent={content} onSetEditingIndex={setIndex} onSetEditingContent={setContent}
      onSendEditedMessage={onSendEditedMessage} onPreviewImage={vi.fn()} onImageContextMenu={vi.fn()}
      onDownloadAttachment={vi.fn()} onSendModelToDcc={vi.fn()} chatContainerRef={container} messagesEndRef={end} /></ThemeProvider>
  }
  render(<Harness />)
  fireEvent.click(within(screen.getAllByTestId('user-message-actions')[target]).getByRole('button', { name: 'chat.edit_message' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed text' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
  return { onSendEditedMessage, before, session }
}
const assertRejected = (f: ReturnType<typeof setup>) => {
  expect(screen.getByText(fixedMessage)).toBeInTheDocument()
  expect(screen.getByTestId('edit-message-composer')).toBeInTheDocument()
  expect(screen.getByRole('textbox')).toHaveValue('changed text')
  expect(f.onSendEditedMessage).not.toHaveBeenCalled()
  expect(f.session).toEqual(f.before)
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('real ChatMessageList report edit preflight', () => {
  it('rejects a primary report in the edited message and retains the edit', () => {
    const session: ChatSession = { id: 'report', title: 'fixture', messages: [{ role: 'user', content: 'original', attachments: [report] }] }
    assertRejected(setup(session, 0))
  })
  it('submits an ordinary file with the same other fields and no role', () => {
    const { reportBundleRole: _role, ...ordinary } = report
    const session: ChatSession = { id: 'ordinary', title: 'fixture', messages: [{ role: 'user', content: 'original', attachments: [ordinary] }] }
    const f = setup(session, 0)
    expect(f.onSendEditedMessage).toHaveBeenCalledOnce()
    expect(f.onSendEditedMessage.mock.calls[0][0]).toBe('changed text')
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([ordinary])
    expect(f.session).toEqual(f.before)
  })
  it('rejects a report in the history prefix and keeps the current edit open', () => {
    const session: ChatSession = { id: 'history', title: 'fixture', messages: [{ role: 'user', content: 'earlier', attachments: [report] }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'original' }] }
    assertRejected(setup(session, 1))
  })
})
