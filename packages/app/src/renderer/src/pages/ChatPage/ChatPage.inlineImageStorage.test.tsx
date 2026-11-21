import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import type { MediaReference } from '@shared/mediaReference'
import type { ChatSession } from './chatStorage'
import { loadAllSessions, saveSessionToDB } from './chatStorage'
import {
  buildChatWorkspaceControlsPortalId,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID
} from './chatPageShared'
import ChatPage from './ChatPage'
import { installFakeIDBKeyRange } from '../../testUtils/fakeIdbKeyRange'
import { createFakeRestoredThreadIndexedDb as createFakeIndexedDb } from '../../testUtils/fakeRestoredThreadIndexedDb'

// FIX-PLAN item 4: stored conversations do not keep inline base64 images. The page runs on the
// real chatStorage over an in-memory IndexedDB; main's managed media store is a fake that hands
// out one reference per data: URL and gives the same bytes back for a request.

installFakeIDBKeyRange()

const SCOPE = 'inline-storage-project.pane-a'
const OTHER_SCOPE = 'inline-storage-project.pane-b'

/** A strict base64 PNG data: URL of about `chars` characters, distinct per seed. */
const inlinePng = (seed: string, chars = 70 * 1024): string => {
  const prefix = 'data:image/png;base64,'
  const stem = btoa(`${seed}-`.padEnd(48, '.')).replace(/=+$/u, '')
  const fill = chars - prefix.length - stem.length
  return `${prefix}${stem}${'A'.repeat(fill - ((stem.length + fill) % 4))}`
}

const fixture = vi.hoisted(() => ({
  config: null as Config | null,
  profiles: [] as LLMAPIProfile[],
  notifyError: vi.fn(),
  ipcChat: vi.fn(),
  importDataUrl: vi.fn(),
  importBytes: vi.fn(),
  migrateLegacyDataUrl: vi.fn(),
  materializeForRequest: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
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
    notifyWarning: vi.fn()
  })
}))
vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({ availableProfiles: fixture.profiles, remoteProfiles: [] })
}))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => window.api }))
vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return { ...actual, supportsStreamingChatCompletion: vi.fn(() => false) }
})
// The stored image migration starts after a short wait here instead of seconds.
vi.mock('./chatStoredImageMigration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStoredImageMigration')>()
  return {
    ...actual,
    STORED_IMAGE_MIGRATION_TIMING: {
      startDelayMs: 20,
      idleTimeoutMs: 20,
      pauseRetryMs: 50,
      busyRetryMs: 100,
      maxAttemptsPerSession: 3
    }
  }
})
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: { currentSession?: ChatSession }) => (
    <pre data-testid="inline-storage-session">{JSON.stringify(currentSession || null)}</pre>
  )
}))
vi.mock('./components/ChatComposer', () => ({
  default: ({
    inputValue,
    onInputChange,
    onSend
  }: {
    inputValue: string
    onInputChange: (value: string) => void
    onSend: () => void
  }) => (
    <div>
      <input
        data-testid="inline-storage-input"
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <button type="button" data-testid="inline-storage-send" onClick={onSend}>
        send
      </button>
    </div>
  )
}))

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: 'inline-vision-fixture',
        model_name: 'Inline Vision Fixture',
        provider: 'openai',
        api_mode: 'responses',
        model_use: 'vision',
        is_vision_model: true,
        attachment_transports: ['request-data-url'],
        preferred_attachment_transport: 'request-data-url'
      } as LLMAPIProfile
    ],
    customSkills: [],
    customSkillCategories: []
  }
})

/** The fake managed store: one id per data: URL, its bytes kept for requests. */
const mediaStore = new Map<string, string>()
const managedId = (dataUrl: string): string => {
  let hash = 0
  for (let index = 0; index < dataUrl.length; index += index < 256 ? 1 : 97) {
    hash = (hash * 31 + dataUrl.charCodeAt(index)) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}${dataUrl.length.toString(16).padStart(8, '0')}`.repeat(
    4
  )
}
const importInto = (dataUrl: string, originalFileName = 'image.png') => {
  const id = managedId(dataUrl)
  mediaStore.set(id, dataUrl)
  const reference: MediaReference = {
    version: 1,
    kind: 'managed',
    relativePath: `originals/${id.slice(0, 2)}/${id}.png`,
    sha256: id,
    sizeBytes: Math.floor((dataUrl.length * 3) / 4),
    mimeType: 'image/png',
    originalFileName,
    status: 'ready'
  }
  return { reference, localMediaUrl: `local-media:///managed/originals/${id}.png` }
}

