import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zhLocaleText } from '../../testUtils/localeTranslator'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import type { ReactNode } from 'react'
import type { ChatSession } from './chatStorage'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import { setTeamTaskStatus } from './agentTeamTasks'
import ChatPage from './ChatPage'

const h = vi.hoisted(() => ({
  sessions: [] as ChatSession[],
  notify: vi.fn(),
  notifyWarning: vi.fn(),
  notifySuccess: vi.fn(),
  notifyInfo: vi.fn(),
  updateConfig: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  fetch: vi.fn(),
  claim: vi.fn(),
  request: vi.fn()
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || zhLocaleText(key),
    i18n: { language: 'en', resolvedLanguage: 'en' }
  })
}))
vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {
      ...DEFAULT_CONFIG,
      use_remote_llm: false,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [],
        customSkills: [],
        customSkillCategories: []
      }
    } as Config,
    isReady: true,
    buildEnv: { ...DEFAULT_BUILD_ENV },
    configUtils: {},
    updateConfig: h.updateConfig
  })
}))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({
  useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null })
}))
// Stable callbacks, as the real hook returns them (hooks/useMessage.ts); h.notify stays swappable.
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: h.notify,
    notifyWarning: h.notifyWarning,
    notifySuccess: h.notifySuccess,
    notifyInfo: h.notifyInfo
  })
}))
vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({
    availableProfiles: [{ id: 'base-model', model_name: 'Base', model_use: 'chat' }],
    remoteProfiles: []
  })
}))
vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  return {
    ...actual,
    loadAllSessions: (...args: unknown[]) => h.load(...args),
    loadSessionFromDB: async (id: string) =>
      structuredClone(h.sessions.find((s) => s.id === id) ?? null),
    saveSessionToDB: (...args: unknown[]) => h.save(...args),
    saveAllSessions: vi.fn(),
    compareAndUpdateSessionInDB: vi.fn(),
    deleteSessionFromDB: vi.fn(),
    cancelDebouncedSessionSave: vi.fn(),
    deleteSessionDraftBackup: vi.fn(),
    migrateFromLocalStorage: vi.fn(async () => null),
    readSessionDraftBackup: vi.fn(),
    hasSessionDeleteTombstone: vi.fn(() => false),
    readSessionDeleteTombstones: vi.fn(() => []),
    debouncedSaveSessions: vi.fn(),
    setSessionDeleteTombstone: vi.fn(),
    writeSessionDraftBackup: vi.fn()
  }
})
// A team runs on the local transport, which always streams (supportsStreamingChatCompletion), so a member's
// task request goes through requestChatCompletionStream. Only that export is replaced, so a refactor of
// chatRequestUtils breaks this fixture loudly instead of silently reaching a real transport.
vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return {
    ...actual,
    requestChatCompletionStream: async (input: {
      beforeLocalDispatch?: () => void | Promise<void>
      onLocalDispatch?: () => void
      signal?: AbortSignal
    }) => {
      if (input.beforeLocalDispatch) await input.beforeLocalDispatch()
      if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const pending = h.request(input) as Promise<{ content: string }>
      input.onLocalDispatch?.()
      const result = await pending
      return { result, response: result.content }
    }
  }
})
// The guarded claim is a compare-and-update in the real store; the fixture commits it to the synthetic store.
vi.mock('./agentTeamTaskDispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentTeamTaskDispatch')>()),
  claimTeamTaskInDB: (...args: unknown[]) => h.claim(...args)
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => <div /> }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('@renderer/utils/fileUtils', () => ({
  selectFile: vi.fn(),
  fileToBlobUrl: vi.fn(),
  fileToDataUrl: vi.fn(),
  checkFileSize: vi.fn(() => true),
  formatFileSize: vi.fn(() => '1 B')
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcAgentLocalFiles: {},
    svcFs: {},
    svcLLMProxy: {},
    svcHyper: {},
    svcManagedMedia: {}
  })
}))
// The composer renders the page's real "+" menu slot, as the runtime-flow fixture does.
vi.mock('./components/ChatComposer', async () => {
  const { useState } = await import('react')
  return {
    default: function ChatComposerMock({
      addMenuSlot
    }: {
      addMenuSlot?: (closeMenu: () => void) => ReactNode
    }) {
      const [open, setOpen] = useState(false)
      return (
        <div data-testid="composer">
          <button type="button" onClick={() => setOpen(true)}>
            open-add-menu
          </button>
          {open && addMenuSlot?.(() => setOpen(false))}
        </div>
      )
    }
  }
})
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: { currentSession?: ChatSession }) => (
    <output data-testid="session">
      {currentSession?.messages.map((m) => m.content).join('|')}
    </output>
  )
}))

