import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { useEffect, useMemo } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type {
  ImportManagedMediaDataUrlReq,
  ImportManagedMediaResp
} from '@shared/api/svcManagedMedia'
import type { ChatSession } from './chatStorage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import { CHAT_ATTACHMENT_STORAGE } from './chatManagedMediaAttachments'
import ChatPage from './ChatPage'

type DropReadResult = { files: File[]; failedUrls: string[] }
type DropReadOptions = { isCurrent?: () => boolean }

const fixture = vi.hoisted(() => ({
  config: null as Config | null,
  sessions: [] as ChatSession[],
  getDroppedLocalImageFiles: vi.fn(),
  importDataUrl: vi.fn(),
  importFile: vi.fn(),
  fileToBlobUrl: vi.fn(),
  receiveEditingAttachment: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  request: vi.fn(),
  stream: vi.fn(),
  fetch: vi.fn()
}))

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const saveSession = (session: ChatSession): void => {
  const index = fixture.sessions.findIndex((candidate) => candidate.id === session.id)
  if (index < 0) fixture.sessions.push(clone(session))
  else fixture.sessions[index] = clone(session)
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options?: Record<string, unknown>) =>
      ((options?.defaultValue as string | undefined) || key).replace(
        /{{(\w+)}}/g,
        (_match, name: string) => String(options?.[name] ?? '')
      )
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
vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({
    availableProfiles: [{ id: 'fixture-profile', model_name: 'Fixture', model_use: 'chat' }],
    remoteProfiles: []
  })
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcFs: {},
    svcLLMProxy: { signHy3DModel: vi.fn() },
    svcManagedMedia: {
      importDataUrl: fixture.importDataUrl,
      importFile: fixture.importFile
    }
  })
}))
vi.mock('@renderer/utils/fileUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/utils/fileUtils')>()),
  fileToBlobUrl: (file: File) => fixture.fileToBlobUrl(file)
}))
vi.mock('@renderer/utils/droppedImageUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/utils/droppedImageUtils')>()),
  getDroppedLocalImageFiles: (...args: unknown[]) => fixture.getDroppedLocalImageFiles(...args)
}))
vi.mock('./chatStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatStorage')>()),
  loadAllSessions: async () => clone(fixture.sessions),
  saveSessionToDB: async (session: ChatSession) => saveSession(session),
  debouncedSaveSessions: (
    sessions: ChatSession[],
    _delay: number,
    _scope: string,
    options?: { onSuccess?: (sessions: ChatSession[]) => void }
  ) => {
    sessions.forEach(saveSession)
    options?.onSuccess?.(sessions)
  },
  cancelDebouncedSessionSave: vi.fn(),
  migrateFromLocalStorage: async () => null
}))
vi.mock('./chatRequestUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatRequestUtils')>()),
  requestChatCompletion: fixture.request,
  requestChatCompletionStream: fixture.stream
}))

vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
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
  default: ({
    inputValue,
    onInputChange,
    pendingAttachments
  }: {
    inputValue: string
    onInputChange: (value: string) => void
    pendingAttachments: ChatAttachment[]
  }) => (
    <div>
      <textarea
        data-testid="composer-input"
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <pre data-testid="pending-attachments">{JSON.stringify(pendingAttachments)}</pre>
    </div>
  )
}))
vi.mock('./components/ChatMessageList', () => ({
  default: function MessageList({
    currentSession,
    editingMessageIndex,
    editingContent,
    onSetEditingIndex,
    onSetEditingContent,
    onRegisterEditingAttachmentReceiver
  }: {
    currentSession?: ChatSession
    editingMessageIndex: number | null
    editingContent: string
    onSetEditingIndex: (index: number | null) => void
    onSetEditingContent: (value: string) => void
    onRegisterEditingAttachmentReceiver: (
      receiver: ((attachment: ChatAttachment) => void) | null
    ) => void
  }) {
    const sessionId = currentSession?.id
    const receiver = useMemo(
      () => (attachment: ChatAttachment) =>
        fixture.receiveEditingAttachment({ sessionId, index: editingMessageIndex, attachment }),
      [sessionId, editingMessageIndex]
    )
    useEffect(() => {
      onRegisterEditingAttachmentReceiver(editingMessageIndex === null ? null : receiver)
      return () => onRegisterEditingAttachmentReceiver(null)
    }, [editingMessageIndex, receiver, onRegisterEditingAttachmentReceiver])
    return (
      <div>
        <pre data-testid="session-state">{JSON.stringify(currentSession ?? null)}</pre>
        <pre data-testid="edit-content">{editingContent}</pre>
        <span data-testid="edit-index">{String(editingMessageIndex)}</span>
        {[0, 1].map((index) => (
          <button
            key={index}
            onClick={() => {
              onSetEditingIndex(index)
              onSetEditingContent(`Edit draft ${index}`)
            }}
          >
            Edit {index}
          </button>
        ))}
        <button
          onClick={() => {
            onSetEditingIndex(null)
            onSetEditingContent('')
          }}
        >
          Cancel edit
        </button>
      </div>
    )
  }
}))

