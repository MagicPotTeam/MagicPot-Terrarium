import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import type { ChatSession } from './chatStorage'
import ChatPage from './ChatPage'

const hoisted = vi.hoisted(() => ({
  config: { value: null as Config | null },
  ready: { value: true },
  sessions: { value: [] as ChatSession[] },
  loadAllSessions: vi.fn(),
  saveSessionToDB: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  requestChatCompletion: vi.fn(),
  requestChatCompletionStream: vi.fn(),
  supportsStreaming: vi.fn()
}))

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [],
    customSkills: [],
    customSkillCategories: []
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; error?: string }) =>
      options?.defaultValue || options?.error || _key,
    i18n: { language: 'en', resolvedLanguage: 'en' }
  })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: hoisted.config.value,
    isReady: hoisted.ready.value,
    buildEnv: { ...DEFAULT_BUILD_ENV },
    configUtils: {},
    updateConfig: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({
  useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: hoisted.notifyError,
    notifyWarning: hoisted.notifyWarning,
    notifySuccess: vi.fn(),
    notifyInfo: vi.fn()
  })
}))

vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({
    availableProfiles: [{ id: 'base-model', model_name: 'Base', model_use: 'chat' as const }],
    remoteProfiles: []
  })
}))

vi.mock('./chatStorage', () => ({
  loadAllSessions: (...args: unknown[]) => hoisted.loadAllSessions(...args),
  saveSessionToDB: (...args: unknown[]) => hoisted.saveSessionToDB(...args),
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
}))

vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return {
    ...actual,
    requestChatCompletion: hoisted.requestChatCompletion,
    requestChatCompletionStream: hoisted.requestChatCompletionStream,
    supportsStreamingChatCompletion: hoisted.supportsStreaming
  }
})

vi.mock('./components/SessionSidebar', () => ({ default: () => <div data-testid="sidebar" /> }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('@renderer/utils/fileUtils', () => ({
  selectFile: vi.fn(),
  fileToBlobUrl: vi.fn(() => 'blob:test'),
  fileToDataUrl: vi.fn(async () => 'data:text/plain;base64,QQ=='),
  checkFileSize: vi.fn(() => true),
  formatFileSize: vi.fn(() => '1 B')
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcAgentLocalFiles: {},
    svcFs: {},
    svcLLMProxy: { signHy3DModel: vi.fn() },
    svcHyper: { saveImageToDir: vi.fn(async () => ({ savedPath: null })) },
    svcManagedMedia: {}
  })
}))
vi.mock('./components/ChatComposer', () => ({
  default: (props: {
    inputValue: string
    onInputChange: (value: string) => void
    onSend: () => void
    onStopGenerating: () => void
    pendingAttachments?: unknown[]
  }) => (
    <div data-testid="composer">
      <input
        data-testid="composer-input"
        value={props.inputValue}
        onChange={(event) => props.onInputChange(event.target.value)}
      />
      <button type="button" data-testid="composer-send" onClick={props.onSend}>
        send
      </button>
      <button type="button" data-testid="composer-stop" onClick={props.onStopGenerating}>
        stop
      </button>
    </div>
  )
}))
vi.mock('./components/ChatMessageList', () => ({
  default: (props: { currentSession?: ChatSession; isLoading?: boolean }) => (
    <div data-testid="message-list" data-loading={String(Boolean(props.isLoading))}>
      <pre data-testid="session-state">{JSON.stringify(props.currentSession || null)}</pre>
    </div>
  )
}))

const renderPage = (scope = 'ui-regressions') =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <ChatPage compact storageScope={scope} active />
      </ThemeProvider>
    </MemoryRouter>
  )

const currentSession = (): ChatSession | null =>
  JSON.parse(screen.getByTestId('session-state').textContent || 'null') as ChatSession | null

