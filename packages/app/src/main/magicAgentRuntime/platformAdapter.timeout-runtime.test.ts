import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { AssistantRuntimeResult } from '../assistantRuntime/types'
import type { MagicAgentPlatformRunReq } from '@shared/api/svcMagicAgentPlatform'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import * as configModule from '../config/config'

const { dataRoot } = vi.hoisted(() => ({ dataRoot: { current: process.cwd() } }))
vi.mock(import('../config/config'), async original => ({ ...(await original()), getConfig: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: dataRoot.current } }) }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/tmp/magicpot-test-user-data'), getVersion: vi.fn(() => '1.0.0') } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true }, platform: { isWindows: false, isMacOS: false, isLinux: true } }))

import { AgentKernel } from '../agentKernel'
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { MagicAgentPlatformAdapter } from './platformAdapter'
import { MagicAgentCreativeToolRegistry } from './tools'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'actual-runtime-timeout-tail' } as const
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function microtasks() { for (let i = 0; i < 64; i++) await Promise.resolve() }
const request = (): MagicAgentPlatformRunReq => ({ text: 'current', agentId: 'local-agent', route, timeoutMs: 1000, allowedToolNames: [] })

async function setup() {
  const temp = await createNodeTestArtifactDir('platform-timeout-actual-runtime')
  dataRoot.current = temp
  const config: Config = { ...DEFAULT_CONFIG, chat_config: { ...DEFAULT_CONFIG.chat_config, enable: true, profile_id: 'explicit-local', max_history_messages: 4 } }
  vi.mocked(configModule.getConfig).mockReturnValue(config)
  const store = new AssistantSessionStore(path.join(temp, 'owned-sessions.json'))
  const chat = vi.fn(async () => ({ content: 'explicit local model fixture' }))
  const runtime = new AssistantRuntime({ sessionStore: store, configProvider: () => config, chatService: { chat } })
  const kernel = new AgentKernel(), execution = new CooperativeExecutionController()
  const handleMessage = runtime.handleMessage.bind(runtime)
  let actual: Promise<AssistantRuntimeResult> | undefined
  vi.spyOn(runtime, 'handleMessage').mockImplementation(req => {
    actual = handleMessage(req)
    void actual.catch(() => undefined)
    return actual
  })
  const adapter = new MagicAgentPlatformAdapter({ assistantRuntime: runtime, agentKernel: kernel, chatService: { chat }, creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [] }) })
  return { temp, store, chat, runtime, kernel, execution, adapter, handleMessage, get actual() { return actual! }, async cleanup() {
    await actual?.catch(() => undefined); adapter.dispose(); await store.flush(); dataRoot.current = process.cwd(); await fs.rm(temp, { recursive: true, force: true })
  } }
}

