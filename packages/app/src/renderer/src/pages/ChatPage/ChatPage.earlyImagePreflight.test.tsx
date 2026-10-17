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

const fixture = vi.hoisted(() => ({
  config: null as Config | null,
  profiles: [] as LLMAPIProfile[],
  sessions: [] as ChatSession[],
  backups: {} as Record<string, { updatedAt: number; draft?: ChatSessionDraft }>,
  fetch: vi.fn(),
  request: vi.fn(),
  stream: vi.fn(),
  batch: vi.fn(),
  supportsStreaming: vi.fn(),
  saveImageToDir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  fileToDataUrl: vi.fn(),
  materializeInternalImageDragAttachment: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  discoverVideoFrames: vi.fn(),
  useRealVideoHelper: false,
  videoExpansionFrames: 0
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
    svcFs: {
      readTextFile: fixture.readTextFile,
      writeTextFile: fixture.writeTextFile
    },
    svcLLMProxy: { signHy3DModel: vi.fn() },
    svcHyper: { saveImageToDir: fixture.saveImageToDir },
    svcManagedMedia: {}
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

vi.mock('@renderer/utils/llmUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/utils/llmUtils')>()),
  getLLMConfig: () => fixture.config?.llm_config,
  resolveLLMProfile: () => fixture.profiles[0]
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
    requestChatCompletion: fixture.request,
    requestChatCompletionStream: fixture.stream,
    resolveAttachmentBatchCapability: fixture.batch,
    supportsStreamingChatCompletion: fixture.supportsStreaming
  }
})

vi.mock('./chatVideoAttachmentUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatVideoAttachmentUtils')>()
  return {
    ...actual,
    augmentAttachmentsWithVideoBoundaryFrames: (
      attachments: ChatAttachment[] | undefined,
      content: string
    ) => {
      const hasVideo = attachments?.some((attachment) => attachment.type === 'video')
      if (fixture.useRealVideoHelper && hasVideo) {
        return actual.augmentAttachmentsWithVideoBoundaryFrames(
          attachments,
          content,
          async (url) => {
            fixture.discoverVideoFrames(url)
            return {
              firstFrameDataUrl: 'data:image/png;base64,RklSU1Q=',
              lastFrameDataUrl: 'data:image/png;base64,TEFTVA=='
            }
          }
        )
      }
      if (hasVideo && fixture.videoExpansionFrames > 0) {
        const frameCount = fixture.videoExpansionFrames
        fixture.videoExpansionFrames = 0
        fixture.discoverVideoFrames()
        return Promise.resolve({
          content,
          attachments: [
            ...(attachments || []),
            ...Array.from({ length: frameCount }, (_, index) => ({
              type: 'image' as const,
              url: `data:image/png;base64,frame-${index}`,
              fileName:
                index === 0
                  ? 'fixture-video-first-frame.png'
                  : index === frameCount - 1
                    ? 'fixture-video-last-frame.png'
                    : `fixture-video-frame-${index + 1}.png`,
              mimeType: 'image/png'
            }))
          ]
        })
      }
      return actual.augmentAttachmentsWithVideoBoundaryFrames(attachments, content)
    }
  }
})

vi.mock('@renderer/utils/droppedImageUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/utils/droppedImageUtils')>()
  return {
    ...actual,
    materializeInternalImageDragAttachment: async (attachment: ChatAttachment) => {
      fixture.materializeInternalImageDragAttachment(attachment)
      return attachment
    }
  }
})

vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
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
    pendingAttachments
  }: {
    inputValue: string
    onInputChange: (value: string) => void
    onSend: () => void
    pendingAttachments: ChatAttachment[]
  }) => (
    <div>
      <input
        data-testid="composer-input"
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <pre data-testid="pending-attachments">{JSON.stringify(pendingAttachments)}</pre>
      <button type="button" data-testid="composer-send" onClick={onSend}>
        Send
      </button>
    </div>
  )
}))

const theme = createTheme()
const scope = 'early-preflight'
const draftText = 'Draft text'

const image = (index: number, url = `blob:fixture-${index}`): ChatAttachment => ({
  type: 'image',
  url,
  fileName: `image-${index}.png`,
  mimeType: 'image/png'
})

const video = (url = 'https://fixture.invalid/video.mp4'): ChatAttachment => ({
  type: 'video',
  url,
  fileName: 'fixture-video.mp4',
  mimeType: 'video/mp4'
})

