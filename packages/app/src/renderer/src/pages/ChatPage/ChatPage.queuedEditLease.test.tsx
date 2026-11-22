import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

// An edit sent while the conversation is busy is queued like a composer item: it keeps a lease
// while it is prepared and is retired only when its user turn is accepted. A refused preparation
// leaves it queued and paused with its text; it is never dropped or replayed by itself.

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
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
// The transcript's edit action: resend the first user message with new text and a video.
vi.mock('./components/ChatMessageList', () => ({
  default: ({
    currentSession,
    onSendEditedMessage
  }: {
    currentSession?: ChatSession
    onSendEditedMessage: (
      content: string,
      attachments: ChatAttachment[] | undefined,
      hiddenContext: string | undefined,
      baseMessages: ChatMessage[]
    ) => void
  }) => (
    <>
      <pre data-testid="session-state">{JSON.stringify(currentSession ?? null)}</pre>
      <button
        type="button"
        data-testid="edit-first-message"
        onClick={() =>
          onSendEditedMessage(
            'edited question',
            [
              {
                type: 'video',
                url: 'https://fixture.invalid/edit.mp4',
                fileName: 'edit.mp4',
                mimeType: 'video/mp4'
              }
            ],
            undefined,
            []
          )
        }
      >
        edit
      </button>
    </>
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

const scope = 'queued-edit-lease'
const theme = createTheme()
const currentSession = (): ChatSession =>
  JSON.parse(screen.getByTestId('session-state').textContent || 'null') as ChatSession
const queueItems = () => screen.queryAllByTestId('chat-queue-item')
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

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
  fixture.prepare = null
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

describe('ChatPage queued edit lease', () => {
  it('keeps a queued edit paused with its text when its preparation is refused', async () => {
    fixture.sessions = [
      {
        id: 'edit-lease',
        title: 'Edit lease',
        profileId: 'fixture-profile',
        messages: [
          { role: 'user', content: 'original question' },
          { role: 'assistant', content: 'original answer' }
        ]
      }
    ]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'edit-lease')
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <div id={buildChatWorkspaceControlsPortalId(scope)} />
          <ChatPage storageScope={scope} />
        </MemoryRouter>
      </ThemeProvider>
    )
    await waitFor(() => expect(currentSession()?.id).toBe('edit-lease'))
    await wait(260)

    const running = Promise.withResolvers<{ content: string }>()
    fixture.request.mockImplementationOnce(() => running.promise)
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'running reply' } })
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())

    // The edit arrives while the reply runs: it is queued, not sent.
    fireEvent.click(screen.getByTestId('edit-first-message'))
    await waitFor(() => expect(queueItems()).toHaveLength(1))
    expect(queueItems()[0]).toHaveTextContent('edited question')

    const prepare = vi.fn(async () => {
      throw new Error('Synthetic preparation refusal')
    })
    fixture.prepare = prepare
    await act(async () => running.resolve({ content: 'running answer' }))
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    await waitFor(() => expect(queueItems()[0]).toHaveTextContent('未发送 · 已暂停'))
    expect(queueItems()).toHaveLength(1)
    expect(queueItems()[0]).toHaveTextContent('edited question')
    await wait(150)
    expect(prepare).toHaveBeenCalledOnce()
    expect(fixture.request).toHaveBeenCalledOnce()
    expect(currentSession().messages.some((message) => message.content === 'edited question')).toBe(
      false
    )
    expect(currentSession().messages.map((message) => message.content)).toEqual([
      'original question',
      'original answer',
      'running reply',
      'running answer'
    ])
  })
})
