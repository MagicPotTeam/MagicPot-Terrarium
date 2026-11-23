import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../testUtils/globalLocale'
import { zhLocaleText } from '../../testUtils/localeTranslator'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { AgentRouteLike } from '@shared/agent'
import { hasThreadImageTool } from './chatPageExtensions'
import type { ChatAttachment } from '@shared/llm'
import type { ChatSession, ChatSessionDraft } from './chatStorage'
import { UNVERIFIED_REPORT_BUNDLE_MESSAGE } from '@shared/llm/unverifiedReport'
import { createReportBundleRegistryFixture } from './__fixtures__/reportBundleFixtures'
import ChatPage from './ChatPage'
import { ChatRequestImageBudgetError } from './chatRequestImageBudget'
import {
  buildChatWorkspaceControlsPortalId,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID
} from './chatPageShared'

// Saved chat images are read as a bounded stream and must sniff as an image, so the
// fixture serves a real Response whose bytes start with the PNG signature.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const pngResponse = (marker: string): Response =>
  new Response(new Uint8Array([...PNG_SIGNATURE, ...new TextEncoder().encode(marker)]), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  })
const pngMarker = (data: Uint8Array): string =>
  new TextDecoder().decode(data.subarray(PNG_SIGNATURE.length))
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
  importDataUrl: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  selectFile: vi.fn(),
  fileTooLarge: false,
  discoverVideoFrames: vi.fn(),
  videoExpansionOverride: null as
    | null
    | ((
        attachments: ChatAttachment[] | undefined,
        content: string
      ) => Promise<{ content: string; attachments: ChatAttachment[] }>),
  useRealVideoHelper: false,
  videoExpansionFrames: 0,
  useRealCompletion: false,
  requestApi: null as null | {
    svcManagedMedia: { materializeForRequest: (...args: unknown[]) => unknown }
    svcLLMProxy: {
      chat: (...args: unknown[]) => unknown
      chatStream: (...args: unknown[]) => unknown
      remoteFetch: (...args: unknown[]) => unknown
    }
    svcReportBundles?: { verify: (...args: never[]) => unknown }
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
      options?.defaultValue || options?.error || zhLocaleText(key)
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
    svcLLMProxy: { signHy3DModel: vi.fn(), ...fixture.requestApi?.svcLLMProxy },
    svcHyper: { saveImageToDir: fixture.saveImageToDir },
    svcManagedMedia: fixture.requestApi?.svcManagedMedia ?? {
      importDataUrl: fixture.importDataUrl
    },
    ...(fixture.requestApi?.svcReportBundles
      ? { svcReportBundles: fixture.requestApi.svcReportBundles }
      : {})
  })
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  fileToDataUrl: (file: File) => fixture.fileToDataUrl(file),
  fileToBlobUrl: vi.fn(() => 'blob:fixture-preview'),
  selectFile: (...args: unknown[]) => fixture.selectFile(...args),
  checkFileSize: () => !fixture.fileTooLarge,
  formatFileSize: (bytes: number) => `${bytes} B`,
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

vi.mock('./chatVideoAttachmentUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatVideoAttachmentUtils')>()
  return {
    ...actual,
    augmentAttachmentsWithVideoBoundaryFrames: (
      attachments: ChatAttachment[] | undefined,
      content: string
    ) => {
      const hasVideo = attachments?.some((attachment) => attachment.type === 'video')
      if (hasVideo && fixture.videoExpansionOverride) {
        return fixture.videoExpansionOverride(attachments, content)
      }
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
    onRemoveAttachment,
    onUploadFile,
    pendingAttachments
  }: {
    inputValue: string
    onInputChange: (value: string) => void
    onSend: () => void
    onRemoveAttachment: (index: number) => void
    onUploadFile?: () => void
    pendingAttachments: ChatAttachment[]
  }) => (
    <div>
      <input
        data-testid="composer-input"
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <pre data-testid="pending-attachments">{JSON.stringify(pendingAttachments)}</pre>
      {pendingAttachments.map((_attachment, index) => (
        <button
          key={index}
          type="button"
          data-testid={`mock-remove-${index}`}
          onClick={() => onRemoveAttachment(index)}
        >
          Remove
        </button>
      ))}
      <button type="button" data-testid="composer-send" onClick={onSend}>
        Send
      </button>
      <button type="button" data-testid="composer-upload" onClick={onUploadFile}>
        Upload
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

const renderPage = async (session: ChatSession, route?: AgentRouteLike): Promise<void> => {
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
        <ChatPage storageScope={scope} route={route} />
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

// The draft autosave imports every blob: image of the composer one by one, and its reads land in
// the same fetch/IPC spies the send assertions use. A fixed delay lets a slow CI runner carry those
// reads past the clear, so wait until the autosave has gone quiet before clearing the observations.
const draftPersistenceActivity = (): number =>
  fixture.fetch.mock.calls.length +
  fixture.saveImageToDir.mock.calls.length +
  fixture.materializeInternalImageDragAttachment.mock.calls.length +
  fixture.writeTextFile.mock.calls.length

const settleInitialDraftPersistence = async (): Promise<void> => {
  const quietMs = 260
  const deadline = Date.now() + 10_000
  let seen = -1
  for (;;) {
    const before = draftPersistenceActivity()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, quietMs))
    })
    const after = draftPersistenceActivity()
    if (after === before && after === seen) break
    seen = after
    if (Date.now() > deadline) throw new Error('The initial draft autosave never went quiet')
  }
  clearSendObservations()
}

