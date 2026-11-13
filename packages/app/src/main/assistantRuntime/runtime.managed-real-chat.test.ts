import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { MagicAgentInstanceState } from '@shared/magicAgentPlatform2/agentInstance'
const state = vi.hoisted(() => ({ root: process.cwd(), forbiddenGlobalConfig: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: state.root } }) }))
vi.mock('../config/config', () => ({ getConfig: state.forbiddenGlobalConfig, saveConfig: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { isPackaged: false, getPath: () => process.cwd() }, BrowserWindow: { fromWebContents: () => undefined }, webContents: { fromId: () => undefined }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined), getMcpClientManager: () => ({ listToolsSnapshot: () => [] }) }))
import { LLMProxySvcImpl, invokeManagedRealChat as invokeRealChat, type ManagedRealChatContext } from '../api/svcLLMProxyImpl'
import { withCooperativeOperation } from './cooperativeOperation'
import { createProviderRawWorkRetainer } from './providerRawWorkRetention'
import { AssistantRuntime } from './runtime'
import { AssistantSessionStore } from './sessionStore'
import { AssistantToolRegistry } from './toolRegistry'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { PersistentManagedAgentInstanceStore } from '../magicAgentPlatform2/agents/persistentManagedAgentInstanceStore'
import { PersistentManagedAgentExecutionStore } from '../magicAgentPlatform2/agents/persistentManagedAgentExecutionStore'
import { ManagedRuntimeRecording } from '../magicAgentPlatform2/agents/managedRuntimeRecording'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'
import { _crashTesting } from '../magicAgentPlatform2/persistence/crashHooks'
import { assertKnownAssistantToolOutcomes, ASSISTANT_TOOL_OUTCOME_UNKNOWN } from './toolRecovery'

