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
 */
import {
  allowChannelBridge,
  allowChannelInMemoryIndexedDb,
  assertNoChannelDeniedAttempts,
  channelDeniedAttempts,
  channelGuardedGlobals,
  isChannelGuardDenied,
  repairReplacedChannelGuards,
  takeChannelDeniedAttempts,
  totalChannelDeniedAttempts,
  type ChannelBridgeAllowance
} from '../../test/channelDenyGuards'
import type React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import { loadSessionFromDB, saveSessionToDB, type ChatSession } from './chatStorage'

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

/**
 * In-memory stand-in for MAIN behind `window.api.svcLLMProxy`: the chat entry points, the team
 * message tools and the process-local team message queue (main/api/agentTeamMessageQueue.ts:
 * capacity 128, 60 s TTL, list by route + storage scope + lead, claim removes). Nothing here
 * leaves the process. Every request the page sent is kept for assertions.
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
  /** Conversation IDs of requests that were cancelled while the model was still working. */
  readonly cancelledRuns: string[] = []
  private readonly queue = new Map<string, { routeKey: string; view: AgentTeamMessageIntent }>()
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

  private prune(): void {
    const now = Date.now()
    for (const [id, entry] of this.queue) if (entry.view.expiresAt <= now) this.queue.delete(id)
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
    this.prune()
    if (this.queue.size >= 128) throw new Error('Team queue capacity reached.')
    const view: AgentTeamMessageIntent = {
      id: `fixture-intent-${++this.nextId}`,
      source: { ...source },
      kind: step.tool === 'send_message' ? 'message' : 'channel',
      hop: request.teamMessageHop === 1 ? 2 : 1,
      ...(recipient === undefined ? {} : { recipient }),
      text: step.args.text,
      expiresAt: Date.now() + 60_000
    }
    this.queue.set(view.id, {
      routeKey: getAgentSessionKey(normalizeAgentRoute(request.route)),
      view
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

  private queueMatches(
    scope: AgentTeamMessageQueueScope,
    entry: { routeKey: string; view: AgentTeamMessageIntent }
  ): boolean {
    return (
      entry.routeKey === getAgentSessionKey(normalizeAgentRoute(scope.route)) &&
      entry.view.source.scope === scope.storageScope &&
      entry.view.source.lead === scope.conversationId
    )
  }

  /** What the page may call on `window.api`; everything else stays refused by the guards. */
  bridge(): ChannelBridgeAllowance {
    const unavailable = (method: string) =>
      this.track(method, async () => {
        throw new Error(`${method} is not available in the channel fixture.`)
      })
    return {
      svcLLMProxy: {
        chatStream: (request: LLMChatReq, stream: ServerStreaming<LLMChatStreamResp>) =>
          this.track('chatStream', async (req: LLMChatReq) => {
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
          async (req: AgentTeamMessageQueueScope) => {
            this.prune()
            return {
              intents: [...this.queue.values()]
                .filter((entry) => this.queueMatches(req, entry))
                .map((entry) => structuredClone(entry.view))
            }
          }
        ),
        claimAgentTeamMessage: this.track(
          'claimAgentTeamMessage',
          async (req: AgentTeamMessageClaim) => {
            this.claimRequests.push(structuredClone(req))
            this.prune()
            const entry = this.queue.get(req.id)
            if (!entry || !this.queueMatches(req, entry)) return {}
            this.queue.delete(req.id)
            return { intent: structuredClone(entry.view) }
          }
        ),
        // The thread has no background jobs or processes, and a running request asks nothing.
        listAgentJobs: this.track('listAgentJobs', async () => ({ jobs: [] })),
        listAgentProcesses: this.track('listAgentProcesses', async () => ({ jobs: [] })),
        listAgentInteractions: this.track('listAgentInteractions', async () => ({
          interactions: []
        })),
        listAgentArchiveQueries: this.track('listAgentArchiveQueries', async () => ({
          queries: []
        })),
        // Skill, HTML-app and first-run pane bindings are MAIN capabilities this fixture leaves off.
        agentSkillScopeRevision: unavailable('agentSkillScopeRevision'),
        setAgentSkillScope: unavailable('setAgentSkillScope'),
        setAgentHtmlScope: unavailable('setAgentHtmlScope'),
        managedFirstRunPaneRevision: unavailable('managedFirstRunPaneRevision'),
        setManagedFirstRunPaneScope: unavailable('setManagedFirstRunPaneScope')
      }
    }
  }
}

type ChannelPageProps = Partial<React.ComponentProps<typeof ChatPage>>

interface ChannelPage {
  main: FakeTeamMain
  idb: FakeChatIndexedDb
  /** Renders the same page again with other props (pane switches: `{ active: false }`). */
  rerender(props: ChannelPageProps): void
  /** The record the real chat storage holds for a session. */
  stored(id: string): Promise<ChatSession | null>
  area: HTMLElement
  send(text: string): void
  openTeamManagement(): Promise<HTMLElement>
  /** Expands a member row of the process area and returns it. */
  memberRow(name: string): HTMLElement
  /** Unmounts, waits until storage and bridge are quiet, and asserts nothing was refused. */
  finish(): Promise<void>
  /** Unmounts and waits until storage and bridge are quiet (no assertions). */
  quiesce(): Promise<void>
}

/** The page of the running test until it finished; a failed test is torn down in afterEach. */
let mountedPage: ChannelPage | undefined

const theme = createTheme()
const lead = (): ChatSession =>
  ({
    id: 'lead',
    title: 'Lead',
    profileId: PROFILE_ID,
    messages: [],
    teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false }
  }) as ChatSession
const member = (id: string, role: string): ChatSession =>
  ({
    id,
    title: id,
    profileId: PROFILE_ID,
    messages: [],
    teamLeadId: 'lead',
    teamMemberName: id,
    teamRole: role
  }) as ChatSession

async function mountChannelPage(input: {
  members: ChatSession[]
  model: FakeModel
  /** Storage of an earlier page of the same test: a restart, nothing is seeded again. */
  storage?: FakeChatIndexedDb
  /** Extra ChatPage props (for example `active: false` for a hidden pane). */
  props?: ChannelPageProps
}): Promise<ChannelPage> {
  const idb = input.storage ?? createFakeChatIndexedDb()
  idb.install((_name, fake) => allowChannelInMemoryIndexedDb(fake))
  const main = new FakeTeamMain(input.model)
  allowChannelBridge('api', main.bridge())

  const config = structuredClone(DEFAULT_CONFIG) as Config
  config.use_remote_llm = false
  config.llm_config.api_profiles = [
    {
      id: PROFILE_ID,
      model_name: 'fixture-model',
      model_use: 'chat',
      api_mode: 'chat-completions',
      // Never resolved: MAIN is the in-memory fake, and the guards refuse every connection.
      base_url: 'http://channel-fixture.invalid/v1/chat/completions',
      api_key: 'fixture-only'
    }
  ] as Config['llm_config']['api_profiles']
  h.config.value = config

  if (!input.storage) {
    for (const session of [lead(), ...input.members]) await saveSessionToDB(session, SCOPE)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, SCOPE), 'lead')
  }

  const element = (props: ChannelPageProps = {}): React.ReactElement => (
    <MemoryRouter>
      <ThemeProvider theme={theme}>
        <ChatPage compact storageScope={SCOPE} route={ROUTE} {...input.props} {...props} />
      </ThemeProvider>
    </MemoryRouter>
  )
  const view = render(element())
  const area = await screen.findByRole('region', { name: '进程区' })
  // The real page is mounted on the lead conversation: real composer, real message list.
  expect(document.querySelector(`[data-chat-page-root="${SCOPE}"]`)).not.toBeNull()
  expect(screen.getByTestId('chat-composer-input')).toBeInTheDocument()
  expect(screen.getByTestId('chat-message-list')).toBeInTheDocument()
  for (const session of input.members) {
    await within(area).findByRole('button', { name: `展开 ${session.id} 详情` })
  }

  const activity = (): number =>
    main.calls.length + Object.values(idb.stats.calls).reduce((sum, count) => sum + count, 0)
  // Debounced saves (500 ms) and in-flight bridge answers of the unmounted page must land while
  // this test's fakes are still allowed: wait until both have been quiet for a while.
  const quiesce = async (): Promise<void> => {
    mountedPage = undefined
    view.unmount()
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
  const page: ChannelPage = {
    main,
    idb,
    rerender: (props) => view.rerender(element(props)),
    stored: (id) => loadSessionFromDB(id, SCOPE),
    area,
    send: (text) => {
      fireEvent.change(screen.getByTestId('chat-composer-input'), { target: { value: text } })
      fireEvent.click(screen.getByRole('button', { name: 'chat.send_message' }))
    },
    openTeamManagement: async () => {
      fireEvent.click(screen.getByTestId('chat-composer-add-menu-button'))
      fireEvent.click(await screen.findByTestId('chat-composer-menu-team'))
      return screen.findByRole('dialog', { name: '团队管理' })
    },
    memberRow: (name) => {
      const row = within(area)
        .getByRole('button', { name: `展开 ${name} 详情` })
        .closest('li')
      if (!row) throw new Error(`missing member row: ${name}`)
      const toggle = within(row).getByRole('button', { name: `展开 ${name} 详情` })
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeVisible()
      return row
    },
    finish: async () => {
      await quiesce()
      expect(main.pendingCalls()).toBe(0)
      // No toast: no save failure, no refused team message, no warning of any kind.
      expect(h.notify.mock.calls).toEqual([])
      expect(channelDeniedAttempts()).toEqual([])
    },
    quiesce
  }
  mountedPage = page
  return page
}

beforeAll(() => {
  // jsdom has no layout: the transcript scrolls its end marker into view.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: () => undefined
    })
  }
})
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  h.notify.mockClear()
})
afterEach(async () => {
  // A test that failed before page.finish(): end held replies and let the page settle, so its
  // late saves cannot land in the next test (where they would be refused and counted).
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
    await saveSessionToDB(
      { id: 'in-memory', title: 'in-memory', messages: [] } as ChatSession,
      'guard-self-test'
    )
    expect((await loadSessionFromDB('in-memory', 'guard-self-test'))?.title).toBe('in-memory')
    expect(channelDeniedAttempts()).toEqual([])
  })

  it('refuses IndexedDB again in the next test', () => {
    expect(() => indexedDB.open('magicpot-chat')).toThrow(/refused indexeddb/)
    expect(takeChannelDeniedAttempts()).toHaveLength(1)
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
  const RESPONDED = '已收到响应（不代表送达）'
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

    const writerRow = page.memberRow('writer')
    const designerRow = page.memberRow('designer')
    const activity = await within(writerRow).findByTestId('team-message-activity')
    const activityLine = within(activity).getByText(/designer → writer/)
    expect(activityLine).toHaveTextContent('来自成员的测试消息')
    expect(activityLine).toHaveTextContent(RESPONDED)
    expect(getComputedStyle(activityLine).color).toBe('rgba(0, 0, 0, 0.6)')
    expect(
      within(await within(designerRow).findByTestId('team-message-activity')).getByText(
        /writer → designer/
      )
    ).toHaveTextContent('文案回复设计')

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

    const writerRow = page.memberRow('writer')
    const reviewerRow = page.memberRow('reviewer')
    const observerRow = page.memberRow('observer')
    await waitFor(() => {
      for (const [id, row] of [
        ['writer', writerRow],
        ['reviewer', reviewerRow]
      ] as const) {
        expect(
          within(within(row).getByTestId('team-message-activity')).getByText(
            new RegExp(`designer → ${id}`)
          )
        ).toHaveTextContent(RESPONDED)
      }
    })
    expect(within(observerRow).queryByText(/designer → observer/)).toBeNull()
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
    const line = (row: HTMLElement, pattern: RegExp) =>
      within(within(row).getByTestId('team-message-activity')).getByText(pattern)

    broadcast('snapshot old broadcast')
    const writerRow = page.memberRow('writer')
    const reviewerRow = page.memberRow('reviewer')
    const observerRow = page.memberRow('observer')
    await waitFor(() => {
      expect(line(writerRow, /用户 → writer.*snapshot old broadcast/)).toHaveTextContent('排队中')
      expect(line(reviewerRow, /用户 → reviewer.*snapshot old broadcast/)).toHaveTextContent(
        RESPONDED
      )
    })
    fireEvent.click(writer)
    fireEvent.click(observer)
    await waitFor(() => {
      expect(writer).not.toBeChecked()
      expect(observer).toBeChecked()
    })
    broadcast('snapshot new broadcast')
    await waitFor(() => {
      expect(line(reviewerRow, /用户 → reviewer.*snapshot new broadcast/)).toHaveTextContent(
        RESPONDED
      )
      expect(line(observerRow, /用户 → observer.*snapshot new broadcast/)).toHaveTextContent(
        RESPONDED
      )
    })
    expect(byRecipient('writer', 'snapshot old broadcast')).toHaveLength(0)
    expect(byRecipient('writer', 'snapshot new broadcast')).toHaveLength(0)

    releaseBusy?.()
    releaseBusy = undefined
    await waitFor(() =>
      expect(line(writerRow, /用户 → writer.*snapshot old broadcast/)).toHaveTextContent(RESPONDED)
    )
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
    // A user broadcast never goes through the MAIN queue.
    expect(main.enqueued).toEqual([])
    expect(main.claimRequests).toEqual([])
    await page.finish()
  }, 20000)
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
    fireEvent.click(within(second.area).getByRole('button', { name: '打开 designer' }))
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
    await second.finish()
  }, 20000)
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
})
