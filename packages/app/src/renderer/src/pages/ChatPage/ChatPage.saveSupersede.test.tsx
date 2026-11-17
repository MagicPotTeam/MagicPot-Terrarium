import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { ChatSessionSaveConflictError, ChatSessionSaveSupersededError, normalizedSessionsEqual, type ChatSession } from './chatStorage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

// Synthetic storage only: the IndexedDB read and the guarded write are a fake with the same
// read -> compare-and-set -> put contract as saveSessionToDB, while the real debounced save queue
// and the real baseline writer (persistLatest) run on top of it. Model requests and fetch fail closed.
type SaveOptions = { expectedSession?: ChatSession | null; shouldUpdate?: () => boolean }
type SaveCall = { session: ChatSession; expected: ChatSession | null | undefined; outcome: 'written' | 'conflict' | 'superseded' }
const h = vi.hoisted(() => ({
  sessions: [] as ChatSession[],
  saves: [] as Array<{ session: ChatSession; expected: ChatSession | null | undefined; outcome: 'written' | 'conflict' | 'superseded' }>,
  // Runs while a save's read is pending, before its compare-and-set and put.
  whileReadPending: null as null | ((candidate: ChatSession) => void),
  // Makes the writer refuse a candidate as superseded although the live object was never replaced.
  forceSupersede: null as null | ((candidate: ChatSession) => boolean),
  // Awaited after whileReadPending, so the page can render (and run its save effect) mid-save.
  afterReadPending: null as null | ((candidate: ChatSession) => Promise<void>),
  // Makes a save fail with this error (before the compare-and-set), as persistLatest's own refusals do.
  forceError: null as null | ((candidate: ChatSession) => Error | null),
  // Every debouncedSaveSessions call of the page: [session ids, options].
  registrations: [] as Array<{ ids: string[]; options: unknown }>,
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
    debouncedSaveSessions: (...args: Parameters<typeof actual.debouncedSaveSessions>) => {
      h.registrations.push({ ids: args[0].map(s => s.id), options: args[3] })
      return actual.debouncedSaveSessions(...args)
    },
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

const scope = 'save-supersede-fixture'
const session: ChatSession = { id: 'supersede-target', title: 'Fixture', profileId: 'base-model', messages: [{ role: 'user', content: 'original' }], createdAt: 299 }
const theme = createTheme()
const page = () => <MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scope} active /></ThemeProvider></MemoryRouter>
const shown = () => screen.getByTestId('session').textContent
const appendEvent = (content: string) =>
  window.dispatchEvent(new CustomEvent('chat:append-message', { detail: { scope, sessionId: session.id, role: 'user', content } }))
const append = (content: string) => act(async () => { appendEvent(content) })
const settle = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
const banner = () => screen.queryByText(/Failed to save chat session/)
const saveErrorsNotified = () => h.notify.mock.calls.filter(([message]) => /Failed to save/.test(String(message)))
const stored = () => h.sessions.find(s => s.id === session.id)
const contents = (value?: ChatSession) => value?.messages.map(m => m.content)
// A same-scope reload of the page: the notifyError identity is a load-effect dependency.
const reloadWith = async (view: ReturnType<typeof render>, read: () => Promise<ChatSession[]>) => {
  let started = false
  h.load.mockImplementationOnce(() => { started = true; return read() })
  h.notify = vi.fn()
  view.rerender(page())
  await waitFor(() => expect(started).toBe(true))
}
// Advance fake time one second per act(), so effects scheduled by a fired timer (a retry
// re-render, a new debounced save) run before the next second is advanced.
const advanceSeconds = async (seconds: number) => {
  for (let second = 0; second < seconds; second++) await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
}
const pending = () => {
  let release!: (value: ChatSession[]) => void
  const promise = new Promise<ChatSession[]>((resolve) => { release = resolve })
  return { promise, release }
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  h.sessions = [structuredClone(session)]
  h.saves = []
  h.whileReadPending = null
  h.forceSupersede = null
  h.afterReadPending = null
  h.forceError = null
  h.registrations = []
  h.load.mockReset().mockImplementation(async () => structuredClone(h.sessions))
  // Same contract as saveSessionToDB: the read is pending first, then the compare-and-set
  // (conflict when storage no longer equals the baseline), then the supersede check (the caller's
  // live object was replaced while the read was pending), then the put.
  h.save.mockReset().mockImplementation(async (candidate: ChatSession, saveScope: string, options?: SaveOptions) => {
    await Promise.resolve()
    h.whileReadPending?.(candidate)
    if (h.afterReadPending) await h.afterReadPending(candidate)
    const current = h.sessions.find(s => s.id === candidate.id)
    const guarded = Boolean(options && Object.hasOwn(options, 'expectedSession'))
    const expected = options?.expectedSession
    const call: SaveCall = { session: structuredClone(candidate), expected: expected && structuredClone(expected), outcome: 'written' }
    h.saves.push(call)
    const forced = h.forceError?.(candidate)
    if (forced) {
      call.outcome = 'conflict'
      throw forced
    }
    if (guarded && !(expected === null ? !current : current && expected && normalizedSessionsEqual(current, expected, saveScope))) {
      call.outcome = 'conflict'
      throw new ChatSessionSaveConflictError(candidate.id, saveScope)
    }
    if (options?.shouldUpdate && (!options.shouldUpdate() || h.forceSupersede?.(candidate))) {
      call.outcome = 'superseded'
      throw new ChatSessionSaveSupersededError()
    }
    h.sessions = [...h.sessions.filter(s => s.id !== candidate.id), structuredClone(candidate)]
  })
  h.notify = vi.fn()
  h.notifyWarning.mockReset()
  h.stream.mockReset().mockRejectedValue(new Error('Model request forbidden in fixture'))
  h.fetch.mockReset().mockRejectedValue(new Error('Network forbidden in fixture'))
  vi.stubGlobal('fetch', h.fetch)
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), session.id)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('ChatPage treats a superseded save as benign and stops retrying a permanent conflict', () => {
  it('does not report the debounced save of a session replaced while its read was pending, and stores the final snapshot', async () => {
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      // The first save of 'first edit' sees the session replaced by 'second edit' before its put.
      h.whileReadPending = (candidate) => {
        if (candidate.messages.at(-1)?.content !== 'first edit') return
        h.whileReadPending = null
        appendEvent('second edit')
      }
      await append('first edit')
      await waitFor(() => expect(h.saves.some(call => call.outcome === 'superseded')).toBe(true), { timeout: 3000 })
      // Shorter than the 500 ms debounce of the newer object: any report here comes from the superseded save.
      await settle(150)
      expect(banner()).toBeNull()
      expect(saveErrorsNotified()).toEqual([])
      await waitFor(() => expect(contents(stored())).toEqual(['original', 'first edit', 'second edit']), { timeout: 3000 })
      await settle(900)
      expect(shown()).toBe('original|first edit|second edit')
      expect(normalizedSessionsEqual(stored()!, h.saves.at(-1)!.session, scope)).toBe(true)
      expect(contents(stored())).toEqual(['original', 'first edit', 'second edit'])
      expect(h.saves.filter(call => call.outcome === 'conflict')).toEqual([])
      expect(banner()).toBeNull()
      expect(h.notify).not.toHaveBeenCalled()
      expect(h.fetch).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('does not report a request placeholder save whose session keeps being replaced while its read is pending', async () => {
    let finish!: (value: unknown) => void
    h.stream.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      // Three replacements in a row: more than the writer's own retries, so the page's follow-up save is needed.
      let replacements = 0
      h.whileReadPending = (candidate) => {
        const last = candidate.messages.at(-1)
        if (replacements >= 3 || !candidate.messages.some(m => m.content === 'fixture request') || last?.role !== 'assistant' && !last?.content.startsWith('canvas note')) return
        replacements += 1
        appendEvent(`canvas note ${replacements}`)
      }
      fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'fixture request' } })
      fireEvent.click(screen.getByTestId('composer-send'))
      await waitFor(() => expect(replacements).toBe(3), { timeout: 3000 })
      await waitFor(() => expect(contents(stored())).toEqual(['original', 'fixture request', '', 'canvas note 1', 'canvas note 2', 'canvas note 3']), { timeout: 3000 })
      expect(h.saves.filter(call => call.outcome === 'superseded').length).toBeGreaterThanOrEqual(3)
      await settle(900)
      expect(banner()).toBeNull()
      expect(saveErrorsNotified()).toEqual([])
      expect(h.saves.filter(call => call.outcome === 'conflict')).toEqual([])
      expect(contents(stored())).toEqual(['original', 'fixture request', '', 'canvas note 1', 'canvas note 2', 'canvas note 3'])
      expect(h.fetch).not.toHaveBeenCalled()
    } finally {
      await act(async () => finish?.({ result: { content: 'done' }, response: 'done' }))
      view.unmount()
    }
  })

  it('reports a second writer conflict once and makes no further save attempt in the next 120 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      // Another writer commits a newer record; this page's baseline is still the original.
      const external: ChatSession = { ...structuredClone(session), messages: [...session.messages, { role: 'assistant', content: 'other writer' }] }
      h.sessions = [structuredClone(external)]
      await append('local edit')
      await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 3000 })
      const attempts = h.saves.length
      expect(attempts).toBeGreaterThanOrEqual(1)
      expect(h.saves.every(call => call.outcome === 'conflict')).toBe(true)
      await advanceSeconds(120)
      expect(h.saves).toHaveLength(attempts)
      expect(screen.getAllByText(/Failed to save chat session/)).toHaveLength(1)
      expect(saveErrorsNotified()).toEqual([])
      // The newer record is untouched and the local edit stays visible and dirty.
      expect(h.sessions).toEqual([external])
      expect(shown()).toBe('original|local edit')
      // An explicit Retry still tries once more and says so.
      fireEvent.click(screen.getByRole('button', { name: /retry/i }))
      await waitFor(() => expect(h.saves).toHaveLength(attempts + 1))
      expect(h.saves.at(-1)?.outcome).toBe('conflict')
      await waitFor(() => expect(saveErrorsNotified()).toHaveLength(1))
      await advanceSeconds(120)
      expect(h.saves).toHaveLength(attempts + 1)
      expect(h.sessions).toEqual([external])
      expect(h.fetch).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('surfaces exactly one error without a save loop when a kept local edit meets a newer stored copy after a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const view = render(page())
    const read = pending()
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      const preLoad = structuredClone(h.sessions[0])
      await reloadWith(view, () => read.promise)
      await append('local update')
      const external: ChatSession = { ...structuredClone(session), messages: [...session.messages, { role: 'assistant', content: 'other writer' }] }
      h.sessions = [structuredClone(external)]
      await act(async () => read.release(structuredClone(h.sessions)))
      expect(shown()).toBe('original|local update')
      await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 3000 })
      const attempts = h.saves.length
      for (const call of h.saves) expect(call).toEqual(expect.objectContaining({ expected: preLoad, outcome: 'conflict' }))
      await advanceSeconds(120)
      expect(h.saves).toHaveLength(attempts)
      expect(screen.getAllByText(/Failed to save chat session/)).toHaveLength(1)
      expect(h.notify).not.toHaveBeenCalled()
      expect(h.sessions).toEqual([external])
      expect(shown()).toBe('original|local update')
      expect(h.fetch).not.toHaveBeenCalled()
    } finally { read.release(structuredClone(h.sessions)); view.unmount() }
  })

  it('saves a session holding a NaN value instead of retrying it silently forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      // NaN !== NaN: before, this session could never equal its own copy and every save was superseded.
      await act(async () => {
        window.dispatchEvent(new CustomEvent('chat:append-message', { detail: { scope, sessionId: session.id, role: 'user', content: 'nan edit', ocrResult: { kind: 'text', text: 'x', boxes: [{ x: 0, y: 0, width: 1, height: 1, confidence: NaN }] } } }))
      })
      await advanceSeconds(10)
      expect(contents(stored())).toEqual(['original', 'nan edit'])
      expect(Number.isNaN(stored()!.messages[1].ocrResult?.boxes?.[0].confidence)).toBe(true)
      expect(h.saves.map(call => call.outcome)).toEqual(['written'])
      // The stored record and the new baseline both hold the NaN: the next edit still matches them.
      await append('after nan')
      await advanceSeconds(10)
      expect(contents(stored())).toEqual(['original', 'nan edit', 'after nan'])
      expect(h.saves.map(call => call.outcome)).toEqual(['written', 'written'])
      expect(banner()).toBeNull()
      expect(h.notify).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('reports a supersede of an unchanged session object once and backs off instead of looping', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      h.forceSupersede = candidate => candidate.messages.some(m => m.content === 'stuck edit')
      await append('stuck edit')
      await advanceSeconds(5)
      expect(banner()).not.toBeNull()
      const early = h.saves.length
      expect(early).toBeGreaterThanOrEqual(3)
      expect(early).toBeLessThanOrEqual(6)
      expect(h.saves.every(call => call.outcome === 'superseded')).toBe(true)
      // Re-queued every 500 ms this would be about 240 attempts; the 1-30 s backoff makes about 8.
      await advanceSeconds(120)
      expect(h.saves.length - early).toBeLessThanOrEqual(10)
      expect(screen.getAllByText(/Failed to save chat session/)).toHaveLength(1)
      expect(contents(stored())).toEqual(['original'])
      expect(shown()).toBe('original|stuck edit')
      // The edit is still dirty: once the writer accepts it, the next backoff retry stores it.
      h.forceSupersede = null
      await advanceSeconds(31)
      expect(contents(stored())).toEqual(['original', 'stuck edit'])
      expect(banner()).toBeNull()
      expect(h.saves.filter(call => call.outcome === 'conflict')).toEqual([])
    } finally { view.unmount() }
  })

  it('records the refused live object, not the registered one, so the refused payload is not tried again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      const external: ChatSession = { ...structuredClone(session), messages: [...session.messages, { role: 'assistant', content: 'other writer' }] }
      // The registered object holds 'first edit'. While its read is pending the live object becomes
      // 'second edit', so persistLatest's own retry sends the live object, which a second writer refuses.
      h.whileReadPending = (candidate) => {
        const last = candidate.messages.at(-1)?.content
        if (last === 'first edit') appendEvent('second edit')
        if (last === 'second edit') { h.whileReadPending = null; h.sessions = [structuredClone(external)] }
      }
      await append('first edit')
      await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 3000 })
      await advanceSeconds(120)
      expect(shown()).toBe('original|first edit|second edit')
      expect(h.saves.map(call => [contents(call.session)?.at(-1), call.outcome])).toEqual([['first edit', 'superseded'], ['second edit', 'conflict']])
      expect(screen.getAllByText(/Failed to save chat session/)).toHaveLength(1)
      expect(h.sessions).toEqual([external])
      // The explicit Retry still tries the refused object once more.
      fireEvent.click(screen.getByRole('button', { name: /retry/i }))
      await waitFor(() => expect(h.saves).toHaveLength(3))
      expect(h.saves.at(-1)?.outcome).toBe('conflict')
      expect(h.sessions).toEqual([external])
    } finally { view.unmount() }
  })

  it('re-queues a superseded save with the newest effect options, not its own stale closure', async () => {
    const other: ChatSession = { id: 'supersede-other', title: 'Other', profileId: 'base-model', messages: [{ role: 'user', content: 'other original' }], createdAt: 298 }
    h.sessions = [structuredClone(session), structuredClone(other)]
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      // The save of 'first edit' is superseded although its object was never replaced (a one-off
      // refusal). Meanwhile another session changes, so a newer effect run registers its own options.
      let refusedOnce = false
      h.forceSupersede = candidate => {
        if (refusedOnce || candidate.messages.at(-1)?.content !== 'first edit') return false
        refusedOnce = true
        return true
      }
      h.afterReadPending = async (candidate) => {
        if (candidate.messages.at(-1)?.content !== 'first edit' || refusedOnce) return
        window.dispatchEvent(new CustomEvent('chat:append-message', { detail: { scope, sessionId: other.id, role: 'user', content: 'other edit' } }))
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      await append('first edit')
      await waitFor(() => expect(contents(stored())).toEqual(['original', 'first edit']), { timeout: 4000 })
      await waitFor(() => expect(contents(h.sessions.find(s => s.id === other.id))).toEqual(['other original', 'other edit']), { timeout: 4000 })
      const otherRegistration = h.registrations.findIndex(call => call.ids.includes(other.id))
      const requeue = h.registrations.findIndex((call, index) => index > otherRegistration && call.ids.includes(session.id))
      expect(otherRegistration).toBeGreaterThan(0)
      expect(requeue).toBeGreaterThan(otherRegistration)
      expect(h.registrations[requeue].options).toBe(h.registrations[otherRegistration].options)
      expect(h.saves.map(call => call.outcome)).toEqual(['superseded', 'written', 'written'])
      expect(banner()).toBeNull()
    } finally { view.unmount() }
  })

  it('treats a lifecycle refusal like a conflict: one error line, no timer retries, a newer version still saves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const view = render(page())
    try {
      await waitFor(() => expect(shown()).toBe('original'))
      // persistLatest's plain Error when the live team lifecycle no longer matches the baseline.
      h.forceError = candidate => candidate.messages.at(-1)?.content === 'lifecycle edit' ? new Error('Session lifecycle changed before save') : null
      await append('lifecycle edit')
      await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 3000 })
      expect(h.saves).toHaveLength(1)
      // Before: the 1-30 s backoff retried the same object about 8 times in 120 s.
      await advanceSeconds(120)
      expect(h.saves).toHaveLength(1)
      expect(screen.getAllByText(/Failed to save chat session/)).toHaveLength(1)
      expect(saveErrorsNotified()).toEqual([])
      expect(contents(stored())).toEqual(['original'])
      // The explicit Retry still tries (and says so).
      fireEvent.click(screen.getByRole('button', { name: /retry/i }))
      await waitFor(() => expect(h.saves).toHaveLength(2))
      await waitFor(() => expect(saveErrorsNotified()).toHaveLength(1))
      await advanceSeconds(60)
      expect(h.saves).toHaveLength(2)
      // A newer version of the session is tried and, here, saved.
      await append('later edit')
      await advanceSeconds(3)
      expect(contents(stored())).toEqual(['original', 'lifecycle edit', 'later edit'])
      expect(banner()).toBeNull()
    } finally { view.unmount() }
  })
})