const readSessionFromUi = (): ChatSession | null => {
  const raw = screen.getByTestId('inline-storage-session').textContent?.trim() || ''
  return raw && raw !== 'null' ? (JSON.parse(raw) as ChatSession) : null
}

const renderPage = (storageScope = SCOPE) =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <div id={buildChatWorkspaceControlsPortalId(storageScope)} />
        <div id="agent-workspace-skill-portal" />
        <ChatPage compact active storageScope={storageScope} />
      </ThemeProvider>
    </MemoryRouter>
  )

const sendComposer = async (text: string): Promise<void> => {
  await act(async () => {
    const input = screen.getByTestId('inline-storage-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    screen.getByTestId('inline-storage-send').click()
  })
}

const storedAttachments = (session: ChatSession | undefined): ChatAttachment[] =>
  (session?.messages || []).flatMap((message) => message.attachments || [])

const waitForStored = async (
  predicate: (session: ChatSession) => boolean,
  scope = SCOPE
): Promise<ChatSession> => {
  let found: ChatSession | undefined
  await waitFor(
    async () => {
      found = (await loadAllSessions(scope)).find(predicate)
      expect(found).toBeTruthy()
    },
    { timeout: 4000 }
  )
  return found as ChatSession
}

let activeFakeDb: ReturnType<typeof createFakeIndexedDb> | undefined

beforeEach(() => {
  fixture.config = createConfig()
  fixture.profiles = fixture.config.llm_config.api_profiles || []
  fixture.notifyError.mockReset()
  fixture.ipcChat.mockReset()
  fixture.importDataUrl.mockReset()
  fixture.importBytes.mockReset()
  fixture.importBytes.mockImplementation(
    async (request: { bytes: Uint8Array; mimeType: string; originalFileName: string }) =>
      importInto(
        `data:${request.mimeType};base64,${btoa(String.fromCharCode(...request.bytes))}`,
        request.originalFileName
      )
  )
  fixture.migrateLegacyDataUrl.mockReset()
  fixture.materializeForRequest.mockReset()
  mediaStore.clear()
  fixture.importDataUrl.mockImplementation(
    async (request: { dataUrl: string; originalFileName: string }) =>
      importInto(request.dataUrl, request.originalFileName)
  )
  fixture.migrateLegacyDataUrl.mockImplementation(
    async (request: { dataUrl: string; metadata: { originalFileName: string } }) => {
      const imported = importInto(request.dataUrl, request.metadata.originalFileName)
      return { ...imported, checkpoint: { version: 1, reclaim: { reference: imported.reference } } }
    }
  )
  fixture.materializeForRequest.mockImplementation(
    async (request: { reference: MediaReference }) => ({
      transport: 'request-data-url',
      dataUrl: mediaStore.get(request.reference.sha256 || ''),
      mimeType: 'image/png',
      sizeBytes: request.reference.sizeBytes
    })
  )
  activeFakeDb = createFakeIndexedDb()
  vi.stubGlobal('indexedDB', activeFakeDb.api)
  vi.stubGlobal('crypto', globalThis.crypto)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      svcLLMProxy: {
        chat: fixture.ipcChat,
        cancelConversation: vi.fn(async () => undefined),
        signHy3DModel: vi.fn()
      },
      svcManagedMedia: {
        importDataUrl: fixture.importDataUrl,
        importBytes: fixture.importBytes,
        migrateLegacyDataUrl: fixture.migrateLegacyDataUrl,
        reclaimLegacyMigration: vi.fn(async () => ({ queued: true })),
        materializeForRequest: fixture.materializeForRequest
      },
      svcAgentLocalFiles: {},
      svcFs: {},
      svcHyper: { saveImageToDir: vi.fn(async () => ({ savedPath: null })) }
    }
  })
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  await act(async () => {
    cleanup()
  })
  await activeFakeDb?.state.database?.waitForTransactions()
  activeFakeDb?.state.database?.close()
  activeFakeDb = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const seed = async (session: ChatSession, scope = SCOPE): Promise<void> => {
  await saveSessionToDB({ ...session, storageScope: scope }, scope)
}

