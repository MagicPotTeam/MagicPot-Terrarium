import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { useEffect, useMemo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type { ChatSession } from './chatStorage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

// Canvas -> Agent hand-off: every incoming image must reach composer, draft and
// session state as a managed attachment (local-media URL + media reference).
const f = vi.hoisted(() => ({
  config: null as Config | null,
  sessions: [] as ChatSession[],
  saved: [] as unknown[],
  edited: [] as ChatAttachment[],
  importTimeoutMs: 60_000,
  importFile: vi.fn(),
  importDataUrl: vi.fn(),
  ensureDerivative: vi.fn(),
  resolvePath: vi.fn(),
  fetch: vi.fn(),
  request: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  noop: vi.fn(),
  profiles: [{ id: 'fixture', model_name: 'fixture', model_use: 'chat' }],
  remoteProfiles: []
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
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
    notifySuccess: f.noop,
    notifyInfo: f.info,
    notifyWarning: f.noop,
    notifyError: f.error
  })
}))
vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({ availableProfiles: f.profiles, remoteProfiles: f.remoteProfiles })
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcFs: {},
    svcHyper: {},
    svcManagedMedia: {
      importFile: f.importFile,
      importDataUrl: f.importDataUrl,
      ensureDerivative: f.ensureDerivative
    },
    svcLLMProxy: { chat: f.request, chatStream: f.request, signHy3DModel: vi.fn() }
  })
}))
// The real module with a per-test import timeout (read at call time through the getter).
vi.mock('./chatManagedMediaAttachments', async (original) => {
  const actual = await original<typeof import('./chatManagedMediaAttachments')>()
  return {
    ...actual,
    get INCOMING_CHAT_IMAGE_IMPORT_TIMEOUT_MS() {
      return f.importTimeoutMs
    }
  }
})
vi.mock('./chatStorage', async (original) => ({
  ...(await original<typeof import('./chatStorage')>()),
  loadAllSessions: async () => f.sessions,
  saveSessionToDB: async (session: unknown) => {
    f.saved.push(structuredClone(session))
  },
  debouncedSaveSessions: (sessions: unknown) => {
    f.saved.push(structuredClone(sessions))
  },
  cancelDebouncedSessionSave: () => undefined,
  saveChatSessions: () => undefined,
  loadChatSessionBackups: () => ({}),
  saveChatSessionBackups: () => undefined,
  migrateFromLocalStorage: async () => null
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
// Stands in for the edit form: registers the per-attachment receiver while a message is edited.
vi.mock('./components/ChatMessageList', () => ({
  default: function MessageList({
    editingMessageIndex,
    editingContent,
    onSetEditingIndex,
    onSetEditingContent,
    onRegisterEditingAttachmentReceiver
  }: {
    editingMessageIndex: number | null
    editingContent: string
    onSetEditingIndex: (index: number) => void
    onSetEditingContent: (content: string) => void
    onRegisterEditingAttachmentReceiver: (
      receiver: ((attachment: ChatAttachment) => void) | null
    ) => void
  }) {
    const receiver = useMemo(() => (attachment: ChatAttachment) => f.edited.push(attachment), [])
    useEffect(() => {
      onRegisterEditingAttachmentReceiver(editingMessageIndex === null ? null : receiver)
      return () => onRegisterEditingAttachmentReceiver(null)
    }, [editingMessageIndex, receiver, onRegisterEditingAttachmentReceiver])
    return (
      <div>
        <span data-testid="edit">{editingContent}</span>
        <button
          onClick={() => {
            onSetEditingIndex(0)
            onSetEditingContent('edit baseline')
          }}
        >
          edit
        </button>
      </div>
    )
  }
}))
vi.mock('./components/ChatComposer', () => ({
  default: ({
    inputValue,
    pendingAttachments
  }: {
    inputValue: string
    pendingAttachments: ChatAttachment[]
  }) => (
    <div>
      <textarea data-testid="composer" value={inputValue} readOnly />
      <pre data-testid="pending">{JSON.stringify(pendingAttachments)}</pre>
    </div>
  )
}))

const scope = 'canvas-handoff-managed'
const sha = (seed: string) => seed.repeat(64).slice(0, 64)
const managed = (seed: string, name: string) => ({
  reference: {
    version: 1,
    kind: 'managed',
    relativePath: `user-output/chat-attachments/originals/${sha(seed).slice(0, 2)}/${sha(seed)}.png`,
    sha256: sha(seed),
    sizeBytes: 3,
    mimeType: 'image/png',
    originalFileName: name
  },
  localMediaUrl: `local-media:///fixture-media/${sha(seed)}.png`
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const pending = (): ChatAttachment[] =>
  JSON.parse(screen.getByTestId('pending').textContent || '[]') as ChatAttachment[]
const dispatch = async (detail: object) => {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('send-to-agent', { detail: { targetScope: scope, ...detail } })
    )
  })
}
const collectUrls = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') return out
  if (Array.isArray(value)) value.forEach((item) => collectUrls(item, out))
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'url' && typeof item === 'string') out.push(item)
      else collectUrls(item, out)
    }
  }
  return out
}

