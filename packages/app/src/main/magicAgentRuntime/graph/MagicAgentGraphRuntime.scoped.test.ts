import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MagicAgentGraphDefinition, MagicAgentGraphRunRecord } from '@shared/magicAgent'
import {
  CooperativeExecutionController,
  type CooperativeOperationGate
} from '../../magicAgentPlatform2/agents/cooperativeExecutionController'
import { MagicAgentGraphRuntime, type MagicAgentGraphRuntimeDeps } from './MagicAgentGraphRuntime'
import { MagicAgentGraphRunEventStore } from './graphRunEventStore'
import type { MagicAgentGraphRunStore } from './graphRunStore'

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'graph-scoped-admission' } as const
const sessionKey = 'generic:dm:graph-scoped-admission'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function microtasks() {
  for (let i = 0; i < 48; i++) await Promise.resolve()
}
const baseGraph = (): MagicAgentGraphDefinition => ({
  graphId: 'test.graph-scoped',
  name: 'Scoped graph',
  description: 'Internal admission fixture',
  version: '1',
  tags: [],
  entryNodeIds: ['first'],
  nodes: [
    { nodeId: 'first', kind: 'agent', name: 'First', description: 'First local work' },
    { nodeId: 'second', kind: 'agent', name: 'Second', description: 'Second local work' }
  ],
  channels: [
    {
      channelId: 'handoff',
      from: 'first',
      to: 'second',
      kind: 'handoff',
      label: 'Handoff',
      required: true
    }
  ],
  outputs: [
    {
      outputId: 'answer',
      name: 'Answer',
      description: 'Final output',
      sourceNodeId: 'second',
      channelId: 'handoff',
      mimeType: 'text/plain'
    }
  ]
})
const completed = (agentId = 'first') => ({
  runId: `local-${agentId}`,
  agentId,
  status: 'completed' as const,
  content: `${agentId} completed`,
  messages: [],
  toolCalls: [],
  events: [],
  startedAt: 1,
  finishedAt: 2
})
function captureController() {
  let execution!: CooperativeExecutionController
  const capture = (controller: CooperativeExecutionController): void => {
    execution = controller
  }
  const requestPause = CooperativeExecutionController.prototype.requestPause
  const run = CooperativeExecutionController.prototype.run
  // Capture only the real callback API; do not replace the returned Promise.
  vi.spyOn(CooperativeExecutionController.prototype, 'requestPause').mockImplementation(function (
    this: CooperativeExecutionController
  ) {
    capture(this)
    return Reflect.apply(requestPause, this, [])
  })
  vi.spyOn(CooperativeExecutionController.prototype, 'run').mockImplementation(function (
    this: CooperativeExecutionController,
    ...args
  ) {
    capture(this)
    return Reflect.apply(run, this, args)
  })
  return () => execution
}
function runStore(save: (run: MagicAgentGraphRunRecord) => Promise<void>): MagicAgentGraphRunStore {
  return {
    save,
    get: async () => undefined,
    pruneSession: async () => undefined
  } as unknown as MagicAgentGraphRunStore
}
afterEach(() => vi.restoreAllMocks())

