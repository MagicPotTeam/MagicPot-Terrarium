import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type { ChatSession, ChatSessionDraft } from './chatStorage'
import ChatPage from './ChatPage'
import {
  buildChatWorkspaceControlsPortalId,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID
} from './chatPageShared'

// Owner decision 5: the same image delivered twice is two occurrences. These cases follow the
// occurrences past the composer, into the provider payload built by the real chatRequestUtils.
const fixture = vi.hoisted(() => ({
  config: null as Config | null,
  sessions: [] as ChatSession[],
  backups: {} as Record<string, { updatedAt: number; draft?: ChatSessionDraft }>,
  fetch: vi.fn(),
  request: vi.fn(),
  stream: vi.fn(),
  batch: vi.fn(),
  supportsStreaming: vi.fn(),
  saveImageToDir: vi.fn(),
  fileToDataUrl: vi.fn(),
  importDataUrl: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  useRealCompletion: false,
  useRealComposer: false,
  requestApi: null as null | {
    svcManagedMedia: { materializeForRequest: (...args: unknown[]) => unknown }
  }
}))

const cloneValue = <T,>(value: T): T => {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options?: { defaultValue?: string; error?: string }) =>
      options?.defaultValue || options?.error || key
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
    svcFs: { readTextFile: vi.fn(), writeTextFile: vi.fn() },
    svcLLMProxy: { signHy3DModel: vi.fn() },
    svcHyper: { saveImageToDir: fixture.saveImageToDir },
    svcManagedMedia: fixture.requestApi?.svcManagedMedia ?? { importDataUrl: fixture.importDataUrl }
  })
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  fileToDataUrl: (file: File) => fixture.fileToDataUrl(file),
  fileToBlobUrl: vi.fn(() => 'blob:fixture-preview'),
  selectFile: vi.fn(),
  checkFileSize: () => true,
  isImageFile: () => true
}))

vi.mock('@renderer/utils/messageUtils', () => ({
  getMessageText: (message: { content?: string }) => message.content || ''
}))

vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  return {
    ...actual,
    loadAllSessions: () => Promise.resolve(fixture.sessions),
    saveSessionToDB: async (session: ChatSession) => {
      const index = fixture.sessions.findIndex((candidate) => candidate.id === session.id)
      if (index >= 0) fixture.sessions[index] = cloneValue(session)
      else fixture.sessions.push(cloneValue(session))
    },
    debouncedSaveSessions: () => undefined,
    cancelDebouncedSessionSave: () => undefined,
    saveChatSessions: (sessions: ChatSession[]) => {
      fixture.sessions = cloneValue(sessions)
    },
    loadChatSessionBackups: () => fixture.backups,
    saveChatSessionBackups: (backups: typeof fixture.backups) => {
      fixture.backups = cloneValue(backups)
    }
  }
})

vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return {
    ...actual,
    requestChatCompletion: (...args: Parameters<typeof actual.requestChatCompletion>) =>
      fixture.useRealCompletion ? actual.requestChatCompletion(...args) : fixture.request(...args),
    requestChatCompletionStream: (
      ...args: Parameters<typeof actual.requestChatCompletionStream>
    ) =>
      fixture.useRealCompletion
        ? actual.requestChatCompletionStream(...args)
        : fixture.stream(...args),
    resolveAttachmentBatchCapability: fixture.batch,
    supportsStreamingChatCompletion: fixture.supportsStreaming
  }
})

vi.mock('@renderer/utils/droppedImageUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/utils/droppedImageUtils')>()
  return {
    ...actual,
    materializeInternalImageDragAttachment: async (attachment: ChatAttachment) => attachment
  }
})

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
        <button key={session.id} type="button" onClick={() => onSelectSession(session.id)}>
          Open {session.id}
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
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))

vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: { currentSession?: ChatSession }) => (
    <pre data-testid="session-state">{JSON.stringify(currentSession ?? null)}</pre>
  )
}))

