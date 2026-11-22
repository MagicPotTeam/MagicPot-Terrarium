import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zhLocaleText } from '../../testUtils/localeTranslator'
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

// Owner decision 3, the Stop and composer-queue contract: Stop never sends the next queued item
// by itself and never loses an unaccepted user item. A manual Stop pauses the head and holds
// the items behind it until the user's own send to that session is accepted.

const fixture = vi.hoisted(() => ({
  config: null as Config | null,
  sessions: [] as ChatSession[],
  request: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
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
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue || zhLocaleText(key)
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
  const store = (session: ChatSession): void => {
    const copy = structuredClone(session)
    const index = fixture.sessions.findIndex((candidate) => candidate.id === session.id)
    if (index >= 0) fixture.sessions[index] = copy
    else fixture.sessions.push(copy)
  }
  return {
    ...actual,
    loadAllSessions: () => Promise.resolve(structuredClone(fixture.sessions)),
    saveSessionToDB: async (session: ChatSession) => store(session),
    debouncedSaveSessions: () => undefined,
    cancelDebouncedSessionSave: () => undefined,
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

const scope = 'stop-queue-contract'
const theme = createTheme()
const video = (fileName = 'clip.mp4'): ChatAttachment => ({
  type: 'video',
  url: `https://fixture.invalid/${fileName}`,
  fileName,
  mimeType: 'video/mp4'
})
const session = (id: string, title = id): ChatSession => ({
  id,
  title,
  messages: [],
  profileId: 'fixture-profile'
})

const currentSession = (): ChatSession =>
  JSON.parse(screen.getByTestId('session-state').textContent || 'null') as ChatSession
const queueItems = () => screen.queryAllByTestId('chat-queue-item')
const userTexts = (messages: ChatMessage[]) =>
  messages.filter((message) => message.role === 'user').map((message) => message.content)
const lastUserText = (call: number): string | undefined => {
  const request = fixture.request.mock.calls[call]?.[0] as { messages: ChatMessage[] } | undefined
  return request?.messages.findLast((message) => message.role === 'user')?.content
}
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
  let signal: AbortSignal | undefined
  const run = ({ signal: requestSignal }: { signal?: AbortSignal }) => {
    signal = requestSignal
    requestSignal?.addEventListener(
      'abort',
      () => reply.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      { once: true }
    )
    return reply.promise
  }
  return { run, reply, aborted: () => Boolean(signal?.aborted) }
}

const renderPage = async (sessions: ChatSession[], currentId = sessions[0].id): Promise<void> => {
  fixture.sessions = structuredClone(sessions)
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), currentId)
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <div id={buildChatWorkspaceControlsPortalId(scope)} />
        <ChatPage storageScope={scope} />
      </MemoryRouter>
    </ThemeProvider>
  )
  await waitFor(() => expect(currentSession()?.id).toBe(currentId))
  // Let the initial draft persistence settle before any send.
  await wait(260)
}

