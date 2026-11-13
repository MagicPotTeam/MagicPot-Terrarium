import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('./chatStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chatStorage')>(),
  saveSessionToDB: fake.save
}))

import { ChatSessionSaveConflictError, type ChatSession } from './chatStorage'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'

const session = (content: string): ChatSession => ({
  id: 'synthetic-session', title: 'synthetic', messages: [{ role: 'user', content }]
})

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe('persistLatest queued synthetic CAS', () => {
  beforeEach(() => { fake.save.mockReset() })

  it.each([false, true])('handles a queued later snapshot with external conflict=%s', async (externalConflict) => {
    const writer = new ChatSessionSaveBaseline()
    const v0 = session('v0'), v1 = session('v1'), v2 = session('v2'), external = session('external')
    const store = new Map<string, string>([['scope', JSON.stringify(v0)]])
    const initialV2 = JSON.stringify(v2)
    const externalBytes = JSON.stringify(external)
    const gate = deferred(), reached = deferred()
    const calls: Array<{ payload: string; expected: string; scope: string }> = []
    const events: string[] = []
    const errors = [new ChatSessionSaveConflictError(v0.id, 'scope'), new ChatSessionSaveConflictError(v0.id, 'scope')]
    let current = v1
    const ack1 = vi.fn(), ack2 = vi.fn()

    // A deliberately limited CAS fake: it checks stored bytes at commit, but does
    // not model IndexedDB scheduling or the production shouldUpdate guard.
    fake.save.mockImplementation(async (payload: ChatSession, scope: string, options: { expectedSession: ChatSession | null; pendingSaveOwner: null }) => {
      const index = calls.length
      calls.push({ payload: JSON.stringify(payload), expected: JSON.stringify(options.expectedSession), scope })
      events.push(`start:${index + 1}`)
      expect(options.pendingSaveOwner).toBeNull()
      if (index === 0) { reached.release(); await gate.promise }
      if (store.get(scope) !== JSON.stringify(options.expectedSession)) {
        events.push(`conflict:${index + 1}`)
        throw errors[index]
      }
      store.set(scope, JSON.stringify(payload))
      events.push(`commit:${index + 1}`)
    })

    const first = writer.persistLatest('scope', v1.id, () => current, () => v0, ack1)
    const firstResult = first.then(value => ({ value }), error => ({ error }))
    let secondResult: Promise<{ value: ChatSession | null } | { error: unknown }> | undefined
    try {
      await reached.promise
      current = v2
      const second = writer.persistLatest('scope', v2.id, () => current, () => v0, ack2)
      secondResult = second.then(value => ({ value }), error => ({ error }))
      if (externalConflict) store.set('scope', externalBytes)
      expect(fake.save).toHaveBeenCalledTimes(1)
      gate.release()
      const [firstOutcome, secondOutcome] = await Promise.all([firstResult, secondResult])
      expect(fake.save).toHaveBeenCalledTimes(2)
      expect(calls).toEqual([
        { payload: JSON.stringify(v1), expected: JSON.stringify(v0), scope: 'scope' },
        { payload: JSON.stringify(v2), expected: JSON.stringify(externalConflict ? v0 : v1), scope: 'scope' }
      ])
      expect(JSON.stringify(v2)).toBe(initialV2)
      expect(current).toBe(v2)
      if (externalConflict) {
        expect(firstOutcome).toEqual({ error: errors[0] })
        expect(secondOutcome).toEqual({ error: errors[1] })
        expect('error' in firstOutcome && firstOutcome.error).toBe(errors[0])
        expect('error' in secondOutcome && secondOutcome.error).toBe(errors[1])
        expect(errors[0]).toBeInstanceOf(ChatSessionSaveConflictError)
        expect(errors[1]).toBeInstanceOf(ChatSessionSaveConflictError)
        expect(events).toEqual(['start:1', 'conflict:1', 'start:2', 'conflict:2'])
        expect(store.get('scope')).toBe(externalBytes)
        expect(ack1).not.toHaveBeenCalled()
        expect(ack2).not.toHaveBeenCalled()
      } else {
        expect(firstOutcome).toEqual({ value: v1 })
        expect(secondOutcome).toEqual({ value: v2 })
        expect(events).toEqual(['start:1', 'commit:1', 'start:2', 'commit:2'])
        expect(store.get('scope')).toBe(initialV2)
        expect(ack1).toHaveBeenCalledTimes(1)
        expect(ack2).toHaveBeenCalledTimes(1)
      }
    } finally {
      gate.release()
      await firstResult
      if (secondResult) await secondResult
    }
  })
})
