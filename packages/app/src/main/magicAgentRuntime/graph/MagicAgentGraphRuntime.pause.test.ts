import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MagicAgentGraphDefinition, MagicAgentGraphRunStreamEvent } from '@shared/magicAgent'
import { CooperativeExecutionController } from '../../magicAgentPlatform2/agents/cooperativeExecutionController'
import { MagicAgentGraphRuntime } from './MagicAgentGraphRuntime'
import { MagicAgentGraphRunEventStore } from './graphRunEventStore'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function microtasks() { for (let i = 0; i < 20; i++) await Promise.resolve() }
afterEach(() => vi.restoreAllMocks())

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'pause-ticket-graph' } as const
const session = 'generic:dm:pause-ticket-graph'
const graph: MagicAgentGraphDefinition = {
  graphId: 'test.pause-tickets', name: 'Pause tickets', description: 'Pause acknowledgement test.', version: '1', tags: [],
  entryNodeIds: ['worker'], nodes: [{ nodeId: 'worker', kind: 'agent', name: 'Worker', description: 'Work' }],
  channels: [], outputs: [{ outputId: 'answer', name: 'Answer', description: 'Answer', sourceNodeId: 'worker', mimeType: 'text/plain' }]
}

function scenario() {
  const started = deferred(), finish = deferred()
  let execution!: CooperativeExecutionController
  const original = CooperativeExecutionController.prototype.requestPause
  const capture = (controller: CooperativeExecutionController): void => { execution = controller }
  vi.spyOn(CooperativeExecutionController.prototype, 'requestPause').mockImplementation(function (this: CooperativeExecutionController) {
    capture(this)
    return Reflect.apply(original, this, [])
  })
  const runtime = new MagicAgentGraphRuntime([graph], { runAgent: async request => {
    started.resolve(); await finish.promise
    return { runId: 'scripted-agent', agentId: request.agentId || 'worker', status: 'completed', content: 'done', messages: [], toolCalls: [], events: [], startedAt: 1, finishedAt: 2 }
  } })
  const running = runtime.run({ graphId: graph.graphId, input: 'test', route, runId: 'ticket-run' })
  const pause = () => runtime.pause('ticket-run', session)
  const resume = () => runtime.resume('ticket-run', session)
  const current = () => runtime.getRun('ticket-run', session)!
  const events = () => current().events || []
  const close = async () => { runtime.cancel('ticket-run', session, 'test cleanup'); finish.resolve(); await running }
  return { runtime, running, pause, resume, current, events, started, finish, close, get execution() { return execution } }
}

function eventType(event: MagicAgentGraphRunStreamEvent): string {
  return event.type === 'event' ? event.event?.type || 'missing-event' : event.type
}

