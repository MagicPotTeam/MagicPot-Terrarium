import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { MagicAgentInstanceState } from '@shared/magicAgentPlatform2/agentInstance'
import type { AssistantInboundMessage } from './types'
import type { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
const { dataRoot } = vi.hoisted(() => ({ dataRoot: { current: process.cwd() } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: dataRoot.current } }) }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => process.cwd() }, BrowserWindow: class {}, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined), getMcpClientManager: () => ({ listToolsSnapshot: () => [] }) }))
import { AssistantRuntime } from './runtime'
import { AssistantSessionStore } from './sessionStore'
import { assertKnownAssistantToolOutcomes, ASSISTANT_TOOL_OUTCOME_UNKNOWN } from './toolRecovery'
import { AssistantToolRegistry } from './toolRegistry'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { _crashTesting } from '../magicAgentPlatform2/persistence/crashHooks'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { PersistentManagedAgentInstanceStore } from '../magicAgentPlatform2/agents/persistentManagedAgentInstanceStore'
import { PersistentManagedAgentExecutionStore } from '../magicAgentPlatform2/agents/persistentManagedAgentExecutionStore'
import { ManagedRuntimeRecording, type ManagedRuntimeTicket } from '../magicAgentPlatform2/agents/managedRuntimeRecording'
import type { ManagedAssociationOwner, ManagedAssistantIngress } from '../magicAgentPlatform2/agents/managedAgentExecutionAssociation'

const cleanups: Array<() => Promise<void>> = []
const route = { channel: 'generic', scopeType: 'dm', scopeId: 'managed-actual-runtime' } as const
const ingress = (text = 'fixture chat'): ManagedAssistantIngress => ({ route: { ...route, senderId: undefined }, text, execution: { allowedToolNames: ['fixture.effect'], maxToolCalls: 2 } })
const command = { instanceId: 'root', expectedRevision: 0, expectedCoverageRevision: 0, authorizedRequestDigest: 'a'.repeat(64), startedAt: 2, idempotencyKey: 'first' }
const failure = /managed|recording|association|ticket|lease|owner|binding|revision|intent|unknown|closed|plain|fields|accessor|replay|call|runtime|scripted/i
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const tick = async () => { for (let i = 0; i < 48; i++) await Promise.resolve() }
type ChatOptions = NonNullable<Parameters<LLMProxySvcImpl['chat']>[1]>
async function setup() {
  const dir = await createNodeTestArtifactDir('managed-actual-runtime-recording'); dataRoot.current = dir
  const events = new MagicAgentEventStore(':memory:'), managed = new PersistentManagedAgentInstanceStore(events), ledger = new PersistentManagedAgentExecutionStore(events)
  const owner: ManagedAssociationOwner = { controller: new AbortController(), cooperativeExecution: new CooperativeExecutionController(), phase: 'running', stopRequested: false }
  const ownership = { active: new Map([['root', owner]]), closing: false }, recording = new ManagedRuntimeRecording(events, ownership)
  const state: MagicAgentInstanceState = { id: 'root', name: 'root', definitionId: 'fixture', configVersion: 'v1', depth: 0, status: 'created', limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 10000, allowedToolNames: ['fixture.effect'], workspaceRoots: [] } }
  managed.createRoot({ instance: state, createdAt: 1, idempotencyKey: 'birth' })
  const config: Config = structuredClone(DEFAULT_CONFIG); config.chat_config = { ...config.chat_config, enable: true, profile_id: 'local-script', system_prompt: 'fixed base', max_history_messages: 4 }
  const configProvider = vi.fn(() => config), session = new AssistantSessionStore(path.join(dir, 'owned-sessions.json'))
  const tool = vi.fn(async (_name: string, _args: Record<string, unknown>, _context?: unknown) => ({ content: 'local effect receipt' })), provider = { listTools: () => [{ name: 'fixture.effect', description: 'local fixture', inputSchema: { type: 'object' } }], callTool: tool }
  const chat = vi.fn(async (_req: unknown, _options?: ChatOptions) => ({ content: 'local scripted reply' }))
  const runtime = new AssistantRuntime({ sessionStore: session, configProvider, chatService: { chat }, toolRegistry: { listTools: () => [] } as unknown as AssistantToolRegistry, managedRecording: recording } as ConstructorParameters<typeof AssistantRuntime>[0])
  const request = (data: ManagedAssistantIngress): AssistantInboundMessage => ({ ...data, signal: owner.controller.signal, cooperativeExecution: owner.cooperativeExecution, toolProvider: provider })
  const begin = (data = ingress()) => recording.begin(command, owner, data)
  const run = (ticket: ManagedRuntimeTicket, data = ingress()) => (runtime.handleMessage as (req: AssistantInboundMessage, options: { ticket: ManagedRuntimeTicket }) => ReturnType<AssistantRuntime['handleMessage']>)(request(data), { ticket })
  const attempt = () => { const identity = managed.getCoverage('root')!.state.accepted!.identity; return ledger.getAttempt(identity)! }
  const result = { dir, events, managed, ledger, owner, ownership, recording, config, configProvider, session, tool, provider, chat, runtime, request, begin, run, attempt }
  cleanups.push(async () => { recording.close(); await session.flush(); events.close(); await fs.rm(dir, { recursive: true, force: true }) }); return result
}
afterEach(async () => { _crashTesting.setHook(null); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); dataRoot.current = process.cwd() })
function contains(root: unknown, target: unknown, seen = new Set<object>()): boolean { if (root === target) return true; if (!root || typeof root !== 'object' || seen.has(root)) return false; seen.add(root); return Reflect.ownKeys(root).some(key => { const d = Object.getOwnPropertyDescriptor(root, key); return d && 'value' in d && contains(d.value, target, seen) }) }

