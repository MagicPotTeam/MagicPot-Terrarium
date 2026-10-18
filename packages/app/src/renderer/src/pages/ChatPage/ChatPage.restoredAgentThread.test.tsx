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

type StoreMap = Map<string, Map<string, unknown>>

type FakeIndexedDbState = {
  stores: StoreMap
  database: FakeIDBDatabase | null
}

const cloneValue = <T,>(value: T): T => {
  if (value === undefined) return value
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

class FakeIDBObjectStore {
  constructor(
    private readonly stores: StoreMap,
    private readonly storeName: string
  ) {}

  get(key: string): {
    result?: unknown
    error?: DOMException
    onsuccess?: () => void
    onerror?: () => void
  } {
    const request: {
      result?: unknown
      error?: DOMException
      onsuccess?: () => void
      onerror?: () => void
    } = {}

    setTimeout(() => {
      const value = this.stores.get(this.storeName)?.get(key)
      request.result = value === undefined ? undefined : cloneValue(value)
      request.onsuccess?.()
    }, 0)

    return request
  }

  getAll(): {
    result?: unknown[]
    error?: DOMException
    onsuccess?: () => void
    onerror?: () => void
  } {
    const request: {
      result?: unknown[]
      error?: DOMException
      onsuccess?: () => void
      onerror?: () => void
    } = {}

    setTimeout(() => {
      request.result = [...(this.stores.get(this.storeName)?.values() || [])].map((value) =>
        cloneValue(value)
      )
      request.onsuccess?.()
    }, 0)

    return request
  }

  put(value: unknown): void {
    const record = value as { storageKey?: string; id?: string }
    const key = record.storageKey || record.id
    if (!key) throw new Error('Missing fake IndexedDB keyPath value')
    this.stores.get(this.storeName)?.set(key, cloneValue(value))
  }

  delete(key: string): void {
    this.stores.get(this.storeName)?.delete(key)
  }
}

class FakeIDBTransaction {
  error: DOMException | null = null
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(private readonly stores: StoreMap) {
    setTimeout(() => {
      if (!this.error) this.oncomplete?.()
    }, 8)
  }

  objectStore(name: string): FakeIDBObjectStore {
    if (!this.stores.has(name)) throw new Error(`Missing fake object store: ${name}`)
    return new FakeIDBObjectStore(this.stores, name)
  }
}

class FakeIDBDatabase {
  onclose: (() => void) | null = null
  onversionchange: (() => void) | null = null
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.state.stores.has(name)
  }

  constructor(private readonly state: FakeIndexedDbState) {}

  createObjectStore(name: string): FakeIDBObjectStore {
    if (!this.state.stores.has(name)) this.state.stores.set(name, new Map())
    return new FakeIDBObjectStore(this.state.stores, name)
  }

  transaction(name: string, _mode: string): FakeIDBTransaction {
    const transaction = new FakeIDBTransaction(this.state.stores)
    const originalObjectStore = transaction.objectStore.bind(transaction)
    transaction.objectStore = (storeName: string) => originalObjectStore(storeName)
    if (!this.state.stores.has(name)) throw new Error(`Missing fake transaction store: ${name}`)
    return transaction
  }

  close(): void {
    this.onclose?.()
  }
}

const createFakeIndexedDb = () => {
  const state: FakeIndexedDbState = {
    stores: new Map(),
    database: null
  }

  return {
    api: {
      open: (_name: string, _version: number) => {
        const request: {
          result?: FakeIDBDatabase
          error?: DOMException
          transaction?: unknown
          onupgradeneeded?: (event: { target: { result: FakeIDBDatabase } }) => void
          onsuccess?: () => void
          onerror?: () => void
          onblocked?: () => void
        } = {}

        setTimeout(() => {
          if (!state.database) {
            state.database = new FakeIDBDatabase(state)
            request.result = state.database
            request.onupgradeneeded?.({ target: { result: state.database } })
          }
          request.result = state.database
          request.onsuccess?.()
        }, 0)

        return request
      },
      deleteDatabase: (_name: string) => {
        const request: {
          onsuccess?: () => void
          onerror?: () => void
          onblocked?: () => void
        } = {}
        setTimeout(() => request.onsuccess?.(), 0)
        return request
      }
    },
    state
  }
}

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
  materializeAttachment: vi.fn()
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
        is_vision_model: true
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
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
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
  })
  return found as ChatSession
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

  const fakeIndexedDb = createFakeIndexedDb()
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
      svcManagedMedia: {},
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

afterEach(() => {
  cleanup()
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

    const firstRequest = fixture.ipcChat.mock.calls[0][0]
    const firstRequestImage = imageAttachmentsInRequest(firstRequest)[0]
    expect(firstRequestImage).toBeTruthy()
    expect(hashBytes(decodeBase64(firstRequestImage.url.split(',')[1]))).toBe(pngHash)

    const firstPersisted = await waitForPersistedSession(
      SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some(
          (message) => message.role === 'user' && message.attachments?.[0]?.url === PNG_DATA_URL
        )
    )
    expect(firstPersisted.messages[0]?.attachments?.[0]?.url).toBe(PNG_DATA_URL)
    expect(
      hashBytes(decodeBase64(firstPersisted.messages[0].attachments![0].url.split(',')[1]))
    ).toBe(pngHash)

    fireEvent.change(screen.getByTestId('restored-agent-composer-input'), {
      target: { value: 'Follow up in plain text.' }
    })
    fireEvent.click(screen.getByTestId('restored-agent-composer-send'))
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(2))
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
          attachments: [expect.objectContaining({ url: PNG_DATA_URL })]
        }),
        expect.objectContaining({ role: 'user', content: 'Follow up in plain text.' })
      ])
    )

    fireEvent.change(screen.getByTestId('restored-agent-composer-input'), {
      target: { value: 'Third question after restoring the thread.' }
    })
    fireEvent.click(screen.getByTestId('restored-agent-composer-send'))
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(3))

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

    const otherRequest = fixture.ipcChat.mock.calls[3][0]
    expect(imageAttachmentsInRequest(otherRequest)).toEqual([])
    const otherSession = await waitForPersistedSession(OTHER_SCOPE, (session) =>
      session.messages.some((message) => message.content === 'Text-only question in another scope.')
    )
    expect(otherSession.messages.flatMap((message) => message.attachments || [])).toEqual([])
    otherRemount.unmount()
  })
})