async function renderPage() {
  render(
    <ThemeProvider theme={createTheme()}>
      <MemoryRouter>
        <ChatPage storageScope={scope} />
      </MemoryRouter>
    </ThemeProvider>
  )
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveValue('draft'))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260))
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  f.saved = []
  f.edited = []
  f.importTimeoutMs = 60_000
  f.config = structuredClone(DEFAULT_CONFIG)
  f.sessions = [
    {
      id: 'session-a',
      title: 'fixture',
      storageScope: scope,
      profileId: 'fixture',
      messages: [],
      draft: {
        inputValue: 'draft',
        pendingAttachments: [],
        pendingHiddenContext: '',
        updatedAt: Date.now()
      }
    }
  ]
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'session-a')
  f.importFile.mockImplementation(async ({ originalFileName }: { originalFileName: string }) =>
    managed('a', originalFileName)
  )
  f.importDataUrl.mockImplementation(async ({ originalFileName }: { originalFileName: string }) =>
    managed(originalFileName.startsWith('blob') ? 'b' : 'c', originalFileName)
  )
  f.resolvePath.mockImplementation(async (filePath: string) => filePath)
  f.fetch.mockImplementation(async (url: string) => {
    if (!String(url).startsWith('blob:')) throw new Error(`Unexpected fetch ${url}`)
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  })
  vi.stubGlobal('fetch', f.fetch)
  vi.stubGlobal('electronFile', { resolveAuthorizedLocalMediaPath: f.resolvePath })
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.unstubAllGlobals()
})

/** An 8 MB original whose 2048 px webp derivative fits the limit (see the hand-off test below). */
const stubOverLimitImports = () => {
  f.importDataUrl.mockImplementation(
    async ({ dataUrl, originalFileName }: { dataUrl: string; originalFileName: string }) => {
      if (dataUrl.startsWith('data:image/webp')) return managed('f', originalFileName)
      const original = managed('e', originalFileName)
      return { ...original, reference: { ...original.reference, sizeBytes: 8 * 1024 * 1024 } }
    }
  )
  f.fetch.mockImplementation(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } })
  )
}
const readyDerivative = async ({ maxEdge }: { maxEdge: number }) => ({
  status: 'ready',
  descriptor: {
    maxEdge,
    relativePath: `derivatives/${maxEdge}.webp`,
    mimeType: 'image/webp',
    sizeBytes: 900_000,
    width: 2048,
    height: 1536,
    sha256: 'f'.repeat(64),
    localMediaUrl: `local-media:///fixture-media/derivative-${maxEdge}.webp`
  }
})
/** An internal canvas drag whose payload names a file and carries it as a File. */
const dropDraggedFile = (name: string) => {
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 4000
    naturalHeight = 3000
    width = 4000
    height = 3000
    set src(_value: string) {
      setTimeout(() => this.onload?.(), 0)
    }
  }
  vi.stubGlobal('Image', FakeImage)
  const urlApi = URL as unknown as {
    createObjectURL?: (blob: Blob) => string
    revokeObjectURL?: (url: string) => void
  }
  if (!urlApi.createObjectURL) urlApi.createObjectURL = () => 'blob:dragged-file'
  if (!urlApi.revokeObjectURL) urlApi.revokeObjectURL = () => undefined
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  const payload = JSON.stringify({ fileItem: { filename: name }, promptId: 'p1' })
  fireEvent.drop(screen.getByTestId('composer'), {
    dataTransfer: {
      files: [file],
      items: [],
      types: ['application/x-qapp-image', 'Files'],
      getData: (key: string) => (key === 'application/x-qapp-image' ? payload : '')
    }
  })
}
const localImage = (name: string): ChatAttachment => ({
  type: 'image',
  url: `local-media:///boards/${name}`,
  mimeType: 'image/png',
  fileName: name
})

