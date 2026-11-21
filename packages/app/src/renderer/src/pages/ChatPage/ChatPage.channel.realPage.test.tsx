/**
 * Channel real-page test bed: the real ChatPage (real composer, message list, request code and
 * chat storage) on in-memory fakes, for team messages and stop/queue cases.
 *
 * Run with config/vitest/vitest.web.channel.config.mjs. Its first setup file
 * (test/channelDenyGuards.ts) refuses and counts fetch, XHR, WebSocket, EventSource, workers,
 * real IndexedDB, TCP sockets and every bridge call that a test did not list, and fails a test
 * that left a refusal behind. Each case here also asserts it explicitly.
 *
 * The three team-message cases are ported from ChatPage.crossLayerTeamMessages.test.tsx, which
 * needs the MAIN service, a loopback HTTP server and temp directories. Here MAIN is
 * `FakeTeamMain`: an in-memory stand-in for the chat bridge and the MAIN team message queue.
 *
 * Every mount gets its own copy of the page and of the chat storage (`loadPageModules`): the
 * storage caches its connection, summary indexes and save baselines at module level, so a shared
 * copy would make all cases read and write the storage of the first one. `./ChatPage` and
 * `./chatStorage` are therefore never imported statically here.
 */
import {
  allowChannelBridge,
  allowChannelInMemoryIndexedDb,
  assertNoChannelDeniedAttempts,
  channelDeniedAttemptCount,
  channelDeniedAttempts,
  channelGuardedGlobals,
  isChannelGuardDenied,
  repairReplacedChannelGuards,
  takeChannelDeniedAttempts,
  totalChannelDeniedAttempts,
  type ChannelBridgeAllowance
} from '../../test/channelDenyGuards'
import type React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type {
  AgentTeamMessageClaim,
  AgentTeamMessageIntent,
  AgentTeamMessageQueueScope
} from '@shared/api/agentTeamMessage'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import type {
  LLMCancelConversationReq,
  LLMChatReq,
  LLMChatStreamResp
} from '@shared/api/svcLLMProxy'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { createFakeChatIndexedDb, type FakeChatIndexedDb } from '../../testUtils/fakeChatIndexedDb'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import type { ChatSession } from './chatStorage'

// Runs before every import of this file: the guards must already be installed by the setup file.
vi.hoisted(() => {
  if (!(globalThis as Record<symbol, unknown>)[Symbol.for('magicpot.channelDenyGuards.v1')]) {
    throw new Error(
      'ChatPage.channel.realPage.test.tsx must run with config/vitest/vitest.web.channel.config.mjs: the deny guards are not installed.'
    )
  }
})

const h = vi.hoisted(() => ({
  config: { value: null as unknown },
  notify: vi.fn(),
  update: vi.fn(),
  configUtils: {}
}))
// Plain module replacements only (no importOriginal): the page's own modules stay real.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
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

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

const SCOPE = 'isolated-fixture'
const ROUTE = { channel: 'canvas', scopeType: 'thread', scopeId: SCOPE, threadId: 'pane' } as const
const PROFILE_ID = 'fixture-profile'

type TeamToolName = 'send_message' | 'send_channel'
type ModelStep =
  | { text: string }
  | { tool: TeamToolName; callId: string; args: { recipient?: string; text: string } }
interface ModelTurn {
  request: LLMChatReq
  /** Text of the last user message of the request. */
  lastUserText: string
  /** Team tools MAIN would offer for this request (canvasAgentTools.ts team message gate). */
  teamTools: readonly TeamToolName[]
  /** Results of the tool calls the model already made in this request. */
  toolResults: readonly { callId: string; name: TeamToolName; content: string }[]
}
/** The scripted model: returns a final text or one team tool call; may stay pending. */
type FakeModel = (turn: ModelTurn) => ModelStep | Promise<ModelStep>

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content ?? '')

type FakeQueueEntry = {
  routeKey: string
  view: AgentTeamMessageIntent
  status: 'queued' | 'claimed' | 'closed'
  /** Queued before this page's document or process (main/api/agentTeamMessageQueue.ts). */
  carriedOver: boolean
  lease?: string
  starts: string[]
}

/**
 * In-memory stand-in for MAIN behind `window.api.svcLLMProxy`: the chat entry points, the team
 * message tools and the durable team message queue (main/api/agentTeamMessageQueue.ts: at most
 * 128 queued, list by route + storage scope + lead, a claim is a lease given out once, a delivery
 * request presents it as teamMessageDelivery and MAIN records the start before the request runs).
 * Nothing here leaves the process. Every request the page sent is kept for assertions.
 */
class FakeTeamMain {
  readonly calls: { method: string; request: unknown }[] = []
  readonly chatRequests: LLMChatReq[] = []
  readonly modelTurns: {
    conversationId: string
    hop: 1 | 2 | undefined
    teamTools: readonly TeamToolName[]
  }[] = []
  readonly toolResults: { callId: string; name: TeamToolName; content: string }[] = []
  readonly enqueued: AgentTeamMessageIntent[] = []
  readonly claimRequests: AgentTeamMessageClaim[] = []
  /** Every request start MAIN recorded for a claimed message (what the real store keeps in starts). */
  readonly starts: { id: string; recipient: string }[] = []
  /** Delivery requests MAIN refused ('Team message is no longer available.'). */
  readonly refusedDeliveries: LLMChatReq[] = []
  /** Conversation IDs of requests that were cancelled while the model was still working. */
  readonly cancelledRuns: string[] = []
  private readonly queue = new Map<string, FakeQueueEntry>()
  private readonly running = new Map<string, { conversationId: string; abort: AbortController }>()
  private nextId = 0
  private pending = 0

  constructor(private readonly model: FakeModel) {}

  /** Bridge calls that are in flight (a held model reply counts). */
  pendingCalls(): number {
    return this.pending
  }

  /** Ends every held model reply as cancelled (used when a failed test is torn down). */
  abortAll(): void {
    for (const run of this.running.values()) run.abort.abort()
  }

  private track<Req, Res>(
    method: string,
    run: (request: Req) => Promise<Res>
  ): (request: Req) => Promise<Res> {
    return async (request) => {
      this.calls.push({ method, request: structuredClone(request) })
      this.pending += 1
      try {
        return await run(request)
      } finally {
        this.pending -= 1
      }
    }
  }

  private teamTools(request: LLMChatReq): TeamToolName[] {
    const member = request.teamMember
    const offered =
      !!member &&
      (request.teamMessageHop === undefined || request.teamMessageHop === 1) &&
      request.conversationId === member.member &&
      !!request.route &&
      member.thread === request.route.threadId
    return offered ? ['send_message', 'send_channel'] : []
  }

  /** A message MAIN carried over (queued by a member before this page's document or process). */
  carryOver(input: Omit<AgentTeamMessageIntent, 'id'>): string {
    const view: AgentTeamMessageIntent = {
      id: `fixture-carried-${++this.nextId}`,
      ...structuredClone(input)
    }
    this.queue.set(view.id, {
      routeKey: getAgentSessionKey(normalizeAgentRoute(ROUTE)),
      view,
      status: 'queued',
      carriedOver: true,
      starts: []
    })
    return view.id
  }

  /** MAIN's admission of a delivery request (agentTeamMessageQueue.ts admitDelivery). */
  private admitDelivery(request: LLMChatReq): void {
    if (!Object.hasOwn(request, 'teamMessageDelivery')) return
    const delivery = request.teamMessageDelivery,
      member = request.teamMember
    const entry = delivery ? this.queue.get(delivery.id) : undefined
    const source = entry?.view.source
    const admitted =
      !!entry &&
      !!delivery &&
      !!member &&
      !!source &&
      entry.status !== 'queued' &&
      entry.lease === delivery.lease &&
      request.teamMessageHop === entry.view.hop &&
      member.scope === source.scope &&
      member.thread === source.thread &&
      member.lead === source.lead &&
      (entry.view.kind === 'message'
        ? member.member === entry.view.recipient
        : member.member !== source.member) &&
      (entry.status === 'claimed' || entry.starts.includes(member.member))
    if (!admitted) {
      this.refusedDeliveries.push(structuredClone(request))
      throw new Error('Team message is no longer available.')
    }
    if (entry.starts.includes(member.member)) return
    entry.starts.push(member.member)
    this.starts.push({ id: delivery.id, recipient: member.member })
    if (entry.view.kind === 'message') entry.status = 'closed'
  }

  private callTeamTool(
    request: LLMChatReq,
    step: Extract<ModelStep, { tool: TeamToolName }>
  ): string {
    const source = request.teamMember
    if (!source || !request.route || !this.teamTools(request).includes(step.tool)) {
      throw new Error('Tool is outside this Agent conversation.')
    }
    const recipient = step.tool === 'send_message' ? step.args.recipient : undefined
    if (
      !step.args.text.trim() ||
      (step.tool === 'send_message' && (!recipient || recipient === source.member))
    ) {
      throw new Error('Invalid team message arguments.')
    }
    if ([...this.queue.values()].filter((entry) => entry.status === 'queued').length >= 128)
      throw new Error('Team queue capacity reached.')
    const view: AgentTeamMessageIntent = {
      id: `fixture-intent-${++this.nextId}`,
      source: { ...source },
      kind: step.tool === 'send_message' ? 'message' : 'channel',
      hop: request.teamMessageHop === 1 ? 2 : 1,
      ...(recipient === undefined ? {} : { recipient }),
      text: step.args.text
    }
    this.queue.set(view.id, {
      routeKey: getAgentSessionKey(normalizeAgentRoute(request.route)),
      view,
      status: 'queued',
      carriedOver: false,
      starts: []
    })
    this.enqueued.push(structuredClone(view))
    return JSON.stringify({ status: 'queued', requestId: view.id })
  }

  private async complete(request: LLMChatReq, signal: AbortSignal): Promise<string> {
    this.chatRequests.push(structuredClone(request))
    const teamTools = this.teamTools(request)
    const toolResults: { callId: string; name: TeamToolName; content: string }[] = []
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
    for (let round = 0; round < 8; round += 1) {
      this.modelTurns.push({
        conversationId: request.conversationId ?? '',
        hop: request.teamMessageHop,
        teamTools
      })
      const step = await Promise.race([
        Promise.resolve(
          this.model({ request, lastUserText: textOf(lastUser?.content), teamTools, toolResults })
        ),
        new Promise<never>((_resolve, reject) => {
          const fail = (): void => reject(new Error('Request cancelled'))
          if (signal.aborted) fail()
          else signal.addEventListener('abort', fail, { once: true })
        })
      ])
      if ('text' in step) return step.text
      const result = {
        callId: step.callId,
        name: step.tool,
        content: this.callTeamTool(request, step)
      }
      toolResults.push(result)
      this.toolResults.push(result)
    }
    throw new Error('Fixture model made too many tool calls.')
  }

  private begin(request: LLMChatReq & { cancellationId?: string }): {
    id: string
    signal: AbortSignal
  } {
    const id = request.cancellationId ?? `fixture-run-${++this.nextId}`
    const abort = new AbortController()
    this.running.set(id, { conversationId: request.conversationId ?? '', abort })
    return { id, signal: abort.signal }
  }

  private queueMatches(scope: AgentTeamMessageQueueScope, entry: FakeQueueEntry): boolean {
    return (
      entry.routeKey === getAgentSessionKey(normalizeAgentRoute(scope.route)) &&
      entry.view.source.scope === scope.storageScope &&
      entry.view.source.lead === scope.conversationId
    )
  }

  /** What the page may call on `window.api`; everything else stays refused by the guards. */
  bridge(): ChannelBridgeAllowance {
    return {
      svcLLMProxy: {
        chatStream: (request: LLMChatReq, stream: ServerStreaming<LLMChatStreamResp>) =>
          this.track('chatStream', async (req: LLMChatReq) => {
            // Before anything else: MAIN records the start of a delivery, or refuses it.
            this.admitDelivery(req)
            const run = this.begin(req)
            stream.abortReceiver?.onAbort(() => this.running.get(run.id)?.abort.abort())
            try {
              const text = await this.complete(req, run.signal)
              stream.onData({ type: 'text-delta', delta: text, done: false })
              stream.onData({
                type: 'done',
                delta: '',
                done: true,
                fullContent: text,
                content: text,
                finishReason: 'stop'
              })
            } catch (error) {
              if (!run.signal.aborted) throw error
              this.cancelledRuns.push(req.conversationId ?? '')
              stream.onData({ type: 'done', delta: '', done: true, finishReason: 'cancelled' })
            } finally {
              this.running.delete(run.id)
            }
          })(request),
        cancelConversation: this.track(
          'cancelConversation',
          async (req: LLMCancelConversationReq) => {
            let cancelled = false
            for (const [id, run] of this.running) {
              if (
                run.conversationId !== req.conversationId ||
                (req.cancellationId && req.cancellationId !== id)
              )
                continue
              run.abort.abort()
              cancelled = true
            }
            return { cancelled }
          }
        ),
        listAgentTeamMessages: this.track(
          'listAgentTeamMessages',
          async (req: AgentTeamMessageQueueScope) => ({
            intents: [...this.queue.values()]
              .filter((entry) => entry.status === 'queued' && this.queueMatches(req, entry))
              .map((entry) => ({
                ...structuredClone(entry.view),
                ...(entry.carriedOver ? { carriedOver: true as const } : {})
              }))
          })
        ),
        claimAgentTeamMessage: this.track(
          'claimAgentTeamMessage',
          async (req: AgentTeamMessageClaim) => {
            this.claimRequests.push(structuredClone(req))
            const entry = this.queue.get(req.id)
            if (!entry || entry.status !== 'queued' || !this.queueMatches(req, entry)) return {}
            entry.status = 'claimed'
            entry.lease = `fixture-lease-${++this.nextId}`
            return {
              intent: {
                ...structuredClone(entry.view),
                ...(entry.carriedOver ? { carriedOver: true as const } : {}),
                lease: entry.lease
              }
            }
          }
        ),
        // The thread has no background jobs or processes, and a running request asks nothing.
        listAgentJobs: this.track('listAgentJobs', async () => ({ jobs: [] })),
        listAgentProcesses: this.track('listAgentProcesses', async () => ({ jobs: [] })),
        // The open thread list asks for the side conversations of the open one: there are none.
        listAgentSides: this.track('listAgentSides', async () => ({ branches: [] })),
        listAgentInteractions: this.track('listAgentInteractions', async () => ({
          interactions: []
        })),
        listAgentArchiveQueries: this.track('listAgentArchiveQueries', async () => ({
          queries: []
        })),
        // Skill, HTML-app and first-run pane bindings are MAIN capabilities this fixture leaves
        // off: listed as `null`, they read as absent (as in the original test, whose MAIN bridge
        // did not have them), so the page takes its "not available" path without a call.
        agentSkillScopeRevision: null,
        setAgentSkillScope: null,
        setAgentHtmlScope: null,
        managedFirstRunPaneRevision: null,
        setManagedFirstRunPaneScope: null
      }
    }
  }
}

