import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { ChatSessionSaveConflictError, ChatSessionSaveSupersededError, normalizedSessionsEqual, type ChatSession } from './chatStorage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

// Synthetic storage only: IndexedDB reads and the guarded write are fakes, while the real debounced
// save queue and the real baseline writer (persistLatest) run on top of them. fetch fails closed.
type SaveOptions = { expectedSession?: ChatSession | null; shouldUpdate?: () => boolean }
type SaveCall = { session: ChatSession; expected: ChatSession | null | undefined; outcome: 'written' | 'conflict' | 'superseded' }
const h = vi.hoisted(() => ({
  sessions: [] as ChatSession[],
  saves: [] as Array<{ session: ChatSession; expected: ChatSession | null | undefined; outcome: 'written' | 'conflict' | 'superseded' }>,
  notify: vi.fn(),
  notifyWarning: vi.fn(),
  notifySuccess: vi.fn(),
  notifyInfo: vi.fn(),
  updateConfig: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  stream: vi.fn(),
  fetch: vi.fn()
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key, i18n: { language: 'en', resolvedLanguage: 'en' } }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [], customSkills: [], customSkillCategories: [] } } as Config, isReady: true, buildEnv: { ...DEFAULT_BUILD_ENV }, configUtils: {}, updateConfig: h.updateConfig }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
// Stable callbacks, as the real hook returns them; only notifyError is swapped to force a same-scope reload.
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifyError: h.notify, notifyWarning: h.notifyWarning, notifySuccess: h.notifySuccess, notifyInfo: h.notifyInfo }) }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: [{ id: 'base-model', model_name: 'Base', model_use: 'chat' }], remoteProfiles: [] }) }))
vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  return {
    ...actual,
    loadAllSessions: (...args: unknown[]) => h.load(...args),
    loadSessionFromDB: async (id: string) => structuredClone(h.sessions.find(s => s.id === id) ?? null),
    saveSessionToDB: (...args: unknown[]) => h.save(...args),
    saveAllSessions: vi.fn(),
    compareAndUpdateSessionInDB: vi.fn(),
    deleteSessionFromDB: vi.fn(),
    deleteSessionDraftBackup: vi.fn(),
    migrateFromLocalStorage: vi.fn(async () => null),
    readSessionDraftBackup: vi.fn(),
    hasSessionDeleteTombstone: vi.fn(() => false),
    readSessionDeleteTombstones: vi.fn(() => []),
    setSessionDeleteTombstone: vi.fn(),
    writeSessionDraftBackup: vi.fn()
  }
})
vi.mock('./components/SessionSidebar', () => ({ default: () => <div /> }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('@renderer/utils/fileUtils', () => ({ selectFile: vi.fn(), fileToBlobUrl: vi.fn(), fileToDataUrl: vi.fn(), checkFileSize: vi.fn(() => true), formatFileSize: vi.fn(() => '1 B') }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcAgentLocalFiles: {}, svcFs: {}, svcLLMProxy: {}, svcHyper: {}, svcManagedMedia: {} }) }))
vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return {
    ...actual,
    requestChatCompletion: vi.fn(async () => { throw new Error('Non-streaming request forbidden in fixture') }),
    requestChatCompletionStream: (...args: unknown[]) => h.stream(...args),
    supportsStreamingChatCompletion: () => true
  }
})
vi.mock('./components/ChatComposer', () => ({
  default: function ComposerMock({ inputValue, onInputChange, onSend }: { inputValue: string; onInputChange: (value: string) => void; onSend: () => void }) {
    return <div data-testid="composer"><input data-testid="composer-input" value={inputValue} onChange={event => onInputChange(event.target.value)} /><button type="button" data-testid="composer-send" onClick={onSend}>send</button></div>
  }
}))
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession }: { currentSession?: ChatSession }) => <output data-testid="session">{currentSession?.messages.map(m => m.content).join('|')}</output> }))

