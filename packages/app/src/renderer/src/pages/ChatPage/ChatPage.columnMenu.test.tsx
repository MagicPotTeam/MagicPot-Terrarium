import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zh from '@shared/locales/zh-CN/renderer.json'
import en from '@shared/locales/en-US/renderer.json'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import ChatPage, { type ChatPageWorkspaceMenu } from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

// Wiring only: where the real ChatPage offers the functions that left the Agent column chrome
// (composer "+" menu entries and slash commands).
const h = vi.hoisted(() => ({
  config: { value: null as any },
  sessions: { value: [] as any[] },
  api: { value: null as any },
  profiles: [{ id: 'fixture-profile', model_name: 'fixture-model', model_use: 'chat' }],
  notify: vi.fn(),
  closeMenu: vi.fn(),
  update: vi.fn(),
  configUtils: {}
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, opts?: { defaultValue?: string }) => {
      const text = key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], zh)
      return typeof text === 'string' ? text : opts?.defaultValue || key
    }
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
  default: ({
    addMenuSlot,
    inputValue,
    inputSyncKey,
    onInputChange,
    onSend,
    selectedSkillName,
    suggestionSkills,
    onSelectSuggestedSkill
  }: any) => (
    <>
      <ul data-testid="composer-add-menu">{addMenuSlot?.(h.closeMenu)}</ul>
      <output data-testid="selected-skill">{selectedSkillName ?? ''}</output>
      {(suggestionSkills ?? []).map((skill: { id: string; name: string }) => (
        <button key={skill.id} onClick={() => onSelectSuggestedSkill(skill.id)}>
          {`accept /${skill.name}`}
        </button>
      ))}
      <input
        data-testid="input"
        data-sync-key={inputSyncKey}
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <button onClick={onSend}>send fixture</button>
    </>
  )
}))
vi.mock('./components/AgentThreadGoalRecordsHost', () => ({
  default: ({ conversationId }: { conversationId?: string }) => (
    <div data-testid="goal-records-host">{conversationId}</div>
  )
}))
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: any) => <pre data-testid="session">{currentSession?.id}</pre>
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({
  default: () => <div data-testid="skill-picker-takeover" />
}))
vi.mock('./components/ChatImageGenerationSettings', () => ({
  default: ({ variant }: { variant?: string }) =>
    variant === 'menuItem' ? <li data-testid="image-generation-entry" /> : null
}))

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'menu-fixture',
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
                        skills: [],
                        staleDisabledIds: [],
                        documentToken: 'fixture-token',
                        revision: 0
                      }))
              }
            )
    }
  )
const menuEntryIds = () =>
  [...screen.getByTestId('composer-add-menu').children].map((entry) =>
    entry.getAttribute('data-testid')
  )
/** Changes whenever ChatPage clears the composer draft. */
const draftSyncKey = () => screen.getByTestId('input').getAttribute('data-sync-key')
const renderPage = (workspaceMenu?: ChatPageWorkspaceMenu) =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <ChatPage compact storageScope="menu-fixture" route={route} workspaceMenu={workspaceMenu} />
      </ThemeProvider>
    </MemoryRouter>
  )

