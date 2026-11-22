import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { useEffect } from 'react'
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
  composer: null as null | {
    onInputChange: (value: string) => void
    onSend: () => void
    onRemoveAttachment: (index: number) => void
    pendingAttachments: ChatAttachment[]
  },
  selectSession: null as null | ((id: string) => void),
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
  loadAllSessions: async (storageScope?: string) =>
    clone(f.sessions.filter((session) => session.storageScope === storageScope)),
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
  default: function Sidebar({
    sessions,
    onSelectSession
  }: {
    sessions: ChatSession[]
    onSelectSession: (id: string) => void
  }) {
    f.selectSession = onSelectSession
    return (
      <div>
        {sessions.map((session) => (
          <button key={session.id} onClick={() => onSelectSession(session.id)}>
            Open {session.id}
          </button>
        ))}
      </div>
    )
  }
}))
vi.mock('./components/ChatComposer', () => ({
  default: function Composer(props: {
    inputValue: string
    onInputChange: (value: string) => void
    onSend: () => void
    onRemoveAttachment: (index: number) => void
    pendingAttachments: ChatAttachment[]
  }) {
    f.composer = props
    return <input data-testid="composer-input" value={props.inputValue} readOnly />
  }
}))
// Like the real list, the edit form exists only while an index is being edited (one mount
// per thread and message) and, like UserMessageEditForm, creates its receiver inside an
// effect keyed on the register prop whose cleanup unregisters with the old prop.
function EditForm({
  sessionId,
  index,
  register
}: {
  sessionId: string | undefined
  index: number
  register: (receiver: Receiver | null) => void
}) {
  useEffect(() => {
    const receiver: Receiver = (attachment) => f.receive({ sessionId, index, attachment })
    register(receiver)
    return () => register(null)
  }, [register, sessionId, index])
  return null
}
vi.mock('./components/ChatMessageList', () => ({
  default: function MessageList(props: ListProps) {
    f.props = props
    const { currentSession, editingMessageIndex, editingContent } = props
    const sessionId = currentSession?.id
    return (
      <div>
        {editingMessageIndex !== null ? (
          <EditForm
            key={`${sessionId}:${editingMessageIndex}`}
            sessionId={sessionId}
            index={editingMessageIndex}
            register={props.onRegisterEditingAttachmentReceiver}
          />
        ) : null}
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

const renderPage = async (sessions = [makeSession('session-a'), makeSession('session-b')]) => {
  f.sessions = sessions
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

const storedContents = (id: string) =>
  f.sessions.find((session) => session.id === id)?.messages.map((message) => message.content)
const queuedItems = () =>
  screen.queryAllByTestId('chat-queue-item').map((item) => item.textContent ?? '')

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
  f.composer = null
  f.selectSession = null
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

  it('routes an image to the edit form of B after A\'s form unmounted, despite a stale register or unregister from A', async () => {
    await renderPage()
    await startEdit(0)
    const registerFromA = f.props!.onRegisterEditingAttachmentReceiver
    await selectSession('session-b')
    await startEdit(2)
    const deadReceiver = vi.fn()
    act(() => registerFromA(null))
    act(() => registerFromA(deadReceiver))
    const attachment: ChatAttachment = { type: 'image', url: 'local-media:///fixture/for-b.png', fileName: 'for-b.png' }
    await act(async () => {
      window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { targetScope: scope, attachment } }))
    })
    await waitFor(() => expect(f.receive).toHaveBeenCalledOnce())
    expect(f.receive).toHaveBeenCalledWith({ sessionId: 'session-b', index: 2, attachment })
    expect(deadReceiver).not.toHaveBeenCalled()
    expect(f.error).not.toHaveBeenCalled()
  })

  it('sends nothing when the thread changes while the edit submit waits for video-frame extraction', async () => {
    await renderPage()
    const extraction = deferred<{ attachments: ChatAttachment[] | undefined; content: string }>()
    f.augment.mockImplementation(() => extraction.promise)
    await startEdit(2)
    fireEvent.click(screen.getByRole('button', { name: 'Submit edit' }))
    await waitFor(() => expect(f.augment).toHaveBeenCalled())
    await selectSession('session-b')
    await act(async () => {
      extraction.resolve({ attachments: undefined, content: 'Edit draft 2' })
      await extraction.promise
    })
    await act(async () => {})
    expect(requestCount()).toBe(0)
    expect(staleWarnings()).toBe(1)
    expect(f.augment).toHaveBeenCalledOnce()
    expect(messages().map((message) => message.content)).toEqual([
      'session-b message 0',
      'session-b reply 0',
      'session-b message 1'
    ])
    await selectSession('session-a')
    expect(messages().map((message) => message.content)).toEqual([
      'session-a message 0',
      'session-a reply 0',
      'session-a message 1'
    ])
    expect(f.sessions.map((session) => session.messages.length)).toEqual([3, 3])
    expect(requestCount()).toBe(0)
  })

  it('delivers nothing to B when an edit-form image import from A completes after the switch', async () => {
    await renderPage()
    await startEdit(0)
    const pending = deferred<ChatAttachment>()
    const attachment: ChatAttachment = { type: 'image', url: 'local-media:///fixture/late.png', fileName: 'late.png' }
    f.materialize.mockReturnValueOnce(pending.promise)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { targetScope: scope, attachment } }))
      await Promise.resolve()
    })
    expect(f.materialize).toHaveBeenCalledWith(attachment)
    await selectSession('session-b')
    await startEdit(2)
    await act(async () => {
      pending.resolve(attachment)
      await pending.promise
    })
    await act(async () => {})
    expect(f.receive).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue('session-b composer draft')
    expect(screen.getByTestId('edit-content')).toHaveTextContent('Edit draft 2')
    expect(requestCount()).toBe(0)
  })

  describe('an edit queued while its thread is busy', () => {
    // A's first edited turn hangs, so the second edit submitted in A is queued under A.
    const queueEditInBusyA = async () => {
      const reply = deferred<{ content: string }>()
      const streamReply = deferred<{ response: string; result: { content: string } }>()
      f.request.mockImplementationOnce(() => reply.promise)
      f.stream.mockImplementationOnce(() => streamReply.promise)
      await startEdit(0)
      fireEvent.click(screen.getByRole('button', { name: 'Submit edit' }))
      await waitFor(() => expect(requestCount()).toBe(1))
      await startEdit(2)
      fireEvent.click(screen.getByRole('button', { name: 'Submit edit' }))
      await waitFor(() => expect(queuedItems()).toEqual([expect.stringContaining('Edit draft 2')]))
      expect(editIndex()).toBe('null')
      return async () => {
        await act(async () => {
          reply.resolve({ content: 'first reply' })
          streamReply.resolve({ response: 'first reply', result: { content: 'first reply' } })
          await Promise.resolve()
        })
      }
    }

    it('is delivered into its thread after A to B to A, without a warning', async () => {
      await renderPage()
      const finishFirstTurn = await queueEditInBusyA()
      await selectSession('session-b')
      expect(queuedItems()).toEqual([])
      await selectSession('session-a')
      expect(queuedItems()).toEqual([expect.stringContaining('Edit draft 2')])
      await finishFirstTurn()
      await waitFor(() => expect(requestCount()).toBe(2))
      await waitFor(() =>
        expect(messages().map((message) => message.content)).toContain('Edit draft 2')
      )
      await waitFor(() => expect(queuedItems()).toEqual([]))
      expect(messages().at(-1)?.content).toBe('fixture reply')
      expect(staleWarnings()).toBe(0)
      expect(storedContents('session-b')).toEqual([
        'session-b message 0',
        'session-b reply 0',
        'session-b message 1'
      ])
    })

    it('is sent into its own thread, never into B, when the queue drains while B is selected', async () => {
      await renderPage()
      const finishFirstTurn = await queueEditInBusyA()
      await selectSession('session-b')
      await finishFirstTurn()
      await waitFor(() => expect(requestCount()).toBe(2))
      await waitFor(() => expect(storedContents('session-a')).toContain('Edit draft 2'))
      await act(async () => {})
      expect(storedContents('session-a')?.at(-1)).toBe('fixture reply')
      expect(staleWarnings()).toBe(0)
      expect(sessionId()).toBe('session-b')
      expect(screen.getByTestId('composer-input')).toHaveValue('session-b composer draft')
      const bContents = ['session-b message 0', 'session-b reply 0', 'session-b message 1']
      expect(messages().map((message) => message.content)).toEqual(bContents)
      expect(storedContents('session-b')).toEqual(bContents)
      await selectSession('session-a')
      expect(messages().map((message) => message.content)).toContain('Edit draft 2')
      expect(queuedItems()).toEqual([])
    })

    it("stays in its thread's queue, paused and unsent, across a storage scope round trip", async () => {
      const view = await renderPage()
      await queueEditInBusyA()
      const otherScope = 'edit-thread-ownership-other'
      f.sessions.push({ ...makeSession('session-c'), storageScope: otherScope })
      localStorage.setItem(
        scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, otherScope),
        'session-c'
      )
      const renderScope = (storageScope: string) =>
        view.rerender(
          <ThemeProvider theme={theme}>
            <MemoryRouter>
              <ChatPage storageScope={storageScope} />
            </MemoryRouter>
          </ThemeProvider>
        )
      renderScope(otherScope)
      await waitFor(() => expect(sessionId()).toBe('session-c'))
      expect(queuedItems()).toEqual([])
      renderScope(scope)
      await waitFor(() => expect(sessionId()).toBe('session-a'))
      await waitFor(() => expect(queuedItems()).toEqual([expect.stringContaining('Edit draft 2')]))
      await act(async () => {})
      expect(requestCount()).toBe(1)
      expect(staleWarnings()).toBe(0)
      expect(storedContents('session-b')).toEqual([
        'session-b message 0',
        'session-b reply 0',
        'session-b message 1'
      ])
      expect(storedContents('session-c')).toEqual([
        'session-c message 0',
        'session-c reply 0',
        'session-c message 1'
      ])
    })
  })

  describe('composer draft ownership across a thread switch', () => {
    const storedDraft = (id: string) =>
      f.sessions.find((session) => session.id === id)?.draft?.inputValue
    const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

    it("never shows or stores A's draft as B's when A's render effects are still pending at the switch", async () => {
      const older = makeSession('session-b')
      older.draft = { ...older.draft!, updatedAt: Date.now() - 60_000 }
      await renderPage([makeSession('session-a'), older])
      // This pins a React scheduling window as jsdom runs it (passive effects of a render
      // committed outside act run in a later task). If a React upgrade closes that window,
      // the test passes without exercising the guard: re-check it against the old code.
      // Typing in A commits A's draft through its debounced timers, outside any act scope,
      // so the render that carries A's new draft leaves its passive effects pending for a
      // later task. The switch to B is clicked in exactly that window.
      f.composer!.onInputChange('session-a typed draft')
      const deadline = Date.now() + 5000
      while (f.props?.currentSession?.draft?.inputValue !== 'session-a typed draft') {
        if (Date.now() > deadline)
          throw new Error("A's typed draft never reached the session state")
        await nextMacrotask()
      }
      fireEvent.click(screen.getByRole('button', { name: 'Open session-b' }))
      await waitFor(() => expect(sessionId()).toBe('session-b'))
      await waitFor(() =>
        expect(screen.getByTestId('composer-input')).toHaveValue('session-b composer draft')
      )
      // Past the draft persistence delay: B keeps its own draft, A keeps the typed one.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
      })
      expect(screen.getByTestId('composer-input')).toHaveValue('session-b composer draft')
      expect(storedDraft('session-b')).toBe('session-b composer draft')
      expect(storedDraft('session-a')).toBe('session-a typed draft')
      fireEvent.click(screen.getByRole('button', { name: 'Open session-a' }))
      await waitFor(() =>
        expect(screen.getByTestId('composer-input')).toHaveValue('session-a typed draft')
      )
      expect(storedDraft('session-b')).toBe('session-b composer draft')
      expect(requestCount()).toBe(0)
    })

    it("does not save A's composer text as B's draft when a flush runs before B's draft is loaded", async () => {
      await renderPage()
      // A switch made outside a discrete user event (as from async code) commits in a later
      // task; a window blur in between flushes the composer, which still holds A's draft.
      f.selectSession!('session-b')
      window.dispatchEvent(new Event('blur'))
      await waitFor(() => expect(sessionId()).toBe('session-b'))
      await waitFor(() =>
        expect(screen.getByTestId('composer-input')).toHaveValue('session-b composer draft')
      )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
      })
      expect(screen.getByTestId('composer-input')).toHaveValue('session-b composer draft')
      expect(storedDraft('session-b')).toBe('session-b composer draft')
      await selectSession('session-a')
      expect(storedDraft('session-a')).toBe('session-a composer draft')
      await selectSession('session-b')
      expect(storedDraft('session-b')).toBe('session-b composer draft')
    })

    it("does not stamp B's composer with an attachment change made in A whose update runs after the switch", async () => {
      const image = (name: string): ChatAttachment => ({
        type: 'image',
        url: `data:image/png;base64,${btoa(name)}`,
        mimeType: 'image/png',
        fileName: name
      })
      const a = makeSession('session-a')
      a.draft = { ...a.draft!, pendingAttachments: [image('a-1.png'), image('a-2.png')] }
      const b = makeSession('session-b')
      b.draft = { ...b.draft!, updatedAt: Date.now() - 60_000 }
      await renderPage([a, b])
      await waitFor(() => expect(f.composer!.pendingAttachments).toHaveLength(2))
      // React computes the second removal's state update only in the next render, which
      // runs after the switch has already moved the selection to B.
      act(() => {
        f.composer!.onRemoveAttachment(0)
        f.composer!.onRemoveAttachment(0)
        f.selectSession!('session-b')
      })
      await waitFor(() => expect(sessionId()).toBe('session-b'))
      await waitFor(() =>
        expect(screen.getByTestId('composer-input')).toHaveValue('session-b composer draft')
      )
      expect(f.composer!.pendingAttachments).toEqual([])
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
      })
      expect(screen.getByTestId('composer-input')).toHaveValue('session-b composer draft')
      expect(f.composer!.pendingAttachments).toEqual([])
      expect(storedDraft('session-b')).toBe('session-b composer draft')
      expect(
        f.sessions.find((session) => session.id === 'session-b')?.draft?.pendingAttachments
      ).toEqual([])
    })
  })

  // An ordinary composer send reads its text, images and hidden context from the visible
  // composer, then prepares them across several awaits (here: video-frame extraction).
  // When the turn is accepted, the composer is cleared only if it still holds that
  // submission: a send for A never clears B's composer or B's stored draft, and a draft
  // the user changed in A after pressing Send is kept.
  describe('a composer send prepared in A while the selection moves', () => {
    const storedDraft = (id: string) => f.sessions.find((session) => session.id === id)?.draft
    const composerValue = () => (screen.getByTestId('composer-input') as HTMLInputElement).value
    const sentInA = [
      'session-a message 0',
      'session-a reply 0',
      'session-a message 1',
      'session-a composer draft',
      'fixture reply'
    ]
    const untouchedB = ['session-b message 0', 'session-b reply 0', 'session-b message 1']
    const holdPreparation = () => {
      const gate = deferred<void>()
      f.augment.mockImplementation(async (attachments: unknown, content: string) => {
        await gate.promise
        return { attachments, content }
      })
      return gate
    }
    const sendFromComposer = async () => {
      act(() => f.composer!.onSend())
      await waitFor(() => expect(f.augment).toHaveBeenCalledOnce())
    }
    const release = async (gate: { resolve: (value: void) => void }) => {
      await act(async () => gate.resolve())
      await waitFor(() => expect(storedContents('session-a')).toEqual(sentInA))
      // Past the draft persistence delay, so an empty composer would have been saved.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
      })
    }
    const openA = async (composer: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Open session-a' }))
      await waitFor(() => expect(sessionId()).toBe('session-a'))
      await waitFor(() => expect(composerValue()).toBe(composer))
    }

    it("sends A's text into A and leaves B's composer and stored draft as they were", async () => {
      await renderPage()
      const gate = holdPreparation()
      await sendFromComposer()
      await selectSession('session-b')
      await release(gate)
      expect(requestCount()).toBe(1)
      expect(sessionId()).toBe('session-b')
      expect(composerValue()).toBe('session-b composer draft')
      expect(storedDraft('session-b')?.inputValue).toBe('session-b composer draft')
      expect(storedContents('session-b')).toEqual(untouchedB)
      // A's draft was exactly the sent text: it is consumed, not shown again for a resend.
      expect(storedDraft('session-a')).toBeUndefined()
      await openA('')
      await selectSession('session-b')
      expect(storedDraft('session-b')?.inputValue).toBe('session-b composer draft')
      expect(requestCount()).toBe(1)
    })

    it("keeps the images and hidden context of B's composer and stored draft", async () => {
      const image: ChatAttachment = {
        type: 'image',
        url: 'data:image/png;base64,iVBORw0KGgo=',
        mimeType: 'image/png',
        fileName: 'session-b.png'
      }
      const b = makeSession('session-b')
      b.draft = {
        ...b.draft!,
        pendingAttachments: [image],
        pendingHiddenContext: 'session-b hidden'
      }
      await renderPage([makeSession('session-a'), b])
      const gate = holdPreparation()
      await sendFromComposer()
      await selectSession('session-b')
      await waitFor(() => expect(f.composer!.pendingAttachments).toHaveLength(1))
      await release(gate)
      expect(composerValue()).toBe('session-b composer draft')
      expect(f.composer!.pendingAttachments.map((attachment) => attachment.fileName)).toEqual([
        'session-b.png'
      ])
      expect(storedDraft('session-b')).toMatchObject({
        inputValue: 'session-b composer draft',
        pendingAttachments: [{ fileName: 'session-b.png', url: image.url }],
        pendingHiddenContext: 'session-b hidden'
      })
      expect(storedContents('session-b')).toEqual(untouchedB)
    })

    it("keeps the newer text the user typed in A after pressing Send, as A's draft", async () => {
      await renderPage()
      const gate = holdPreparation()
      await sendFromComposer()
      act(() => f.composer!.onInputChange('session-a newer text'))
      await selectSession('session-b')
      await release(gate)
      expect(composerValue()).toBe('session-b composer draft')
      expect(storedDraft('session-b')?.inputValue).toBe('session-b composer draft')
      expect(storedDraft('session-a')?.inputValue).toBe('session-a newer text')
      await openA('session-a newer text')
      expect(requestCount()).toBe(1)
    })

    it("clears A's composer after A to B to A, where it shows the text being sent again", async () => {
      await renderPage()
      const gate = holdPreparation()
      await sendFromComposer()
      await selectSession('session-b')
      await selectSession('session-a')
      await release(gate)
      expect(sessionId()).toBe('session-a')
      expect(composerValue()).toBe('')
      expect(storedDraft('session-a')).toBeUndefined()
      await selectSession('session-b')
      expect(storedDraft('session-b')?.inputValue).toBe('session-b composer draft')
      expect(storedContents('session-b')).toEqual(untouchedB)
      expect(requestCount()).toBe(1)
    })
  })
})
