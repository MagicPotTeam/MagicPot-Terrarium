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
function setup(session: ChatSession, target: number, extra: Partial<Props> = {}) {
  const before = structuredClone(session)
  const onSendEditedMessage = vi.fn<Props['onSendEditedMessage']>()
  const Harness = () => {
    const [index, setIndex] = React.useState<number | null>(null)
    const [content, setContent] = React.useState('')
    const container = React.useRef<HTMLDivElement>(null), end = React.useRef<HTMLDivElement>(null)
    return <ThemeProvider theme={theme}><ChatMessageList currentSession={session} isLoading={false}
      editingMessageIndex={index} editingContent={content} onSetEditingIndex={setIndex} onSetEditingContent={setContent}
      onSendEditedMessage={onSendEditedMessage} onPreviewImage={vi.fn()} onImageContextMenu={vi.fn()}
      onDownloadAttachment={vi.fn()} onSendModelToDcc={vi.fn()} chatContainerRef={container} messagesEndRef={end} {...extra} /></ThemeProvider>
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
  it('rejects a prefix whose only report is in an assistant message', () => {
    const session: ChatSession = { id: 'assistant-report', title: 'fixture', messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply', attachments: [report] }, { role: 'user', content: 'original' }] }
    assertRejected(setup(session, 1))
  })
  it('checks the projected history: a projector that drops the history lets the edit submit', () => {
    const session: ChatSession = { id: 'projected', title: 'fixture', messages: [{ role: 'user', content: 'earlier', attachments: [report] }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'original' }] }
    const projectEditHistory = vi.fn<NonNullable<Props['projectEditHistory']>>(() => [])
    const f = setup(session, 1, { projectEditHistory })
    expect(projectEditHistory).toHaveBeenCalledWith(session.messages.slice(0, 2))
    expect(screen.queryByText(fixedMessage)).not.toBeInTheDocument()
    expect(f.onSendEditedMessage).toHaveBeenCalledOnce()
    expect(f.onSendEditedMessage.mock.calls[0][0]).toBe('changed text')
    // The send still carries the full kept history; only the preflight looks at the projection.
    expect(f.onSendEditedMessage.mock.calls[0][3]).toEqual(session.messages.slice(0, 2))
    expect(f.session).toEqual(f.before)
  })
  it('still refuses a report in the edited message when the projector drops the history', () => {
    const session: ChatSession = { id: 'projected-current', title: 'fixture', messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'original', attachments: [report] }] }
    assertRejected(setup(session, 1, { projectEditHistory: () => [] }))
  })
  it('refuses when the projector keeps the report', () => {
    const session: ChatSession = { id: 'projected-kept', title: 'fixture', messages: [{ role: 'user', content: 'earlier', attachments: [report] }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'original' }] }
    assertRejected(setup(session, 1, { projectEditHistory: (prefix) => prefix.slice(-2) }))
  })
})
