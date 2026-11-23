import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { AGENT_THREAD_INBOX_LIMITS } from '@shared/api/agentThreadInbox'
import {
  THREAD_EVENT_KIND,
  THREAD_EVENT_STATE_KIND,
  ThreadInboxStore,
  type ThreadEventAppend
} from './agentThreadInboxStore'

const session = {
  storageScope: 'scope',
  routeKey: 'canvas:thread:project:pane',
  conversationId: 'a'
}
const event = (over: Partial<ThreadEventAppend> = {}): ThreadEventAppend => ({
  ...session,
  type: 'trigger_fire',
  source: 'synthetic-timer',
  text: 'synthetic tick',
  ...over
})
const directories: string[] = []
const stores: ThreadInboxStore[] = []
function file(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'thread-inbox-store-'))
  directories.push(directory)
  return join(directory, 'events.sqlite')
}
function open(path: string, boot = 'boot-a', now: () => number = Date.now): ThreadInboxStore {
  const store = new ThreadInboxStore(new MagicAgentEventStore(path), boot, now)
  stores.push(store)
  return store
}
function reopen(store: ThreadInboxStore, path: string, boot: string, now?: () => number) {
  store.close()
  stores.splice(stores.indexOf(store), 1)
  return open(path, boot, now)
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable thread event store', () => {
  it('writes the event once and only the small state record afterwards, ending done after one start', () => {
    const path = file()
    const store = open(path)
    const { event: queued, duplicate } = store.append(event())
    expect(duplicate).toBe(false)
    expect(store.queued().map((entry) => entry.event.id)).toEqual([queued.id])
    expect(store.claim(queued.id)?.state).toMatchObject({
      status: 'claimed',
      claim: { boot: 'boot-a' }
    })
    expect(store.claim(queued.id)).toBeUndefined()
    expect(store.queued()).toEqual([])
    expect(store.start(queued.id).state).toMatchObject({ status: 'done' })
    expect(() => store.start(queued.id)).toThrow('Thread event is not claimed.')
    expect(store.release(queued.id)).toBe('done')
    const reopened = reopen(store, path, 'boot-b')
    expect(reopened.get(queued.id)?.state).toMatchObject({ status: 'done' })
    expect(reopened.queued()).toEqual([])
    const db = new MagicAgentEventStore(path)
    try {
      expect(db.getResource(THREAD_EVENT_KIND, queued.id)?.revision).toBe(0)
      expect(db.getResource(THREAD_EVENT_STATE_KIND, queued.id)?.revision).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('collapses a repeated idempotency key per session while the event waits, and frees it once done or expired', () => {
    const store = open(file())
    const first = store.append(event({ idempotencyKey: 'tick-1' }))
    const repeat = store.append(event({ idempotencyKey: 'tick-1', text: 'synthetic repeat' }))
    expect(repeat).toMatchObject({
      duplicate: true,
      event: { id: first.event.id, text: 'synthetic tick' }
    })
    // Another session or another key is another event.
    expect(store.append(event({ idempotencyKey: 'tick-1', conversationId: 'b' })).duplicate).toBe(
      false
    )
    expect(store.append(event({ idempotencyKey: 'tick-2' })).duplicate).toBe(false)
    // Still collapsed while claimed.
    store.claim(first.event.id)
    expect(store.append(event({ idempotencyKey: 'tick-1' })).event.id).toBe(first.event.id)
    store.start(first.event.id)
    const afterDone = store.append(event({ idempotencyKey: 'tick-1' }))
    expect(afterDone.duplicate).toBe(false)
    expect(afterDone.event.id).not.toBe(first.event.id)
    store.expireSession(session, 'session-removed')
    expect(store.append(event({ idempotencyKey: 'tick-1' })).duplicate).toBe(false)
  })

  it('keeps the idempotency key across a restart while the event still waits', () => {
    const path = file()
    const store = open(path)
    const first = store.append(event({ idempotencyKey: 'drive-1' }))
    const reopened = reopen(store, path, 'boot-b')
    expect(reopened.append(event({ idempotencyKey: 'drive-1' }))).toMatchObject({
      duplicate: true,
      event: { id: first.event.id }
    })
  })

  it('queues again a claim of another boot that never started, and never redelivers a started event', () => {
    const path = file()
    const store = open(path, 'boot-a')
    const claimed = store.append(event({ text: 'synthetic claimed' })).event
    const started = store.append(event({ text: 'synthetic started' })).event
    store.claim(claimed.id)
    store.claim(started.id)
    store.start(started.id)
    const reopened = reopen(store, path, 'boot-b')
    expect(reopened.queued().map((entry) => entry.event.id)).toEqual([claimed.id])
    expect(reopened.get(started.id)?.state.status).toBe('done')
    // The other boot's claim is over: only this boot's claim can start it.
    expect(() => reopened.start(claimed.id)).toThrow('Thread event is not claimed.')
  })

  it('lists oldest first and expires an event past its 7-day TTL instead of delivering it', () => {
    let now = 1_000_000
    const store = open(file(), 'boot-a', () => now)
    const old = store.append(event({ text: 'synthetic old' })).event
    now += 1
    const fresh = store.append(event({ text: 'synthetic fresh' })).event
    expect(store.queued().map((entry) => entry.event.id)).toEqual([old.id, fresh.id])
    now = old.expiresAt
    expect(store.claim(old.id)).toBeUndefined()
    expect(store.get(old.id)?.state).toMatchObject({ status: 'expired', expiredReason: 'ttl' })
    now = fresh.expiresAt
    expect(store.expireStale()).toBe(1)
    expect(store.queued()).toEqual([])
    expect(fresh.expiresAt - fresh.createdAt).toBe(AGENT_THREAD_INBOX_LIMITS.ttlMs)
  })

  it('expires the waiting and claimed events of one removed session, nothing else', () => {
    const store = open(file())
    const a1 = store.append(event()).event
    const a2 = store.append(event()).event
    const b = store.append(event({ conversationId: 'b' })).event
    const other = store.append(event({ routeKey: 'canvas:thread:project:other' })).event
    store.claim(a2.id)
    expect(store.expireSession(session, 'session-removed')).toBe(2)
    expect(store.get(a1.id)?.state).toMatchObject({
      status: 'expired',
      expiredReason: 'session-removed'
    })
    expect(store.get(a2.id)?.state).toMatchObject({ status: 'expired' })
    expect(store.get(a2.id)?.state.claim).toBeUndefined()
    expect(() => store.start(a2.id)).toThrow('Thread event is not claimed.')
    expect(store.queued().map((entry) => entry.event.id)).toEqual([b.id, other.id])
  })

  it('refuses malformed events and counts queued events per session', () => {
    const store = open(file())
    expect(() => store.append(event({ text: ' ' }))).toThrow('Invalid thread event.')
    expect(() => store.append(event({ source: 'line\nbreak' }))).toThrow('Invalid thread event.')
    expect(() => store.append(event({ type: 'unknown' as never }))).toThrow('Invalid thread event.')
    expect(() =>
      store.append(event({ text: 'x'.repeat(AGENT_THREAD_INBOX_LIMITS.textCharacters + 1) }))
    ).toThrow('Invalid thread event.')
    store.append(event())
    store.append(event({ conversationId: 'b' }))
    expect(store.queuedCount(session)).toBe(1)
    expect(store.queuedCount()).toBe(2)
  })
})
