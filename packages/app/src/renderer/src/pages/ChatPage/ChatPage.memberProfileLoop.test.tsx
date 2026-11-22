import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

// A team member whose model cannot be resolved (here: its lead has no model) owns a null selection,
// which means "unavailable". The page must settle on it instead of normalizing it to the first
// available profile, which the member selection sync would undo on the next render, forever.
const h = vi.hoisted(() => ({
  config: { value: null as any },
  sessions: { value: [] as any[] },
  api: { value: null as any },
  profiles: [{ id: 'fixture-profile', model_name: 'fixture-model', model_use: 'chat' }],
  notify: vi.fn(),
  update: vi.fn(),
  configUtils: {},
  composerRenders: { value: 0 },
  selections: [] as Array<{ profileId: string | null; memberModel: string | undefined }>
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, opts?: Record<string, unknown>) =>
      String(opts?.defaultValue || key).replace(/{{(\w+)}}/g, (_match, name: string) =>
        String(opts?.[name] ?? '')
      )
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
// The composer re-renders with every page render: it counts them and shows the model slot it is given.
vi.mock('./components/ChatComposer', () => ({
  default: ({ modelSelectorSlot }: { modelSelectorSlot?: React.ReactNode }) => {
    h.composerRenders.value += 1
    // A render loop unmounts the page here, so the test fails quickly instead of spinning the worker.
    if (h.composerRenders.value > 200) throw new Error('ChatPage render loop')
    return <div data-testid="composer">{modelSelectorSlot}</div>
  }
}))
vi.mock('./components/ChatPrimarySelection', () => ({
  default: ({
    selectedProfileId,
    memberModel
  }: {
    selectedProfileId: string | null
    memberModel?: { state: string }
  }) => {
    h.selections.push({ profileId: selectedProfileId, memberModel: memberModel?.state })
    return (
      <output data-testid="selection">
        {`${selectedProfileId ?? 'null'}|${memberModel?.state ?? 'none'}`}
      </output>
    )
  }
}))
vi.mock('./components/AgentThreadSidesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession }: any) => <pre data-testid="session">{currentSession?.id}</pre>
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))

const scope = 'member-profile-loop-fixture'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: scope, threadId: 'pane' } as const
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
// The lead has no model selected, so a member without its own choice has no runnable model.
const lead = {
  id: 'lead',
  title: 'Poster thread',
  messages: [],
  teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false }
}
const designer = {
  id: 'designer',
  createdAt: 1,
  title: '设计师',
  messages: [],
  teamLeadId: 'lead',
  teamMemberName: '设计师',
  teamRole: '设计师'
}

function Harness() {
  const [host, setHost] = React.useState<HTMLDivElement | null>(null)
  return (
    <MemoryRouter>
      <ThemeProvider theme={createTheme()}>
        <div data-testid="sub-rows" ref={setHost} />
        <ChatPage compact active storageScope={scope} route={route} threadSubRowsHost={host} />
      </ThemeProvider>
    </MemoryRouter>
  )
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
}

describe('ChatPage member profile selection', () => {
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
    h.sessions.value = [lead, designer]
    h.composerRenders.value = 0
    h.selections.length = 0
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'designer')
  })
  afterEach(() => {
    cleanup()
    if (oldApi) Object.defineProperty(window, 'api', oldApi)
    else Reflect.deleteProperty(window, 'api')
    localStorage.clear()
    sessionStorage.clear()
  })

  it('settles on an unavailable selection for a member whose lead has no model', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('designer'))
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent('null|unavailable')
    )
    const rendersWhenSettled = h.composerRenders.value
    await settle()
    // No ping-pong: the page stops rendering, and the member never shows a model it will not use.
    expect(h.composerRenders.value - rendersWhenSettled).toBeLessThan(3)
    expect(h.composerRenders.value).toBeLessThan(20)
    expect(screen.getByTestId('selection')).toHaveTextContent('null|unavailable')
    // The page may render the previous selection once before the sync effect clears it; once cleared,
    // the member's selection is never replaced by another profile again.
    const memberSelections = h.selections.filter((selection) => selection.memberModel !== undefined)
    const firstCleared = memberSelections.findIndex((selection) => selection.profileId === null)
    expect(firstCleared).toBeGreaterThanOrEqual(0)
    expect(memberSelections.slice(firstCleared).map((selection) => selection.profileId)).toEqual(
      memberSelections.slice(firstCleared).map(() => null)
    )
  })

  it('normalizes the selection again after leaving the member for an ordinary conversation', async () => {
    render(<Harness />)
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent('null|unavailable')
    )
    await settle()

    fireEvent.click(within(screen.getByTestId('sub-rows')).getByRole('button', { name: 'Lead' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    // The lead is an ordinary conversation: it gets the first available profile instead of null.
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent('fixture-profile|none')
    )
    const rendersWhenSettled = h.composerRenders.value
    await settle()
    expect(h.composerRenders.value - rendersWhenSettled).toBeLessThan(3)
    expect(screen.getByTestId('selection')).toHaveTextContent('fixture-profile|none')
  })
})
