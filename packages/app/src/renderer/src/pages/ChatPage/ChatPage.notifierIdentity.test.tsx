import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type { ChatSession } from './chatStorage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

// Session loading and draft persistence must not depend on the identity of the toast functions.
// The real useMessage hook returns memoised callbacks, but a caller (or a test double) that hands
// out new functions on every render used to restart the session load on every render and let the
// draft-flush cleanup write the still-empty composer over the stored draft.
// notifyError stays stable here on purpose: the session-load effect still lists it, and
// ChatPage.runtimeFlow ('keeps a confirmed draft and recovers through Retry when the same-scope
// initial reload read is stale') uses one notifyError identity change as its same-scope reload trigger.
const f = vi.hoisted(() => ({
  config: null as Config | null,
  store: new Map<string, Map<string, ChatSession>>(),
  load: vi.fn(),
  save: vi.fn(),
  freshNotifiers: false,
  stable: { notifySuccess: vi.fn(), notifyInfo: vi.fn(), notifyWarning: vi.fn(), notifyError: vi.fn() },
  request: vi.fn(),
  fetch: vi.fn(),
  forbidden: vi.fn(),
  dispatch: vi.fn()
}))
vi.mock('react-redux', () => ({ useDispatch: () => f.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en', resolvedLanguage: 'en' }, t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: f.config, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: {}, updateConfig: vi.fn() }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => f.freshNotifiers
    ? { notifySuccess: vi.fn(), notifyInfo: vi.fn(), notifyWarning: vi.fn(), notifyError: f.stable.notifyError }
    : f.stable
}))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: [{ id: 'fixture', model_name: 'fixture', model_use: 'chat' }], remoteProfiles: [] }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcFs: {}, svcHyper: {}, svcManagedMedia: { importDataUrl: f.forbidden, importFile: f.forbidden }, svcLLMProxy: { chat: f.request, chatStream: f.request, signHy3DModel: f.forbidden } }) }))
vi.mock('@renderer/utils/fileUtils', () => ({ fileToDataUrl: f.forbidden, fileToBlobUrl: f.forbidden, selectFile: f.forbidden, checkFileSize: () => true, isImageFile: () => true }))
vi.mock('@renderer/utils/messageUtils', () => ({ getMessageText: (message: { content?: string }) => message.content || '' }))
vi.mock('./chatStorage', async original => ({
  ...await original<typeof import('./chatStorage')>(),
  loadAllSessions: (scope: string) => f.load(scope),
  saveSessionToDB: (session: ChatSession, scope: string) => f.save(session, scope),
  debouncedSaveSessions: () => undefined,
  cancelDebouncedSessionSave: () => undefined,
  saveChatSessions: () => undefined,
  loadChatSessionBackups: () => ({}),
  saveChatSessionBackups: () => undefined,
  migrateFromLocalStorage: async () => null
}))
vi.mock('./chatRequestUtils', async original => ({ ...await original<typeof import('./chatRequestUtils')>(), requestChatCompletion: f.request, requestChatCompletionStream: f.request, supportsStreamingChatCompletion: () => false }))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, pendingAttachments }: { inputValue: string; pendingAttachments: ChatAttachment[] }) => <div><input data-testid="composer" value={inputValue} readOnly /><pre data-testid="pending">{JSON.stringify(pendingAttachments)}</pre></div> }))
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession }: { currentSession?: ChatSession }) => <span data-testid="session">{currentSession?.id}</span> }))

const scopeA = 'notifier-identity-a', scopeB = 'notifier-identity-b'
const sessionId = (scope: string) => `session-${scope}`
const draftText = (scope: string) => `draft-${scope}`
const session = (scope: string): ChatSession => ({ id: sessionId(scope), title: 'fixture', storageScope: scope, profileId: 'fixture', messages: [{ role: 'user', content: 'original' }], draft: { inputValue: draftText(scope), pendingAttachments: [], pendingHiddenContext: '', updatedAt: 1 } })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const readStore = (scope: string) => structuredClone([...(f.store.get(scope)?.values() ?? [])])
const page = (scope: string) => <ThemeProvider theme={createTheme()}><MemoryRouter><ChatPage storageScope={scope} /></MemoryRouter></ThemeProvider>
const loadsFor = (scope: string) => f.load.mock.calls.filter(([candidate]) => candidate === scope).length
const settle = async (ms: number) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }

