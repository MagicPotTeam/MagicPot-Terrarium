import { describe, expect, it, vi } from 'vitest'
import type { AgentThreadEventView } from '@shared/api/agentThreadInbox'
import {
  THREAD_EVENT_REFUSED_RETRY_MS,
  ThreadEventPump,
  type ThreadEventPumpHost,
  type ThreadEventRunOutcome,
  type ThreadEventSessionState
} from './threadEventPump'

const view = (id: string, conversationId: string, createdAt: number): AgentThreadEventView => ({
  id,
  conversationId,
  type: 'trigger_fire',
  source: 'synthetic-timer',
  text: `synthetic ${id}`,
  createdAt,
  expiresAt: createdAt + 1000
})

function harness(options: {
  events: AgentThreadEventView[]
  states?: Record<string, ThreadEventSessionState>
  outcome?: ThreadEventRunOutcome
}) {
  let queued = [...options.events]
  const states = options.states ?? {}
  const runs: string[] = []
  const finish: Array<() => void> = []
  const host = {
    isCurrent: vi.fn(() => true),
    sessionState: vi.fn((id: string) => states[id] ?? 'ready'),
    list: vi.fn(async () => queued),
    claim: vi.fn(async (id: string) => {
      const event = queued.find((item) => item.id === id)
      if (!event) return undefined
      queued = queued.filter((item) => item.id !== id)
      return { ...event, lease: `lease-${id}` }
    }),
    release: vi.fn(async (id: string) => {
      if (options.outcome !== 'refused') return false
      queued = [...options.events.filter((item) => item.id === id), ...queued]
      return true
    }),
    expire: vi.fn(async (conversationId: string) => {
      queued = queued.filter((item) => item.conversationId !== conversationId)
    }),
    run: vi.fn(
      (event: AgentThreadEventView & { lease: string }) =>
        new Promise<ThreadEventRunOutcome>((resolve) => {
          runs.push(event.id)
          finish.push(() => resolve(options.outcome ?? 'dispatched'))
        })
    ),
    wake: vi.fn()
  } satisfies ThreadEventPumpHost
  return { host, runs, finish, states }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('thread event wake pump', () => {
  it('runs the oldest event of each session, one at a time per session, catch-up included', async () => {
    const { host, runs, finish } = harness({
      events: [view('a1', 'a', 1), view('b1', 'b', 2), view('a2', 'a', 3)]
    })
    const pump = new ThreadEventPump(host)
    await pump.tick()
    expect(runs).toEqual(['a1', 'b1'])
    await pump.tick()
    expect(runs).toEqual(['a1', 'b1'])
    finish[0]()
    await settle()
    expect(host.wake).toHaveBeenCalled()
    await pump.tick()
    expect(runs).toEqual(['a1', 'b1', 'a2'])
  })

  it('claims nothing for a busy or held session, and leaves its events queued', async () => {
    const { host, runs } = harness({ events: [view('a1', 'a', 1)], states: { a: 'wait' } })
    await new ThreadEventPump(host).tick()
    expect(host.claim).not.toHaveBeenCalled()
    expect(runs).toEqual([])
  })

  it('expires the events of a removed or unavailable session and never runs them', async () => {
    const { host, runs } = harness({
      events: [view('a1', 'a', 1), view('a2', 'a', 2), view('m1', 'member', 3)],
      states: { a: 'removed', member: 'unavailable' }
    })
    await new ThreadEventPump(host).tick()
    expect(host.expire).toHaveBeenCalledWith('a', 'session-removed')
    expect(host.expire).toHaveBeenCalledWith('member', 'session-unavailable')
    expect(host.claim).not.toHaveBeenCalled()
    expect(runs).toEqual([])
  })

  it('releases a claim whose session became busy before the turn started', async () => {
    const { host, runs } = harness({ events: [view('a1', 'a', 1)] })
    host.sessionState.mockReturnValueOnce('ready').mockReturnValueOnce('wait')
    await new ThreadEventPump(host).tick()
    expect(host.release).toHaveBeenCalledWith('a1', 'a', 'lease-a1')
    expect(runs).toEqual([])
  })

  it('releases after the turn (a no-op once MAIN started it) and keeps the claim of a queued send', async () => {
    const dispatched = harness({ events: [view('a1', 'a', 1)] })
    await new ThreadEventPump(dispatched.host).tick()
    dispatched.finish[0]()
    await settle()
    expect(dispatched.host.release).toHaveBeenCalledWith('a1', 'a', 'lease-a1')
    const queued = harness({ events: [view('a1', 'a', 1)], outcome: 'queued' })
    await new ThreadEventPump(queued.host).tick()
    queued.finish[0]()
    await settle()
    expect(queued.host.release).not.toHaveBeenCalled()
  })

  it('waits before claiming again an event whose turn never went out', async () => {
    let now = 1000
    const { host, runs, finish } = harness({ events: [view('a1', 'a', 1)], outcome: 'refused' })
    const pump = new ThreadEventPump(host, () => now)
    await pump.tick()
    finish[0]()
    await settle()
    await pump.tick()
    expect(runs).toEqual(['a1'])
    now += THREAD_EVENT_REFUSED_RETRY_MS
    await pump.tick()
    expect(runs).toEqual(['a1', 'a1'])
  })

  it('stops claiming once the page or scope is no longer current, and after end()', async () => {
    const { host } = harness({ events: [view('a1', 'a', 1)] })
    host.isCurrent.mockReturnValue(false)
    const pump = new ThreadEventPump(host)
    await pump.tick()
    expect(host.list).not.toHaveBeenCalled()
    host.isCurrent.mockReturnValue(true)
    pump.end()
    await pump.tick()
    expect(host.list).not.toHaveBeenCalled()
  })

  it('a failed poll claims nothing and the next poll still runs', async () => {
    const { host, runs } = harness({ events: [view('a1', 'a', 1)] })
    host.list.mockRejectedValueOnce(new Error('fixture IPC unavailable'))
    const pump = new ThreadEventPump(host)
    await pump.tick()
    expect(runs).toEqual([])
    await pump.tick()
    expect(runs).toEqual(['a1'])
  })
})
