import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { MagicAgentInstanceState } from '@shared/magicAgentPlatform2/agentInstance'
const state = vi.hoisted(() => ({ root: process.cwd(), forbiddenGlobalConfig: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: state.root } }) }))
vi.mock('../config/config', () => ({ getConfig: state.forbiddenGlobalConfig, saveConfig: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { isPackaged: false, getPath: () => process.cwd() }, BrowserWindow: { fromWebContents: () => undefined }, webContents: { fromId: () => undefined }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined), getMcpClientManager: () => ({ listToolsSnapshot: () => [] }) }))
import { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { AssistantRuntime } from './runtime'
import { AssistantSessionStore } from './sessionStore'
import { AssistantToolRegistry } from './toolRegistry'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { PersistentManagedAgentInstanceStore } from '../magicAgentPlatform2/agents/persistentManagedAgentInstanceStore'
import { PersistentManagedAgentExecutionStore } from '../magicAgentPlatform2/agents/persistentManagedAgentExecutionStore'
import { ManagedRuntimeRecording } from '../magicAgentPlatform2/agents/managedRuntimeRecording'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const cleanups: Array<() => Promise<void>> = []
const route = { channel: 'generic', scopeType: 'dm', scopeId: 'managed-provider-tail' } as const
async function fixture() {
  const dir = await createNodeTestArtifactDir('managed-provider-tail'); state.root = dir
  const events = new MagicAgentEventStore(':memory:'), managed = new PersistentManagedAgentInstanceStore(events), ledger = new PersistentManagedAgentExecutionStore(events)
  const owner = { controller: new AbortController(), cooperativeExecution: new CooperativeExecutionController(), phase: 'running' as const, stopRequested: false }
  const recording = new ManagedRuntimeRecording(events, { active: new Map([['root', owner]]), closing: false })
  managed.createRoot({ instance: { id: 'root', name: 'root', definitionId: 'local', configVersion: 'v1', depth: 0, status: 'created', limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 10000, allowedToolNames: [], workspaceRoots: [] } } satisfies MagicAgentInstanceState, createdAt: 1, idempotencyKey: 'birth' })
  const config = structuredClone(DEFAULT_CONFIG); config.use_remote_llm = false; config.chat_config = { ...config.chat_config, enable: true, profile_id: 'real-text' }
  config.llm_config.api_profiles = [{ id: 'real-text', model_name: 'fixture-text', api_key: 'local-fixture-not-a-secret', base_url: 'http://127.0.0.1:1/v1/chat/completions', provider: 'openai', call_type: 'api', deployment: 'local', model_use: 'agent', api_mode: 'chat-completions' }]
  const sessions = new AssistantSessionStore(path.join(dir, 'sessions.json')), tool = vi.fn(async () => ({ content: 'must not dispatch' }))
  const runtime = new AssistantRuntime({ chatService: LLMProxySvcImpl.createManagedRealChatService(), sessionStore: sessions, configProvider: () => config, toolRegistry: { listTools: () => [], callTool: tool } as unknown as AssistantToolRegistry, managedRecording: recording })
  const data = { route, text: 'owned provider-tail fixture', execution: { allowedToolNames: [], maxToolCalls: 0 } }
  const ticket = recording.begin({ instanceId: 'root', expectedRevision: 0, expectedCoverageRevision: 0, authorizedRequestDigest: 'a'.repeat(64), startedAt: 2, idempotencyKey: 'first' }, owner, data)
  cleanups.push(async () => { recording.close(); await sessions.flush(); events.close(); await fs.rm(dir, { recursive: true, force: true }) })
  return { owner, tool, run: () => runtime.handleMessage({ ...data, signal: owner.controller.signal, cooperativeExecution: owner.cooperativeExecution }, { ticket }), attempt: () => ledger.getAttempt(managed.getCoverage('root')!.state.accepted!.identity)!, coverage: () => managed.getCoverage('root')! }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); state.forbiddenGlobalConfig.mockReset(); state.root = process.cwd() })

describe('managed real-client known raw tails, not production owner or clean acceptance', () => {
  it('caller abort settles promptly but owner retains ignored-signal raw fetch and its late response cancellation', async () => {
    const entered = deferred<void>(), raw = deferred<Response>(), cancelEntered = deferred<void>(), cancel = deferred<void>()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelEntered.resolve(); return cancel.promise } }))
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => { entered.resolve(); return raw.promise }); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(), running = f.run(), observed = running.catch(error => error)
    try {
      await entered.promise; f.owner.controller.abort(Error('owned caller stop'))
      expect((await observed).status).toBe('cancelled')
      expect(f.owner.cooperativeExecution.isQuiescent()).toBe(false)
      raw.resolve(response); await cancelEntered.promise
      expect(f.owner.cooperativeExecution.isQuiescent()).toBe(false)
      expect(fetcher).toHaveBeenCalledOnce(); expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0)
      cancel.resolve(); await f.owner.cooperativeExecution.whenQuiescent()
      expect(f.coverage().state.status).toBe('dirty')
    } finally { f.owner.controller.abort(); raw.resolve(response); await cancelEntered.promise; cancel.resolve(); await observed; await f.owner.cooperativeExecution.whenQuiescent() }
  })
  it('owner also retains the late-response cancellation after the previously pending raw fetch itself settles', async () => {
    const entered = deferred<void>(), raw = deferred<Response>(), cancelEntered = deferred<void>(), cancel = deferred<void>()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelEntered.resolve(); return cancel.promise } }))
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => { entered.resolve(); return raw.promise }); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(), observed = f.run().catch(error => error)
    try {
      await entered.promise; f.owner.controller.abort(Error('owned stop before late response'))
      expect((await observed).status).toBe('cancelled'); raw.resolve(response); await cancelEntered.promise
      expect(f.owner.cooperativeExecution.isQuiescent()).toBe(false)
      cancel.resolve(); await f.owner.cooperativeExecution.whenQuiescent()
      expect(fetcher).toHaveBeenCalledOnce(); expect(f.tool).not.toHaveBeenCalled(); expect(f.coverage().state.status).toBe('dirty')
    } finally { f.owner.controller.abort(); raw.resolve(response); await cancelEntered.promise; cancel.resolve(); await observed; await f.owner.cooperativeExecution.whenQuiescent() }
  })
  it('caller abort settles promptly but owner retains a pending reader cancellation after body read unblocks', async () => {
    const readEntered = deferred<void>(), cancelEntered = deferred<void>(), cancel = deferred<void>()
    const response = new Response(new ReadableStream<Uint8Array>({ pull() { readEntered.resolve() }, cancel() { cancelEntered.resolve(); return cancel.promise } }, { highWaterMark: 0 }))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response); vi.stubGlobal('fetch', fetcher)
    const f = await fixture(), running = f.run(), observed = running.catch(error => error)
    try {
      await readEntered.promise; f.owner.controller.abort(Error('owned stop during reader.read'))
      expect((await observed).status).toBe('cancelled'); await cancelEntered.promise
      expect(f.owner.cooperativeExecution.isQuiescent()).toBe(false)
      cancel.resolve(); await f.owner.cooperativeExecution.whenQuiescent()
      expect(f.tool).not.toHaveBeenCalled(); expect(f.attempt().state.totalIntents).toBe(0); expect(f.coverage().state.status).toBe('dirty')
    } finally { f.owner.controller.abort(); cancel.resolve(); await observed; await f.owner.cooperativeExecution.whenQuiescent() }
  })
})