type ChatPageComponent = (typeof import('./ChatPage'))['default']
type ChatStorageModule = typeof import('./chatStorage')
type ChannelPageProps = Partial<React.ComponentProps<ChatPageComponent>>

const SESSION_STORE = 'sessions-v2'
const storageKey = (id: string): string => `${SCOPE}\u0000${id}`

/**
 * A new copy of the page and of the chat storage it uses: no cached connection, summary index,
 * save baseline or any other module state of an earlier mount. With the same fake storage this is
 * a restart of the renderer's storage layer; with a new one, a page of its own.
 */
async function loadPageModules(): Promise<{
  ChatPage: ChatPageComponent
  storage: ChatStorageModule
}> {
  vi.resetModules()
  const storage = await import('./chatStorage')
  const { default: ChatPage } = await import('./ChatPage')
  return { ChatPage, storage }
}

interface ChannelPage {
  main: FakeTeamMain
  /** The in-memory storage this page, and only this page, reads and writes. */
  idb: FakeChatIndexedDb
  /** Renders the same page again with other props (pane switches: `{ active: false }`). */
  rerender(props: ChannelPageProps): void
  /** The record the real chat storage holds for a session. */
  stored(id: string): Promise<ChatSession | null>
  /** The thread-list host the page renders its lead and member rows into. */
  rows: HTMLElement
  send(text: string): void
  openTeamManagement(): Promise<HTMLElement>
  /** Names of the member rows the thread list shows, sorted. */
  memberNames(): string[]
  /** Unmounts, waits until storage and bridge are quiet, and asserts nothing was refused. */
  finish(): Promise<void>
  /** Unmounts and waits until storage and bridge are quiet (no assertions). */
  quiesce(): Promise<void>
}

/** The page of the running test until it finished; a failed test is torn down in afterEach. */
let mountedPage: Pick<ChannelPage, 'main' | 'quiesce'> | undefined

const theme = createTheme()
const lead = (): ChatSession =>
  ({
    id: 'lead',
    title: 'Lead',
    profileId: PROFILE_ID,
    messages: [],
    teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false }
  }) as ChatSession
const member = (id: string, role: string, messages: ChatSession['messages'] = []): ChatSession =>
  ({
    id,
    title: id,
    profileId: PROFILE_ID,
    messages,
    teamLeadId: 'lead',
    teamMemberName: id,
    teamRole: role
  }) as ChatSession

async function mountChannelPage(input: {
  /** The members the storage holds: seeded on a new storage, expected on a restart. */
  members: ChatSession[]
  model: FakeModel
  /**
   * Storage an earlier page of the same test left behind: a restart. Nothing is seeded again, the
   * page and the chat storage are loaded anew and open their own connection to this storage, and
   * the connection of the earlier page is refused from here on.
   */
  storage?: FakeChatIndexedDb
  /** Extra ChatPage props (for example `active: false` for a hidden pane). */
  props?: ChannelPageProps
  /** Extra fields of the seeded lead (for example its shared tasks). */
  lead?: Partial<ChatSession>
  /** A second, visible pane of the same lead in the same window (its own page instance and rows). */
  secondPane?: boolean
  /** Prepares the fake MAIN before the page's first poll (for example carried-over messages). */
  beforeMount?: (main: FakeTeamMain) => void
  /** The chat models of the configuration (default: the one fixture model, `PROFILE_ID`). */
  profiles?: readonly { id: string; model_name: string }[]
  /** Runs on the storage after the seed, before the page mounts (raw rows of other builds). */
  beforePage?: (idb: FakeChatIndexedDb) => void
}): Promise<ChannelPage> {
  if (mountedPage)
    throw new Error('mountChannelPage: finish() the earlier page of this test first.')
  const idb = input.storage ?? createFakeChatIndexedDb()
  const { ChatPage, storage } = await loadPageModules()
  idb.install((_name, fake) => allowChannelInMemoryIndexedDb(fake))
  const main = new FakeTeamMain(input.model)
  input.beforeMount?.(main)
  allowChannelBridge('api', main.bridge())

  const config = structuredClone(DEFAULT_CONFIG) as Config
  config.use_remote_llm = false
  config.llm_config.api_profiles = (
    input.profiles ?? [{ id: PROFILE_ID, model_name: 'fixture-model' }]
  ).map((profile) => ({
    id: profile.id,
    model_name: profile.model_name,
    model_use: 'chat',
    api_mode: 'chat-completions',
    // Never resolved: MAIN is the in-memory fake, and the guards refuse every connection.
    base_url: 'http://channel-fixture.invalid/v1/chat/completions',
    api_key: 'fixture-only'
  })) as Config['llm_config']['api_profiles']
  h.config.value = config

  const expectedKeys = ['lead', ...input.members.map((session) => session.id)]
    .map(storageKey)
    .sort()
  if (!input.storage) {
    for (const session of [{ ...lead(), ...input.lead }, ...input.members])
      await storage.saveSessionToDB(session, SCOPE)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), 'lead')
    // The seed went into THIS fake, one record per session, and nothing else is in it.
    expect(idb.stats.calls.put).toBe(expectedKeys.length)
  }
  input.beforePage?.(idb)
  // This storage holds exactly the conversations of this case: nothing of an earlier mount or test.
  expect(idb.keys(SESSION_STORE)).toEqual(expectedKeys)
  const handedOutBeforeMount = idb.stats.handedOut.length

  // The Agent column's thread list: the page renders the lead and member rows into this host.
  const rowsHost = document.createElement('div')
  rowsHost.setAttribute('data-testid', 'team-rows-host')
  document.body.appendChild(rowsHost)
  const element = (props: ChannelPageProps = {}): React.ReactElement => (
    <MemoryRouter>
      <ThemeProvider theme={theme}>
        <ChatPage
          compact
          storageScope={SCOPE}
          route={ROUTE}
          threadSubRowsHost={rowsHost}
          {...input.props}
          {...props}
        />
      </ThemeProvider>
    </MemoryRouter>
  )
  const view = render(element())
  let secondView: ReturnType<typeof render> | undefined
  const secondRowsHost = document.createElement('div')

  const activity = (): number =>
    main.calls.length + Object.values(idb.stats.calls).reduce((sum, count) => sum + count, 0)
  // Debounced saves (500 ms) and in-flight bridge answers of the unmounted page must land while
  // this test's fakes are still allowed: wait until both have been quiet for a while. A save that
  // comes later than that finds its database refused by the guards and fails the test it lands in.
  const quiesce = async (): Promise<void> => {
    mountedPage = undefined
    secondView?.unmount()
    secondRowsHost.remove()
    view.unmount()
    rowsHost.remove()
    let seen = activity()
    let quietSince = Date.now()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && (Date.now() - quietSince < 750 || main.pendingCalls() > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (activity() !== seen) {
        seen = activity()
        quietSince = Date.now()
      }
    }
  }
  // Registered before the first assertion on the page, so a mount that fails is torn down too.
  mountedPage = { main, quiesce }

  // The real page is mounted on the lead conversation: real composer, real message list.
  expect(document.querySelector(`[data-chat-page-root="${SCOPE}"]`)).not.toBeNull()
  expect(screen.getByTestId('chat-composer-input')).toBeInTheDocument()
  expect(screen.getByTestId('chat-message-list')).toBeInTheDocument()
  for (const session of input.members) {
    await within(rowsHost).findByRole('button', { name: session.id })
  }
  // The first row is the lead's; one row per member follows.
  const memberNames = (): string[] =>
    within(rowsHost)
      .queryAllByRole('button')
      .slice(1)
      .map((button) => button.textContent ?? '?')
      .sort()
  // The team on screen is the team of this storage: no member row of an earlier mount or test.
  expect(memberNames()).toEqual(input.members.map((session) => session.id).sort())
  // The page read its conversations from THIS fake (after a restart: over a new connection).
  expect(idb.stats.handedOut.slice(handedOutBeforeMount)).toEqual(
    expect.arrayContaining(expectedKeys)
  )
  if (input.secondPane) {
    document.body.appendChild(secondRowsHost)
    secondView = render(
      <MemoryRouter>
        <ThemeProvider theme={theme}>
          <ChatPage
            compact
            storageScope={SCOPE}
            route={ROUTE}
            threadSubRowsHost={secondRowsHost}
            {...input.props}
          />
        </ThemeProvider>
      </MemoryRouter>
    )
    for (const session of input.members)
      await within(secondRowsHost).findByRole('button', { name: session.id })
  }
  // With a second pane the composer of the first one is meant.
  const firstPage = input.secondPane ? within(view.container) : screen

  const page: ChannelPage = {
    main,
    idb,
    rerender: (props) => view.rerender(element(props)),
    stored: (id) => storage.loadSessionFromDB(id, SCOPE),
    rows: rowsHost,
    send: (text) => {
      fireEvent.change(firstPage.getByTestId('chat-composer-input'), { target: { value: text } })
      fireEvent.click(firstPage.getByRole('button', { name: 'chat.send_message' }))
    },
    openTeamManagement: async () => {
      // Team management opens from the conversation header (the composer has no "+" menu).
      fireEvent.click(await screen.findByTestId('agent-header-team'))
      return screen.findByRole('dialog', { name: '团队管理' })
    },
    memberNames,
    finish: async () => {
      const storageCallsBeforeUnmount = Object.values(idb.stats.calls).reduce(
        (sum, count) => sum + count,
        0
      )
      await quiesce()
      expect(main.pendingCalls()).toBe(0)
      // No toast: no save failure, no refused team message, no warning of any kind.
      expect(h.notify.mock.calls).toEqual([])
      expect(channelDeniedAttempts()).toEqual([])
      // The storage half of the quiet wait watched a storage that is really in use.
      expect(storageCallsBeforeUnmount).toBeGreaterThan(expectedKeys.length)
      // Still exactly this case's conversations: no record of another case was written here.
      expect(idb.keys(SESSION_STORE)).toEqual(expectedKeys)
    },
    quiesce
  }
  return page
}

