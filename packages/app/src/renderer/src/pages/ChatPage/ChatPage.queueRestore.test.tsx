import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import type { ChatSession } from './chatStorage'
import ChatPage from './ChatPage'
import {
  buildChatWorkspaceControlsPortalId,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID
} from './chatPageShared'

// Owner decision 3, part 1: unaccepted user-authored queued items are kept with the draft and come
// back paused after a reload or restart; nothing is sent by itself. The session records live in an
// in-memory stand-in for IndexedDB that survives a remount; the draft backup is jsdom localStorage.

const fixture = vi.hoisted(() => ({
  config: null as Config | null,
  sessions: [] as ChatSession[],
  request: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  /** Runs before a session record is stored; a pending promise holds that write. */
  beforeStore: null as null | ((session: ChatSession) => Promise<void> | void),
  /** Called for every send with a video attachment: the preparation this suite gates. */
  prepare: null as
    | null
    | ((
        content: string,
        attachments: ChatAttachment[]
      ) => Promise<{ content: string; attachments: ChatAttachment[] }>)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
  })
}))
vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: fixture.config,
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
    notifyError: fixture.notifyError,
    notifyWarning: fixture.notifyWarning
  })
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcFs: {
      readTextFile: vi.fn(async () => ({ content: '' })),
      writeTextFile: vi.fn(async () => undefined)
    },
    svcLLMProxy: { signHy3DModel: vi.fn() },
    svcHyper: {
      saveImageToDir: vi.fn(async () => {
        throw new Error('No file writes in this fixture')
      })
    },
    svcManagedMedia: {
      importDataUrl: vi.fn(async () => {
        throw new Error('No media imports in this fixture')
      })
    }
  })
}))
vi.mock('@renderer/utils/fileUtils', () => ({
  fileToDataUrl: vi.fn(),
  fileToBlobUrl: vi.fn(() => 'blob:fixture-preview'),
  selectFile: vi.fn(),
  checkFileSize: () => true,
  isImageFile: () => true
}))
vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  const store = async (session: ChatSession): Promise<void> => {
    const copy = structuredClone(session)
    await fixture.beforeStore?.(copy)
    const index = fixture.sessions.findIndex((candidate) => candidate.id === session.id)
    if (index >= 0) fixture.sessions[index] = copy
    else fixture.sessions.push(copy)
  }
  // The real debounced save runs (through the save baseline); only the record store is replaced.
  return {
    ...actual,
    loadAllSessions: () => Promise.resolve(structuredClone(fixture.sessions)),
    loadSessionFromDB: async (id: string) =>
      structuredClone(fixture.sessions.find((session) => session.id === id) ?? null),
    saveSessionToDB: async (session: ChatSession) => store(session),
    deleteSessionFromDB: async (id: string) => {
      fixture.sessions = fixture.sessions.filter((session) => session.id !== id)
    },
    migrateFromLocalStorage: async () => null,
    saveChatSessions: (sessions: ChatSession[]) => {
      fixture.sessions = structuredClone(sessions)
    },
    loadChatSessionBackups: () => ({}),
    saveChatSessionBackups: () => undefined
  }
})
// Only the model request is replaced; everything before it (preflight, acceptance) is real.
vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return {
    ...actual,
    requestChatCompletion: (...args: unknown[]) => fixture.request(...args),
    supportsStreamingChatCompletion: () => false,
    resolveAttachmentBatchCapability: async () => 1
  }
})
vi.mock('./chatVideoAttachmentUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatVideoAttachmentUtils')>()
  return {
    ...actual,
    augmentAttachmentsWithVideoBoundaryFrames: (
      attachments: ChatAttachment[] | undefined,
      content: string
    ) =>
      attachments?.some((attachment) => attachment.type === 'video') && fixture.prepare
        ? fixture.prepare(content, attachments)
        : actual.augmentAttachmentsWithVideoBoundaryFrames(attachments, content)
  }
})
vi.mock('./components/SessionSidebar', () => ({
  default: ({
    visibleSessions,
    onSelectSession
  }: {
    visibleSessions: ChatSession[]
    onSelectSession: (id: string) => void
  }) => (
    <div>
      {visibleSessions.map((session) => (
        <button
          key={session.id}
          type="button"
          data-testid={`select-${session.id}`}
          onClick={() => onSelectSession(session.id)}
        >
          {session.title}
        </button>
      ))}
    </div>
  )
}))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: { currentSession?: ChatSession }) => (
    <pre data-testid="session-state">{JSON.stringify(currentSession ?? null)}</pre>
  )
}))
vi.mock('./components/ChatComposer', () => ({
  default: ({
    inputValue,
    onInputChange,
    onSend,
    isLoading,
    onStopGenerating,
    pendingAttachments
  }: {
    inputValue: string
    onInputChange: (value: string) => void
    onSend: () => void
    isLoading: boolean
    onStopGenerating: () => void
    pendingAttachments: ChatAttachment[]
  }) => (
    <div>
      <input
        data-testid="composer-input"
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <div data-testid="composer-attachments">
        {pendingAttachments.map((attachment) => attachment.fileName).join('|')}
      </div>
      <button type="button" data-testid="composer-send" onClick={onSend}>
        send
      </button>
      {isLoading ? (
        <button type="button" data-testid="composer-stop" onClick={onStopGenerating}>
          stop
        </button>
      ) : null}
    </div>
  )
}))

