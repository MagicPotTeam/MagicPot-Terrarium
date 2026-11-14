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

// Wiring only: which entries the real ChatPage adds to the composer "+" menu in the Agent column.
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
  default: ({ addMenuSlot }: { addMenuSlot?: (closeMenu: () => void) => React.ReactNode }) => (
    <ul data-testid="composer-add-menu">{addMenuSlot?.(h.closeMenu)}</ul>
  )
}))
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: any) => <pre data-testid="session">{currentSession?.id}</pre>
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
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
const renderPage = (workspaceMenu?: ChatPageWorkspaceMenu) =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <ChatPage compact storageScope="menu-fixture" route={route} workspaceMenu={workspaceMenu} />
      </ThemeProvider>
    </MemoryRouter>
  )

describe('ChatPage composer "+" menu in the Agent column', () => {
  const oldApi = Object.getOwnPropertyDescriptor(window, 'api')
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    h.closeMenu.mockClear()
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
      'chat-composer-menu-trace'
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

  it('adds no workspace entries outside the Agent column', async () => {
    renderPage(undefined)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(menuEntryIds()).not.toContain('chat-composer-menu-canvas-target')
    expect(menuEntryIds()).not.toContain('chat-composer-menu-trace')
  })
})
