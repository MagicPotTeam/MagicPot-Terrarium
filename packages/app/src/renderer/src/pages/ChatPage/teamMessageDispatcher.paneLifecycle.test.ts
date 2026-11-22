import { describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher, type TeamDispatchEntry, type TeamDispatchStage } from './teamMessageDispatcher'

describe('simulated pane host lifecycle', () => {
  it('retains the old snapshot while a new dispatcher starts empty and resubscribes', () => {
    const team = { scope: 'synthetic-scope', thread: 'synthetic-thread', lead: 'synthetic-lead' }
    const members = ['a', 'b']
    const deliver = vi.fn(async () => {})
    let alive = true
    let snapshot: readonly TeamDispatchEntry[] = []
    const make = (current: () => boolean) => new TeamMessageDispatcher(team, current, id => members.includes(id), [], deliver, entries => { if (current()) snapshot = entries }, 1000, () => true)
    const old = make(() => alive)
    const oldKnown = new Set<string>()
    for (const id of members) if (!oldKnown.has(id)) { old.subscribe(id); oldKnown.add(id) }
    old.unsubscribe('b')
    old.enqueue({ id: 'synthetic-id', source: { ...team, kind: 'user' }, kind: 'channel', hop: 1, text: 'synthetic message' })
    expect(snapshot.map(entry => [entry.recipient, entry.status])).toEqual([['a', 'queued']])
    expect(old.pump('a')).toBeUndefined()
    expect(deliver).not.toHaveBeenCalled()

    alive = false
    old.end()
    expect(old.entries()[0].status).toBe('unavailable')
    expect(snapshot[0].status).toBe('queued')
    expect(() => old.pump('a')).toThrow()

    let nextAlive = true
    const next = make(() => nextAlive)
    const nextKnown = new Set<string>()
    for (const id of members) if (!nextKnown.has(id)) { next.subscribe(id); nextKnown.add(id) }
    expect(next.isSubscribed('b')).toBe(true)
    expect(next.entries()).toEqual([])
    expect(next.pump('a')).toBeUndefined()
    expect(next.pump('b')).toBeUndefined()
    expect(snapshot[0].status).toBe('queued')
    expect(deliver).not.toHaveBeenCalled()
    nextAlive = false
    next.end()
  })

  it('does not treat a claimed delivery without a start callback as proof of no side effect', async () => {
    const team = { scope: 'synthetic-scope', thread: 'synthetic-thread', lead: 'synthetic-lead' }
    const members = ['a', 'b']
    const effects: string[] = []
    let releaseGate = () => {}
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    let deliveryFinished = false
    let lateStage: ((stage: TeamDispatchStage) => void) | undefined
    let alive = true
    let snapshot: readonly TeamDispatchEntry[] = []
    const deliver = vi.fn(async (delivery: { id: string }, _source: unknown, stage: (stage: TeamDispatchStage) => void) => {
      effects.push(delivery.id)
      lateStage = stage
      await gate
      deliveryFinished = true
    })
    const old = new TeamMessageDispatcher(team, () => alive, id => members.includes(id), [], deliver, entries => {
      if (alive) snapshot = entries
    })
    old.enqueue({ id: 'synthetic-claimed', source: { ...team, kind: 'member', member: 'a' }, kind: 'message', hop: 1, recipient: 'b', text: 'synthetic message' })
    let pending: Promise<void> | undefined
    try {
      pending = old.pump('b')
      expect(pending).toBeInstanceOf(Promise)
      expect(effects).toEqual(['synthetic-claimed'])
      expect(deliver).toHaveBeenCalledOnce()
      expect(deliveryFinished).toBe(false)
      expect(lateStage).toBeTypeOf('function')
      expect(snapshot[0].status).toBe('queued')
      alive = false
      old.end()
      expect(old.entries()[0].status).toBe('unavailable')
      expect(snapshot[0].status).toBe('queued')
      const next = new TeamMessageDispatcher(team, () => true, id => members.includes(id), [], deliver)
      expect(next.entries()).toEqual([])
      expect(next.pump('b')).toBeUndefined()
      next.end()
      lateStage?.('request_started')
      lateStage?.('response_received')
    } finally {
      releaseGate()
      await pending
      await Promise.all(deliver.mock.results.map(result => result.value))
    }
    expect(deliveryFinished).toBe(true)
    expect(old.entries()[0].status).toBe('unavailable')
    expect(snapshot[0].status).toBe('queued')
    expect(effects).toEqual(['synthetic-claimed'])
    expect(deliver).toHaveBeenCalledOnce()
  })
})
