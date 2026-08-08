import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { TriggerExecutionOutcomeStore } from './executionOutcomeStore'

const roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})
const record = (store: TriggerExecutionOutcomeStore) =>
  store.recordPermitConsumed({
    triggerId: 'trigger-1',
    occurrenceAt: 100,
    authorizationId: 'authorization-1',
    requestDigest: 'sha256:' + 'a'.repeat(64),
    consumedAt: 1000
  })

describe('TriggerExecutionOutcomeStore', () => {
  it('records permit consumption idempotently and rejects identity conflicts', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new TriggerExecutionOutcomeStore(eventStore)
    const first = record(store)
    expect(record(store)).toEqual(first)
    expect(() =>
      store.recordPermitConsumed({
        triggerId: 'other',
        occurrenceAt: 100,
        authorizationId: 'authorization-1',
        requestDigest: 'sha256:' + 'a'.repeat(64),
        consumedAt: 1000
      })
    ).toThrow()
    eventStore.close()
  })

  it('allows only permit-consumed to success or failure with redacted bounded evidence', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new TriggerExecutionOutcomeStore(eventStore)
    const created = record(store)
    const success = store.complete(created.id, 'succeeded', 1001, {
      secret: 'hidden',
      value: 'ok'.repeat(2000)
    })
    expect(success.state.status).toBe('succeeded')
    expect(JSON.stringify(success.state)).not.toContain('hidden')
    expect(JSON.stringify(success.state.result).length).toBeLessThan(5000)
    expect(() => store.complete(created.id, 'failed', 1002, { error: 'later' })).toThrow()
    eventStore.close()
  })

  it('reopens and exposes consumed outcomes as uncertain without replaying', () => {
    const root = resolve(`.tmp-trigger-outcome-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    roots.push(root)
    const path = resolve(root, 'events.db')
    const firstEventStore = new MagicAgentEventStore(path)
    record(new TriggerExecutionOutcomeStore(firstEventStore))
    firstEventStore.close()
    const secondEventStore = new MagicAgentEventStore(path)
    const reopened = new TriggerExecutionOutcomeStore(secondEventStore)
    expect(reopened.listUncertain()[0].state.status).toBe('outcome-unknown')
    expect(reopened.list()[0].state.status).toBe('permit-consumed')
    secondEventStore.close()
  })

  it.each([
    ['triggerId', { triggerId: 'other' }],
    ['occurrenceAt', { occurrenceAt: 101 }],
    ['consumedAt', { consumedAt: 1001 }]
  ])(
    'rejects same execution identity with changed %s',
    (_field, patch: { triggerId?: string; occurrenceAt?: number; consumedAt?: number }) => {
      const eventStore = new MagicAgentEventStore(':memory:')
      const store = new TriggerExecutionOutcomeStore(eventStore)
      record(store)
      expect(() =>
        store.recordPermitConsumed({
          triggerId: patch.triggerId ?? 'trigger-1',
          occurrenceAt: patch.occurrenceAt ?? 100,
          authorizationId: 'authorization-1',
          requestDigest: 'sha256:' + 'a'.repeat(64),
          consumedAt: patch.consumedAt ?? 1000
        })
      ).toThrow()
      eventStore.close()
    }
  )

  it('bounds deep, wide, long-array, and oversized evidence without leaking secrets', () => {
    let deep: Record<string, unknown> = { secret: 'deep-secret' }
    for (let index = 0; index < 20; index++) deep = { nested: deep }
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`key-${index}`, index])
    )
    const array = Array.from({ length: 100 }, (_, index) => ({ token: `token-${index}` }))
    const oversized = { payload: 'x'.repeat(10_000), secret: 'oversized-secret' }
    for (const value of [deep, wide, array, oversized]) {
      const eventStore = new MagicAgentEventStore(':memory:')
      const store = new TriggerExecutionOutcomeStore(eventStore)
      const created = record(store)
      const completed = store.complete(created.id, 'succeeded', 1001, value)
      const serialized = JSON.stringify(completed.state.result)
      expect(serialized.length).toBeLessThan(4096)
      expect(serialized).not.toContain('secret')
      expect(serialized).not.toContain('token-')
      eventStore.close()
    }
  })
})