const cleanups: Array<() => Promise<void>> = []
const route = { channel: 'generic', scopeType: 'dm', scopeId: 'managed-real-chat' } as const
const definition = { name: 'fixture.effect', description: 'bounded local fixture effect', inputSchema: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: false } }
const profile = () => ({ id: 'real-text', model_name: 'fixture-text', api_key: 'local-fixture-not-a-secret', base_url: 'http://127.0.0.1:1/v1/chat/completions', provider: 'openai' as const, call_type: 'api', deployment: 'local' as const, model_use: 'agent' as const, api_mode: 'chat-completions' as const })
const config = () => { const c = structuredClone(DEFAULT_CONFIG); c.use_remote_llm = false; c.chat_config = { ...c.chat_config, enable: true, profile_id: 'real-text', max_history_messages: 4 }; c.llm_config.api_profiles = [profile()]; return c }
const nativeReply = (id = 'native-one') => ({ id: 'fixture', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'mp_tool_0', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }] })
const textReply = (content = 'actual client complete', finish = 'stop') => ({ id: 'fixture', choices: [{ message: { role: 'assistant', content }, finish_reason: finish }] })
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const serviceRequest = (): LLMChatReq => ({ profileId: 'real-text', route, messages: [{ role: 'user', content: 'use bound tool' }], skillRuntime: { bindings: [{ appId: 'assistant-runtime', source: 'assistant-runtime', toolNames: ['fixture.effect'] }] } })
const serviceOptions = () => ({ signal: new AbortController().signal, runId: '00000000-0000-4000-8000-000000000001', additionalToolDefinitions: [definition], executeTool: vi.fn(async () => ({ content: 'only callback receipt' })) })
// Service-only validation tests are not owner-authority tests. Their trusted
// context must still supply a concrete exact child for the new constructor policy.
async function invokeManagedRealChat(
  service: object,
  request: LLMChatReq,
  options: Parameters<typeof invokeRealChat>[2],
  context: Omit<ManagedRealChatContext, 'retainRawWork'>
) {
  const controller = new CooperativeExecutionController()
  try {
    return await withCooperativeOperation(controller, 'llm-inference', options.signal, async child =>
      invokeRealChat(service, request, options, {
        ...context,
        retainRawWork: createProviderRawWorkRetainer(child, options.signal, context.assertCurrent)
      })
    )
  } finally {
    await controller.whenQuiescent()
  }
}
async function fixture(kernel = false) {
  const dir = await createNodeTestArtifactDir('managed-real-chat'); state.root = dir
  const events = new MagicAgentEventStore(':memory:'), managed = new PersistentManagedAgentInstanceStore(events), ledger = new PersistentManagedAgentExecutionStore(events)
  const owner = { controller: new AbortController(), cooperativeExecution: new CooperativeExecutionController(), phase: 'running' as const, stopRequested: false }
  const ownership = { active: new Map([['root', owner]]), closing: false }, recording = new ManagedRuntimeRecording(events, ownership)
  const instance: MagicAgentInstanceState = { id: 'root', name: 'root', definitionId: 'local', configVersion: 'v1', depth: 0, status: 'created', limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 10000, allowedToolNames: [definition.name], workspaceRoots: [] } }
  managed.createRoot({ instance, createdAt: 1, idempotencyKey: 'birth' })
  const c = config(), configProvider = vi.fn(() => c), session = new AssistantSessionStore(path.join(dir, 'sessions.json'))
  const tool = vi.fn(async (_name: string, _args: Record<string, unknown>, _context?: unknown) => ({ content: 'durable local tool receipt' }))
  const provider = { listTools: () => [definition], callTool: tool }, service = LLMProxySvcImpl.createManagedRealChatService()
  const data = { route, text: 'use one bound tool', execution: { allowedToolNames: [definition.name], maxToolCalls: 3 } }
  cleanups.push(async () => { recording.close(); await session.flush(); events.close(); await fs.rm(dir, { recursive: true, force: true }) })
  const runtime = new AssistantRuntime({ chatService: service, sessionStore: session, configProvider, toolRegistry: { listTools: () => kernel ? [definition] : [], callTool: tool } as unknown as AssistantToolRegistry, managedRecording: recording })
  const ticket = recording.begin({ instanceId: 'root', expectedRevision: 0, expectedCoverageRevision: 0, authorizedRequestDigest: 'a'.repeat(64), startedAt: 2, idempotencyKey: 'first' }, owner, data)
  const run = () => runtime.handleMessage({ ...data, signal: owner.controller.signal, cooperativeExecution: owner.cooperativeExecution, ...(kernel ? {} : { toolProvider: provider }) }, { ticket })
  const attempt = () => ledger.getAttempt(managed.getCoverage('root')!.state.accepted!.identity)!
  return { dir, c, configProvider, events, managed, ledger, owner, ownership, recording, runtime, session, tool, provider, service, ticket, run, attempt }
}
afterEach(async () => { _crashTesting.setHook(null); for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); state.forbiddenGlobalConfig.mockReset(); state.root = process.cwd() })

