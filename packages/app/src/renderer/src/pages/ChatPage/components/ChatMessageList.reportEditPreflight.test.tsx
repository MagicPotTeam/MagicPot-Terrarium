import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

describe('real ChatMessageList async MAIN report preflight for edits', () => {
  const bound: ChatAttachment = { ...report, reportBundleBinding: `rb1.${'C'.repeat(43)}` }
  const historySession = (): ChatSession => ({ id: 'bound-history', title: 'fixture', messages: [{ role: 'user', content: 'earlier', attachments: [bound] }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'original' }] })

  it('keeps the edit form with the typed text and the fixed message when MAIN refuses a bound history report', async () => {
    const session = historySession()
    const preflightEditReports = vi.fn<NonNullable<Props['preflightEditReports']>>(async () => { throw new Error(fixedMessage) })
    const f = setup(session, 1, { preflightEditReports })
    await waitFor(() => expect(screen.getByText(fixedMessage)).toBeInTheDocument())
    expect(preflightEditReports).toHaveBeenCalledOnce()
    expect(preflightEditReports).toHaveBeenCalledWith(session.messages.slice(0, 2), undefined)
    assertRejected(f)
  })

  it('submits the edit once MAIN verifies the bound history report', async () => {
    const session = historySession()
    let accept: () => void = () => undefined
    const preflightEditReports = vi.fn<NonNullable<Props['preflightEditReports']>>(() => new Promise<void>(resolve => { accept = resolve }))
    const f = setup(session, 1, { preflightEditReports })
    await waitFor(() => expect(preflightEditReports).toHaveBeenCalledOnce())
    // Nothing is given up while MAIN is still deciding, and a second click starts no second check.
    expect(f.onSendEditedMessage).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('changed text')
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(preflightEditReports).toHaveBeenCalledOnce()
    accept()
    await waitFor(() => expect(f.onSendEditedMessage).toHaveBeenCalledOnce())
    expect(f.onSendEditedMessage.mock.calls[0][0]).toBe('changed text')
    expect(f.onSendEditedMessage.mock.calls[0][3]).toEqual(session.messages.slice(0, 2))
    expect(screen.queryByText(fixedMessage)).not.toBeInTheDocument()
    expect(f.session).toEqual(f.before)
  })

  it('keeps the form when the text changes while MAIN answers, and a new Save checks the new text', async () => {
    const session = historySession()
    let accept: () => void = () => undefined
    const preflightEditReports = vi.fn<NonNullable<Props['preflightEditReports']>>(() => new Promise<void>(resolve => { accept = resolve }))
    const f = setup(session, 1, { preflightEditReports })
    await waitFor(() => expect(preflightEditReports).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed text, typed on' } })
    accept()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.onSendEditedMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('edit-message-composer')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('changed text, typed on')
    preflightEditReports.mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    await waitFor(() => expect(f.onSendEditedMessage).toHaveBeenCalledOnce())
    expect(preflightEditReports).toHaveBeenCalledTimes(2)
    expect(f.onSendEditedMessage.mock.calls[0][0]).toBe('changed text, typed on')
  })

  it('passes the edited bound report itself to the preflight', async () => {
    const session: ChatSession = { id: 'bound-current', title: 'fixture', messages: [{ role: 'user', content: 'original', attachments: [bound] }] }
    const preflightEditReports = vi.fn<NonNullable<Props['preflightEditReports']>>(async () => undefined)
    const f = setup(session, 0, { preflightEditReports })
    await waitFor(() => expect(f.onSendEditedMessage).toHaveBeenCalledOnce())
    expect(preflightEditReports).toHaveBeenCalledWith([], [bound])
    expect(f.onSendEditedMessage.mock.calls[0][1]).toEqual([bound])
  })

  it('does not call the preflight for an edit without any primary report', () => {
    const { reportBundleRole: _role, ...ordinary } = report
    const session: ChatSession = { id: 'plain', title: 'fixture', messages: [{ role: 'user', content: 'original', attachments: [ordinary] }] }
    const preflightEditReports = vi.fn<NonNullable<Props['preflightEditReports']>>(async () => undefined)
    const f = setup(session, 0, { preflightEditReports })
    expect(preflightEditReports).not.toHaveBeenCalled()
    expect(f.onSendEditedMessage).toHaveBeenCalledOnce()
  })
})