const scope = 'queue-restore'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: scope, threadId: 'pane' } as const
const theme = createTheme()
const backupKey = (id: string) => `magicpot-chat-draft:${scope}:${id}`
const video = (fileName = 'clip.mp4'): ChatAttachment => ({
  type: 'video',
  url: `https://fixture.invalid/${fileName}`,
  fileName,
  mimeType: 'video/mp4'
})
const session = (id: string, extra: Partial<ChatSession> = {}): ChatSession => ({
  id,
  title: id,
  messages: [],
  profileId: 'fixture-profile',
  ...extra
})

const currentSession = (): ChatSession =>
  JSON.parse(screen.getByTestId('session-state').textContent || 'null') as ChatSession
const queueItems = () => screen.queryAllByTestId('chat-queue-item')
const storedSession = (id: string) => fixture.sessions.find((candidate) => candidate.id === id)
const userTexts = (messages: ChatMessage[] | undefined) =>
  (messages ?? []).filter((message) => message.role === 'user').map((message) => message.content)
const typeAndSend = (text: string): void => {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('composer-send'))
}
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

/** A model reply that runs until the test settles or the request is aborted. */
const pendingReply = () => {
  const reply = Promise.withResolvers<{ content: string }>()
  const run = ({ signal }: { signal?: AbortSignal }) => {
    signal?.addEventListener(
      'abort',
      () => reply.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      { once: true }
    )
    return reply.promise
  }
  return { run, reply }
}

type PageOptions = { withRoute?: boolean; compact?: boolean }
const mountPage = async (currentId: string, options: PageOptions = {}) => {
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), currentId)
  const view = render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <div id={buildChatWorkspaceControlsPortalId(scope)} />
        <ChatPage
          storageScope={scope}
          {...(options.withRoute ? { route } : {})}
          {...(options.compact ? { compact: true } : {})}
        />
      </MemoryRouter>
    </ThemeProvider>
  )
  await waitFor(() => expect(currentSession()?.id).toBe(currentId))
  // Let the initial draft persistence settle before any send.
  await wait(260)
  return view
}
const renderPage = async (sessions: ChatSession[], currentId = sessions[0].id, options: PageOptions = {}) => {
  fixture.sessions = structuredClone(sessions)
  return mountPage(currentId, options)
}

/** One running reply, then two queued composer items behind it. */
const queueTwoBehindRunningReply = async () => {
  const first = pendingReply()
  fixture.request.mockImplementationOnce(first.run)
  typeAndSend('running reply')
  await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
  typeAndSend('queued one')
  typeAndSend('queued two')
  await waitFor(() => expect(queueItems()).toHaveLength(2))
  return first
}

const expectRestoredPaused = (texts: string[]) => {
  expect(queueItems().map((item) => item.textContent)).toEqual(
    texts.map((text) => expect.stringContaining(text))
  )
  for (const item of queueItems()) expect(item).toHaveTextContent('未发送 · 已暂停')
}