describe('restricted real LLM service and built-in client, not production owner transport', () => {
  it('executes native tool through actual runtime durable intent and returns real client text', async () => {
    state.forbiddenGlobalConfig.mockImplementation(() => { throw Error('Global config read during native managed real-chat contract') })
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(nativeReply())).mockResolvedValueOnce(jsonResponse(textReply()))
    vi.stubGlobal('fetch', fetcher)
    const f = await fixture()
    f.tool.mockImplementation(async () => { expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 1 }); return { content: 'verified actual tool receipt' } })
    const result = await f.run()
    expect(result.reply.content).toBe('actual client complete'); expect(f.tool).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2)
    expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 0, unknownIntents: 0 }); expect(f.managed.getCoverage('root')!.state.status).toBe('dirty')
    // Existing adapter kernel catalog refresh may read global MCP availability,
    // caught by the bridge; service dispatch must not reread it to route models.
    expect(state.forbiddenGlobalConfig.mock.results.every(result => result.type === 'throw')).toBe(true)
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body)); expect(bodies[0].tools).toHaveLength(1); expect(bodies[0].tools[0].type).toBe('function'); expect(bodies[1].messages.some((m: { content?: string }) => m.content === 'verified actual tool receipt')).toBe(true)
    const wire = JSON.stringify(fetcher.mock.calls); for (const word of ['ticket', 'lease', 'controller', 'coordinator', 'assertCurrent', 'cooperativeExecution']) expect(wire).not.toContain(word)
  })
  it('executes legacy JSON envelope through the same actual durable executor', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(textReply('{"toolName":"fixture.effect","args":{"x":2}}'))).mockResolvedValueOnce(jsonResponse(textReply('json complete'))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); expect((await f.run()).reply.content).toBe('json complete'); expect(f.tool).toHaveBeenCalledOnce(); expect(f.attempt().state.totalIntents).toBe(1)
  })
  it('does not allow facade use without concrete recording or by direct ordinary .chat', async () => {
    const service = LLMProxySvcImpl.createManagedRealChatService()
    await expect(service.chat(serviceRequest())).rejects.toThrow(/private|executor/i)
    expect(() => new AssistantRuntime({ chatService: service })).toThrow(/managed|recording/i)
  })
  it('does not accept copied routing identity at the private helper', async () => {
    const service = LLMProxySvcImpl.createManagedRealChatService()
    await expect(invokeManagedRealChat({ ...service }, serviceRequest(), serviceOptions(), { config: config(), assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/exact|managed/i)
  })
  it.each(['length', 'content_filter'])('rejects incomplete %s JSON tool output without intent or effect', async reason => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(textReply('{"toolName":"fixture.effect","args":{}}', reason))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); await expect(f.run()).rejects.toThrow(/incomplete/i); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0)
  })
  it.each(['length', 'content_filter'])('rejects incomplete %s JSON tool envelope returned as text parts before intent/effect', async reason => {
    const body = textReply('', reason); Object.assign(body.choices[0].message, { content: [{ type: 'text', text: '{"toolName":"fixture.effect","args":{}}' }] })
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(body)).mockResolvedValueOnce(jsonResponse(textReply('should not reach another model step'))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); await expect(f.run()).rejects.toThrow(/incomplete/i); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0); expect(fetcher).toHaveBeenCalledOnce()
  })
  it('rejects a media endpoint even with explicit chat-completions mode before fetch', async () => {
    const c = config(); c.llm_config.api_profiles[0].base_url = 'http://127.0.0.1:1/v1/images/generations'; const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(invokeManagedRealChat(LLMProxySvcImpl.createManagedRealChatService(), serviceRequest(), serviceOptions(), { config: c, assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/endpoint|text|chat/i); expect(fetcher).not.toHaveBeenCalled()
  })
  it('rechecks owner between tool completion and next model dispatch', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(nativeReply())).mockResolvedValueOnce(jsonResponse(textReply())); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); f.tool.mockImplementation(async () => { f.owner.stopRequested = true; return { content: 'effect then revoke' } })
    await expect(f.run()).rejects.toThrow(/owner|stopped|managed/i); expect(fetcher).toHaveBeenCalledOnce(); expect(f.tool).toHaveBeenCalledOnce()
  })
  it('restricted service helper uses callback without global runtime or provider fetch', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const req = serviceRequest(); req.messages[0].content = '/tool fixture.effect {"x":1}'
    const options = serviceOptions(), reply = await invokeManagedRealChat(LLMProxySvcImpl.createManagedRealChatService(), req, options, { config: config(), assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })
    expect(reply.content).toBe('only callback receipt'); expect(options.executeTool).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled(); expect(state.forbiddenGlobalConfig).not.toHaveBeenCalled()
  })
  it('executes registry-only kernel tool through a complete callback catalog', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(nativeReply())).mockResolvedValueOnce(jsonResponse(textReply('kernel complete'))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(true); expect((await f.run()).reply.content).toBe('kernel complete'); expect(f.tool).toHaveBeenCalledOnce(); expect(f.attempt().state).toMatchObject({ totalIntents: 1, pendingIntents: 0 })
  })
  it('uses detached pinned config despite original config changes during first provider step', async () => {
    const fetcher = vi.fn().mockImplementationOnce(async () => { f.c.llm_config.api_profiles[0].base_url = 'http://changed.invalid/v1/chat/completions'; f.c.use_remote_llm = true; return jsonResponse(nativeReply()) }).mockResolvedValueOnce(jsonResponse(textReply('still pinned'))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); expect((await f.run()).reply.content).toBe('still pinned'); expect(f.configProvider).toHaveBeenCalledOnce(); expect(fetcher.mock.calls.map(([url]) => url)).toEqual([profile().base_url, profile().base_url]); expect(fetcher.mock.calls.every(([, init]) => init.redirect === 'error')).toBe(true)
  })
  it('native unsupported falls back once to JSON protocol without changing provider or bypassing intent', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ error: { message: 'tools is not supported' } }, 400)).mockResolvedValueOnce(jsonResponse(textReply('{"toolName":"fixture.effect","args":{"x":2}}'))).mockResolvedValueOnce(jsonResponse(textReply('fallback complete'))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); expect((await f.run()).reply.content).toBe('fallback complete'); expect(fetcher).toHaveBeenCalledTimes(3); expect(f.tool).toHaveBeenCalledOnce(); expect(f.attempt().state.totalIntents).toBe(1)
    expect(JSON.parse(fetcher.mock.calls[0][1].body).tools).toHaveLength(1); expect(JSON.parse(fetcher.mock.calls[1][1].body).tools).toBeUndefined()
  })
  it('owner revoked by unsupported response blocks the fallback fetch', async () => {
    const fetcher = vi.fn(async () => { f.owner.stopRequested = true; return jsonResponse({ error: { message: 'tools is not supported' } }, 400) }); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); await expect(f.run()).rejects.toThrow(/managed|owner|stopped/i); expect(fetcher).toHaveBeenCalledOnce(); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0)
  })
  it('does not retry capacity failures on this private service', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: { message: 'temporarily overloaded' } }, 503)); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); await expect(f.run()).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce(); expect(f.tool).not.toHaveBeenCalled()
  })
  it('malformed protocol repairs once before any intent, then uses the same executor', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(textReply('{"toolName":"fixture.effect","args":{x:1}}'))).mockResolvedValueOnce(jsonResponse(textReply('{"toolName":"fixture.effect","args":{"x":1}}'))).mockResolvedValueOnce(jsonResponse(textReply('repaired'))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); expect((await f.run()).reply.content).toBe('repaired'); expect(f.tool).toHaveBeenCalledOnce(); expect(f.attempt().state.totalIntents).toBe(1); expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('accounts native batch members separately and refuses duplicate replay before a second effect', async () => {
    const first = nativeReply('same-id'); first.choices[0].message.tool_calls.push({ ...first.choices[0].message.tool_calls[0], id: 'another-id' })
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(first)).mockResolvedValueOnce(jsonResponse(nativeReply('same-id'))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); await expect(f.run()).rejects.toThrow(/duplicate|replay/i); expect(f.tool).toHaveBeenCalledTimes(2); expect(f.attempt().state).toMatchObject({ totalIntents: 2, pendingIntents: 0 })
  })
  it.each(['length', 'content_filter'])('rejects incomplete %s native response before intent/effect', async reason => {
    const body = nativeReply(); body.choices[0].finish_reason = reason
    const fetcher = vi.fn(async () => jsonResponse(body)); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); await expect(f.run()).rejects.toThrow(/incomplete/i); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0)
  })
  it.each(['resource.before-commit', 'resource.after-commit'] as const)('fails closed on mandatory intent %s through the real service', async stage => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(nativeReply())); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(), mutate = f.events.mutateResourcesBatch.bind(f.events)
    f.events.mutateResourcesBatch = (inputs, fence) => {
      if (inputs.some(input => input.kind === 'managed-agent-execution-intent')) _crashTesting.setHook(current => { if (current === stage) throw Error(`real-chat-intent:${stage}`) })
      try { return mutate(inputs, fence) } finally { _crashTesting.setHook(null) }
    }
    try { await expect(f.run()).rejects.toThrow(/real-chat-intent/); expect(f.tool).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce(); expect(f.attempt().state.totalIntents).toBe(stage === 'resource.before-commit' ? 0 : 1); await expect(f.run()).rejects.toThrow(/ticket|managed/i) } finally { f.events.mutateResourcesBatch = mutate }
  })
  it('does not write a second outcome or dispatch another model after post-COMMIT outcome failure', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(nativeReply())); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(), mutate = f.events.mutateResourcesBatch.bind(f.events); let outcomes = 0
    f.events.mutateResourcesBatch = (inputs, fence) => {
      if (inputs.some(input => input.kind === 'managed-agent-execution-intent' && (input.state as { status?: string }).status === 'reported-result')) { outcomes++; _crashTesting.setHook(stage => { if (stage === 'resource.after-commit') throw Error('real-chat-outcome-postcommit') }) }
      try { return mutate(inputs, fence) } finally { _crashTesting.setHook(null) }
    }
    try { await expect(f.run()).rejects.toThrow(/real-chat-outcome/); expect(f.tool).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce(); expect(outcomes).toBe(1); expect(f.attempt().state).toMatchObject({ pendingIntents: 0, unknownIntents: 0 }); expect(f.managed.getCoverage('root')!.state.status).toBe('dirty') } finally { f.events.mutateResourcesBatch = mutate }
  })
  it('preserves unknown marker and ordinary journal recovery refusal without another model', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(nativeReply())); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); f.tool.mockResolvedValue({ content: 'uncertain', metadata: { ok: true, error: { code: ASSISTANT_TOOL_OUTCOME_UNKNOWN } } } as { content: string })
    await expect(f.run()).rejects.toThrow(/unknown|review|managed/i); expect(fetcher).toHaveBeenCalledOnce(); expect(f.attempt().state.unknownIntents).toBe(1)
    const journal = (await f.session.getSession(route))!.eventLog; expect(() => assertKnownAssistantToolOutcomes(journal, f.attempt().state.binding!.runtimeRunId, { requireRunStart: true })).toThrow(/review/i)
  })
  it('caller cancellation stays responsive while raw real-service tool is retained and unknown stays sticky', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(nativeReply())); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); let enter!: () => void, finish!: (value: { content: string }) => void
    const entered = new Promise<void>(resolve => { enter = resolve }), raw = new Promise<{ content: string }>(resolve => { finish = resolve })
    f.tool.mockImplementation(async () => { enter(); return raw })
    const running = f.run(), observed = running.catch(error => error)
    try { await entered; f.owner.controller.abort(Error('user stopped')); expect((await observed).status).toBe('cancelled'); expect(f.owner.cooperativeExecution.isQuiescent()).toBe(false); expect(f.attempt().state.unknownIntents).toBe(1) }
    finally { finish({ content: 'late actual effect result' }); await observed; await f.owner.cooperativeExecution.whenQuiescent() }
    expect(fetcher).toHaveBeenCalledOnce(); expect(f.attempt().state.unknownIntents).toBe(1); expect(f.managed.getCoverage('root')!.state.status).toBe('dirty')
  })
  it.each(['sessionUrl', 'conversationId', 'comparisonRouting', 'structuredOutput', 'imageGenerationOptions', 'videoGenerationOptions', 'cancellationId', 'goal', 'skillContext'] as const)('rejects unsupported request own field %s before helper, extension or fetch', async field => {
    const req = { ...serviceRequest(), [field]: undefined }, options = serviceOptions(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    req.messages[0].content = '/tool fixture.effect {}'
    await expect(invokeManagedRealChat(LLMProxySvcImpl.createManagedRealChatService(), req, options, { config: config(), assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/unsupported|managed/i)
    expect(options.executeTool).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(state.forbiddenGlobalConfig).not.toHaveBeenCalled()
  })
  it.each(['oauth', 'attachment_transports', 'http_headers', 'api_keys', 'auth_mode', 'routing_backend', 'tencent_secret_key', 'api_key_strategy'] as const)('rejects unsupported profile auth/routing field %s before helper or fetch', async field => {
    const c = config(); Object.assign(c.llm_config.api_profiles[0], { [field]: undefined }); const req = serviceRequest(); req.messages[0].content = '/tool fixture.effect {}'; const options = serviceOptions(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(invokeManagedRealChat(LLMProxySvcImpl.createManagedRealChatService(), req, options, { config: c, assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/profile|authentication/i); expect(options.executeTool).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects duplicate selected profiles and unsupported provider without another route', async () => {
    const c = config(); c.llm_config.api_profiles.push({ ...c.llm_config.api_profiles[0] }); const options = serviceOptions(), service = LLMProxySvcImpl.createManagedRealChatService(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(invokeManagedRealChat(service, serviceRequest(), options, { config: c, assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/unique/i)
    c.llm_config.api_profiles.pop(); c.llm_config.api_profiles[0].provider = 'claude'
    await expect(invokeManagedRealChat(service, serviceRequest(), options, { config: c, assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/profile/i); expect(fetcher).not.toHaveBeenCalled(); expect(options.executeTool).not.toHaveBeenCalled()
  })
  it('rejects non-data options and request/catalog accessors without invoking them', async () => {
    const service = LLMProxySvcImpl.createManagedRealChatService(), getter = vi.fn(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const options = serviceOptions(); Object.defineProperty(options, 'extra', { get: getter })
    await expect(invokeManagedRealChat(service, serviceRequest(), options, { config: config(), assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/data|managed|accessor/i)
    const req = serviceRequest(); Object.defineProperty(req.messages[0], 'attachments', { get: getter })
    await expect(invokeManagedRealChat(service, req, serviceOptions(), { config: config(), assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/data|managed|accessor/i)
    expect(getter).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps an image-looking URL as ordinary text, without an image or continuation result', async () => {
    const content = 'https://images.invalid/file.png', fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(textReply(content))); vi.stubGlobal('fetch', fetcher)
    const result = await invokeManagedRealChat(LLMProxySvcImpl.createManagedRealChatService(), serviceRequest(), serviceOptions(), { config: config(), assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })
    expect(result.content).toBe(content); expect(result.imageUrl).toBeUndefined(); expect(result.attachments).toBeUndefined(); expect(result.sessionUrl).toBeUndefined()
  })
  it('rejects returned image payload instead of creating a runtime artifact', async () => {
    const body = textReply(); Object.assign(body.choices[0].message, { content: [{ type: 'image_url', image_url: { url: 'https://images.invalid/a.png' } }] })
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(body)); vi.stubGlobal('fetch', fetcher)
    await expect(invokeManagedRealChat(LLMProxySvcImpl.createManagedRealChatService(), serviceRequest(), serviceOptions(), { config: config(), assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).rejects.toThrow(/text|empty|invalid/i)
  })
  it.each(['content', 'images'] as const)('refuses mixed native tools and returned media in %s before intent/effect', async field => {
    const body = nativeReply(); Object.assign(body.choices[0].message, { [field]: [{ type: 'image_url', image_url: { url: 'https://images.invalid/mixed.png' } }] })
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(body)).mockResolvedValueOnce(jsonResponse(textReply('must not dispatch again'))); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(); await expect(f.run()).rejects.toThrow(/text|media|image/i); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0); expect(fetcher).toHaveBeenCalledOnce()
  })
  it('does not invoke fetch when the exact assertion revokes at the final delegate gate', async () => {
    const fetcher = vi.fn(), error = Error('exact owner revoked at delegate'); vi.stubGlobal('fetch', fetcher)
    let delegateGateObserved = false
    const assertCurrent = () => { if (new Error().stack?.includes('fetchImpl')) { delegateGateObserved = true; throw error } }
    await expect(invokeManagedRealChat(LLMProxySvcImpl.createManagedRealChatService(), serviceRequest(), serviceOptions(), { config: config(), assertCurrent })).rejects.toThrow(); expect(delegateGateObserved).toBe(true); expect(fetcher).not.toHaveBeenCalled()
  })
  it('never enters extension handle/create hooks for a supported builtin request', async () => {
    const existing = mainHostExtensionApiV1.llmProxy[0], handle = existing?.handleChatRequest ? vi.spyOn(existing, 'handleChatRequest') : undefined
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(textReply('builtin only'))); vi.stubGlobal('fetch', fetcher)
    const options = serviceOptions(); expect((await invokeManagedRealChat(LLMProxySvcImpl.createManagedRealChatService(), serviceRequest(), options, { config: config(), assertCurrent() { /* Test-only routing context; actual runtime assertions tested separately. */ } })).content).toBe('builtin only')
    if (handle) expect(handle).not.toHaveBeenCalled(); expect(options.executeTool).not.toHaveBeenCalled(); expect(state.forbiddenGlobalConfig).not.toHaveBeenCalled()
  })
})
