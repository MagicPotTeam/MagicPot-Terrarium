import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { useEffect, useMemo } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import type { ChatSession } from './chatStorage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

// The edit form belongs to the thread it was opened in (P6 cross-session edit leak):
// a thread switch closes it, and callbacks captured by a form of an earlier thread
// (submit, setters, attachment receiver registration) cannot act on another thread.

type Receiver = (attachment: ChatAttachment) => void
type ListProps = {
  currentSession?: ChatSession
  editingMessageIndex: number | null
  editingContent: string
  onSetEditingIndex: (index: number | null) => void
  onSetEditingContent: (value: string) => void
  onRegisterEditingAttachmentReceiver: (receiver: Receiver | null) => void
  onSendEditedMessage: (
    content: string,
    attachments: ChatAttachment[] | undefined,
    hiddenContext: string | undefined,
    baseMessages: ChatMessage[]
  ) => void
}

const f = vi.hoisted(() => ({
  config: null as Config | null,
  sessions: [] as ChatSession[],
  props: null as null | ListProps,
  receive: vi.fn(),
  materialize: vi.fn(),
  augment: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
  stream: vi.fn(),
  fetch: vi.fn()
}))

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string) => key
  })
}))
vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: f.config,
    isReady: true,
    buildEnv: DEFAULT_BUILD_ENV,
    configUtils: {},
    updateConfig: vi.fn()
  })
}))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({
  useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null })
}))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: vi.fn(),
    notifyInfo: vi.fn(),
    notifyError: f.error,
    notifyWarning: f.warning
  })
}))
vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({
    availableProfiles: [{ id: 'fixture-profile', model_name: 'Fixture', model_use: 'chat' }],
    remoteProfiles: []
  })
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcFs: {}, svcLLMProxy: {}, svcManagedMedia: {} })
}))
vi.mock('@renderer/utils/droppedImageUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/utils/droppedImageUtils')>()),
  materializeInternalImageDragAttachment: (attachment: ChatAttachment) => f.materialize(attachment)
}))
vi.mock('./chatVideoAttachmentUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatVideoAttachmentUtils')>()
  return {
    ...actual,
    augmentAttachmentsWithVideoBoundaryFrames: (
      ...args: Parameters<typeof actual.augmentAttachmentsWithVideoBoundaryFrames>
    ) =>
      f.augment.getMockImplementation()
        ? f.augment(...args)
        : actual.augmentAttachmentsWithVideoBoundaryFrames(...args)
  }
})
vi.mock('./chatStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatStorage')>()),
  loadAllSessions: async () => clone(f.sessions),
  saveSessionToDB: async (session: ChatSession) => {
    const index = f.sessions.findIndex((candidate) => candidate.id === session.id)
    if (index < 0) f.sessions.push(clone(session))
    else f.sessions[index] = clone(session)
  },
  debouncedSaveSessions: () => undefined,
  cancelDebouncedSessionSave: vi.fn(),
  migrateFromLocalStorage: async () => null
}))
vi.mock('./chatRequestUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatRequestUtils')>()),
  requestChatCompletion: f.request,
  requestChatCompletionStream: f.stream
}))

vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('./components/SessionSidebar', () => ({
  default: ({
    sessions,
    onSelectSession
  }: {
    sessions: ChatSession[]
    onSelectSession: (id: string) => void
  }) => (
    <div>
      {sessions.map((session) => (
        <button key={session.id} onClick={() => onSelectSession(session.id)}>
          Open {session.id}
        </button>
      ))}
    </div>
  )
}))
vi.mock('./components/ChatComposer', () => ({
  default: ({ inputValue }: { inputValue: string }) => (
    <input data-testid="composer-input" value={inputValue} readOnly />
  )
}))
// Like the real list, the edit form exists only while an index is being edited and
// registers its receiver from an effect whose cleanup runs with the old prop.
vi.mock('./components/ChatMessageList', () => ({
  default: function MessageList(props: ListProps) {
    f.props = props
    const { currentSession, editingMessageIndex, editingContent } = props
    const sessionId = currentSession?.id
    const receiver = useMemo<Receiver>(
      () => (attachment) => f.receive({ sessionId, index: editingMessageIndex, attachment }),
      [sessionId, editingMessageIndex]
    )
    const register = props.onRegisterEditingAttachmentReceiver
    useEffect(() => {
      if (editingMessageIndex === null) return
      register(receiver)
      return () => register(null)
    }, [editingMessageIndex, receiver, register])
    return (
      <div>
        <span data-testid="session-id">{sessionId ?? ''}</span>
        <pre data-testid="messages">{JSON.stringify(currentSession?.messages ?? [])}</pre>
        <span data-testid="edit-index">{String(editingMessageIndex)}</span>
        <pre data-testid="edit-content">{editingContent}</pre>
        {[0, 2].map((index) => (
          <button
            key={index}
            onClick={() => {
              props.onSetEditingIndex(index)
              props.onSetEditingContent(`Edit draft ${index}`)
            }}
          >
            Edit {index}
          </button>
        ))}
        <button
          onClick={() => {
            // The real form's order: clear the form, then submit in the same handler.
            const index = editingMessageIndex ?? 0
            const baseMessages = currentSession?.messages.slice(0, index) ?? []
            props.onSetEditingIndex(null)
            props.onSetEditingContent('')
            props.onSendEditedMessage(editingContent, undefined, undefined, baseMessages)
          }}
        >
          Submit edit
        </button>
      </div>
    )
  }
}))

const scope = 'edit-thread-ownership'
const theme = createTheme()

const makeSession = (id: string): ChatSession => ({
  id,
  title: id,
  storageScope: scope,
  profileId: 'fixture-profile',
  messages: [
    { role: 'user', content: `${id} message 0` },
    { role: 'assistant', content: `${id} reply 0` },
    { role: 'user', content: `${id} message 1` }
  ],
  draft: {
    inputValue: `${id} composer draft`,
    pendingAttachments: [],
    pendingHiddenContext: '',
    updatedAt: Date.now()
  }
})

const sessionId = () => screen.getByTestId('session-id').textContent
const editIndex = () => screen.getByTestId('edit-index').textContent
const messages = () =>
  JSON.parse(screen.getByTestId('messages').textContent || '[]') as ChatMessage[]
const requestCount = () => f.request.mock.calls.length + f.stream.mock.calls.length
const staleWarnings = () =>
  f.warning.mock.calls.filter(([message]) => message === 'chat.edit_submit_stale').length

const renderPage = async () => {
  f.sessions = [makeSession('session-a'), makeSession('session-b')]
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'session-a')
  const view = render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ChatPage storageScope={scope} />
      </MemoryRouter>
    </ThemeProvider>
  )
  await waitFor(() => expect(sessionId()).toBe('session-a'))
  await waitFor(() =>
    expect(screen.getByTestId('composer-input')).toHaveValue('session-a composer draft')
  )
  return view
}

const selectSession = async (id: string): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: `Open ${id}` }))
  await waitFor(() => expect(sessionId()).toBe(id))
  await waitFor(() =>
    expect(screen.getByTestId('composer-input')).toHaveValue(`${id} composer draft`)
  )
}

const startEdit = async (index: 0 | 2): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: `Edit ${index}` }))
  await waitFor(() => expect(editIndex()).toBe(String(index)))
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  f.config = clone(DEFAULT_CONFIG)
  f.config.use_remote_llm = false
  f.props = null
  f.sessions = []
  f.request.mockResolvedValue({ content: 'fixture reply' })
  f.stream.mockResolvedValue({ response: 'fixture reply', result: { content: 'fixture reply' } })
  f.materialize.mockImplementation(async (attachment: ChatAttachment) => attachment)
  f.fetch.mockRejectedValue(new Error('Unexpected network access in edit ownership test'))
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('fetch', f.fetch)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.unstubAllGlobals()
  expect(f.fetch).not.toHaveBeenCalled()
})