beforeEach(() => {
  vi.resetAllMocks()
  fixture.config = structuredClone(DEFAULT_CONFIG)
  fixture.config.use_remote_llm = false
  fixture.config.llm_config.api_profiles = [
    {
      id: 'fixture-profile',
      model_name: 'fixture-model',
      provider: 'openai',
      api_mode: 'chat-completions'
    } as LLMAPIProfile
  ]
  fixture.sessions = []
  fixture.prepare = null
  fixture.beforeStore = null
  fixture.request.mockResolvedValue({ content: 'fixture reply' })
  localStorage.clear()
  sessionStorage.clear()
  // Fail closed: nothing in this suite may reach the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network access')
    })
  )
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ChatPage queued sends kept with the draft', () => {
  it('restores two queued items paused after a remount, sends nothing and keeps the newer composer text', async () => {
    const view = await renderPage([session('restore-both')])
    await queueTwoBehindRunningReply()
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'newer text' } })
    // The draft persistence and the session record's own save both run.
    await waitFor(() => expect(storedSession('restore-both')?.draft?.queuedSends).toHaveLength(2))
    await waitFor(() => expect(storedSession('restore-both')?.draft?.inputValue).toBe('newer text'))

    view.unmount()
    fixture.request.mockClear()
    await mountPage('restore-both')
    await waitFor(() => expect(queueItems()).toHaveLength(2))
    expectRestoredPaused(['queued one', 'queued two'])
    expect(screen.getByTestId('composer-input')).toHaveValue('newer text')
    await wait(300)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(queueItems()).toHaveLength(2)
    // Nothing was accepted: the conversation still ends with the running reply's turn.
    expect(userTexts(currentSession().messages)).toEqual(['running reply'])
  })

  it('restores from the draft backup alone when the session write is slower than the remount', async () => {
    const view = await renderPage([session('backup-only')])
    const first = pendingReply()
    fixture.request.mockImplementationOnce(first.run)
    typeAndSend('running reply')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    await wait(700)
    // From here on no session record write lands before the remount.
    const held = Promise.withResolvers<void>()
    fixture.beforeStore = () => held.promise
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: { targetScope: scope, text: 'queued with video', attachment: video() }
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('composer-attachments')).toHaveTextContent('clip.mp4')
    )
    fireEvent.click(screen.getByTestId('composer-send'))
    typeAndSend('queued text')
    await waitFor(() => expect(queueItems()).toHaveLength(2))
    await wait(700)
    expect(storedSession('backup-only')?.draft?.queuedSends).toBeUndefined()
    const backup = JSON.parse(localStorage.getItem(backupKey('backup-only')) || '{}')
    expect(backup.queuedSends).toHaveLength(2)
    expect(JSON.stringify(backup).length).toBeLessThan(4096)

    view.unmount()
    fixture.request.mockClear()
    await mountPage('backup-only')
    await waitFor(() => expect(queueItems()).toHaveLength(2))
    expectRestoredPaused(['queued with video', 'queued text'])
    expect(queueItems()[0]).toHaveTextContent('1')
    await wait(300)
    expect(fixture.request).not.toHaveBeenCalled()

    // The restored item goes back into the composer with its attachment, and only from there.
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    expect(screen.getByTestId('composer-input')).toHaveValue('queued with video')
    expect(screen.getByTestId('composer-attachments')).toHaveTextContent('clip.mp4')
    expect(queueItems()).toHaveLength(1)
    await act(async () => held.resolve())
  })

  it('does not restore an accepted item when its queue removal write is still pending after the session save', async () => {
    const view = await renderPage([session('accepted')])
    const first = pendingReply()
    fixture.request.mockImplementationOnce(first.run)
    typeAndSend('running reply')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    typeAndSend('accepted item')
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    await waitFor(() => expect(storedSession('accepted')?.draft?.queuedSends).toHaveLength(1))

    // The race: the session save that carries the accepted turn completes, while the write that
    // removes the item from the stored queue has not landed. The stored record keeps the stale queue.
    const staleDraft = structuredClone(storedSession('accepted')!.draft!)
    fixture.beforeStore = (record) => {
      if (userTexts(record.messages).includes('accepted item')) record.draft = structuredClone(staleDraft)
    }
    const second = pendingReply()
    fixture.request.mockImplementationOnce(second.run)
    await act(async () => first.reply.resolve({ content: 'first reply' }))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(queueItems()).toHaveLength(0))
    await waitFor(() => expect(userTexts(storedSession('accepted')?.messages)).toContain('accepted item'))
    await wait(700)
    // The stored record still lists the accepted item; the backup does not.
    expect(storedSession('accepted')?.draft?.queuedSends?.map((item) => item.content)).toEqual(['accepted item'])
    expect(JSON.parse(localStorage.getItem(backupKey('accepted')) || '{}').queuedSends).toEqual([])

    view.unmount()
    fixture.request.mockClear()
    await mountPage('accepted')
    await wait(300)
    expect(queueItems()).toHaveLength(0)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(userTexts(currentSession().messages)).toEqual(['running reply', 'accepted item'])
  })

  it('leaves no queue behind for a deleted session', async () => {
    // The delete request is the compact column's event.
    const view = await renderPage([session('deleted'), session('kept')], 'deleted', { compact: true })
    await queueTwoBehindRunningReply()
    await waitFor(() => expect(storedSession('deleted')?.draft?.queuedSends).toHaveLength(2))
    expect(JSON.parse(localStorage.getItem(backupKey('deleted')) || '{}').queuedSends).toHaveLength(2)

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:deleteSession', { detail: { scope, sessionId: 'deleted' } })
      )
    })
    await waitFor(() => expect(currentSession().id).toBe('kept'))
    await wait(700)
    expect(localStorage.getItem(backupKey('deleted'))).toBeNull()
    expect(storedSession('deleted')).toBeUndefined()

    view.unmount()
    fixture.request.mockClear()
    await mountPage('kept', { compact: true })
    await wait(300)
    expect(queueItems()).toHaveLength(0)
    expect(localStorage.getItem(backupKey('deleted'))).toBeNull()
    expect(fixture.request).not.toHaveBeenCalled()
  })

  it('restores blob and over-cap inline attachments as unavailable and refuses to send them', async () => {
    const largeInline = `data:image/png;base64,${'A'.repeat(70 * 1024)}`
    await renderPage([
      session('unavailable', {
        draft: {
          inputValue: '',
          pendingAttachments: [],
          pendingHiddenContext: '',
          updatedAt: 0,
          queuedSendsUpdatedAt: 5,
          queuedSends: [
            {
              id: 'stored-item',
              content: 'stored with images',
              queuedAt: 1,
              attachments: [
                { type: 'image', url: 'blob:file:///gone', fileName: 'gone.png', mimeType: 'image/png' },
                { type: 'image', url: largeInline, fileName: 'large.png', mimeType: 'image/png' }
              ]
            }
          ]
        }
      })
    ])
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    expectRestoredPaused(['stored with images'])
    // Never silently dropped: both attachments are still counted.
    expect(queueItems()[0]).toHaveTextContent('2')
    // The stored copies are healed to the unavailable form: no blob URL, no large inline image.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(backupKey('unavailable')) || '{}').queuedSends).toHaveLength(1)
    )
    const backupText = localStorage.getItem(backupKey('unavailable')) || ''
    expect(backupText).not.toContain('blob:')
    expect(backupText).not.toContain('AAAA')
    expect(backupText).toContain('queuedAttachmentUnavailable')

    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    expect(screen.getByTestId('composer-input')).toHaveValue('stored with images')
    expect(screen.getByTestId('composer-attachments')).toHaveTextContent('gone.png|large.png')
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.notifyWarning).toHaveBeenCalledWith('Image unavailable'))
    await wait(200)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue('stored with images')
    expect(currentSession().messages).toEqual([])
  })

  it('keeps a restored item of an ended team paused and refuses it on send', async () => {
    const queuedDraft = {
      inputValue: '',
      pendingAttachments: [],
      pendingHiddenContext: '',
      updatedAt: 0,
      queuedSendsUpdatedAt: 5,
      queuedSends: [{ id: 'member-item', content: 'member queued text', queuedAt: 1 }]
    }
    await renderPage(
      [
        session('lead', {
          teamEnded: true,
          teamGeneration: 1,
          teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false }
        }),
        session('member', {
          teamLeadId: 'lead',
          teamMemberName: 'Bob',
          teamRole: 'writer',
          teamMemberGeneration: 0,
          draft: queuedDraft
        })
      ],
      'member',
      { withRoute: true }
    )
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    expectRestoredPaused(['member queued text'])
    await wait(300)
    expect(fixture.request).not.toHaveBeenCalled()

    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    expect(screen.getByTestId('composer-input')).toHaveValue('member queued text')
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.notifyWarning).toHaveBeenCalled())
    await wait(200)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(currentSession().messages).toEqual([])
  })

  it('keeps a restored item of an archived member paused and refuses it on send', async () => {
    await renderPage(
      [
        session('live-lead', {
          teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: true }
        }),
        session('archived-member', {
          teamLeadId: 'live-lead',
          teamMemberName: 'Ann',
          teamRole: 'designer',
          archived: true,
          draft: {
            inputValue: '',
            pendingAttachments: [],
            pendingHiddenContext: '',
            updatedAt: 0,
            queuedSendsUpdatedAt: 5,
            queuedSends: [{ id: 'archived-item', content: 'archived queued text', queuedAt: 1 }]
          }
        })
      ],
      'archived-member',
      { withRoute: true }
    )
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    expectRestoredPaused(['archived queued text'])
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    fireEvent.click(screen.getByTestId('composer-send'))
    // The refusal is the team-authority check for an archived member, not an unrelated warning.
    await waitFor(() => expect(fixture.notifyWarning).toHaveBeenCalledWith('Team lead unavailable.'))
    await wait(200)
    expect(fixture.request).not.toHaveBeenCalled()
  })

  // Accepts 'accepted item' while every write of this session's draft backup fails (storage full).
  const acceptWhileBackupWritesFail = async (id: string, failRemove: boolean) => {
    const view = await renderPage([session(id)])
    const first = pendingReply()
    fixture.request.mockImplementationOnce(first.run)
    typeAndSend('running reply')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    typeAndSend('accepted item')
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    await waitFor(() => expect(storedSession(id)?.draft?.queuedSends).toHaveLength(1))
    expect(JSON.parse(localStorage.getItem(backupKey(id)) || '{}').queuedSends).toHaveLength(1)
    const quotaError = () => new DOMException('full', 'QuotaExceededError')
    const setItem = Storage.prototype.setItem
    const removeItem = Storage.prototype.removeItem
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === backupKey(id)) throw quotaError()
      return setItem.call(this, key, value)
    })
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (failRemove && key === backupKey(id)) throw quotaError()
      return removeItem.call(this, key)
    })
    await act(async () => first.reply.resolve({ content: 'first reply' }))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(queueItems()).toHaveLength(0))
    await waitFor(() => expect(userTexts(storedSession(id)?.messages)).toContain('accepted item'))
    await wait(900)
    setSpy.mockRestore()
    removeSpy.mockRestore()
    return view
  }

  it('does not restore an accepted item when the backup write that removes it fails', async () => {
    const view = await acceptWhileBackupWritesFail('quota', false)
    // The stale queue left the backup even though the backup could not be rewritten.
    expect(JSON.parse(localStorage.getItem(backupKey('quota')) || '{}').queuedSends ?? []).toEqual([])

    view.unmount()
    fixture.request.mockClear()
    await mountPage('quota')
    await wait(400)
    expect(queueItems()).toHaveLength(0)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(userTexts(currentSession().messages)).toEqual(['running reply', 'accepted item'])
  })

  it('lets the session record outrank a stale backup queue that could not be changed at all', async () => {
    const view = await acceptWhileBackupWritesFail('stuck', true)
    // The backup still lists the accepted item; the session record holds the newer removal marker.
    const backup = JSON.parse(localStorage.getItem(backupKey('stuck')) || '{}')
    expect(backup.queuedSends?.map((item: { content: string }) => item.content)).toEqual(['accepted item'])
    const stored = storedSession('stuck')?.draft
    expect(stored?.queuedSends).toEqual([])
    expect(stored?.queuedSendsUpdatedAt).toBeGreaterThan(backup.queuedSendsUpdatedAt)

    view.unmount()
    fixture.request.mockClear()
    await mountPage('stuck')
    await wait(400)
    expect(queueItems()).toHaveLength(0)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(userTexts(currentSession().messages)).toEqual(['running reply', 'accepted item'])
  })

  it('stores the edited text in the draft backup at once when a restored item is moved into the composer', async () => {
    await renderPage([
      session('edit-flush', {
        draft: {
          inputValue: '',
          pendingAttachments: [],
          pendingHiddenContext: '',
          updatedAt: 0,
          queuedSendsUpdatedAt: 5,
          queuedSends: [{ id: 'edit-item', content: 'edited queued text', queuedAt: 1 }]
        }
      })
    ])
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    // Read synchronously, before any debounced persistence can run: the text is never in neither place.
    const backup = JSON.parse(localStorage.getItem(backupKey('edit-flush')) || '{}')
    expect(backup.draft?.inputValue).toBe('edited queued text')
    expect(backup.queuedSends).toEqual([])
    expect(fixture.request).not.toHaveBeenCalled()
  })

  it('stores no generated team context and no callbacks with the queue', async () => {
    const view = await renderPage([session('stored-shape')])
    const first = pendingReply()
    fixture.request.mockImplementationOnce(first.run)
    typeAndSend('running reply')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    // A canvas hand-off puts hidden context into the composer; a member-message turn is internal.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: { targetScope: scope, text: 'with canvas context', hiddenText: 'CANVAS HIDDEN' }
        })
      )
    })
    await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveValue('with canvas context'))
    fireEvent.click(screen.getByTestId('composer-send'))
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: { targetScope: scope, autoSend: true, text: 'internal auto-send', requestId: 'auto-1' }
        })
      )
    })
    await waitFor(() => expect(queueItems()).toHaveLength(2))
    await waitFor(() => expect(storedSession('stored-shape')?.draft?.queuedSends).toHaveLength(1))
    const stored = storedSession('stored-shape')!.draft!.queuedSends!
    const backup = JSON.parse(localStorage.getItem(backupKey('stored-shape')) || '{}')
    for (const record of [stored, backup.queuedSends]) {
      expect(record).toHaveLength(1)
      expect(Object.keys(record[0]).sort()).toEqual(
        ['content', 'id', 'originalComposerHiddenContext', 'queuedAt'].sort()
      )
      expect(record[0]).toMatchObject({ content: 'with canvas context', originalComposerHiddenContext: 'CANVAS HIDDEN' })
      const text = JSON.stringify(record)
      expect(text).not.toContain('internal auto-send')
      expect(text).not.toContain('targetSessionId')
      expect(text).not.toContain('queueKey')
      expect(text).not.toContain('baseMessages')
    }
    view.unmount()
  })
})