describe('ChatPage persistence and run identity regressions', () => {
  beforeEach(() => {
    hoisted.config.value = createConfig()
    hoisted.ready.value = true
    hoisted.sessions.value = []
    hoisted.loadAllSessions.mockReset()
    hoisted.loadAllSessions.mockImplementation(async () => clone(hoisted.sessions.value))
    hoisted.saveSessionToDB.mockReset()
    hoisted.saveSessionToDB.mockImplementation(async (session: ChatSession) => {
      hoisted.sessions.value = [clone(session)]
    })
    hoisted.notifyError.mockReset()
    hoisted.notifyWarning.mockReset()
    hoisted.requestChatCompletion.mockReset()
    hoisted.requestChatCompletion.mockResolvedValue({ content: 'reply' })
    hoisted.requestChatCompletionStream.mockReset()
    hoisted.supportsStreaming.mockReset()
    hoisted.supportsStreaming.mockReturnValue(false)
    localStorage.clear()
    sessionStorage.clear()
  })

  it('keeps the existing session and blocks auto-create when initial storage load fails', async () => {
    const existing: ChatSession = {
      id: 'dirty-session',
      title: 'Dirty local session',
      messages: [{ role: 'user', content: 'unsaved local work' }]
    }
    hoisted.loadAllSessions.mockRejectedValueOnce(new Error('IndexedDB unavailable'))
    hoisted.sessions.value = [existing]

    renderPage()

    await waitFor(() =>
      expect(
        screen.getByText('Failed to load chat sessions: IndexedDB unavailable')
      ).toBeInTheDocument()
    )
    expect(currentSession()).toBeNull()
    expect(hoisted.notifyError).toHaveBeenCalledWith(
      'Failed to load chat sessions: IndexedDB unavailable'
    )
    expect(hoisted.saveSessionToDB).not.toHaveBeenCalled()
  })

  it('shows a failed placeholder save without an unhandled rejection and keeps generated response separate', async () => {
    hoisted.saveSessionToDB.mockRejectedValue(new Error('disk full'))
    renderPage()
    await waitFor(() => expect(currentSession()?.id).toBeTruthy())

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('composer-send'))

    await waitFor(() => expect(hoisted.requestChatCompletion).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(hoisted.notifyError).toHaveBeenCalled())
    expect(
      hoisted.notifyError.mock.calls.some(([message]) => String(message).includes('disk full'))
    ).toBe(true)
    expect(currentSession()?.messages.some((message) => message.content === 'reply')).toBe(true)
  })

  it('persists tool history on the assistant message from a real ChatPage completion', async () => {
    const history = [
      {
        runId: 'owned-run',
        toolCallId: 'owned-tool-0',
        toolName: 'audit.read',
        args: {},
        status: 'completed',
        content: 'owned tool result'
      }
    ]
    hoisted.requestChatCompletion.mockResolvedValue({
      content: 'reply-with-tools',
      metadata: { runId: 'owned-run', toolHistory: history }
    })

    renderPage()
    await waitFor(() => expect(currentSession()?.id).toBeTruthy())
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'use owned tool' }
    })
    fireEvent.click(screen.getByTestId('composer-send'))

    await waitFor(() =>
      expect(
        currentSession()?.messages.some((message) => message.content === 'reply-with-tools')
      ).toBe(true)
    )
    expect(
      currentSession()?.messages.find((message) => message.content === 'reply-with-tools')
        ?.toolHistory
    ).toEqual(history)
    await waitFor(() =>
      expect(
        hoisted.sessions.value[0]?.messages.find(
          (message) => message.content === 'reply-with-tools'
        )?.toolHistory
      ).toEqual(history)
    )
  })

  it('retries a failed save by persisting the dirty reply instead of reloading stale disk data', async () => {
    const old: ChatSession = {
      id: 'owned-dirty',
      title: 'Owned dirty',
      profileId: 'base-model',
      messages: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old saved answer' }
      ]
    }
    hoisted.sessions.value = [clone(old)]
    renderPage()
    await waitFor(() => expect(currentSession()?.id).toBe(old.id))

    hoisted.saveSessionToDB.mockRejectedValue(new Error('owned disk full'))
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'new question' }
    })
    fireEvent.click(screen.getByTestId('composer-send'))

    await waitFor(() =>
      expect(
        hoisted.saveSessionToDB.mock.calls.some(([session]) =>
          (session as ChatSession).messages?.some((message) => message.content === 'reply')
        )
      ).toBe(true)
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(
      currentSession()?.messages.some((message) => message.content === 'reply'),
      'generated reply must survive an unsuccessful save and automatic refresh'
    ).toBe(true)
    await waitFor(() => expect(screen.getAllByText(/owned disk full/).length).toBeGreaterThan(0))

    hoisted.saveSessionToDB.mockImplementation(async (session: ChatSession) => {
      hoisted.sessions.value = [clone(session)]
    })
    hoisted.saveSessionToDB.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /retry|重试/i }))
    await waitFor(
      () =>
        expect(
          hoisted.sessions.value[0]?.messages.some((message) => message.content === 'reply')
        ).toBe(true),
      { timeout: 2000 }
    )
    expect(currentSession()?.messages.some((message) => message.content === 'reply')).toBe(true)
  })

  it('keeps hook order stable when configuration becomes ready', async () => {
    const page = () => (
      <MemoryRouter>
        <ThemeProvider theme={createTheme()}>
          <ChatPage compact storageScope="owned-config-ready" active />
        </ThemeProvider>
      </MemoryRouter>
    )
    hoisted.config.value = createConfig()
    hoisted.ready.value = false
    const view = render(page())
    hoisted.ready.value = true
    expect(() => view.rerender(page())).not.toThrow()
    await waitFor(() => expect(currentSession()?.id).toBeTruthy())
  })

  it('keeps the generated reply and dirty state when a guarded save conflicts with a newer record', async () => {
    const old: ChatSession = {
      id: 'owned-conflict',
      title: 'Owned conflict',
      messages: [{ role: 'user', content: 'old question' }]
    }
    hoisted.sessions.value = [clone(old)]
    // The placeholder (no reply yet) saves cleanly; the reply save hits a cross-writer conflict.
    const conflict = Object.assign(new Error('record changed in another window'), {
      name: 'ChatSessionSaveConflictError'
    })
    hoisted.saveSessionToDB.mockImplementation(async (session: ChatSession) => {
      if (session.messages.some((message) => message.content === 'reply')) throw conflict
      hoisted.sessions.value = [clone(session)]
    })
    renderPage()
    await waitFor(() => expect(currentSession()?.id).toBe(old.id))

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'new question' } })
    fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(hoisted.requestChatCompletion).toHaveBeenCalledTimes(1))

    // The reply must survive in the UI (dirty) even though the guarded write was rejected.
    await waitFor(() =>
      expect(currentSession()?.messages.some((message) => message.content === 'reply')).toBe(true)
    )
    // The stale snapshot must not have overwritten the conflicting record.
    expect(hoisted.sessions.value[0]?.messages.some((message) => message.content === 'reply')).toBe(
      false
    )
    await waitFor(() => expect(screen.getAllByText(/another window/).length).toBeGreaterThan(0))
  })

  it('keeps an unsaved draft visible and dirty when draft persistence fails', async () => {
    const old: ChatSession = { id: 'owned-draft', title: 'Owned draft', messages: [] }
    hoisted.sessions.value = [clone(old)]
    hoisted.saveSessionToDB.mockImplementation(async (session: ChatSession) => {
      if (session.draft?.inputValue) throw new Error('draft disk full')
      hoisted.sessions.value = [clone(session)]
    })
    renderPage()
    await waitFor(() => expect(currentSession()?.id).toBe(old.id))

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'unsaved draft text' }
    })
    // Wait for the draft debounce (200ms) to fire and the guarded save to fail.
    await waitFor(() => expect(screen.getAllByText(/draft disk full/).length).toBeGreaterThan(0), {
      timeout: 3000
    })
    // The draft must remain in the session and stay dirty (not silently dropped).
    expect(currentSession()?.draft?.inputValue).toBe('unsaved draft text')
  })
})