async function expectRestored(scope: string) {
  await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent(sessionId(scope)))
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveValue(draftText(scope)))
}

function expectStoredDraftIntact(scope: string) {
  expect(f.store.get(scope)?.get(sessionId(scope))?.draft?.inputValue).toBe(draftText(scope))
  // No intermediate write may have stripped or replaced the stored draft either.
  for (const [saved, savedScope] of f.save.mock.calls as Array<[ChatSession, string]>) {
    if (savedScope === scope && saved.id === sessionId(scope)) expect(saved.draft?.inputValue).toBe(draftText(scope))
  }
}

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear()
  f.config = structuredClone(DEFAULT_CONFIG); f.config.use_remote_llm = false
  f.freshNotifiers = false
  f.store = new Map([scopeA, scopeB].map(scope => [scope, new Map([[sessionId(scope), session(scope)]])]))
  for (const scope of [scopeA, scopeB]) localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), sessionId(scope))
  f.load.mockImplementation(async (scope: string) => readStore(scope))
  f.save.mockImplementation(async (saved: ChatSession, scope: string) => {
    const records = f.store.get(scope) ?? new Map<string, ChatSession>()
    records.set(saved.id, structuredClone(saved)); f.store.set(scope, records)
  })
  f.fetch.mockImplementation(() => { throw new Error('Unexpected fetch: forbidden') })
  f.forbidden.mockImplementation(() => { throw new Error('Unexpected file or managed media access: forbidden') })
  f.request.mockImplementation(() => { throw new Error('Unexpected request: forbidden') })
  vi.stubGlobal('fetch', f.fetch); vi.stubGlobal('api', { svcLLMProxy: { chat: f.request, chatStream: f.request }, svcManagedMedia: {} })
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(async () => { cleanup(); await act(async () => {}); expect(f.fetch).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

describe('ChatPage notifier identity', () => {
  it('loads the scope once and keeps the restored draft when toast functions change on every render', async () => {
    f.freshNotifiers = true
    render(page(scopeA))
    await expectRestored(scopeA)
    await settle(300)
    expect(screen.getByTestId('composer')).toHaveValue(draftText(scopeA))
    expect(loadsFor(scopeA)).toBe(1)
    expectStoredDraftIntact(scopeA)
  })

  // Regression for the draft-flush hazard behind the notifier trigger (reported to K1): the
  // flush effect's cleanup writes whatever the composer holds whenever flushSessionDraft changes
  // identity. A scope change is the other prop that changes persistDraftSnapshot's identity; it
  // happens here while the new scope's draft is not restored yet.
  it('keeps both stored drafts when the scope changes before the new scope draft is restored', async () => {
    const view = render(page(scopeA))
    await expectRestored(scopeA)
    const loadB = deferred<ChatSession[]>()
    f.load.mockImplementation((scope: string) => scope === scopeB ? loadB.promise : Promise.resolve(readStore(scope)))
    try {
      view.rerender(page(scopeB))
      await settle(50)
      await act(async () => { loadB.resolve(readStore(scopeB)); await loadB.promise })
      await expectRestored(scopeB)
      await settle(300)
      expect(screen.getByTestId('composer')).toHaveValue(draftText(scopeB))
      expectStoredDraftIntact(scopeA)
      expectStoredDraftIntact(scopeB)
    } finally { loadB.resolve(readStore(scopeB)) }
  })

  it('keeps both stored drafts when the scope changes before the first scope draft is restored', async () => {
    const loadA = deferred<ChatSession[]>()
    f.load.mockImplementation((scope: string) => scope === scopeA ? loadA.promise : Promise.resolve(readStore(scope)))
    try {
      const view = render(page(scopeA))
      await waitFor(() => expect(f.load).toHaveBeenCalledWith(scopeA))
      view.rerender(page(scopeB))
      await act(async () => { loadA.resolve(readStore(scopeA)); await loadA.promise })
      await expectRestored(scopeB)
      await settle(300)
      expect(screen.getByTestId('composer')).toHaveValue(draftText(scopeB))
      expectStoredDraftIntact(scopeA)
      expectStoredDraftIntact(scopeB)
    } finally { loadA.resolve(readStore(scopeA)) }
  })
})
