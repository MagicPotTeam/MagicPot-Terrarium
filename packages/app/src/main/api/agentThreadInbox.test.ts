import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
const h = vi.hoisted(() => ({ senders: new Map<number, unknown>() }))
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => h.senders.get(id) } }))
vi.mock('./agentThreadScope', () => ({
  authorizeAgentThreadScope: (
    scope: { route?: { scopeId?: string } },
    invocation: { senderId: number; methodName: string },
    method: string
  ) => {
    if (invocation?.methodName !== `svcLLMProxy.${method}`) throw Error('unauthorized')
    // The fixture sender 9 belongs to another canvas document.
    if (invocation.senderId === 9 || scope.route?.scopeId !== 'project') throw Error('unauthorized')
    return invocation.senderId
  }
}))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => {
    throw Error('Unexpected production path')
  }
}))
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { AGENT_THREAD_INBOX_LIMITS } from '@shared/api/agentThreadInbox'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import {
  AgentThreadInbox,
  THREAD_EVENT_BUSY,
  THREAD_EVENT_UNAVAILABLE,
  threadInboxStoreOpener,
  type AgentThreadEventInput
} from './agentThreadInbox'
import { THREAD_EVENT_STATE_KIND } from './agentThreadInboxStore'

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project',
  threadId: 'pane'
} as const
const scope = { route, storageScope: 'scope' }
const invoke = (id: number, method: string) => ({
  senderId: id,
  methodName: `svcLLMProxy.${method}`,
  senderUrl: 'file:///fixture',
  frameUrl: 'file:///fixture',
  isMainFrame: true
})
const sender = (id: number) => {
  const s = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    getURL: () => 'file:///fixture'
  })
  h.senders.set(id, s)
  return s
}
const input = (over: Partial<AgentThreadEventInput> = {}): AgentThreadEventInput => ({
  ...scope,
  conversationId: 'session-a',
  type: 'trigger_fire',
  source: 'synthetic-timer',
  text: 'synthetic tick',
  ...over
})
const directories: string[] = [],
  inboxes: AgentThreadInbox[] = []
function path(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'thread-inbox-'))
  directories.push(directory)
  return join(directory, 'thread-inbox', 'events.sqlite')
}
function inbox(file = path(), boot: string = randomUUID()) {
  const q = new AgentThreadInbox({ store: threadInboxStoreOpener(file, boot) })
  inboxes.push(q)
  return { q, file }
}
function stored(file: string, id: string): Record<string, unknown> | undefined {
  for (const q of inboxes.splice(0)) q.dispose()
  const db = new MagicAgentEventStore(file)
  try {
    return db.getResource<Record<string, unknown>>(THREAD_EVENT_STATE_KIND, id)?.state
  } finally {
    db.close()
  }
}
const list = (q: AgentThreadInbox, id = 1) => q.list(scope, invoke(id, 'listAgentThreadEvents'))
const claim = (q: AgentThreadInbox, eventId: string, id = 1, conversationId = 'session-a') =>
  q.claim({ ...scope, conversationId, id: eventId }, invoke(id, 'claimAgentThreadEvent'))
