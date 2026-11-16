import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

// The team of a thread as rows of the Agent column's thread list (lead first, then members).
const h = vi.hoisted(() => ({
  config: { value: null as any },
  sessions: { value: [] as any[] },
  api: { value: null as any },
  profiles: [{ id: 'fixture-profile', model_name: 'fixture-model', model_use: 'chat' }],
  notify: vi.fn(),
  update: vi.fn(),
  configUtils: {}
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key
  })
}))
vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: h.config.value,
    isReady: true,
    buildEnv: DEFAULT_BUILD_ENV,
    configUtils: h.configUtils,
    updateConfig: h.update
  })
}))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({
  useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null })
}))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: h.notify,
    notifyError: h.notify,
    notifyWarning: h.notify,
    notifyInfo: h.notify
  })
}))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => h.api.value }))
vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({ availableProfiles: h.profiles, remoteProfiles: [] })
}))
vi.mock('./chatStorage', async (original) => {
  const actual = await original<typeof import('./chatStorage')>()
  return {
    ...actual,
    compareAndUpdateSessionInDB: vi.fn(async () => null),
    loadAllSessions: vi.fn(async () => structuredClone(h.sessions.value)),
    loadSessionFromDB: vi.fn(async (id: string) =>
      structuredClone(h.sessions.value.find((s) => s.id === id) ?? null)
    ),
    saveSessionToDB: vi.fn(async () => undefined),
    saveAllSessions: vi.fn(async () => undefined),
    migrateFromLocalStorage: vi.fn(async () => null),
    debouncedSaveSessions: vi.fn(),
    cancelDebouncedSessionSave: vi.fn(),
    hasSessionDeleteTombstone: vi.fn(() => false),
    readSessionDeleteTombstones: vi.fn(() => []),
    readSessionDraftBackup: vi.fn(),
    writeSessionDraftBackup: vi.fn(),
    deleteSessionDraftBackup: vi.fn()
  }
})
vi.mock('./components/ChatComposer', () => ({ default: () => null }))
// The side conversations render their rows into the host they are given.
vi.mock('./components/AgentThreadSidesPanel', async () => {
  const { forwardRef } = await import('react')
  const { createPortal } = await import('react-dom')
  return {
    default: forwardRef<unknown, { subRowsHost?: HTMLElement | null }>(function SidesStub({ subRowsHost }, _ref) {
      return subRowsHost ? createPortal(<button type="button">side-row</button>, subRowsHost) : null
    })
  }
})
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: any) => <pre data-testid="session">{currentSession?.id}</pre>
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'team-rows-fixture',
  threadId: 'pane'
} as const
const everyService = () =>
  new Proxy(
    {},
    {
      get: (_target, name) =>
        name === 'then'
          ? undefined
          : new Proxy(
              {},
              {
                get: (_service, method) =>
                  method === 'then'
                    ? undefined
                    : vi.fn(async () => ({ jobs: [], messages: [], entries: [], notes: [], revision: 0 }))
              }
            )
    }
  )
const lead = {
  id: 'lead',
  title: 'Poster thread',
  profileId: 'fixture-profile',
  messages: [],
  teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false }
}
const member = (id: string, name: string) => ({
  id,
  title: name,
  profileId: 'fixture-profile',
  messages: [],
  teamLeadId: 'lead',
  teamMemberName: name,
  teamRole: name
})

function Harness({ compact = true, onThreadSubRowChange }: { compact?: boolean; onThreadSubRowChange?: (title: string | null) => void }) {
  const [host, setHost] = React.useState<HTMLDivElement | null>(null)
  const [targetHost, setTargetHost] = React.useState<HTMLDivElement | null>(null)
  return (
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <div data-testid="target-host" ref={setTargetHost} />
        <div data-testid="sub-rows" ref={setHost} />
        <ChatPage
          compact={compact}
          storageScope="team-rows-fixture"
          route={route}
          threadSubRowsHost={host}
          teamTargetHost={targetHost}
          onThreadSubRowChange={onThreadSubRowChange}
        />
      </ThemeProvider>
    </MemoryRouter>
  )
}
const rowLabels = () =>
  within(screen.getByTestId('sub-rows'))
    .queryAllByRole('button')
    .map((row) => row.textContent)