describe('ChatPage save guard (FIX-PLAN item 4, part 1)', () => {
  it('stores an assistant image that arrives inline as a managed reference and shows that', async () => {
    const generated = inlinePng('generated')
    await seed({
      id: 'guarded',
      title: 'Guarded',
      profileId: 'inline-vision-fixture',
      messages: []
    })
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), 'guarded')
    fixture.ipcChat.mockResolvedValue({ content: 'here it is', imageUrl: generated })

    renderPage()
    await waitFor(() => expect(readSessionFromUi()?.id).toBe('guarded'))
    await sendComposer('draw a cat')
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(1))

    const stored = await waitForStored(
      (session) =>
        session.id === 'guarded' &&
        storedAttachments(session).some((attachment) => attachment.media?.kind === 'managed')
    )
    await activeFakeDb?.state.database?.waitForTransactions()
    const record = (await loadAllSessions(SCOPE)).find((session) => session.id === 'guarded')
    expect(JSON.stringify(record)).not.toContain('data:image/png;base64')
    expect(storedAttachments(stored)).toHaveLength(1)
    expect(fixture.importDataUrl).toHaveBeenCalledWith(
      expect.objectContaining({ dataUrl: generated })
    )
    // The page holds the same reference form it stored: the image is still there, once.
    await waitFor(() => {
      const shown = storedAttachments(readSessionFromUi() ?? undefined)
      expect(shown).toHaveLength(1)
      expect(shown[0]?.url).toMatch(/^local-media:\/\//)
    })
    expect(fixture.notifyError).not.toHaveBeenCalled()
  })

  it('stores the reply at once while its image import hangs, and the reference after it', async () => {
    const generated = inlinePng('slow')
    let finishImport: () => void = () => undefined
    const imported = new Promise<void>((resolve) => (finishImport = resolve))
    fixture.importDataUrl.mockImplementation(
      async (request: { dataUrl: string; originalFileName: string }) => {
        await imported
        return importInto(request.dataUrl, request.originalFileName)
      }
    )
    await seed({ id: 'slow', title: 'Slow', profileId: 'inline-vision-fixture', messages: [] })
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), 'slow')
    fixture.ipcChat.mockResolvedValue({ content: 'slow reply', imageUrl: generated })

    renderPage()
    await waitFor(() => expect(readSessionFromUi()?.id).toBe('slow'))
    await sendComposer('draw a fox')
    // The import has not finished: the message and the reply are stored anyway, the image as it
    // is. Before, the save waited for the import (up to 30 s per image).
    const early = await waitForStored(
      (session) =>
        session.id === 'slow' &&
        session.messages.some((message: ChatMessage) => message.content === 'slow reply')
    )
    expect(early.messages.map((message: ChatMessage) => message.content)).toEqual([
      'draw a fox',
      'slow reply'
    ])
    expect(storedAttachments(early).map((attachment) => attachment.url)).toEqual([generated])
    await waitFor(() => expect(fixture.importDataUrl).toHaveBeenCalledTimes(1))

    finishImport()
    const rewritten = await waitForStored(
      (session) =>
        session.id === 'slow' &&
        storedAttachments(session).some((attachment) => attachment.media?.kind === 'managed')
    )
    expect(JSON.stringify(rewritten)).not.toContain('data:image/png;base64')
    expect(rewritten.messages.map((message: ChatMessage) => message.content)).toEqual([
      'draw a fox',
      'slow reply'
    ])
    await waitFor(() => {
      const shown = storedAttachments(readSessionFromUi() ?? undefined)
      expect(shown).toHaveLength(1)
      expect(shown[0]?.url).toMatch(/^local-media:\/\//)
    })
    expect(fixture.importDataUrl).toHaveBeenCalledTimes(1)
    expect(fixture.notifyError).not.toHaveBeenCalled()
  })

  it('keeps the image inline, and saves, when the managed import fails', async () => {
    const generated = inlinePng('refused')
    fixture.importDataUrl.mockRejectedValue(new Error('media store unavailable'))
    await seed({
      id: 'refused',
      title: 'Refused',
      profileId: 'inline-vision-fixture',
      messages: []
    })
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), 'refused')
    fixture.ipcChat.mockResolvedValue({ content: 'inline reply', imageUrl: generated })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      renderPage()
      await waitFor(() => expect(readSessionFromUi()?.id).toBe('refused'))
      await sendComposer('draw a dog')
      const stored = await waitForStored(
        (session) =>
          session.id === 'refused' &&
          session.messages.some((message: ChatMessage) => message.content === 'inline reply')
      )
      expect(storedAttachments(stored).map((attachment) => attachment.url)).toEqual([generated])
      expect(fixture.importDataUrl).toHaveBeenCalled()
      expect(fixture.notifyError).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

