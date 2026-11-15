import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zh from '@shared/locales/zh-CN/renderer.json'
import en from '@shared/locales/en-US/renderer.json'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

// Wiring only: the real ChatPage turns the result of a slash command into a card of the
// transcript tail in the Agent column, and keeps its views in the full-page chat.
const h = vi.hoisted(() => ({
  config: { value: null as any },
  sessions: { value: [] as any[] },
  api: { value: null as any },
  profiles: [{ id: 'fixture-profile', model_name: 'fixture-model', model_use: 'chat' }],
  notify: vi.fn(),
  navigate: vi.fn(),
  update: vi.fn(),
  configUtils: {}
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, opts?: Record<string, unknown>) => {
      const text = key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], zh)
      const template = typeof text === 'string' ? text : (opts?.defaultValue as string) || key
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(opts?.[name] ?? ''))
    }
  })
}))
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate
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
  default: ({ composerInputRef, inputValue, onInputChange, onSend }: any) => (
    <>
      <input
        ref={composerInputRef}
        data-testid="input"
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
// The list double shows what ChatPage hands to the real list: the tail rows and the scroll token.
vi.mock('./components/ChatMessageList', () => ({
  default: ({ currentSession, tail, tailScrollToken, columnStyle }: any) => (
    <div data-testid="list" data-column={String(Boolean(columnStyle))} data-token={tailScrollToken}>
      <pre data-testid="session">{currentSession?.id}</pre>
      {tail}
    </div>
  )
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({
  default: ({ visibleSessions, onSelectSession }: any) => (
    <>
      {visibleSessions.map((session: { id: string }) => (
        <button key={session.id} onClick={() => onSelectSession(session.id)}>
          {`open ${session.id}`}
        </button>
      ))}
    </>
  )
}))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'cards-fixture',
  threadId: 'pane'
} as const
const anyResult = {
  jobs: [],
  messages: [],
  entries: [],
  notes: [],
  skills: [],
  staleDisabledIds: [],
  documentToken: 'fixture-token',
  revision: 0
}
/** Every service method answers with an empty result unless `overrides` names it ("svc.method"). */
const services = (overrides: Record<string, unknown> = {}) => {
  const fallback = vi.fn(async () => anyResult)
  return new Proxy(
    {},
    {
      get: (_target, service) =>
        service === 'then'
          ? undefined
          : new Proxy(
              {},
              {
                get: (_service, method) =>
                  method === 'then'
                    ? undefined
                    : (overrides[`${String(service)}.${String(method)}`] ?? fallback)
              }
            )
    }
  )
}
const useServices = (overrides: Record<string, unknown>) => {
  h.api.value = services(overrides)
  Object.defineProperty(window, 'api', { configurable: true, value: h.api.value })
}
const page = (props: { compact?: boolean; active?: boolean } = {}) => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme()}>
      <ChatPage
        compact={props.compact ?? true}
        active={props.active}
        storageScope="cards-fixture"
        route={route}
      />
    </ThemeProvider>
  </MemoryRouter>
)
const renderPage = async (props: { compact?: boolean } = {}) => {
  const view = render(page(props))
  await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
  return view
}
const run = (command: string) => {
  fireEvent.change(screen.getByTestId('input'), { target: { value: command } })
  fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))
}
const cards = () => screen.queryAllByTestId('chat-command-card')
const commands = () => cards().map((card) => card.getAttribute('data-command'))
const token = () => Number(screen.getByTestId('list').getAttribute('data-token'))
/** Test ids of the boxes that used to be stacked above the transcript. */
const OLD_VIEWS = [
  'agent-inspection-view',
  'agent-basic-command-view',
  'agent-configuration-view',
  'agent-scratchpad-view',
  'image-repair-view',
  'replay-confirmation',
  'agent-goal-view'
]
const expectCardsInTheTranscriptOnly = () => {
  for (const id of OLD_VIEWS) expect(screen.queryByTestId(id)).toBeNull()
  for (const card of cards()) expect(screen.getByTestId('list')).toContainElement(card)
}
const expectNothingAboveTheTranscript = () => {
  expectCardsInTheTranscriptOnly()
  // The list is the first thing with any text in the main column.
  const column = document.querySelector('[data-chat-main-column]')!
  const before = [...column.querySelectorAll('*')].filter(
    (element) =>
      element.compareDocumentPosition(screen.getByTestId('list')) &
        Node.DOCUMENT_POSITION_FOLLOWING &&
      !element.contains(screen.getByTestId('list')) &&
      (element.textContent ?? '').trim() !== '' &&
      !/^open /.test(element.textContent ?? '')
  )
  expect(before).toEqual([])
}

