import { createHash } from 'node:crypto'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import type { ChatSession } from './chatStorage'
import { loadAllSessions, saveSessionToDB } from './chatStorage'
import {
  buildChatWorkspaceControlsPortalId,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID
} from './chatPageShared'
import ChatPage from './ChatPage'
import { installFakeIDBKeyRange } from '../../testUtils/fakeIdbKeyRange'
// A transaction of this fake cannot complete while one of its requests is pending, as in a
// browser; the per-file fake it replaces completed on a fixed timer and made this suite flaky.
import { createFakeRestoredThreadIndexedDb as createFakeIndexedDb } from '../../testUtils/fakeRestoredThreadIndexedDb'

// chatStorage reads one scope through a key range; jsdom has no IDBKeyRange of its own.
installFakeIDBKeyRange()

let activeFakeIndexedDb: ReturnType<typeof createFakeIndexedDb> | undefined

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`
const PNG_FILE_NAME = 'owned-fixture.png'
const SCOPE = 'restored-agent-thread'
const OTHER_SCOPE = 'restored-agent-thread-other'

const fixture = vi.hoisted(() => ({
  config: null as Config | null,
  profiles: [] as LLMAPIProfile[],
  ipcChat: vi.fn(),
  materializeAttachment: vi.fn(),
  importDataUrl: vi.fn(),
  materializeForRequest: vi.fn()
}))

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: 'fixture-vision-model',
        model_name: 'Fixture Vision Model',
        provider: 'openai',
        api_mode: 'responses',
        model_use: 'vision',
        is_vision_model: true,
        // Main refuses inline images for profiles without this declaration.
        attachment_transports: ['request-data-url'],
        preferred_attachment_transport: 'request-data-url'
      } as LLMAPIProfile
    ],
    customSkills: [],
    customSkillCategories: []
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (_key: string, options?: { defaultValue?: string; error?: string }) =>
      options?.defaultValue || options?.error || _key
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
    notifyError: vi.fn(),
    notifyWarning: vi.fn()
  })
}))

vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({
    availableProfiles: fixture.profiles,
    remoteProfiles: []
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => window.api
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  selectFile: vi.fn(),
  fileToBlobUrl: vi.fn(() => 'blob:unused'),
  fileToDataUrl: vi.fn(async () => PNG_DATA_URL),
  checkFileSize: vi.fn(() => true),
  formatFileSize: vi.fn(() => '1 B')
}))

vi.mock('@renderer/utils/droppedImageUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/utils/droppedImageUtils')>()
  return {
    ...actual,
    materializeInternalImageDragAttachment: async (attachment: ChatAttachment) => {
      fixture.materializeAttachment(attachment)
      return attachment
    }
  }
})

vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return {
    ...actual,
    // Keep requestChatCompletion real, but force the local request down its non-streaming
    // path so the test can observe the exact chat() IPC payload.
    supportsStreamingChatCompletion: vi.fn(() => false)
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
    <pre data-testid="restored-agent-session">{JSON.stringify(currentSession || null)}</pre>
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
    <div data-testid="restored-agent-composer">
      <input
        data-testid="restored-agent-composer-input"
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <button type="button" data-testid="restored-agent-composer-send" onClick={onSend}>
        send
      </button>
    </div>
  )
}))

const createImageAttachment = (): ChatAttachment => ({
  type: 'image',
  url: PNG_DATA_URL,
  fileName: PNG_FILE_NAME,
  mimeType: 'image/png',
  sizeBytes: decodeBase64(PNG_BASE64).byteLength
})

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const hashBytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex')

const pngHash = hashBytes(decodeBase64(PNG_BASE64))
// The send-to-agent hand-off imports the inline PNG into managed media (content-addressed).
const MANAGED_PNG_URL = `local-media:///fixture-chat-media/originals/${pngHash.slice(0, 2)}/${pngHash}.png`

const readSessionFromUi = (): ChatSession | null => {
  const raw = screen.getByTestId('restored-agent-session').textContent?.trim() || ''
  if (!raw || raw === 'null') return null
  return JSON.parse(raw) as ChatSession
}

const renderPage = (scope: string) =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <div id={buildChatWorkspaceControlsPortalId(scope)} />
        <div id="agent-workspace-skill-portal" />
        <ChatPage compact storageScope={scope} active />
      </ThemeProvider>
    </MemoryRouter>
  )

const sendExternalMessage = async (detail: Record<string, unknown>): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('send-to-agent', { detail }))
  })
}

const waitForPersistedSession = async (
  scope: string,
  predicate: (session: ChatSession) => boolean
): Promise<ChatSession> => {
  let found: ChatSession | undefined
  await waitFor(async () => {
    const sessions = await loadAllSessions(scope)
    found = sessions.find(predicate)
    expect(found).toBeTruthy()
  }, { timeout: 8000 })
  return found as ChatSession
}

