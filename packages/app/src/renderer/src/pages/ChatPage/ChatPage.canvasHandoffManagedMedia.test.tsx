import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
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
  importFile: vi.fn(),
  importDataUrl: vi.fn(),
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
    svcManagedMedia: { importFile: f.importFile, importDataUrl: f.importDataUrl },
    svcLLMProxy: { chat: f.request, chatStream: f.request, signHy3DModel: vi.fn() }
  })
}))
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
vi.mock('./components/ChatMessageList', () => ({ default: () => null }))
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

  it('treats the same managed content as a duplicate and reports a failed import', async () => {
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(pending()).toHaveLength(1)

    f.importDataUrl.mockRejectedValueOnce(new Error('store full'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await dispatch({
      attachment: { type: 'image', url: 'data:image/png;base64,AQID', fileName: 'broken.png' }
    })
    await waitFor(() => expect(f.error).toHaveBeenCalledWith('canvas.send_to_agent_failed'))
    expect(pending().map((item) => item.fileName)).toEqual(['same.png'])
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
})