describe('slash-command results in the Agent column', () => {
  const oldApi = Object.getOwnPropertyDescriptor(window, 'api')
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    h.notify.mockClear()
    h.navigate.mockClear()
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
    useServices({})
    h.sessions.value = [
      {
        id: 'lead',
        title: 'Lead',
        profileId: 'fixture-profile',
        createdAt: 2,
        messages: [
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' }
        ]
      },
      { id: 'other', title: 'Other', profileId: 'fixture-profile', createdAt: 1, messages: [] }
    ]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'cards-fixture'), 'lead')
  })
  afterEach(() => {
    cleanup()
    if (oldApi) Object.defineProperty(window, 'api', oldApi)
    else Reflect.deleteProperty(window, 'api')
    localStorage.clear()
    sessionStorage.clear()
  })

  it('appends one card per /status, /env and /system_prompt at the end of the transcript', async () => {
    await renderPage()
    expect(cards()).toHaveLength(0)
    const before = token()

    run('/status')
    await waitFor(() => expect(commands()).toEqual(['/status']))
    expect(screen.getByTestId('input')).toHaveValue('')
    expect(token()).toBe(before + 1)
    const body = within(cards()[0]).getByTestId('chat-command-card-text')
    expect(body).toHaveTextContent('"messages": 2')
    expect(getComputedStyle(body).fontFamily).toContain('monospace')
    expect(within(cards()[0]).queryByRole('button')).toBeNull()

    // The same command again adds a second card; the first one stays.
    run('/status')
    await waitFor(() => expect(commands()).toEqual(['/status', '/status']))
    run('/env')
    run('/system_prompt')
    await waitFor(() =>
      expect(commands()).toEqual(['/status', '/status', '/env', '/system_prompt'])
    )
    expect(token()).toBe(before + 4)
    expect(cards()[2]).toHaveTextContent('lead')
    expectNothingAboveTheTranscript()
  })

  it('lists the jobs as rows without a refresh button; running /jobs again adds a fresh card', async () => {
    // The thread's job poller reads the same service, so the answer is a value, not a queue.
    let answer: () => Promise<unknown> = async () => ({
      jobs: [{ id: 'job-1', kind: 'explore', status: 'running', expiresAt: Date.now() + 60_000 }]
    })
    const listAgentJobs = vi.fn((_scope: unknown) => answer())
    useServices({ 'svcLLMProxy.listAgentJobs': listAgentJobs })
    await renderPage()

    run('/jobs')
    await waitFor(() => expect(commands()).toEqual(['/jobs']))
    expect(listAgentJobs).toHaveBeenCalledWith({ route, conversationId: 'lead' })
    const rows = within(cards()[0]).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('explorerunning · job-1')
    expect(within(cards()[0]).queryByRole('button')).toBeNull()

    answer = async () => ({ jobs: [] })
    run('/jobs')
    await waitFor(() => expect(commands()).toEqual(['/jobs', '/jobs']))
    expect(cards()[1]).toHaveTextContent(zh.chat.no_helper_jobs)
    // The first card still shows what it showed.
    expect(cards()[0]).toHaveTextContent('explore')

    answer = async () => {
      throw new Error('offline')
    }
    run('/jobs')
    await waitFor(() => expect(commands()).toHaveLength(3))
    expect(cards()[2]).toHaveAttribute('data-error', 'true')
    expect(within(cards()[2]).getByRole('alert')).toHaveTextContent(zh.chat.command_card.jobs_failed)
    expect(en.chat.command_card.jobs_failed).toBe('Could not read the jobs.')
    // (The process area, which lists the same jobs above the transcript, leaves with a later item.)
    expectCardsInTheTranscriptOnly()
  })

  it('shows the notes of /scratchpad and /pad with the revision as the title and one muted line', async () => {
    const getAgentNotes = vi
      .fn()
      .mockResolvedValueOnce({ revision: 3, notes: [{ key: 'plan', value: 'ship it', updatedAt: 1 }] })
      .mockResolvedValueOnce({ revision: 4, notes: [] })
      .mockRejectedValueOnce(new Error('offline'))
    useServices({ 'svcLLMProxy.getAgentNotes': getAgentNotes })
    await renderPage()

    run('/scratchpad')
    await waitFor(() => expect(commands()).toEqual(['/scratchpad']))
    expect(within(cards()[0]).getByTestId('chat-command-card-title')).toHaveTextContent('笔记版本 3')
    expect(within(cards()[0]).getByTestId('chat-command-card-text')).toHaveTextContent('plan: ship it')
    expect(within(cards()[0]).getByTestId('chat-command-card-note')).toHaveTextContent(
      zh.chat.command_card.scratchpad_note
    )
    expect(within(cards()[0]).queryByRole('button')).toBeNull()

    run('/pad')
    await waitFor(() => expect(commands()).toEqual(['/scratchpad', '/pad']))
    expect(cards()[1]).toHaveTextContent(zh.chat.agent_scratchpad.empty)

    run('/pad')
    await waitFor(() => expect(commands()).toHaveLength(3))
    expect(within(cards()[2]).getByRole('alert')).toHaveTextContent(zh.chat.agent_scratchpad.failed)
    expectNothingAboveTheTranscript()
  })

  it('hands /plugin, /module and /video_gen over through text links in the card', async () => {
    await renderPage()
    run('/plugin')
    run('/module configure')
    run('/video_gen')
    await waitFor(() => expect(commands()).toEqual(['/plugin', '/module', '/video_gen']))
    expect(cards()[0]).toHaveTextContent(zh.chat.command_card.plugin_hint)
    expect(cards()[1]).toHaveTextContent(zh.chat.command_card.module_hint)
    expect(cards()[2]).toHaveTextContent(zh.chat.command_card.video_gen_hint)
    for (const key of ['plugin_hint', 'module_hint', 'video_gen_hint', 'scratchpad_note'] as const) {
      expect(en.chat.command_card[key]).toMatch(/^[A-Z]/)
    }

    fireEvent.click(within(cards()[0]).getByRole('button', { name: zh.chat.open_plugin_center }))
    expect(h.navigate).toHaveBeenLastCalledWith('/workshop/plugins', { state: null })
    const moduleLinks = within(cards()[1]).getAllByRole('button')
    expect(moduleLinks.map((link) => link.textContent)).toEqual([
      zh.chat.open_tool_environment_settings,
      zh.chat.open_mcp_client_settings
    ])
    fireEvent.click(moduleLinks[1])
    expect(h.navigate).toHaveBeenLastCalledWith('/settings?tab=mcp', { state: null })
    fireEvent.click(within(cards()[2]).getByRole('button'))
    expect(h.navigate).toHaveBeenLastCalledWith('/qappexecute', {
      state: { magicpotOpenVideoGeneration: true }
    })
    // Following a link leaves the card where it is.
    expect(commands()).toEqual(['/plugin', '/module', '/video_gen'])
    expectNothingAboveTheTranscript()
  })

  it('drops the cards with the conversation and a late result of the conversation that was left', async () => {
    // Every read stays open (the job poller reads too); all of them are answered at once below.
    const pending: ((value: unknown) => void)[] = []
    const listAgentJobs = vi.fn((_scope: unknown) => new Promise((resolve) => pending.push(resolve)))
    useServices({ 'svcLLMProxy.listAgentJobs': listAgentJobs })
    await renderPage()
    run('/status')
    await waitFor(() => expect(commands()).toEqual(['/status']))
    run('/jobs')
    await waitFor(() =>
      expect(listAgentJobs.mock.calls.filter(([scope]) => (scope as any).conversationId === 'lead').length).toBe(2)
    )
    const before = token()

    fireEvent.click(screen.getByRole('button', { name: 'open other' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('other'))
    expect(cards()).toHaveLength(0)
    await act(async () => {
      for (const release of pending)
        release({ jobs: [{ id: 'late', kind: 'explore', status: 'done', expiresAt: Date.now() + 60_000 }] })
    })
    expect(cards()).toHaveLength(0)
    expect(token()).toBe(before)

    fireEvent.click(screen.getByRole('button', { name: 'open lead' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(cards()).toHaveLength(0)
  })

  it('asks before /branch, /regen and /edit through a prompt card and keeps the answered card', async () => {
    await renderPage()
    run('/branch')
    const card = await screen.findByTestId('chat-command-confirm-card')
    expect(screen.getByTestId('list')).toContainElement(card)
    expect(card).toHaveAttribute('data-command', '/branch')
    expect(within(card).getByTestId('chat-prompt-card-title')).toHaveTextContent('确认')
    expect(within(card).getByTestId('chat-prompt-card-prompt')).toHaveTextContent(
      zh.chat.command_card.branch_prompt
    )
    const buttons = within(card).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['新建对话', '取消'])
    expect(buttons[0]).toHaveAttribute('data-primary', 'true')
    expect(buttons[1]).not.toHaveAttribute('data-primary')
    expect(screen.getByTestId('input')).toHaveValue('')
    expectNothingAboveTheTranscript()

    fireEvent.click(buttons[1])
    expect(card).toHaveAttribute('data-resolved', 'true')
    expect(within(card).getByTestId('chat-prompt-card-state')).toHaveTextContent('已回答')
    expect(within(card).getByTestId('chat-prompt-card-reply')).toHaveTextContent('→ 取消')
    expect(within(card).queryByRole('button')).toBeNull()
    // The buttons are gone: the keyboard is back in the composer, and nothing was created.
    expect(screen.getByTestId('input')).toHaveFocus()
    expect(screen.getByTestId('session')).toHaveTextContent('lead')

    run('/regen')
    run('/edit 1 Another question')
    await waitFor(() => expect(screen.getAllByTestId('chat-command-confirm-card')).toHaveLength(3))
    const [, regen, edit] = screen.getAllByTestId('chat-command-confirm-card')
    expect(regen).toHaveTextContent(zh.chat.command_card.regen_prompt)
    expect(edit).toHaveTextContent('保留第 1 条消息之前的内容')
    for (const key of ['branch_prompt', 'regen_prompt', 'edit_prompt', 'repair_prompt'] as const) {
      expect(en.chat.command_card[key]).toMatch(/^[A-Z]/)
    }
    expect(en.chat.command_card.confirm_title).toBe('Confirm')
    expect(en.chat.command_card.new_conversation).toBe('New conversation')
  })

  it('confirms a card with the keyboard and leaves for the new conversation', async () => {
    await renderPage()
    run('/branch')
    const card = await screen.findByTestId('chat-command-confirm-card')
    const user = userEvent.setup()
    screen.getByTestId('input').focus()
    // The card is above the composer: the buttons are the two tab stops before the input.
    await user.tab({ shift: true })
    expect(within(card).getByRole('button', { name: '取消' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(within(card).getByRole('button', { name: '新建对话' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByTestId('session')).not.toHaveTextContent('lead'))
    // The card belonged to the conversation that was left.
    expect(screen.queryByTestId('chat-command-confirm-card')).toBeNull()
    expect(cards()).toHaveLength(0)
  })

  it('marks a confirmation that can no longer run as expired instead of running it', async () => {
    const view = await renderPage()
    run('/branch')
    const card = await screen.findByTestId('chat-command-confirm-card')
    // The model settings change between the question and the answer.
    h.config.value = { ...h.config.value, llm_config: structuredClone(h.config.value.llm_config) }
    view.rerender(page())
    h.notify.mockClear()
    fireEvent.click(within(card).getByRole('button', { name: '新建对话' }))
    expect(card).toHaveAttribute('data-resolved', 'true')
    expect(within(card).getByTestId('chat-prompt-card-state')).toHaveTextContent('已失效')
    expect(within(card).queryByTestId('chat-prompt-card-reply')).toBeNull()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('session')).toHaveTextContent('lead')
    expect(en.chat.command_card.expired).toBe('expired')
  })

  it('lists the missing images of /repair-images in the card and confirms with Space', async () => {
    h.sessions.value[0].messages[1].attachments = [
      { type: 'image', url: 'local-media:///fixture/missing.png' }
    ]
    const fileExistsBatch = vi.fn(async () => [false])
    useServices({ 'svcShell.fileExistsBatch': fileExistsBatch })
    await renderPage()
    run('/repair-images')
    const card = await screen.findByTestId('chat-command-confirm-card')
    expect(card).toHaveAttribute('data-command', '/repair-images')
    expect(within(card).getByTestId('chat-prompt-card-prompt')).toHaveTextContent('1 张缺失的本地图片')
    expect(within(card).getByTestId('chat-prompt-card-detail')).toHaveTextContent(/2.*1/)
    expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '确认',
      '取消'
    ])
    expectNothingAboveTheTranscript()

    const user = userEvent.setup()
    within(card).getByRole('button', { name: '确认' }).focus()
    await user.keyboard(' ')
    expect(card).toHaveAttribute('data-resolved', 'true')
    expect(within(card).getByTestId('chat-prompt-card-reply')).toHaveTextContent('→ 确认')
    expect(screen.getByTestId('input')).toHaveFocus()

    // Nothing missing: nothing to confirm, the result is a plain card.
    fileExistsBatch.mockResolvedValue([true])
    run('/repair-images')
    await waitFor(() => expect(commands()).toEqual(['/repair-images']))
    expect(screen.getAllByTestId('chat-command-confirm-card')).toHaveLength(1)
  })

  it('runs /compact at once: no question, no card', async () => {
    await renderPage()
    run('/compact')
    await waitFor(() => expect(screen.getByTestId('input')).toHaveValue(''))
    expect(cards()).toHaveLength(0)
    expect(screen.queryByTestId('chat-command-confirm-card')).toBeNull()
    expectNothingAboveTheTranscript()
  })

  it('shows the goal records inside one card that moves to the end when /goal runs again', async () => {
    await renderPage()
    run('/goal')
    await waitFor(() => expect(commands()).toEqual(['/goal']))
    const card = cards()[0]
    expect(within(card).getByTestId('chat-command-card-title')).toHaveTextContent('线程目标')
    const records = await screen.findByTestId('goal-records-host')
    expect(within(card).getByTestId('chat-command-card-panel')).toContainElement(records)
    expect(records).toHaveTextContent('lead')
    // No close button: the card leaves with the conversation.
    expect(within(card).queryByRole('button')).toBeNull()
    expect(screen.getByTestId('input')).toHaveValue('')

    run('/status')
    await waitFor(() => expect(commands()).toEqual(['/goal', '/status']))
    const before = token()
    run('/goal')
    await waitFor(() => expect(commands()).toEqual(['/status', '/goal']))
    expect(token()).toBe(before + 1)
    // The same view moved with its card; it was not opened a second time.
    expect(screen.getAllByTestId('goal-records-host')).toEqual([records])
    expect(cards()[1]).toContainElement(records)
    expectNothingAboveTheTranscript()

    fireEvent.click(screen.getByRole('button', { name: 'open other' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('other'))
    expect(cards()).toHaveLength(0)
    expect(screen.queryByTestId('goal-records-host')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'open lead' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    expect(cards()).toHaveLength(0)
    expect(screen.queryByTestId('goal-records-host')).toBeNull()
  })

  it('shows the thread skills inside one card for /skills and /skill, with the transcript still there', async () => {
    const listAgentSessionSkills = vi.fn(async () => ({
      revision: 1,
      skills: [
        { id: 'one', name: 'Poster', description: 'Makes posters', paths: [], hidden: false, enabled: true }
      ],
      staleDisabledIds: [],
      truncated: false,
      grantsPermission: false
    }))
    useServices({ 'svcLLMProxy.listAgentSessionSkills': listAgentSessionSkills })
    await renderPage()
    // The command is accepted once the thread's skill scope is bound.
    await waitFor(() => {
      run('/skills')
      expect(commands()).toEqual(['/skills'])
    })
    const card = cards()[0]
    const panel = within(card).getByTestId('chat-command-card-panel')
    expect(await within(panel).findByText(`Poster · ${zh.chat.agent_skill_session.enabled}`)).toBeVisible()
    // The card has no close button, and nothing took the place of the transcript or the composer.
    expect(within(card).queryByRole('button', { name: zh.general.close })).toBeNull()
    expect(screen.getByTestId('list')).toBeVisible()
    expect(screen.getByTestId('input')).toBeVisible()
    expect(screen.getByTestId('input')).toHaveValue('')
    expectNothingAboveTheTranscript()

    run('/status')
    await waitFor(() => expect(commands()).toEqual(['/skills', '/status']))
    // "/skill" is the same view: its one card moves to the end under the command that was typed.
    run('/skill list')
    await waitFor(() => expect(commands()).toEqual(['/status', '/skill']))
    expect(within(cards()[1]).getByText(`Poster · ${zh.chat.agent_skill_session.enabled}`)).toBeVisible()
    // The skills card does not take other commands away.
    run('/scratchpad')
    await waitFor(() => expect(commands()).toEqual(['/status', '/skill', '/scratchpad']))

    fireEvent.click(screen.getByRole('button', { name: 'open other' }))
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('other'))
    expect(cards()).toHaveLength(0)
    expect(screen.queryByText(`Poster · ${zh.chat.agent_skill_session.enabled}`)).toBeNull()
  })

  it('drops the cards when the pane stops being the active one', async () => {
    const view = await renderPage()
    run('/status')
    await waitFor(() => expect(commands()).toEqual(['/status']))
    view.rerender(page({ active: false }))
    expect(cards()).toHaveLength(0)
    view.rerender(page({ active: true }))
    expect(cards()).toHaveLength(0)
  })

  it('keeps the views of the full-page chat', async () => {
    await renderPage({ compact: false })
    expect(screen.getByTestId('list')).toHaveAttribute('data-column', 'false')
    run('/status')
    const view = await screen.findByTestId('agent-inspection-view')
    expect(view).toHaveTextContent('"messages": 2')
    expect(cards()).toHaveLength(0)
    fireEvent.click(within(view).getByRole('button', { name: zh.chat.close_command_view }))
    expect(screen.queryByTestId('agent-inspection-view')).toBeNull()

    run('/plugin')
    expect(await screen.findByTestId('agent-configuration-view')).toHaveTextContent('/plugin')
    expect(cards()).toHaveLength(0)
  })
})