describe('graph atomic per-node admission and declared publication boundary (not timeout drainage)', () => {
  it.each(['running', 'completed', 'channel', 'failed'] as const)(
    'retains node ownership through %s snapshot settlement and keeps the next node a new paused root',
    async (stage) => {
      const execution = captureController(),
        reached = deferred(),
        finishSave = deferred(),
        agents: string[] = []
      let held = false
      const runtime = new MagicAgentGraphRuntime([baseGraph()], {
        runStore: runStore(async (snapshot) => {
          const first = snapshot.nodes?.find((node) => node.nodeId === 'first')
          const target =
            stage === 'channel'
              ? snapshot.events?.some((event) => event.type === 'channel.message')
              : first?.status === stage
          if (!held && target) {
            held = true
            reached.resolve()
            await finishSave.promise
          }
        }),
        runAgent: async (request) => {
          agents.push(request.agentId!)
          if (stage === 'failed') throw new Error('original local node failure')
          return completed(request.agentId)
        }
      })
      const running = runtime.run({
          graphId: 'test.graph-scoped',
          input: 'local',
          route,
          runId: `stage-${stage}`
        }),
        observed = running.catch((error) => error)
      let paused: ReturnType<typeof runtime.pause> | undefined
      try {
        await Promise.race([
          reached.promise,
          observed.then((result) => {
            throw new Error(
              `Graph ended before ${stage} snapshot fixture: ${JSON.stringify(result)}`
            )
          })
        ])
        let acknowledged = false
        paused = runtime.pause(`stage-${stage}`, sessionKey).then((value) => {
          acknowledged = true
          return value
        })
        await microtasks()
        expect(execution().isQuiescent()).toBe(false)
        expect(acknowledged).toBe(false)
        finishSave.resolve()
        await paused
        await microtasks()
        expect(agents).toEqual(['first'])
        expect(execution().isPaused()).toBe(true)
        if (stage === 'failed')
          expect(await observed).toMatchObject({
            status: 'failed',
            error: 'original local node failure'
          })
        else {
          expect(
            runtime
              .getRun(`stage-${stage}`, sessionKey)
              ?.nodes?.find((node) => node.nodeId === 'second')?.status
          ).toBe('pending')
          runtime.resume(`stage-${stage}`, sessionKey)
          expect(await observed).toMatchObject({ status: 'completed' })
          expect(agents).toEqual(['first', 'second'])
        }
      } finally {
        finishSave.resolve()
        execution()?.resume()
        runtime.resume(`stage-${stage}`, sessionKey)
        await paused
        await observed
      }
    }
  )

  it('keeps an emitted final output owned until its publication snapshot settles', async () => {
    const execution = captureController(),
      reached = deferred(),
      finish = deferred()
    let held = false
    const runtime = new MagicAgentGraphRuntime([baseGraph()], {
      runAgent: async (request) => completed(request.agentId),
      runStore: runStore(async (snapshot) => {
        if (!held && snapshot.events?.some((event) => event.type === 'output.created')) {
          held = true
          reached.resolve()
          await finish.promise
        }
      })
    })
    const running = runtime.run({
        graphId: 'test.graph-scoped',
        input: 'local',
        route,
        runId: 'final-output'
      }),
      observed = running.catch((error) => error)
    let paused: ReturnType<typeof runtime.pause> | undefined
    try {
      await Promise.race([
        reached.promise,
        observed.then(() => {
          throw new Error('Graph ended before final-output snapshot fixture')
        })
      ])
      let acknowledged = false
      paused = runtime.pause('final-output', sessionKey).then((value) => {
        acknowledged = true
        return value
      })
      await microtasks()
      expect(execution().isQuiescent()).toBe(false)
      expect(acknowledged).toBe(false)
      finish.resolve()
      expect(await observed).toMatchObject({ status: 'completed' })
      await paused
      expect(execution().isQuiescent()).toBe(true)
    } finally {
      finish.resolve()
      execution()?.resume()
      runtime.resume('final-output', sessionKey)
      await observed
      await paused
    }
  })

  it('allows exact live node children to drain but rejects the old node scope while a later node is live', async () => {
    const execution = captureController(),
      started = deferred(),
      enterChild = deferred(),
      childStarted = deferred(),
      finishChild = deferred(),
      secondStarted = deferred(),
      finishSecond = deferred()
    let firstScope: CooperativeOperationGate | undefined,
      secondScope: CooperativeOperationGate | undefined,
      effects = 0,
      late: unknown
    const deps: MagicAgentGraphRuntimeDeps = {
      runAgent: async (request, options) => {
        const gate = (options as { cooperativeExecution?: CooperativeOperationGate } | undefined)
          ?.cooperativeExecution
        if (request.agentId === 'first') {
          firstScope = gate
          started.resolve()
          await enterChild.promise
          if (!gate) throw new Error('Node child gate missing from trusted execution options')
          await gate.run('assistant-turn', options?.signal, async (inference) => {
            await inference.run('tool-invocation', options?.signal, async () => {
              effects++
              childStarted.resolve()
              await finishChild.promise
            })
          })
        } else {
          secondScope = gate
          secondStarted.resolve()
          try {
            await firstScope!.run('tool-invocation', new AbortController().signal, () => {
              effects++
            })
          } catch (error) {
            late = error
          }
          await finishSecond.promise
        }
        return completed(request.agentId)
      }
    }
    const runtime = new MagicAgentGraphRuntime([baseGraph()], deps),
      running = runtime.run({
        graphId: 'test.graph-scoped',
        input: 'local',
        route,
        runId: 'nested-scopes'
      }),
      observed = running.catch((error) => error)
    let paused: ReturnType<typeof runtime.pause> | undefined, independent: Promise<void> | undefined
    try {
      await Promise.race([
        started.promise,
        observed.then((result) => {
          throw new Error(`Graph ended before child callback: ${JSON.stringify(result)}`)
        })
      ])
      let acknowledged = false,
        unrelated = 0
      paused = runtime.pause('nested-scopes', sessionKey).then((value) => {
        acknowledged = true
        return value
      })
      independent = execution().run('assistant-turn', undefined, () => {
        unrelated++
      })
      enterChild.resolve()
      await microtasks()
      expect(firstScope).toBeDefined()
      await childStarted.promise
      expect(effects).toBe(1)
      expect(unrelated).toBe(0)
      expect(acknowledged).toBe(false)
      finishChild.resolve()
      expect((await paused).paused).toBe(true)
      expect(unrelated).toBe(0)
      runtime.resume('nested-scopes', sessionKey)
      await secondStarted.promise
      await microtasks()
      expect(secondScope).toBeDefined()
      expect(secondScope).not.toBe(firstScope)
      expect(late).toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      expect(effects).toBe(1)
      expect(execution().isQuiescent()).toBe(false)
      finishSecond.resolve()
      expect(await observed).toMatchObject({ status: 'completed' })
      await independent
      expect(unrelated).toBe(1)
    } finally {
      enterChild.resolve()
      finishChild.resolve()
      finishSecond.resolve()
      execution()?.resume()
      runtime.resume('nested-scopes', sessionKey)
      await independent
      await observed
      await paused
    }
  })

  it('uses callback roots for every node and final output without legacy split methods', async () => {
    const checkpoint = vi.spyOn(CooperativeExecutionController.prototype, 'checkpoint'),
      enter = vi.spyOn(CooperativeExecutionController.prototype, 'enter'),
      run = vi.spyOn(CooperativeExecutionController.prototype, 'run')
    const runtime = new MagicAgentGraphRuntime([baseGraph()], {
      runAgent: async (request) => completed(request.agentId)
    })
    expect(
      await runtime.run({
        graphId: 'test.graph-scoped',
        input: 'local',
        route,
        runId: 'only-atomic'
      })
    ).toMatchObject({ status: 'completed' })
    expect(run).toHaveBeenCalledTimes(3)
    expect(checkpoint).not.toHaveBeenCalled()
    expect(enter).not.toHaveBeenCalled()
  })

  it.each(['direct', 'approved'] as const)(
    'forwards one exact node child to a %s tool invocation',
    async (mode) => {
      const graph = baseGraph()
      graph.nodes = [
        {
          nodeId: 'first',
          kind: 'tool',
          name: 'Tool',
          description: 'Local tool',
          toolName: 'fixture.echo'
        }
      ]
      graph.channels = []
      graph.outputs[0].sourceNodeId = 'first'
      delete graph.outputs[0].channelId
      let scope: CooperativeOperationGate | undefined
      const callTool = vi.fn(
        async (
          _request,
          options?: { signal: AbortSignal; cooperativeExecution?: CooperativeOperationGate }
        ) => {
          scope = options?.cooperativeExecution
          if (!scope) throw new Error('Tool node scope missing')
          await scope.run('tool-invocation', options?.signal, () => undefined)
          return {
            ok: true,
            toolName: 'fixture.echo',
            source: 'magicAgentRuntime' as const,
            status: 'ok' as const,
            content: 'local tool'
          }
        }
      )
      const runtime = new MagicAgentGraphRuntime([graph], {
        callTool,
        ...(mode === 'approved'
          ? {
              requestToolApproval: (request) => ({
                pending: { approvalId: 'fixture-approval', revision: 0, createdAt: 1 },
                decision: Promise.resolve({ invoke: request.invoke })
              })
            }
          : {})
      })
      expect(
        await runtime.run({
          graphId: graph.graphId,
          input: 'local',
          route,
          allowedToolNames: ['fixture.echo'],
          runId: `tool-${mode}`
        })
      ).toMatchObject({ status: 'completed' })
      expect(callTool).toHaveBeenCalledOnce()
      expect(scope).toBeDefined()
      await expect(scope!.run('tool-invocation', undefined, () => undefined)).rejects.toMatchObject(
        { code: 'COOPERATIVE_SCOPE_RELEASED' }
      )
    }
  )

  it.each(['outside-objective', 'inactive-inbound', 'missing-required'] as const)(
    'owns the %s decision and its final event publication',
    async (reason) => {
      const graph = baseGraph(),
        execution = captureController(),
        reached = deferred(),
        finish = deferred(),
        agents: string[] = []
      if (reason === 'outside-objective')
        graph.nodes.push({
          nodeId: 'ignored',
          kind: 'agent',
          name: 'Ignored',
          description: 'Outside requested outputs'
        })
      else {
        graph.channels[0].condition = { operator: 'contains', value: 'NEVER' }
        graph.channels[0].required = reason === 'missing-required'
      }
      const targetNode = reason === 'outside-objective' ? 'ignored' : 'second',
        targetEvent = reason === 'missing-required' ? 'node.failed' : 'node.skipped'
      let held = false,
        paused: ReturnType<typeof runtime.pause> | undefined
      const runtime = new MagicAgentGraphRuntime([graph], {
        runAgent: async (request) => {
          agents.push(request.agentId!)
          return completed(request.agentId)
        },
        runStore: runStore(async (snapshot) => {
          if (
            !held &&
            snapshot.events?.some(
              (event) => event.type === targetEvent && event.metadata?.nodeId === targetNode
            )
          ) {
            held = true
            reached.resolve()
            await finish.promise
          }
        })
      })
      const running = runtime.run({ graphId: graph.graphId, route, input: 'local', runId: reason }),
        observed = running.catch((error) => error)
      try {
        await Promise.race([
          reached.promise,
          observed.then((result) => {
            throw new Error(`Did not reach ${reason}: ${JSON.stringify(result)}`)
          })
        ])
        let acknowledged = false
        paused = runtime.pause(reason, sessionKey).then((result) => {
          acknowledged = true
          return result
        })
        await microtasks()
        expect(execution().isQuiescent()).toBe(false)
        expect(acknowledged).toBe(false)
        finish.resolve()
        await paused
        expect(agents).not.toContain('second')
        runtime.resume(reason, sessionKey)
        expect(await observed).toMatchObject({
          status: reason === 'missing-required' ? 'failed' : 'completed'
        })
      } finally {
        finish.resolve()
        execution()?.resume()
        runtime.resume(reason, sessionKey)
        await paused
        await observed
      }
    }
  )

  it('rejects the retained approved invocation itself, even while the next node has a valid child', async () => {
    const graph = baseGraph()
    graph.nodes[0] = {
      nodeId: 'first',
      kind: 'tool',
      name: 'Tool',
      description: 'Approved local fixture',
      toolName: 'fixture.echo'
    }
    let savedInvoke!: () => Promise<unknown>,
      invocationSignal: AbortSignal | undefined,
      effects = 0,
      stale: unknown
    const secondStarted = deferred(),
      finish = deferred(),
      execution = captureController()
    const runtime = new MagicAgentGraphRuntime([graph], {
      requestToolApproval: (request) => {
        savedInvoke = request.invoke
        invocationSignal = request.signal
        return {
          pending: { approvalId: 'fixture-exact', revision: 0, createdAt: 1 },
          decision: Promise.resolve({ invoke: request.invoke })
        }
      },
      // This deliberately ignores gate options like the actual creative adapter.
      callTool: async (_request, options) => {
        effects++
        expect(options?.signal).toBe(invocationSignal)
        return {
          ok: true,
          toolName: 'fixture.echo',
          source: 'magicAgentRuntime',
          status: 'ok',
          content: 'one local effect'
        }
      },
      runAgent: async (request, options) => {
        secondStarted.resolve()
        try {
          await savedInvoke()
        } catch (error) {
          stale = error
        }
        await options!.cooperativeExecution!.run('assistant-turn', options!.signal, () => undefined)
        await finish.promise
        return completed(request.agentId)
      }
    })
    const running = runtime.run({
        graphId: graph.graphId,
        route,
        input: 'local',
        allowedToolNames: ['fixture.echo'],
        runId: 'retained-approval'
      }),
      observed = running.catch((error) => error)
    try {
      await secondStarted.promise
      await microtasks()
      expect(stale).toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      expect(effects).toBe(1)
      expect(execution().isQuiescent()).toBe(false)
      finish.resolve()
      expect(await observed).toMatchObject({ status: 'completed' })
      await expect(savedInvoke()).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      expect(effects).toBe(1)
    } finally {
      finish.resolve()
      execution()?.resume()
      await observed
    }
  })

  it('retains the original node failure when only the newly added trailing failure fence rejects', async () => {
    const graph = baseGraph(),
      original = new Error('primary node execution'),
      secondary = new Error('secondary publication fence'),
      finish = deferred(),
      reached = deferred(),
      execution = captureController()
    let failedSnapshotsWithEvent = 0,
      fenceRejections = 0
    const runtime = new MagicAgentGraphRuntime([graph], {
      runAgent: async () => {
        throw original
      },
      runStore: runStore(async (snapshot) => {
        if (snapshot.events?.at(-1)?.type === 'node.failed' && ++failedSnapshotsWithEvent === 2) {
          reached.resolve()
          await finish.promise
          fenceRejections++
          throw secondary
        }
      })
    })
    const running = runtime.run({
        graphId: graph.graphId,
        route,
        input: 'local',
        runId: 'secondary-save'
      }),
      observed = running.catch((error) => error)
    try {
      await reached.promise
      const paused = runtime.pause('secondary-save', sessionKey)
      await microtasks()
      expect(execution().isQuiescent()).toBe(false)
      finish.resolve()
      expect(await observed).toMatchObject({ status: 'failed', error: original.message })
      await paused
      expect(fenceRejections).toBe(1)
    } finally {
      finish.resolve()
      execution()?.resume()
      await observed
    }
  })

  it('does not fabricate success when the new successful-node fence rejects', async () => {
    let channelSnapshots = 0
    const failure = new Error('successful node final snapshot failed')
    const runtime = new MagicAgentGraphRuntime([baseGraph()], {
      runAgent: async (request) => completed(request.agentId),
      runStore: runStore(async (snapshot) => {
        if (
          snapshot.events?.at(-1)?.type === 'channel.message' &&
          snapshot.nodes?.find((node) => node.nodeId === 'first')?.status === 'completed' &&
          ++channelSnapshots === 2
        )
          throw failure
      })
    })
    expect(
      await runtime.run({
        graphId: 'test.graph-scoped',
        route,
        input: 'local',
        runId: 'success-fence-fail'
      })
    ).toMatchObject({ status: 'failed', error: failure.message })
    expect(channelSnapshots).toBe(2)
  })

  it('propagates synchronous event append failure and settles its owned failure publication', async () => {
    const journal = new MagicAgentGraphRunEventStore(':memory:'),
      append = journal.append.bind(journal),
      failure = new Error('node completed event append failed'),
      execution = captureController(),
      reached = deferred(),
      finish = deferred()
    vi.spyOn(journal, 'append').mockImplementation((event) => {
      if (event.type === 'node.completed') throw failure
      return append(event)
    })
    let held = false
    const runtime = new MagicAgentGraphRuntime([baseGraph()], {
      runEventStore: journal,
      runAgent: async (request) => completed(request.agentId),
      runStore: runStore(async (snapshot) => {
        if (!held && snapshot.events?.at(-1)?.type === 'node.failed') {
          held = true
          reached.resolve()
          await finish.promise
        }
      })
    })
    const running = runtime.run({
        graphId: 'test.graph-scoped',
        route,
        input: 'local',
        runId: 'sync-append'
      }),
      observed = running.catch((error) => error)
    try {
      await reached.promise
      const paused = runtime.pause('sync-append', sessionKey)
      await microtasks()
      expect(execution().isQuiescent()).toBe(false)
      finish.resolve()
      expect(await observed).toMatchObject({ status: 'failed', error: failure.message })
      await paused
    } finally {
      finish.resolve()
      execution()?.resume()
      await observed
      journal.close()
    }
  })

  it('keeps a save queued by synchronous failure-publication reentry owned when that publication throws', async () => {
    const journal = new MagicAgentGraphRunEventStore(':memory:'),
      failure = new Error('failure event subscriber threw'),
      execution = captureController(),
      reached = deferred(),
      finish = deferred()
    let pause: ReturnType<MagicAgentGraphRuntime['pause']> | undefined,
      held = false,
      pauseSettled = false
    const runId = 'failure-publication-reentry'
    const runtime = new MagicAgentGraphRuntime([baseGraph()], {
      runEventStore: journal,
      runAgent: async () => {
        throw new Error('original node failure')
      },
      runStore: runStore(async (snapshot) => {
        if (!held && snapshot.status === 'pausing') {
          held = true
          reached.resolve()
          await finish.promise
        }
      })
    })
    const unsubscribe = journal.subscribe(runId, (event) => {
      if (event.kind === 'node.failed') {
        pause = runtime.pause(runId, sessionKey).then((result) => {
          pauseSettled = true
          return result
        })
        throw failure
      }
    })
    const running = runtime.run({ graphId: 'test.graph-scoped', route, input: 'local', runId }),
      observed = running.catch((error) => error)
    try {
      await reached.promise
      await microtasks()
      expect(pauseSettled).toBe(false)
      expect(execution().isQuiescent()).toBe(false)
      finish.resolve()
      expect(await observed).toMatchObject({ status: 'failed', error: failure.message })
      await pause
      expect(pauseSettled).toBe(true)
    } finally {
      finish.resolve()
      execution()?.resume()
      runtime.resume(runId, sessionKey)
      await observed
      await pause
      unsubscribe()
      journal.close()
    }
  })

  it('retains final-output ownership after a later synchronous output append fails', async () => {
    const graph = baseGraph()
    graph.outputs.push({ ...graph.outputs[0], outputId: 'second-answer', name: 'Second answer' })
    const journal = new MagicAgentGraphRunEventStore(':memory:'),
      append = journal.append.bind(journal),
      failure = new Error('second output append failed'),
      reached = deferred(),
      finish = deferred(),
      execution = captureController()
    vi.spyOn(journal, 'append').mockImplementation((event) => {
      if (event.type === 'output.created' && event.metadata?.outputId === 'second-answer')
        throw failure
      return append(event)
    })
    let held = false,
      acknowledgement: Promise<unknown> | undefined
    const runtime = new MagicAgentGraphRuntime([graph], {
      runEventStore: journal,
      runAgent: async (request) => completed(request.agentId),
      runStore: runStore(async (snapshot) => {
        if (
          !held &&
          snapshot.events?.at(-1)?.type === 'output.created' &&
          snapshot.events.at(-1)?.metadata?.outputId === 'answer'
        ) {
          held = true
          reached.resolve()
          await finish.promise
        }
      })
    })
    const running = runtime.run({
        graphId: graph.graphId,
        route,
        input: 'local',
        runId: 'second-output-append'
      }),
      observed = running.catch((error) => error)
    try {
      await reached.promise
      let acknowledged = false
      acknowledgement = execution()
        .requestPause()
        .then(
          (ticket) => {
            acknowledged = true
            return ticket
          },
          (error) => error
        )
      await microtasks()
      expect(execution().isQuiescent()).toBe(false)
      expect(acknowledged).toBe(false)
      finish.resolve()
      expect(await observed).toMatchObject({ status: 'failed', error: failure.message })
      await acknowledgement
      expect(execution().isQuiescent()).toBe(true)
    } finally {
      finish.resolve()
      execution()?.resume()
      await observed
      await acknowledgement
      journal.close()
    }
  })

  it('binds first-party callbacks to a live tool child and revokes it after settlement', async () => {
    const graph = baseGraph()
    graph.nodes = [
      {
        nodeId: 'first',
        kind: 'tool',
        name: 'First party',
        description: 'Trusted fixture',
        config: { firstParty: { family: 'llm', operation: 'infer', config: {} } }
      }
    ]
    graph.channels = []
    graph.outputs[0].sourceNodeId = 'first'
    delete graph.outputs[0].channelId
    let saved: CooperativeOperationGate | undefined
    const runtime = new MagicAgentGraphRuntime([graph], {
      firstPartyNodeExecutor: async (request) => {
        saved = request.cooperativeExecution
        expect(saved).toBeDefined()
        await saved!.run('assistant-turn', request.signal, async (inference) => {
          await inference.run('llm-inference', request.signal, () => undefined)
        })
        return 'local first-party response'
      }
    })
    expect(
      await runtime.run({ graphId: graph.graphId, route, input: 'local', runId: 'first-party' })
    ).toMatchObject({ status: 'completed' })
    await expect(saved!.run('assistant-turn', undefined, () => undefined)).rejects.toMatchObject({
      code: 'COOPERATIVE_SCOPE_RELEASED'
    })
  })
})