const request = (
  event: { id: string; lease: string },
  over: Partial<LLMChatReq> = {}
): LLMChatReq => ({
  messages: [{ role: 'user', content: 'synthetic event turn' }],
  route,
  conversationId: 'session-a',
  threadEvent: event,
  isEdit: false,
  ...over
})
afterEach(() => {
  vi.restoreAllMocks()
  h.senders.clear()
  for (const q of inboxes.splice(0)) q.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('thread event inbox', () => {
  it('lists only its own route and storage scope, oldest first, and creates no file for a read', () => {
    sender(1)
    const { q, file } = inbox()
    expect(list(q)).toEqual([])
    expect(existsSync(file)).toBe(false)
    const first = q.enqueue(input()).id
    q.enqueue(input({ storageScope: 'other-scope' }))
    q.enqueue(input({ route: { ...route, threadId: 'other-pane' } }))
    const second = q.enqueue(input({ conversationId: 'session-b', type: 'job_done' })).id
    expect(list(q).map((event) => event.id)).toEqual([first, second])
    expect(list(q)[0]).toMatchObject({
      type: 'trigger_fire',
      source: 'synthetic-timer',
      text: 'synthetic tick'
    })
    expect(list(q)[0].lease).toBeUndefined()
    expect(() => list(q, 9)).toThrow('unauthorized')
    expect(() => q.list(scope, invoke(1, 'claimAgentThreadEvent'))).toThrow('unauthorized')
  })

  it('accepts only MAIN producer types and bounded fields; team_message stays reserved', () => {
    const { q } = inbox()
    expect(() => q.enqueue(input({ type: 'team_message' }))).toThrow('Invalid thread event type.')
    expect(() => q.enqueue(input({ text: '' }))).toThrow('Invalid thread event.')
    expect(() => q.enqueue(input({ source: 'x'.repeat(121) }))).toThrow('Invalid thread event.')
    expect(() => q.enqueue(input({ conversationId: '../escape' }))).toThrow(
      'Invalid thread event scope.'
    )
    expect(() => q.enqueue(input({ route: { ...route, scopeType: 'project' } as never }))).toThrow(
      'Invalid thread event route.'
    )
  })

  it('collapses an idempotency key while the event waits, without counting against the caps', () => {
    const { q } = inbox()
    const first = q.enqueue(input({ idempotencyKey: 'trigger:daily:2026-01-01' }))
    expect(first.duplicate).toBe(false)
    expect(q.enqueue(input({ idempotencyKey: 'trigger:daily:2026-01-01' }))).toEqual({
      id: first.id,
      duplicate: true
    })
    for (let i = 1; i < AGENT_THREAD_INBOX_LIMITS.perSession; i++)
      q.enqueue(input({ text: `synthetic ${i}` }))
    // Full session: a repeat of a waiting key still collapses, a new event is refused.
    expect(q.enqueue(input({ idempotencyKey: 'trigger:daily:2026-01-01' })).id).toBe(first.id)
    expect(() => q.enqueue(input())).toThrow('Thread inbox capacity reached.')
    expect(q.enqueue(input({ conversationId: 'session-b' })).duplicate).toBe(false)
  })

  it('caps the whole inbox at 1024 queued events', () => {
    const { q } = inbox()
    for (let i = 0; i < AGENT_THREAD_INBOX_LIMITS.total; i++)
      q.enqueue(
        input({ conversationId: `s${Math.floor(i / AGENT_THREAD_INBOX_LIMITS.perSession)}` })
      )
    expect(() => q.enqueue(input({ conversationId: 'fresh' }))).toThrow(
      'Thread inbox capacity reached.'
    )
  }, 60_000)

  it('gives the lease out once, only for the right session, and lets only the holder release it', () => {
    sender(1)
    sender(2)
    const { q } = inbox()
    const id = q.enqueue(input()).id
    expect(claim(q, id, 1, 'session-b')).toBeUndefined()
    expect(() => claim(q, id, 9)).toThrow('unauthorized')
    const claimed = claim(q, id)!
    expect(claimed.lease).toEqual(expect.any(String))
    expect(claim(q, id)).toBeUndefined()
    expect(claim(q, id, 2)).toBeUndefined()
    expect(list(q)).toEqual([])
    const release = (by: number, lease: string) =>
      q.release(
        { ...scope, conversationId: 'session-a', id, lease },
        invoke(by, 'releaseAgentThreadEvent')
      )
    expect(release(2, claimed.lease!)).toEqual({ released: false })
    expect(release(1, 'not-the-lease')).toEqual({ released: false })
    expect(release(1, claimed.lease!)).toEqual({ released: true })
    expect(list(q).map((event) => event.id)).toEqual([id])
    expect(release(1, claimed.lease!)).toEqual({ released: false })
  })

  it('admits the turn once with its lease, records the start first and marks it event-origin', () => {
    sender(1)
    const { q, file } = inbox()
    const id = q.enqueue(input()).id
    const lease = claim(q, id)!.lease!
    const admitted = q.admitEvent(request({ id, lease }), invoke(1, 'chatStream'))
    expect(Object.hasOwn(admitted, 'threadEvent')).toBe(false)
    expect(admitted.threadEventOrigin).toBe('trigger_fire')
    expect(JSON.stringify(admitted)).not.toContain(lease)
    // A second presentation of the same lease, or a release after the start, does nothing.
    expect(() => q.admitEvent(request({ id, lease }), invoke(1, 'chatStream'))).toThrow(
      THREAD_EVENT_UNAVAILABLE
    )
    expect(
      q.release(
        { ...scope, conversationId: 'session-a', id, lease },
        invoke(1, 'releaseAgentThreadEvent')
      )
    ).toEqual({ released: false })
    expect(stored(file, id)).toMatchObject({ status: 'done', startedAt: expect.any(Number) })
  })

  it('passes a request without threadEvent unchanged, even one that claims threadEventOrigin', () => {
    const { q } = inbox()
    const req = { messages: [], threadEventOrigin: 'job_done' } as LLMChatReq
    expect(q.admitEvent(req, invoke(1, 'chat'))).toBe(req)
  })

  it('refuses every other presentation, and any field that stands for the user, before the start', () => {
    sender(1)
    sender(2)
    const { q, file } = inbox()
    const id = q.enqueue(input()).id
    const queued = q.enqueue(input({ text: 'synthetic queued' })).id
    const lease = claim(q, id)!.lease!
    const refused: Array<[string, LLMChatReq, number | null, string?]> = [
      ['a wrong token', request({ id, lease: 'not-the-lease' }), 1],
      ['another sender', request({ id, lease }), 2],
      ['no invocation', request({ id, lease }), null],
      ['another method', request({ id, lease }), 1, 'claimAgentThreadEvent'],
      ['another conversation', request({ id, lease }, { conversationId: 'session-b' }), 1],
      ['another route', request({ id, lease }, { route: { ...route, threadId: 'other' } }), 1],
      ['a record still queued', request({ id: queued, lease }), 1],
      ['an extra field', request({ id, lease, extra: 1 } as never), 1],
      ['an undefined field', { ...request({ id, lease }), threadEvent: undefined }, 1],
      ['an edit', request({ id, lease }, { isEdit: true }), 1],
      ['a regeneration', request({ id, lease }, { isRegenerate: true }), 1],
      [
        'a model configuration consent',
        request({ id, lease }, { expectedProfileRevision: 'r1' }),
        1
      ],
      ['a goal progress share', request({ id, lease }, { goalProgressToken: 'token' }), 1],
      [
        'a team member turn',
        request(
          { id, lease },
          { teamMember: { scope: 's', thread: 'pane', lead: 'l', member: 'm' } }
        ),
        1
      ],
      ['a team hop', request({ id, lease }, { teamMessageHop: 1 }), 1],
      ['an image review', request({ id, lease }, { threadImageReview: 'last-output' }), 1],
      ['a comparison route', request({ id, lease }, { comparisonRouting: 'local' }), 1]
    ]
    for (const [name, req, by, method] of refused)
      expect(
        () => q.admitEvent(req, by === null ? undefined : invoke(by, method ?? 'chat')),
        name
      ).toThrow(THREAD_EVENT_UNAVAILABLE)
    // Still claimed by its holder: a correct presentation is admitted afterwards.
    expect(q.admitEvent(request({ id, lease }), invoke(1, 'chat')).threadEventOrigin).toBe(
      'trigger_fire'
    )
    expect(stored(file, queued)).toMatchObject({ status: 'queued' })
  })

  it('does not start an event while its session has a running turn; the claim stays for a release', () => {
    sender(1)
    const { q, file } = inbox()
    const id = q.enqueue(input()).id
    const lease = claim(q, id)!.lease!
    const busy = vi.fn((conversationId: string) => conversationId === 'session-a')
    expect(() => q.admitEvent(request({ id, lease }), invoke(1, 'chatStream'), busy)).toThrow(
      THREAD_EVENT_BUSY
    )
    expect(busy).toHaveBeenCalledWith('session-a')
    expect(
      q.release(
        { ...scope, conversationId: 'session-a', id, lease },
        invoke(1, 'releaseAgentThreadEvent')
      )
    ).toEqual({ released: true })
    expect(stored(file, id)).toMatchObject({ status: 'queued' })
  })

  it('queues again the claims of a document that ended', () => {
    const window = sender(1)
    const { q } = inbox()
    const id = q.enqueue(input()).id
    const lease = claim(q, id)!.lease!
    window.emit('destroyed')
    sender(1)
    expect(() => q.admitEvent(request({ id, lease }), invoke(1, 'chat'))).toThrow(
      THREAD_EVENT_UNAVAILABLE
    )
    expect(list(q).map((event) => event.id)).toEqual([id])
  })

  it('expires a removed session, drops its lease, and never delivers its events again', () => {
    sender(1)
    const { q, file } = inbox()
    const claimedId = q.enqueue(input()).id
    const waiting = q.enqueue(input({ text: 'synthetic waiting' })).id
    const other = q.enqueue(input({ conversationId: 'session-b' })).id
    const lease = claim(q, claimedId)!.lease!
    const expire = (reason: string, by = 1) =>
      q.expire(
        { ...scope, conversationId: 'session-a', reason } as never,
        invoke(by, 'expireAgentThreadEvents')
      )
    // A stop is dormant, not removal: there is no stop reason to expire with.
    expect(() => expire('session-stopped')).toThrow('Invalid thread event scope.')
    expect(() => expire('thread-closed')).toThrow('Invalid thread event scope.')
    expect(() => expire('session-removed', 9)).toThrow('unauthorized')
    expect(list(q).map((event) => event.id)).toEqual([waiting, other])
    expect(expire('session-removed')).toEqual({ expired: 2 })
    expect(() => q.admitEvent(request({ id: claimedId, lease }), invoke(1, 'chat'))).toThrow(
      THREAD_EVENT_UNAVAILABLE
    )
    expect(claim(q, waiting)).toBeUndefined()
    expect(list(q).map((event) => event.id)).toEqual([other])
    expect(stored(file, waiting)).toMatchObject({
      status: 'expired',
      expiredReason: 'session-removed'
    })
  })

  it('after a restart: an unstarted claim is queued again, a started one never returns', () => {
    sender(1)
    const file = path()
    const { q } = inbox(file, 'boot-a')
    const claimed = q.enqueue(input({ text: 'synthetic claimed' })).id
    const started = q.enqueue(input({ text: 'synthetic started' })).id
    claim(q, claimed)
    const lease = claim(q, started)!.lease!
    q.admitEvent(request({ id: started, lease }), invoke(1, 'chat'))
    q.dispose()
    const { q: next } = inbox(file, 'boot-b')
    expect(list(next).map((event) => event.id)).toEqual([claimed])
  })
})