const scope = 'external-image-drop'
const draft = 'Keep my existing draft.'
const firstUrl = 'file:///C:/Feishu/Cache/first%20image.png'
const secondUrl = 'file:///C:/Feishu/Cache/second.jpg'
const theme = createTheme()

const imageFile = (name = 'first image.png'): File =>
  new File([`synthetic image bytes for ${name}`], name, {
    type: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'
  })

const managedResult = (name: string): ImportManagedMediaResp => ({
  localMediaUrl: `local-media://user-output/chat-attachments/${encodeURIComponent(name)}`,
  reference: {
    version: 1,
    kind: 'managed',
    relativePath: `user-output/chat-attachments/${name}`,
    originalFileName: name,
    status: 'ready'
  }
})

const existingAttachment: ChatAttachment = {
  type: 'image',
  fileName: 'existing.png',
  mimeType: 'image/png',
  url: managedResult('existing.png').localMediaUrl,
  media: managedResult('existing.png').reference
}

const makeSession = (id: string, attachments: ChatAttachment[] = []): ChatSession => ({
  id,
  title: id,
  storageScope: scope,
  profileId: 'fixture-profile',
  messages: [
    { role: 'user', content: 'Original message 0' },
    { role: 'user', content: 'Original message 1' }
  ],
  draft: {
    inputValue: id === 'session-a' ? draft : 'Other session draft.',
    pendingAttachments: attachments,
    pendingHiddenContext: '',
    updatedAt: Date.now()
  }
})

const createDataTransfer = (data: Record<string, string>, files: File[] = []): DataTransfer =>
  ({
    getData: (type: string) => data[type] || '',
    files: Object.assign([...files], { item: (index: number) => files[index] || null }),
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => null
    })),
    types: [...Object.keys(data), ...(files.length ? ['Files'] : [])],
    dropEffect: 'none'
  }) as unknown as DataTransfer

const pendingAttachments = (): ChatAttachment[] =>
  JSON.parse(screen.getByTestId('pending-attachments').textContent || '[]') as ChatAttachment[]
const currentSession = (): ChatSession =>
  JSON.parse(screen.getByTestId('session-state').textContent || 'null') as ChatSession

const renderPage = async (attachments: ChatAttachment[] = []) => {
  fixture.sessions = [makeSession('session-a', attachments), makeSession('session-b')]
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'session-a')
  const view = render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ChatPage storageScope={scope} />
      </MemoryRouter>
    </ThemeProvider>
  )
  await waitFor(() => expect(currentSession()?.id).toBe('session-a'))
  await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveValue(draft))
  await waitFor(() => expect(pendingAttachments()).toHaveLength(attachments.length))
  return view
}

const drop = (data: Record<string, string> = { 'text/plain': firstUrl }, files: File[] = []) =>
  fireEvent.drop(screen.getByTestId('composer-input'), {
    dataTransfer: createDataTransfer(data, files)
  })

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const selectSession = async (id: string): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: `Open ${id}` }))
  await waitFor(() => expect(currentSession().id).toBe(id))
}

beforeEach(() => {
  vi.resetAllMocks()
  fixture.config = clone(DEFAULT_CONFIG)
  fixture.config.use_remote_llm = false
  fixture.sessions = []
  fixture.getDroppedLocalImageFiles.mockResolvedValue({ files: [], failedUrls: [] })
  fixture.importDataUrl.mockImplementation(
    async ({ originalFileName }: ImportManagedMediaDataUrlReq) => managedResult(originalFileName)
  )
  fixture.fileToBlobUrl.mockImplementation((file: File) => `blob:fixture-${file.name}`)
  fixture.fetch.mockRejectedValue(new Error('Unexpected network access in drop regression'))
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('fetch', fixture.fetch)
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 640
      naturalHeight = 480
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_url: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
  )
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.unstubAllGlobals()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.stream).not.toHaveBeenCalled()
  expect(fixture.fetch).not.toHaveBeenCalled()
})