describe('canvas hand-off into managed media', () => {
  it('imports local-media, blob: and data: images and keeps no data:/blob: URL in composer or saved state', async () => {
    await renderPage()
    await dispatch({
      attachment: {
        type: 'image',
        url: 'local-media:///boards/file-backed.png',
        mimeType: 'image/png',
        fileName: 'file-backed.png',
        sourceWidth: 40,
        sourceHeight: 30
      }
    })
    await dispatch({
      attachment: { type: 'image', url: 'blob:restored-item', fileName: 'blob-restored.png' }
    })
    await dispatch({
      attachment: {
        type: 'image',
        url: 'data:image/png;base64,AQID',
        mimeType: 'image/png',
        fileName: 'canvas-selection.png',
        hiddenFromChatView: true
      }
    })
    await dispatch({ hiddenText: 'manifest', text: 'canvas text' })

    await waitFor(() => expect(pending()).toHaveLength(3))
    await waitFor(() => expect(screen.getByTestId('composer')).toHaveValue('draft\ncanvas text'))
    const attachments = pending()
    expect(attachments.map((item) => item.fileName)).toEqual([
      'file-backed.png',
      'blob-restored.png',
      'canvas-selection.png'
    ])
    expect(attachments.every((item) => item.media?.kind === 'managed')).toBe(true)
    expect(attachments.every((item) => item.url.startsWith('local-media:///fixture-media/'))).toBe(
      true
    )
    expect(attachments[0]).toMatchObject({ sourceWidth: 40, sourceHeight: 30 })
    expect(attachments[2]).toMatchObject({ hiddenFromChatView: true })
    // File-backed source: imported by path in main, no bytes read in the renderer.
    expect(f.resolvePath).toHaveBeenCalledWith('/boards/file-backed.png')
    expect(f.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/boards/file-backed.png', mimeType: 'image/png' })
    )
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.fetch).toHaveBeenCalledWith('blob:restored-item')
    expect(f.error).not.toHaveBeenCalled()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    // The draft carrying the three images was persisted, with managed URLs only.
    expect(JSON.stringify(f.saved)).toContain('blob-restored.png')
    const stateUrls = [...collectUrls(f.saved), ...collectUrls(attachments)]
    expect(stateUrls.length).toBeGreaterThanOrEqual(6)
    expect(stateUrls.filter((url) => /^(?:data|blob):/.test(url))).toEqual([])
    for (let index = 0; index < localStorage.length; index += 1) {
      const value = localStorage.getItem(localStorage.key(index) || '') || ''
      expect(value).not.toMatch(/"url":"(?:data|blob):/)
    }
  })

  it('applies separate events in arrival order even when a later import finishes first', async () => {
    await renderPage()
    const slow = deferred<ReturnType<typeof managed>>()
    f.importFile.mockImplementationOnce(async () => slow.promise)
    await dispatch({
      attachment: {
        type: 'image',
        url: 'local-media:///boards/first.png',
        mimeType: 'image/png',
        fileName: 'first.png'
      }
    })
    await dispatch({
      attachment: { type: 'image', url: 'data:image/png;base64,AQID', fileName: 'second.png' }
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(pending()).toEqual([])
    await act(async () => {
      slow.resolve(managed('a', 'first.png'))
      await slow.promise
    })
    await waitFor(() =>
      expect(pending().map((item) => item.fileName)).toEqual(['first.png', 'second.png'])
    )
  })

  // Owner decision 5: the same image delivered by two separate events is two occurrences.
  it('keeps the same managed content delivered twice as two occurrences and reports a failed import', async () => {
    await renderPage()
    f.importDataUrl.mockImplementation(async ({ originalFileName }: { originalFileName: string }) =>
      managed('d', originalFileName)
    )
    await dispatch({
      attachment: { type: 'image', url: 'data:image/png;base64,AQID', fileName: 'same.png' }
    })
    await waitFor(() => expect(pending()).toHaveLength(1))
    await dispatch({
      attachment: { type: 'image', url: 'blob:same-pixels', fileName: 'same.png' }
    })
    await waitFor(() => expect(pending()).toHaveLength(2))
    expect(pending().map((item) => item.media)).toEqual([
      expect.objectContaining({ sha256: sha('d') }),
      expect.objectContaining({ sha256: sha('d') })
    ])

    f.importDataUrl.mockRejectedValueOnce(new Error('store full'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await dispatch({
      attachment: { type: 'image', url: 'data:image/png;base64,AQID', fileName: 'broken.png' }
    })
    await waitFor(() => expect(f.error).toHaveBeenCalledWith('canvas.send_to_agent_failed'))
    expect(pending().map((item) => item.fileName)).toEqual(['same.png', 'same.png'])
  })

  it('imports a blob: image from an internal canvas drag instead of inlining it', async () => {
    await renderPage()
    const payload = JSON.stringify({
      attachments: [{ type: 'image', url: 'blob:dragged-item', fileName: 'blob-dragged.png' }]
    })
    fireEvent.drop(screen.getByTestId('composer'), {
      dataTransfer: {
        files: [],
        items: [],
        types: ['application/x-qapp-image'],
        getData: (key: string) => (key === 'application/x-qapp-image' ? payload : '')
      }
    })
    await waitFor(() => expect(pending()).toHaveLength(1))
    expect(pending()[0]).toMatchObject({
      fileName: 'blob-dragged.png',
      url: `local-media:///fixture-media/${sha('b')}.png`,
      media: expect.objectContaining({ kind: 'managed', sha256: sha('b') })
    })
    expect(f.importDataUrl).toHaveBeenCalledWith(
      expect.objectContaining({ dataUrl: 'data:image/png;base64,AQID' })
    )
  })

  it('attaches a bounded copy of a canvas image above the per-image limit and says so', async () => {
    await renderPage()
    const tooBig = 8 * 1024 * 1024
    f.importDataUrl.mockImplementation(
      async ({ dataUrl, originalFileName }: { dataUrl: string; originalFileName: string }) => {
        if (dataUrl.startsWith('data:image/webp')) return managed('f', originalFileName)
        const original = managed('e', originalFileName)
        return { ...original, reference: { ...original.reference, sizeBytes: tooBig } }
      }
    )
    f.ensureDerivative.mockImplementation(async ({ maxEdge }: { maxEdge: number }) => ({
      status: 'ready',
      descriptor: {
        maxEdge,
        relativePath: `derivatives/${maxEdge}.webp`,
        mimeType: 'image/webp',
        sizeBytes: 900_000,
        width: 2048,
        height: 1536,
        sha256: 'f'.repeat(64),
        localMediaUrl: `local-media:///fixture-media/derivative-${maxEdge}.webp`
      }
    }))
    f.fetch.mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } })
    )
    await dispatch({
      attachment: { type: 'image', url: 'data:image/png;base64,AQID', fileName: 'huge.png' }
    })
    await waitFor(() => expect(pending()).toHaveLength(1))
    expect(f.ensureDerivative).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEdge: 2048,
        reference: expect.objectContaining({ sha256: sha('e') })
      })
    )
    expect(pending()[0]).toMatchObject({
      fileName: 'huge.png',
      url: `local-media:///fixture-media/${sha('f')}.png`,
      sourceWidth: 2048,
      sourceHeight: 1536
    })
    expect(f.info).toHaveBeenCalledWith('chat.incoming_image_downscaled')
    expect(f.error).not.toHaveBeenCalled()
  })

  it('refuses a canvas image above the limit that cannot be reduced, with the size message', async () => {
    await renderPage()
    f.importDataUrl.mockImplementation(
      async ({ originalFileName }: { originalFileName: string }) => ({
        ...managed('g', originalFileName),
        reference: { ...managed('g', originalFileName).reference, sizeBytes: 9 * 1024 * 1024 }
      })
    )
    f.ensureDerivative.mockResolvedValue({
      status: 'fallbackOriginal',
      reason: 'animated-gif',
      localMediaUrl: 'local-media:///fixture-media/a.gif'
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await dispatch({
      attachment: { type: 'image', url: 'data:image/gif;base64,AQID', fileName: 'anim.gif' }
    })
    await waitFor(() => expect(f.error).toHaveBeenCalledWith('chat.incoming_image_too_large'))
    expect(f.error).not.toHaveBeenCalledWith('canvas.send_to_agent_failed')
    expect(pending()).toEqual([])
  })

  // Owner decision 5: a file delivered again is one more occurrence, not a repeat to drop.
  it('keeps two selected files with identical bytes and different names, and a repeated file as another occurrence', async () => {
    await renderPage()
    // ref-A.png and ref-B.png are copies of one picture: the store gives both one reference.
    f.importFile.mockImplementation(async ({ originalFileName }: { originalFileName: string }) =>
      managed(originalFileName.startsWith('ref') ? 'a' : 'c', originalFileName)
    )
    await dispatch({ attachment: localImage('ref-A.png') })
    await dispatch({ attachment: localImage('ref-B.png') })
    await dispatch({ attachment: localImage('other.png') })
    await dispatch({ hiddenText: 'manifest: ref-A.png, ref-B.png, other.png' })
    const selection = ['ref-A.png', 'ref-B.png', 'other.png']
    await waitFor(() => expect(pending().map((item) => item.fileName)).toEqual(selection))
    expect(pending()[0].media).toMatchObject({ sha256: sha('a') })
    expect(pending()[1].media).toMatchObject({ sha256: sha('a') })
    expect(f.error).not.toHaveBeenCalled()

    // The same file again (same name, same content) is a fourth occurrence.
    await dispatch({ attachment: localImage('ref-A.png') })
    await dispatch({ text: 'after the repeat' })
    await waitFor(() =>
      expect(screen.getByTestId('composer')).toHaveValue('draft\nafter the repeat')
    )
    expect(pending().map((item) => item.fileName)).toEqual([...selection, 'ref-A.png'])
    expect(pending()[3].media).toMatchObject({ sha256: sha('a') })
  })

  it('gives the edit form the images in arrival order when the first import finishes last', async () => {
    f.sessions[0].messages = [{ role: 'user', content: 'original' }]
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'edit' }))
    await waitFor(() => expect(screen.getByTestId('edit')).toHaveTextContent('edit baseline'))
    await act(async () => {})

    const slow = deferred<ReturnType<typeof managed>>()
    f.importFile.mockImplementation(async ({ originalFileName }: { originalFileName: string }) =>
      originalFileName === 'first.png' ? slow.promise : managed('c', originalFileName)
    )
    await dispatch({ attachment: localImage('first.png') })
    await dispatch({ attachment: localImage('second.png') })
    await dispatch({ attachment: localImage('third.png') })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    // Nothing overtakes the first image while it is still being imported.
    expect(f.edited).toEqual([])
    await act(async () => {
      slow.resolve(managed('a', 'first.png'))
      await slow.promise
    })
    await waitFor(() => expect(f.edited).toHaveLength(3))
    expect(f.edited.map((item) => item.fileName)).toEqual(['first.png', 'second.png', 'third.png'])
    expect(f.edited.every((item) => item.media?.kind === 'managed')).toBe(true)
    // The edit form received them; the bottom composer did not.
    expect(pending()).toEqual([])
    expect(f.error).not.toHaveBeenCalled()
  })

  it('refuses an import that never settles and still applies the later hand-offs', async () => {
    f.importTimeoutMs = 150
    await renderPage()
    f.importFile.mockImplementationOnce(() => new Promise(() => {}))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await dispatch({ attachment: localImage('stuck.png') })
    await dispatch({
      attachment: { type: 'image', url: 'data:image/png;base64,AQID', fileName: 'later.png' }
    })
    await dispatch({ text: 'typed by canvas' })
    await waitFor(() => expect(f.error).toHaveBeenCalledWith('canvas.send_to_agent_failed'))
    await waitFor(() => expect(pending().map((item) => item.fileName)).toEqual(['later.png']))
    await waitFor(() =>
      expect(screen.getByTestId('composer')).toHaveValue('draft\ntyped by canvas')
    )
    expect(f.error).toHaveBeenCalledTimes(1)
  })

  it('reads and imports a source once when one hand-off carries it twice', async () => {
    await renderPage()
    const payload = JSON.stringify({
      attachments: [
        { type: 'image', url: 'blob:same-source', fileName: 'first.png' },
        { type: 'image', url: 'blob:same-source', fileName: 'second.png', sourceWidth: 7 }
      ]
    })
    fireEvent.drop(screen.getByTestId('composer'), {
      dataTransfer: {
        files: [],
        items: [],
        types: ['application/x-qapp-image'],
        getData: (key: string) => (key === 'application/x-qapp-image' ? payload : '')
      }
    })
    await waitFor(() => expect(pending()).toHaveLength(2))
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.importDataUrl).toHaveBeenCalledTimes(1)
    expect(pending().map((item) => [item.fileName, item.url, item.media?.kind])).toEqual([
      ['first.png', `local-media:///fixture-media/${sha('c')}.png`, 'managed'],
      ['second.png', `local-media:///fixture-media/${sha('c')}.png`, 'managed']
    ])
    expect(pending()[1]).toMatchObject({ sourceWidth: 7 })
  })

  it('tells the user when a dragged canvas file above the limit is attached as a smaller copy', async () => {
    await renderPage()
    stubOverLimitImports()
    f.ensureDerivative.mockImplementation(readyDerivative)
    dropDraggedFile('huge-file.png')
    await waitFor(() => expect(pending()).toHaveLength(1))
    expect(pending()[0]).toMatchObject({
      fileName: 'huge-file.png',
      url: `local-media:///fixture-media/${sha('f')}.png`
    })
    expect(f.info).toHaveBeenCalledTimes(1)
    expect(f.info).toHaveBeenCalledWith('chat.incoming_image_downscaled')
    expect(f.error).not.toHaveBeenCalled()
  })

  it('refuses a dragged canvas file above the limit that cannot be reduced, with the size message', async () => {
    await renderPage()
    stubOverLimitImports()
    f.ensureDerivative.mockResolvedValue({
      status: 'fallbackOriginal',
      reason: 'animated-gif',
      localMediaUrl: 'local-media:///fixture-media/a.gif'
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    dropDraggedFile('huge-anim.png')
    await waitFor(() => expect(f.error).toHaveBeenCalledWith('chat.incoming_image_too_large'))
    expect(f.error).toHaveBeenCalledTimes(1)
    expect(f.error).not.toHaveBeenCalledWith('canvas.send_to_agent_failed')
    expect(f.info).not.toHaveBeenCalled()
    expect(pending()).toEqual([])
  })
})