const scope = 'ensure-frozen-fixture'
const session: ChatSession = {
  id: 'load-target',
  title: 'Fixture',
  profileId: 'base-model',
  messages: [{ role: 'user', content: 'original' }],
  createdAt: 299
}
const theme = createTheme()
const page = () => (
  <MemoryRouter>
    <ThemeProvider theme={theme}>
      <ChatPage compact storageScope={scope} active />
    </ThemeProvider>
  </MemoryRouter>
)
// A canvas thread route enables team management for the page.
const teamRoute = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'ensure-frozen-project',
  threadId: 'ensure-frozen-pane'
} as const
const teamPage = () => (
  <MemoryRouter>
    <ThemeProvider theme={theme}>
      <ChatPage compact storageScope={scope} active route={teamRoute} />
    </ThemeProvider>
  </MemoryRouter>
)
const lead: ChatSession = {
  id: 'fixture-lead',
  title: 'Lead',
  profileId: 'base-model',
  messages: [{ role: 'user', content: 'original' }],
  createdAt: 300,
  teamGeneration: 1,
  teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false },
  teamTasks: [
    {
      id: 'fixture-task',
      title: 'fixture task',
      ownerId: 'fixture-member',
      status: 'pending',
      dependsOn: []
    }
  ]
}
const member: ChatSession = {
  id: 'fixture-member',
  title: 'designer',
  profileId: 'base-model',
  messages: [],
  createdAt: 301,
  teamLeadId: lead.id,
  teamMemberName: 'designer',
  teamRole: '设计师',
  teamMemberGeneration: 1
}
const storedLead = () => h.sessions.find((stored) => stored.id === lead.id)

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  h.sessions = [structuredClone(session)]
  h.load.mockReset().mockImplementation(async () => structuredClone(h.sessions))
  h.save.mockReset().mockImplementation(() => new Promise(() => {}))
  h.notify = vi.fn()
  h.fetch.mockReset().mockRejectedValue(new Error('Network forbidden in fixture'))
  h.claim.mockReset().mockRejectedValue(new Error('Claim not expected in this test'))
  h.request.mockReset().mockRejectedValue(new Error('Request not expected in this test'))
  vi.stubGlobal('fetch', h.fetch)
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), session.id)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatPage baseline call sites, synthetic storage and no network', () => {
  it('freezes the original baseline when an initial reload merges an existing locally changed session without a save acknowledgement', async () => {
    const freeze = vi.spyOn(ChatSessionSaveBaseline.prototype, 'freeze')
    let release!: (value: ChatSession[]) => void
    let started = false
    const view = render(page())
    try {
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('original'))
      const snapshot = structuredClone(h.sessions)
      h.load.mockImplementationOnce(() => {
        started = true
        return new Promise<ChatSession[]>((resolve) => {
          release = resolve
        })
      })
      h.notify = vi.fn()
      view.rerender(page())
      await waitFor(() => expect(started).toBe(true))
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent('chat:append-message', {
            detail: { scope, sessionId: session.id, role: 'user', content: 'local update' }
          })
        )
      )
      expect(screen.getByTestId('session')).toHaveTextContent('local update')
      expect(h.sessions).toEqual(snapshot)
      freeze.mockClear()
      await act(async () => release(snapshot))
      await waitFor(() =>
        expect(freeze).toHaveBeenCalledWith(
          scope,
          session.id,
          expect.objectContaining({ id: session.id, messages: session.messages })
        )
      )
      expect(screen.getByTestId('session')).toHaveTextContent('local update')
      expect(h.sessions).toEqual(snapshot)
      expect(h.fetch).not.toHaveBeenCalled()
    } finally {
      release?.(structuredClone(h.sessions))
      view.unmount()
    }
  })

  it('freezes the lead baseline and invokes persistLatest after a guarded task claim and member completion', async () => {
    // The assertion is deliberately a real page route, never a direct baseline helper invocation.
    const freeze = vi.spyOn(ChatSessionSaveBaseline.prototype, 'freeze')
    const persistLatest = vi.spyOn(ChatSessionSaveBaseline.prototype, 'persistLatest')
    h.sessions = [structuredClone(lead), structuredClone(member)]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), lead.id)
    // Saves acknowledge in this test: the completion write must commit for the page to report it.
    h.save.mockReset().mockImplementation(async (saved: ChatSession) => {
      h.sessions = h.sessions.map((stored) =>
        stored.id === saved.id ? structuredClone(saved) : stored
      )
    })
    h.claim.mockImplementation(
      async ({ expectedLead, taskId }: { expectedLead: ChatSession; taskId: string }) => {
        const claimed: ChatSession = {
          ...structuredClone(expectedLead),
          teamTasks: setTeamTaskStatus(expectedLead.teamTasks ?? [], taskId, 'running')
        }
        h.sessions = h.sessions.map((stored) =>
          stored.id === claimed.id ? structuredClone(claimed) : stored
        )
        return claimed
      }
    )
    let finish!: (value: { content: string }) => void
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(teamPage())
    try {
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('original'))
      // Team management opens from the conversation header (the composer has no "+" menu).
      fireEvent.click(await screen.findByTestId('agent-header-team'))
      await screen.findByRole('dialog', { name: '团队管理' })
      expect(screen.getByRole('button', { name: '执行 fixture task' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: '执行 fixture task' }))
      await waitFor(() => expect(h.request).toHaveBeenCalledTimes(1))
      expect(h.claim).toHaveBeenCalledTimes(1)
      expect(storedLead()?.teamTasks?.[0].status).toBe('running')
      const request = h.request.mock.calls[0][0] as {
        teamMember?: unknown
        messages: Array<{ content: string }>
      }
      expect(request.teamMember).toEqual({
        scope,
        thread: teamRoute.threadId,
        lead: lead.id,
        member: member.id
      })
      expect(request.messages.at(-1)?.content).toContain('fixture task')
      // Only the completion path may satisfy the baseline assertions below, never a load-time freeze.
      freeze.mockClear()
      persistLatest.mockClear()
      await act(async () => finish({ content: 'fixture result' }))
      await waitFor(() => expect(storedLead()?.teamTasks?.[0].status).toBe('done'))
      expect(freeze).toHaveBeenCalledWith(
        scope,
        'fixture-lead',
        expect.objectContaining({ id: 'fixture-lead' })
      )
      expect(persistLatest).toHaveBeenCalledWith(
        scope,
        'fixture-lead',
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        true,
        expect.any(Function)
      )
      // The completion write is checked against the claimed lead, the baseline frozen for it.
      const completionSave = h.save.mock.calls.findLast(
        ([saved]) => (saved as ChatSession).id === lead.id
      ) as [ChatSession, string, { expectedSession?: ChatSession | null }] | undefined
      expect(completionSave?.[0].teamTasks?.[0].status).toBe('done')
      expect(completionSave?.[2].expectedSession?.teamTasks?.[0].status).toBe('running')
      expect(h.request).toHaveBeenCalledTimes(1)
      expect(h.fetch).not.toHaveBeenCalled()
    } finally {
      finish?.({ content: 'cleanup' })
      view.unmount()
    }
  })
})