const imagesInRequest = (callIndex: number): ChatAttachment[] =>
  (
    ((fixture.ipcChat.mock.calls[callIndex][0] as { messages?: ChatMessage[] }).messages ||
      []) as ChatMessage[]
  ).flatMap((message) =>
    (message.attachments || []).filter((attachment) => attachment.type === 'image')
  )

describe('ChatPage stored image migration (FIX-PLAN item 4, part 2)', () => {
  it("moves the open pane's stored inline images to managed media and sends the same images", async () => {
    const big = inlinePng('history-big')
    const small = inlinePng('history-small', 2048)
    const other = inlinePng('history-other')
    const foreign = inlinePng('other-pane')
    await seed({
      id: 'history-a',
      title: 'History A',
      profileId: 'inline-vision-fixture',
      messages: [
        {
          role: 'user',
          content: 'what is in these',
          attachments: [
            { type: 'image', url: big, fileName: 'big.png', mimeType: 'image/png' },
            { type: 'image', url: small, fileName: 'small.png', mimeType: 'image/png' }
          ]
        },
        { role: 'assistant', content: 'two pictures' }
      ]
    })
    await seed({
      id: 'history-b',
      title: 'History B',
      profileId: 'inline-vision-fixture',
      messages: [
        {
          role: 'user',
          content: 'another',
          attachments: [{ type: 'image', url: other, fileName: 'other.png' }]
        }
      ]
    })
    await seed(
      {
        id: 'other-pane',
        title: 'Other pane',
        messages: [
          { role: 'user', content: 'not opened', attachments: [{ type: 'image', url: foreign }] }
        ]
      },
      OTHER_SCOPE
    )
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), 'history-a')
    fixture.ipcChat.mockImplementation(async () => ({
      content: `reply-${fixture.ipcChat.mock.calls.length}`
    }))

    const first = renderPage()
    await waitFor(() => expect(readSessionFromUi()?.id).toBe('history-a'))
    await waitFor(
      async () => {
        const records = await loadAllSessions(SCOPE)
        expect(records).toHaveLength(2)
        for (const record of records) {
          expect(JSON.stringify(record)).not.toContain('data:image')
          expect(JSON.stringify(record).length).toBeLessThan(50_000)
        }
      },
      { timeout: 5000 }
    )
    // Nothing lost or reordered; the pane shows the references it stored.
    const [storedA] = (await loadAllSessions(SCOPE)).filter((record) => record.id === 'history-a')
    expect(storedAttachments(storedA).map((attachment) => attachment.fileName)).toEqual([
      'big.png',
      'small.png'
    ])
    await waitFor(() =>
      expect(
        storedAttachments(readSessionFromUi() ?? undefined).map((attachment) => attachment.url)
      ).toEqual(storedAttachments(storedA).map((attachment) => attachment.url))
    )
    // A scope the user did not open is never touched.
    const [otherRecord] = await loadAllSessions(OTHER_SCOPE)
    expect(storedAttachments(otherRecord)[0]?.url).toBe(foreign)
    expect(
      fixture.migrateLegacyDataUrl.mock.calls.some(
        ([request]) => (request as { dataUrl: string }).dataUrl === foreign
      )
    ).toBe(false)

    // The next message sends both history images, with the bytes they had inline.
    await sendComposer('and now?')
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(1))
    expect(imagesInRequest(0).map((attachment) => attachment.url)).toEqual([big, small])
    await waitForStored(
      (session) =>
        session.id === 'history-a' &&
        session.messages.some((message) => message.content === 'reply-1')
    )
    await activeFakeDb?.state.database?.waitForTransactions()
    const migrations = fixture.migrateLegacyDataUrl.mock.calls.length

    // After a restart on the same profile: still migrated, nothing migrated again, same images.
    await act(async () => {
      first.unmount()
    })
    document.body.innerHTML = ''
    renderPage()
    await waitFor(() => expect(readSessionFromUi()?.id).toBe('history-a'))
    expect(storedAttachments(readSessionFromUi() ?? undefined)[0]?.url).toMatch(/^local-media:/)
    await sendComposer('once more')
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(2))
    expect(imagesInRequest(1).map((attachment) => attachment.url)).toEqual([big, small])
    expect(fixture.migrateLegacyDataUrl.mock.calls.length).toBe(migrations)
    expect(fixture.notifyError).not.toHaveBeenCalled()
  })

  it('keeps the record as it was when the import fails, and does not try again in this start', async () => {
    const inline = inlinePng('kept')
    fixture.migrateLegacyDataUrl.mockRejectedValue(new Error('store unavailable'))
    fixture.importDataUrl.mockRejectedValue(new Error('store unavailable'))
    await seed({
      id: 'kept',
      title: 'Kept',
      profileId: 'inline-vision-fixture',
      messages: [
        { role: 'user', content: 'keep me', attachments: [{ type: 'image', url: inline }] }
      ]
    })
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), 'kept')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      renderPage()
      await waitFor(() => expect(readSessionFromUi()?.id).toBe('kept'))
      await waitFor(() => expect(fixture.migrateLegacyDataUrl).toHaveBeenCalled(), {
        timeout: 3000
      })
      // Tried once in this start, not in a loop.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(fixture.migrateLegacyDataUrl).toHaveBeenCalledTimes(1)
      const [record] = await loadAllSessions(SCOPE)
      expect(storedAttachments(record).map((attachment) => attachment.url)).toEqual([inline])
      expect(storedAttachments(readSessionFromUi() ?? undefined)[0]?.url).toBe(inline)
      expect(fixture.notifyError).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('ChatPage queued images (FIX-PLAN item 4, part 3)', () => {
  it('stores a queued blob: image as a managed reference, not as an unavailable tile', async () => {
    const blobUrl = 'blob:file:///queued-composer-image'
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url !== blobUrl) throw new Error(`unexpected fetch ${url}`)
        return { ok: true, blob: async () => new Blob([pngBytes], { type: 'image/png' }) }
      })
    )
    await seed({
      id: 'queue-images',
      title: 'Queue images',
      profileId: 'inline-vision-fixture',
      messages: [],
      // A composer image only this renderer can read (a blob: URL).
      draft: {
        inputValue: '',
        pendingAttachments: [
          { type: 'image', url: blobUrl, fileName: 'pasted.png', mimeType: 'image/png' }
        ],
        pendingHiddenContext: '',
        updatedAt: 1
      }
    })
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), 'queue-images')
    // The first reply never arrives, so the next message is queued behind it.
    fixture.ipcChat.mockImplementation(() => new Promise(() => undefined))

    renderPage()
    await waitFor(() => expect(readSessionFromUi()?.id).toBe('queue-images'))
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: { targetScope: SCOPE, autoSend: true, requestId: 'busy', text: 'first, slow' }
        })
      )
    })
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(1))
    await sendComposer('queued with an image')

    const backupKey = `magicpot-chat-draft:${SCOPE}:queue-images`
    await waitFor(
      () => {
        const backup = JSON.parse(localStorage.getItem(backupKey) || 'null')
        const queued = backup?.queuedSends?.[0]
        expect(queued?.content).toBe('queued with an image')
        expect(queued?.attachments?.[0]?.url).toMatch(/^local-media:/)
        expect(queued?.attachments?.[0]?.media?.kind).toBe('managed')
      },
      { timeout: 3000 }
    )
    expect(localStorage.getItem(backupKey)).not.toContain('blob:')
    expect(localStorage.getItem(backupKey)).not.toContain('queuedAttachmentUnavailable')
    expect(fixture.importBytes).toHaveBeenCalledTimes(1)
  })
})
