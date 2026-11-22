import { EventEmitter } from 'node:events'
import { net } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../../../shared/config/config'
import type { MagicAgentPlatformRunResp } from '../../../shared/api/svcMagicAgentPlatform'
import { MagicAgentPlatformSvcImpl } from '../../api/svcMagicAgentPlatformImpl'
import { AssistantSessionStore } from '../../assistantRuntime/sessionStore'
import { vol } from 'memfs'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { _crashTesting } from '../persistence/crashHooks'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { TerminalApprovalCoordinator } from '../terminalApprovalCoordinator'
import { digestPolicyRequest } from '../../../shared/magicAgentPlatform2'
import { PersistentManagedAgentExecutionStore, type ManagedExecutionAttempt } from './persistentManagedAgentExecutionStore'
import type { ManagedFirstRunEnvironment } from './managedFirstRunLifecycle'
import { NodeSQLiteAdapter } from '../persistence/sqliteAdapter'
import { ProductionAgentInstanceLifecycle } from './productionAgentInstanceLifecycleOwner'
import { PersistentManagedAgentInstanceStore } from './persistentManagedAgentInstanceStore'

vi.mock('electron', () => ({ net: { fetch: vi.fn(), request: vi.fn() }, BrowserWindow: { fromWebContents: vi.fn() }, webContents: { fromId: vi.fn() }, app: { getPath: () => '.' } }))
vi.mock('node:fs', async (importActual) => importActual())
vi.mock('../../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn() }))
vi.mock('../../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/managed-joint-workspace' } }) }))
vi.mock('../../magicAgentRuntime/packageResolver', () => ({ MagicAgentPackageResolver: class {} }))
vi.mock('@main/aiClients/visionClient', () => ({ createVisionChatClient: vi.fn() }))
const resources: MagicAgentEventStore[] = []
const native = () => new Promise<void>(resolve => setImmediate(resolve))
const config = (): Config => { const value = structuredClone(DEFAULT_CONFIG); value.use_remote_llm = false; value.llm_config.api_profiles = [{ id: 'fixture-profile', provider: 'openai', deployment: 'local', call_type: 'local', model_use: 'agent', api_mode: 'chat-completions', base_url: 'http://127.0.0.1:1234/v1/chat/completions', api_key: '', model_name: 'fixture-model', request_timeout_ms: 1000 }]; return value }
const intent = () => ({ instanceId: 'joint-root', runId: 'joint-run', name: 'Explicit bounded run', text: 'A single explicit plain text message', profileId: 'fixture-profile', maxOutputTokens: 64, route: { channel: 'generic', scopeType: 'dm' as const, scopeId: 'new-isolated-managed-session' } })
const failedRunner = async (): Promise<MagicAgentPlatformRunResp> => { throw Error('ordinary runner must not be entered') }
function setup(enabled = true, { holdResponse = false } = {}) {
  const events = new MagicAgentEventStore(':memory:'); resources.push(events)
  const rules = [{ ruleId: 'explicit-managed-first-run', priority: 100, effect: 'require-approval' as const, match: { actions: ['agent.instance.managed.birth', 'agent.instance.managed.start', 'agent.instance.managed.stop'] }, explanation: 'Explicit approval only.', approvalRequirement: { scopeKind: 'request' as const, scopeValue: '*', maxUses: 1, expiresInMs: 60_000, reason: 'New bounded model run.' } }]
  const approver = { kind: 'user' as const, id: 'desktop-approver' }
  const authorization = new MagicAgentPolicyAuthorizationService({ store: events, policyVersion: 'managed-joint-test-v1', storeId: 'managed-joint', trustedApprovers: [approver], rules: [...rules, { ruleId: 'deny-nonuser-managed-stop-fixture', priority: 200, effect: 'deny', match: { actions: ['agent.instance.managed.stop'], actorKinds: ['agent'] }, explanation: 'Fixture worker cannot cancel the desktop user owner.' }] })
  const approvals = new TerminalApprovalCoordinator(authorization, request => { const at = Date.now(); const { grant } = authorization.createApprovalGrant({ grantId: `grant:${digestPolicyRequest(request)}`, request, approvedBy: approver, maxUses: 1, issuedAt: at, expiresAt: at + 60_000, idempotencyKey: `grant:${digestPolicyRequest(request)}` }); return { grantId: grant.grantId, expectedGrantUseCount: 0 } })
  // Keep the concrete mock surface in the request collection; new abort-order
  // cases inspect native abort completion, not just EventEmitter events.
  type MockNativeRequest = EventEmitter & { end: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
  const revoked = new AbortController(), requests: MockNativeRequest[] = []
  const sessionStore = new AssistantSessionStore('/managed-joint-sessions.json')
  const facade = MagicAgentPlatformSvcImpl.createManagedTextFirstRunService(sessionStore)
  const platform = new MagicAgentPlatformSvcImpl()
  const respond = (request: EventEmitter) => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'application/json' } })
    request.emit('response', response)
    queueMicrotask(() => {
      response.emit('data', Buffer.from(JSON.stringify({ id: 'reply', choices: [{ message: { role: 'assistant', content: 'bounded reply' }, finish_reason: 'stop' }] })))
      response.emit('end')
    })
  }
  vi.mocked(net.request).mockImplementation(() => {
    const request = new EventEmitter() as MockNativeRequest
    request.setHeader = vi.fn(); request.write = vi.fn()
    request.end = vi.fn(() => { if (!holdResponse) respond(request) })
    request.abort = vi.fn(); requests.push(request)
    return request as never
  })
  const prepare = vi.fn(async (): Promise<ManagedFirstRunEnvironment> => {
    expect(owner.service.hasActive(intent().instanceId)).toBe(true)
    return { config: config(), configVersion: 'config-joint-v1', document: { senderId: 10, conversationId: 'current-document', revision: 1 }, actor: { kind: 'user' as const, id: 'desktop-user' }, signal: revoked.signal, facade, dispose: vi.fn() }
  })
  const owner = new ProductionAgentInstanceLifecycle({ eventStore: events, authorization, platformService: platform, runAgent: failedRunner, ...(enabled ? { managedFirstRun: { approvals, prepare } } : {}) })
  const start = () => owner.service.startManagedTextFirstRun(intent())
  const approve = async (approved = true) => { await vi.waitFor(() => expect(approvals.list()).toHaveLength(1)); const view = approvals.list()[0]; approvals.resolve({ approvalId: view.approvalId, expectedRevision: view.revision, approved }) }
  const stop = async (idempotencyKey: string) => {
    const request = owner.service.prepareManagedTextFirstRunStop({ actor: { kind: 'user', id: 'desktop-user' }, instanceId: 'joint-root' })
    const reference = approvals.request(request)
    await approve()
    const approved = await reference
    return owner.service.stop({ instanceId: 'joint-root', expectedRevision: request.input.revision as number, actor: request.actor, idempotencyKey, grantId: approved.grantId, expectedGrantUseCount: approved.expectedGrantUseCount })
  }
  return { events, owner, start, stop, prepare, approvals, approve, revoked, requests, sessionStore, facade, respond }
}
const adapterOf = (events: MagicAgentEventStore): NodeSQLiteAdapter => (events as unknown as { adapter: NodeSQLiteAdapter }).adapter
const attemptOf = (events: MagicAgentEventStore) => events.listResources({ kind: 'managed-agent-execution-attempt' })[0] as { state: ManagedExecutionAttempt } | undefined
afterEach(() => { _crashTesting.setHook(null); vi.restoreAllMocks(); vol.reset(); for (const store of resources.splice(0)) store.close() })
describe('disabled production-owner bounded first-run joint composition', () => {
  it('has no managed boot dependency or ordinary fallback by default', () => { const f = setup(false); expect(() => f.start()).toThrow(/disabled|unavailable/i); expect(f.owner.service.hasActive('joint-root')).toBe(false); expect(f.events.countEvents()).toBe(0) })
  it('owns preparation, two explicit approvals, fresh atomic acceptance, native close and atomic terminal in the same active owner', async () => {
    const startCall = vi.spyOn(PersistentManagedAgentInstanceStore.prototype, 'startFirstAttempt')
    const f = setup(), handle = f.start(); await f.approve(); await f.approve(); await native()
    const startFailure = startCall.mock.results.find(result => result.type === 'throw')
    if (startFailure) throw startFailure.value
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); await native()
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.owner.store.get('joint-root')?.state.status).toBe('running')
    expect(f.events.listResources({ kind: 'managed-agent-execution-attempt' })[0].state).toMatchObject({ status: 'open', acceptance: { protocol: 'assistant-final-input/v1', runId: 'joint-run' } })
    f.requests[0].emit('close'); await handle.joined
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' })
    expect(f.owner.service.hasActive('joint-root')).toBe(false)
    expect(f.owner.store.get('joint-root')?.state.status).toBe('stopped')
    const coverage = f.events.listResources({ kind: 'managed-agent-instance-coverage' })[0]
    expect(coverage).toMatchObject({ revision: 1, state: { status: 'dirty' } })
    expect(f.events.listResources({ kind: 'managed-agent-execution-attempt' })[0]).toMatchObject({ revision: 1, state: { status: 'bounded-closed', totalIntents: 0, terminal: { witness: 'producer-closure' } } })
    expect(await f.sessionStore.listSessions()).toHaveLength(1); expect(net.fetch).not.toHaveBeenCalled()
  })
  it('joins late preparation on close without birth, dispatch or a second owner', async () => {
    const f = setup(); let finish!: (value: Awaited<ReturnType<typeof f.prepare>>) => void
    const original = f.prepare.getMockImplementation()!
    f.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const handle = f.start(); await native(); let closed = false; const close = f.owner.close().then(() => { closed = true }); await native(); expect(closed).toBe(false)
    finish(await original()); await close; await handle.joined
    await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' }); expect(f.owner.store.get('joint-root')).toBeUndefined(); expect(f.requests).toHaveLength(0)
  })
  it('retires only a positively born unused virgin root when start approval is denied', async () => {
    const f = setup(), handle = f.start(); await f.approve(); await f.approve(false); await handle.joined
    await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' }); expect(f.owner.store.get('joint-root')?.state.status).toBe('removed'); expect(f.events.listResources({ kind: 'managed-agent-execution-attempt' })).toHaveLength(0); expect(f.requests).toHaveLength(0)
  })
  it('uses a definite pre-COMMIT rollback, not absence-looking readback, to retire revoked acceptance', async () => {
    const f = setup(), handle = f.start(); await f.approve(); await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit' && f.owner.store.get('joint-root')?.state.status === 'running') f.revoked.abort(Error('document revoked')) })
    await f.approve(); await handle.joined
    expect(f.owner.store.get('joint-root')?.state.status).toBe('removed'); expect(f.events.listResources({ kind: 'managed-agent-execution-attempt' })).toHaveLength(0); expect(f.requests).toHaveLength(0)
  })
  it('publishes distinct accepted-never-dispatched evidence on a positive commit followed by revocation', async () => {
    const f = setup(), handle = f.start(); await f.approve(); await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    _crashTesting.setHook(stage => { if (stage === 'resource.after-commit' && f.owner.store.get('joint-root')?.state.status === 'running') f.revoked.abort(Error('after acceptance revoked')) })
    await f.approve(); await handle.joined
    expect(f.requests).toHaveLength(0); expect(f.owner.store.get('joint-root')?.state.status).toBe('stopped')
    expect(f.events.listResources({ kind: 'managed-agent-execution-attempt' })[0].state).toMatchObject({ status: 'bounded-closed', terminal: { witness: 'accepted-never-dispatched', status: 'cancelled' } })
  })
  it('rejects a direct bounded-terminal read if its stopped instance snapshot no longer matches its lifecycle mutation receipt', async () => {
    const f = setup(), handle = f.start(); await f.approve(); await f.approve(); await vi.waitFor(() => expect(f.requests).toHaveLength(1)); f.requests[0].emit('close'); await handle.joined
    const attempt = f.events.listResources({ kind: 'managed-agent-execution-attempt' })[0].state as ManagedExecutionAttempt
    const ledger = new PersistentManagedAgentExecutionStore(f.events)
    expect(ledger.getAttempt(attempt.identity)?.state.status).toBe('bounded-closed')
    const current = f.owner.store.get('joint-root')!
    const adapter = (f.events as unknown as { adapter: NodeSQLiteAdapter }).adapter
    adapter.prepare('UPDATE resources SET state_json = ? WHERE resource_kind = ? AND resource_id = ?').run(JSON.stringify({ ...current.state, name: 'inconsistent snapshot' }), 'agent-instance', 'joint-root')
    expect(() => ledger.getAttempt(attempt.identity)).toThrow(/corrupt|mutation|receipt|evidence/i)
  })

  it('does not create any managed resource until the first explicit approval is granted', async () => {
    const f = setup(), handle = f.start()
    await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    expect(f.events.listResources().filter(row => ['agent-instance', 'managed-agent-instance-coverage', 'managed-agent-execution-attempt'].includes(row.kind))).toHaveLength(0)
    expect(f.requests).toHaveLength(0)
    await f.approve(false); await handle.joined
    await expect(handle.result).resolves.toEqual({ status: 'cancelled' })
    expect(f.events.listResources().filter(row => ['agent-instance', 'managed-agent-instance-coverage', 'managed-agent-execution-attempt'].includes(row.kind))).toHaveLength(0)
    expect(f.owner.service.hasActive('joint-root')).toBe(false)
  })

  it.each(['birth', 'start'] as const)('cancels while awaiting %s approval without leaving a runnable attempt', async approval => {
    const f = setup(), handle = f.start()
    if (approval === 'start') await f.approve()
    await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    await f.owner.service.cancelManagedTextFirstRun('joint-root'); await handle.joined
    expect(f.approvals.list()).toHaveLength(0)
    expect(attemptOf(f.events)).toBeUndefined()
    expect(f.owner.store.get('joint-root')?.state.status).toBe(approval === 'birth' ? undefined : 'removed')
    expect(f.requests).toHaveLength(0)
    await expect(handle.result).resolves.toEqual({ status: 'cancelled' })
    expect(() => f.owner.service.cancelManagedTextFirstRun('joint-root')).toThrow(/no active/i)
  })

  it('reserves the exact owner before a reentrant preparation close, and disposes late preparation once', async () => {
    const f = setup(), original = f.prepare.getMockImplementation()!
    let closing!: Promise<void>, disposals = 0
    f.prepare.mockImplementationOnce(async () => {
      expect(() => f.start()).toThrow(/active/i)
      closing = f.owner.close()
      const environment = await original()
      return { ...environment, dispose: () => { disposals++ } }
    })
    const handle = f.start(); await handle.joined; await closing
    expect(disposals).toBe(1)
    expect(f.owner.store.get('joint-root')).toBeUndefined()
    expect(f.requests).toHaveLength(0)
  })

  it('rejects an already revoked preparation environment before planning or approval', async () => {
    const f = setup(), original = f.prepare.getMockImplementation()!, plan = vi.fn(f.facade.prepare)
    f.prepare.mockImplementationOnce(async () => ({ ...await original(), facade: { ...f.facade, prepare: plan } }))
    f.revoked.abort(Error('document is already gone'))
    const handle = f.start(); await handle.joined
    expect(plan).not.toHaveBeenCalled(); expect(f.approvals.list()).toHaveLength(0)
    expect(f.events.listResources().filter(row => ['agent-instance', 'managed-agent-instance-coverage', 'managed-agent-execution-attempt'].includes(row.kind))).toHaveLength(0)
    await expect(handle.result).resolves.toEqual({ status: 'cancelled' })
  })

  it.each(['cancel', 'close', 'provenance', 'stop'] as const)('keeps completion-only authority and the original native join after %s', async action => {
    const f = setup(true, { holdResponse: true }), handle = f.start()
    await f.approve(); await f.approve(); await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    let joined = false, callerResult: unknown
    void handle.result.then(value => { callerResult = value })
    const stopping = action === 'cancel' ? f.owner.service.cancelManagedTextFirstRun('joint-root')
      : action === 'close' ? f.owner.close()
        : action === 'stop' ? f.stop('explicit-stop')
          : (f.revoked.abort(Error('document or config changed')), handle.joined)
    void stopping.then(() => { joined = true })
    await native()
    expect(joined).toBe(false)
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.owner.store.get('joint-root')?.state.status).toBe('running')
    expect(attemptOf(f.events)!.state.status).toBe('open')
    // Caller cancellation is responsive; it is not a terminal receipt or a join.
    expect(callerResult).toEqual({ status: 'cancelled' })
    expect(joined).toBe(false)
    f.requests[0].emit('close'); await stopping; await handle.joined
    expect(joined).toBe(true)
    expect(attemptOf(f.events)!.state.terminal).toMatchObject({ witness: 'producer-closure', status: 'cancelled' })
    expect(f.events.listResources({ kind: 'managed-agent-instance-coverage' })[0]).toMatchObject({ revision: 1, state: { status: 'dirty' } })
    await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('retains the original accepted owner and open attempt after an unqualified upload close, including late native events', async () => {
    const f = setup(true, { holdResponse: true }), handle = f.start()
    await f.approve(); await f.approve(); await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const request = f.requests[0]
    request.emit('close')
    await expect(handle.result).resolves.toMatchObject({ status: 'failed' })
    let joined = false, shutdown = false
    void handle.joined.then(() => { joined = true })
    const closing = f.owner.close().then(() => { shutdown = true }); void closing.catch(() => undefined)
    await native()
    expect(joined).toBe(false); expect(shutdown).toBe(false)
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.owner.store.get('joint-root')?.state.status).toBe('running')
    expect(attemptOf(f.events)!.state).toMatchObject({ status: 'open' })
    expect(attemptOf(f.events)!.state.terminal).toBeUndefined()
    expect(f.events.listResources({ kind: 'managed-agent-instance-coverage' })[0]).toMatchObject({ revision: 1, state: { status: 'dirty' } })
    f.respond(request); request.emit('error', Error('late native callback after upload close')); request.emit('close'); await native()
    expect(joined).toBe(false); expect(shutdown).toBe(false)
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(attemptOf(f.events)!.state.status).toBe('open')
    expect(f.requests).toHaveLength(1); expect(net.fetch).not.toHaveBeenCalled()
  })
  it.each(['throw', 'close-then-throw'] as const)('holds the original owner after native abort failure %s before first close', async when => {
    const f = setup(true, { holdResponse: true }), handle = f.start()
    await f.approve(); await f.approve(); await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const request = f.requests[0]
    request.abort.mockImplementationOnce(() => {
      if (when === 'close-then-throw') request.emit('close')
      throw Error('native abort did not finish')
    })
    let joined = false
    const cancelling = f.owner.service.cancelManagedTextFirstRun('joint-root')
    void cancelling.then(() => { joined = true })
    await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' })
    if (when === 'throw') request.emit('close')
    await native()
    expect(joined).toBe(false); expect(request.abort).toHaveBeenCalledOnce()
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.owner.store.get('joint-root')?.state.status).toBe('running')
    expect(attemptOf(f.events)!.state).toMatchObject({ status: 'open' })
    expect(attemptOf(f.events)!.state.terminal).toBeUndefined()
    request.emit('abort'); request.emit('error', Error('late native error')); request.emit('close'); await native()
    expect(joined).toBe(false); expect(attemptOf(f.events)!.state.status).toBe('open')
    expect(f.events.listResources({ kind: 'managed-agent-instance-coverage' })[0]).toMatchObject({ revision: 1, state: { status: 'dirty' } })
    expect(f.requests).toHaveLength(1); expect(net.fetch).not.toHaveBeenCalled()
  })
  it('returns the caller response before native close without publishing terminal or releasing the owner', async () => {
    const f = setup(), handle = f.start(); await f.approve(); await f.approve()
    await expect(handle.result).resolves.toMatchObject({ status: 'completed', response: { content: 'bounded reply' } })
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.owner.store.get('joint-root')?.state.status).toBe('running')
    expect(attemptOf(f.events)!.state.status).toBe('open')
    expect(() => f.start()).toThrow(/active/i)
    f.requests[0].emit('close'); await handle.joined
    expect(f.owner.service.hasActive('joint-root')).toBe(false)
    expect(attemptOf(f.events)!.state.status).toBe('bounded-closed')
  })

  it('keeps a failed terminal publication on joined even after the caller already received its response', async () => {
    const f = setup(), handle = f.start(); await f.approve(); await f.approve()
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' })
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit' && f.owner.store.get('joint-root')?.state.status === 'stopped') throw Error('late publication failure') })
    f.requests[0].emit('close'); await expect(handle.joined).rejects.toThrow('late publication failure')
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' })
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(attemptOf(f.events)!.state.status).toBe('open')
    _crashTesting.setHook(null); await expect(f.owner.close()).rejects.toThrow('late publication failure')
  })

  it('returns a runtime deadline to the caller without timing out the original native drain', async () => {
    const f = setup(true, { holdResponse: true }), handle = f.start()
    await f.approve(); await f.approve(); await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' })
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(attemptOf(f.events)!.state.status).toBe('open')
    f.requests[0].emit('close'); await handle.joined
    expect(attemptOf(f.events)!.state.terminal).toMatchObject({ status: 'cancelled', witness: 'producer-closure' })
  })

  it('joins the awaited final session write even after the native request has closed', async () => {
    const f = setup(), append = f.sessionStore.appendTurn.bind(f.sessionStore)
    let release!: () => void, entered = false, joined = false
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(f.sessionStore, 'appendTurn').mockImplementation(async (...args) => {
      if (args[1][0]?.role === 'assistant') { entered = true; await pending }
      return append(...args)
    })
    const handle = f.start(); void handle.joined.then(() => { joined = true })
    await f.approve(); await f.approve(); await vi.waitFor(() => expect(entered).toBe(true))
    f.requests[0].emit('close'); await native()
    expect(joined).toBe(false)
    expect(f.owner.store.get('joint-root')?.state.status).toBe('running')
    release(); await handle.joined
    expect(attemptOf(f.events)!.state.terminal?.witness).toBe('producer-closure')
  })

  it('never labels a failed final session write as bounded closure or never-dispatched', async () => {
    const f = setup(), append = f.sessionStore.appendTurn.bind(f.sessionStore)
    const writes = vi.spyOn(f.sessionStore, 'appendTurn').mockImplementationOnce(append).mockRejectedValueOnce(Error('final session write failed'))
    const handle = f.start(); await f.approve(); await f.approve()
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(2))
    f.requests[0].emit('close')
    await expect(handle.joined).rejects.toThrow('final session write failed')
    await expect(handle.result).rejects.toThrow('final session write failed')
    expect(attemptOf(f.events)!.state).toMatchObject({ status: 'open' })
    expect(attemptOf(f.events)!.state.terminal).toBeUndefined()
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    await expect(f.owner.close()).rejects.toThrow('final session write failed')
  })

  it('burns dispatch before a throwing facade call and joins known work without fabricating never-dispatched evidence', async () => {
    const f = setup(), original = f.prepare.getMockImplementation()!
    let release!: () => void, joined = false
    const dispatch = vi.fn((_plan: Parameters<typeof f.facade.start>[0], context: Parameters<typeof f.facade.start>[1]): ReturnType<typeof f.facade.start> => {
      release = context.cooperativeExecution.enter('scheduled-task')
      throw Error('facade threw after dispatch claim')
    })
    f.prepare.mockImplementationOnce(async () => ({ ...await original(), facade: { prepare: (...args) => f.facade.prepare(...args), start: dispatch, consumeClosure: (...args) => f.facade.consumeClosure(...args) } }))
    const handle = f.start(); void handle.joined.catch(() => { joined = true })
    await f.approve(); await f.approve()
    await expect(handle.result).rejects.toThrow('facade threw after dispatch claim'); await native()
    expect(joined).toBe(false); expect(dispatch).toHaveBeenCalledTimes(1)
    expect(attemptOf(f.events)!.state.status).toBe('open')
    expect(attemptOf(f.events)!.state.terminal).toBeUndefined()
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(() => f.start()).toThrow(/active/i)
    release(); await expect(handle.joined).rejects.toThrow('facade threw after dispatch claim')
    await expect(f.owner.close()).rejects.toThrow('facade threw after dispatch claim')
  })

  it.each(['before', 'after'] as const)('retains a faulted owner when COMMIT throws %s performing the accepted-start write', async when => {
    const f = setup(), adapter = adapterOf(f.events), exec = adapter.exec.bind(adapter)
    const handle = f.start(); await f.approve(); await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    vi.spyOn(adapter, 'exec').mockImplementation(sql => {
      if (sql === 'COMMIT' && f.owner.store.get('joint-root')?.state.status === 'running') {
        if (when === 'after') exec(sql)
        throw Error('COMMIT disposition ambiguous')
      }
      exec(sql)
    })
    await f.approve(); await expect(handle.joined).rejects.toThrow('COMMIT disposition ambiguous')
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.owner.store.get('joint-root')?.state.status).toBe(when === 'after' ? 'running' : 'created')
    expect(f.requests).toHaveLength(0); expect(() => f.start()).toThrow(/active/i)
    await expect(f.owner.close()).rejects.toThrow('COMMIT disposition ambiguous')
  })

  it('does not infer a definite rollback when ROLLBACK throws despite absent-looking accepted resources', async () => {
    const f = setup(), adapter = adapterOf(f.events), exec = adapter.exec.bind(adapter)
    const handle = f.start(); await f.approve(); await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    vi.spyOn(adapter, 'exec').mockImplementation(sql => { exec(sql); if (sql === 'ROLLBACK') throw Error('rollback acknowledgement lost') })
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit' && f.owner.store.get('joint-root')?.state.status === 'running') throw Error('before-COMMIT staged failure') })
    await f.approve(); await expect(handle.joined).rejects.toThrow('before-COMMIT staged failure')
    expect(f.owner.store.get('joint-root')?.state.status).toBe('created')
    expect(attemptOf(f.events)).toBeUndefined()
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.requests).toHaveLength(0)
    await expect(f.owner.close()).rejects.toThrow('before-COMMIT staged failure')
  })

  it.each(['resource.before-commit', 'resource.after-commit'] as const)('burns the sole terminal publication slot after failure at %s', async failureStage => {
    const f = setup(), handle = f.start(); await f.approve(); await f.approve()
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    let attempts = 0
    _crashTesting.setHook(stage => {
      if (stage === failureStage && f.owner.store.get('joint-root')?.state.status === 'stopped') {
        attempts++; throw Error('terminal publication failed')
      }
    })
    f.requests[0].emit('close'); await expect(handle.joined).rejects.toThrow('terminal publication failed')
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.owner.store.get('joint-root')?.state.status).toBe(failureStage === 'resource.before-commit' ? 'running' : 'stopped')
    expect(attemptOf(f.events)!.state.status).toBe(failureStage === 'resource.before-commit' ? 'open' : 'bounded-closed')
    _crashTesting.setHook(null)
    await expect(f.owner.close()).rejects.toThrow('terminal publication failed')
    expect(attempts).toBe(1)
    expect(() => f.start()).toThrow(/closing|active/i)
  })

  it('keeps bounded attempts outside legacy runtime binding, intent, outcome and replay shortcuts', async () => {
    const f = setup(true, { holdResponse: true }), handle = f.start()
    await f.approve(); await f.approve(); await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const ledger = new PersistentManagedAgentExecutionStore(f.events), identity = attemptOf(f.events)!.state.identity
    const rejectLedger = () => {
      expect(() => ledger.bindRuntime({ identity, expectedRevision: 0, binding: { runtimeRunId: 'joint-run', effectiveRequestDigest: 'a'.repeat(64) }, recordedAt: 1 })).toThrow(/bounded/i)
      expect(() => ledger.recordIntent({ identity, expectedRevision: 0, intent: { invocationId: 'tool', runtimeRunId: 'joint-run', toolName: 'not-allowed', argsDigest: 'a'.repeat(64) }, recordedAt: 1 })).toThrow(/bounded/i)
      expect(() => ledger.recordOutcome({ identity, expectedRevision: 0, invocationId: 'tool', outcome: { kind: 'unknown', resultDigest: 'a'.repeat(64) }, recordedAt: 1 })).toThrow(/bounded/i)
      expect(() => ledger.getIntent(identity, 'tool')).toThrow(/bounded/i)
    }
    rejectLedger(); f.respond(f.requests[0]); await expect(handle.result).resolves.toMatchObject({ status: 'completed' }); f.requests[0].emit('close'); await handle.joined; rejectLedger()
    expect(f.events.listResources({ kind: 'managed-agent-execution-intent' })).toHaveLength(0)
  })

  it('authorizes stop against the exact preparing owner before any persisted instance exists', async () => {
    const f = setup(), original = f.prepare.getMockImplementation()!
    let finish!: (value: ManagedFirstRunEnvironment) => void
    f.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const handle = f.start()
    let stopped = false
    const stopping = f.stop('prebirth-stop').then(() => { stopped = true })
    await native(); expect(stopped).toBe(false)
    finish(await original()); await stopping; await handle.joined
    expect(f.owner.store.get('joint-root')).toBeUndefined(); expect(f.requests).toHaveLength(0)
    await expect(handle.result).resolves.toEqual({ status: 'cancelled' })
    await expect(f.owner.service.stop({ instanceId: 'joint-root', expectedRevision: 0, actor: { kind: 'user', id: 'desktop-user' }, idempotencyKey: 'inactive-stop' })).rejects.toThrow(/not found/i)
  })

  it('rejects unauthorized managed stop without revoking the active owner or dispatch permission', async () => {
    const f = setup(), handle = f.start()
    await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    await expect(f.owner.service.stop({ instanceId: 'joint-root', expectedRevision: 0, actor: { kind: 'agent', id: 'not-a-user' }, idempotencyKey: 'untrusted-stop' })).rejects.toThrow(/stop.*denied/i)
    expect(f.approvals.list()).toHaveLength(1); expect(f.owner.service.hasActive('joint-root')).toBe(true)
    await f.approve(false); await handle.joined
  })

  it.each([true, false])('does not transfer a prior prebirth stop approval to a replacement owner (consumed=%s)', async consumed => {
    const f = setup(), original = f.prepare.getMockImplementation()!
    let release!: (value: ManagedFirstRunEnvironment) => void
    f.prepare.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = f.start()
    const request = f.owner.service.prepareManagedTextFirstRunStop({ actor: { kind: 'user', id: 'desktop-user' }, instanceId: 'joint-root' })
    const approval = f.approvals.request(request); await f.approve(); const grant = await approval
    const command = { instanceId: 'joint-root', expectedRevision: 0, actor: request.actor, idempotencyKey: 'old-prebirth-stop', grantId: grant.grantId, expectedGrantUseCount: grant.expectedGrantUseCount }
    const stopping = consumed ? f.owner.service.stop(command) : f.owner.service.cancelManagedTextFirstRun('joint-root')
    release(await original()); await stopping; await first.joined
    const next = f.start(); await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    expect(request.input.ownerEpoch).not.toBe(f.owner.service.prepareManagedTextFirstRunStop({ actor: request.actor, instanceId: 'joint-root' }).input.ownerEpoch)
    await expect(f.owner.service.stop(command)).rejects.toThrow(/already-consumed|approval|conflict|owner|denied/i)
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    expect(f.approvals.list()).toHaveLength(1)
    await f.approve(false); await next.joined
  })

  it('bounds original pending owners before preparation and retains their slots until late preparation joins', async () => {
    const f = setup(), original = f.prepare.getMockImplementation()!
    let release!: (value: ManagedFirstRunEnvironment) => void
    const pending = new Promise<ManagedFirstRunEnvironment>(resolve => { release = resolve })
    f.prepare.mockImplementation(() => pending)
    const handles = [f.start(), ...Array.from({ length: 31 }, (_, index) => f.owner.service.startManagedTextFirstRun({ ...intent(), instanceId: `bounded-owner-${index}` }))]
    expect(f.prepare).toHaveBeenCalledTimes(32)
    expect(() => f.owner.service.startManagedTextFirstRun({ ...intent(), instanceId: 'over-capacity' })).toThrow(/capacity/i)
    expect(f.prepare).toHaveBeenCalledTimes(32)
    const late = await original()
    const closing = f.owner.close()
    await Promise.all(handles.map(handle => expect(handle.result).resolves.toEqual({ status: 'cancelled' })))
    expect(f.owner.service.hasActive('joint-root')).toBe(true)
    release(late); await closing; await Promise.all(handles.map(handle => handle.joined))
    expect(f.owner.service.hasActive('joint-root')).toBe(false)
    expect(f.requests).toHaveLength(0)
  })

  it('rejects a precommit substitution of the policy-approved private session identity', async () => {
    const original = PersistentManagedAgentInstanceStore.prototype.startFirstAttempt
    vi.spyOn(PersistentManagedAgentInstanceStore.prototype, 'startFirstAttempt').mockImplementation(function (this: PersistentManagedAgentInstanceStore, input, state) {
      return original.call(this, { ...input, sessionKey: 'generic:dm:unapproved-session' }, state)
    })
    const f = setup(), handle = f.start(); await f.approve(); await f.approve(); await native()
    expect(f.requests).toHaveLength(0)
    await handle.joined
    expect(attemptOf(f.events)).toBeUndefined()
    expect(f.owner.store.get('joint-root')?.state.status).toBe('removed')
  })

  it('never commits a terminal pair while a precommit callout has registered more original-root work', async () => {
    const f = setup(), original = f.prepare.getMockImplementation()!
    let context!: Parameters<typeof f.facade.start>[1], release!: () => void, joined = false
    f.prepare.mockImplementationOnce(async () => ({ ...await original(), facade: {
      prepare: (...args) => f.facade.prepare(...args),
      start: (...args) => { context = args[1]; return f.facade.start(...args) },
      consumeClosure: (...args) => f.facade.consumeClosure(...args)
    } }))
    const handle = f.start(); void handle.joined.then(() => { joined = true }, () => { joined = true })
    await f.approve(); await f.approve(); await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    _crashTesting.setHook(stage => {
      if (stage === 'resource.before-commit' && f.owner.store.get('joint-root')?.state.status === 'stopped') release = context.cooperativeExecution.enter('scheduled-task')
    })
    f.requests[0].emit('close'); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(f.owner.store.get('joint-root')?.state.status).toBe('running')
    expect(attemptOf(f.events)!.state.status).toBe('open')
    expect(joined).toBe(false)
    release(); await expect(handle.joined).rejects.toThrow(/owner|quiescen|commit/i)
    _crashTesting.setHook(null); await expect(f.owner.close()).rejects.toThrow(/owner|quiescen|commit/i)
  })

  it('rejects a direct terminal read when the dirty coverage snapshot differs from its accepted mutation receipt', async () => {
    const f = setup(), handle = f.start(); await f.approve(); await f.approve(); await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    f.requests[0].emit('close'); await handle.joined
    const coverage = f.events.listResources({ kind: 'managed-agent-instance-coverage' })[0]
    adapterOf(f.events).prepare('UPDATE resources SET state_json = ? WHERE resource_kind = ? AND resource_id = ?').run(JSON.stringify({ ...coverage.state as object, birthStateDigest: '0'.repeat(64) }), coverage.kind, coverage.id)
    expect(() => new PersistentManagedAgentExecutionStore(f.events).getAttempt(attemptOf(f.events)!.state.identity)).toThrow(/corrupt|receipt|coverage|evidence|mutation/i)
  })

  it('keeps the exact faulted owner after post-COMMIT failure with no dispatch, replay, retry or adoption', async () => {
    const f = setup(), handle = f.start(); await f.approve(); await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    _crashTesting.setHook(stage => { if (stage === 'resource.after-commit' && f.owner.store.get('joint-root')?.state.status === 'running') throw Error('uncertain acceptance publication') })
    await f.approve(); await expect(handle.joined).rejects.toThrow('uncertain acceptance publication'); await expect(handle.result).rejects.toThrow('uncertain acceptance publication')
    expect(f.owner.service.hasActive('joint-root')).toBe(true); expect(f.owner.store.get('joint-root')?.state.status).toBe('running'); expect(f.requests).toHaveLength(0); expect(() => f.start()).toThrow(/active|owned|already/i)
    _crashTesting.setHook(null); await expect(f.owner.close()).rejects.toThrow('uncertain acceptance publication')
  })
})