const makeSession = (attachments: ChatAttachment[], title = 'Fixture session'): ChatSession => ({
  id: 'fixture-session',
  title,
  messages: [],
  draft: {
    inputValue: draftText,
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

const configure = (maxInputImages?: number): void => {
  fixture.config = cloneValue(DEFAULT_CONFIG)
  fixture.config!.use_remote_llm = false
  fixture.config!.llm_config.api_profiles = [
    {
      id: 'fixture-profile',
      model_name: 'fixture-model',
      provider: 'openai',
      api_mode: 'responses',
      ...(maxInputImages === undefined ? {} : { max_input_images: maxInputImages })
    } as LLMAPIProfile
  ]
  fixture.profiles = fixture.config!.llm_config.api_profiles
}

const renderPage = async (session: ChatSession): Promise<void> => {
  const fixtureSession = {
    ...cloneValue(session),
    storageScope: scope,
    draft: session.draft
      ? {
          ...session.draft,
          pendingAttachments: session.draft.pendingAttachments.map((attachment) => ({
            ...attachment
          }))
        }
      : undefined
  }
  fixture.sessions = [fixtureSession]
  window.localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), session.id)
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <div id={buildChatWorkspaceControlsPortalId(scope)} />
        <div id="agent-workspace-skill-portal" />
        <ChatPage storageScope={scope} />
      </MemoryRouter>
    </ThemeProvider>
  )
  await waitFor(() => expect(screen.getByTestId('session-state')).toBeInTheDocument())
  await waitFor(() => expect(currentSession().id).toBe(session.id))
  await waitFor(() =>
    expect(screen.getByTestId('composer-input')).toHaveValue(session.draft?.inputValue)
  )
  await waitFor(() =>
    expect(pendingAttachments()).toHaveLength(session.draft?.pendingAttachments?.length ?? 0)
  )
}

const clearSendObservations = (): void => {
  fixture.fetch.mockClear()
  fixture.request.mockClear()
  fixture.stream.mockClear()
  fixture.batch.mockClear()
  fixture.readTextFile.mockClear()
  fixture.saveImageToDir.mockClear()
  fixture.notifyError.mockClear()
  fixture.notifyWarning.mockClear()
  fixture.materializeInternalImageDragAttachment.mockClear()
  fixture.discoverVideoFrames.mockClear()
}

const settleInitialDraftPersistence = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260))
  })
  clearSendObservations()
}

beforeEach(() => {
  vi.resetAllMocks()
  configure()
  fixture.sessions = []
  fixture.backups = {}
  fixture.fetch.mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['fixture-image'], { type: 'image/png' })
  })
  fixture.fileToDataUrl.mockImplementation(async (file: File) => `blob:serialized-${file.name}`)
  fixture.request.mockResolvedValue({ content: 'fixture assistant response' })
  fixture.stream.mockResolvedValue({
    result: { content: 'fixture streamed response' },
    response: 'fixture streamed response'
  })
  fixture.batch.mockResolvedValue(1)
  fixture.supportsStreaming.mockReturnValue(false)
  fixture.saveImageToDir.mockResolvedValue({ savedPath: 'C:/fixture/chat-upload.png' })
  fixture.readTextFile.mockResolvedValue({ content: 'fixture resource' })
  fixture.writeTextFile.mockResolvedValue(undefined)
  fixture.materializeInternalImageDragAttachment.mockImplementation(
    async (attachment: ChatAttachment) => attachment
  )
  fixture.useRealVideoHelper = false
  fixture.videoExpansionFrames = 0
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
  document.body.innerHTML = ''
})