beforeEach(() => {
  vi.resetAllMocks()
  configure()
  fixture.sessions = []
  fixture.backups = {}
  fixture.fetch.mockImplementation(async () => pngResponse('fixture-image'))
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
  fixture.videoExpansionOverride = null
  fixture.videoExpansionFrames = 0
  fixture.useRealCompletion = false
  fixture.requestApi = null
  fixture.fileTooLarge = false
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
  it('keeps a shared blob URL usable until the last duplicate draft occurrence is removed', async () => {
    configure()
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const first = image(1, 'blob:shared-fixture')
    const second = image(2, 'blob:shared-fixture')
    // Keep two in-memory occurrences pending without relying on a persisted blob URL.
    const neverSerialize = new Promise<string>(() => {})
    fixture.fileToDataUrl.mockReturnValue(neverSerialize)
    await renderPage(makeSession([first, second]))
    expect(pendingAttachments()).toEqual([first, second])
    fireEvent.click(screen.getByTestId('mock-remove-0'))
    await waitFor(() => expect(pendingAttachments()).toEqual([second]))
    expect(revoke).not.toHaveBeenCalledWith('blob:shared-fixture')
    fireEvent.click(screen.getByTestId('mock-remove-0'))
    await waitFor(() => expect(pendingAttachments()).toEqual([]))
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:shared-fixture')
  })

  it('preserves separately delivered explicit image occurrences even when their URLs match', async () => {
    configure()
    await renderPage(makeSession([]))
    await settleInitialDraftPersistence()
    const first = image(1, 'local-media:///fixture/same-source.png')
    const second = image(2, 'local-media:///fixture/same-source.png')
    await act(async () => {
      for (const attachment of [first, second]) {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', { detail: { targetScope: scope, attachment } })
        )
      }
    })
    await waitFor(() => expect(pendingAttachments()).toEqual([first, second]))
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    const sent = fixture.request.mock.calls[0][0].messages.find(
      (message: { role: string }) => message.role === 'user'
    )
    expect(sent.attachments).toEqual([first, second])
  })

  it.each([false, true])(
    'rejects a single external batch of 51 identical image occurrences before materialization (auto=%s)',
    async (autoSend) => {
      configure()
      await renderPage(makeSession([]))
      await settleInitialDraftPersistence()
      const before = pendingAttachments()
      const same = image(1, 'blob:fixture-repeated')
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: {
              targetScope: scope,
              autoSend,
              text: 'should not append',
              attachments: Array.from({ length: 51 }, () => same)
            }
          })
        )
      })
      await waitFor(() =>
        expect(fixture.notifyError).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
      )
      expect(fixture.materializeInternalImageDragAttachment).not.toHaveBeenCalled()
      expect(fixture.fetch).not.toHaveBeenCalled()
      expect(fixture.request).not.toHaveBeenCalled()
      expect(pendingAttachments()).toEqual(before)
      expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
    }
  )

  it('rejects an external batch of 50 image descriptors plus an inline image before resolution', async () => {
    configure()
    await renderPage(makeSession([]))
    await settleInitialDraftPersistence()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            autoSend: true,
            text: 'Analyze',
            image: 'data:image/png;base64,ZmFrZQ==',
            attachments: Array.from({ length: 50 }, (_, i) =>
              image(i, `local-media:///fixture-${i}.png`)
            )
          }
        })
      )
    })
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    )
    expect(fixture.materializeInternalImageDragAttachment).not.toHaveBeenCalled()
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(pendingAttachments()).toEqual([])
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
  })

  it.each([false, true])(
    'rejects a 51-image manifest before saving the selected blob and preserves the draft (stream=%s)',
    async (stream) => {
      configure()
      fixture.useRealCompletion = true
      fixture.supportsStreaming.mockReturnValue(stream)
      // A bundle MAIN registered for this conversation. manifestUrl is MAIN's own snapshot
      // manifest, which verify returns; the descriptor's manifest URL is never read.
      const manifestUrl = 'local-media:///fixture/owned.manifest.json'
      const reports = createReportBundleRegistryFixture()
      const primary: ChatAttachment = reports.register(
        {
          type: 'file',
          url: 'data:text/plain;base64,cmVwb3J0',
          fileName: 'report.txt',
          reportBundleRole: 'primary-report',
          reportBundleManifestUrl: 'local-media:///fixture/descriptor-only.manifest.json'
        },
        'fixture-session',
        { manifestUrl, imageCount: 50 }
      )
      await renderPage(makeSession([image(1), primary]))
      await settleInitialDraftPersistence()
      const draftBefore = pendingAttachments()
      const dispatch = vi.fn(async () => ({ content: 'unexpected dispatch' }))
      const dispatchStream = vi.fn(async () => undefined)
      const remoteFetch = vi.fn()
      const materializeForRequest = vi.fn()
      fixture.requestApi = {
        svcManagedMedia: { materializeForRequest },
        svcLLMProxy: { chat: dispatch, chatStream: dispatchStream, remoteFetch },
        svcReportBundles: reports.svcReportBundles
      }
      fixture.fetch.mockImplementation(async (url: string) => {
        if (String(url) === manifestUrl) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                version: 1,
                bundleId: 'owned-fixture',
                title: 'owned-fixture',
                entries: Array.from({ length: 50 }, (_, index) => ({
                  role: 'report-image',
                  fileName: `owned-${index}.png`,
                  sourceUrl: `local-media:///fixture/owned-${index}.png`
                }))
              })
          }
        }
        if (String(url).startsWith('blob:')) {
          return pngResponse('fixture')
        }
        throw new Error(`Unexpected fixture read: ${String(url)}`)
      })
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() =>
        expect(fixture.notifyError).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
      )
      expect(fixture.fetch.mock.calls.map(([url]) => String(url))).toEqual([manifestUrl])
      expect(reports.verify).toHaveBeenCalledOnce()
      expect(reports.verify).toHaveBeenCalledWith({
        conversation: { conversationId: 'fixture-session', storageScope: scope },
        items: [{ binding: primary.reportBundleBinding, primaryUrl: primary.url }]
      })
      expect(fixture.saveImageToDir).not.toHaveBeenCalled()
      expect(materializeForRequest).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(dispatchStream).not.toHaveBeenCalled()
      expect(remoteFetch).not.toHaveBeenCalled()
      expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
      expect(pendingAttachments()).toEqual(draftBefore)
      expect(currentSession().messages).toEqual([])
    }
  )

  it.each([false, true])(
    'refuses an unregistered 50-image report before any read, save or dispatch and preserves the draft (stream=%s)',
    async (stream) => {
      configure()
      fixture.useRealCompletion = true
      fixture.supportsStreaming.mockReturnValue(stream)
      const reports = createReportBundleRegistryFixture()
      const primary: ChatAttachment = {
        type: 'file',
        url: 'data:text/plain;base64,cmVwb3J0',
        fileName: 'report.txt',
        reportBundleRole: 'primary-report',
        reportBundleManifestUrl: 'local-media:///fixture/owned.manifest.json',
        reportBundleImageCount: 50
      }
      await renderPage(makeSession([image(1), primary]))
      await settleInitialDraftPersistence()
      const draftBefore = pendingAttachments()
      const dispatch = vi.fn(async () => ({ content: 'unexpected dispatch' }))
      const dispatchStream = vi.fn(async () => undefined)
      const remoteFetch = vi.fn()
      const materializeForRequest = vi.fn()
      fixture.requestApi = {
        svcManagedMedia: { materializeForRequest },
        svcLLMProxy: { chat: dispatch, chatStream: dispatchStream, remoteFetch },
        svcReportBundles: reports.svcReportBundles
      }
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() =>
        expect(fixture.notifyError).toHaveBeenCalledWith(UNVERIFIED_REPORT_BUNDLE_MESSAGE)
      )
      expect(fixture.fetch).not.toHaveBeenCalled()
      expect(reports.verify).not.toHaveBeenCalled()
      expect(fixture.saveImageToDir).not.toHaveBeenCalled()
      expect(materializeForRequest).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(dispatchStream).not.toHaveBeenCalled()
      expect(remoteFetch).not.toHaveBeenCalled()
      expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
      expect(pendingAttachments()).toEqual(draftBefore)
      expect(currentSession().messages).toEqual([])
    }
  )

  it('rejects 51 explicit images before video extraction, preserving the composer draft', async () => {
    configure()
    fixture.videoExpansionFrames = 2
    const attachments = [...Array.from({ length: 51 }, (_, index) => image(index)), video()]
    await renderPage(makeSession(attachments))
    await settleInitialDraftPersistence()
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    )
    expect(fixture.discoverVideoFrames).not.toHaveBeenCalled()
    expect(fixture.videoExpansionFrames).toBe(2)
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.saveImageToDir).not.toHaveBeenCalled()
    expect(fixture.materializeInternalImageDragAttachment).not.toHaveBeenCalled()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.stream).not.toHaveBeenCalled()
    expect(currentSession().messages).toEqual([])
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
    expect(pendingAttachments()).toHaveLength(52)
  })

  it('keeps the draft and rejects 50 visible images plus one hidden overview at the conservative count boundary', async () => {
    configure()
    const attachments = [
      ...Array.from({ length: 50 }, (_, index) =>
        image(index, `https://fixture.invalid/${index}.png`)
      ),
      {
        ...image(50, 'data:image/png;base64,YWJj'),
        fileName: 'canvas-selection.png',
        hiddenFromChatView: true
      }
    ]
    await renderPage(makeSession(attachments))
    await settleInitialDraftPersistence()
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    )
    expect(fixture.request).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
    expect(pendingAttachments()).toHaveLength(51)
    fireEvent.click(screen.getByTestId('mock-remove-50'))
    await waitFor(() => expect(pendingAttachments()).toHaveLength(50))
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
  })

  it('keeps an over-limit canvas overview removable and preserves the draft across incoming event mocks', async () => {
    configure()
    // The inline overview is imported into managed media at the hand-off.
    fixture.importDataUrl.mockImplementation(
      async ({ originalFileName }: { originalFileName: string }) => ({
        reference: {
          version: 1,
          kind: 'managed',
          relativePath: `user-output/chat-attachments/originals/ab/${'ab'.repeat(32)}.png`,
          sha256: 'ab'.repeat(32),
          sizeBytes: 3,
          mimeType: 'image/png',
          originalFileName
        },
        localMediaUrl: `local-media:///fixture-media/${'ab'.repeat(32)}.png`
      })
    )
    await renderPage(makeSession([], 'canvas overview'))
    await settleInitialDraftPersistence()
    await act(async () => {
      for (let index = 0; index < 50; index += 1) {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: {
              targetScope: scope,
              text: '',
              attachment: image(index, `local-media:///owned-${index}.png`)
            }
          })
        )
      }
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            text: '',
            attachment: {
              ...image(50, 'data:image/png;base64,YWJj'),
              fileName: 'canvas-selection.png',
              hiddenFromChatView: true
            }
          }
        })
      )
    })
    await waitFor(() => expect(pendingAttachments()).toHaveLength(51))
    expect(pendingAttachments()[50]).toEqual(
      expect.objectContaining({
        url: `local-media:///fixture-media/${'ab'.repeat(32)}.png`,
        fileName: 'canvas-selection.png',
        hiddenFromChatView: true
      })
    )
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    )
    expect(fixture.request).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
    fireEvent.click(screen.getByTestId('mock-remove-50'))
    await waitFor(() => expect(pendingAttachments()).toHaveLength(50))
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
  })

  it('rejects 51 queued descriptors before resolving external attachments', async () => {
    configure()
    await renderPage(makeSession([], 'queued images'))
    await settleInitialDraftPersistence()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: scope,
            autoSend: true,
            requestId: 'queued-51-images',
            text: 'Analyze',
            attachments: Array.from({ length: 51 }, (_, index) =>
              image(index, `local-media:///owned-${index}.png`)
            )
          }
        })
      )
    })
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    )
    expect(fixture.materializeInternalImageDragAttachment).not.toHaveBeenCalled()
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.stream).not.toHaveBeenCalled()
    expect(currentSession().messages).toEqual([])
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
  })

  it('does not clear a busy composer when 51 images cannot be queued', async () => {
    configure()
    let finish!: (value: { content: string }) => void
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await renderPage(makeSession([], 'busy send'))
    await settleInitialDraftPersistence()
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'new unsent draft' }
    })
    // The production composer owns its local value; this minimal mock is controlled
    // by ChatPage's debounced value, so wait for that commit before another render.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(screen.getByTestId('composer-input')).toHaveValue('new unsent draft')
    // Separate events can still accumulate an over-limit draft; keep the
    // original busy-queue and draft-preservation assertions meaningful.
    await act(async () => {
      for (let index = 0; index < 51; index += 1) {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: {
              targetScope: scope,
              attachment: image(index, `https://fixture.invalid/${index}.png`)
            }
          })
        )
      }
    })
    await waitFor(() => expect(pendingAttachments()).toHaveLength(51))
    expect(screen.getByTestId('composer-input')).toHaveValue('new unsent draft')
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    )
    expect(screen.getByTestId('composer-input')).toHaveValue('new unsent draft')
    expect(pendingAttachments()).toHaveLength(51)
    expect(fixture.request).toHaveBeenCalledOnce()
    await act(async () => {
      finish({ content: 'fixture completed' })
    })
  })

  it('retains a queued composer draft when video-frame preflight later rejects it', async () => {
    configure(2)
    const activeRequest = Promise.withResolvers<{ content: string }>()
    fixture.request.mockImplementationOnce(() => activeRequest.promise)
    await renderPage(makeSession([], 'busy video draft'))
    await settleInitialDraftPersistence()
    try {
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
      const attachment = video()
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: { targetScope: scope, text: 'queued video text', attachment }
          })
        )
      })
      await waitFor(() => expect(pendingAttachments()).toEqual([attachment]))
      expect(screen.getByTestId('composer-input')).toHaveValue('queued video text')
      fixture.videoExpansionFrames = 3
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() =>
        expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('queued video text')
      )
      expect(screen.getByTestId('composer-input')).toHaveValue('')
      expect(pendingAttachments()).toEqual([])
      expect(fixture.request).toHaveBeenCalledOnce()
      await act(async () => activeRequest.resolve({ content: 'active response' }))
      await waitFor(() =>
        expect(fixture.notifyError).toHaveBeenCalledWith('Too many images; the limit is 2.')
      )
      expect(fixture.discoverVideoFrames).toHaveBeenCalledTimes(1)
      expect(fixture.request).toHaveBeenCalledOnce()
      expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('queued video text')
      await waitFor(() =>
        expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('未发送 · 已暂停')
      )
      expect(
        currentSession().messages.some((message) => message.content === 'queued video text')
      ).toBe(false)
      fireEvent.click(
        within(screen.getByTestId('chat-queue-item')).getByRole('button', {
          name: 'chat.queue_edit'
        })
      )
      expect(screen.getByTestId('composer-input')).toHaveValue('queued video text')
      expect(pendingAttachments()).toEqual([attachment])
      expect(screen.queryByTestId('chat-queue-item')).not.toBeInTheDocument()
      expect(fixture.request).toHaveBeenCalledOnce()
    } finally {
      activeRequest.resolve({ content: 'cleanup' })
    }
  })

  it('does not let a later queued message or a new draft overwrite the paused failed item', async () => {
    configure(2)
    const activeRequest = Promise.withResolvers<{ content: string }>()
    fixture.request.mockImplementationOnce(() => activeRequest.promise)
    await renderPage(makeSession([], 'busy queue order'))
    await settleInitialDraftPersistence()
    try {
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
      const attachment = video()
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: { targetScope: scope, text: 'first queued video', attachment }
          })
        )
      })
      await waitFor(() => expect(pendingAttachments()).toEqual([attachment]))
      fixture.videoExpansionFrames = 3
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(1))
      fireEvent.change(screen.getByTestId('composer-input'), {
        target: { value: 'second queued text' }
      })
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(2))
      fireEvent.change(screen.getByTestId('composer-input'), {
        target: { value: 'new unsent draft' }
      })
      await waitFor(() =>
        expect(screen.getByTestId('composer-input')).toHaveValue('new unsent draft')
      )
      await act(async () => activeRequest.resolve({ content: 'active response' }))
      await waitFor(() =>
        expect(screen.getAllByTestId('chat-queue-item')[0]).toHaveTextContent('未发送 · 已暂停')
      )
      expect(screen.getAllByTestId('chat-queue-item')[0]).toHaveTextContent('first queued video')
      expect(screen.getAllByTestId('chat-queue-item')[1]).toHaveTextContent('second queued text')
      expect(
        within(screen.getAllByTestId('chat-queue-item')[0]).getByText(
          '编辑或移除此项后，后续排队消息可能继续发送。'
        )
      ).toBeVisible()
      expect(screen.getByTestId('composer-input')).toHaveValue('new unsent draft')
      fireEvent.click(
        within(screen.getAllByTestId('chat-queue-item')[0]).getByRole('button', {
          name: 'chat.queue_edit'
        })
      )
      expect(screen.getByTestId('composer-input')).toHaveValue('new unsent draft')
      expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(2)
      expect(
        within(screen.getAllByTestId('chat-queue-item')[0]).getByText(
          '编辑或移除此项后，后续排队消息可能继续发送。'
        )
      ).toBeVisible()
      expect(fixture.request).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByTestId('composer-send'))
      expect(fixture.notifyWarning).toHaveBeenCalledWith('chat.queue_paused_first')
      expect(screen.getByTestId('composer-input')).toHaveValue('new unsent draft')
      expect(fixture.request).toHaveBeenCalledOnce()
      expect(
        currentSession().messages.some((message) => message.content === 'first queued video')
      ).toBe(false)
      expect(
        currentSession().messages.some((message) => message.content === 'second queued text')
      ).toBe(false)
    } finally {
      activeRequest.resolve({ content: 'cleanup' })
    }
  })

  it('warns before editing or removing a paused head when later queued turns may resume', async () => {
    configure(2)
    const activeRequest = Promise.withResolvers<{ content: string }>()
    fixture.request.mockImplementationOnce(() => activeRequest.promise)
    await renderPage(makeSession([], 'busy queue notice'))
    await settleInitialDraftPersistence()
    try {
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
      const attachment = video()
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: { targetScope: scope, text: 'first paused video', attachment }
          })
        )
      })
      await waitFor(() => expect(pendingAttachments()).toEqual([attachment]))
      fixture.videoExpansionFrames = 3
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(1))
      fireEvent.change(screen.getByTestId('composer-input'), {
        target: { value: 'later queued text' }
      })
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(2))
      const warning = '编辑或移除此项后，后续排队消息可能继续发送。'
      expect(screen.queryByText(warning)).not.toBeInTheDocument()
      await act(async () => activeRequest.resolve({ content: 'active response' }))
      await waitFor(() =>
        expect(screen.getAllByTestId('chat-queue-item')[0]).toHaveTextContent('未发送 · 已暂停')
      )
      const [first, second] = screen.getAllByTestId('chat-queue-item')
      expect(within(first).getByText(warning)).toBeVisible()
      expect(
        within(first).getByRole('button', { name: 'chat.queue_edit' })
      ).toHaveAccessibleDescription(warning)
      expect(
        within(first).getByRole('button', { name: 'chat.queue_remove' })
      ).toHaveAccessibleDescription(warning)
      expect(within(second).queryByText(warning)).not.toBeInTheDocument()
      expect(fixture.request).toHaveBeenCalledOnce()
      fireEvent.click(within(second).getByRole('button', { name: 'chat.queue_remove' }))
      expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(1)
      expect(
        within(screen.getByTestId('chat-queue-item')).queryByText(warning)
      ).not.toBeInTheDocument()
      expect(fixture.request).toHaveBeenCalledOnce()
    } finally {
      activeRequest.resolve({ content: 'cleanup' })
    }
  })

  it('does not send a queued turn when the page unmounts during video preparation', async () => {
    configure(2)
    const activeRequest = Promise.withResolvers<{ content: string }>()
    const expansion = Promise.withResolvers<{ content: string; attachments: ChatAttachment[] }>()
    fixture.request.mockImplementationOnce(() => activeRequest.promise)
    fixture.videoExpansionOverride = vi.fn(() => expansion.promise)
    await renderPage(makeSession([], 'active before queued video'))
    await settleInitialDraftPersistence()
    try {
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
      const attachment = video()
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: { targetScope: scope, text: 'queued before unmount', attachment }
          })
        )
      })
      await waitFor(() => expect(pendingAttachments()).toEqual([attachment]))
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() =>
        expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('queued before unmount')
      )
      await act(async () => activeRequest.resolve({ content: 'active response' }))
      await waitFor(() => expect(fixture.videoExpansionOverride).toHaveBeenCalledOnce())
      const item = screen.getByTestId('chat-queue-item')
      expect(item).toHaveTextContent('正在准备')
      expect(within(item).getByRole('button', { name: 'chat.queue_remove' })).toBeDisabled()
      expect(
        within(item).queryByRole('button', { name: 'chat.queue_edit' })
      ).not.toBeInTheDocument()
      cleanup()
      await act(async () =>
        expansion.resolve({ content: 'queued before unmount', attachments: [attachment] })
      )
      expect(fixture.request).toHaveBeenCalledOnce()
    } finally {
      activeRequest.resolve({ content: 'cleanup' })
      expansion.resolve({ content: 'cleanup', attachments: [] })
    }
  })

  it('does not replay a queued user turn after the model request fails', async () => {
    configure(2)
    const activeRequest = Promise.withResolvers<{ content: string }>()
    const queuedRequest = Promise.withResolvers<{ content: string }>()
    fixture.request.mockImplementationOnce(() => activeRequest.promise)
    fixture.request.mockImplementationOnce(() => queuedRequest.promise)
    await renderPage(makeSession([], 'running first'))
    await settleInitialDraftPersistence()
    try {
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
      fireEvent.change(screen.getByTestId('composer-input'), {
        target: { value: 'queued before provider error' }
      })
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() =>
        expect(screen.getByTestId('chat-queue-item')).toHaveTextContent(
          'queued before provider error'
        )
      )
      await act(async () => activeRequest.resolve({ content: 'first response' }))
      await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
      await act(async () => queuedRequest.reject(new Error('synthetic provider error')))
      await waitFor(() => expect(screen.queryByTestId('chat-queue-item')).not.toBeInTheDocument())
      expect(
        currentSession().messages.filter(
          (message) => message.content === 'queued before provider error'
        )
      ).toHaveLength(1)
      expect(fixture.request).toHaveBeenCalledTimes(2)
    } finally {
      activeRequest.resolve({ content: 'cleanup' })
      queuedRequest.resolve({ content: 'cleanup' })
    }
  })

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
    // Every incoming attachment now goes through the crop materializer, which leaves
    // a non-image (and any blob: URL) unchanged; the blob video is still never read.
    { label: 'accessible URL', url: 'https://fixture.invalid/video.mp4', materializes: true },
    { label: 'blob URL', url: 'blob:fixture-video', materializes: true }
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
  it('persists a batch sequentially without changing original bytes, order or attachment metadata', async () => {
    configure()
    const original = [image(1), { ...image(2), sourceWidth: 128, sourceHeight: 64 }, image(3)]
    const originalSnapshot = JSON.stringify(original)
    await renderPage(makeSession(original))
    await settleInitialDraftPersistence()
    const selected = pendingAttachments()
    const selectedUrls = selected.map((attachment) => attachment.url)

    let firstSaveStarted = false
    const firstSaveRelease = Promise.withResolvers<void>()
    fixture.fetch.mockImplementation(async (url: string) => pngResponse(`bytes:${url}`))
    fixture.saveImageToDir.mockImplementation(
      async ({ data, fileName }: { data: Uint8Array; fileName: string }) => {
        if (pngMarker(data) === `bytes:${selectedUrls[0]}`) {
          firstSaveStarted = true
          await firstSaveRelease.promise
        }
        return { savedPath: `C:/fixture/${fileName}` }
      }
    )
    try {
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(firstSaveStarted).toBe(true))
      expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual([selectedUrls[0]])
      expect(fixture.saveImageToDir).toHaveBeenCalledTimes(1)
      expect(fixture.request).not.toHaveBeenCalled()
    } finally {
      firstSaveRelease.resolve()
    }

    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual(selectedUrls)
    expect(fixture.saveImageToDir.mock.calls.map(([value]) => pngMarker(value.data))).toEqual(
      selectedUrls.map((url) => `bytes:${url}`)
    )
    const sent = fixture.request.mock.calls[0][0].messages.find(
      (entry: { role: string }) => entry.role === 'user'
    )
    expect(sent.attachments.map((attachment: ChatAttachment) => attachment.fileName)).toEqual([
      'image-1.png',
      'image-2.png',
      'image-3.png'
    ])
    expect(sent.attachments[1]).toEqual(
      expect.objectContaining({ sourceWidth: 128, sourceHeight: 64 })
    )
    expect(
      sent.attachments.every((attachment: ChatAttachment) =>
        attachment.url.startsWith('file://C:/fixture/')
      )
    ).toBe(true)
    expect(new Set(sent.attachments.map((attachment: ChatAttachment) => attachment.url)).size).toBe(
      3
    )
    expect(JSON.stringify(original)).toBe(originalSnapshot)
  })

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
    // Ordinary multimodal chat keeps all references in one request. Only
    // explicitly per-attachment skills may probe and split attachment batches.
    expect(fixture.batch).not.toHaveBeenCalled()
    expect(fixture.request).toHaveBeenCalledTimes(1)
    const sentUserMessage = fixture.request.mock.calls[0][0].messages.find(
      (message: { role: string }) => message.role === 'user'
    )
    expect(sentUserMessage.attachments).toHaveLength(4)
    expect(
      sentUserMessage.attachments.filter(
        (attachment: ChatAttachment) => attachment.type === 'image'
      )
    ).toHaveLength(3)
    expect(
      sentUserMessage.attachments.filter(
        (attachment: ChatAttachment) => attachment.type === 'video'
      )
    ).toHaveLength(1)
    expect(fixture.readTextFile).not.toHaveBeenCalled()
    expect(fixture.notifyError).not.toHaveBeenCalled()
    expect(
      currentSession().messages.some(
        (message) => message.role === 'user' && message.attachments?.length === 4
      )
    ).toBe(true)
  })
})

