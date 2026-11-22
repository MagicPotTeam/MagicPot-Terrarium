import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import type { CooperativeOperationGate } from '../magicAgentPlatform2/agents/cooperativeExecutionController'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), sync: vi.fn() }))
vi.mock('../agentKernel/toolBridge', () => ({ invokeAssistantToolViaKernel: bridge.invoke, syncAssistantToolsWithAgentKernel: bridge.sync }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => process.cwd() }, BrowserWindow: class {}, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
import { AssistantExecutionAdapter } from './executionAdapter'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function microtasks() { for (let i = 0; i < 32; i++) await Promise.resolve() }
type Request = Parameters<AssistantExecutionAdapter['run']>[0]
type ChatOptions = NonNullable<Parameters<LLMProxySvcImpl['chat']>[1]>
const requestFor = (cooperativeExecution?: CooperativeOperationGate, runId = 'scoped-run'): Request => ({ config: {}, route: { channel: 'generic', scopeType: 'dm', scopeId: 'scoped-adapter' }, sessionStore: {}, taskState: {}, messages: [], req: { text: 'local', execution: { allowedToolNames: ['demo.echo'] } }, runId, cooperativeExecution }) as unknown as Request
const invocation = (toolCallId = 'one') => ({ toolName: 'demo.echo', args: {}, runId: 'scoped-run', toolCallId })

beforeEach(() => { bridge.invoke.mockReset(); bridge.sync.mockReset(); bridge.invoke.mockResolvedValue({ content: 'tool done' }) })

describe('AssistantExecutionAdapter explicit scoped admission (not underlying effect drainage)', () => {
  it.each(['tool', 'llm'])('uses the callback-only %s gate without legacy fallback and keeps its callback live to settlement', async kind => {
    const execution = new CooperativeExecutionController(), gate = { run: execution.run.bind(execution) }
    const started = deferred(), finish = deferred()
    const work = vi.fn(async () => { started.resolve(); await finish.promise; return { content: 'done' } })
    bridge.invoke.mockImplementation(work)
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: work } })
    const request = requestFor(gate), pending = (kind === 'tool' ? adapter.callTool('demo.echo', {}, request) : adapter.run(request))
    const observed = pending.catch(error => error)
    try {
      await microtasks(); expect(work).toHaveBeenCalledOnce(); expect(execution.isQuiescent()).toBe(false)
      let acknowledged = false
      const pause = execution.requestPause().then(ticket => { acknowledged = true; return ticket }, error => error)
      await microtasks(); expect(acknowledged).toBe(false)
      finish.resolve(); expect(await observed).not.toBeInstanceOf(Error)
      expect(execution.isPauseCurrent(await pause)).toBe(true)
    } finally { finish.resolve(); execution.resume(); await observed }
  })

  it('lets real chat children drain a requested pause while independent tool roots remain blocked', async () => {
    const execution = new CooperativeExecutionController(), started = deferred(), callChildren = deferred(), finishTools = deferred()
    const effects: string[] = []
    bridge.invoke.mockImplementation(async (input: { args: { label?: string } }) => { effects.push(input.args.label || 'child'); await finishTools.promise; return { content: 'done' } })
    const chat = vi.fn(async (_req, options?: ChatOptions) => { started.resolve(); await callChildren.promise; await Promise.all([options!.executeTool!({ ...invocation('one'), args: { label: 'one' } }), options!.executeTool!({ ...invocation('two'), args: { label: 'two' } })]); return { content: 'done' } })
    const adapter = new AssistantExecutionAdapter({ chatService: { chat } }), request = requestFor(execution)
    const pending = adapter.run(request), observed = pending.catch(error => error)
    let independent: Promise<unknown> | undefined, pause: Promise<unknown> | undefined, acknowledged = false
    try {
      await started.promise
      pause = execution.requestPause().then(ticket => { acknowledged = true; return ticket }, error => error)
      independent = adapter.callTool('demo.echo', { label: 'independent' }, { ...request, sessionStore: {} } as Request).catch(error => error)
      callChildren.resolve(); await microtasks()
      expect(effects.sort()).toEqual(['one', 'two']); expect(acknowledged).toBe(false); expect(execution.isQuiescent()).toBe(false)
      finishTools.resolve(); expect(await observed).not.toBeInstanceOf(Error); await pause
      expect(effects).not.toContain('independent'); expect(execution.isPaused()).toBe(true)
      execution.resume(); await independent; expect(effects).toContain('independent')
    } finally { callChildren.resolve(); finishTools.resolve(); execution.resume(); await observed; await independent; await pause }
  })

  it.each([false, true])('rejects a late captured executeTool while the outer turn remains live (invocation aborted: %s)', async abortInvocation => {
    const execution = new CooperativeExecutionController(), keepTurn = deferred(), chatDone = deferred()
    let options!: ChatOptions, lateError: unknown
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: async (_request, current) => { options = current!; return { content: 'done' } } } })
    const root = execution.run('assistant-turn', undefined, async child => {
      try {
        await adapter.run(requestFor(child)); chatDone.resolve()
        const cancelled = new AbortController(); if (abortInvocation) cancelled.abort(new Error('invocation cancelled'))
        try { await options.executeTool!({ ...invocation('late'), signal: cancelled.signal }) } catch (error) { lateError = error }
        await keepTurn.promise
      } finally { chatDone.resolve() }
    })
    const observed = root.catch(error => error)
    try {
      await chatDone.promise; await microtasks()
      expect(lateError).toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      expect(bridge.invoke).not.toHaveBeenCalled(); expect(execution.isQuiescent()).toBe(false)
    } finally { keepTurn.resolve(); execution.resume(); await observed }
  })

  it('does not mutate a reused request or let one completed chat borrow a different live chat scope', async () => {
    const execution = new CooperativeExecutionController(), firstDone = deferred(), secondStarted = deferred(), finishSecond = deferred()
    const options: ChatOptions[] = []
    const chat = vi.fn(async (_req, current?: ChatOptions) => { options.push(current!); if (options.length === 1) { firstDone.resolve(); return { content: 'first' } } secondStarted.resolve(); await finishSecond.promise; return { content: 'second' } })
    const adapter = new AssistantExecutionAdapter({ chatService: { chat } }), shared = Object.freeze(requestFor(execution))
    const first = adapter.run(shared), a = first.catch(error => error)
    let second: Promise<unknown> | undefined
    try {
      await firstDone.promise; await a; second = adapter.run(shared).catch(error => error); await secondStarted.promise
      await expect(options[0].executeTool!(invocation('stale-first'))).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      await options[1].executeTool!(invocation('live-second'))
      expect(bridge.invoke).toHaveBeenCalledOnce(); expect(shared.cooperativeExecution).toBe(execution)
      expect(execution.isQuiescent()).toBe(false)
    } finally { finishSecond.resolve(); execution.resume(); await a; await second }
  })

  it('retains an admitted tool lease through asynchronous terminal audit instead of acknowledging early', async () => {
    const execution = new CooperativeExecutionController(), auditStarted = deferred(), finishAudit = deferred()
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() }, onAgentAction: async action => { if (action.type === 'tool.result') { auditStarted.resolve(); await finishAudit.promise } } })
    const pending = adapter.callTool('demo.echo', {}, requestFor(execution)), observed = pending.catch(error => error)
    let pause: Promise<unknown> | undefined, acknowledged = false
    try {
      await auditStarted.promise
      pause = execution.requestPause().then(ticket => { acknowledged = true; return ticket }, error => error)
      await microtasks(); expect(acknowledged).toBe(false); expect(execution.isQuiescent()).toBe(false)
      finishAudit.resolve(); await observed; await pause; expect(execution.isQuiescent()).toBe(true)
    } finally { finishAudit.resolve(); execution.resume(); await observed; await pause }
  })

  it('retains the tool scope through a failed terminal observer, preserves its error and never retries the effect', async () => {
    const execution = new CooperativeExecutionController(), reached = deferred(), finish = deferred(), original = new Error('audit failed')
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() }, onAgentAction: async action => { if (action.type === 'tool.result') { reached.resolve(); await finish.promise; throw original } } })
    const pending = adapter.callTool('demo.echo', {}, requestFor(execution)), observed = pending.catch(error => error)
    let pause: Promise<unknown> | undefined, acknowledged = false
    try {
      await reached.promise; pause = execution.requestPause().then(ticket => { acknowledged = true; return ticket }, error => error)
      await microtasks(); expect(acknowledged).toBe(false); expect(execution.isQuiescent()).toBe(false)
      finish.resolve(); expect(await observed).toBe(original); await pause
      expect(bridge.invoke).toHaveBeenCalledOnce(); expect(execution.isQuiescent()).toBe(true)
    } finally { finish.resolve(); execution.resume(); await observed; await pause }
  })

  it('admits a durable replay before consulting it without adding another action pair or tool effect', async () => {
    const execution = new CooperativeExecutionController(), actions: unknown[] = []
    const sessionStore = { getSession: async () => ({ eventLog: actions.map(action => ({ metadata: { agentAction: action } })) }), appendEvents: async (_route: unknown, events: Array<{ metadata?: { agentAction?: unknown } }>) => { actions.push(...events.map(event => event.metadata?.agentAction)) } }
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } }), request = { ...requestFor(execution), sessionStore } as unknown as Request
    const options = { runId: 'durable-run', toolCallId: 'exact' }
    const first = await adapter.callTool('demo.echo', {}, request, options)
    const ticket = await execution.requestPause()
    let replayed = false
    const replay = adapter.callTool('demo.echo', {}, request, options).then(value => { replayed = true; return value }), observed = replay.catch(error => error)
    try {
      await microtasks(); expect(replayed).toBe(false); expect(execution.isPauseCurrent(ticket)).toBe(true)
      execution.resume(); expect(await observed).toEqual(first); expect(actions).toHaveLength(2); expect(bridge.invoke).toHaveBeenCalledOnce()
    } finally { execution.resume(); await observed }
  })

  it('drops the full request path from the admitted tool-only context instead of retaining a parent scope', async () => {
    const execution = new CooperativeExecutionController(), adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
    // Inspection-only spy on the private handoff, not the gate or actual dispatch.
    const admitted = vi.spyOn(adapter as unknown as { executeAdmittedToolInvokeAction: (...args: unknown[]) => Promise<unknown> }, 'executeAdmittedToolInvokeAction')
    const full = Object.freeze({ ...requestFor(execution), req: Object.freeze({ ...requestFor().req, cooperativeExecution: execution }) })
    await adapter.callTool('demo.echo', {}, full)
    const context = admitted.mock.calls[0]?.[2] as Record<string, unknown>
    expect(context).not.toHaveProperty('req'); expect(Object.isFrozen(context)).toBe(true)
    expect(context.cooperativeExecution).not.toBe(execution); expect(full.req.cooperativeExecution).toBe(execution)
    expect(bridge.invoke).toHaveBeenCalledOnce(); expect(execution.isQuiescent()).toBe(true)
  })

  it('inherits a cancelled parent scope even when executeTool supplies a different live signal', async () => {
    const execution = new CooperativeExecutionController(), parent = new AbortController(), invocationSignal = new AbortController()
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: async (_req, options?: ChatOptions) => {
      parent.abort(new Error('parent stopped'))
      await options!.executeTool!({ ...invocation('cancelled'), signal: invocationSignal.signal })
      return { content: 'forbidden' }
    } } })
    await expect(adapter.run({ ...requestFor(execution), signal: parent.signal })).rejects.toThrow('parent stopped')
    expect(bridge.invoke).not.toHaveBeenCalled(); expect(invocationSignal.signal.aborted).toBe(false); expect(execution.isQuiescent()).toBe(true)
  })
})