describe('ChatPage image preflight at the send boundary', () => {
  it('rejects three provisional blob images before any I/O, dispatch, resource read, or placeholder', async () => {
    configure(2)
    const attachments = [image(1), image(2), image(3)]
    await renderPage(makeSession(attachments))
    await settleInitialDraftPersistence()

    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('Too many images; the limit is 2.')
    )

    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.saveImageToDir).not.toHaveBeenCalled()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.stream).not.toHaveBeenCalled()
    expect(fixture.readTextFile).not.toHaveBeenCalled()
    expect(fixture.batch).not.toHaveBeenCalled()
    expect(currentSession().messages).toEqual([])
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
    expect(pendingAttachments()).toHaveLength(3)
    expect(pendingAttachments().every((attachment) => attachment.url.startsWith('blob:'))).toBe(
      true
    )
  })

  it('does not invoke the auto-send resolver when queued attachment descriptors exceed the limit', async () => {
    configure(2)
    await renderPage(makeSession([], 'queued draft'))
    await settleInitialDraftPersistence()

    const queuedAttachments = [
      image(1, 'local-media:///queued-1.png'),
      image(2, 'local-media:///queued-2.png'),
      image(3, 'local-media:///queued-3.png')
    ]
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            autoSend: true,
            requestId: 'queued-over-limit',
            text: 'Analyze these images.',
            attachments: queuedAttachments
          }
        })
      )
    })
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('Too many images; the limit is 2.')
    )

    expect(fixture.materializeInternalImageDragAttachment).not.toHaveBeenCalled()
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.saveImageToDir).not.toHaveBeenCalled()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.stream).not.toHaveBeenCalled()
    expect(currentSession().messages).toEqual([])
  })

  it('rejects queued video descriptors when boundary expansion exceeds the limit', async () => {
    configure(2)
    await renderPage(makeSession([], 'queued video'))
    await settleInitialDraftPersistence()

    const queuedVideo = video()
    fixture.videoExpansionFrames = 3
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            autoSend: true,
            requestId: 'queued-video-over-limit',
            text: 'Analyze this video.',
            attachment: queuedVideo
          }
        })
      )
    })
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('Too many images; the limit is 2.')
    )

    expect(fixture.discoverVideoFrames).toHaveBeenCalledTimes(1)
    expect(fixture.materializeInternalImageDragAttachment).not.toHaveBeenCalled()
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.saveImageToDir).not.toHaveBeenCalled()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.stream).not.toHaveBeenCalled()
    expect(fixture.readTextFile).not.toHaveBeenCalled()
    expect(fixture.batch).not.toHaveBeenCalled()
    expect(currentSession().messages).toEqual([])
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
    expect(pendingAttachments()).toHaveLength(0)
  })

  it.each([
    { label: 'accessible URL', url: 'https://fixture.invalid/video.mp4', materializes: true },
    { label: 'blob URL', url: 'blob:fixture-video', materializes: false }
  ])(
    'allows queued $label video with both frames at the exact limit',
    async ({ url, materializes }) => {
      configure(2)
      await renderPage(makeSession([], 'queued video at limit'))
      await settleInitialDraftPersistence()

      fixture.useRealVideoHelper = true
      const queuedVideo = video(url)
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: {
              targetScope: scope,
              autoSend: true,
              requestId: 'queued-video-at-limit',
              text: 'Analyze this video.',
              attachment: queuedVideo
            }
          })
        )
      })

      await waitFor(() => expect(fixture.request).toHaveBeenCalled())
      expect(fixture.notifyError).not.toHaveBeenCalled()
      if (materializes) {
        expect(fixture.materializeInternalImageDragAttachment).toHaveBeenCalledTimes(1)
        expect(fixture.materializeInternalImageDragAttachment).toHaveBeenCalledWith(queuedVideo)
      } else {
        expect(fixture.materializeInternalImageDragAttachment).not.toHaveBeenCalled()
      }
      expect(fixture.discoverVideoFrames).toHaveBeenCalledTimes(1)
      expect(fixture.discoverVideoFrames).toHaveBeenCalledWith(queuedVideo.url)
      expect(fixture.fetch).not.toHaveBeenCalled()
      expect(fixture.saveImageToDir).not.toHaveBeenCalled()
      const requestMessages = fixture.request.mock.calls.flatMap(
        ([input]) =>
          (input as { messages?: Array<{ attachments?: ChatAttachment[] }> }).messages || []
      )
      const videoMessage = requestMessages.find((message) =>
        message.attachments?.some(
          (attachment) => attachment.type === 'video' && attachment.url === queuedVideo.url
        )
      )
      expect(videoMessage?.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'video',
            url: queuedVideo.url,
            fileName: queuedVideo.fileName
          }),
          expect.objectContaining({
            type: 'image',
            fileName: 'fixture-video-first-frame.png',
            url: 'data:image/png;base64,RklSU1Q='
          }),
          expect.objectContaining({
            type: 'image',
            fileName: 'fixture-video-last-frame.png',
            url: 'data:image/png;base64,TEFTVA=='
          })
        ])
      )
      expect(
        requestMessages
          .flatMap((message) => message.attachments || [])
          .some((attachment) => attachment.url.startsWith('provisional:'))
      ).toBe(false)
    }
  )

  it.each([
    { name: 'the exact finite limit', maxInputImages: 2, count: 2 },
    { name: 'an unlimited profile', maxInputImages: Infinity, count: 3 }
  ])('persists $name manual blob images before dispatch', async ({ maxInputImages, count }) => {
    configure(maxInputImages)
    const attachments = Array.from({ length: count }, (_, index) => image(index + 1))
    await renderPage(makeSession(attachments, 'manual blob images'))
    await settleInitialDraftPersistence()

    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalled())

    expect(fixture.fetch).toHaveBeenCalledTimes(count)
    expect(fixture.saveImageToDir).toHaveBeenCalledTimes(count)
    expect(fixture.notifyError).not.toHaveBeenCalled()
    expect(currentSession().messages.some((message) => message.role === 'user')).toBe(true)
  })
})