describe('ChatPage functions relocated out of the Agent column chrome', () => {
  const oldApi = Object.getOwnPropertyDescriptor(window, 'api')
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    h.closeMenu.mockClear()
    h.notify.mockClear()
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
    h.sessions.value = [{ id: 'lead', title: 'Lead', profileId: 'fixture-profile', messages: [] }]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'menu-fixture'), 'lead')
  })
  afterEach(() => {
    cleanup()
    if (oldApi) Object.defineProperty(window, 'api', oldApi)
    else Reflect.deleteProperty(window, 'api')
    localStorage.clear()
    sessionStorage.clear()
  })

  it('lists canvas target and start trace after the existing entries and runs the workspace handlers', async () => {
    const workspaceMenu = {
      traceRecording: false,
      onToggleTrace: vi.fn(),
      onOpenCanvasTarget: vi.fn()
    }
    renderPage(workspaceMenu)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))

    expect(menuEntryIds()).toEqual([
      'image-generation-entry',
      'chat-composer-menu-canvas-target',
      'chat-composer-menu-trace',
      'chat-composer-menu-add-member'
    ])
    expect(screen.getByTestId('chat-composer-menu-canvas-target')).toHaveTextContent('画布目标')
    expect(screen.getByTestId('chat-composer-menu-trace')).toHaveTextContent('开始追踪')
    expect(en.agent_workspace.trace_start).toBe('Start trace')

    fireEvent.click(screen.getByTestId('chat-composer-menu-canvas-target'))
    expect(workspaceMenu.onOpenCanvasTarget).toHaveBeenCalledTimes(1)
    expect(h.closeMenu).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('chat-composer-menu-trace'))
    expect(workspaceMenu.onToggleTrace).toHaveBeenCalledTimes(1)
    expect(h.closeMenu).toHaveBeenCalledTimes(2)
  })

  it('offers stop trace in the error colour while a trace is recording', async () => {
    const theme = createTheme()
    renderPage({ traceRecording: true, onToggleTrace: vi.fn(), onOpenCanvasTarget: vi.fn() })
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))

    const entry = screen.getByTestId('chat-composer-menu-trace')
    expect(entry).toHaveTextContent('停止追踪')
    expect(en.agent_workspace.trace_stop).toBe('Stop trace')
    const probe = document.createElement('span')
    probe.style.color = theme.palette.error.main
    expect(getComputedStyle(entry).color).toBe(probe.style.color)
  })

  it('shows no goal row until /goal opens the goal records as a closable command view', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.queryByTestId('agent-goal-view')).toBeNull()
    expect(screen.queryByRole('button', { name: '目标' })).toBeNull()

    // Text after the name is accepted and ignored: the records are edited in the view.
    const syncKey = draftSyncKey()
    fireEvent.change(screen.getByTestId('input'), { target: { value: '/goal 做一张海报' } })
    fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))

    const view = await screen.findByTestId('agent-goal-view')
    expect(view).toContainElement(screen.getByTestId('goal-records-host'))
    expect(screen.getByTestId('goal-records-host')).toHaveTextContent('lead')
    // The accepted command leaves the draft: the composer is told to reset its text.
    expect(draftSyncKey()).not.toBe(syncKey)
    expect(h.notify).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '收起目标' }))
    expect(screen.queryByTestId('agent-goal-view')).toBeNull()
    expect(en.chat.composer_suggestions.command_goal).toBe('Set, show or clear the current goal')
    expect(zh.chat.composer_suggestions.command_goal).toBe('设置、查看或清除当前目标')
  })

  it('refuses /goal with the remote model service and keeps the draft', async () => {
    h.config.value.use_remote_llm = true
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    const syncKey = draftSyncKey()
    fireEvent.change(screen.getByTestId('input'), { target: { value: '/goal' } })
    fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))
    await waitFor(() => expect(h.notify).toHaveBeenCalledWith(zh.chat.command_unavailable_current))
    expect(screen.queryByTestId('agent-goal-view')).toBeNull()
    expect(draftSyncKey()).toBe(syncKey)
  })

  it('offers "add member" instead of a team banner and opens the existing member form', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.queryByTestId('team-conversation-actions')).toBeNull()
    expect(screen.queryByText('团队协作')).toBeNull()
    await waitFor(() => expect(menuEntryIds()).toContain('chat-composer-menu-add-member'))
    // No team yet: nothing to manage.
    expect(menuEntryIds()).not.toContain('chat-composer-menu-team')
    expect(screen.getByTestId('chat-composer-menu-add-member')).toHaveTextContent('添加成员…')
    expect(en.chat.team_menu_add_member).toBe('Add member…')

    fireEvent.click(screen.getByTestId('chat-composer-menu-add-member'))
    expect(h.closeMenu).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog', { name: '创建成员' })).toBeInTheDocument()
  })

  it('offers "team" after "add member" when the thread has a team and opens team management', async () => {
    h.sessions.value = [
      { id: 'lead', title: 'Lead', profileId: 'fixture-profile', messages: [] },
      {
        id: 'designer',
        title: 'designer',
        profileId: 'fixture-profile',
        messages: [],
        teamLeadId: 'lead',
        teamMemberName: 'designer',
        teamRole: 'designer'
      }
    ]
    renderPage({ traceRecording: false, onToggleTrace: vi.fn(), onOpenCanvasTarget: vi.fn() })
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    await waitFor(() => expect(menuEntryIds()).toContain('chat-composer-menu-team'))
    expect(menuEntryIds()).toEqual([
      'image-generation-entry',
      'chat-composer-menu-canvas-target',
      'chat-composer-menu-trace',
      'chat-composer-menu-add-member',
      'chat-composer-menu-team'
    ])
    expect(screen.getByTestId('chat-composer-menu-team')).toHaveTextContent('团队…')
    expect(en.chat.team_menu_manage).toBe('Team…')
    // The unlabeled trigger in the process area is gone; the menu entry is the only way in.
    expect(screen.queryByRole('button', { name: '团队管理' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '团队管理' })).toBeNull()

    fireEvent.click(screen.getByTestId('chat-composer-menu-team'))
    expect(await screen.findByRole('dialog', { name: '团队管理' })).toBeInTheDocument()
  })

  it('offers no team entries with the remote model service', async () => {
    h.config.value.use_remote_llm = true
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(menuEntryIds()).toEqual(['image-generation-entry'])
  })

  it('selects a skill accepted from the "/" list exactly as the picker did', async () => {
    h.config.value.llm_config.customSkills = [
      { id: 'fixture-poster', category: '设计', skillName: '海报设计', prompt: 'fixture', type: 'prompt' }
    ]
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.getByTestId('selected-skill')).toBeEmptyDOMElement()
    fireEvent.click(await screen.findByRole('button', { name: 'accept /海报设计' }))
    // The chip of the composer shows the selected skill.
    await waitFor(() => expect(screen.getByTestId('selected-skill')).toHaveTextContent('海报设计'))
  })

  it('has no skills button and opens the picker take-over view through /skills only', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.queryByRole('button', { name: '技能' })).toBeNull()
    expect(screen.queryByTestId('skill-picker-takeover')).toBeNull()

    // The command is accepted once the thread's skill scope is bound.
    await waitFor(() => {
      fireEvent.change(screen.getByTestId('input'), { target: { value: '/skills' } })
      fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))
      expect(screen.getByTestId('skill-picker-takeover')).toBeInTheDocument()
    })
  })

  it('adds no workspace entries outside the Agent column', async () => {
    renderPage(undefined)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(menuEntryIds()).not.toContain('chat-composer-menu-canvas-target')
    expect(menuEntryIds()).not.toContain('chat-composer-menu-trace')
  })
})