describe('direct actual runtime recording with scripted chat, not production transport or admission', () => {
  it('records actual UUID before first config callback and pins one config snapshot through execution', async () => {
    const f = await setup(), ticket = f.begin(); let observedRunId = ''
    f.configProvider.mockImplementation(() => { const records = f.events.listResources({ kind: 'managed-runtime-ingress' }); expect(records).toHaveLength(1); observedRunId = (records[0].state as { runtimeRunId: string }).runtimeRunId; return f.config })
    const result = await f.run(ticket)
    expect(result.runId).toBe(observedRunId); expect(result.status).toBe('completed'); expect(f.configProvider).toHaveBeenCalledOnce()
    expect(f.attempt().state.binding).toMatchObject({ bindingVersion: 2, runtimeRunId: result.runId, executorInputProtocol: 'assistant-executor-input/v1' }); expect(f.attempt().state.binding).not.toHaveProperty('effectiveRequestDigest')
    expect(f.managed.getCoverage('root')?.state.status).toBe('dirty'); expect(f.attempt().revision).toBe(1); expect(f.tool).not.toHaveBeenCalled()
  })
  it.each(['slash', 'chat'] as const)('records mandatory intent and result on actual %s path before journal/provider', async mode => {
    const f = await setup(), data = ingress(mode === 'slash' ? '/tool fixture.effect {"x":1}' : undefined), ticket = f.begin(data), append = f.session.appendEvents.bind(f.session)
    vi.spyOn(f.session, 'appendEvents').mockImplementation(async (...args) => { if ((args[1][0]?.metadata?.agentAction as { type?: string })?.type === 'tool.invoke') expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 1 }); return append(...args) })
    f.tool.mockImplementation(async () => { expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 1 }); return { content: 'recorded local receipt' } })
    if (mode === 'chat') f.chat.mockImplementation(async (_req, options) => { await options!.executeTool!({ toolName: 'fixture.effect', args: { x: 1 }, runId: options!.runId!, toolCallId: 'call-one' }); return { content: 'after recorded call' } })
    await f.run(ticket, data); expect(f.tool).toHaveBeenCalledOnce(); expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 0, unknownIntents: 0 }); expect(f.attempt().revision).toBe(3)
    expect(f.managed.getCoverage('root')?.state.status).toBe('dirty')
  })
  it.each(['copy', 'otherRuntime', 'replacedOwner', 'aborted', 'gateSwap', 'signalSwap', 'ingressChange', 'continue', 'resume'] as const)('refuses %s before preparation and burns recognized tickets', async kind => {
    const f = await setup(), data = ingress(), ticket = f.begin(data), req = f.request(data); let target = f.runtime, passed = ticket
    if (kind === 'copy') passed = { ...ticket } as ManagedRuntimeTicket
    if (kind === 'otherRuntime') target = new AssistantRuntime({ chatService: { chat: f.chat }, configProvider: f.configProvider, sessionStore: f.session })
    if (kind === 'replacedOwner') f.ownership.active.set('root', { ...f.owner })
    if (kind === 'aborted') f.owner.controller.abort(Error('stopped'))
    if (kind === 'gateSwap') req.cooperativeExecution = new CooperativeExecutionController()
    if (kind === 'signalSwap') req.signal = new AbortController().signal
    if (kind === 'ingressChange') req.text = 'substituted'
    if (kind === 'continue') req.continueFromRunId = 'prior'
    if (kind === 'resume') req.resumeFromRunId = 'prior'
    await expect(target.handleMessage(req, { ticket: passed })).rejects.toThrow(failure)
    expect(f.configProvider).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.tool).not.toHaveBeenCalled()
  })
  it('refuses managed submit before prep instead of silently dropping the ticket', async () => {
    const f = await setup(), ticket = f.begin()
    await expect((f.runtime.submitMessage as (req: AssistantInboundMessage, opts: { ticket: ManagedRuntimeTicket }) => Promise<unknown>)(f.request(ingress()), { ticket })).rejects.toThrow(failure); expect(f.configProvider).not.toHaveBeenCalled()
  })
  it('one ticket cannot rerun after completion or be claimed reentrantly by config', async () => {
    const f = await setup(), ticket = f.begin(); let nested: Promise<unknown> | undefined
    f.configProvider.mockImplementation(() => { nested = f.run(ticket).catch(error => error); return f.config })
    await f.run(ticket); expect(await nested).toBeInstanceOf(Error); await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.chat).toHaveBeenCalledOnce()
  })
  it.each(['resource.before-commit', 'resource.after-commit'] as const)('burns early ingress %s ambiguity before config or execution', async stage => {
    const f = await setup(), ticket = f.begin(); _crashTesting.setHook(current => { if (current === stage) throw Error('early ingress fixture failure') })
    await expect(f.run(ticket)).rejects.toThrow('early ingress fixture failure'); _crashTesting.setHook(null)
    expect(f.configProvider).not.toHaveBeenCalled(); await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.events.listResources({ kind: 'managed-runtime-ingress' })).toHaveLength(stage === 'resource.before-commit' ? 0 : 1); expect(f.attempt().revision).toBe(0)
  })
  it.each(['resource.before-commit', 'resource.after-commit'] as const)('intent %s failure causes zero dispatch and no replay permission', async stage => {
    const f = await setup(), data = ingress('/tool fixture.effect {}'), ticket = f.begin(data)
    const mutate = f.events.mutateResourcesBatch.bind(f.events)
    vi.spyOn(f.events, 'mutateResourcesBatch').mockImplementation((inputs, fence) => { const intent = inputs.some(input => input.kind === 'managed-agent-execution-intent'); if (intent) _crashTesting.setHook(current => { if (current === stage) throw Error('mandatory intent failure') }); try { return mutate(inputs, fence) } finally { _crashTesting.setHook(null) } })
    await expect(f.run(ticket, data)).rejects.toThrow('mandatory intent failure'); expect(f.tool).not.toHaveBeenCalled(); await expect(f.run(ticket, data)).rejects.toThrow(failure)
    expect(f.attempt().state.totalIntents).toBe(stage === 'resource.before-commit' ? 0 : 1)
  })
  it('rejects forged chat runtime ID without dispatch', async () => {
    const f = await setup(), ticket = f.begin()
    f.chat.mockImplementation(async (_req, options) => { await options!.executeTool!({ toolName: 'fixture.effect', args: {}, runId: 'foreign', toolCallId: 'call' }); return { content: 'not reached' } })
    await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0)
  })
  it('post-dispatch throw is sticky unknown and cannot publish a late successful outcome', async () => {
    const f = await setup(), data = ingress('/tool fixture.effect {}'), ticket = f.begin(data); f.tool.mockRejectedValue(Error('effect may have happened'))
    await expect(f.run(ticket, data)).rejects.toThrow('effect may have happened'); expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 0, unknownIntents: 1, reviewRequired: true }); expect(f.tool).toHaveBeenCalledOnce()
  })
  it('unknown marker in an apparently successful receipt remains unknown', async () => {
    const f = await setup(), data = ingress('/tool fixture.effect {}'), ticket = f.begin(data)
    f.tool.mockResolvedValue({ content: 'not known', metadata: { ok: true, error: { code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' } } } as Awaited<ReturnType<typeof f.tool>>)
    await expect(f.run(ticket, data)).rejects.toThrow(failure); expect(f.attempt().state.unknownIntents).toBe(1)
  })
  it('responsive caller abort retains the abort-ignoring actual invocation until it settles', async () => {
    const f = await setup(), data = ingress('/tool fixture.effect {}'), ticket = f.begin(data), entered = deferred<void>(), raw = deferred<{ content: string }>()
    f.tool.mockImplementation(async () => { entered.resolve(); return raw.promise })
    const pending = f.run(ticket, data), observed = pending.catch(error => error)
    try { await entered.promise; f.owner.controller.abort(Error('user cancelled')); await observed; expect(f.attempt().state.unknownIntents).toBe(1); expect(f.owner.cooperativeExecution.isQuiescent()).toBe(false); raw.resolve({ content: 'late' }); await f.owner.cooperativeExecution.whenQuiescent(); expect(f.attempt().state.unknownIntents).toBe(1) }
    finally { raw.resolve({ content: 'cleanup' }); await observed; await tick() }
  })
  it.each(['resource.before-commit', 'resource.after-commit'] as const)('V2 binding %s ambiguity never reaches model/tool and cannot rerun', async stage => {
    const f = await setup(), data = ingress('/tool fixture.effect {}'), ticket = f.begin(data), mutate = f.events.mutateResourcesBatch.bind(f.events)
    vi.spyOn(f.events, 'mutateResourcesBatch').mockImplementation((inputs, fence) => {
      if (inputs.some(input => input.kind === 'managed-agent-execution-attempt' && (input.state as { binding?: unknown }).binding)) _crashTesting.setHook(current => { if (current === stage) throw Error('executor binding fixture failure') })
      try { return mutate(inputs, fence) } finally { _crashTesting.setHook(null) }
    })
    await expect(f.run(ticket, data)).rejects.toThrow('executor binding fixture failure'); expect(f.tool).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.attempt().revision).toBe(stage === 'resource.before-commit' ? 0 : 1); await expect(f.run(ticket, data)).rejects.toThrow(failure)
  })
  it.each(['resource.before-commit', 'resource.after-commit'] as const)('outcome %s ambiguity preserves actual durable state with exactly one publication and effect', async stage => {
    const f = await setup(), data = ingress('/tool fixture.effect {}'), ticket = f.begin(data), mutate = f.events.mutateResourcesBatch.bind(f.events); let outcomeAttempts = 0
    vi.spyOn(f.events, 'mutateResourcesBatch').mockImplementation((inputs, fence) => {
      if (inputs.some(input => input.kind === 'managed-agent-execution-intent' && (input.state as { status: string }).status !== 'pending')) { outcomeAttempts++; _crashTesting.setHook(current => { if (current === stage) throw Error('outcome publication fixture failure') }) }
      try { return mutate(inputs, fence) } finally { _crashTesting.setHook(null) }
    })
    await expect(f.run(ticket, data)).rejects.toThrow('outcome publication fixture failure'); expect(f.tool).toHaveBeenCalledOnce(); expect(outcomeAttempts).toBe(1)
    expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: stage === 'resource.before-commit' ? 1 : 0, unknownIntents: 0 }); await expect(f.run(ticket, data)).rejects.toThrow(failure); expect(outcomeAttempts).toBe(1)
  })
  it('failed unknown publication cannot be followed by success or another chat invocation', async () => {
    const f = await setup(), ticket = f.begin(), mutate = f.events.mutateResourcesBatch.bind(f.events); let publications = 0
    f.tool.mockRejectedValue(Error('effect unknown'))
    vi.spyOn(f.events, 'mutateResourcesBatch').mockImplementation((inputs, fence) => {
      if (inputs.some(input => input.kind === 'managed-agent-execution-intent' && (input.state as { status: string }).status === 'unknown')) { publications++; _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') throw Error('unknown publication fixture failure') }) }
      try { return mutate(inputs, fence) } finally { _crashTesting.setHook(null) }
    })
    f.chat.mockImplementation(async (_req, options) => {
      await expect(options!.executeTool!({ toolName: 'fixture.effect', args: {}, runId: options!.runId!, toolCallId: 'first' })).rejects.toThrow('unknown publication fixture failure')
      f.tool.mockResolvedValue({ content: 'would be success' })
      await expect(options!.executeTool!({ toolName: 'fixture.effect', args: {}, runId: options!.runId!, toolCallId: 'second' })).rejects.toThrow(failure)
      return { content: 'script caught failures' }
    })
    await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.tool).toHaveBeenCalledOnce(); expect(publications).toBe(1); expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 1, unknownIntents: 0 })
  })
  it('chat cannot convert an unknown outcome into a successful completed runtime result', async () => {
    const f = await setup(), ticket = f.begin(); f.tool.mockRejectedValue(Error('effect unknown'))
    f.chat.mockImplementation(async (_req, options) => { await options!.executeTool!({ toolName: 'fixture.effect', args: {}, runId: options!.runId!, toolCallId: 'first' }).catch(() => undefined); return { content: 'pretend successful reply' } })
    await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.attempt().state.unknownIntents).toBe(1)
  })
  it.each(['sequential', 'parallel'] as const)('distinct %s invocations have exact monotonic paired receipts and counters', async mode => {
    const f = await setup(), ticket = f.begin()
    f.chat.mockImplementation(async (_req, options) => {
      const call = (id: string) => options!.executeTool!({ toolName: 'fixture.effect', args: { id }, runId: options!.runId!, toolCallId: id })
      if (mode === 'sequential') { await call('one'); await call('two') } else await Promise.all([call('one'), call('two')])
      return { content: 'two recorded tools' }
    })
    await f.run(ticket); expect(f.tool).toHaveBeenCalledTimes(2); expect(f.attempt().state).toMatchObject({ totalIntents: 2, pendingIntents: 0, unknownIntents: 0 }); expect(f.attempt().revision).toBe(5)
  })
  it('reused call ID with changed args is rejected after the first effect and cannot be hidden by chat', async () => {
    const f = await setup(), ticket = f.begin()
    f.chat.mockImplementation(async (_req, options) => {
      await options!.executeTool!({ toolName: 'fixture.effect', args: { value: 1 }, runId: options!.runId!, toolCallId: 'reused' })
      await expect(options!.executeTool!({ toolName: 'fixture.effect', args: { value: 2 }, runId: options!.runId!, toolCallId: 'reused' })).rejects.toThrow(failure)
      return { content: 'caught replay rejection' }
    })
    await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.tool).toHaveBeenCalledOnce(); expect(f.attempt().state.totalIntents).toBe(1)
  })
  it('provider catalog callout may stop owner, but no tool dispatch follows', async () => {
    const f = await setup(), data = ingress('/tool fixture.effect {}'), ticket = f.begin(data)
    vi.spyOn(f.provider, 'listTools').mockImplementation(() => { f.owner.phase = 'finishing'; return [{ name: 'fixture.effect', description: 'fixture', inputSchema: { type: 'object' } }] })
    await expect(f.run(ticket, data)).rejects.toThrow(failure); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 0, unknownIntents: 0 })
  })
  it('second catalog callout revoking owner prevents chat dispatch, not only terminal success', async () => {
    const f = await setup(), ticket = f.begin(); let catalogReads = 0
    vi.spyOn(f.provider, 'listTools').mockImplementation(() => {
      catalogReads++
      if (catalogReads === 2) f.owner.phase = 'finishing'
      return [{ name: 'fixture.effect', description: 'fixture', inputSchema: { type: 'object' } }]
    })
    await expect(f.run(ticket)).rejects.toThrow(failure); expect(catalogReads).toBe(2); expect(f.chat).not.toHaveBeenCalled(); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0)
  })
  it('freezes captured actions before journal callout so mutation cannot alter dispatched arguments', async () => {
    const f = await setup(), data = ingress('/tool fixture.effect {"value":1}'), ticket = f.begin(data), append = f.session.appendEvents.bind(f.session); let mutationRefused = false
    vi.spyOn(f.session, 'appendEvents').mockImplementation(async (...args) => {
      const action = args[1][0]?.metadata?.agentAction as { type?: string; payload?: { args?: Record<string, unknown> } }
      if (action?.type === 'tool.invoke') { try { action.payload!.args!.value = 999 } catch { mutationRefused = true } }
      return append(...args)
    })
    await f.run(ticket, data); expect(mutationRefused).toBe(true); expect(f.tool.mock.calls[0]?.[1]).toEqual({ value: 1 })
  })
  it.each(['accessor', 'proxy', 'cyclic'] as const)('rejects unsupported %s config after early association but before preparation/model', async kind => {
    const f = await setup(), ticket = f.begin(); let getterCalls = 0
    if (kind === 'accessor') Object.defineProperty(f.config, 'unsafe', { enumerable: true, get() { getterCalls++; return 'not read' } })
    if (kind === 'cyclic') Object.assign(f.config, { unsafe: f.config })
    if (kind === 'proxy') f.configProvider.mockReturnValue(new Proxy(f.config, {}))
    await expect(f.run(ticket)).rejects.toThrow(failure); expect(getterCalls).toBe(0); expect(f.chat).not.toHaveBeenCalled(); expect(f.tool).not.toHaveBeenCalled(); expect(f.events.listResources({ kind: 'managed-runtime-ingress' })).toHaveLength(1); expect(f.attempt().revision).toBe(0)
  })
  it('plain caller config mutation during preparation cannot change the admitted executor snapshot', async () => {
    const f = await setup(), ticket = f.begin(), upsert = f.session.upsertRun.bind(f.session)
    vi.spyOn(f.session, 'upsertRun').mockImplementation(async (...args) => { f.config.chat_config.system_prompt = 'substituted later'; return upsert(...args) })
    await f.run(ticket); const req = f.chat.mock.calls[0]?.[0] as { systemPrompt: string }; expect(req.systemPrompt).toContain('fixed base'); expect(req.systemPrompt).not.toContain('substituted later'); expect(f.configProvider).toHaveBeenCalledOnce()
  })
  it('refuses missing options and standalone callTool on the configured runtime before config', async () => {
    const f = await setup(); await expect(f.runtime.handleMessage(f.request(ingress()))).rejects.toThrow(failure); await expect(f.runtime.callTool(route, 'fixture.effect', {})).rejects.toThrow(failure); expect(f.configProvider).not.toHaveBeenCalled(); expect(f.tool).not.toHaveBeenCalled()
  })
  it('unconfigured runtime preserves ordinary UUID allocation after asynchronous preparation and two config reads', async () => {
    const f = await setup(), runtime = new AssistantRuntime({ chatService: { chat: f.chat }, configProvider: f.configProvider, sessionStore: f.session, toolRegistry: { listTools: () => [] } as unknown as AssistantToolRegistry })
    const prepared = deferred<void>(), release = deferred<void>(), prepare = (runtime as unknown as { prepareSession: (...args: unknown[]) => Promise<unknown> }).prepareSession.bind(runtime)
    vi.spyOn(runtime as unknown as { prepareSession: (...args: unknown[]) => Promise<unknown> }, 'prepareSession').mockImplementation(async (...args) => { const value = await prepare(...args); prepared.resolve(); await release.promise; return value })
    const uuid = vi.spyOn(crypto, 'randomUUID'), req = f.request(ingress()), running = runtime.handleMessage(req)
    try { await prepared.promise; expect(uuid).not.toHaveBeenCalled(); release.resolve(); await running; expect(uuid).toHaveBeenCalled(); expect(f.configProvider).toHaveBeenCalledTimes(2); expect(f.events.listResources({ kind: 'managed-runtime-ingress' })).toHaveLength(0) }
    finally { release.resolve(); await running.catch(() => undefined) }
  })
  it('same-store ingress receipt read reentrancy cannot claim the ticket a second time', async () => {
    const f = await setup(), ticket = f.begin(), get = f.events.getResource.bind(f.events); let nested: Promise<unknown> | undefined
    vi.spyOn(f.events, 'getResource').mockImplementation((...args) => { if (!nested) { nested = Promise.resolve(); nested = f.run(ticket).catch(error => error) } return get(...args) })
    await f.run(ticket); expect(await nested).toBeInstanceOf(Error); expect(f.configProvider).toHaveBeenCalledOnce(); expect(f.chat).toHaveBeenCalledOnce(); expect(f.events.listResources({ kind: 'managed-runtime-ingress' })).toHaveLength(1)
  })
  it.each(['removed', 'finishing', 'faulted', 'stopRequested', 'closing', 'closed', 'storeClosed'] as const)('refuses %s owner/epoch/store before any config preparation', async kind => {
    const f = await setup(), ticket = f.begin()
    if (kind === 'removed') f.ownership.active.delete('root')
    if (kind === 'finishing' || kind === 'faulted') f.owner.phase = kind
    if (kind === 'stopRequested') f.owner.stopRequested = true
    if (kind === 'closing') f.ownership.closing = true
    if (kind === 'closed') f.recording.close()
    if (kind === 'storeClosed') f.events.close()
    await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.configProvider).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.tool).not.toHaveBeenCalled()
  })
  it('requires a distinct fixture coordinator to reject another coordinator ticket without ordinary fallback', async () => {
    const f = await setup(), ticket = f.begin(), recording = new ManagedRuntimeRecording(f.events, f.ownership)
    const runtime = new AssistantRuntime({ managedRecording: recording, chatService: { chat: f.chat }, configProvider: f.configProvider, sessionStore: f.session, toolRegistry: { listTools: () => [] } as unknown as AssistantToolRegistry })
    try { await expect(runtime.handleMessage(f.request(ingress()), { ticket })).rejects.toThrow(failure); expect(f.configProvider).not.toHaveBeenCalled(); await f.run(ticket); expect(f.chat).toHaveBeenCalledOnce() } finally { recording.close() }
  })
  it('request accessor is not invoked and recognized ticket cannot be retried with clean input', async () => {
    const f = await setup(), ticket = f.begin(), req = f.request(ingress()); let getter = 0
    Object.defineProperty(req, 'text', { enumerable: true, get() { getter++; return 'bad' } })
    await expect(f.runtime.handleMessage(req, { ticket })).rejects.toThrow('accessors'); expect(getter).toBe(0); await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.configProvider).not.toHaveBeenCalled()
  })
  it('released scripted executeTool callback cannot borrow another live run or root authority', async () => {
    const f = await setup(), ticket = f.begin(); let captured: ChatOptions | undefined
    f.chat.mockImplementation(async (_req, options) => { captured = options; return { content: 'done' } })
    await f.run(ticket); await expect(captured!.executeTool!({ toolName: 'fixture.effect', args: {}, runId: captured!.runId!, toolCallId: 'late' })).rejects.toThrow(failure); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0)
  })
  it('actual kernel-backed local fixture observes durable intent before registry dispatch', async () => {
    const f = await setup(), data = ingress('/tool fixture.effect {"local":true}'), ticket = f.begin(data)
    const registry = { listTools: () => [{ name: 'fixture.effect', description: 'local kernel fixture', inputSchema: { type: 'object' } }], callTool: f.tool } as unknown as AssistantToolRegistry
    // Runtime fixture was already attached; its registry reference is trusted MAIN,
    // so replace its selected methods rather than creating a second runtime lease.
    const target = (f.runtime as unknown as { toolRegistry: AssistantToolRegistry }).toolRegistry
    target.listTools = registry.listTools; target.callTool = registry.callTool
    f.tool.mockImplementation(async () => { expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 1 }); return { content: 'kernel local result' } })
    await f.run(ticket, data); expect(f.tool).toHaveBeenCalledOnce(); expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 0, unknownIntents: 0 })
  })
  it('intent journal failure cannot dispatch a tool and records a reported pre-dispatch failure only', async () => {
    const f = await setup(), data = ingress('/tool fixture.effect {}'), ticket = f.begin(data), append = f.session.appendEvents.bind(f.session)
    vi.spyOn(f.session, 'appendEvents').mockImplementation(async (...args) => { if ((args[1][0]?.metadata?.agentAction as { type?: string })?.type === 'tool.invoke') throw Error('session journal fixture failure'); return append(...args) })
    await expect(f.run(ticket, data)).rejects.toThrow('session journal fixture failure'); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 0, unknownIntents: 0 }); expect(f.managed.getCoverage('root')?.state.status).toBe('dirty')
  })
  it('ordinary final publication tail failure leaves recording dirty without replay permission', async () => {
    const f = await setup(), ticket = f.begin(), append = f.session.appendTurn.bind(f.session)
    vi.spyOn(f.session, 'appendTurn').mockImplementation(async (...args) => { if (args[3]?.run?.status === 'completed') throw Error('final publication fixture failure'); return append(...args) })
    await expect(f.run(ticket)).rejects.toThrow('final publication fixture failure'); expect(f.attempt().revision).toBe(1); expect(f.managed.getCoverage('root')?.state.status).toBe('dirty'); await expect(f.run(ticket)).rejects.toThrow(failure)
  })
  it('extra options accessor cannot be evaluated or leave a recognized ticket runnable', async () => {
    const f = await setup(), ticket = f.begin(), options = { ticket }; let getters = 0
    Object.defineProperty(options, 'extra', { enumerable: true, get() { getters++; return 'ignored' } })
    await expect(f.runtime.handleMessage(f.request(ingress()), options)).rejects.toThrow('accessors'); expect(getters).toBe(0)
    await expect(f.run(ticket)).rejects.toThrow(failure); expect(f.configProvider).not.toHaveBeenCalled()
  })
  it('chat cannot report success while an accepted detached tool intent is still pending', async () => {
    const f = await setup(), ticket = f.begin(), started = deferred<void>(), raw = deferred<{ content: string }>(); let detached: Promise<unknown> | undefined
    f.tool.mockImplementation(async () => { started.resolve(); return raw.promise })
    f.chat.mockImplementation(async (_req, options) => { detached = options!.executeTool!({ toolName: 'fixture.effect', args: {}, runId: options!.runId!, toolCallId: 'detached' }).catch(error => error); await started.promise; return { content: 'not full tool completion' } })
    const running = f.run(ticket)
    try { await expect(running).rejects.toThrow(failure); expect(f.attempt().state.pendingIntents).toBe(1); expect(f.owner.cooperativeExecution.isQuiescent()).toBe(false) }
    finally { raw.resolve({ content: 'late receipt' }); await detached; await running.catch(() => undefined); await f.owner.cooperativeExecution.whenQuiescent() }
    expect(f.managed.getCoverage('root')?.state.status).toBe('dirty')
  })
  it.each(['slash', 'chat'] as const)('managed generic post-dispatch %s failure stays unknown in both durable ledger and journal resume gate', async mode => {
    const f = await setup(), data = ingress(mode === 'slash' ? '/tool fixture.effect {}' : undefined), ticket = f.begin(data)
    f.tool.mockRejectedValue(Error('effect may have happened'))
    if (mode === 'chat') f.chat.mockImplementation(async (_req, options) => { await options!.executeTool!({ toolName: 'fixture.effect', args: {}, runId: options!.runId!, toolCallId: 'uncertain' }); return { content: 'unreachable' } })
    await expect(f.run(ticket, data)).rejects.toThrow('effect may have happened')
    const runId = f.attempt().state.binding!.runtimeRunId, journal = (await f.session.getSession(data.route))!.eventLog
    expect(f.attempt().state.unknownIntents).toBe(1)
    expect(() => assertKnownAssistantToolOutcomes(journal, runId, { requireRunStart: true })).toThrow('review its effects')
    const result = journal.map(event => event.metadata?.agentAction as { type?: string; payload?: { error?: { code?: string } } }).find(action => action?.type === 'tool.result')
    expect(result?.payload?.error?.code).toBe(ASSISTANT_TOOL_OUTCOME_UNKNOWN)
    const ordinary = new AssistantRuntime({ sessionStore: f.session, configProvider: f.configProvider, chatService: { chat: f.chat }, toolRegistry: { listTools: () => [] } as unknown as AssistantToolRegistry })
    const before = f.chat.mock.calls.length
    await expect(ordinary.resumeRun(data.route, runId)).rejects.toMatchObject({ code: 'TOOL_REPLAY_REQUIRES_REVIEW' }); expect(f.chat.mock.calls).toHaveLength(before)
  })
  it('does not leak ticket/coordinator/owner/EventStore through real request/chat/tool/result data', async () => {
    const f = await setup(), ticket = f.begin(), captured: unknown[] = []
    f.chat.mockImplementation(async (req, options) => { captured.push(req, options); const value = await options!.executeTool!({ toolName: 'fixture.effect', args: {}, runId: options!.runId!, toolCallId: 'one' }); captured.push(value); return { content: 'local' } })
    f.tool.mockImplementation(async (...args: unknown[]) => { captured.push(...args); return { content: 'local' } })
    const result = await f.run(ticket); captured.push(result, await f.session.getSession(route))
    for (const root of captured) for (const privateValue of [ticket, f.recording, f.events, f.owner, f.owner.controller, f.owner.cooperativeExecution]) expect(contains(root, privateValue)).toBe(false)
  })
})