describe('manual blob attachment persistence at the send boundary', () => {
  it.each([
    { label: 'exact finite limit', maxInputImages: 2, count: 2 },
    { label: 'default unlimited policy', maxInputImages: undefined, count: 3 }
  ])('persists every image once under the $label', async ({ maxInputImages, count }) => {
    configure(maxInputImages)
    fixture.saveImageToDir.mockImplementation(async ({ fileName }: { fileName: string }) => ({
      savedPath: `C:/fixture/${fileName}`
    }))
    await renderPage(makeSession(Array.from({ length: count }, (_, index) => image(index + 1))))
    await settleInitialDraftPersistence()
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(currentSession().messages.some((message) => message.role === 'assistant')).toBe(true)
    )
    expect(fixture.request).toHaveBeenCalled()
    expect(fixture.fetch).toHaveBeenCalledTimes(count)
    expect(fixture.saveImageToDir).toHaveBeenCalledTimes(count)
    expect(fixture.notifyError).not.toHaveBeenCalled()
    expect(fixture.readTextFile).not.toHaveBeenCalled()
    const outgoing = currentSession().messages.find((message) => message.role === 'user')
    expect(outgoing?.attachments).toHaveLength(count)
    expect(
      outgoing?.attachments?.every((attachment) => attachment.url.startsWith('file://C:/fixture/'))
    ).toBe(true)
    expect(new Set(outgoing?.attachments?.map((attachment) => attachment.url)).size).toBe(count)
    expect(screen.getByTestId('composer-input')).toHaveValue('')
    expect(pendingAttachments()).toEqual([])
  })
})

describe('video boundary discovery as the second image-limit boundary', () => {
  const videoDraft = (): ChatAttachment[] => [image(1), video()]

  it('rejects after boundary expansion and before blob persistence', async () => {
    configure(2)
    fixture.videoExpansionFrames = 2
    await renderPage(makeSession(videoDraft()))
    await settleInitialDraftPersistence()

    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('Too many images; the limit is 2.')
    )

    expect(fixture.discoverVideoFrames).toHaveBeenCalledTimes(1)
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.saveImageToDir).not.toHaveBeenCalled()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.stream).not.toHaveBeenCalled()
    expect(fixture.readTextFile).not.toHaveBeenCalled()
    expect(fixture.batch).not.toHaveBeenCalled()
    expect(currentSession().messages).toEqual([])
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
    expect(pendingAttachments()).toHaveLength(2)
    expect(pendingAttachments()[0].url).toMatch(/^blob:/)
  })

  it('discovers boundary frames under the unlimited policy, then persists and dispatches', async () => {
    configure()
    fixture.videoExpansionFrames = 2
    await renderPage(makeSession(videoDraft()))
    await settleInitialDraftPersistence()

    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalled())
    await waitFor(() =>
      expect(currentSession().messages.some((message) => message.role === 'assistant')).toBe(true)
    )

    expect(fixture.discoverVideoFrames).toHaveBeenCalledTimes(1)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(fixture.saveImageToDir).toHaveBeenCalledTimes(1)
    expect(fixture.batch).toHaveBeenCalled()
    expect(fixture.readTextFile).not.toHaveBeenCalled()
    expect(fixture.notifyError).not.toHaveBeenCalled()
    expect(
      currentSession().messages.some(
        (message) => message.role === 'user' && message.attachments?.length === 4
      )
    ).toBe(true)
  })
})