// Uses actual runtime preparation/queue/cancellation/final-publication and owned
// file persistence. Only local model reply and explicit write barriers are scripted;
// not native SDK/host effects, external provider or sticky-unknown restart proof.
describe('platform timeout retains actual AssistantRuntime returned-promise tails', () => {
  it.each(['fulfill', 'reject'] as const)('owns real final appendTurn %s tail after the inner execution gate has settled', async settlement => {
    const s = await setup(), reached = deferred<void>(), release = deferred<void>()
    const append = s.store.appendTurn.bind(s.store), failure = new Error('explicit final appendTurn failure')
    vi.spyOn(s.store, 'appendTurn').mockImplementation(async (...args) => {
      if (args[3]?.run?.status === 'completed') {
        reached.resolve(undefined)
        await release.promise
        if (settlement === 'reject') throw failure
      }
      return append(...args)
    })
    vi.useFakeTimers()
    try {
      const caller = s.adapter.runAgent(request(), { cooperativeExecution: s.execution })
      await reached.promise
      expect(s.chat).toHaveBeenCalledOnce()
      expect(s.execution.isQuiescent()).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      const result = await caller
      expect(result.status).toBe('timeout')
      expect(s.execution.isQuiescent()).toBe(false)
      let drained = false
      const drain = s.execution.whenQuiescent().then(() => { drained = true })
      await microtasks(); expect(drained).toBe(false)
      release.resolve(undefined)
      await s.actual.catch(() => undefined)
      await drain
      expect(s.execution.isQuiescent()).toBe(true)
      expect(result.status).toBe('timeout')
      expect(s.kernel.listRuns()).toHaveLength(1)
      expect(s.kernel.listEvents().filter(event => event.type === 'run.failed')).toHaveLength(1)
      const saved = await s.store.getSession(route)
      expect(saved?.runs).toHaveLength(1)
      expect(saved?.runs[0].status).toBe(settlement === 'fulfill' ? 'completed' : 'failed')
    } finally { release.resolve(undefined); await s.cleanup(); vi.useRealTimers() }
  }, 15000)

  it('owns actual queued publication before runtime turn admission and cancellation cleanup after timeout', async () => {
    const s = await setup(), reached = deferred<void>(), release = deferred<void>()
    const upsert = s.store.upsertRun.bind(s.store)
    vi.spyOn(s.store, 'upsertRun').mockImplementation(async (...args) => {
      if (args[1].status === 'queued') { reached.resolve(undefined); await release.promise }
      return upsert(...args)
    })
    vi.useFakeTimers()
    try {
      const caller = s.adapter.runAgent(request(), { cooperativeExecution: s.execution })
      await reached.promise
      expect(s.chat).not.toHaveBeenCalled()
      expect(s.execution.isQuiescent()).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(caller).resolves.toMatchObject({ status: 'timeout' })
      let paused = false
      const pause = s.execution.requestPause().then(ticket => { paused = true; return ticket })
      await microtasks(); expect(paused).toBe(false)
      release.resolve(undefined)
      await expect(s.actual).resolves.toMatchObject({ status: 'cancelled' })
      expect(s.execution.isPauseCurrent(await pause)).toBe(true)
      expect(s.chat).not.toHaveBeenCalled()
      expect((await s.store.getSession(route))?.runs[0].status).toBe('cancelled')
    } finally { release.resolve(undefined); await s.cleanup(); vi.useRealTimers() }
  }, 15000)

  it('retains a timed-out actual same-route queue successor until its predecessor exits', async () => {
    const s = await setup(), firstEntered = deferred<void>(), finishFirst = deferred<void>(), successorQueued = deferred<void>()
    s.chat.mockImplementationOnce(async () => { firstEntered.resolve(undefined); await finishFirst.promise; return { content: 'first local model' } })
    const upsert = s.store.upsertRun.bind(s.store)
    vi.spyOn(s.store, 'upsertRun').mockImplementation(async (...args) => {
      const result = await upsert(...args)
      if (args[1].requestText === 'current' && args[1].status === 'queued') successorQueued.resolve(undefined)
      return result
    })
    const predecessor = s.handleMessage({ route, text: 'predecessor', execution: { allowedToolNames: [] } })
    void predecessor.catch(() => undefined)
    vi.useFakeTimers()
    try {
      await firstEntered.promise
      const caller = s.adapter.runAgent(request(), { cooperativeExecution: s.execution })
      await successorQueued.promise
      await vi.advanceTimersByTimeAsync(1000)
      await expect(caller).resolves.toMatchObject({ status: 'timeout' })
      expect(s.execution.isQuiescent()).toBe(false)
      expect(s.chat).toHaveBeenCalledOnce()
      let drained = false
      const drain = s.execution.whenQuiescent().then(() => { drained = true })
      await microtasks(); expect(drained).toBe(false)
      finishFirst.resolve(undefined)
      await predecessor
      await expect(s.actual).resolves.toMatchObject({ status: 'cancelled' })
      await drain
      expect(s.chat).toHaveBeenCalledOnce()
      const saved = await s.store.getSession(route)
      expect(saved?.runs.map(run => run.status)).toEqual(['completed', 'cancelled'])
    } finally { finishFirst.resolve(undefined); await predecessor.catch(() => undefined); await s.cleanup(); vi.useRealTimers() }
  }, 15000)
})