describe('ChatPage request image size preflight', () => {
  const managedImage = (sizeBytes: number): ChatAttachment => {
    const sha256 = 'b'.repeat(64)
    return {
      type: 'image',
      url: `local-media:///fixture/${sha256}.png`,
      fileName: 'large.png',
      mimeType: 'image/png',
      media: {
        version: 1,
        kind: 'managed',
        relativePath: `originals/bb/${sha256}.png`,
        sha256,
        sizeBytes,
        mimeType: 'image/png',
        originalFileName: 'large.png'
      }
    } as ChatAttachment
  }
  const configureProvider = (provider: 'gemini' | 'openai'): void => {
    configure()
    fixture.config!.llm_config.api_profiles = [
      {
        ...fixture.config!.llm_config.api_profiles[0],
        provider,
        ...(provider === 'gemini' ? { api_mode: undefined } : {})
      } as LLMAPIProfile
    ]
    fixture.profiles = fixture.config!.llm_config.api_profiles
  }

  it('refuses a new message whose images exceed the provider JSON budget and keeps the draft', async () => {
    configureProvider('gemini')
    const attachment = managedImage(22 * 1024 * 1024)
    await renderPage(makeSession([attachment]))
    await settleInitialDraftPersistence()
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.notifyError).toHaveBeenCalledOnce())
    expect(fixture.notifyError.mock.calls[0][0]).toBe(new ChatRequestImageBudgetError().message)
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.stream).not.toHaveBeenCalled()
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue(draftText)
    expect(pendingAttachments()).toEqual([attachment])
    expect(currentSession().messages).toEqual([])
  })

  it('sends the same message on the Responses route, whose limit is checked at the request entry', async () => {
    configureProvider('openai')
    await renderPage(makeSession([managedImage(22 * 1024 * 1024)]))
    await settleInitialDraftPersistence()
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
    expect(fixture.notifyError).not.toHaveBeenCalled()
  })

  it('shows the size notice when the file chooser returns a file above the limit', async () => {
    configure()
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    await renderPage(makeSession([]))
    await settleInitialDraftPersistence()
    fixture.fileTooLarge = true
    fixture.selectFile.mockResolvedValue(new File(['x'], 'huge.png', { type: 'image/png' }))
    fireEvent.click(screen.getByTestId('composer-upload'))
    await waitFor(() =>
      expect(fixture.notifyError).toHaveBeenCalledWith('chat.incoming_image_too_large')
    )
    expect(alert).not.toHaveBeenCalled()
    expect(pendingAttachments()).toEqual([])
  })
})