describe('ChatPage team rows in the thread list', () => {
  const oldApi = Object.getOwnPropertyDescriptor(window, 'api')
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    h.config.value = structuredClone(DEFAULT_CONFIG)
    h.config.value.use_remote_llm = false
    h.config.value.llm_config.api_profiles = [
      {
        id: 'fixture-profile',
        model_name: 'fixture-model',
        model_use: 'chat',
        api_mode: 'chat-completions',
        base_url: 'http://127.0.0.1:9/v1/chat/completions',
        api_key: 'fixture-only'
      }
    ]
    h.api.value = everyService()
    Object.defineProperty(window, 'api', { configurable: true, value: h.api.value })
    h.sessions.value = [lead, member('designer', '设计师'), member('writer', '文案')]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'team-rows-fixture'), 'lead')
  })
  afterEach(() => {
    cleanup()
    if (oldApi) Object.defineProperty(window, 'api', oldApi)
    else Reflect.deleteProperty(window, 'api')
    localStorage.clear()
    sessionStorage.clear()
  })

  it('lists the lead and the members, then the side rows, and opens the clicked conversation', async () => {
    const onThreadSubRowChange = vi.fn()
    render(<Harness onThreadSubRowChange={onThreadSubRowChange} />)
    await waitFor(() => expect(rowLabels()).toEqual(['Lead', '设计师', '文案', 'side-row']))
    const rows = within(screen.getByTestId('sub-rows'))
    expect(rows.getByRole('button', { name: 'Lead' })).toHaveAttribute('aria-current', 'true')
    expect(rows.getByRole('button', { name: '文案' })).not.toHaveAttribute('aria-current')
    expect(onThreadSubRowChange).toHaveBeenLastCalledWith(null)

    fireEvent.click(rows.getByRole('button', { name: '文案' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('writer'))
    await waitFor(() => expect(rows.getByRole('button', { name: '文案' })).toHaveAttribute('aria-current', 'true'))
    expect(rows.getByRole('button', { name: 'Lead' })).not.toHaveAttribute('aria-current')
    // The toolbar summary reads "<thread> · <member>".
    expect(onThreadSubRowChange).toHaveBeenLastCalledWith('文案')

    fireEvent.click(rows.getByRole('button', { name: 'Lead' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    await waitFor(() => expect(onThreadSubRowChange).toHaveBeenLastCalledWith(null))
    expect(rows.getByRole('button', { name: 'Lead' })).toHaveAttribute('aria-current', 'true')
  })

  it('puts a target select with the lead and the members in the header host', async () => {
    const onThreadSubRowChange = vi.fn()
    render(<Harness onThreadSubRowChange={onThreadSubRowChange} />)
    const select = await within(screen.getByTestId('target-host')).findByTestId('agent-team-target-select')
    expect(select).toHaveTextContent(/^Lead$/)
    expect(select).toHaveAttribute('aria-haspopup', 'menu')

    fireEvent.click(select)
    const menu = await screen.findByRole('menu', { name: 'Team members' })
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Lead', '设计师', '文案'])
    expect(within(menu).getByRole('menuitemradio', { name: 'Lead' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '设计师' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('designer'))
    await waitFor(() => expect(select).toHaveTextContent(/^设计师$/))
    expect(onThreadSubRowChange).toHaveBeenLastCalledWith('设计师')
    expect(within(screen.getByTestId('sub-rows')).getByRole('button', { name: '设计师' })).toHaveAttribute('aria-current', 'true')

    fireEvent.click(select)
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Team members' })).getByRole('menuitemradio', { name: 'Lead' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    await waitFor(() => expect(select).toHaveTextContent(/^Lead$/))
  })

  it('shows no team rows and no target select for a thread without members', async () => {
    h.sessions.value = [lead]
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    await waitFor(() => expect(rowLabels()).toEqual(['side-row']))
    expect(screen.getByTestId('target-host')).toBeEmptyDOMElement()
  })

  it('shows no team rows and no target select outside the Agent column', async () => {
    render(<Harness compact={false} />)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    await waitFor(() => expect(rowLabels()).toEqual(['side-row']))
    expect(screen.getByTestId('target-host')).toBeEmptyDOMElement()
  })
})
