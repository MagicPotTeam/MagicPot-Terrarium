import { act, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import type { ChatSession } from './chatStorage'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

const h = vi.hoisted(() => ({ sessions: [] as ChatSession[], notify: vi.fn(), load: vi.fn(), save: vi.fn(), fetch: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key, i18n: { language: 'en', resolvedLanguage: 'en' } }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [], customSkills: [], customSkillCategories: [] } } as Config, isReady: true, buildEnv: { ...DEFAULT_BUILD_ENV }, configUtils: {}, updateConfig: vi.fn() }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifyError: h.notify, notifyWarning: vi.fn(), notifySuccess: vi.fn(), notifyInfo: vi.fn() }) }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: [{ id: 'base-model', model_name: 'Base', model_use: 'chat' }], remoteProfiles: [] }) }))
vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  return { ...actual, loadAllSessions: (...args: unknown[]) => h.load(...args), loadSessionFromDB: async (id: string) => structuredClone(h.sessions.find(s => s.id === id) ?? null), saveSessionToDB: (...args: unknown[]) => h.save(...args), saveAllSessions: vi.fn(), compareAndUpdateSessionInDB: vi.fn(), deleteSessionFromDB: vi.fn(), cancelDebouncedSessionSave: vi.fn(), deleteSessionDraftBackup: vi.fn(), migrateFromLocalStorage: vi.fn(async () => null), readSessionDraftBackup: vi.fn(), hasSessionDeleteTombstone: vi.fn(() => false), readSessionDeleteTombstones: vi.fn(() => []), debouncedSaveSessions: vi.fn(), setSessionDeleteTombstone: vi.fn(), writeSessionDraftBackup: vi.fn() }
})
vi.mock('./components/SessionSidebar', () => ({ default: () => <div /> }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('@renderer/utils/fileUtils', () => ({ selectFile: vi.fn(), fileToBlobUrl: vi.fn(), fileToDataUrl: vi.fn(), checkFileSize: vi.fn(() => true), formatFileSize: vi.fn(() => '1 B') }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcAgentLocalFiles: {}, svcFs: {}, svcLLMProxy: {}, svcHyper: {}, svcManagedMedia: {} }) }))
vi.mock('./components/ChatComposer', () => ({ default: () => <div data-testid="composer" /> }))
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession }: { currentSession?: ChatSession }) => <output data-testid="session">{currentSession?.messages.map(m => m.content).join('|')}</output> }))

const scope = 'ensure-frozen-fixture'
const session: ChatSession = { id: 'load-target', title: 'Fixture', profileId: 'base-model', messages: [{ role: 'user', content: 'original' }], createdAt: 299 }
const theme = createTheme()
const page = () => <MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scope} active /></ThemeProvider></MemoryRouter>

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  h.sessions = [structuredClone(session)]
  h.load.mockReset().mockImplementation(async () => structuredClone(h.sessions))
  h.save.mockReset().mockImplementation(() => new Promise(() => {}))
  h.notify = vi.fn()
  h.fetch.mockReset().mockRejectedValue(new Error('Network forbidden in fixture'))
  vi.stubGlobal('fetch', h.fetch)
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), session.id)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('ChatPage baseline call sites, synthetic storage and no network', () => {
  it('freezes the original baseline when an initial reload merges an existing locally changed session without a save acknowledgement', async () => {
    const freeze = vi.spyOn(ChatSessionSaveBaseline.prototype, 'freeze')
    let release!: (value: ChatSession[]) => void
    let started = false
    const view = render(page())
    try {
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('original'))
      const snapshot = structuredClone(h.sessions)
      h.load.mockImplementationOnce(() => { started = true; return new Promise<ChatSession[]>(resolve => { release = resolve }) })
      h.notify = vi.fn()
      view.rerender(page())
      await waitFor(() => expect(started).toBe(true))
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', { detail: { scope, sessionId: session.id, role: 'user', content: 'local update' } })))
      expect(screen.getByTestId('session')).toHaveTextContent('local update')
      expect(h.sessions).toEqual(snapshot)
      freeze.mockClear()
      await act(async () => release(snapshot))
      await waitFor(() => expect(freeze).toHaveBeenCalledWith(scope, session.id, expect.objectContaining({ id: session.id, messages: session.messages })))
      expect(screen.getByTestId('session')).toHaveTextContent('local update')
      expect(h.sessions).toEqual(snapshot)
      expect(h.fetch).not.toHaveBeenCalled()
    } finally { release?.(structuredClone(h.sessions)); view.unmount() }
  })

  it('freezes the lead baseline and invokes persistLatest after a guarded task claim and member completion', async () => {
    // The assertion is deliberately a real page route, never a direct baseline helper invocation.
    const freeze = vi.spyOn(ChatSessionSaveBaseline.prototype, 'freeze')
    const persistLatest = vi.spyOn(ChatSessionSaveBaseline.prototype, 'persistLatest')
    const view = render(page())
    try {
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('original'))
      expect(screen.getByRole('button', { name: '执行 fixture task' })).toBeEnabled()
      expect(freeze).toHaveBeenCalledWith(scope, 'fixture-lead', expect.objectContaining({ id: 'fixture-lead' }))
      expect(persistLatest).toHaveBeenCalledWith(scope, 'fixture-lead', expect.any(Function), expect.any(Function), expect.any(Function), true, expect.any(Function))
    } finally { view.unmount() }
  })
})