type ComposerProps = {
  inputValue: string
  onInputChange: (value: string) => void
  onSend: () => void
  onRemoveAttachment: (index: number) => void
  pendingAttachments: ChatAttachment[]
}

// The stand-in composer, or the real one when a case needs the composer's own revoke calls.
vi.mock('./components/ChatComposer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/ChatComposer')>()
  const RealComposer = actual.default as unknown as (props: ComposerProps) => JSX.Element
  return {
    default: (props: ComposerProps) =>
      fixture.useRealComposer ? (
        <div>
          <pre data-testid="pending-attachments">{JSON.stringify(props.pendingAttachments)}</pre>
          <RealComposer {...props} />
        </div>
      ) : (
        <div>
          <input
            data-testid="composer-input"
            value={props.inputValue}
            onChange={(event) => props.onInputChange(event.target.value)}
          />
          <pre data-testid="pending-attachments">{JSON.stringify(props.pendingAttachments)}</pre>
          {props.pendingAttachments.map((_attachment, index) => (
            <button
              key={index}
              type="button"
              data-testid={`mock-remove-${index}`}
              onClick={() => props.onRemoveAttachment(index)}
            >
              Remove
            </button>
          ))}
          <button type="button" data-testid="composer-send" onClick={props.onSend}>
            Send
          </button>
        </div>
      )
  }
})

const theme = createTheme()
const scope = 'image-occurrences'
const sharedBlobUrl = 'blob:shared-occurrence'
const sha = 'a'.repeat(64)

const blobImage = (fileName = 'shared.png'): ChatAttachment => ({
  type: 'image',
  url: sharedBlobUrl,
  fileName,
  mimeType: 'image/png'
})

// A canvas image after the hand-off: a managed attachment with its local-media URL.
const managedImage = (): ChatAttachment => ({
  type: 'image',
  url: `local-media:///fixture-media/${sha}.png`,
  fileName: 'same.png',
  mimeType: 'image/png',
  sizeBytes: 3,
  media: {
    version: 1,
    kind: 'managed',
    relativePath: `user-output/chat-attachments/originals/aa/${sha}.png`,
    sha256: sha,
    sizeBytes: 3,
    mimeType: 'image/png',
    originalFileName: 'same.png'
  }
})

const makeSession = (
  id: string,
  attachments: ChatAttachment[],
  inputValue = `${id} draft`
): ChatSession => ({
  id,
  title: id,
  messages: [],
  storageScope: scope,
  draft: {
    inputValue,
    pendingAttachments: attachments,
    pendingHiddenContext: '',
    updatedAt: Date.now()
  },
  profileId: 'fixture-profile'
})

const pendingAttachments = (): ChatAttachment[] =>
  JSON.parse(screen.getByTestId('pending-attachments').textContent || '[]') as ChatAttachment[]

const currentSession = (): ChatSession =>
  JSON.parse(screen.getByTestId('session-state').textContent || 'null') as ChatSession

const configure = (): void => {
  fixture.config = cloneValue(DEFAULT_CONFIG)
  fixture.config!.use_remote_llm = false
  fixture.config!.llm_config.api_profiles = [
    {
      id: 'fixture-profile',
      model_name: 'fixture-model',
      provider: 'openai',
      api_mode: 'responses',
      // Managed images reach the provider as request data URLs.
      attachment_transports: ['request-data-url']
    } as LLMAPIProfile
  ]
}

const renderPage = async (sessions: ChatSession[], currentId = sessions[0].id): Promise<void> => {
  fixture.sessions = cloneValue(sessions)
  window.localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), currentId)
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <div id={buildChatWorkspaceControlsPortalId(scope)} />
        <div id="agent-workspace-skill-portal" />
        <ChatPage storageScope={scope} />
      </MemoryRouter>
    </ThemeProvider>
  )
  await waitFor(() => expect(currentSession()?.id).toBe(currentId))
  const current = sessions.find((session) => session.id === currentId)
  await waitFor(() =>
    expect(pendingAttachments()).toHaveLength(current?.draft?.pendingAttachments.length ?? 0)
  )
  // Let the initial draft persistence start (its blob serialization may never finish).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260))
  })
}