describe('ChatPage external local image drop', () => {
  it.each(['text/plain', 'text/uri-list', 'text/html'])(
    'imports multiple %s images as durable attachments without replacing the draft',
    async (flavor) => {
      const files = [imageFile(), imageFile('second.jpg')]
      fixture.getDroppedLocalImageFiles.mockResolvedValue({ files, failedUrls: [] })
      await renderPage([existingAttachment])

      drop({
        [flavor]:
          flavor === 'text/html'
            ? `<img src="${firstUrl}"><img src="${secondUrl}">`
            : `${firstUrl}\r\n${secondUrl}`
      })

      await waitFor(() => expect(pendingAttachments()).toHaveLength(3))
      expect(fixture.getDroppedLocalImageFiles).toHaveBeenCalledTimes(1)
      expect(fixture.getDroppedLocalImageFiles).toHaveBeenCalledWith(
        expect.objectContaining({ fileUrls: [firstUrl, secondUrl] }),
        expect.objectContaining({ isCurrent: expect.any(Function) })
      )
      expect(fixture.importDataUrl).toHaveBeenCalledTimes(2)
      expect(fixture.importFile).not.toHaveBeenCalled()
      for (const [index, file] of files.entries()) {
        expect(fixture.fileToBlobUrl).toHaveBeenNthCalledWith(index + 1, file)
        expect(fixture.importDataUrl).toHaveBeenNthCalledWith(index + 1, {
          dataUrl: expect.stringMatching(/^data:image\/(?:png|jpeg);base64,/),
          originalFileName: file.name,
          storage: CHAT_ATTACHMENT_STORAGE
        })
        expect(pendingAttachments()[index + 1]).toMatchObject({
          type: 'image',
          fileName: file.name,
          url: managedResult(file.name).localMediaUrl,
          media: managedResult(file.name).reference,
          sourceWidth: 640,
          sourceHeight: 480
        })
      }
      expect(pendingAttachments()[0]).toEqual(existingAttachment)
      expect(screen.getByTestId('composer-input')).toHaveValue(draft)
      expect(fixture.notifyError).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(
          fixture.sessions.find((session) => session.id === 'session-a')?.draft?.pendingAttachments
        ).toHaveLength(3)
      )
      expect(JSON.stringify(fixture.sessions)).not.toContain('file:///')
    }
  )

  it('retains existing draft and dropped body text but never inserts the local file URL', async () => {
    fixture.getDroppedLocalImageFiles.mockResolvedValue({ files: [imageFile()], failedUrls: [] })
    await renderPage()

    drop({ 'text/plain': `Please compare the colors.\n${firstUrl}\nKeep the composition.` })

    await waitFor(() => expect(pendingAttachments()).toHaveLength(1))
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    expect(input.value).toContain(draft)
    expect(input.value).toContain('Please compare the colors.')
    expect(input.value).toContain('Keep the composition.')
    expect(input.value).not.toContain('file:///')
  })

  it.each(['image/png', '', 'application/octet-stream'])(
    'uses native File payloads (%s MIME) instead of importing duplicate URI flavors',
    async (type) => {
      const file = new File(['synthetic native image'], 'native.png', { type })
      await renderPage()

      drop({ 'text/plain': firstUrl, 'text/uri-list': firstUrl }, [file])

      await waitFor(() => expect(pendingAttachments()).toHaveLength(1))
      expect(fixture.getDroppedLocalImageFiles).not.toHaveBeenCalled()
      expect(fixture.fileToBlobUrl).toHaveBeenCalledWith(file)
      expect(pendingAttachments()[0]).toMatchObject({ type: 'image', fileName: 'native.png' })
      expect(fixture.importDataUrl).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('composer-input')).toHaveValue(draft)
    }
  )

  it('retains sanitized body text with a native File without reading its duplicate URI', async () => {
    await renderPage()

    drop({ 'text/plain': `Compare this native image.\n${firstUrl}` }, [imageFile('native.png')])

    await waitFor(() => expect(pendingAttachments()).toHaveLength(1))
    expect(fixture.getDroppedLocalImageFiles).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue(
      `${draft}\n\nCompare this native image.`
    )
    expect(fixture.importDataUrl).toHaveBeenCalledTimes(1)
  })

  it('reports an unreadable image while retaining successful images and draft text', async () => {
    fixture.getDroppedLocalImageFiles.mockResolvedValue({
      files: [imageFile()],
      failedUrls: [secondUrl]
    })
    await renderPage([existingAttachment])

    drop({ 'text/uri-list': `${firstUrl}\n${secondUrl}` })

    await waitFor(() => expect(pendingAttachments()).toHaveLength(2))
    expect(fixture.notifyError).toHaveBeenCalledWith(expect.stringContaining('second.jpg'))
    expect(screen.getByTestId('composer-input')).toHaveValue(draft)
    expect(pendingAttachments()[0]).toEqual(existingAttachment)
  })

  it('notifies on a failed local-image read without attaching a URL or changing the draft', async () => {
    fixture.getDroppedLocalImageFiles.mockRejectedValue(new Error('Expired drop permission'))
    await renderPage([existingAttachment])

    drop()

    await waitFor(() => expect(fixture.notifyError).toHaveBeenCalled())
    expect(pendingAttachments()).toEqual([existingAttachment])
    expect(screen.getByTestId('composer-input')).toHaveValue(draft)
    expect(fixture.importDataUrl).not.toHaveBeenCalled()
  })

  it('reports a managed import failure without leaving a temporary URL attachment', async () => {
    fixture.getDroppedLocalImageFiles.mockResolvedValue({ files: [imageFile()], failedUrls: [] })
    fixture.importDataUrl.mockRejectedValue(new Error('Managed media storage is unavailable'))
    await renderPage([existingAttachment])

    drop()

    await waitFor(() => expect(fixture.notifyError).toHaveBeenCalled())
    expect(pendingAttachments()).toEqual([existingAttachment])
    expect(screen.getByTestId('composer-input')).toHaveValue(draft)
    expect(fixture.importFile).not.toHaveBeenCalled()
  })

  it('routes dropped images and body text to the active edit, not the bottom composer', async () => {
    fixture.getDroppedLocalImageFiles.mockResolvedValue({ files: [imageFile()], failedUrls: [] })
    await renderPage([existingAttachment])
    fireEvent.click(screen.getByRole('button', { name: 'Edit 0' }))

    drop({ 'text/plain': `Add this reference.\n${firstUrl}` })

    await waitFor(() => expect(fixture.receiveEditingAttachment).toHaveBeenCalledTimes(1))
    expect(fixture.receiveEditingAttachment).toHaveBeenCalledWith({
      sessionId: 'session-a',
      index: 0,
      attachment: expect.objectContaining({
        fileName: 'first image.png',
        media: managedResult('first image.png').reference
      })
    })
    expect(screen.getByTestId('edit-content').textContent).toContain('Edit draft 0')
    expect(screen.getByTestId('edit-content').textContent).toContain('Add this reference.')
    expect(screen.getByTestId('edit-content').textContent).not.toContain('file:///')
    expect(screen.getByTestId('composer-input')).toHaveValue(draft)
    expect(pendingAttachments()).toEqual([existingAttachment])
  })

  it('continues importing other edit images when one managed import fails', async () => {
    fixture.getDroppedLocalImageFiles.mockResolvedValue({
      files: [imageFile(), imageFile('second.jpg')],
      failedUrls: []
    })
    fixture.importDataUrl.mockRejectedValueOnce(new Error('First image import failed'))
    await renderPage([existingAttachment])
    fireEvent.click(screen.getByRole('button', { name: 'Edit 0' }))

    drop({ 'text/uri-list': `${firstUrl}\n${secondUrl}` })

    await waitFor(() => expect(fixture.receiveEditingAttachment).toHaveBeenCalledTimes(1))
    expect(fixture.notifyError).toHaveBeenCalledWith(expect.stringContaining('first image.png'))
    expect(fixture.receiveEditingAttachment).toHaveBeenCalledWith({
      sessionId: 'session-a',
      index: 0,
      attachment: expect.objectContaining({ fileName: 'second.jpg', type: 'image' })
    })
    expect(pendingAttachments()).toEqual([existingAttachment])
    expect(screen.getByTestId('composer-input')).toHaveValue(draft)
  })

  it.each([
    ['read', false],
    ['read', true],
    ['import', false],
    ['import', true]
  ] as const)(
    'discards stale %s results after session switch (return to origin: %s)',
    async (phase, reopen) => {
      const readGate = deferred<DropReadResult>()
      const importGate = deferred<ImportManagedMediaResp>()
      fixture.getDroppedLocalImageFiles.mockImplementation(() =>
        phase === 'read'
          ? readGate.promise
          : Promise.resolve({ files: [imageFile()], failedUrls: [] })
      )
      fixture.importDataUrl.mockReturnValue(importGate.promise)
      await renderPage()
      drop({ 'text/plain': phase === 'read' ? `Do not leak this body.\n${firstUrl}` : firstUrl })
      await waitFor(() =>
        expect(
          phase === 'read' ? fixture.getDroppedLocalImageFiles : fixture.importDataUrl
        ).toHaveBeenCalledTimes(1)
      )
      const readOptions = fixture.getDroppedLocalImageFiles.mock.calls[0][1] as DropReadOptions

      await selectSession('session-b')
      if (reopen) await selectSession('session-a')
      expect(readOptions.isCurrent?.()).toBe(false)
      await act(async () => {
        readGate.resolve({ files: [imageFile()], failedUrls: [] })
        importGate.resolve(managedResult('first image.png'))
      })

      expect(pendingAttachments()).toEqual([])
      expect(screen.getByTestId('composer-input')).toHaveValue(
        reopen ? draft : 'Other session draft.'
      )
      expect(fixture.receiveEditingAttachment).not.toHaveBeenCalled()
      expect(fixture.notifyError).not.toHaveBeenCalled()
      if (phase === 'read') expect(fixture.importDataUrl).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['read', false],
    ['read', true],
    ['import', false],
    ['import', true]
  ] as const)(
    'discards stale %s results after edit-target change (reopen same edit: %s)',
    async (phase, reopen) => {
      const readGate = deferred<DropReadResult>()
      const importGate = deferred<ImportManagedMediaResp>()
      fixture.getDroppedLocalImageFiles.mockImplementation(() =>
        phase === 'read'
          ? readGate.promise
          : Promise.resolve({ files: [imageFile()], failedUrls: [] })
      )
      fixture.importDataUrl.mockReturnValue(importGate.promise)
      await renderPage()
      fireEvent.click(screen.getByRole('button', { name: 'Edit 0' }))
      drop({ 'text/plain': `Do not leak this body.\n${firstUrl}` })
      await waitFor(() =>
        expect(
          phase === 'read' ? fixture.getDroppedLocalImageFiles : fixture.importDataUrl
        ).toHaveBeenCalledTimes(1)
      )
      const readOptions = fixture.getDroppedLocalImageFiles.mock.calls[0][1] as DropReadOptions

      if (reopen) fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))
      fireEvent.click(screen.getByRole('button', { name: reopen ? 'Edit 0' : 'Edit 1' }))
      expect(readOptions.isCurrent?.()).toBe(false)
      await act(async () => {
        readGate.resolve({ files: [imageFile()], failedUrls: [] })
        importGate.resolve(managedResult('first image.png'))
      })

      expect(fixture.receiveEditingAttachment).not.toHaveBeenCalled()
      expect(pendingAttachments()).toEqual([])
      expect(screen.getByTestId('edit-content')).toHaveTextContent(
        reopen ? 'Edit draft 0' : 'Edit draft 1'
      )
      expect(screen.getByTestId('edit-content').textContent).not.toContain('Do not leak')
      expect(screen.getByTestId('composer-input')).toHaveValue(draft)
      expect(fixture.notifyError).not.toHaveBeenCalled()
      if (phase === 'read') expect(fixture.importDataUrl).not.toHaveBeenCalled()
    }
  )

  it('does not move a pending composer drop into an edit opened during the read', async () => {
    const gate = deferred<DropReadResult>()
    fixture.getDroppedLocalImageFiles.mockReturnValue(gate.promise)
    await renderPage()
    drop()
    await waitFor(() => expect(fixture.getDroppedLocalImageFiles).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Edit 0' }))
    await act(async () => gate.resolve({ files: [imageFile()], failedUrls: [] }))

    expect(pendingAttachments()).toEqual([])
    expect(fixture.receiveEditingAttachment).not.toHaveBeenCalled()
    expect(fixture.importDataUrl).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue(draft)
  })

  it('ignores a pending read and its failure notification after unmount', async () => {
    const gate = deferred<DropReadResult>()
    fixture.getDroppedLocalImageFiles.mockReturnValue(gate.promise)
    const view = await renderPage()
    drop()
    await waitFor(() => expect(fixture.getDroppedLocalImageFiles).toHaveBeenCalledTimes(1))
    const readOptions = fixture.getDroppedLocalImageFiles.mock.calls[0][1] as DropReadOptions

    view.unmount()
    expect(readOptions.isCurrent?.()).toBe(false)
    await act(async () => gate.resolve({ files: [imageFile()], failedUrls: [secondUrl] }))

    expect(fixture.importDataUrl).not.toHaveBeenCalled()
    expect(fixture.receiveEditingAttachment).not.toHaveBeenCalled()
    expect(fixture.notifyError).not.toHaveBeenCalled()
  })
})