describe('ChatPage restored queue edited in the Agent column (S5c)', () => {
  const statuses = () => screen.queryAllByTestId('chat-queue-status').map((item) => item.textContent)
  const requestedTexts = () =>
    fixture.request.mock.calls.map((call) =>
      (call[0] as { messages: ChatMessage[] }).messages.filter((message) => message.role === 'user').at(-1)?.content
    )
  const saveRowEdit = (row: HTMLElement, text: string) => {
    fireEvent.click(within(row).getByRole('button', { name: 'chat.queue_edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'chat.queue_edit_field' }), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
  }

  it('saving an edit of the second restored item sends nothing; each item goes only on its own save, in order', async () => {
    const view = await renderPage([session('restored-order')], 'restored-order', { compact: true })
    await queueTwoBehindRunningReply()
    await waitFor(() => expect(storedSession('restored-order')?.draft?.queuedSends).toHaveLength(2))
    view.unmount()
    fixture.request.mockClear()
    await mountPage('restored-order', { compact: true })
    await waitFor(() => expect(queueItems()).toHaveLength(2))
    expect(statuses()).toEqual(['chat.queue_status_held', 'chat.queue_status_held'])
    const storedIds = storedSession('restored-order')!.draft!.queuedSends!.map((item) => item.id)
    // 'queued one' is still held before it: the save changes only the text.
    saveRowEdit(queueItems()[1], 'queued two edited')
    await wait(300)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(statuses()).toEqual(['chat.queue_status_held', 'chat.queue_status_held'])
    expect(screen.getAllByTestId('chat-queue-text').map((item) => item.textContent)).toEqual(['queued one', 'queued two edited'])
    expect(userTexts(currentSession().messages)).toEqual(['running reply'])
    // The stored queue keeps both items under their own ids, with the edited text.
    await waitFor(() =>
      expect(storedSession('restored-order')?.draft?.queuedSends?.map((item) => [item.id, item.content])).toEqual([
        [storedIds[0], 'queued one'],
        [storedIds[1], 'queued two edited']
      ])
    )
    // The first one goes on its own save; the second, restored and held, waits for its own.
    saveRowEdit(queueItems()[0], 'queued one')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(1))
    await wait(300)
    expect(fixture.request).toHaveBeenCalledTimes(1)
    expect(statuses()).toEqual(['chat.queue_status_held'])
    saveRowEdit(queueItems()[0], 'queued two edited')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
    expect(requestedTexts()).toEqual(['queued one', 'queued two edited'])
    await waitFor(() => expect(queueItems()).toHaveLength(0))
  })

  it('drops an attachment that did not survive the reload only when the person saves again', async () => {
    await renderPage(
      [
        session('drop-unavailable', {
          draft: {
            inputValue: '',
            pendingAttachments: [],
            pendingHiddenContext: '',
            updatedAt: 0,
            queuedSendsUpdatedAt: 5,
            queuedSends: [
              {
                id: 'stored-image-item',
                content: 'look at this',
                queuedAt: 1,
                attachments: [{ type: 'image', url: 'blob:file:///gone', fileName: 'gone.png', mimeType: 'image/png' }]
              }
            ]
          }
        })
      ],
      'drop-unavailable',
      { compact: true }
    )
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    expect(screen.getByTestId('chat-queue-edit-error')).toHaveTextContent('chat.queue_edit_drop_unavailable')
    await wait(200)
    expect(fixture.request).not.toHaveBeenCalled()
    // Changing the text asks again.
    fireEvent.change(screen.getByRole('textbox', { name: 'chat.queue_edit_field' }), { target: { value: 'look at this, no image' } })
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    expect(screen.getByTestId('chat-queue-edit-error')).toHaveTextContent('chat.queue_edit_drop_unavailable')
    await wait(200)
    expect(fixture.request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(1))
    const sent = (fixture.request.mock.calls[0][0] as { messages: ChatMessage[] }).messages.filter((message) => message.role === 'user').at(-1)
    expect(sent?.content).toBe('look at this, no image')
    expect(sent?.attachments ?? []).toEqual([])
    await waitFor(() => expect(queueItems()).toHaveLength(0))
  })

  it('refuses to save a message of unavailable attachments only', async () => {
    await renderPage(
      [
        session('only-unavailable', {
          draft: {
            inputValue: '',
            pendingAttachments: [],
            pendingHiddenContext: '',
            updatedAt: 0,
            queuedSendsUpdatedAt: 5,
            queuedSends: [
              {
                id: 'stored-image-only',
                content: '',
                queuedAt: 1,
                attachments: [{ type: 'image', url: 'blob:file:///gone', fileName: 'gone.png', mimeType: 'image/png' }]
              }
            ]
          }
        })
      ],
      'only-unavailable',
      { compact: true }
    )
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    expect(screen.getByTestId('chat-queue-edit-error')).toHaveTextContent('Image unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    await wait(200)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(queueItems()).toHaveLength(1)
  })
})

describe('ChatPage queued edit refusals in the Agent column (S5c)', () => {
  const draftWith = (content: string, attachments?: ChatAttachment[]) => ({
    inputValue: '',
    pendingAttachments: [],
    pendingHiddenContext: '',
    updatedAt: 0,
    queuedSendsUpdatedAt: 5,
    queuedSends: [{ id: `stored-${content.length}`, content, queuedAt: 1, ...(attachments ? { attachments } : {}) }]
  })
  /** Opens the restored item's editor, saves `text`, and returns the refusal line (the item is never sent). */
  const saveRefused = async (text?: string) => {
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    if (text !== undefined) {
      fireEvent.change(screen.getByRole('textbox', { name: 'chat.queue_edit_field' }), { target: { value: text } })
    }
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    const error = screen.getByTestId('chat-queue-edit-error').textContent
    await wait(200)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(queueItems()).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'chat.queue_edit_field' })).toBeInTheDocument()
    return error
  }
  const team = (lead: Partial<ChatSession>, member: Partial<ChatSession>) => [
    session('lead', { teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false }, ...lead }),
    session('member', { teamLeadId: 'lead', teamMemberName: 'Bob', teamRole: 'writer', teamMemberGeneration: 0, ...member })
  ]

  it('refuses an archived conversation', async () => {
    await renderPage([session('archived', { archived: true, draft: draftWith('archived text') })], 'archived', { compact: true })
    expect(await saveRefused()).toBe('chat.queue_edit_unavailable')
  })

  it('refuses a conversation deleted in another window (tombstone)', async () => {
    await renderPage([session('tombstoned', { draft: draftWith('tombstoned text') })], 'tombstoned', { compact: true })
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    localStorage.setItem(`magicpot-chat-delete-tombstone:${encodeURIComponent(scope)}:tombstoned`, JSON.stringify({ sessionId: 'tombstoned' }))
    expect(await saveRefused()).toBe('chat.queue_edit_unavailable')
  })

  it('refuses a member whose lead is archived', async () => {
    await renderPage(team({ archived: true }, { draft: draftWith('member text') }), 'member', { compact: true, withRoute: true })
    expect(await saveRefused()).toBe('chat.queue_edit_unavailable')
  })

  it('refuses a member of an ended team', async () => {
    await renderPage(team({ teamEnded: true, teamGeneration: 1 }, { draft: draftWith('member text') }), 'member', { compact: true, withRoute: true })
    expect(await saveRefused()).toBe('chat.queue_edit_unavailable')
  })

  it('refuses a member while a remote model serves the team', async () => {
    fixture.config!.use_remote_llm = true
    await renderPage(team({}, { draft: draftWith('member text') }), 'member', { compact: true, withRoute: true })
    expect(await saveRefused()).toBe('chat.queue_edit_unavailable')
  })

  it('refuses an "@member" request on a lead with members, and a command', async () => {
    await renderPage(team({ draft: draftWith('lead text') }, {}), 'lead', { compact: true, withRoute: true })
    expect(await saveRefused('@Bob please draw')).toBe('chat.queue_edit_plain_only')
    fireEvent.change(screen.getByRole('textbox', { name: 'chat.queue_edit_field' }), { target: { value: '/status' } })
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    expect(screen.getByTestId('chat-queue-edit-error')).toHaveTextContent('chat.queue_edit_plain_only')
  })

  it('lets "@" text through on a conversation without members', async () => {
    await renderPage([session('solo', { draft: draftWith('solo text') })], 'solo', { compact: true })
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'chat.queue_edit_field' }), { target: { value: '@home is fine' } })
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(1))
  })

  it('refuses more images than one message may carry', async () => {
    const images = Array.from({ length: 51 }, (_, index): ChatAttachment => ({
      type: 'image',
      url: `https://fixture.invalid/${index}.png`,
      fileName: `${index}.png`,
      mimeType: 'image/png'
    }))
    await renderPage([session('many-images', { draft: draftWith('many images', images) })], 'many-images', { compact: true })
    expect(await saveRefused()).toBe('本次图片数量超过限制，请分批发送')
  })
})