/** One running reply, then two queued composer items behind it. */
const queueTwoBehindRunningReply = async () => {
  const first = pendingReply()
  fixture.request.mockImplementationOnce(first.run)
  typeAndSend('running reply')
  await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
  typeAndSend('queued head')
  typeAndSend('queued follower')
  await waitFor(() => expect(queueItems()).toHaveLength(2))
  return first
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

describe('ChatPage Stop and the composer queue', () => {
  it('pauses the head and holds the follower on Stop, then sends an edited head before its follower', async () => {
    await renderPage([session('stop-hold')])
    const first = await queueTwoBehindRunningReply()

    fireEvent.click(screen.getByTestId('composer-stop'))
    expect(first.aborted()).toBe(true)
    await waitFor(() => expect(queueItems()[0]).toHaveTextContent('未发送 · 已暂停'))
    expect(queueItems()[0]).toHaveTextContent('queued head')
    expect(queueItems()[1]).toHaveTextContent('queued follower')
    expect(queueItems()[1]).not.toHaveTextContent('未发送 · 已暂停')
    await wait(200)
    expect(fixture.request).toHaveBeenCalledOnce()

    // Editing the head moves it into the composer; the held follower does not move by itself.
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    expect(screen.getByTestId('composer-input')).toHaveValue('queued head')
    expect(queueItems()).toHaveLength(1)
    await wait(100)
    expect(fixture.request).toHaveBeenCalledOnce()

    const head = pendingReply()
    fixture.request.mockImplementationOnce(head.run)
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
    expect(lastUserText(1)).toBe('queued head')
    // The follower waits for the head's reply: FIFO.
    await wait(50)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    await act(async () => head.reply.resolve({ content: 'head reply' }))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(3))
    expect(lastUserText(2)).toBe('queued follower')
    await waitFor(() => expect(queueItems()).toHaveLength(0))
    await waitFor(() =>
      expect(userTexts(currentSession().messages)).toEqual([
        'running reply',
        'queued head',
        'queued follower'
      ])
    )
  })

  it('does not send a held follower after the paused head is removed and a send-to-agent auto-send finishes', async () => {
    await renderPage([session('stop-remove')])
    await queueTwoBehindRunningReply()
    fireEvent.click(screen.getByTestId('composer-stop'))
    await waitFor(() => expect(queueItems()[0]).toHaveTextContent('未发送 · 已暂停'))

    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_remove' }))
    expect(queueItems()).toHaveLength(1)
    expect(queueItems()[0]).toHaveTextContent('queued follower')

    // A drain the user did not start: a canvas auto-send into the same conversation.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            autoSend: true,
            text: 'canvas auto-send',
            requestId: 'canvas-request-1'
          }
        })
      )
    })
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
    expect(lastUserText(1)).toBe('canvas auto-send')
    await waitFor(() => expect(userTexts(currentSession().messages)).toContain('canvas auto-send'))
    await wait(200)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    expect(queueItems()).toHaveLength(1)
    expect(queueItems()[0]).toHaveTextContent('queued follower')
    expect(userTexts(currentSession().messages)).not.toContain('queued follower')

    // The user's own accepted send releases the hold; the follower then follows it.
    typeAndSend('my next message')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(4))
    expect(lastUserText(2)).toBe('my next message')
    expect(lastUserText(3)).toBe('queued follower')
  })

  it('makes a stale lease inert when Stop lands during the head preparation', async () => {
    await renderPage([session('stop-preflight')])
    const first = pendingReply()
    fixture.request.mockImplementationOnce(first.run)
    typeAndSend('running reply')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())

    const preparation = Promise.withResolvers<{ content: string; attachments: ChatAttachment[] }>()
    const prepare = vi.fn(() => preparation.promise)
    fixture.prepare = prepare
    // The queued head carries a video, so its preparation runs through the gated step.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: { targetScope: scope, text: 'prepared head', attachment: video() }
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('composer-attachments')).toHaveTextContent('clip.mp4')
    )
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(queueItems()).toHaveLength(1))

    await act(async () => first.reply.resolve({ content: 'first reply' }))
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(queueItems()[0]).toHaveTextContent('正在准备')
    // The conversation is not loading, but the preparation can be stopped.
    fireEvent.click(screen.getByTestId('composer-stop'))
    await waitFor(() => expect(queueItems()[0]).toHaveTextContent('未发送 · 已暂停'))

    // The earlier lease finishes late: it neither sends, accepts nor changes the paused item.
    await act(async () => preparation.resolve({ content: 'prepared head', attachments: [video()] }))
    await wait(100)
    expect(fixture.request).toHaveBeenCalledOnce()
    expect(queueItems()).toHaveLength(1)
    expect(queueItems()[0]).toHaveTextContent('未发送 · 已暂停')
    expect(userTexts(currentSession().messages)).toEqual(['running reply'])

    // Resuming it is the user's action: exactly one request carries it.
    fixture.prepare = async (content, attachments) => ({ content, attachments })
    fireEvent.click(within(queueItems()[0]).getByRole('button', { name: 'chat.queue_edit' }))
    expect(screen.getByTestId('composer-input')).toHaveValue('prepared head')
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
    expect(lastUserText(1)).toBe('prepared head')
    await wait(100)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    expect(userTexts(currentSession().messages)).toEqual(['running reply', 'prepared head'])
  })

  it('drops a team-internal auto-send at the head on Stop and pauses the user item behind it', async () => {
    await renderPage([session('stop-internal-head')])
    const first = pendingReply()
    fixture.request.mockImplementationOnce(first.run)
    typeAndSend('running reply')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            autoSend: true,
            text: 'queued canvas auto-send',
            requestId: 'canvas-request-2'
          }
        })
      )
    })
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    typeAndSend('queued user text')
    await waitFor(() => expect(queueItems()).toHaveLength(2))

    fireEvent.click(screen.getByTestId('composer-stop'))
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    expect(queueItems()[0]).toHaveTextContent('queued user text')
    expect(queueItems()[0]).toHaveTextContent('未发送 · 已暂停')
    await wait(200)
    expect(fixture.request).toHaveBeenCalledOnce()

    // The dropped auto-send released its request key: the same canvas request can be sent again.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            autoSend: true,
            text: 'queued canvas auto-send',
            requestId: 'canvas-request-2'
          }
        })
      )
    })
    await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
    expect(lastUserText(1)).toBe('queued canvas auto-send')
    await wait(100)
    expect(fixture.request).toHaveBeenCalledTimes(2)
    expect(queueItems()[0]).toHaveTextContent('queued user text')
  })

  it('keeps a stopped preparation inert after a thread switch: nothing is sent to either conversation', async () => {
    await renderPage([session('switch-a', 'Thread A'), session('switch-b', 'Thread B')], 'switch-a')
    const first = pendingReply()
    fixture.request.mockImplementationOnce(first.run)
    typeAndSend('running reply')
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())

    const preparation = Promise.withResolvers<{ content: string; attachments: ChatAttachment[] }>()
    fixture.prepare = vi.fn(() => preparation.promise)
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: { targetScope: scope, text: 'queued in A', attachment: video() }
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('composer-attachments')).toHaveTextContent('clip.mp4')
    )
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    await act(async () => first.reply.resolve({ content: 'first reply' }))
    await waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByTestId('composer-stop'))
    await waitFor(() => expect(queueItems()[0]).toHaveTextContent('未发送 · 已暂停'))

    fireEvent.click(screen.getByTestId('select-switch-b'))
    await waitFor(() => expect(currentSession().id).toBe('switch-b'))
    await act(async () => preparation.resolve({ content: 'queued in A', attachments: [video()] }))
    await wait(150)
    expect(fixture.request).toHaveBeenCalledOnce()
    expect(currentSession().messages).toEqual([])
    expect(queueItems()).toHaveLength(0)

    fireEvent.click(screen.getByTestId('select-switch-a'))
    await waitFor(() => expect(currentSession().id).toBe('switch-a'))
    expect(userTexts(currentSession().messages)).toEqual(['running reply'])
    expect(queueItems()).toHaveLength(1)
    expect(queueItems()[0]).toHaveTextContent('queued in A')
    expect(queueItems()[0]).toHaveTextContent('未发送 · 已暂停')
    expect(fixture.request).toHaveBeenCalledOnce()
  })
})
