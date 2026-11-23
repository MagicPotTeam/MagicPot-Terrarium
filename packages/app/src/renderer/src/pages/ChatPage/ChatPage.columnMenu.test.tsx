import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zh from '@shared/locales/zh-CN/renderer.json'
import en from '@shared/locales/en-US/renderer.json'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

// Wiring only: where the real ChatPage offers the functions that left the Agent column chrome
// (the column header's team buttons and slash commands; the composer has no "+" menu).
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
    composerInputRef,
    inputValue,
    inputSyncKey,
    onInputChange,
    onSend,
    selectedSkillName,
    suggestionSkills,
    onSelectSuggestedSkill,
    modelSelectorSlot,
    layout
  }: any) => (
    <>
      <div data-testid="composer-model-slot" data-layout={layout}>
        {modelSelectorSlot}
      </div>
      <ul data-testid="composer-add-menu">{addMenuSlot?.(h.closeMenu)}</ul>
      <output data-testid="selected-skill">{selectedSkillName ?? ''}</output>
      {(suggestionSkills ?? []).map((skill: { id: string; name: string }) => (
        <button key={skill.id} onClick={() => onSelectSuggestedSkill(skill.id)}>
          {`accept /${skill.name}`}
        </button>
      ))}
      <input
        ref={composerInputRef}
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
  default: ({ currentSession, tail }: any) => (
    <div data-testid="list">
      <pre data-testid="session">{currentSession?.id}</pre>
      {tail}
    </div>
  )
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({
  default: ({ headerPill, active }: { headerPill?: boolean; active?: boolean }) => (
    <button data-testid="model-selector" data-header-pill={String(Boolean(headerPill))}>
      {active ? 'active model' : 'inactive model'}
    </button>
  )
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
const renderPage = () =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <ChatPage compact storageScope="menu-fixture" route={route} />
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

  it('gives the Agent thread composer no "+" menu entries (no image options, canvas target or trace)', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(menuEntryIds()).toEqual([])
  })

  it('shows no goal row until /goal adds the goal records as a card of the transcript', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.queryByTestId('goal-records-host')).toBeNull()
    expect(screen.queryByRole('button', { name: '目标' })).toBeNull()

    // Text after the name is accepted and ignored: the records are edited in the card.
    const syncKey = draftSyncKey()
    fireEvent.change(screen.getByTestId('input'), { target: { value: '/goal 做一张海报' } })
    fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))

    const records = await screen.findByTestId('goal-records-host')
    const card = screen.getByTestId('chat-command-card')
    expect(card).toHaveAttribute('data-command', '/goal')
    expect(card).toContainElement(records)
    expect(screen.getByTestId('list')).toContainElement(card)
    expect(records).toHaveTextContent('lead')
    // The accepted command leaves the draft: the composer is told to reset its text.
    expect(draftSyncKey()).not.toBe(syncKey)
    expect(h.notify).not.toHaveBeenCalled()

    // A card has no close button and Escape does not remove it: it leaves with the conversation.
    expect(screen.queryByTestId('agent-goal-view')).toBeNull()
    expect(screen.queryByRole('button', { name: '收起目标' })).toBeNull()
    fireEvent.keyDown(records, { key: 'Escape' })
    expect(screen.getByTestId('goal-records-host')).toBe(records)
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
    expect(screen.queryByTestId('goal-records-host')).toBeNull()
    expect(screen.queryByTestId('chat-command-card')).toBeNull()
    expect(draftSyncKey()).toBe(syncKey)
  })

  it('has no "add member" button and, without a team, no team button either (as upstream)', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.queryByTestId('team-conversation-actions')).toBeNull()
    expect(screen.queryByText('团队协作')).toBeNull()
    expect(screen.queryByTestId('agent-header-add-member')).toBeNull()
    expect(screen.queryByTestId('agent-header-team')).toBeNull()
    expect(screen.queryByTestId('agent-header-team-actions')).toBeNull()
    expect(screen.queryByRole('dialog', { name: '创建成员' })).toBeNull()
  })

  it('offers only "team" in the header when the thread has a team and opens team management', async () => {
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
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    const team = await screen.findByTestId('agent-header-team')
    const actions = screen.getByTestId('agent-header-team-actions')
    expect([...actions.children].map((entry) => entry.getAttribute('data-testid'))).toEqual([
      'agent-header-team'
    ])
    expect(team).toHaveAccessibleName('团队…')
    expect(en.chat.team_menu_manage).toBe('Team…')
    expect(menuEntryIds()).toEqual([])
    expect(screen.queryByRole('dialog', { name: '团队管理' })).toBeNull()

    fireEvent.click(team)
    const dialog = await screen.findByRole('dialog', { name: '团队管理' })
    const closeTeam = screen.getByRole('button', { name: '关闭团队管理' })
    await waitFor(() => expect(closeTeam).toHaveFocus())
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '团队管理' })).toBeNull()
  })

  it('offers no team buttons with the remote model service', async () => {
    h.config.value.use_remote_llm = true
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.queryByTestId('agent-header-team-actions')).toBeNull()
    expect(menuEntryIds()).toEqual([])
  })

  it('selects a skill accepted from the "/" list exactly as the picker did', async () => {
    h.config.value.llm_config.customSkills = [
      {
        id: 'fixture-poster',
        category: '设计',
        skillName: '海报设计',
        prompt: 'fixture',
        type: 'prompt'
      }
    ]
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.getByTestId('selected-skill')).toBeEmptyDOMElement()
    fireEvent.click(await screen.findByRole('button', { name: 'accept /海报设计' }))
    // The chip of the composer shows the selected skill.
    await waitFor(() => expect(screen.getByTestId('selected-skill')).toHaveTextContent('海报设计'))
  })

  it('has no skills button; /skills adds the thread skills card and leaves the composer in place', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(screen.queryByRole('button', { name: '技能' })).toBeNull()

    // The command is accepted once the thread's skill scope is bound.
    await waitFor(() => {
      fireEvent.change(screen.getByTestId('input'), { target: { value: '/skills' } })
      fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))
      expect(screen.getByTestId('input')).toHaveValue('')
    })
    // The "/" list is the skill picker: nothing takes over the pane.
    expect(screen.getByTestId('input')).toBeVisible()
    expect(screen.queryByRole('button', { name: '技能' })).toBeNull()
  })

  describe("model selector in the column header, as in KohakuTerrarium (owner's request)", () => {
    const renderWithHost = (props: { active?: boolean; host?: HTMLElement | null }) => (
      <MemoryRouter>
        <ThemeProvider theme={createTheme()}>
          <ChatPage
            compact
            active={props.active ?? true}
            storageScope="menu-fixture"
            route={route}
            {...('host' in props ? { modelPillHost: props.host } : {})}
          />
        </ThemeProvider>
      </MemoryRouter>
    )
    const header = () => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      return host
    }

    it('puts the model selector into the header host; the composer has none', async () => {
      const host = header()
      const view = render(renderWithHost({ host }))
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))

      expect(
        within(screen.getByTestId('composer-model-slot')).queryByTestId('model-selector')
      ).toBeNull()
      const selector = within(host).getByTestId('model-selector')
      expect(selector).toHaveAttribute('data-header-pill', 'true')
      expect(within(host).queryByTestId('agent-header-add-member')).toBeNull()

      // An inactive pane leaves the header host to the pane that is active.
      view.rerender(renderWithHost({ host, active: false }))
      expect(host).toBeEmptyDOMElement()
      view.rerender(renderWithHost({ host, active: true }))
      expect(within(host).getByTestId('model-selector')).toBeInTheDocument()
      host.remove()
    })

    it('shows the model selector in the composer before the header host is mounted', async () => {
      render(renderWithHost({ host: null }))
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
      expect(
        within(screen.getByTestId('composer-model-slot')).getByTestId('model-selector')
      ).toBeInTheDocument()
    })

    it('keeps the selector in the composer where there is no column header', async () => {
      render(renderWithHost({}))
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
      const selector = within(screen.getByTestId('composer-model-slot')).getByTestId(
        'model-selector'
      )
      expect(selector).toHaveAttribute('data-header-pill', 'false')
    })
  })

  it('clears the draft once /repair-images has run, so the "/" list does not reopen over the result', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    const before = draftSyncKey()

    fireEvent.change(screen.getByTestId('input'), { target: { value: '/repair-images' } })
    fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))
    await waitFor(() =>
      expect(screen.getByTestId('chat-command-card')).toHaveAttribute(
        'data-command',
        '/repair-images'
      )
    )
    // ChatPage clears a draft by handing the composer an empty value under a new sync key.
    await waitFor(() => expect(draftSyncKey()).not.toBe(before))
    expect(screen.getByTestId('input')).toHaveValue('')
  })

  it('keeps a /repair-images draft that could not run', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    const before = draftSyncKey()

    fireEvent.change(screen.getByTestId('input'), { target: { value: '/repair-images now' } })
    fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))
    await waitFor(() => expect(h.notify).toHaveBeenCalledWith(zh.chat.use_repair_images))
    expect(draftSyncKey()).toBe(before)
    expect(screen.queryByText(/\/repair-images — /)).toBeNull()
  })

  it('adds no "+" menu entries outside the Agent column either', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(menuEntryIds()).toEqual([])
  })
})
