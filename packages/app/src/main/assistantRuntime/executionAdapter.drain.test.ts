import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolInvokeAction, ToolResultAction } from '@shared/agent'
import type { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import type { AssistantRunEvent } from './types'
import { assertKnownAssistantToolOutcomes } from './toolRecovery'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), sync: vi.fn() }))
vi.mock('../agentKernel/toolBridge', () => ({
  invokeAssistantToolViaKernel: bridge.invoke,
  syncAssistantToolsWithAgentKernel: bridge.sync
}))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => ({ pathMap: { data: process.cwd() } })
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))
import { AssistantExecutionAdapter } from './executionAdapter'

type Request = Parameters<AssistantExecutionAdapter['callTool']>[2]
type Result = Awaited<ReturnType<AssistantExecutionAdapter['callTool']>>
type Action = ToolInvokeAction | ToolResultAction
type ChatOptions = NonNullable<Parameters<LLMProxySvcImpl['chat']>[1]>
const definition = { name: 'demo.effect', description: 'Local fixture', inputSchema: {} }
const options = { runId: 'retained-run', toolCallId: 'same-call' }
const inProgress = { code: 'TOOL_INVOCATION_IN_PROGRESS' }
const review = { code: 'TOOL_REPLAY_REQUIRES_REVIEW' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function microtasks() {
  for (let index = 0; index < 48; index++) await Promise.resolve()
}
async function expectInProgress(pending: Promise<unknown>) {
  let settled = false, result: unknown
  // A broken duplicate guard must fail an assertion, not wait on the same raw
  // fixture until Vitest's timeout. Observe both outcomes before inspecting it.
  void pending.then(value => { settled = true; result = value }, error => { settled = true; result = error })
  await microtasks()
  expect({ settled, result }).toMatchObject({ settled: true, result: inProgress })
}
function journal() {
  const events: AssistantRunEvent[] = []
  return {
    events,
    store: {
      getSession: async () => ({ eventLog: events.slice() }),
      appendEvents: async (_route: unknown, incoming: AssistantRunEvent[]) => {
        events.push(...incoming)
      }
    }
  }
}
function requestFor(
  store: object,
  execution?: CooperativeExecutionController,
  signal?: AbortSignal
): Request {
  return {
    config: {},
    route: { channel: 'generic', scopeType: 'dm', scopeId: 'retained-tool-fixture' },
    sessionStore: store,
    taskState: {},
    cooperativeExecution: execution,
    signal
  } as unknown as Request
}
function adapterFor(
  path: 'provider' | 'kernel',
  request: Request,
  work: () => Promise<Result>,
  onAgentAction?: (action: Action) => void | Promise<void>
) {
  const invoke = vi.fn(work)
  if (path === 'provider') {
    request = { ...request, toolProvider: { listTools: () => [definition], callTool: invoke } }
  } else bridge.invoke.mockImplementation(invoke)
  const adapter = new AssistantExecutionAdapter({
    chatService: { chat: vi.fn() },
    toolRegistry: { listTools: () => [] } as never,
    onAgentAction
  })
  return { adapter, request, invoke }
}
function lastResult(events: AssistantRunEvent[]): ToolResultAction {
  return events.at(-1)!.metadata!.agentAction as ToolResultAction
}

beforeEach(() => { bridge.invoke.mockReset(); bridge.sync.mockReset() })

describe('adapter-returned invocation promise retention (not nested wrapper/effect drainage)', () => {
  it.each([
    ['provider', 'fulfill'], ['provider', 'reject'],
    ['kernel', 'fulfill'], ['kernel', 'reject']
  ] as const)(
    'keeps %s ownership after prompt cancellation until late %s, without rewriting the receipt',
    async (path, settlement) => {
      const raw = deferred<Result>(), entered = deferred<void>()
      const execution = new CooperativeExecutionController(), abort = new AbortController()
      const { events, store } = journal()
      const actions: Action[] = []
      const fixture = adapterFor(path, requestFor(store, execution, abort.signal), () => {
        entered.resolve(undefined)
        return raw.promise
      }, action => { actions.push(action) })
      const pending = fixture.adapter.callTool('demo.effect', {}, fixture.request, options)
      const observed = pending.catch(error => error)
      let pause: Promise<unknown> | undefined, acknowledged = false
      try {
        await entered.promise
        pause = execution.requestPause().then(ticket => { acknowledged = true; return ticket }, error => error)
        abort.abort('user stopped waiting')
        const callerError = await observed
        expect(callerError).toMatchObject({ name: 'AbortError', message: 'user stopped waiting' })
        expect(callerError.code).not.toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
        await microtasks()
        expect(execution.isQuiescent()).toBe(false)
        expect(acknowledged).toBe(false)
        expect(lastResult(events).payload).toMatchObject({
          ok: false, error: { code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' }
        })
        const saved = JSON.stringify(events), savedActions = JSON.stringify(actions)
        if (settlement === 'fulfill') raw.resolve({ content: 'late value is not a caller result' })
        else raw.reject(new Error('late invocation rejection stays observed'))
        await microtasks()
        expect(execution.isPauseCurrent(await pause as never)).toBe(true)
        expect(JSON.stringify(events)).toBe(saved)
        expect(JSON.stringify(actions)).toBe(savedActions)
        expect(fixture.invoke).toHaveBeenCalledOnce()
      } finally {
        raw.resolve({ content: 'cleanup' })
        execution.resume()
        await observed
        await pause
        await microtasks()
      }
    }
  )

  it.each([
    ['provider', false], ['provider', true], ['kernel', false], ['kernel', true]
  ] as const)(
    'retains the shared %s identity after abort with a journal=%s until the invocation settles',
    async (path, durable) => {
      const raw = deferred<Result>(), entered = deferred<void>(), abort = new AbortController()
      const { store } = journal(), sharedStore = durable ? store : {}
      const fixture = adapterFor(path, requestFor(sharedStore, undefined, abort.signal), () => {
        entered.resolve(undefined)
        return raw.promise
      })
      const second = new AssistantExecutionAdapter({
        chatService: { chat: vi.fn() }, toolRegistry: { listTools: () => [] } as never
      })
      const pending = fixture.adapter.callTool('demo.effect', {}, fixture.request, options)
      const observed = pending.catch(error => error)
      const independentRequest = { ...fixture.request, signal: undefined }
      try {
        await entered.promise
        abort.abort('cancel only the first caller')
        expect(await observed).toMatchObject({ name: 'AbortError' })
        await expectInProgress(second.callTool('demo.effect', {}, independentRequest, options))
        expect(fixture.invoke).toHaveBeenCalledOnce()
        raw.resolve({ content: 'finished later' })
        await microtasks()
        if (durable) {
          await expect(second.callTool('demo.effect', {}, independentRequest, options)).rejects.toMatchObject(review)
          expect(fixture.invoke).toHaveBeenCalledOnce()
        } else {
          // With no durable journal there is no restart/replay safety proof. A
          // different explicit invocation may proceed after the old one drains;
          // do not require blindly rerunning the old unknown identity here.
          await expect(second.callTool('demo.effect', {}, independentRequest, {
            ...options, toolCallId: 'new-explicit-call'
          })).resolves.toMatchObject({ content: 'finished later' })
          expect(fixture.invoke).toHaveBeenCalledTimes(2)
        }
      } finally {
        raw.resolve({ content: 'cleanup' })
        await observed
        await microtasks()
      }
    }
  )

  it.each(['invocation-first', 'publication-first'] as const)(
    'keeps identity until both invocation and terminal observer settle (%s)',
    async order => {
      const raw = deferred<Result>(), entered = deferred<void>(), publication = deferred<void>()
      const publishing = deferred<void>(), abort = new AbortController()
      const execution = new CooperativeExecutionController()
      const fixture = adapterFor('provider', requestFor({}, execution, abort.signal), () => {
        entered.resolve(undefined)
        return raw.promise
      }, async action => {
        if (action.type === 'tool.result') { publishing.resolve(undefined); await publication.promise }
      })
      const pending = fixture.adapter.callTool('demo.effect', {}, fixture.request, options)
      const observed = pending.catch(error => error)
      const independent = { ...fixture.request, cooperativeExecution: undefined, signal: undefined }
      const second = new AssistantExecutionAdapter({
        chatService: { chat: vi.fn() }, toolRegistry: { listTools: () => [] } as never
      })
      let pause: Promise<unknown> | undefined, acknowledged = false
      try {
        await entered.promise
        abort.abort('cancel with two remaining owners')
        await publishing.promise
        pause = execution.requestPause().then(ticket => { acknowledged = true; return ticket }, error => error)
        if (order === 'invocation-first') raw.resolve({ content: 'late raw done' })
        else { publication.resolve(undefined); await observed }
        await microtasks()
        expect(acknowledged).toBe(false)
        expect(execution.isQuiescent()).toBe(false)
        await expectInProgress(fixture.adapter.callTool('demo.effect', {}, independent, options))
        // The publication-only tail must be shared across adapters on this exact
        // store too, not just retained by the adapter that owns the observer.
        await expectInProgress(second.callTool('demo.effect', {}, independent, options))
        expect(fixture.invoke).toHaveBeenCalledOnce()
        if (order === 'invocation-first') publication.resolve(undefined)
        else raw.resolve({ content: 'late raw done' })
        expect(await observed).toMatchObject({ name: 'AbortError' })
        await pause
        expect(execution.isQuiescent()).toBe(true)
      } finally {
        publication.resolve(undefined)
        raw.resolve({ content: 'cleanup' })
        execution.resume()
        await observed
        await pause
        await microtasks()
      }
    }
  )

  it.each(['invocation-first', 'publication-first'] as const)(
    'does not release identity while cancellation journal persistence is still pending (%s)',
    async order => {
      const raw = deferred<Result>(), entered = deferred<void>(), saving = deferred<void>()
      const finishSave = deferred<void>(), abort = new AbortController()
      const execution = new CooperativeExecutionController(), events: AssistantRunEvent[] = []
      const store = {
        getSession: async () => ({ eventLog: events.slice() }),
        appendEvents: async (_route: unknown, incoming: AssistantRunEvent[]) => {
          if ((incoming[0]?.metadata?.agentAction as Action)?.type === 'tool.result') {
            saving.resolve(undefined)
            await finishSave.promise
          }
          events.push(...incoming)
        }
      }
      const fixture = adapterFor('provider', requestFor(store, execution, abort.signal), () => {
        entered.resolve(undefined)
        return raw.promise
      })
      const observed = fixture.adapter.callTool('demo.effect', {}, fixture.request, options).catch(error => error)
      const second = new AssistantExecutionAdapter({
        chatService: { chat: vi.fn() }, toolRegistry: { listTools: () => [] } as never
      })
      let pause: Promise<unknown> | undefined, acknowledged = false
      try {
        await entered.promise
        abort.abort('cancel pending durable save')
        await saving.promise
        pause = execution.requestPause().then(ticket => { acknowledged = true; return ticket }, error => error)
        if (order === 'invocation-first') raw.resolve({ content: 'late returned value' })
        else { finishSave.resolve(undefined); await observed }
        await microtasks()
        expect(acknowledged).toBe(false)
        await expectInProgress(fixture.adapter.callTool('demo.effect', {}, {
          ...fixture.request, signal: undefined, cooperativeExecution: undefined
        }, options))
        await expectInProgress(second.callTool('demo.effect', {}, {
          ...fixture.request, signal: undefined, cooperativeExecution: undefined
        }, options))
        expect(fixture.invoke).toHaveBeenCalledOnce()
        if (order === 'invocation-first') finishSave.resolve(undefined)
        else raw.resolve({ content: 'late returned value' })
        expect(await observed).toMatchObject({ name: 'AbortError' })
        await pause
        expect(lastResult(events).payload.error?.code).toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
      } finally {
        finishSave.resolve(undefined); raw.resolve({ content: 'cleanup' }); execution.resume()
        await observed; await pause; await microtasks()
      }
    }
  )

  it('does not let failed cancellation publication release a still-pending invocation or replace AbortError', async () => {
    const raw = deferred<Result>(), entered = deferred<void>(), abort = new AbortController()
    const execution = new CooperativeExecutionController()
    const fixture = adapterFor('provider', requestFor({}, execution, abort.signal), () => {
      entered.resolve(undefined)
      return raw.promise
    }, action => { if (action.type === 'tool.result') throw new Error('terminal observer failed') })
    const pending = fixture.adapter.callTool('demo.effect', {}, fixture.request, options)
    const observed = pending.catch(error => error)
    try {
      await entered.promise
      abort.abort('original cancellation')
      expect(await observed).toMatchObject({ name: 'AbortError', message: 'original cancellation' })
      expect(execution.isQuiescent()).toBe(false)
      await expectInProgress(fixture.adapter.callTool('demo.effect', {}, {
        ...fixture.request, cooperativeExecution: undefined, signal: undefined
      }, options))
    } finally {
      raw.reject(new Error('cleanup late failure'))
      await observed
      await microtasks()
      execution.resume()
    }
  })

  it.each(['fulfill', 'reject'] as const)(
    'treats an abort receipt as unknown for replay and recovery after late %s and a fresh journal reader',
    async settlement => {
      const raw = deferred<Result>(), entered = deferred<void>(), abort = new AbortController()
      const { events, store } = journal()
      const fixture = adapterFor('provider', requestFor(store, undefined, abort.signal), () => {
        entered.resolve(undefined)
        return raw.promise
      })
      const pending = fixture.adapter.callTool('demo.effect', {}, fixture.request, options)
      const observed = pending.catch(error => error)
      try {
        await entered.promise
        abort.abort('unknown external outcome')
        expect(await observed).toMatchObject({ name: 'AbortError' })
        const cancellationReceipt = JSON.stringify(events)
        if (settlement === 'fulfill') raw.resolve({ content: 'late success is not rollback proof' })
        else raw.reject(new Error('late failure is not rollback proof'))
        await microtasks()
        const freshReader = {
          getSession: async () => ({ eventLog: JSON.parse(JSON.stringify(events)) }),
          appendEvents: vi.fn()
        }
        const replay = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
        const replayed = await replay.callTool('demo.effect', {}, {
          ...fixture.request, sessionStore: freshReader as never, signal: undefined
        }, options).catch(error => error)
        let recovery: unknown
        try { assertKnownAssistantToolOutcomes(events, options.runId) } catch (error) { recovery = error }
        expect({ replayed, recovery }).toMatchObject({ replayed: review, recovery: review })
        expect(JSON.stringify(events)).toBe(cancellationReceipt)
        expect(freshReader.appendEvents).not.toHaveBeenCalled()
        expect(fixture.invoke).toHaveBeenCalledOnce()
      } finally {
        raw.resolve({ content: 'cleanup' })
        await observed
        await microtasks()
      }
    }
  )

  it('does not classify a normally rejected invocation as unknown just because its terminal observer sees a later abort', async () => {
    const original = new Error('ordinary invocation failure'), abort = new AbortController()
    const { events, store } = journal()
    const fixture = adapterFor('provider', requestFor(store, undefined, abort.signal), async () => {
      throw original
    }, action => { if (action.type === 'tool.result') abort.abort('too late to win') })
    await expect(fixture.adapter.callTool('demo.effect', {}, fixture.request, options)).rejects.toBe(original)
    expect(lastResult(events).payload.error?.code).not.toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
    expect(() => assertKnownAssistantToolOutcomes(events, options.runId)).not.toThrow()
  })

  it('keeps a synchronous invocation exception primary when the same provider call aborts before throwing', async () => {
    const abort = new AbortController(), original = new Error('sync provider exception')
    const { events, store } = journal()
    const fixture = adapterFor('provider', requestFor(store, undefined, abort.signal), () => {
      abort.abort('provider aborts and then throws')
      throw original
    })
    await expect(fixture.adapter.callTool('demo.effect', {}, fixture.request, options)).rejects.toBe(original)
    expect(lastResult(events).payload.error?.code).not.toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
  })

  it('handles an abort inside dispatch before the cancellation listener is installed without releasing the returned promise', async () => {
    const abort = new AbortController(), raw = deferred<Result>()
    const execution = new CooperativeExecutionController(), { events, store } = journal()
    const fixture = adapterFor('provider', requestFor(store, execution, abort.signal), () => {
      abort.abort('synchronous dispatch cancellation')
      return raw.promise
    })
    const pending = fixture.adapter.callTool('demo.effect', {}, fixture.request, options)
    const observed = pending.catch(error => error)
    try {
      expect(await observed).toMatchObject({ name: 'AbortError', message: 'synchronous dispatch cancellation' })
      expect(execution.isQuiescent()).toBe(false)
      expect(lastResult(events).payload.error?.code).toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
    } finally { raw.resolve({ content: 'late' }); await observed; await microtasks(); execution.resume() }
  })

  it('records uncertainty when abort wins even if the invocation settles before the cancellation catch continuation', async () => {
    const abort = new AbortController(), raw = deferred<Result>(), entered = deferred<void>()
    const { events, store } = journal()
    const fixture = adapterFor('provider', requestFor(store, undefined, abort.signal), () => {
      entered.resolve(undefined)
      return raw.promise
    })
    const pending = fixture.adapter.callTool('demo.effect', {}, fixture.request, options)
    const observed = pending.catch(error => error)
    try {
      await entered.promise
      abort.abort('abort wins before raw resolution')
      raw.resolve({ content: 'same-tick late fulfillment' })
      expect(await observed).toMatchObject({ name: 'AbortError' })
      expect(lastResult(events).payload.error?.code).toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
    } finally { raw.resolve({ content: 'cleanup' }); await observed; await microtasks() }
  })

  it.each([false, true])(
    'forwards a live chat parent cancellation after tool dispatch with a distinct invocation signal (gate=%s)',
    async gated => {
      const raw = deferred<Result>(), entered = deferred<void>()
      const parent = new AbortController(), invocationSignal = new AbortController()
      const execution = new CooperativeExecutionController(), { events, store } = journal()
      let toolError: unknown, completed = false, providerSignal: AbortSignal | undefined
      const request = requestFor(store, gated ? execution : undefined, parent.signal)
      const adapter = new AssistantExecutionAdapter({
        toolRegistry: { listTools: () => [] } as never,
        chatService: { chat: async (_req, chatOptions?: ChatOptions) => {
          try {
            await chatOptions!.executeTool!({
              toolName: 'demo.effect', args: {}, runId: options.runId,
              toolCallId: options.toolCallId, signal: invocationSignal.signal
            })
          } catch (error) { toolError = error }
          return { content: 'Local chat fixture observed cancellation' }
        } }
      })
      const pending = adapter.run({
        ...request, runId: options.runId, messages: [],
        req: { route: request.route, text: 'Local fixture', execution: { allowedToolNames: ['demo.effect'] } },
        toolProvider: {
          listTools: () => [definition],
          callTool: (_name, _args, context) => {
            providerSignal = context.signal; entered.resolve(undefined); return raw.promise
          }
        }
      } as Parameters<AssistantExecutionAdapter['run']>[0])
      const observed = pending.then(result => { completed = true; return result }, error => error)
      try {
        await entered.promise
        parent.abort('parent stopped after dispatch')
        await microtasks()
        expect({ completed, toolError }).toMatchObject({
          completed: true, toolError: { name: 'AbortError', message: 'parent stopped after dispatch' }
        })
        expect(invocationSignal.signal.aborted).toBe(false)
        expect(providerSignal?.aborted).toBe(true)
        expect(lastResult(events).payload.error?.code).toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN')
        if (gated) expect(execution.isQuiescent()).toBe(false)
      } finally {
        raw.resolve({ content: 'late return' }); await observed; await microtasks(); execution.resume()
      }
    }
  )

  it('does not dispatch or create a raw-work owner for an already-aborted root', async () => {
    const execution = new CooperativeExecutionController(), abort = new AbortController()
    abort.abort('already cancelled')
    const fixture = adapterFor('provider', requestFor({}, execution, abort.signal), async () => ({ content: 'forbidden' }))
    await expect(fixture.adapter.callTool('demo.effect', {}, fixture.request, options)).rejects.toThrow()
    expect(fixture.invoke).not.toHaveBeenCalled()
    expect(execution.isQuiescent()).toBe(true)
  })
})