// Remount only completed turns. Seeing an IPC invocation or user message is
// not evidence that the asynchronous assistant reply and guarded save finished.
const waitForPersistedReply = async (
  scope: string,
  sessionId: string,
  content: string
): Promise<void> => {
  await waitFor(() =>
    expect(readSessionFromUi()?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'assistant', content })])
    )
  )
  await waitForPersistedSession(
    scope,
    (session) =>
      session.id === sessionId &&
      session.messages.some(
        (message) => message.role === 'assistant' && message.content === content
      )
  )
  await act(async () => {
    await activeFakeIndexedDb?.state.database?.waitForTransactions()
  })
}

const allRequestMessages = (request: unknown): ChatMessage[] =>
  ((request as { messages?: ChatMessage[] }).messages || []) as ChatMessage[]

const imageAttachmentsInRequest = (request: unknown): ChatAttachment[] =>
  allRequestMessages(request).flatMap((message) =>
    (message.attachments || []).filter((attachment) => attachment.type === 'image')
  )

beforeEach(() => {
  fixture.config = createConfig()
  fixture.profiles = fixture.config.llm_config.api_profiles || []
  fixture.ipcChat.mockReset()
  fixture.materializeAttachment.mockReset()
  fixture.ipcChat.mockImplementation(async () => ({
    content: `assistant-${fixture.ipcChat.mock.calls.length}`
  }))
  fixture.importDataUrl.mockReset()
  fixture.importDataUrl.mockImplementation(
    async ({ dataUrl, originalFileName }: { dataUrl: string; originalFileName: string }) => {
      const bytes = decodeBase64(dataUrl.split(',')[1])
      const sha256 = hashBytes(bytes)
      return {
        reference: {
          version: 1,
          kind: 'managed',
          relativePath: `user-output/chat-attachments/originals/${sha256.slice(0, 2)}/${sha256}.png`,
          sha256,
          sizeBytes: bytes.byteLength,
          mimeType: 'image/png',
          originalFileName
        },
        localMediaUrl: `local-media:///fixture-chat-media/originals/${sha256.slice(0, 2)}/${sha256}.png`
      }
    }
  )
  fixture.materializeForRequest.mockReset()
  fixture.materializeForRequest.mockImplementation(async () => ({
    transport: 'request-data-url',
    dataUrl: PNG_DATA_URL,
    mimeType: 'image/png',
    sizeBytes: decodeBase64(PNG_BASE64).byteLength
  }))

  const fakeIndexedDb = createFakeIndexedDb()
  activeFakeIndexedDb = fakeIndexedDb
  vi.stubGlobal('indexedDB', fakeIndexedDb.api)
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
        materializeForRequest: fixture.materializeForRequest
      },
      svcAgentLocalFiles: {},
      svcFs: {},
      svcHyper: {
        saveImageToDir: vi.fn(async () => ({ savedPath: null }))
      }
    }
  })
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  cleanup()
  await activeFakeIndexedDb?.state.database?.waitForTransactions()
  activeFakeIndexedDb?.state.database?.close()
  activeFakeIndexedDb = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ChatPage restored agent thread persistence', () => {
  it('restores the first-turn PNG for the third request without leaking it across scopes', async () => {
    expect(decodeBase64(PNG_BASE64).slice(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]))

    const firstAttachment = createImageAttachment()
    const firstHash = hashBytes(decodeBase64(firstAttachment.url.split(',')[1]))
    expect(firstHash).toBe(pngHash)

    const seededSession: ChatSession = {
      id: 'restored-agent-session',
      title: 'Restored agent fixture',
      storageScope: SCOPE,
      profileId: 'fixture-vision-model',
      messages: [],
      createdAt: Date.now()
    }
    await saveSessionToDB(seededSession, SCOPE)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), seededSession.id)

    const firstRender = renderPage(SCOPE)
    await waitFor(() => {
      const session = readSessionFromUi()
      expect(session?.id).toBeTruthy()
    })
    const session = readSessionFromUi()
    if (!session) throw new Error('ChatPage did not expose a session after storage load')
    const sessionId = session.id

    await sendExternalMessage({
      targetScope: SCOPE,
      autoSend: true,
      requestId: 'restored-agent-first',
      text: 'Describe this owned PNG.',
      attachments: [firstAttachment]
    })
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(1))
    await waitForPersistedReply(SCOPE, sessionId, 'assistant-1')

    const firstRequest = fixture.ipcChat.mock.calls[0][0]
    const firstRequestImage = imageAttachmentsInRequest(firstRequest)[0]
    expect(firstRequestImage).toBeTruthy()
    expect(hashBytes(decodeBase64(firstRequestImage.url.split(',')[1]))).toBe(pngHash)

    const firstPersisted = await waitForPersistedSession(
      SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some(
          (message) => message.role === 'user' && message.attachments?.[0]?.url === MANAGED_PNG_URL
        )
    )
    // Stored as a managed descriptor, never as the inline data URL it arrived as.
    expect(firstPersisted.messages[0]?.attachments?.[0]?.url).toBe(MANAGED_PNG_URL)
    expect(firstPersisted.messages[0]?.attachments?.[0]?.media).toEqual(
      expect.objectContaining({ kind: 'managed', sha256: pngHash })
    )
    expect(JSON.stringify(firstPersisted)).not.toContain('data:')
    expect(fixture.importDataUrl).toHaveBeenCalledWith(
      expect.objectContaining({ dataUrl: PNG_DATA_URL, originalFileName: PNG_FILE_NAME })
    )

    fireEvent.change(screen.getByTestId('restored-agent-composer-input'), {
      target: { value: 'Follow up in plain text.' }
    })
    fireEvent.click(screen.getByTestId('restored-agent-composer-send'))
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(2))
    await waitForPersistedReply(SCOPE, sessionId, 'assistant-2')
    await waitForPersistedSession(
      SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some((message) => message.content === 'Follow up in plain text.')
    )

    firstRender.unmount()
    document.body.innerHTML = ''

    const restoredRender = renderPage(SCOPE)
    await waitFor(() => {
      const session = readSessionFromUi()
      expect(session?.id).toBe(sessionId)
    })
    const restoredSession = readSessionFromUi()
    if (!restoredSession) throw new Error('ChatPage did not restore the persisted session')
    expect(restoredSession.id).toBe(sessionId)
    expect(restoredSession.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'Describe this owned PNG.',
          attachments: [
            expect.objectContaining({
              url: MANAGED_PNG_URL,
              media: expect.objectContaining({ sha256: pngHash })
            })
          ]
        }),
        expect.objectContaining({ role: 'user', content: 'Follow up in plain text.' })
      ])
    )

    fireEvent.change(screen.getByTestId('restored-agent-composer-input'), {
      target: { value: 'Third question after restoring the thread.' }
    })
    fireEvent.click(screen.getByTestId('restored-agent-composer-send'))
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(3))
    await waitForPersistedReply(SCOPE, sessionId, 'assistant-3')

    const thirdRequest = fixture.ipcChat.mock.calls[2][0]
    const thirdRequestImages = imageAttachmentsInRequest(thirdRequest)
    expect(thirdRequestImages).toHaveLength(1)
    expect(hashBytes(decodeBase64(thirdRequestImages[0].url.split(',')[1]))).toBe(pngHash)
    expect(allRequestMessages(thirdRequest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('Describe this owned PNG.') }),
        expect.objectContaining({ content: 'Follow up in plain text.' }),
        expect.objectContaining({ content: 'Third question after restoring the thread.' })
      ])
    )

    await waitForPersistedSession(
      SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some(
          (message) => message.content === 'Third question after restoring the thread.'
        )
    )
    restoredRender.unmount()
    document.body.innerHTML = ''

    expect(await loadAllSessions(OTHER_SCOPE)).toEqual([])
    const otherRender = renderPage(OTHER_SCOPE)
    await waitFor(() => expect(readSessionFromUi()).toBeNull())
    const otherSessionId = 'restored-agent-other-session'
    await saveSessionToDB(
      {
        id: otherSessionId,
        title: 'Other scope fixture',
        storageScope: OTHER_SCOPE,
        profileId: 'fixture-vision-model',
        messages: [],
        createdAt: Date.now()
      },
      OTHER_SCOPE
    )
    otherRender.unmount()
    document.body.innerHTML = ''
    const otherRemount = renderPage(OTHER_SCOPE)
    await waitFor(() => expect(readSessionFromUi()?.id).toBe(otherSessionId))
    await sendExternalMessage({
      targetScope: OTHER_SCOPE,
      autoSend: true,
      requestId: 'restored-agent-other-scope',
      text: 'Text-only question in another scope.'
    })
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(4))
    await waitForPersistedReply(OTHER_SCOPE, otherSessionId, 'assistant-4')

    const otherRequest = fixture.ipcChat.mock.calls[3][0]
    expect(imageAttachmentsInRequest(otherRequest)).toEqual([])
    const otherSession = await waitForPersistedSession(OTHER_SCOPE, (session) =>
      session.messages.some((message) => message.content === 'Text-only question in another scope.')
    )
    expect(otherSession.messages.flatMap((message) => message.attachments || [])).toEqual([])
    otherRemount.unmount()
    // The managed path settles through the save-conflict retry of the fake store; same
    // budget as ChatPage.restoredManagedAgentThread needs.
  }, 20_000)
})