const scope = 'reload-local-edit-fixture'
const session: ChatSession = { id: 'reload-target', title: 'Fixture', profileId: 'base-model', messages: [{ role: 'user', content: 'original' }], createdAt: 299 }
const theme = createTheme()
const page = () => <MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scope} active /></ThemeProvider></MemoryRouter>
const shown = () => screen.getByTestId('session').textContent
const append = (content: string) => act(async () => {
  window.dispatchEvent(new CustomEvent('chat:append-message', { detail: { scope, sessionId: session.id, role: 'user', content } }))
})
const settle = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
// A same-scope reload of the page: the notifyError identity is a load-effect dependency.
const reloadWith = async (view: ReturnType<typeof render>, read: () => Promise<ChatSession[]>) => {
  let started = false
  h.load.mockImplementationOnce(() => { started = true; return read() })
  h.notify = vi.fn()
  view.rerender(page())
  await waitFor(() => expect(started).toBe(true))
}
const pending = () => {
  let release!: (value: ChatSession[]) => void
  let fail!: (error: Error) => void
  const promise = new Promise<ChatSession[]>((resolve, reject) => { release = resolve; fail = reject })
  return { promise, release, fail }
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  h.sessions = [structuredClone(session)]
  h.saves = []
  h.load.mockReset().mockImplementation(async () => structuredClone(h.sessions))
  // A guarded write with the same compare-and-set contract as saveSessionToDB.
  h.save.mockReset().mockImplementation(async (candidate: ChatSession, saveScope: string, options?: SaveOptions) => {
    const stored = h.sessions.find(s => s.id === candidate.id)
    const guarded = Boolean(options && Object.hasOwn(options, 'expectedSession'))
    const expected = options?.expectedSession
    const call: SaveCall = { session: structuredClone(candidate), expected: expected && structuredClone(expected), outcome: 'written' }
    h.saves.push(call)
    if (guarded && !(expected === null ? !stored : stored && expected && normalizedSessionsEqual(stored, expected, saveScope))) {
      call.outcome = 'conflict'
      throw new ChatSessionSaveConflictError(candidate.id, saveScope)
    }
    if (options?.shouldUpdate && !options.shouldUpdate()) {
      call.outcome = 'superseded'
      throw new ChatSessionSaveSupersededError()
    }
    h.sessions = [...h.sessions.filter(s => s.id !== candidate.id), structuredClone(candidate)]
  })
  h.notify = vi.fn()
  h.stream.mockReset().mockRejectedValue(new Error('Model request forbidden in fixture'))
  h.fetch.mockReset().mockRejectedValue(new Error('Network forbidden in fixture'))
  vi.stubGlobal('fetch', h.fetch)
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), session.id)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('ChatPage keeps local edits made while a same-scope read is pending', () => {
  it('keeps a local append made during a pending same-scope reload and saves it once against the pre-load snapshot', async () => {
    const view = render(page())
    const read = pending()
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      const preLoad = structuredClone(h.sessions[0])
      await reloadWith(view, () => read.promise)
      await append('local update')
      expect(shown()).toBe('original|local update')
      await act(async () => read.release(structuredClone(h.sessions)))
      expect(shown()).toBe('original|local update')
      await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 3000 })
      expect(h.saves[0]).toEqual({ session: expect.objectContaining({ id: session.id, messages: [{ role: 'user', content: 'original' }, { role: 'user', content: 'local update' }] }), expected: preLoad, outcome: 'written' })
      expect(h.sessions[0].messages.map(m => m.content)).toEqual(['original', 'local update'])
      await settle(1200)
      expect(h.saves).toHaveLength(1)
      expect(shown()).toBe('original|local update')
      expect(screen.queryByText(/Failed to save chat session/)).toBeNull()
      expect(h.fetch).not.toHaveBeenCalled()
    } finally { read.release(structuredClone(h.sessions)); view.unmount() }
  })

  it('keeps the dirty copy and refuses the save when storage changed while the reload was pending', async () => {
    const view = render(page())
    const read = pending()
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      const preLoad = structuredClone(h.sessions[0])
      await reloadWith(view, () => read.promise)
      await append('local update')
      // Another writer commits a newer record before the reload's read returns it.
      const external: ChatSession = { ...structuredClone(session), messages: [...session.messages, { role: 'assistant', content: 'other writer' }] }
      h.sessions = [structuredClone(external)]
      await act(async () => read.release(structuredClone(h.sessions)))
      expect(shown()).toBe('original|local update')
      await waitFor(() => expect(h.saves.length).toBeGreaterThanOrEqual(1), { timeout: 3000 })
      await waitFor(() => expect(screen.getByText(/Failed to save chat session/)).toBeInTheDocument())
      // Every attempt is refused by the compare-and-set: none of them carried the newer stored copy as its baseline.
      for (const call of h.saves) expect(call).toEqual(expect.objectContaining({ expected: preLoad, outcome: 'conflict' }))
      expect(h.sessions).toEqual([external])
      expect(shown()).toBe('original|local update')
      expect(screen.getAllByText(/Failed to save chat session/)).toHaveLength(1)
      expect(h.notify).not.toHaveBeenCalled()
      expect(h.fetch).not.toHaveBeenCalled()
    } finally { read.release(structuredClone(h.sessions)); view.unmount() }
  })

  it('does not let a refresh that runs while the gate is still on after a failed reload drop a gated local edit', async () => {
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      const preLoad = structuredClone(h.sessions[0])
      await reloadWith(view, async () => { throw new Error('fixture read failed') })
      await waitFor(() => expect(screen.getByText(/Failed to load chat sessions: fixture read failed/)).toBeInTheDocument())
      await append('local update')
      expect(shown()).toBe('original|local update')
      // A refresh whose read is still pending when a further local edit lands must not merge that read.
      const stale = pending()
      let staleStarted = false
      h.load.mockImplementationOnce(() => { staleStarted = true; return stale.promise })
      await act(async () => { window.dispatchEvent(new CustomEvent('chat:preview-refresh', { detail: { scope, reason: 'storage-updated' } })) })
      await waitFor(() => expect(staleStarted).toBe(true))
      await append('second update')
      await act(async () => stale.release(structuredClone(h.sessions)))
      expect(shown()).toBe('original|local update|second update')
      expect(screen.getByText(/Failed to load chat sessions: fixture read failed/)).toBeInTheDocument()
      expect(h.saves).toHaveLength(0)
      // The next refresh merges, keeps both gated edits and saves them against the pre-load snapshot.
      await act(async () => { window.dispatchEvent(new CustomEvent('chat:preview-refresh', { detail: { scope, reason: 'storage-updated' } })) })
      await waitFor(() => expect(screen.queryByText(/Failed to load chat sessions/)).toBeNull())
      expect(shown()).toBe('original|local update|second update')
      await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 3000 })
      expect(h.saves[0]).toEqual(expect.objectContaining({ expected: preLoad, outcome: 'written' }))
      expect(h.sessions[0].messages.map(m => m.content)).toEqual(['original', 'local update', 'second update'])
      expect(h.fetch).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('keeps a streaming delta that lands while a same-scope reload is pending', async () => {
    let request!: { onEvent: (event: unknown) => void; signal: AbortSignal }
    let finish!: (value: unknown) => void
    h.stream.mockImplementation((input: typeof request) => { request = input; return new Promise(resolve => { finish = resolve }) })
    const view = render(page())
    const read = pending()
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'fixture request' } })
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(request).toBeDefined())
      // The user turn and the empty reply placeholder are saved before the reload starts.
      await waitFor(() => expect(h.sessions[0].messages.map(m => m.content)).toEqual(['original', 'fixture request', '']), { timeout: 3000 })
      const preLoad = structuredClone(h.sessions[0])
      const savesBeforeReload = h.saves.length
      await reloadWith(view, () => read.promise)
      await act(async () => request.onEvent({ type: 'text-delta', delta: 'streamed part' }))
      expect(shown()).toBe('original|fixture request|streamed part')
      await act(async () => read.release(structuredClone(h.sessions)))
      expect(shown()).toBe('original|fixture request|streamed part')
      expect(request.signal.aborted).toBe(false)
      await waitFor(() => expect(h.saves.length).toBeGreaterThan(savesBeforeReload), { timeout: 3000 })
      expect(h.saves[savesBeforeReload]).toEqual(expect.objectContaining({ expected: preLoad, outcome: 'written' }))
      expect(h.sessions[0].messages.map(m => m.content)).toEqual(['original', 'fixture request', 'streamed part'])
      expect(h.saves.every(call => call.outcome === 'written')).toBe(true)
      expect(h.fetch).not.toHaveBeenCalled()
    } finally {
      read.release(structuredClone(h.sessions))
      await act(async () => finish?.({ result: { content: 'streamed part' }, response: 'streamed part' }))
      view.unmount()
    }
  })
})
