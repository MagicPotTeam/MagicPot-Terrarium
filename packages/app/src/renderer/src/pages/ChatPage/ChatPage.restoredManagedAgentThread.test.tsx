import { createHash } from 'node:crypto'
import React from 'react'
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
import { requestChatCompletion } from './chatRequestUtils'
import {
  buildChatWorkspaceControlsPortalId,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID
} from './chatPageShared'
import ChatPage from './ChatPage'

// Test-only Fake IndexedDB: this isolates the real chatStorage API in jsdom. It is not an Electron
// restart or a claim about a real desktop IndexedDB process surviving termination.
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

  get(key: string) {
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

  getAll() {
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
    if (!this.state.stores.has(name)) throw new Error(`Missing fake transaction store: ${name}`)
    return new FakeIDBTransaction(this.state.stores)
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
    state,
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
    }
  }
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`
const PNG_BYTES = decodeBase64(PNG_BASE64)
const PNG_HASH = hashBytes(PNG_BYTES)
const PNG_FILE_NAME = 'managed-fixture.png'
const PRIMARY_SCOPE = 'canvas-managed-project-pane'
const SECONDARY_SCOPE = 'canvas-managed-other-pane'
const CANVAS_ROUTE = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project-managed-fixture',
  threadId: 'pane-managed-fixture'
} as const
const SECONDARY_CANVAS_ROUTE = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project-managed-fixture',
  threadId: 'pane-managed-other'
} as const

const fixture = vi.hoisted(() => ({
  notifyError: vi.fn(),
  config: null as Config | null,
  profiles: [] as LLMAPIProfile[],
  ipcChat: vi.fn(),
  materializeForRequest: vi.fn()
}))

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

const managedReference: MediaReference = {
  version: 1,
  kind: 'managed',
  relativePath: 'originals/aa/managed-fixture.png',
  sha256: PNG_HASH,
  sizeBytes: PNG_BYTES.byteLength,
  mimeType: 'image/png',
  originalFileName: PNG_FILE_NAME,
  status: 'ready'
}

const managedAttachment: ChatAttachment = {
  type: 'image',
  url: 'local-media:///managed/originals/aa/managed-fixture.png',
  fileName: PNG_FILE_NAME,
  mimeType: 'image/png',
  sizeBytes: PNG_BYTES.byteLength,
  media: managedReference
}

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: 'managed-vision-fixture',
        model_name: 'Managed Vision Fixture',
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
    notifyError: fixture.notifyError,
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
  fileToBlobUrl: vi.fn(() => 'blob:managed-fixture'),
  fileToDataUrl: vi.fn(async () => PNG_DATA_URL),
  checkFileSize: vi.fn(() => true),
  formatFileSize: vi.fn(() => `${PNG_BYTES.byteLength} B`)
}))

vi.mock('@renderer/utils/droppedImageUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/utils/droppedImageUtils')>()
  return {
    ...actual,
    materializeInternalImageDragAttachment: async (attachment: ChatAttachment) => attachment
  }
})

vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return {
    ...actual,
    // The request implementation remains real; only stream selection is constrained so the
    // test observes the exact unary svcLLMProxy.chat payload.
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
    <pre data-testid="managed-restored-session">{JSON.stringify(currentSession || null)}</pre>
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
    <div data-testid="managed-restored-composer">
      <input
        data-testid="managed-restored-input"
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <button type="button" data-testid="managed-restored-send" onClick={onSend}>
        send
      </button>
    </div>
  )
}))

const readSessionFromUi = (): ChatSession | null => {
  const raw = screen.getByTestId('managed-restored-session').textContent?.trim() || ''
  if (!raw || raw === 'null') return null
  return JSON.parse(raw) as ChatSession
}

const renderPage = (storageScope: string) => {
  const route = storageScope === SECONDARY_SCOPE ? SECONDARY_CANVAS_ROUTE : CANVAS_ROUTE
  return render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <div id={buildChatWorkspaceControlsPortalId(storageScope)} />
        <div id="agent-workspace-skill-portal" />
        <ChatPage compact active storageScope={storageScope} route={route} />
      </ThemeProvider>
    </MemoryRouter>
  )
}

const allRequestMessages = (request: unknown): ChatMessage[] =>
  ((request as { messages?: ChatMessage[] }).messages || []) as ChatMessage[]

const imageAttachmentsInRequest = (request: unknown): ChatAttachment[] =>
  allRequestMessages(request).flatMap((message) =>
    (message.attachments || []).filter((attachment) => attachment.type === 'image')
  )

const requestPayload = (index: number): Record<string, unknown> =>
  fixture.ipcChat.mock.calls[index][0] as Record<string, unknown>

const assertManagedProjection = (
  request: unknown,
  expectedConversationId: string,
  expectedRoute = CANVAS_ROUTE
): void => {
  const payload = request as {
    conversationId?: string
    route?: unknown
  }
  expect(payload.conversationId).toBe(expectedConversationId)
  expect(payload.route).toEqual(expectedRoute)

  const images = imageAttachmentsInRequest(request)
  expect(images).toHaveLength(1)
  expect(images[0]).toMatchObject({
    type: 'image',
    url: PNG_DATA_URL,
    mimeType: 'image/png',
    sizeBytes: PNG_BYTES.byteLength
  })
  expect(images[0]).not.toHaveProperty('media')
  expect(hashBytes(decodeBase64(images[0].url.split(',')[1]))).toBe(PNG_HASH)
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

const waitForUiMessage = async (content: string): Promise<void> => {
  await waitFor(() => {
    expect(readSessionFromUi()?.messages.some((message) => message.content === content)).toBe(true)
  })
}

const sendExternal = async (detail: Record<string, unknown>): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('send-to-agent', { detail }))
  })
}

const sendComposer = async (text: string): Promise<void> => {
  await act(async () => {
    const input = screen.getByTestId('managed-restored-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    screen.getByTestId('managed-restored-send').click()
  })
}

let activeFakeDb: ReturnType<typeof createFakeIndexedDb> | undefined

beforeEach(() => {
  fixture.config = createConfig()
  fixture.profiles = fixture.config.llm_config.api_profiles || []
  fixture.ipcChat.mockReset()
  fixture.materializeForRequest.mockReset()
  fixture.notifyError.mockReset()
  fixture.ipcChat.mockImplementation(async () => ({
    content: `managed-assistant-${fixture.ipcChat.mock.calls.length}`
  }))
  fixture.materializeForRequest.mockImplementation(
    async (request: { reference: MediaReference }) => ({
      transport: 'request-data-url',
      dataUrl: PNG_DATA_URL,
      mimeType: request.reference.mimeType || 'image/png',
      sizeBytes: PNG_BYTES.byteLength
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
  await act(async () => {
    cleanup()
  })
  activeFakeDb?.state.database?.close()
  activeFakeDb = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ChatPage restored managed-agent thread persistence', () => {
  it('persists managed media, restores it for turn three, preserves canvas route identity, and isolates scopes', async () => {
    expect(PNG_BYTES.slice(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]))

    const sessionId = 'managed-restored-session'
    const seededSession: ChatSession = {
      id: sessionId,
      title: 'Managed canvas fixture',
      storageScope: PRIMARY_SCOPE,
      profileId: 'managed-vision-fixture',
      messages: [],
      createdAt: Date.now()
    }
    await saveSessionToDB(seededSession, PRIMARY_SCOPE)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, PRIMARY_SCOPE), sessionId)

    const firstRender = renderPage(PRIMARY_SCOPE)
    await waitFor(() => expect(readSessionFromUi()?.id).toBe(sessionId))

    await sendExternal({
      targetScope: PRIMARY_SCOPE,
      autoSend: true,
      requestId: 'managed-turn-one',
      text: 'Describe the managed canvas image.',
      attachments: [managedAttachment]
    })
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(1))
    assertManagedProjection(requestPayload(0), sessionId)
    expect(fixture.materializeForRequest).toHaveBeenCalledTimes(1)
    expect(fixture.materializeForRequest).toHaveBeenNthCalledWith(1, {
      reference: managedReference,
      transport: 'request-data-url'
    })

    const firstPersisted = await waitForPersistedSession(
      PRIMARY_SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some((message) =>
          message.attachments?.some(
            (attachment) =>
              attachment.url === managedAttachment.url &&
              JSON.stringify(attachment.media) === JSON.stringify(managedReference)
          )
        )
    )
    const firstStoredAttachment = firstPersisted.messages
      .flatMap((message) => message.attachments || [])
      .find((attachment) => attachment.type === 'image')
    expect(firstStoredAttachment).toMatchObject(managedAttachment)
    expect(firstStoredAttachment?.url).toMatch(/^local-media:\/\//)

    await sendComposer('Text-only follow-up for the same canvas thread.')
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(2))
    assertManagedProjection(requestPayload(1), sessionId)
    expect(fixture.materializeForRequest).toHaveBeenCalledTimes(2)
    expect(fixture.materializeForRequest).toHaveBeenNthCalledWith(2, {
      reference: managedReference,
      transport: 'request-data-url'
    })
    await waitForPersistedSession(
      PRIMARY_SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some(
          (message) => message.content === 'Text-only follow-up for the same canvas thread.'
        )
    )
    await waitForUiMessage('Text-only follow-up for the same canvas thread.')

    await act(async () => {
      firstRender.unmount()
    })
    document.body.innerHTML = ''

    const restoredRender = renderPage(PRIMARY_SCOPE)
    await waitFor(() => expect(readSessionFromUi()?.id).toBe(sessionId))
    const restoredSession = readSessionFromUi()
    if (!restoredSession) throw new Error('Managed session did not restore from IndexedDB')
    const restoredAttachment = restoredSession.messages
      .flatMap((message) => message.attachments || [])
      .find((attachment) => attachment.type === 'image')
    expect(restoredAttachment).toMatchObject(managedAttachment)
    expect(restoredAttachment?.url).toMatch(/^local-media:\/\//)

    await sendComposer('Third question after managed-media recovery.')
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(3))
    assertManagedProjection(requestPayload(2), sessionId)
    expect(fixture.materializeForRequest).toHaveBeenCalledTimes(3)
    expect(fixture.materializeForRequest).toHaveBeenNthCalledWith(3, {
      reference: managedReference,
      transport: 'request-data-url'
    })
    expect(allRequestMessages(requestPayload(2))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('Describe the managed canvas image.')
        }),
        expect.objectContaining({ content: 'Text-only follow-up for the same canvas thread.' }),
        expect.objectContaining({ content: 'Third question after managed-media recovery.' })
      ])
    )
    await waitForPersistedSession(
      PRIMARY_SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some(
          (message) => message.content === 'Third question after managed-media recovery.'
        )
    )
    await waitForUiMessage('Third question after managed-media recovery.')
    expect(requestPayload(2).route).toEqual(CANVAS_ROUTE)
    expect(requestPayload(2).conversationId).toBe(sessionId)

    await act(async () => {
      restoredRender.unmount()
    })

    document.body.innerHTML = ''

    expect(await loadAllSessions(SECONDARY_SCOPE)).toEqual([])
    const secondarySessionId = 'managed-other-scope-session'
    await saveSessionToDB(
      {
        id: secondarySessionId,
        title: 'Other canvas scope fixture',
        storageScope: SECONDARY_SCOPE,
        profileId: 'managed-vision-fixture',
        messages: [],
        createdAt: Date.now()
      },
      SECONDARY_SCOPE
    )
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SECONDARY_SCOPE),
      secondarySessionId
    )
    const secondaryRender = renderPage(SECONDARY_SCOPE)
    await waitFor(() => expect(readSessionFromUi()?.id).toBe(secondarySessionId))

    await sendExternal({
      targetScope: SECONDARY_SCOPE,
      autoSend: true,
      requestId: 'managed-other-scope-text',
      text: 'Text-only message in a separate canvas scope.'
    })
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(4))
    const secondaryPayload = requestPayload(3)
    expect(secondaryPayload.conversationId).toBe(secondarySessionId)
    expect(secondaryPayload.route).toEqual(SECONDARY_CANVAS_ROUTE)
    expect(secondaryPayload.route).not.toEqual(CANVAS_ROUTE)
    expect(imageAttachmentsInRequest(secondaryPayload)).toEqual([])
    expect(fixture.materializeForRequest).toHaveBeenCalledTimes(3)
    const secondaryStored = await waitForPersistedSession(
      SECONDARY_SCOPE,
      (session) =>
        session.id === secondarySessionId &&
        session.messages.some(
          (message) => message.content === 'Text-only message in a separate canvas scope.'
        )
    )
    await waitForUiMessage('Text-only message in a separate canvas scope.')
    expect(secondaryStored.messages.flatMap((message) => message.attachments || [])).toEqual([])
    expect(await loadAllSessions(SECONDARY_SCOPE)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessionId })])
    )

    await act(async () => {
      secondaryRender.unmount()
    })
  })

  it('shows a restored third-turn managed-media failure without dispatching IPC', async () => {
    const sessionId = 'managed-restored-missing-media-session'
    await saveSessionToDB(
      {
        id: sessionId,
        title: 'Managed missing-media fixture',
        storageScope: PRIMARY_SCOPE,
        profileId: 'managed-vision-fixture',
        messages: [],
        createdAt: Date.now()
      },
      PRIMARY_SCOPE
    )
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, PRIMARY_SCOPE), sessionId)

    const firstRender = renderPage(PRIMARY_SCOPE)
    await waitFor(() => expect(readSessionFromUi()?.id).toBe(sessionId))
    await sendExternal({
      targetScope: PRIMARY_SCOPE,
      autoSend: true,
      requestId: 'managed-missing-turn-one',
      text: 'Persist this managed image before the restore failure.',
      attachments: [managedAttachment]
    })
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(1))
    assertManagedProjection(requestPayload(0), sessionId)
    await waitForPersistedSession(
      PRIMARY_SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some((message) =>
          message.attachments?.some((attachment) => attachment.media?.sha256 === PNG_HASH)
        )
    )

    await sendComposer('Second message before restore failure.')
    await waitFor(() => expect(fixture.ipcChat).toHaveBeenCalledTimes(2))
    assertManagedProjection(requestPayload(1), sessionId)
    await waitForUiMessage('Second message before restore failure.')

    await act(async () => {
      firstRender.unmount()
    })
    document.body.innerHTML = ''

    const restoredRender = renderPage(PRIMARY_SCOPE)
    await waitFor(() => expect(readSessionFromUi()?.id).toBe(sessionId))
    expect(
      readSessionFromUi()?.messages.some((message) =>
        message.attachments?.some((attachment) => attachment.media?.sha256 === PNG_HASH)
      )
    ).toBe(true)

    const failure = new Error('managed media reference is unavailable after restore')
    fixture.materializeForRequest.mockRejectedValueOnce(failure)
    await sendComposer('Third message with an unavailable restored image.')
    await waitFor(() =>
      expect(
        readSessionFromUi()?.messages.some((message) =>
          message.content.includes('managed media reference is unavailable after restore')
        )
      ).toBe(true)
    )
    expect(fixture.ipcChat).toHaveBeenCalledTimes(2)
    expect(fixture.materializeForRequest).toHaveBeenCalledTimes(3)
    expect(fixture.materializeForRequest).toHaveBeenNthCalledWith(3, {
      reference: managedReference,
      transport: 'request-data-url'
    })
    await waitForPersistedSession(
      PRIMARY_SCOPE,
      (session) =>
        session.id === sessionId &&
        session.messages.some((message) =>
          message.content.includes('managed media reference is unavailable after restore')
        )
    )

    await act(async () => {
      restoredRender.unmount()
    })
  })
})