beforeAll(async () => {
  // jsdom has no layout: the transcript scrolls its end marker into view.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: () => undefined
    })
  }
  // The first load of the page transforms its whole module graph (several seconds): done here,
  // outside the time limit of a test. Every mount loads its own copy again, which is quick.
  await loadPageModules()
}, 180000)
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  h.notify.mockClear()
})
afterEach(async () => {
  // A test that failed before page.finish(): end held replies and let the page settle while its
  // fakes are still allowed. A save that comes later still is not lost silently: its database is
  // refused by the guards and counted in the test it lands in.
  if (mountedPage) {
    mountedPage.main.abortAll()
    await mountedPage.quiesce()
  }
  localStorage.clear()
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------------------------
// The guards themselves
// ---------------------------------------------------------------------------------------------

describe('channel deny guards', () => {
  const denied = (kind: string, detail: string | RegExp) =>
    expect.objectContaining({
      kind,
      detail: typeof detail === 'string' ? detail : expect.stringMatching(detail)
    })

  it('refuses and counts a deliberate fetch', async () => {
    const before = totalChannelDeniedAttempts()
    expect(channelDeniedAttempts()).toEqual([])
    await expect(fetch('http://127.0.0.1:9/deliberate')).rejects.toSatisfy(isChannelGuardDenied)
    await expect(window.fetch(new URL('https://example.invalid/deliberate'))).rejects.toSatisfy(
      isChannelGuardDenied
    )
    expect(channelDeniedAttempts()).toHaveLength(2)
    expect(takeChannelDeniedAttempts()).toEqual([
      {
        kind: 'fetch',
        detail: 'http://127.0.0.1:9/deliberate',
        test: expect.stringContaining('deliberate fetch'),
        stack: expect.any(String)
      },
      denied('fetch', 'https://example.invalid/deliberate')
    ])
    expect(channelDeniedAttempts()).toEqual([])
    expect(totalChannelDeniedAttempts()).toBe(before + 2)
  })

  it('fails a test that leaves a refusal behind, and does not carry it into the next test', () => {
    void fetch('http://127.0.0.1:9/left-behind').catch(() => undefined)
    // The same check the setup file runs after every test.
    expect(() => assertNoChannelDeniedAttempts()).toThrow(
      /1 denied attempt\(s\) during the test:\n1\. fetch: http:\/\/127\.0\.0\.1:9\/left-behind/
    )
    expect(channelDeniedAttempts()).toEqual([])
    expect(() => assertNoChannelDeniedAttempts()).not.toThrow()
  })

  // Passes only because the afterEach of the setup file fails it: the body itself does not throw.
  it.fails('is failed by the setup file when a refusal is left behind', () => {
    void fetch('http://127.0.0.1:9/caught-by-the-setup-file').catch(() => undefined)
  })

  it('starts with an empty counter after a test that left a refusal behind', () => {
    expect(channelDeniedAttempts()).toEqual([])
  })

  it('counts a page that retries in a loop without keeping every call stack', () => {
    const before = totalChannelDeniedAttempts()
    for (let attempt = 0; attempt < 450; attempt += 1) {
      void fetch(`http://127.0.0.1:9/retry-${attempt}`).catch(() => undefined)
    }
    expect(totalChannelDeniedAttempts()).toBe(before + 450)
    const kept = takeChannelDeniedAttempts()
    expect(kept).toHaveLength(201)
    expect(kept[199].detail).toBe('http://127.0.0.1:9/retry-199')
    expect(kept[200].detail).toBe('... and 250 more refusal(s) that were counted but not kept')
    expect(channelDeniedAttempts()).toEqual([])
    expect(channelDeniedAttemptCount()).toBe(0)

    // The end-of-test message reports how many were refused, not how many stacks were kept.
    for (let attempt = 0; attempt < 450; attempt += 1) {
      void fetch(`http://127.0.0.1:9/again-${attempt}`).catch(() => undefined)
    }
    expect(channelDeniedAttemptCount()).toBe(450)
    expect(() => assertNoChannelDeniedAttempts()).toThrow(
      /^450 denied attempt\(s\) during the test:/
    )
    expect(channelDeniedAttemptCount()).toBe(0)
  })

  it('refuses XHR, WebSocket, EventSource and workers on both globals', () => {
    const globals = channelGuardedGlobals() as Array<
      Record<string, new (...args: unknown[]) => unknown>
    >
    // The Node global the tests call `window`, and the jsdom window underneath it.
    expect(globals).toHaveLength(2)
    expect(globals[0]).toBe(globalThis)
    expect(globals[1]).toBe((globalThis as unknown as { jsdom: { window: unknown } }).jsdom.window)
    expect(document.defaultView).toBe(globalThis)
    for (const target of globals) {
      expect(() => new target.XMLHttpRequest()).toThrow(/refused xhr/)
      expect(() => new target.WebSocket('ws://127.0.0.1:9/socket')).toThrow(/refused websocket/)
      expect(() => new target.EventSource('http://127.0.0.1:9/events')).toThrow(
        /refused eventsource/
      )
      expect(() => new target.Worker('worker.js')).toThrow(/refused worker/)
      expect(() => new target.SharedWorker('worker.js')).toThrow(/refused worker/)
      expect(navigator.sendBeacon('http://127.0.0.1:9/beacon')).toBe(false)
    }
    expect(takeChannelDeniedAttempts().map((attempt) => attempt.kind)).toEqual([
      ...['xhr', 'websocket', 'eventsource', 'worker', 'worker', 'beacon'],
      ...['xhr', 'websocket', 'eventsource', 'worker', 'worker', 'beacon']
    ])
  })

  it('refuses TCP below the page: node sockets, node:http(s) loaded later, and listening', async () => {
    const net = await import('node:net')
    const http = await import('node:http')
    const https = await import('node:https')
    const failure = (start: (fail: (error: Error) => void) => void): Promise<Error> =>
      new Promise((resolve) => start(resolve))
    expect(await failure((fail) => net.connect(9, '127.0.0.1').once('error', fail))).toSatisfy(
      isChannelGuardDenied
    )
    expect(
      await failure((fail) => http.get('http://127.0.0.1:9/node-http').once('error', fail))
    ).toSatisfy(isChannelGuardDenied)
    expect(
      await failure((fail) => https.get('https://127.0.0.1:9/node-https').once('error', fail))
    ).toSatisfy(isChannelGuardDenied)
    expect(() => http.createServer().listen(0, '127.0.0.1')).toThrow(/refused socket/)
    expect(takeChannelDeniedAttempts()).toEqual([
      denied('socket', 'net.Socket.connect(127.0.0.1:9)'),
      denied('socket', /^net\.Socket\.connect\(127\.0\.0\.1:9\)$/),
      denied('socket', /^net\.Socket\.connect\(127\.0\.0\.1:9\)$/),
      denied('socket', 'net.Server.listen()')
    ])
  })

  it('refuses UDP and DNS, which never open a TCP connection', async () => {
    const dgram = await import('node:dgram')
    const dns = await import('node:dns')
    const dnsPromises = await import('node:dns/promises')
    const socket = dgram.createSocket('udp4')
    try {
      expect(() => socket.send('x', 9, '127.0.0.1')).toThrow(/refused udp/)
      expect(() => socket.bind(0)).toThrow(/refused udp/)
      expect(() => socket.connect(9, '127.0.0.1')).toThrow(/refused udp/)
    } finally {
      socket.close()
    }
    // The named export, as a module gets it with `import { lookup } from 'node:dns'` ...
    expect(() => dns.lookup('localhost', () => undefined)).toThrow(/refused dns/)
    // ... and the property of the module object.
    expect(() => dns.default.lookup('example.invalid', () => undefined)).toThrow(/refused dns/)
    expect(() => dns.resolve4('example.invalid', () => undefined)).toThrow(/refused dns/)
    expect(() => new dns.Resolver().resolve('example.invalid', () => undefined)).toThrow(
      /refused dns/
    )
    await expect(dnsPromises.lookup('example.invalid')).rejects.toSatisfy(isChannelGuardDenied)
    await expect(new dnsPromises.Resolver().resolve4('example.invalid')).rejects.toSatisfy(
      isChannelGuardDenied
    )
    expect(
      takeChannelDeniedAttempts().map((attempt) => `${attempt.kind}: ${attempt.detail}`)
    ).toEqual([
      'udp: dgram.Socket.send(x, 9, 127.0.0.1)',
      'udp: dgram.Socket.bind(0)',
      'udp: dgram.Socket.connect(9, 127.0.0.1)',
      'dns: dns.lookup(localhost)',
      'dns: dns.lookup(example.invalid)',
      'dns: dns.resolve4(example.invalid)',
      'dns: dns.Resolver.resolve(example.invalid)',
      'dns: dns.promises.lookup(example.invalid)',
      'dns: dns.promises.Resolver.resolve4(example.invalid)'
    ])
  })

  it('refuses a request from a third global (an iframe window) at the transport', async () => {
    const frame = document.body.appendChild(document.createElement('iframe'))
    try {
      const FrameXhr = (frame.contentWindow as unknown as { XMLHttpRequest: typeof XMLHttpRequest })
        .XMLHttpRequest
      // Not one of the guarded globals: the page-level guard is not on it ...
      expect(channelGuardedGlobals()).not.toContain(frame.contentWindow)
      const xhr = new FrameXhr()
      const ended = new Promise<string>((resolve) => {
        xhr.onerror = () => resolve('error')
        xhr.onload = () => resolve('load')
      })
      xhr.open('GET', 'http://127.0.0.1:9/from-an-iframe')
      xhr.send()
      // ... so the socket underneath refuses it.
      expect(await ended).toBe('error')
      expect(takeChannelDeniedAttempts()).toEqual([
        denied('socket', 'net.Socket.connect(127.0.0.1:9)')
      ])
    } finally {
      frame.remove()
    }
  })

  // Three tests in this order: the allowance of the first must be gone in the other two.
  describe('IndexedDB allowance across tests', () => {
    // The chat storage copy and the fake of the next test, kept for the two tests after it: business
    // code that cached its connection, as the real chat storage does.
    let keptStorage: typeof import('./chatStorage') | undefined
    let keptFake: FakeChatIndexedDb | undefined
    const selfTestSession = (id: string): ChatSession =>
      ({ id, title: id, messages: [] }) as ChatSession

    it('refuses IndexedDB unless the test allows an in-memory fake, and forgets the fake afterwards', async () => {
      expect(() => indexedDB.open('magicpot-chat')).toThrow(/refused indexeddb/)
      await expect(indexedDB.databases()).rejects.toSatisfy(isChannelGuardDenied)
      expect(takeChannelDeniedAttempts()).toEqual([
        denied('indexeddb', 'indexedDB.open(magicpot-chat)'),
        denied('indexeddb', 'indexedDB.databases()')
      ])
      const fake = createFakeChatIndexedDb()
      // The fake cannot be put on the global directly ...
      expect(() => fake.install((name, value) => vi.stubGlobal(name, value))).toThrow(TypeError)
      // ... only through the guards, for this test.
      fake.install((_name, value) => allowChannelInMemoryIndexedDb(value))
      vi.resetModules()
      const storage = await import('./chatStorage')
      await storage.saveSessionToDB(selfTestSession('in-memory'), 'guard-self-test')
      expect((await storage.loadSessionFromDB('in-memory', 'guard-self-test'))?.title).toBe(
        'in-memory'
      )
      expect(fake.keys('sessions-v2')).toEqual(['guard-self-test\u0000in-memory'])
      expect(channelDeniedAttempts()).toEqual([])
      keptStorage = storage
      keptFake = fake
    })

    it('refuses IndexedDB again in the next test', () => {
      expect(() => indexedDB.open('magicpot-chat')).toThrow(/refused indexeddb/)
      expect(takeChannelDeniedAttempts()).toHaveLength(1)
    })

    it('refuses the connection that business code kept from an earlier test', async () => {
      // Nothing is allowed in this test; the chat storage copy of the test before last still holds
      // the database it opened there.
      expect(keptStorage, 'run the whole "IndexedDB allowance across tests" group').toBeDefined()
      const storage = keptStorage!
      const fake = keptFake!
      const storageErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const callsBefore = structuredClone(fake.stats.calls)
      const read = await storage.loadSessionFromDB('in-memory', 'guard-self-test').then(
        (session) => ({ session }),
        (error: unknown) => ({ error })
      )
      // Whatever the storage makes of the failure, it did not get the record ...
      expect(read).not.toHaveProperty('session.title')
      const write = await storage.saveSessionToDB(selfTestSession('late'), 'guard-self-test').then(
        () => 'saved',
        () => 'failed'
      )
      expect(write).toBe('failed')
      expect(storageErrors).toHaveBeenCalled()
      storageErrors.mockRestore()
      // ... the earlier test's storage was neither read nor written ...
      expect(fake.stats.calls).toEqual(callsBefore)
      expect(fake.keys('sessions-v2')).toEqual(['guard-self-test\u0000in-memory'])
      // ... and every attempt was refused and counted.
      const attempts = takeChannelDeniedAttempts()
      expect(attempts.length).toBeGreaterThanOrEqual(2)
      expect(attempts.every((attempt) => attempt.kind === 'indexeddb')).toBe(true)
      expect(attempts[0]).toEqual(
        denied(
          'indexeddb',
          /^IDBDatabase\.transaction\(sessions-v2\) after its in-memory allowance ended/
        )
      )
    })
  })

  it('ends an allowance when the test allows again: databases, transactions and the factory', async () => {
    const fake = createFakeChatIndexedDb()
    fake.seedStore('sessions-v2', 'storageKey', [])
    fake.setVersion(2)
    const opened = (): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('magicpot-chat', 2)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    fake.install((_name, value) => allowChannelInMemoryIndexedDb(value))
    const firstFactory = indexedDB
    const first = await opened()
    const firstTransaction = first.transaction('sessions-v2', 'readonly')
    expect(firstTransaction.objectStore('sessions-v2').keyPath).toBe('storageKey')
    expect(channelDeniedAttempts()).toEqual([])

    // A restart on the same storage: a new allowance for the same fake.
    fake.install((_name, value) => allowChannelInMemoryIndexedDb(value))
    expect(indexedDB).not.toBe(firstFactory)
    expect(() => first.transaction('sessions-v2', 'readwrite')).toThrow(/refused indexeddb/)
    expect(() => firstTransaction.objectStore('sessions-v2')).toThrow(/refused indexeddb/)
    expect(() => first.close()).toThrow(/refused indexeddb/)
    expect(() => firstFactory.open('magicpot-chat', 2)).toThrow(/refused indexeddb/)
    expect(
      takeChannelDeniedAttempts().map((attempt) => attempt.detail.split(' after ')[0])
    ).toEqual([
      'IDBDatabase.transaction(sessions-v2)',
      'IDBTransaction.objectStore(sessions-v2)',
      'IDBDatabase.close()',
      'indexedDB.open(magicpot-chat)'
    ])
    // The new allowance works, on the same records.
    const second = await opened()
    expect(second).not.toBe(first)
    expect(second.transaction('sessions-v2', 'readonly').objectStore('sessions-v2').keyPath).toBe(
      'storageKey'
    )
    expect(channelDeniedAttempts()).toEqual([])
  })

  it('refuses every bridge call that the test did not list', async () => {
    const bridge = window.api as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
    // Reading and feature-testing a bridge is not a call.
    expect(typeof bridge.svcFs.readFileFromPath).toBe('function')
    expect('svcFs' in bridge).toBe(true)
    expect(bridge.svcFs).toBe(bridge.svcFs)
    expect(channelDeniedAttempts()).toEqual([])

    await expect(bridge.svcFs.readFileFromPath({ fullPath: '/etc/hosts' })).rejects.toSatisfy(
      isChannelGuardDenied
    )
    const listed = vi.fn(async () => ({ jobs: [] }))
    allowChannelBridge('api', { svcLLMProxy: { listAgentJobs: listed } })
    await expect(bridge.svcLLMProxy.listAgentJobs({ conversationId: 'lead' })).resolves.toEqual({
      jobs: []
    })
    expect(listed).toHaveBeenCalledWith({ conversationId: 'lead' })
    // A listed neighbour does not open the rest of the service, or the other bridges.
    await expect(bridge.svcLLMProxy.chat({ messages: [] })).rejects.toSatisfy(isChannelGuardDenied)
    const others = window as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => unknown>
    >
    await expect(others.win.minimize()).rejects.toSatisfy(isChannelGuardDenied)
    await expect(others.appEvents.onCloseActiveTab(() => undefined)).rejects.toSatisfy(
      isChannelGuardDenied
    )
    await expect(others.electronFile.getPathForFile({})).rejects.toSatisfy(isChannelGuardDenied)
    expect(
      takeChannelDeniedAttempts().map((attempt) => `${attempt.kind}: ${attempt.detail}`)
    ).toEqual([
      'bridge: api.svcFs.readFileFromPath',
      'bridge: api.svcLLMProxy.chat',
      'bridge: win.minimize',
      'bridge: appEvents.onCloseActiveTab',
      'bridge: electronFile.getPathForFile'
    ])
  })

  it('forgets listed bridge calls in the next test', async () => {
    const bridge = window.api as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
    await expect(bridge.svcLLMProxy.listAgentJobs({ conversationId: 'lead' })).rejects.toSatisfy(
      isChannelGuardDenied
    )
    expect(takeChannelDeniedAttempts()).toEqual([denied('bridge', 'api.svcLLMProxy.listAgentJobs')])
  })

  it('cannot be replaced: assignment is refused, redefinition throws or is restored', () => {
    const guardedFetch = globalThis.fetch
    const guardedApi = window.api
    const replacement = vi.fn()
    ;(globalThis as { fetch: unknown }).fetch = replacement
    ;(window as { api: unknown }).api = { svcLLMProxy: { chat: replacement } }
    expect(globalThis.fetch).toBe(guardedFetch)
    expect(window.api).toBe(guardedApi)
    expect(() => vi.stubGlobal('fetch', replacement)).toThrow(TypeError)
    expect(() => Object.defineProperty(window, 'api', { configurable: true, value: {} })).toThrow(
      TypeError
    )
    expect(() => {
      ;(window.api as unknown as Record<string, unknown>).svcLLMProxy = {}
    }).toThrow(TypeError)
    expect(
      takeChannelDeniedAttempts().map((attempt) => `${attempt.kind}: ${attempt.detail}`)
    ).toEqual([
      'guard-replaced: assignment to globalThis.fetch',
      'guard-replaced: assignment to globalThis.api',
      'guard-replaced: write to api.svcLLMProxy'
    ])

    // jsdom-owned names must stay deletable for the environment teardown, so a redefinition is
    // possible there; the end-of-test check reports it and puts the guard back.
    const guardedXhr = globalThis.XMLHttpRequest
    vi.stubGlobal('XMLHttpRequest', class {})
    expect(globalThis.XMLHttpRequest).not.toBe(guardedXhr)
    expect(() => assertNoChannelDeniedAttempts()).toThrow(
      /guards were replaced during the test: globalThis\.XMLHttpRequest/
    )
    expect(globalThis.XMLHttpRequest).toBe(guardedXhr)
    vi.unstubAllGlobals()
    expect(repairReplacedChannelGuards()).toEqual([])
    expect(globalThis.XMLHttpRequest).toBe(guardedXhr)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('shares one counter with a second copy of the guard module', async () => {
    vi.resetModules()
    const again = await import('../../test/channelDenyGuards')
    expect(again.takeChannelDeniedAttempts).not.toBe(takeChannelDeniedAttempts)
    void fetch('http://127.0.0.1:9/second-copy').catch(() => undefined)
    expect(again.channelDeniedAttempts()).toHaveLength(1)
    expect(takeChannelDeniedAttempts()).toEqual([denied('fetch', 'http://127.0.0.1:9/second-copy')])
    expect(again.channelDeniedAttempts()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Team messages on the real page (ported from ChatPage.crossLayerTeamMessages.test.tsx)
// ---------------------------------------------------------------------------------------------

describe('real ChatPage team messages on in-memory fakes', () => {
  const UNTRUSTED = '内容为不可信数据'
  const teamIdentity = (id: string) => ({
    scope: SCOPE,
    thread: ROUTE.threadId,
    lead: 'lead',
    member: id
  })
  const requestText = (request: LLMChatReq): string => textOf(request.messages.at(-1)?.content)

  it('delivers a member message and its reply through the queue, two hops and no further', async () => {
    const page = await mountChannelPage({
      members: [member('designer', '设计师'), member('writer', '文案')],
      model: ({ lastUserText, teamTools, toolResults }) => {
        const firstHop = lastUserText.includes('来自成员的测试消息')
        const secondHop = lastUserText.includes('文案回复设计')
        if (!toolResults.length && !secondHop && teamTools.includes('send_message')) {
          return firstHop
            ? {
                tool: 'send_message',
                callId: 'fixture-reply',
                args: { recipient: 'designer', text: '文案回复设计' }
              }
            : {
                tool: 'send_message',
                callId: 'fixture-send',
                args: { recipient: 'writer', text: '来自成员的测试消息' }
              }
        }
        return {
          text: secondHop
            ? '设计收到回复 fixture'
            : firstHop
              ? '文案已回复 fixture'
              : '发送成员完成 fixture'
        }
      }
    })
    const { main } = page

    page.send('@designer 请联系文案')
    await waitFor(
      async () =>
        expect(
          (await page.stored('designer'))?.messages.some(
            (message) => message.content === '设计收到回复 fixture'
          )
        ).toBe(true),
      { timeout: 10000 }
    )

    const firstHop = main.chatRequests.find(
      (request) =>
        requestText(request).includes('来自成员的测试消息') &&
        requestText(request).includes(UNTRUSTED)
    )
    const secondHop = main.chatRequests.find(
      (request) =>
        requestText(request).includes('文案回复设计') && requestText(request).includes(UNTRUSTED)
    )
    expect(firstHop).toBeTruthy()
    expect(secondHop).toBeTruthy()
    expect(JSON.stringify(firstHop!.messages)).toContain('designer')
    expect(JSON.stringify(secondHop!.messages)).toContain('writer')
    // The page reports who speaks and how deep the delivery is; MAIN derives the tools from it.
    expect(firstHop).toMatchObject({
      conversationId: 'writer',
      teamMember: teamIdentity('writer'),
      teamMessageHop: 1,
      route: ROUTE
    })
    expect(secondHop).toMatchObject({
      conversationId: 'designer',
      teamMember: teamIdentity('designer'),
      teamMessageHop: 2,
      route: ROUTE
    })
    expect(main.chatRequests[0]).toMatchObject({
      conversationId: 'designer',
      teamMember: teamIdentity('designer')
    })
    expect(main.chatRequests[0].teamMessageHop).toBeUndefined()
    // What the fixture's copy of the MAIN tool gate (canvasAgentTools.ts) offers for those fields.
    // The real gate, and that MAIN stops after two hops, stay covered by
    // ChatPage.crossLayerTeamMessages.test.tsx; here only the request fields above are product code.
    expect(
      main.modelTurns.find((turn) => turn.conversationId === 'writer' && turn.hop === 1)?.teamTools
    ).toEqual(['send_message', 'send_channel'])
    expect(main.modelTurns.filter((turn) => turn.hop === 2).map((turn) => turn.teamTools)).toEqual([
      []
    ])
    for (const callId of ['fixture-send', 'fixture-reply']) {
      const result = main.toolResults.find((item) => item.callId === callId)
      expect(JSON.parse(result!.content)).toEqual({
        status: 'queued',
        requestId: expect.any(String)
      })
    }
    expect(
      main.enqueued.map((intent) => [
        intent.source.member,
        intent.recipient,
        intent.hop,
        intent.text
      ])
    ).toEqual([
      ['designer', 'writer', 1, '来自成员的测试消息'],
      ['writer', 'designer', 2, '文案回复设计']
    ])

    // The column lists no message activity: each message is seen as a request to its recipient.
    expect(
      main.chatRequests.filter(
        (request) =>
          request.conversationId === 'writer' && requestText(request).includes('来自成员的测试消息')
      )
    ).toHaveLength(1)
    expect(
      main.chatRequests.filter(
        (request) =>
          request.conversationId === 'designer' && requestText(request).includes('文案回复设计')
      )
    ).toHaveLength(1)

    // Each delivery presented its claim and MAIN recorded exactly one start, for its recipient.
    expect(firstHop!.teamMessageDelivery).toEqual({
      id: main.enqueued[0].id,
      lease: expect.stringMatching(/^fixture-lease-/)
    })
    expect(secondHop!.teamMessageDelivery).toEqual({
      id: main.enqueued[1].id,
      lease: expect.stringMatching(/^fixture-lease-/)
    })
    expect(main.chatRequests[0]).not.toHaveProperty('teamMessageDelivery')
    expect(main.starts).toEqual([
      { id: main.enqueued[0].id, recipient: 'writer' },
      { id: main.enqueued[1].id, recipient: 'designer' }
    ])
    expect(main.refusedDeliveries).toEqual([])

    // Each intent was claimed exactly once, and a claim cannot be replayed.
    expect(main.claimRequests).toHaveLength(2)
    for (const claim of main.claimRequests.slice()) {
      expect((await window.api.svcLLMProxy.claimAgentTeamMessage(claim)).intent).toBeUndefined()
    }
    // The stored transcripts carry the three replies.
    expect((await page.stored('writer'))?.messages.map((message) => message.content)).toContain(
      '文案已回复 fixture'
    )
    expect((await page.stored('designer'))?.messages.map((message) => message.content)).toEqual(
      expect.arrayContaining(['发送成员完成 fixture', '设计收到回复 fixture'])
    )
    await page.finish()
  }, 20000)

  it('delivers a channel message to the subscribed members only', async () => {
    const page = await mountChannelPage({
      members: [
        member('designer', '设计师'),
        member('writer', '文案'),
        member('reviewer', 'reviewer'),
        member('observer', 'observer')
      ],
      model: ({ lastUserText, teamTools, toolResults }) => {
        const channelRecipient = lastUserText.includes('广播测试正文')
        if (!toolResults.length && !channelRecipient && teamTools.includes('send_channel')) {
          return { tool: 'send_channel', callId: 'fixture-channel', args: { text: '广播测试正文' } }
        }
        return { text: channelRecipient ? '频道收到 fixture' : '发送成员完成 fixture' }
      }
    })
    const { main } = page

    const dialog = await page.openTeamManagement()
    const observer = await within(dialog).findByRole('checkbox', { name: 'observer' })
    await waitFor(() => expect(observer).toBeChecked())
    fireEvent.click(observer)
    expect(observer).not.toBeChecked()

    page.send('@designer 发送频道广播')
    await waitFor(
      async () => {
        for (const id of ['writer', 'reviewer']) {
          expect(
            (await page.stored(id))?.messages.some(
              (message) => message.content === '频道收到 fixture'
            )
          ).toBe(true)
        }
      },
      { timeout: 10000 }
    )

    const byRecipient = (id: string) =>
      main.chatRequests.filter(
        (request) =>
          request.conversationId === id && JSON.stringify(request.messages).includes('广播测试正文')
      )
    expect(byRecipient('writer')).toHaveLength(1)
    expect(byRecipient('reviewer')).toHaveLength(1)
    expect(byRecipient('observer')).toHaveLength(0)
    for (const id of ['writer', 'reviewer']) {
      expect(JSON.stringify(byRecipient(id)[0].messages)).toContain(UNTRUSTED)
      expect(JSON.stringify(byRecipient(id)[0].messages)).toContain('designer')
      expect(byRecipient(id)[0]).toMatchObject({ teamMember: teamIdentity(id), teamMessageHop: 1 })
    }
    expect(
      JSON.parse(main.toolResults.find((item) => item.callId === 'fixture-channel')!.content)
    ).toEqual({ status: 'queued', requestId: expect.any(String) })
    expect(main.enqueued).toEqual([
      expect.objectContaining({
        kind: 'channel',
        hop: 1,
        source: teamIdentity('designer'),
        text: '广播测试正文'
      })
    ])
    expect(main.enqueued[0]).not.toHaveProperty('recipient')
    // One claim, one lease for both recipients; MAIN recorded one start per recipient.
    expect(byRecipient('writer')[0].teamMessageDelivery).toEqual({
      id: main.enqueued[0].id,
      lease: expect.stringMatching(/^fixture-lease-/)
    })
    expect(byRecipient('reviewer')[0].teamMessageDelivery).toEqual(
      byRecipient('writer')[0].teamMessageDelivery
    )
    expect(main.starts.map((start) => start.recipient).sort()).toEqual(['reviewer', 'writer'])
    expect(main.refusedDeliveries).toEqual([])

    expect(main.claimRequests).toHaveLength(1)
    expect(
      (await window.api.svcLLMProxy.claimAgentTeamMessage(main.claimRequests[0])).intent
    ).toBeUndefined()
    await page.finish()
  }, 20000)

  it('keeps the subscription snapshot of a user broadcast while a member is busy', async () => {
    let releaseBusy: (() => void) | undefined
    const page = await mountChannelPage({
      members: [
        member('designer', '设计师'),
        member('writer', '文案'),
        member('reviewer', 'reviewer'),
        member('observer', 'observer')
      ],
      model: ({ lastUserText }) =>
        lastUserText.includes('hold writer busy')
          ? new Promise<ModelStep>((resolve) => {
              releaseBusy = () => resolve({ text: 'snapshot fixture reply' })
            })
          : { text: 'snapshot fixture reply' }
    })
    const { main } = page

    page.send('@writer hold writer busy')
    await waitFor(() => expect(releaseBusy).toBeDefined())
    const dialog = await page.openTeamManagement()
    const writer = await within(dialog).findByRole('checkbox', { name: 'writer' })
    const reviewer = within(dialog).getByRole('checkbox', { name: 'reviewer' })
    const observer = within(dialog).getByRole('checkbox', { name: 'observer' })
    const designer = within(dialog).getByRole('checkbox', { name: 'designer' })
    await waitFor(() => {
      expect(writer).toBeChecked()
      expect(reviewer).toBeChecked()
      expect(observer).toBeChecked()
      expect(designer).toBeChecked()
    })
    fireEvent.click(observer)
    fireEvent.click(designer)
    const broadcast = (text: string): void => {
      fireEvent.change(screen.getByLabelText('频道消息'), { target: { value: text } })
      fireEvent.click(screen.getByRole('button', { name: '广播给订阅成员' }))
    }
    const byRecipient = (id: string, text: string) =>
      main.chatRequests.filter(
        (request) => request.conversationId === id && requestText(request).includes(text)
      )

    broadcast('snapshot old broadcast')
    // The busy writer keeps the broadcast queued; the reviewer is asked at once and answers.
    await waitFor(async () => {
      expect(byRecipient('reviewer', 'snapshot old broadcast')).toHaveLength(1)
      expect(
        (await page.stored('reviewer'))?.messages.some(
          (message) => message.role === 'assistant' && message.content === 'snapshot fixture reply'
        )
      ).toBe(true)
    })
    expect(byRecipient('writer', 'snapshot old broadcast')).toHaveLength(0)
    fireEvent.click(writer)
    fireEvent.click(observer)
    await waitFor(() => {
      expect(writer).not.toBeChecked()
      expect(observer).toBeChecked()
    })
    broadcast('snapshot new broadcast')
    await waitFor(() => {
      expect(byRecipient('reviewer', 'snapshot new broadcast')).toHaveLength(1)
      expect(byRecipient('observer', 'snapshot new broadcast')).toHaveLength(1)
    })
    expect(byRecipient('writer', 'snapshot old broadcast')).toHaveLength(0)
    expect(byRecipient('writer', 'snapshot new broadcast')).toHaveLength(0)

    releaseBusy?.()
    releaseBusy = undefined
    await waitFor(() => expect(byRecipient('writer', 'snapshot old broadcast')).toHaveLength(1))
    for (const [id, text, count] of [
      ['writer', 'snapshot old broadcast', 1],
      ['writer', 'snapshot new broadcast', 0],
      ['reviewer', 'snapshot old broadcast', 1],
      ['reviewer', 'snapshot new broadcast', 1],
      ['observer', 'snapshot old broadcast', 0],
      ['observer', 'snapshot new broadcast', 1],
      ['designer', 'snapshot old broadcast', 0],
      ['designer', 'snapshot new broadcast', 0]
    ] as const) {
      expect(byRecipient(id, text)).toHaveLength(count)
    }
    // A user broadcast never goes through the MAIN queue and presents no lease.
    expect(main.enqueued).toEqual([])
    expect(main.claimRequests).toEqual([])
    expect(
      main.chatRequests.filter((request) => Object.hasOwn(request, 'teamMessageDelivery'))
    ).toEqual([])
    expect(main.starts).toEqual([])
    await page.finish()
  }, 20000)

  it('keeps a member message across a pane switch and delivers it once when the pane is back', async () => {
    let releaseBusy: (() => void) | undefined
    let releaseSender: (() => void) | undefined
    const page = await mountChannelPage({
      members: [member('designer', '设计师'), member('writer', '文案')],
      model: ({ lastUserText, teamTools, toolResults }) => {
        if (lastUserText.includes('hold writer busy')) {
          return new Promise<ModelStep>((resolve) => {
            releaseBusy = () => resolve({ text: 'writer busy reply fixture' })
          })
        }
        if (
          lastUserText.includes('来自成员的测试消息') ||
          lastUserText.includes('隐藏时的第二条消息')
        ) {
          return { text: '文案已收到 fixture' }
        }
        if (toolResults.length || !teamTools.includes('send_message'))
          return { text: '发送成员完成 fixture' }
        if (lastUserText.includes('hidden pane send')) {
          return new Promise<ModelStep>((resolve) => {
            releaseSender = () =>
              resolve({
                tool: 'send_message',
                callId: 'fixture-hidden-send',
                args: { recipient: 'writer', text: '隐藏时的第二条消息' }
              })
          })
        }
        return {
          tool: 'send_message',
          callId: 'fixture-pane-send',
          args: { recipient: 'writer', text: '来自成员的测试消息' }
        }
      }
    })
    const { main } = page
    const toWriter = (text: string) =>
      main.chatRequests.filter(
        (request) => request.conversationId === 'writer' && requestText(request).includes(text)
      )
    const writerStored = async (): Promise<string[]> =>
      ((await page.stored('writer'))?.messages ?? []).map((message) => message.content)
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    // While a member runs, the lead's composer shows Stop; Enter still sends (as a person would).
    const sendByEnter = (text: string): void => {
      const input = screen.getByTestId('chat-composer-input')
      fireEvent.change(input, { target: { value: text } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }

    // 1. Claimed while the pane is visible and queued behind the busy recipient; then the pane is
    //    hidden. The message is not dropped when the pane goes away.
    page.send('@writer hold writer busy')
    await waitFor(() => expect(releaseBusy).toBeDefined())
    sendByEnter('@designer 请联系文案')
    await waitFor(() => expect(main.claimRequests).toHaveLength(1), { timeout: 5000 })
    page.rerender({ active: false })
    releaseBusy?.()
    await waitFor(async () => expect(await writerStored()).toContain('writer busy reply fixture'))
    // Hidden: the recipient is free, but nothing is delivered until the pane is shown again.
    await pause(1500)
    expect(toWriter('来自成员的测试消息')).toHaveLength(0)
    page.rerender({ active: true })
    await waitFor(() => expect(toWriter('来自成员的测试消息')).toHaveLength(1), { timeout: 5000 })
    await waitFor(async () => expect(await writerStored()).toContain('文案已收到 fixture'))

    // 2. Sent by a member while the pane is hidden: the hidden pane claims it at once (MAIN would
    //    drop it after 60 s) and delivers it when the pane is back.
    page.send('@designer hidden pane send')
    await waitFor(() => expect(releaseSender).toBeDefined())
    page.rerender({ active: false })
    releaseSender?.()
    await waitFor(() => expect(main.claimRequests).toHaveLength(2), { timeout: 5000 })
    expect(main.enqueued).toHaveLength(2)
    await pause(1500)
    expect(toWriter('隐藏时的第二条消息')).toHaveLength(0)
    page.rerender({ active: true })
    await waitFor(() => expect(toWriter('隐藏时的第二条消息')).toHaveLength(1), { timeout: 5000 })
    await pause(1500)
    // Exactly one request per message, and every intent was claimed once.
    expect(toWriter('来自成员的测试消息')).toHaveLength(1)
    expect(toWriter('隐藏时的第二条消息')).toHaveLength(1)
    expect(main.claimRequests).toHaveLength(2)
    await waitFor(async () =>
      expect((await writerStored()).filter((text) => text === '文案已收到 fixture')).toHaveLength(2)
    )
    await page.finish()
  }, 30000)
})

describe('real ChatPage member message leases on in-memory fakes', () => {
  const requestText = (request: LLMChatReq): string => textOf(request.messages.at(-1)?.content)
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('delivers a member message once from two mounted panes of the lead: one request, one start', async () => {
    const page = await mountChannelPage({
      members: [member('designer', '设计师'), member('writer', '文案')],
      secondPane: true,
      model: ({ lastUserText, teamTools, toolResults }) => {
        if (lastUserText.includes('来自成员的测试消息')) return { text: '文案已收到 fixture' }
        if (!toolResults.length && teamTools.includes('send_message')) {
          return {
            tool: 'send_message',
            callId: 'fixture-two-panes',
            args: { recipient: 'writer', text: '来自成员的测试消息' }
          }
        }
        return { text: '发送成员完成 fixture' }
      }
    })
    const { main } = page
    const toWriter = () =>
      main.chatRequests.filter(
        (request) =>
          request.conversationId === 'writer' && requestText(request).includes('来自成员的测试消息')
      )

    page.send('@designer 请联系文案')
    await waitFor(() => expect(toWriter()).toHaveLength(1), { timeout: 10000 })
    await waitFor(async () =>
      expect((await page.stored('writer'))?.messages.map((message) => message.content)).toContain(
        '文案已收到 fixture'
      )
    )
    // Both panes poll the same lead every 500 ms: give the other one time to deliver it again.
    await pause(2000)
    expect(toWriter()).toHaveLength(1)
    expect(main.starts).toEqual([{ id: main.enqueued[0].id, recipient: 'writer' }])
    expect(main.refusedDeliveries).toEqual([])
    expect(
      main.calls.filter((call) => call.method === 'listAgentTeamMessages').length
    ).toBeGreaterThan(2)
    await page.finish()
  }, 30000)

  it('presents the lease when a team message queued behind a busy recipient starts later', async () => {
    let releaseBusy: (() => void) | undefined
    const page = await mountChannelPage({
      members: [member('designer', '设计师'), member('writer', '文案')],
      model: ({ lastUserText, teamTools, toolResults }) => {
        if (lastUserText.includes('hold writer busy')) {
          return new Promise<ModelStep>((resolve) => {
            releaseBusy = () => resolve({ text: 'writer busy reply fixture' })
          })
        }
        if (lastUserText.includes('来自成员的测试消息')) return { text: '文案已收到 fixture' }
        if (!toolResults.length && teamTools.includes('send_message')) {
          return {
            tool: 'send_message',
            callId: 'fixture-busy-send',
            args: { recipient: 'writer', text: '来自成员的测试消息' }
          }
        }
        return { text: '发送成员完成 fixture' }
      }
    })
    const { main } = page
    // The dispatcher checks the recipient right before it sends, so a recipient that turns busy in
    // between cannot be produced from outside: its view of busy is blinded instead, and the send
    // wrapper, which still sees the busy writer, queues the team message behind the writer's run.
    const { TeamMessageDispatcher } = await import('./teamMessageDispatcher')
    const pump = TeamMessageDispatcher.prototype.pump
    const blinded = vi.spyOn(TeamMessageDispatcher.prototype, 'pump').mockImplementation(function (
      this: InstanceType<typeof TeamMessageDispatcher>,
      recipient: string
    ) {
      Object.assign(this as object, { isRecipientBusy: () => false })
      return pump.call(this, recipient)
    })
    const toWriter = () =>
      main.chatRequests.filter(
        (request) =>
          request.conversationId === 'writer' && requestText(request).includes('来自成员的测试消息')
      )
    try {
      page.send('@writer hold writer busy')
      await waitFor(() => expect(releaseBusy).toBeDefined())
      fireEvent.change(screen.getByTestId('chat-composer-input'), {
        target: { value: '@designer 请联系文案' }
      })
      fireEvent.keyDown(screen.getByTestId('chat-composer-input'), { key: 'Enter' })
      await waitFor(() => expect(main.claimRequests).toHaveLength(1), { timeout: 5000 })
      await pause(1500)
      expect(toWriter()).toHaveLength(0)
      releaseBusy?.()
      await waitFor(() => expect(toWriter()).toHaveLength(1), { timeout: 5000 })
      expect(toWriter()[0].teamMessageDelivery).toEqual({
        id: main.enqueued[0].id,
        lease: expect.stringMatching(/^fixture-lease-/)
      })
      expect(main.starts).toEqual([{ id: main.enqueued[0].id, recipient: 'writer' }])
      await waitFor(async () =>
        expect((await page.stored('writer'))?.messages.map((message) => message.content)).toContain(
          '文案已收到 fixture'
        )
      )
      await pause(1000)
      expect(toWriter()).toHaveLength(1)
      expect(main.refusedDeliveries).toEqual([])
    } finally {
      blinded.mockRestore()
    }
    await page.finish()
  }, 30000)
})

// ---------------------------------------------------------------------------------------------
// Restart on the same storage (backlog item 13 adds the MAIN-owned delivery cases here)
// ---------------------------------------------------------------------------------------------

describe('real ChatPage restart on in-memory fakes', () => {
  it('reads the team and a member transcript back from storage, once', async () => {
    const members = [member('designer', '设计师')]
    const first = await mountChannelPage({
      members,
      model: () => ({ text: 'reply before restart' })
    })
    first.send('@designer remember this')
    await waitFor(async () =>
      expect(
        (await first.stored('designer'))?.messages.map((message) => message.content)
      ).toContain('reply before restart')
    )
    await first.finish()

    // A new page and a new MAIN on the storage the first page left behind.
    const second = await mountChannelPage({
      members,
      model: () => ({ text: 'unexpected request after restart' }),
      storage: first.idb
    })
    fireEvent.click(within(second.rows).getByRole('button', { name: 'designer' }))
    const transcript = await screen.findByTestId('chat-message-list')
    await within(transcript).findByText('reply before restart')
    expect(within(transcript).getAllByText('reply before restart')).toHaveLength(1)
    const stored = (await second.stored('designer'))?.messages.map((message) => [
      message.role,
      message.content
    ])
    expect(stored?.filter(([role]) => role === 'assistant')).toEqual([
      ['assistant', 'reply before restart']
    ])
    expect(stored?.filter(([role]) => role === 'user')).toHaveLength(1)
    // Opening a stored conversation asks the model nothing.
    expect(second.main.chatRequests).toEqual([])
    expect(second.idb).toBe(first.idb)
    await second.finish()

    // The restart was one of the storage layer too: the connection the first page's copy of the
    // chat storage had opened is refused, so that page cannot read or write this storage any more.
    const storageErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const callsBefore = structuredClone(first.idb.stats.calls)
    expect(
      await first.stored('designer').then(
        (session) => session?.id ?? 'nothing',
        () => 'failed'
      )
    ).not.toBe('designer')
    expect(first.idb.stats.calls).toEqual(callsBefore)
    expect(takeChannelDeniedAttempts()[0]).toMatchObject({
      kind: 'indexeddb',
      detail: expect.stringMatching(/^IDBDatabase\.transaction\(sessions-v2\) after its in-memory/)
    })
    storageErrors.mockRestore()
  }, 20000)

  const carriedTeam = (id: string) => ({
    scope: SCOPE,
    thread: ROUTE.threadId,
    lead: 'lead',
    member: id
  })
  const earlierWork = (task: string): ChatSession['messages'] =>
    [
      { role: 'user', content: task },
      { role: 'assistant', content: `${task} done fixture` }
    ] as ChatSession['messages']
  const heldNote = 'chat.delegated.member_label — chat.delegated.held'
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('holds a carried-over member message until the user sends to its recipient, then delivers it once', async () => {
    let carried = ''
    const page = await mountChannelPage({
      members: [
        member('designer', '设计师'),
        member('writer', '文案', earlierWork('earlier writer task'))
      ],
      beforeMount: (main) => {
        carried = main.carryOver({
          source: carriedTeam('designer'),
          kind: 'message',
          hop: 1,
          recipient: 'writer',
          text: '重启前的成员消息'
        })
      },
      model: ({ lastUserText }) => ({
        text: lastUserText.includes('重启前的成员消息') ? '文案已收到 fixture' : '文案继续 fixture'
      })
    })
    const { main } = page
    const toWriter = () =>
      main.chatRequests
        .filter((request) => request.conversationId === 'writer')
        .map((request) => textOf(request.messages.at(-1)?.content))

    // Claimed at the first poll, but never delivered by itself: the writer is held, its row says so.
    await waitFor(() => expect(main.claimRequests).toHaveLength(1), { timeout: 5000 })
    expect(await screen.findByRole('button', { name: heldNote })).toBeInTheDocument()
    await pause(2000)
    expect(toWriter()).toEqual([])
    expect(main.starts).toEqual([])

    // The user's next send to the writer resumes it: the carried-over message follows, once.
    page.send('@writer 请继续')
    await waitFor(() => expect(toWriter()).toHaveLength(2), { timeout: 5000 })
    expect(toWriter()[0]).toContain('请继续')
    expect(toWriter()[1]).toContain('重启前的成员消息')
    expect(
      main.chatRequests.find((request) =>
        textOf(request.messages.at(-1)?.content).includes('重启前的成员消息')
      )?.teamMessageDelivery
    ).toEqual({ id: carried, lease: expect.stringMatching(/^fixture-lease-/) })
    expect(main.starts).toEqual([{ id: carried, recipient: 'writer' }])
    await waitFor(async () =>
      expect((await page.stored('writer'))?.messages.map((message) => message.content)).toContain(
        '文案已收到 fixture'
      )
    )
    await pause(1500)
    expect(toWriter()).toHaveLength(2)
    expect(screen.queryByRole('button', { name: heldNote })).toBeNull()
    expect(main.refusedDeliveries).toEqual([])
    await page.finish()
  }, 30000)

  it('holds both subscribers of a carried-over channel message; each follows its own user send', async () => {
    let carried = ''
    const page = await mountChannelPage({
      members: [
        member('designer', '设计师'),
        member('writer', '文案', earlierWork('earlier writer task')),
        member('reviewer', 'reviewer', earlierWork('earlier reviewer task'))
      ],
      beforeMount: (main) => {
        carried = main.carryOver({
          source: carriedTeam('designer'),
          kind: 'channel',
          hop: 1,
          text: '重启前的频道消息'
        })
      },
      model: ({ lastUserText }) => ({
        text: lastUserText.includes('重启前的频道消息') ? '频道收到 fixture' : '继续 fixture'
      })
    })
    const { main } = page
    const to = (id: string) =>
      main.chatRequests
        .filter((request) => request.conversationId === id)
        .map((request) => textOf(request.messages.at(-1)?.content))

    await waitFor(() => expect(main.claimRequests).toHaveLength(1), { timeout: 5000 })
    await waitFor(() => expect(screen.getAllByRole('button', { name: heldNote })).toHaveLength(2))
    await pause(2000)
    expect([to('writer'), to('reviewer'), to('designer')]).toEqual([[], [], []])

    page.send('@writer 请继续')
    await waitFor(() => expect(to('writer')).toHaveLength(2), { timeout: 5000 })
    expect(to('writer')[1]).toContain('重启前的频道消息')
    await pause(1500)
    // The reviewer is still held: only the user's own send to it releases it.
    expect(to('reviewer')).toEqual([])
    expect(screen.getAllByRole('button', { name: heldNote })).toHaveLength(1)
    expect(main.starts).toEqual([{ id: carried, recipient: 'writer' }])

    page.send('@reviewer 请继续')
    await waitFor(() => expect(to('reviewer')).toHaveLength(2), { timeout: 5000 })
    expect(to('reviewer')[1]).toContain('重启前的频道消息')
    expect(main.starts).toEqual([
      { id: carried, recipient: 'writer' },
      { id: carried, recipient: 'reviewer' }
    ])
    await waitFor(async () => {
      for (const id of ['writer', 'reviewer'])
        expect((await page.stored(id))?.messages.map((message) => message.content)).toContain(
          '频道收到 fixture'
        )
    })
    await pause(1000)
    expect([to('writer').length, to('reviewer').length, to('designer').length]).toEqual([2, 2, 0])
    expect(screen.queryByRole('button', { name: heldNote })).toBeNull()
    expect(main.refusedDeliveries).toEqual([])
    await page.finish()
  }, 30000)
})

// ---------------------------------------------------------------------------------------------
// Stop on the real page (the smallest stop/queue case; K3 and backlog item 13 add theirs here)
// ---------------------------------------------------------------------------------------------

describe('real ChatPage stop on in-memory fakes', () => {
  it('cancels the running request through the bridge when the user stops', async () => {
    const page = await mountChannelPage({
      members: [member('designer', '设计师')],
      // Never answers: only Stop can end this request.
      model: () => new Promise<ModelStep>(() => undefined)
    })
    const { main } = page

    page.send('hold the lead busy')
    await waitFor(() =>
      expect(main.chatRequests.map((request) => request.conversationId)).toEqual(['lead'])
    )
    expect(main.pendingCalls()).toBeGreaterThan(0)
    fireEvent.click(await screen.findByRole('button', { name: 'chat.stop_generating' }))

    await waitFor(() => expect(main.cancelledRuns).toEqual(['lead']))
    await screen.findByRole('button', { name: 'chat.send_message' })
    // The user's message is kept, and nothing else was requested.
    await waitFor(async () =>
      expect(
        (await page.stored('lead'))?.messages.map((message) => [message.role, message.content])
      ).toContainEqual(['user', 'hold the lead busy'])
    )
    expect(main.chatRequests).toHaveLength(1)
    await page.finish()
  }, 20000)

  it('keeps a stopped member stopped: its team message waits until the user sends to it again', async () => {
    const page = await mountChannelPage({
      members: [member('designer', '设计师'), member('writer', '文案')],
      model: ({ request, lastUserText, teamTools, toolResults }) => {
        if (request.conversationId === 'writer') {
          // Never answers: only the stop ends the writer's first run.
          if (lastUserText.includes('hold writer busy'))
            return new Promise<ModelStep>(() => undefined)
          return {
            text: lastUserText.includes('来自成员的测试消息')
              ? '文案已收到 fixture'
              : '文案继续 fixture'
          }
        }
        if (!toolResults.length && teamTools.includes('send_message')) {
          return {
            tool: 'send_message',
            callId: 'fixture-stop-send',
            args: { recipient: 'writer', text: '来自成员的测试消息' }
          }
        }
        return { text: '发送成员完成 fixture' }
      }
    })
    const { main } = page
    const toWriter = () =>
      main.chatRequests
        .filter((request) => request.conversationId === 'writer')
        .map((request) => textOf(request.messages.at(-1)?.content))

    page.send('@writer hold writer busy')
    await waitFor(() => expect(toWriter()).toHaveLength(1))
    // Enter sends while a member runs (the lead's composer shows Stop).
    fireEvent.change(screen.getByTestId('chat-composer-input'), {
      target: { value: '@designer 请联系文案' }
    })
    fireEvent.keyDown(screen.getByTestId('chat-composer-input'), { key: 'Enter' })
    await waitFor(() => expect(main.claimRequests).toHaveLength(1), { timeout: 5000 })
    await waitFor(async () =>
      expect((await page.stored('designer'))?.messages.map((message) => message.content)).toContain(
        '发送成员完成 fixture'
      )
    )

    // Stop-all from the lead's composer stops the writer; its queued team message is held.
    fireEvent.click(await screen.findByRole('button', { name: 'chat.stop_generating' }))
    await waitFor(() => expect(main.cancelledRuns).toEqual(['writer']))
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(toWriter()).toHaveLength(1)
    // The writer's delegated row says so (the fixture's t() returns keys).
    expect(
      screen.getByRole('button', { name: 'chat.delegated.member_label — chat.delegated.held' })
    ).toBeInTheDocument()

    // The user's next send to the writer resumes it: the held message follows, once.
    page.send('@writer 请继续')
    await waitFor(() => expect(toWriter()).toHaveLength(3), { timeout: 5000 })
    expect(toWriter()[1]).toContain('请继续')
    expect(toWriter()[2]).toContain('来自成员的测试消息')
    await waitFor(async () =>
      expect((await page.stored('writer'))?.messages.map((message) => message.content)).toContain(
        '文案已收到 fixture'
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(toWriter()).toHaveLength(3)
    expect(main.claimRequests).toHaveLength(1)
    expect(
      screen.queryByRole('button', { name: 'chat.delegated.member_label — chat.delegated.held' })
    ).toBeNull()
    await page.finish()
  }, 30000)
  it('releases a stopped member when the user dispatches a task to it: its held team message follows the task once', async () => {
    const page = await mountChannelPage({
      members: [member('designer', '设计师'), member('writer', '文案')],
      lead: {
        teamTasks: [
          {
            id: 'task-writer',
            title: '写文案',
            ownerId: 'writer',
            status: 'pending',
            dependsOn: []
          }
        ]
      },
      model: ({ request, lastUserText, teamTools, toolResults }) => {
        if (request.conversationId === 'writer') {
          if (lastUserText.includes('hold writer busy'))
            return new Promise<ModelStep>(() => undefined)
          if (lastUserText.includes('团队任务：写文案')) return { text: '文案任务完成 fixture' }
          return {
            text: lastUserText.includes('来自成员的测试消息')
              ? '文案已收到 fixture'
              : '文案继续 fixture'
          }
        }
        if (!toolResults.length && teamTools.includes('send_message')) {
          return {
            tool: 'send_message',
            callId: 'fixture-task-send',
            args: { recipient: 'writer', text: '来自成员的测试消息' }
          }
        }
        return { text: '发送成员完成 fixture' }
      }
    })
    const { main } = page
    const toWriter = () =>
      main.chatRequests
        .filter((request) => request.conversationId === 'writer')
        .map((request) => textOf(request.messages.at(-1)?.content))

    page.send('@writer hold writer busy')
    await waitFor(() => expect(toWriter()).toHaveLength(1))
    fireEvent.change(screen.getByTestId('chat-composer-input'), {
      target: { value: '@designer 请联系文案' }
    })
    fireEvent.keyDown(screen.getByTestId('chat-composer-input'), { key: 'Enter' })
    await waitFor(() => expect(main.claimRequests).toHaveLength(1), { timeout: 5000 })
    await waitFor(async () =>
      expect((await page.stored('designer'))?.messages.map((message) => message.content)).toContain(
        '发送成员完成 fixture'
      )
    )
    fireEvent.click(await screen.findByRole('button', { name: 'chat.stop_generating' }))
    await waitFor(() => expect(main.cancelledRuns).toEqual(['writer']))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    // Held: the stop is not undone by the team message.
    expect(toWriter()).toHaveLength(1)

    // The user dispatches the writer's task: it runs first, then the held message follows, once.
    const dialog = await page.openTeamManagement()
    fireEvent.click(within(dialog).getByRole('button', { name: '执行 写文案' }))
    await waitFor(() => expect(toWriter()).toHaveLength(3), { timeout: 6000 })
    expect(toWriter()[1]).toContain('团队任务：写文案')
    expect(toWriter()[2]).toContain('来自成员的测试消息')
    await waitFor(async () => {
      const stored = await page.stored('lead')
      expect(stored?.teamTasks?.[0]).toEqual({
        id: 'task-writer',
        title: '写文案',
        ownerId: 'writer',
        status: 'done',
        dependsOn: []
      })
    })
    await waitFor(async () =>
      expect((await page.stored('writer'))?.messages.map((message) => message.content)).toContain(
        '文案已收到 fixture'
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(toWriter()).toHaveLength(3)
    expect(main.claimRequests).toHaveLength(1)
    await page.finish()
  }, 30000)

  it('stop-all holds a member whose run ended just before the click while a team message waits for it', async () => {
    const page = await mountChannelPage({
      members: [member('designer', '设计师'), member('writer', '文案')],
      model: ({ request, lastUserText, teamTools, toolResults }) => {
        if (request.conversationId === 'writer')
          return {
            text: lastUserText.includes('来自成员的测试消息')
              ? '文案已收到 fixture'
              : '文案继续 fixture'
          }
        if (!toolResults.length && teamTools.includes('send_message')) {
          return {
            tool: 'send_message',
            callId: 'fixture-ended-send',
            args: { recipient: 'writer', text: '来自成员的测试消息' }
          }
        }
        // The designer keeps running after its message: the lead's composer offers Stop.
        return new Promise<ModelStep>(() => undefined)
      }
    })
    const { main } = page
    const toWriter = () =>
      main.chatRequests
        .filter((request) => request.conversationId === 'writer')
        .map((request) => textOf(request.messages.at(-1)?.content))
    const writerExternalRun = (loading: boolean): void => {
      window.dispatchEvent(
        new CustomEvent('chat:set-external-loading', {
          detail: { scope: SCOPE, sessionId: 'writer', loading }
        })
      )
    }
    try {
      // The writer is busy with a Canvas Target run, so the designer's message waits for it, queued.
      act(() => writerExternalRun(true))
      page.send('@designer 请联系文案')
      await waitFor(() => expect(main.claimRequests).toHaveLength(1), { timeout: 5000 })
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(toWriter()).toEqual([])
      const stop = await screen.findByRole('button', { name: 'chat.stop_generating' })
      // The writer's run ends and stop-all is clicked before the next pump.
      act(() => {
        writerExternalRun(false)
        stop.click()
      })
      await waitFor(() => expect(main.cancelledRuns).toEqual(['designer']))
      await new Promise((resolve) => setTimeout(resolve, 2000))
      expect(toWriter()).toEqual([])
      // The user's next send to the writer resumes it: the held message follows, once.
      page.send('@writer 请继续')
      await waitFor(() => expect(toWriter()).toHaveLength(2), { timeout: 5000 })
      expect(toWriter()[0]).toContain('请继续')
      expect(toWriter()[1]).toContain('来自成员的测试消息')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(toWriter()).toHaveLength(2)
    } finally {
      writerExternalRun(false)
    }
    await page.finish()
  }, 30000)

  it('queues a user send to a session with a Canvas Target run and sends it exactly once after that run ends', async () => {
    const page = await mountChannelPage({
      members: [member('writer', '文案')],
      model: ({ request }) => ({
        text: request.conversationId === 'lead' ? '组长回复 fixture' : '文案回复 fixture'
      })
    })
    const { main } = page
    const toLead = () =>
      main.chatRequests
        .filter((request) => request.conversationId === 'lead')
        .map((request) => textOf(request.messages.at(-1)?.content))
    const leadExternalRun = (loading: boolean): void => {
      window.dispatchEvent(
        new CustomEvent('chat:set-external-loading', {
          detail: { scope: SCOPE, sessionId: 'lead', loading }
        })
      )
    }
    try {
      act(() => leadExternalRun(true))
      // Enter sends while the lead is busy (as a person would): the send waits behind the external run.
      fireEvent.change(screen.getByTestId('chat-composer-input'), {
        target: { value: '外部运行期间的消息' }
      })
      fireEvent.keyDown(screen.getByTestId('chat-composer-input'), { key: 'Enter' })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(toLead()).toEqual([])
      act(() => leadExternalRun(false))
      await waitFor(() => expect(toLead()).toHaveLength(1), { timeout: 5000 })
      expect(toLead()[0]).toContain('外部运行期间的消息')
      await waitFor(async () =>
        expect((await page.stored('lead'))?.messages.map((message) => message.content)).toEqual([
          '外部运行期间的消息',
          '组长回复 fixture'
        ])
      )
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(toLead()).toHaveLength(1)
    } finally {
      leadExternalRun(false)
    }
    await page.finish()
  }, 30000)
})

describe('real ChatPage member model on the real composer selector', () => {
  // The Agent column passes these hosts (AgentWorkspace); the model selector itself stays in the
  // composer (owner's request), the header host holds the team actions.
  const A = { id: PROFILE_ID, model_name: 'fixture-model' }
  const B = { id: 'fixture-profile-b', model_name: 'fixture-model-b' }
  const INHERITED = 'Inherits lead: {{model}}'
  // The first row of a member's menu while the lead's model can be used: label and that model.
  const inheritRow = (model: string): string => `Inherit lead${model}`
  const SELECTED = 'Member model: {{model}}'
  let pillHost: HTMLElement
  let overlayHost: HTMLElement
  beforeEach(() => {
    pillHost = document.createElement('div')
    overlayHost = document.createElement('div')
    document.body.append(pillHost, overlayHost)
  })
  afterEach(() => {
    pillHost.remove()
    overlayHost.remove()
  })
  const team = () => [member('designer', '设计师'), member('writer', '文案')]
  const mountTeam = (input: Partial<Parameters<typeof mountChannelPage>[0]> = {}) =>
    mountChannelPage({
      members: team(),
      model: ({ request }) => ({ text: `${request.conversationId} reply fixture` }),
      profiles: [A, B],
      props: { modelPillHost: pillHost, overlayHost },
      ...input
    })
  const slot = (): HTMLElement => screen.getByTestId('chat-composer-model-selector-slot')
  const openConversation = async (page: ChannelPage, name: string, label: string) => {
    fireEvent.click(within(page.rows).getByRole('button', { name }))
    return within(slot()).findByRole('button', { name: label })
  }
  const openLead = async (page: ChannelPage) => {
    fireEvent.click(within(page.rows).getAllByRole('button')[0])
    return within(slot()).findByRole('button', { name: 'fixture-model' })
  }
  const openMenu = async (button: HTMLElement): Promise<HTMLElement> => {
    fireEvent.click(button)
    return screen.findByRole('menu')
  }
  // A member's menu is one radio group (the lead's menu is a plain one).
  const rowNames = (menu: HTMLElement): string[] =>
    within(menu)
      .getAllByRole('menuitemradio')
      .map((item) => item.textContent ?? '?')
  // The row of the model in use: checked for a screen reader, and MUI's selected state on screen
  // (the tint, and the focus on open). The two always agree.
  const markedRows = (menu: HTMLElement): string[] => {
    const rows = within(menu).getAllByRole('menuitemradio')
    const checked = within(menu).queryAllByRole('menuitemradio', { checked: true })
    expect(rows.filter((item) => item.classList.contains('Mui-selected'))).toEqual(checked)
    expect(rows.filter((item) => item.getAttribute('aria-checked') === 'false')).toEqual(
      rows.filter((item) => !checked.includes(item))
    )
    return checked.map((item) => item.textContent ?? '?')
  }
  const closeMenu = async () => {
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
  const requestProfiles = (page: ChannelPage, conversationId: string) =>
    page.main.chatRequests
      .filter((request) => request.conversationId === conversationId)
      .map((request) => request.profileId)
  const storedReply = async (page: ChannelPage, id: string, count: number) =>
    waitFor(async () =>
      expect(
        (await page.stored(id))?.messages.filter((message) => message.role === 'assistant')
      ).toHaveLength(count)
    )
  const rawRow = (idb: FakeChatIndexedDb, id: string): Record<string, unknown> | undefined =>
    idb
      .values(SESSION_STORE)
      .find((value) => (value as { storageKey?: string }).storageKey === storageKey(id)) as
      Record<string, unknown> | undefined
  // Waits until the storage saw no put for a second (the page's debounced saves are 500 ms).
  const quietPuts = async (page: ChannelPage): Promise<number> => {
    let puts = page.idb.stats.calls.put
    for (let stable = 0; stable < 10;) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      stable = page.idb.stats.calls.put === puts ? stable + 1 : 0
      puts = page.idb.stats.calls.put
    }
    return puts
  }

  it('shows the lead model selector in the composer and leaves the header host to the team actions', async () => {
    const page = await mountTeam()
    const selector = within(slot()).getByRole('button', { name: 'fixture-model' })
    expect(within(pillHost).getByTestId('agent-header-team-actions')).toBeInTheDocument()
    expect(within(pillHost).queryByRole('button', { name: /fixture-model/ })).toBeNull()
    const menu = await openMenu(selector)
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['fixture-model', 'fixture-model-b'])
    expect(pillHost.contains(menu)).toBe(false)
    expect(overlayHost.childElementCount).toBe(0)
    await closeMenu()
    await page.finish()
  }, 30000)

  it('stores a member pick, routes that member only, and leaves the lead and the other member alone', async () => {
    const page = await mountTeam()
    const inherited = await openConversation(page, 'designer', INHERITED)
    expect(inherited).toBeEnabled()
    const leadBefore = await page.stored('lead')
    const menu = await openMenu(inherited)
    expect(rowNames(menu)).toEqual([
      inheritRow('fixture-model'),
      'fixture-model',
      'fixture-model-b'
    ])
    expect(markedRows(menu)).toEqual([inheritRow('fixture-model')])
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'fixture-model-b' }))
    await waitFor(async () =>
      expect((await page.stored('designer'))?.memberModelChoice).toEqual({
        version: 1,
        profileId: B.id
      })
    )
    expect(await page.stored('lead')).toEqual(leadBefore)
    expect(Object.hasOwn((await page.stored('writer'))!, 'memberModelChoice')).toBe(false)
    expect(Object.hasOwn(rawRow(page.idb, 'writer')!, 'memberModelChoice')).toBe(false)
    const selected = await within(slot()).findByRole('button', { name: SELECTED })
    const reopened = await openMenu(selected)
    expect(rowNames(reopened)).toEqual([
      inheritRow('fixture-model'),
      'fixture-model',
      'fixture-model-b'
    ])
    expect(markedRows(reopened)).toEqual(['fixture-model-b'])
    await closeMenu()

    page.send('designer task fixture')
    await waitFor(() => expect(requestProfiles(page, 'designer')).toEqual([B.id]))
    await storedReply(page, 'designer', 1)
    await openLead(page)
    page.send('@writer hi')
    await waitFor(() => expect(requestProfiles(page, 'writer')).toEqual([A.id]))
    await storedReply(page, 'writer', 1)
    expect(requestProfiles(page, 'designer')).toEqual([B.id])
    await page.finish()
  }, 30000)

  it('closes the member menu and writes nothing when the pane is hidden', async () => {
    const page = await mountTeam()
    const inherited = await openConversation(page, 'designer', INHERITED)
    await openMenu(inherited)
    const putsBefore = await quietPuts(page)
    page.rerender({ active: false })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(pillHost.childElementCount).toBe(0)
    expect(await quietPuts(page)).toBe(putsBefore)
    expect(Object.hasOwn((await page.stored('designer'))!, 'memberModelChoice')).toBe(false)
    await page.finish()
  }, 30000)

  it('keeps a member pick across a restart: the picked member uses it, the lead and the other member do not', async () => {
    const first = await mountTeam()
    const menu = await openMenu(await openConversation(first, 'designer', INHERITED))
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'fixture-model-b' }))
    await waitFor(async () =>
      expect((await first.stored('designer'))?.memberModelChoice).toEqual({
        version: 1,
        profileId: B.id
      })
    )
    await within(slot()).findByRole('button', { name: SELECTED })
    await first.finish()

    const second = await mountTeam({ members: team(), storage: first.idb })
    await openLead(second)
    second.send('lead task fixture')
    await waitFor(() => expect(requestProfiles(second, 'lead')).toEqual([A.id]))
    await storedReply(second, 'lead', 1)
    // No click on a model: the stored pick is what the member shows and uses.
    expect(
      markedRows(await openMenu(await openConversation(second, 'designer', SELECTED)))
    ).toEqual(['fixture-model-b'])
    await closeMenu()
    second.send('designer task fixture')
    await waitFor(() => expect(requestProfiles(second, 'designer')).toEqual([B.id]))
    await storedReply(second, 'designer', 1)
    await openLead(second)
    second.send('@writer hi')
    await waitFor(() => expect(requestProfiles(second, 'writer')).toEqual([A.id]))
    await storedReply(second, 'writer', 1)
    expect((await second.stored('designer'))?.memberModelChoice).toEqual({
      version: 1,
      profileId: B.id
    })
    expect(Object.hasOwn((await second.stored('writer'))!, 'memberModelChoice')).toBe(false)
    await second.finish()
  }, 40000)

  it('lets a member of an earlier build inherit the lead model and opens it without a write', async () => {
    // As earlier builds wrote them: the member's own profileId and the team default never decided.
    let before: { lead?: unknown; designer?: unknown } = {}
    const page = await mountTeam({
      members: [{ ...member('designer', '设计师'), profileId: B.id }, member('writer', '文案')],
      lead: { teamSettings: { maxMembers: 6, defaultModel: B.id, autoCleanup: false } },
      beforePage: (idb) => {
        before = { lead: rawRow(idb, 'lead'), designer: rawRow(idb, 'designer') }
      }
    })
    expect(before.designer).toMatchObject({ profileId: B.id })
    expect(Object.hasOwn(before.designer as object, 'memberModelChoice')).toBe(false)
    expect(before.lead).toMatchObject({ profileId: A.id, teamSettings: { defaultModel: B.id } })
    expect(markedRows(await openMenu(await openConversation(page, 'designer', INHERITED)))).toEqual(
      [inheritRow('fixture-model')]
    )
    await closeMenu()
    await quietPuts(page)
    expect(rawRow(page.idb, 'lead')).toBe(before.lead)
    expect(rawRow(page.idb, 'designer')).toBe(before.designer)
    page.send('designer task fixture')
    await waitFor(() => expect(requestProfiles(page, 'designer')).toEqual([A.id]))
    await storedReply(page, 'designer', 1)
    expect(Object.hasOwn((await page.stored('designer'))!, 'memberModelChoice')).toBe(false)
    await page.finish()
  }, 30000)

  it('keeps a member marker of a newer build closed: no pick, no request, the record unchanged', async () => {
    let seeded: Record<string, unknown> | undefined
    const page = await mountTeam({
      beforePage: (idb) => {
        const row = structuredClone(rawRow(idb, 'designer')!)
        row.memberModelChoice = { version: 2, profileId: B.id }
        idb.seedRows(SESSION_STORE, [{ key: storageKey('designer'), value: row }])
        seeded = structuredClone(row)
      }
    })
    const unavailable = await openConversation(page, 'designer', 'Member model unavailable')
    expect(unavailable).toBeDisabled()
    fireEvent.click(unavailable)
    expect(screen.queryByRole('menu')).toBeNull()
    page.send('designer task fixture')
    await waitFor(() => expect(h.notify).toHaveBeenCalledWith('Team lead unavailable.'))
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('designer task fixture')
    await quietPuts(page)
    expect(page.main.chatRequests).toEqual([])
    // The record keeps every stored field, the unknown marker included, byte for byte; the one
    // addition is the person's own kept text, saved as the draft as for any conversation.
    expect(rawRow(page.idb, 'designer')).toEqual({
      ...seeded,
      draft: {
        inputValue: 'designer task fixture',
        pendingAttachments: [],
        pendingHiddenContext: '',
        updatedAt: expect.any(Number)
      }
    })
    await page.quiesce()
    expect(h.notify.mock.calls).toEqual([['Team lead unavailable.']])
    expect(page.main.chatRequests).toEqual([])
    expect(channelDeniedAttempts()).toEqual([])
  }, 30000)

  it('lets a member whose picked model was removed pick again and keeps the text it kept', async () => {
    const C = { id: 'fixture-profile-c', model_name: 'fixture-model-c' }
    const UNAVAILABLE = 'Member model unavailable'
    const page = await mountTeam({
      profiles: [A, C],
      beforePage: (idb) => {
        const row = structuredClone(rawRow(idb, 'designer')!)
        row.memberModelChoice = { version: 1, profileId: B.id }
        idb.seedRows(SESSION_STORE, [{ key: storageKey('designer'), value: row }])
      }
    })
    const unavailable = await openConversation(page, 'designer', UNAVAILABLE)
    expect(unavailable).toBeEnabled()
    page.send('designer task fixture')
    await waitFor(() => expect(h.notify).toHaveBeenCalledWith('Team lead unavailable.'))
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('designer task fixture')
    // The kept text is saved as the draft; once that save has settled the member can be repaired.
    await quietPuts(page)
    expect(page.main.chatRequests).toEqual([])
    const before = await page.stored('designer')
    expect(before?.draft?.inputValue).toBe('designer task fixture')
    const menu = await openMenu(within(slot()).getByRole('button', { name: UNAVAILABLE }))
    expect(rowNames(menu)).toEqual([
      inheritRow('fixture-model'),
      'fixture-model',
      'fixture-model-c'
    ])
    expect(markedRows(menu)).toEqual([])
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'fixture-model-c' }))
    await waitFor(async () =>
      expect((await page.stored('designer'))?.memberModelChoice).toEqual({
        version: 1,
        profileId: C.id
      })
    )
    await within(slot()).findByRole('button', { name: SELECTED })
    expect(screen.getByTestId('chat-composer-input')).toHaveValue('designer task fixture')
    const after = await page.stored('designer')
    expect(after?.draft).toEqual(before?.draft)
    expect(after?.messages).toEqual(before?.messages)
    expect(h.notify.mock.calls).toEqual([['Team lead unavailable.']])
    page.send('designer task fixture')
    await waitFor(() => expect(requestProfiles(page, 'designer')).toEqual([C.id]))
    await storedReply(page, 'designer', 1)
    expect(requestProfiles(page, 'designer')).toEqual([C.id])
    await page.quiesce()
    expect(h.notify.mock.calls).toEqual([['Team lead unavailable.']])
    expect(channelDeniedAttempts()).toEqual([])
  }, 30000)

  it.each([
    ['held as the restart restored it', false],
    ['paused after a resume was refused', true]
  ])(
    'lets a member whose model is gone after a restart pick again while its queued text waits (%s), and sends that text with the new model',
    async (_case, refuseFirst) => {
      const C = { id: 'fixture-profile-c', model_name: 'fixture-model-c' }
      const UNAVAILABLE = 'Member model unavailable'
      const QUEUED = 'queued designer fixture'
      const model: FakeModel = ({ request, lastUserText }) =>
        lastUserText.includes('hold designer busy')
          ? // Never answers: only Stop ends this request.
            new Promise<ModelStep>(() => undefined)
          : { text: `${request.conversationId} reply fixture` }
      const queueItem = (): HTMLElement =>
        within(screen.getByRole('region', { name: 'chat.queue_region' })).getByTestId(
          'chat-queue-item'
        )
      const resumeQueued = async () => {
        fireEvent.click(within(queueItem()).getByRole('button', { name: 'chat.queue_edit' }))
        fireEvent.click(await within(queueItem()).findByRole('button', { name: 'chat.queue_save' }))
      }

      // The designer runs on its own model; the person queues more text for it, then stops it.
      const first = await mountTeam({ model })
      const menu = await openMenu(await openConversation(first, 'designer', INHERITED))
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'fixture-model-b' }))
      await within(slot()).findByRole('button', { name: SELECTED })
      first.send('hold designer busy')
      await waitFor(() => expect(requestProfiles(first, 'designer')).toEqual([B.id]))
      fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: QUEUED } })
      fireEvent.keyDown(screen.getByTestId('chat-composer-input'), { key: 'Enter' })
      await waitFor(() => expect(queueItem()).toHaveTextContent(QUEUED))
      fireEvent.click(await screen.findByRole('button', { name: 'chat.stop_generating' }))
      await waitFor(() => expect(first.main.cancelledRuns).toEqual(['designer']))
      await waitFor(async () =>
        expect(
          (await first.stored('designer'))?.draft?.queuedSends?.map((item) => item.content)
        ).toEqual([QUEUED])
      )
      await first.finish()

      // A restart without that model: the queued text comes back held, the member's model is gone.
      const second = await mountTeam({ model, profiles: [A, C], storage: first.idb })
      await openConversation(second, 'designer', UNAVAILABLE)
      await waitFor(() => expect(queueItem()).toHaveAttribute('data-status', 'held'))
      expect(queueItem()).toHaveTextContent(QUEUED)
      if (refuseFirst) {
        // Resuming it now is refused (no usable model); it stays, paused.
        await resumeQueued()
        await waitFor(() => expect(h.notify).toHaveBeenCalledWith('Team lead unavailable.'))
        await waitFor(() => expect(queueItem()).toHaveAttribute('data-status', 'paused'))
      }
      await quietPuts(second)
      expect(requestProfiles(second, 'designer')).toEqual([])

      // The pick goes through while the paused text waits for the person.
      const repick = await openMenu(within(slot()).getByRole('button', { name: UNAVAILABLE }))
      fireEvent.click(within(repick).getByRole('menuitemradio', { name: 'fixture-model-c' }))
      await waitFor(async () =>
        expect((await second.stored('designer'))?.memberModelChoice).toEqual({
          version: 1,
          profileId: C.id
        })
      )
      await within(slot()).findByRole('button', { name: SELECTED })
      expect(queueItem()).toHaveTextContent(QUEUED)
      expect(requestProfiles(second, 'designer')).toEqual([])

      // Resumed by the person, the text goes out once, on the model just picked.
      await resumeQueued()
      await waitFor(() => expect(requestProfiles(second, 'designer')).toEqual([C.id]))
      expect(
        textOf(
          second.main.chatRequests
            .find((request) => request.conversationId === 'designer')
            ?.messages.at(-1)?.content
        )
      ).toContain(QUEUED)
      await waitFor(async () =>
        expect(
          (await second.stored('designer'))?.messages.map((message) => [
            message.role,
            message.content
          ])
        ).toEqual(
          expect.arrayContaining([
            ['user', QUEUED],
            ['assistant', 'designer reply fixture']
          ])
        )
      )
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: 'chat.queue_region' })).toBeNull()
      )
      await second.quiesce()
      expect(requestProfiles(second, 'designer')).toEqual([C.id])
      expect(h.notify.mock.calls).toEqual(refuseFirst ? [['Team lead unavailable.']] : [])
      expect(channelDeniedAttempts()).toEqual([])
    },
    60000
  )

  it('lets a member inherit the lead again: it follows the lead model, across a restart too', async () => {
    const C = { id: 'fixture-profile-c', model_name: 'fixture-model-c' }
    const pick = async (page: ChannelPage, name: string, row: string, label: string) => {
      const menu = await openMenu(await openConversation(page, name, INHERITED))
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: row }))
      await within(slot()).findByRole('button', { name: label })
    }
    const first = await mountTeam({ profiles: [A, B, C] })
    await pick(first, 'designer', 'fixture-model-b', SELECTED)
    await pick(first, 'writer', 'fixture-model-b', SELECTED)
    // The designer follows the lead again.
    const menu = await openMenu(await openConversation(first, 'designer', SELECTED))
    expect(markedRows(menu)).toEqual(['fixture-model-b'])
    const inherit = within(menu).getAllByRole('menuitemradio')[0]
    expect(inherit).toHaveTextContent(inheritRow('fixture-model'))
    fireEvent.click(inherit)
    await within(slot()).findByRole('button', { name: INHERITED })
    const designer = await first.stored('designer')
    expect(Object.hasOwn(designer!, 'memberModelChoice')).toBe(false)
    expect(Object.hasOwn(rawRow(first.idb, 'designer')!, 'memberModelChoice')).toBe(false)
    expect((await first.stored('writer'))?.memberModelChoice).toEqual({
      version: 1,
      profileId: B.id
    })
    first.send('designer task fixture')
    await waitFor(() => expect(requestProfiles(first, 'designer')).toEqual([A.id]))
    await storedReply(first, 'designer', 1)

    // The lead changes its own model: the inheriting member follows, the one with a pick does not.
    const leadMenu = await openMenu(await openLead(first))
    fireEvent.click(within(leadMenu).getByRole('menuitem', { name: 'fixture-model-c' }))
    await within(slot()).findByRole('button', { name: 'fixture-model-c' })
    await waitFor(async () => expect((await first.stored('lead'))?.profileId).toBe(C.id))
    first.send('@designer next task')
    await waitFor(() => expect(requestProfiles(first, 'designer')).toEqual([A.id, C.id]))
    await storedReply(first, 'designer', 2)
    first.send('@writer hi')
    await waitFor(() => expect(requestProfiles(first, 'writer')).toEqual([B.id]))
    await storedReply(first, 'writer', 1)
    await first.finish()

    const second = await mountTeam({ profiles: [A, B, C], storage: first.idb })
    const reopened = await openMenu(await openConversation(second, 'designer', INHERITED))
    expect(markedRows(reopened)).toEqual([inheritRow('fixture-model-c')])
    await closeMenu()
    expect(Object.hasOwn((await second.stored('designer'))!, 'memberModelChoice')).toBe(false)
    second.send('designer after restart')
    await waitFor(() => expect(requestProfiles(second, 'designer')).toEqual([C.id]))
    await storedReply(second, 'designer', 3)
    await second.finish()
  }, 60000)
})