describe('graph pause acknowledgement consumers (not full graph drainage)', () => {
  it('does not overwrite a same-turn idle resume with a resolved old pause', async () => {
    const s = scenario()
    try {
      const old = s.pause(); expect(s.resume().resumed).toBe(true)
      expect((await old).paused).toBe(false)
      expect(s.current().status).toBe('running'); expect(s.execution.isPaused()).toBe(false)
      expect(s.events().filter(event => event.type === 'graph.paused')).toHaveLength(0)
    } finally { await s.close() }
  })

  it('keeps the old acknowledgement stale when a fresh pause follows resume in the same turn', async () => {
    const s = scenario()
    try {
      const old = s.pause(); s.resume(); const fresh = s.pause()
      expect((await old).paused).toBe(false); expect((await fresh).paused).toBe(true)
      expect(s.current().status).toBe('paused'); expect(s.execution.isPaused()).toBe(true)
      expect(s.events().filter(event => event.type === 'graph.paused')).toHaveLength(1)
    } finally { await s.close() }
  })

  it('withdraws a waiting pause on resume without waiting for or releasing its active node', async () => {
    const s = scenario()
    try {
      await s.started.promise
      let settled = false
      const old = s.pause().then(result => { settled = true; return result })
      s.resume(); await microtasks()
      expect(settled).toBe(true); expect(s.execution.isQuiescent()).toBe(false)
      expect((await old).paused).toBe(false); expect(s.current().status).toBe('running')
    } finally { await s.close() }
  })

  it('deduplicates simultaneous same-generation graph paused publication', async () => {
    const s = scenario()
    try {
      const results = await Promise.all([s.pause(), s.pause(), s.pause()])
      expect(results.map(result => result.paused)).toEqual([true, true, true])
      expect(s.events().filter(event => event.type === 'graph.pause.requested')).toHaveLength(1)
      expect(s.events().filter(event => event.type === 'graph.paused')).toHaveLength(1)
    } finally { await s.close() }
  })

  it('revalidates an already-paused run instead of acknowledging late legacy active work', async () => {
    const s = scenario()
    try {
      expect((await s.pause()).paused).toBe(true)
      expect(() => s.execution.enter('graph-node')).toThrow(
        expect.objectContaining({ code: 'COOPERATIVE_EXECUTION_PAUSED' })
      )
      // Synthetic pre-hardening/corrupt state only: public paused entry now
      // rejects. Keep real registration/release and the consumer recheck below.
      const leave = Reflect.apply(Reflect.get(s.execution, 'registerActive'), s.execution, [
        'graph-node'
      ]) as () => void
      let repeated!: ReturnType<typeof s.pause>
      try {
        let acknowledged = false
        repeated = s.pause().then(result => { acknowledged = true; return result })
        await microtasks(); expect(acknowledged).toBe(false)
      } finally { leave() }
      expect((await repeated).paused).toBe(true)
      expect(s.events().filter(event => event.type === 'graph.paused')).toHaveLength(1)
    } finally { await s.close() }
  })

  it.each([false, true])('cannot reassert an old pause after requested-event reentry resume with newPause=%s', async rePause => {
    const s = scenario(), seenA: string[] = [], seenB: string[] = []
    let acted = false, fresh: ReturnType<typeof s.pause> | undefined
    s.runtime.subscribeToRun('ticket-run', session, event => {
      seenA.push(eventType(event))
      if (eventType(event) === 'graph.pause.requested' && !acted) {
        acted = true; s.resume()
        if (rePause) fresh = s.pause()
      }
    })
    s.runtime.subscribeToRun('ticket-run', session, event => { seenB.push(eventType(event)) })
    try {
      const old = await s.pause()
      expect(old.paused).toBe(false); expect(acted).toBe(true)
      expect(seenA).toContain('graph.resumed'); expect(seenB).toContain('graph.resumed')
      // State correctness only: synchronous reentrant fan-out delivery order is
      // explicitly not guaranteed or asserted by this ticket repair.
      if (rePause) {
        expect(fresh).toBeDefined(); expect((await fresh!).paused).toBe(true)
        expect(s.current().status).toBe('paused'); expect(s.execution.isPaused()).toBe(true)
      } else {
        expect(s.current().status).toBe('running'); expect(s.execution.isPaused()).toBe(false)
      }
    } finally { await s.close() }
  })

  it('invalidates before resumed-event publication so a reentrant fresh pause is not withdrawn afterwards', async () => {
    const s = scenario(), seenB: string[] = []
    let fresh: ReturnType<typeof s.pause> | undefined
    try {
      await s.pause()
      s.runtime.subscribeToRun('ticket-run', session, event => {
        if (eventType(event) === 'graph.resumed' && !fresh) fresh = s.pause()
      })
      s.runtime.subscribeToRun('ticket-run', session, event => { seenB.push(eventType(event)) })
      s.resume(); expect(fresh).toBeDefined()
      expect((await fresh!).paused).toBe(true)
      expect(s.current().status).toBe('paused'); expect(s.execution.isPaused()).toBe(true)
      expect(seenB).toContain('graph.resumed'); expect(seenB).toContain('graph.paused')
    } finally { await s.close() }
  })

  it('does not return a current paused success when a paused-event subscriber synchronously resumes', async () => {
    const s = scenario()
    s.runtime.subscribeToRun('ticket-run', session, event => {
      if (eventType(event) === 'graph.paused') s.resume()
    })
    try {
      expect((await s.pause()).paused).toBe(false)
      expect(s.current().status).toBe('running'); expect(s.execution.isPaused()).toBe(false)
    } finally { await s.close() }
  })

  it('cannot overwrite a terminal completed run with a delayed still-paused current ticket', async () => {
    const s = scenario(), releaseAck = deferred()
    // Remove the capture spy before wrapping the actual method. Trigger pause at
    // output publication, after the final checkpoint: a legitimate unowned gap
    // where this ticket-only slice must not resurrect the terminal graph state.
    vi.restoreAllMocks()
    const original = CooperativeExecutionController.prototype.requestPause
    vi.spyOn(CooperativeExecutionController.prototype, 'requestPause').mockImplementation(async function (this: CooperativeExecutionController) {
      const ticket = await Reflect.apply(original, this, [])
      await releaseAck.promise
      return ticket
    })
    let pending: ReturnType<typeof s.pause> | undefined
    s.runtime.subscribeToRun('ticket-run', session, event => {
      if (eventType(event) === 'output.created') pending = s.pause()
    })
    try {
      await s.started.promise
      s.finish.resolve(); expect((await s.running).status).toBe('completed')
      expect(pending).toBeDefined(); releaseAck.resolve()
      expect((await pending!).paused).toBe(false); expect(s.current().status).toBe('completed')
      expect(s.events().filter(event => event.type === 'graph.paused')).toHaveLength(0)
    } finally { releaseAck.resolve(); await s.close() }
  })

  it('does not overwrite cancellation from a requested-event subscriber', async () => {
    const s = scenario()
    s.runtime.subscribeToRun('ticket-run', session, event => {
      if (eventType(event) === 'graph.pause.requested') s.runtime.cancel('ticket-run', session, 'reentrant cancel')
    })
    try {
      expect((await s.pause()).paused).toBe(false)
      expect(s.current().status).toBe('cancelled')
    } finally { await s.close() }
  })

  it.each(['pending', 'rejected'])('observes an abandoned %s acknowledgement when requested-event persistence throws without withdrawing the gate', async state => {
    const s = scenario(), journal = new MagicAgentGraphRunEventStore(':memory:')
    const append = journal.append.bind(journal), failure = new Error('requested-event persistence failure')
    s.runtime.setDeps({ runEventStore: journal })
    // Observe the real acknowledgement without allowing an intentionally red
    // assertion to leak an unhandled rejection into unrelated Vitest cases.
    vi.restoreAllMocks()
    const request = CooperativeExecutionController.prototype.requestPause
    const capture = (controller: CooperativeExecutionController): void => { gate = controller }
    let gate!: CooperativeExecutionController
    let acknowledgement!: Promise<unknown>
    let rejectionObserved = false
    CooperativeExecutionController.prototype.requestPause = function (this: CooperativeExecutionController) {
      capture(this)
      const pending = Reflect.apply(request, this, [])
      // Keep the actual pause active even when injecting an immediate ack error.
      acknowledgement = state === 'pending' ? pending : Promise.reject(new Error('ack failure'))
      if (state === 'rejected') void pending.catch(() => undefined)
      Object.defineProperty(acknowledgement, 'then', { value: (fulfilled: unknown, rejected: unknown) => {
        if (typeof rejected === 'function') rejectionObserved = true
        return Reflect.apply(Promise.prototype.then, acknowledgement, [fulfilled, rejected])
      } })
      return acknowledgement as ReturnType<typeof request>
    }
    // Only requested-event writes fail; cleanup and later events keep working.
    vi.spyOn(journal, 'append').mockImplementation(event => {
      if (event.type === 'graph.pause.requested') throw failure
      return append(event)
    })
    try {
      await s.started.promise
      await expect(s.pause()).rejects.toBe(failure)
      expect(gate.isPaused()).toBe(true); expect(gate.isQuiescent()).toBe(false)
      expect(s.current().status).toBe('pausing')
      expect(rejectionObserved).toBe(true)
      expect(s.events().filter(event => event.type === 'graph.paused')).toHaveLength(0)
    } finally {
      CooperativeExecutionController.prototype.requestPause = request
      if (acknowledgement) Reflect.apply(Promise.prototype.then, acknowledgement, [() => undefined, () => undefined])
      s.resume(); await s.close(); journal.close()
    }
  })

  it('propagates a non-supersession pause failure rather than presenting it as resume or success', async () => {
    const s = scenario(), failure = new Error('pause failure')
    vi.spyOn(CooperativeExecutionController.prototype, 'requestPause').mockRejectedValueOnce(failure)
    try { await expect(s.pause()).rejects.toBe(failure) } finally { await s.close() }
  })
})