describe('ChatPage image review dispatch projection', () => {
  const route = {
    channel: 'canvas',
    scopeType: 'thread',
    scopeId: 'review-project',
    threadId: 'review-thread'
  } as const
  const prompt = '你能自己找出问题吗'
  const reply = '海报上方的标题被裁掉了一部分。'
  const reference = { sha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 67 }
  const generated: ChatAttachment = {
    type: 'image',
    // A previously saved display URL must not be read to review the managed output.
    url: 'file:///fixture/generated.png',
    media: {
      ...reference,
      version: 1,
      kind: 'managed',
      relativePath: `originals/aa/${reference.sha256}.png`,
      originalFileName: 'generated.png'
    }
  }

  const sendFromCanvas = async (text = prompt, profileId = 'fixture-profile') => {
    const session = makeSession([], 'image review flow')
    session.profileId = profileId
    session.messages = [
      { role: 'user', content: '画一张海报。' },
      { role: 'assistant', content: '这是海报。', attachments: [generated] }
    ]
    await renderPage(session, route)
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
    fireEvent.click(screen.getByTestId('composer-send'))
  }

  it('sends the previous assistant image as a hash-only review hint from the canvas composer', async () => {
    configure()
    fixture.profiles[0].model_use = 'chat'
    expect(hasThreadImageTool(fixture.config!, 'fixture-profile')).toBe(false)
    fixture.useRealCompletion = true
    const chat = vi.fn(async (_request: LLMChatReq) => ({
      content: reply,
      finishReason: 'stop' as const
    }))
    const materializeForRequest = vi.fn()
    const remoteFetch = vi.fn()
    const ipc = {
      svcManagedMedia: { materializeForRequest },
      svcLLMProxy: { chat, remoteFetch, chatStream: vi.fn() }
    }
    vi.stubGlobal('api', ipc)

    await sendFromCanvas()
    await waitFor(() =>
      expect(currentSession().messages.at(-1)).toMatchObject({ role: 'assistant', content: reply })
    )

    expect(chat).toHaveBeenCalledOnce()
    const [[request]] = chat.mock.calls
    expect(request.route).toMatchObject(route)
    expect(request.threadImageReview).toBe('last-output')
    expect(request.threadImageHistory).toStrictEqual([reference])
    expect(request.messages).toEqual([{ role: 'user', content: prompt }])
    expect(request.imageRequest).toBeUndefined()
    expect(request.imageGenerationOptions?.enabled).not.toBe(true)
    expect(materializeForRequest).not.toHaveBeenCalled()
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(remoteFetch).not.toHaveBeenCalled()
    expect(fixture.readTextFile).not.toHaveBeenCalled()
    expect(fixture.saveImageToDir).not.toHaveBeenCalled()
  })

  it.each(['生成一张新的海报', '把上一张海报的背景改成蓝色'])(
    'keeps explicit creation and edits on the Images profile: %s',
    async (text) => {
      configure()
      Object.assign(fixture.profiles[0], { api_mode: 'images', model_use: 'image' })
      await sendFromCanvas(text)
      await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
      const [[request]] = fixture.request.mock.calls
      expect(request.profileId).toBe('fixture-profile')
      expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: text })
      expect(request.threadImageReview).toBeUndefined()
      expect(fixture.notifyWarning).not.toHaveBeenCalled()
    }
  )

  it.each([
    { label: 'Images endpoint', api_mode: 'images', model_use: 'chat' },
    { label: 'image generation', api_mode: 'responses', model_use: 'image' },
    { label: 'video generation', api_mode: 'responses', model_use: 'video' },
    { label: 'Hunyuan 3D', api_mode: 'responses', model_use: 'chat' }
  ] as const)(
    'declines review on a $label profile without reading or dispatching',
    async ({ label, api_mode, model_use }) => {
      configure()
      const id = label === 'Hunyuan 3D' ? 'hunyuan3d-pro' : 'fixture-profile'
      Object.assign(fixture.profiles[0], { id, api_mode, model_use })
      fixture.useRealCompletion = true
      const chat = vi.fn(),
        chatStream = vi.fn(),
        remoteFetch = vi.fn(),
        materializeForRequest = vi.fn()
      vi.stubGlobal('api', {
        svcLLMProxy: { chat, chatStream, remoteFetch },
        svcManagedMedia: { materializeForRequest }
      })
      await sendFromCanvas(prompt, id)
      await waitFor(() =>
        expect(fixture.notifyWarning).toHaveBeenCalledWith(
          'Choose a chat model that accepts images to review the previous image. No generation request was sent.'
        )
      )
      expect(chat).not.toHaveBeenCalled()
      expect(chatStream).not.toHaveBeenCalled()
      expect(remoteFetch).not.toHaveBeenCalled()
      expect(materializeForRequest).not.toHaveBeenCalled()
      expect(fixture.fetch).not.toHaveBeenCalled()
      expect(fixture.readTextFile).not.toHaveBeenCalled()
      expect(fixture.saveImageToDir).not.toHaveBeenCalled()
      expect(currentSession().messages).toHaveLength(2)
    }
  )
})