describe('ChatPage queued item identity across an in-place save (S5c)', () => {
  it('keeps the stored id of an edited item, and a reload brings back no duplicate', async () => {
    const view = await renderPage([session('identity')], 'identity', { compact: true })
    await queueTwoBehindRunningReply()
    await waitFor(() => expect(storedSession('identity')?.draft?.queuedSends).toHaveLength(2))
    const ids = storedSession('identity')!.draft!.queuedSends!.map((item) => item.id)
    fireEvent.click(within(queueItems()[1]).getByRole('button', { name: 'chat.queue_edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'chat.queue_edit_field' }), { target: { value: 'queued two edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_save' }))
    await waitFor(() =>
      expect(storedSession('identity')?.draft?.queuedSends?.map((item) => [item.id, item.content])).toEqual([
        [ids[0], 'queued one'],
        [ids[1], 'queued two edited']
      ])
    )
    const backup = JSON.parse(localStorage.getItem(backupKey('identity')) || '{}')
    expect(backup.queuedSends.map((item: { id: string; content: string }) => [item.id, item.content])).toEqual([
      [ids[0], 'queued one'],
      [ids[1], 'queued two edited']
    ])
    view.unmount()
    fixture.request.mockClear()
    await mountPage('identity', { compact: true })
    await waitFor(() => expect(queueItems()).toHaveLength(2))
    await wait(300)
    expect(screen.getAllByTestId('chat-queue-text').map((item) => item.textContent)).toEqual(['queued one', 'queued two edited'])
    expect(fixture.request).not.toHaveBeenCalled()
  })
})

describe('ChatPage full-page Edit of a Stop-paused head (S5c)', () => {
  it('moving the paused head back into the composer does not let the released item behind it overtake it', async () => {
    await renderPage([session('moved-head')])
    const first = pendingReply()
    fixture.request.mockImplementationOnce(first.run)
    typeAndSend('running reply')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    typeAndSend('A head')
    typeAndSend('B behind')
    await waitFor(() => expect(queueItems()).toHaveLength(2))
    fireEvent.click(screen.getByTestId('composer-stop'))
    await wait(300)
    // The person's newer send is accepted and releases B, which now waits behind the paused A.
    typeAndSend('N newer')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
    await wait(400)
    expect(queueItems()).toHaveLength(2)
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    expect(screen.getByTestId('composer-input')).toHaveValue('A head')
    await wait(400)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(4))
    const sent = fixture.request.mock.calls.map((call) =>
      (call[0] as { messages: ChatMessage[] }).messages.filter((message) => message.role === 'user').at(-1)?.content)
    expect(sent).toEqual(['running reply', 'N newer', 'A head', 'B behind'])
  })
})