describe('ChatPage edit form thread ownership', () => {
  it('closes the edit on a thread switch, keeps it on re-selection and keeps both composer drafts', async () => {
    await renderPage()
    await startEdit(2)
    await selectSession('session-a')
    expect(editIndex()).toBe('2')
    expect(screen.getByTestId('edit-content')).toHaveTextContent('Edit draft 2')

    await selectSession('session-b')
    expect(editIndex()).toBe('null')
    expect(screen.getByTestId('edit-content')).toBeEmptyDOMElement()

    await selectSession('session-a')
    expect(editIndex()).toBe('null')
    expect(screen.getByTestId('edit-content')).toBeEmptyDOMElement()
    expect(requestCount()).toBe(0)
  })

  it('does not hand an incoming image to the closed edit form of the previous thread', async () => {
    await renderPage()
    await startEdit(0)
    await selectSession('session-b')
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            attachment: { type: 'image', url: 'local-media:///fixture/after-switch.png' }
          }
        })
      )
    })
    await waitFor(() => expect(f.materialize).toHaveBeenCalledOnce())
    expect(f.receive).not.toHaveBeenCalled()
  })

  it('refuses a submit captured in A when called in B, and again after A to B to A, warning once each time', async () => {
    await renderPage()
    await startEdit(2)
    const submitFromA = f.props!.onSendEditedMessage
    await selectSession('session-b')
    act(() => submitFromA('Edited in A', undefined, undefined, []))
    expect(staleWarnings()).toBe(1)

    await selectSession('session-a')
    expect(editIndex()).toBe('null')
    act(() => submitFromA('Edited in A', undefined, undefined, []))
    expect(staleWarnings()).toBe(2)

    await act(async () => {})
    expect(requestCount()).toBe(0)
    expect(messages().map((message) => message.content)).toEqual([
      'session-a message 0',
      'session-a reply 0',
      'session-a message 1'
    ])
    expect(f.sessions.map((session) => session.messages.length)).toEqual([3, 3])
  })

  it('does not let a setter captured in A clear or overwrite an edit started in B', async () => {
    await renderPage()
    await startEdit(0)
    const { onSetEditingIndex, onSetEditingContent } = f.props!
    await selectSession('session-b')
    await startEdit(2)
    act(() => {
      onSetEditingIndex(null)
      onSetEditingContent('')
    })
    expect(editIndex()).toBe('2')
    expect(screen.getByTestId('edit-content')).toHaveTextContent('Edit draft 2')
    act(() => {
      onSetEditingIndex(0)
      onSetEditingContent('Stale text from A')
    })
    expect(editIndex()).toBe('2')
    expect(screen.getByTestId('edit-content')).toHaveTextContent('Edit draft 2')
  })

  it('sends the real form order (clear, then submit) once into the thread that owns the edit', async () => {
    await renderPage()
    await selectSession('session-b')
    await selectSession('session-a')
    await startEdit(2)
    fireEvent.click(screen.getByRole('button', { name: 'Submit edit' }))
    await waitFor(() => expect(requestCount()).toBe(1))
    await waitFor(() =>
      expect(messages().map((message) => message.content)).toEqual([
        'session-a message 0',
        'session-a reply 0',
        'Edit draft 2',
        'fixture reply'
      ])
    )
    expect(editIndex()).toBe('null')
    expect(staleWarnings()).toBe(0)
    expect(sessionId()).toBe('session-a')
    await selectSession('session-b')
    expect(messages().map((message) => message.content)).toEqual([
      'session-b message 0',
      'session-b reply 0',
      'session-b message 1'
    ])
    expect(requestCount()).toBe(1)
  })
})
