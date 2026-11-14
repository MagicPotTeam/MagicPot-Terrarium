import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

// Wiring only: which commands the real ChatPage hands to the composer.
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
vi.mock('./components/ChatComposer', () => ({
  default: (props: any) => (
    <pre data-testid="composer-suggestion-props">
      {JSON.stringify({
        commands: props.suggestionCommands.map((command: any) => command.name),
        hasMentionMembers: 'mentionMembers' in props
      })}
    </pre>
  )
}))
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: any) => <pre data-testid="session">{currentSession?.id}</pre>
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'suggestion-fixture',
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
                    : vi.fn(async () => ({
                        jobs: [],
                        messages: [],
                        entries: [],
                        notes: [],
                        revision: 0
                      }))
              }
            )
    }
  )
const props = () =>
  JSON.parse(screen.getByTestId('composer-suggestion-props').textContent ?? '{}') as {
    commands: string[]
    hasMentionMembers: boolean
  }
const renderPage = (pageRoute: typeof route | undefined) =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <ChatPage compact storageScope="suggestion-fixture" route={pageRoute} />
      </ThemeProvider>
    </MemoryRouter>
  )

describe('ChatPage composer suggestions', () => {
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
    h.sessions.value = [
      {
        id: 'lead',
        title: 'Lead',
        profileId: 'fixture-profile',
        messages: [],
        teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false }
      },
      {
        id: 'designer',
        title: 'designer',
        profileId: 'fixture-profile',
        messages: [],
        teamLeadId: 'lead',
        teamMemberName: 'designer',
        teamRole: 'Visual design'
      },
      {
        id: 'writer',
        title: 'writer',
        profileId: 'fixture-profile',
        messages: [],
        teamLeadId: 'lead',
        teamMemberName: 'writer',
        teamRole: 'writer'
      }
    ]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'suggestion-fixture'),
      'lead'
    )
  })
  afterEach(() => {
    cleanup()
    if (oldApi) Object.defineProperty(window, 'api', oldApi)
    else Reflect.deleteProperty(window, 'api')
    localStorage.clear()
    sessionStorage.clear()
  })

  it('offers thread commands to a lead and to a member, and never hands team members to the composer', async () => {
    renderPage(route)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    await waitFor(() => expect(props().commands).toContain('status'))
    // The "@" member list is gone: the composer gets no member data at all.
    expect(props().hasMentionMembers).toBe(false)
    expect(props().commands).toEqual([
      'goal',
      'status',
      'jobs',
      'compact',
      'btw',
      'skill',
      'scratchpad',
      'branch',
      'regen',
      'edit',
      'repair-images',
      'env',
      'system_prompt',
      'plugin',
      'module',
      'video_gen'
    ])

    fireEvent.click(
      within(await screen.findByRole('region', { name: '进程区' })).getByRole('button', {
        name: '打开 designer'
      })
    )
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('designer'))
    // A member conversation cannot be compacted.
    await waitFor(() => expect(props().commands).not.toContain('compact'))
    expect(props().hasMentionMembers).toBe(false)
    expect(props().commands).toEqual(
      expect.arrayContaining(['goal', 'status', 'jobs', 'btw', 'skill', 'edit'])
    )
  })

  it('offers no thread-only commands outside a canvas thread', async () => {
    renderPage(undefined)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    await waitFor(() => expect(props().commands).toContain('status'))
    expect(props().commands).toEqual([
      'status',
      'compact',
      'branch',
      'regen',
      'edit',
      'repair-images',
      'env',
      'system_prompt',
      'plugin',
      'module',
      'video_gen'
    ])
  })

  it('offers only the commands that work with the remote model service', async () => {
    h.config.value.use_remote_llm = true
    renderPage(route)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    await waitFor(() => expect(props().commands).toContain('status'))
    expect(props().commands).toEqual([
      'status',
      'compact',
      'env',
      'system_prompt',
      'plugin',
      'module',
      'video_gen'
    ])
  })
})