const dispatchSendToAgent = async (detail: Record<string, unknown>): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('send-to-agent', { detail: { targetScope: scope, ...detail } })
    )
  })
}

const selectSession = async (id: string): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: `Open ${id}` }))
  await waitFor(() => expect(currentSession().id).toBe(id))
}

type WindowWithApi = Window & { api?: unknown }

beforeEach(() => {
  vi.resetAllMocks()
  configure()
  fixture.sessions = []
  fixture.backups = {}
  fixture.useRealCompletion = false
  fixture.useRealComposer = false
  fixture.requestApi = null
  fixture.fetch.mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['fixture-image'], { type: 'image/png' })
  })
  // Draft serialization of a blob: URL never finishes, so the URL stays in every
  // transient draft that holds it.
  fixture.fileToDataUrl.mockReturnValue(new Promise<string>(() => {}))
  fixture.request.mockResolvedValue({ content: 'fixture assistant response' })
  fixture.stream.mockResolvedValue({
    result: { content: 'fixture streamed response' },
    response: 'fixture streamed response'
  })
  fixture.batch.mockResolvedValue(1)
  fixture.supportsStreaming.mockReturnValue(false)
  fixture.saveImageToDir.mockResolvedValue({ savedPath: 'C:/fixture/chat-upload.png' })
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('fetch', fixture.fetch)
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.unstubAllGlobals()
  delete (window as WindowWithApi).api
  document.body.innerHTML = ''
})

describe('ChatPage image occurrences in the provider payload', () => {
  it.each([false, true])(
    'sends two occurrences of the same image delivered by two events as two image parts (stream=%s)',
    async (stream) => {
      fixture.useRealCompletion = true
      fixture.supportsStreaming.mockReturnValue(stream)
      const materializeForRequest = vi.fn(
        async ({ reference, transport }: { reference: { sha256: string }; transport: string }) =>
          transport === 'chunked-binary-v1'
            ? {
                transport,
                reference: { sha256: reference.sha256, sizeBytes: 3, mimeType: 'image/png' },
                chunks: []
              }
            : {
                transport: 'request-data-url',
                dataUrl: 'data:image/png;base64,AQID',
                mimeType: 'image/png',
                sizeBytes: 3
              }
      )
      const chat = vi.fn(async () => ({ content: 'fixture provider reply' }))
      const chatStream = vi.fn(
        async (_request: unknown, response: { onData: (chunk: unknown) => void }) => {
          response.onData({ type: 'done', content: 'fixture provider reply' })
        }
      )
      fixture.requestApi = { svcManagedMedia: { materializeForRequest } }
      ;(window as WindowWithApi).api = {
        svcLLMProxy: { chat, chatStream, cancelConversation: vi.fn(async () => undefined) }
      }
      await renderPage([makeSession('session-a', [])])

      const first = managedImage()
      const second = managedImage()
      await dispatchSendToAgent({ attachment: first })
      await dispatchSendToAgent({ attachment: second })
      await waitFor(() => expect(pendingAttachments()).toEqual([first, second]))

      fireEvent.click(screen.getByTestId('composer-send'))
      const dispatch = stream ? chatStream : chat
      await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
      expect(stream ? chat : chatStream).not.toHaveBeenCalled()
      const payload = dispatch.mock.calls[0][0] as {
        messages: { role: string; attachments?: ChatAttachment[] }[]
      }
      const user = payload.messages.filter((message) => message.role === 'user').at(-1)
      const images = (user?.attachments ?? []).filter((attachment) => attachment.type === 'image')
      // Same URL, same name, same content: still two image parts, in delivery order.
      expect(images).toHaveLength(2)
      expect(images.map((image) => image.fileName)).toEqual(['same.png', 'same.png'])
      expect(materializeForRequest).toHaveBeenCalledTimes(2)
      expect(materializeForRequest.mock.calls.map(([request]) => request.reference.sha256)).toEqual(
        [sha, sha]
      )
    }
  )
})
