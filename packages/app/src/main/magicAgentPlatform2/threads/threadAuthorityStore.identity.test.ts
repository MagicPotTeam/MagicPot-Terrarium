import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _crashTesting } from '../persistence/crashHooks'
import { MagicAgentEventStore, ResourceRevisionConflictError } from '../persistence/eventStore'
import {
  THREAD_IDENTITY_INDEX_KIND as INDEX,
  THREAD_IDENTITY_KIND as IDENTITY,
  ThreadAuthorityStore,
  ThreadAuthorityUnavailableError,
  type ThreadAuthorityTarget
} from './threadAuthorityStore'

vi.unmock('node:fs')

const dirs: string[] = []
const stores: MagicAgentEventStore[] = []
afterEach(() => {
  _crashTesting.setHook(null)
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A temporary SQLite file, an injected clock and one id source shared by every connection. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'thread-authority-identity-'))
  dirs.push(dir)
  const file = join(dir, 'events.sqlite')
  const clock = { now: 1_000_000 }
  let serial = 0
  const newId = () => `id-${(serial += 1)}`
  const open = () => {
    const store = new MagicAgentEventStore(file)
    stores.push(store)
    return store
  }
  const build = (store: MagicAgentEventStore) =>
    new ThreadAuthorityStore(store, { now: () => clock.now, newId })
  const store = open()
  return { clock, open, build, store, authority: build(store) }
}

type TargetParts = {
  scopeId: string
  threadId: string
  conversationId: string
  storageScope: string
}
const parts: TargetParts = {
  scopeId: 'project-1',
  threadId: 'thread-1',
  conversationId: 'conversation-1',
  storageScope: 'profile/agents'
}
function target(over: Partial<TargetParts> = {}): ThreadAuthorityTarget {
  const p = { ...parts, ...over }
  return {
    route: { channel: 'canvas', scopeType: 'thread', scopeId: p.scopeId, threadId: p.threadId },
    conversationId: p.conversationId,
    storageScope: p.storageScope
  }
}
function keyOf(over: Partial<TargetParts> = {}): string {
  const p = { ...parts, ...over }
  return createHash('sha256')
    .update(
      JSON.stringify([
        IDENTITY,
        `canvas:thread:${p.scopeId}:thread:${p.threadId}`,
        p.conversationId,
        p.storageScope
      ])
    )
    .digest('hex')
}
const footprint = (store: MagicAgentEventStore) => [
  store.countEvents(),
  store.countResources({ includeDeleted: true })
]

let rawSerial = 0
/** A direct event-store write that bypasses the authority store, used to damage rows. */
function rawWrite(
  store: MagicAgentEventStore,
  kind: string,
  id: string,
  operation: 'create' | 'update' | 'delete',
  state?: unknown
) {
  const row = store.getResource(kind, id, { includeDeleted: true })
  const eventId = `raw-${(rawSerial += 1)}`
  const createdAt = Math.max(row?.updatedAt ?? 0, 1)
  const sequence = row ? row.revision + 1 : 0
  store.mutateResource({
    operation,
    kind,
    id,
    ...(row ? { expectedRevision: row.revision } : {}),
    ...(operation === 'delete' ? {} : { state }),
    createdAt,
    idempotencyKey: eventId,
    event: {
      protocolVersion: '2.0.0',
      envelopeKind: 'event',
      id: eventId,
      type: 'raw.changed',
      createdAt,
      payload: {},
      streamId: `${kind}:${id}:stream`,
      sequence
    }
  })
}
function rawState(store: MagicAgentEventStore, kind: string, id: string): Record<string, unknown> {
  return structuredClone(store.getResource(kind, id)!.state) as Record<string, unknown>
}
function rawStreamEvidence(store: MagicAgentEventStore, kind: string, id: string) {
  const eventId = `raw-${(rawSerial += 1)}`
  store.appendBatch([
    {
      protocolVersion: '2.0.0',
      envelopeKind: 'event',
      id: eventId,
      type: 'raw.changed',
      createdAt: 1,
      payload: {},
      streamId: `${kind}:${id}:stream`,
      sequence: 0
    }
  ])
}

describe('thread identity registry: issue, read, verify, revoke', () => {
  it('issues one MAIN id per target, stable over repeated calls and over close and reopen', () => {
    const { authority, store, open, build } = setup()
    expect(authority.readThread(target())).toBeUndefined()
    const pair = authority.issueThread(target())
    expect(pair).toEqual({ threadId: expect.stringMatching(/^id-\d+$/), generation: 1 })
    const before = footprint(store)
    expect(authority.issueThread(target())).toEqual(pair)
    expect(authority.issueThread(target())).toEqual(pair)
    expect(footprint(store)).toEqual(before)
    expect(store.getResource(IDENTITY, keyOf())?.state).toEqual({
      v: 1,
      key: keyOf(),
      target: target(),
      threadId: pair.threadId,
      generation: 1,
      status: 'live',
      issuedAt: 1_000_000,
      grants: []
    })
    expect(store.getResource(INDEX, pair.threadId)?.state).toEqual({
      v: 1,
      threadId: pair.threadId,
      key: keyOf(),
      generation: 1
    })
    expect(authority.verifyThread(pair.threadId, 1)).toEqual({ ok: true, target: target() })
    store.close()
    const reopened = build(open())
    expect(reopened.issueThread(target())).toEqual(pair)
    expect(reopened.readThread(target())).toEqual({ ...pair, status: 'live', issuedAt: 1_000_000 })
    expect(reopened.verifyThread(pair.threadId, 1)).toEqual({ ok: true, target: target() })
  })

  it('gives a different id to targets that differ in exactly one of scopeId, threadId, conversationId, storageScope', () => {
    const { authority, store } = setup()
    const variants: Partial<TargetParts>[] = [
      {},
      { scopeId: 'project-2' },
      { threadId: 'thread-2' },
      { conversationId: 'conversation-2' },
      { storageScope: 'profile/agents2' }
    ]
    const pairs = variants.map((over) => authority.issueThread(target(over)))
    expect(new Set(pairs.map((pair) => pair.threadId)).size).toBe(variants.length)
    expect(new Set(variants.map((over) => keyOf(over))).size).toBe(variants.length)
    for (const [index, over] of variants.entries()) {
      expect(store.getResource(IDENTITY, keyOf(over))?.state).toMatchObject({
        threadId: pairs[index].threadId,
        generation: 1
      })
      expect(authority.verifyThread(pairs[index].threadId, 1)).toEqual({
        ok: true,
        target: target(over)
      })
    }
    authority.revokeThread(target({ conversationId: 'conversation-2' }))
    expect(authority.verifyThread(pairs[0].threadId, 1).ok).toBe(true)
    expect(authority.verifyThread(pairs[3].threadId, 1)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('answers revoked after revoke, also after reopen; never-issued and repeated revokes write nothing', () => {
    const { authority, store, open, build, clock } = setup()
    const before = footprint(store)
    expect(authority.revokeThread(target())).toEqual({ status: 'unknown' })
    expect(authority.verifyThread('id-404', 1)).toEqual({ ok: false, reason: 'unknown' })
    expect(footprint(store)).toEqual(before)
    const pair = authority.issueThread(target())
    clock.now += 10
    expect(authority.revokeThread(target())).toEqual({ status: 'revoked' })
    const revoked = footprint(store)
    expect(authority.revokeThread(target())).toEqual({ status: 'already-revoked' })
    expect(footprint(store)).toEqual(revoked)
    expect(authority.verifyThread(pair.threadId, 1)).toEqual({ ok: false, reason: 'revoked' })
    store.close()
    const reopened = build(open())
    expect(reopened.verifyThread(pair.threadId, 1)).toEqual({ ok: false, reason: 'revoked' })
    expect(reopened.readThread(target())).toEqual({
      ...pair,
      status: 'revoked',
      issuedAt: 1_000_000,
      revokedAt: 1_000_010
    })
  })

  it('issues a new id and generation 2 after revoke; the old pair is stale for ever', () => {
    const { authority, store, open, build } = setup()
    const first = authority.issueThread(target())
    authority.revokeThread(target())
    const second = authority.issueThread(target())
    expect(second.generation).toBe(2)
    expect(second.threadId).not.toBe(first.threadId)
    expect(authority.verifyThread(first.threadId, 1)).toEqual({ ok: false, reason: 'stale' })
    expect(authority.verifyThread(first.threadId, 2)).toEqual({ ok: false, reason: 'stale' })
    expect(authority.verifyThread(second.threadId, 1)).toEqual({ ok: false, reason: 'stale' })
    expect(authority.verifyThread(second.threadId, 2)).toEqual({ ok: true, target: target() })
    expect(store.getResource(INDEX, first.threadId)?.state).toEqual({
      v: 1,
      threadId: first.threadId,
      key: keyOf(),
      generation: 1
    })
    store.close()
    const reopened = build(open())
    expect(reopened.verifyThread(first.threadId, 1)).toEqual({ ok: false, reason: 'stale' })
    reopened.revokeThread(target())
    expect(reopened.verifyThread(second.threadId, 2)).toEqual({ ok: false, reason: 'revoked' })
    const third = reopened.issueThread(target())
    expect(third.generation).toBe(3)
    for (const old of [first, second])
      expect(reopened.verifyThread(old.threadId, old.generation)).toEqual({
        ok: false,
        reason: 'stale'
      })
    expect(reopened.verifyThread(third.threadId, 3).ok).toBe(true)
  })

  it.each([
    ['extra target key', { ...target(), extra: 1 }],
    ['missing storageScope', { route: target().route, conversationId: 'conversation-1' }],
    ['extra route key', { ...target(), route: { ...target().route, senderId: 'x' } }],
    [
      'missing route threadId',
      { ...target(), route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project-1' } }
    ],
    ['channel not canvas', { ...target(), route: { ...target().route, channel: 'telegram' } }],
    ['scopeType not thread', { ...target(), route: { ...target().route, scopeType: 'dm' } }],
    ['scopeId with a colon', target({ scopeId: 'project:1' })],
    ['threadId too long', target({ threadId: 'a'.repeat(129) })],
    ['conversationId with leading dash', target({ conversationId: '-conversation' })],
    ['conversationId not a string', { ...target(), conversationId: 7 }],
    ['empty storageScope', target({ storageScope: '' })],
    ['blank storageScope', target({ storageScope: '   ' })],
    ['storageScope too long', target({ storageScope: 's'.repeat(513) })],
    ['storageScope with a control character', target({ storageScope: 'profile\u0007' })],
    ['storageScope with DEL', target({ storageScope: 'profile\u007f' })],
    ['route an array', { ...target(), route: [] }],
    ['target null', null],
    ['target with a class prototype', Object.assign(Object.create({ inherited: true }), target())]
  ])('rejects an invalid target (%s) before any read and writes nothing', (_name, value) => {
    const { authority, store } = setup()
    const before = footprint(store)
    const reads = vi.spyOn(store, 'getResource')
    const evidence = vi.spyOn(store, 'hasResourceEvidence')
    const bad = value as unknown as ThreadAuthorityTarget
    for (const call of [
      () => authority.issueThread(bad),
      () => authority.readThread(bad),
      () => authority.revokeThread(bad)
    ])
      expect(call).toThrow(TypeError)
    expect(reads).not.toHaveBeenCalled()
    expect(evidence).not.toHaveBeenCalled()
    expect(footprint(store)).toEqual(before)
    expect(store.countResources({ kind: IDENTITY, includeDeleted: true })).toBe(0)
  })

  it('rejects an invalid pair before any read', () => {
    const { authority, store } = setup()
    const reads = vi.spyOn(store, 'getResource')
    for (const [threadId, generation] of [
      ['', 1],
      ['id-1', 0],
      ['id-1', 1.5],
      ['id-1', -1],
      ['id 1', 1],
      [7, 1],
      ['id-1', Number.MAX_SAFE_INTEGER + 1]
    ] as const)
      expect(() => authority.verifyThread(threadId as string, generation)).toThrow(TypeError)
    expect(reads).not.toHaveBeenCalled()
  })

  it('refuses a clock or id source that returns an unusable value, writing nothing', () => {
    const { store } = setup()
    for (const now of [-1, 1.5, Number.NaN, '5']) {
      const broken = new ThreadAuthorityStore(store, {
        now: () => now as number,
        newId: () => 'id-x'
      })
      expect(() => broken.issueThread(target())).toThrow('clock')
    }
    for (const id of ['', 'bad id', 'x'.repeat(129)]) {
      const broken = new ThreadAuthorityStore(store, { now: () => 5, newId: () => id })
      expect(() => broken.issueThread(target())).toThrow('id source')
    }
    expect(footprint(store)).toEqual([0, 0])
    const repeating = new ThreadAuthorityStore(store, { now: () => 5, newId: () => 'same' })
    expect(repeating.issueThread(target())).toEqual({ threadId: 'same', generation: 1 })
    const before = footprint(store)
    expect(() => repeating.issueThread(target({ threadId: 'thread-2' }))).toThrow(
      'id source repeated an id'
    )
    expect(footprint(store)).toEqual(before)
    expect(() => new ThreadAuthorityStore(undefined as unknown as MagicAgentEventStore)).toThrow(
      TypeError
    )
  })
})

describe('thread identity registry: unavailable records fail closed', () => {
  type Shape = (store: MagicAgentEventStore, pair: { threadId: string; generation: number }) => void
  const damage =
    (
      kind: 'identity' | 'index',
      change: (state: Record<string, unknown>) => Record<string, unknown>
    ): Shape =>
    (store, pair) => {
      const [k, id] = kind === 'identity' ? [IDENTITY, keyOf()] : [INDEX, pair.threadId]
      rawWrite(store, k, id, 'update', change(rawState(store, k, id)))
    }
  const shapes: [string, Shape][] = [
    ['identity with v: 2', damage('identity', (s) => ({ ...s, v: 2 }))],
    ['identity with an extra key', damage('identity', (s) => ({ ...s, extra: 1 }))],
    ['identity without grants', damage('identity', ({ grants: _grants, ...s }) => s)],
    ['identity with a revokedAt while live', damage('identity', (s) => ({ ...s, revokedAt: 5 }))],
    ['identity with an unknown status', damage('identity', (s) => ({ ...s, status: 'paused' }))],
    ['identity with another key', damage('identity', (s) => ({ ...s, key: 'f'.repeat(64) }))],
    [
      'identity whose target hashes to another key',
      damage('identity', (s) => ({ ...s, target: target({ conversationId: 'conversation-9' }) }))
    ],
    ['identity with generation 0', damage('identity', (s) => ({ ...s, generation: 0 }))],
    [
      'identity with a repeated grant id',
      damage('identity', (s) => ({ ...s, grants: ['g-1', 'g-1'] }))
    ],
    ['identity deleted', (store) => rawWrite(store, IDENTITY, keyOf(), 'delete')],
    [
      'identity pointing to an id without index',
      damage('identity', (s) => ({ ...s, threadId: 'ghost' }))
    ],
    [
      'identity pointing to an index with stream evidence only',
      (store) => {
        rawStreamEvidence(store, INDEX, 'ghost-2')
        damage('identity', (s) => ({ ...s, threadId: 'ghost-2' }))(store, {
          threadId: '',
          generation: 1
        })
      }
    ],
    ['index with v: 2', damage('index', (s) => ({ ...s, v: 2 }))],
    ['index with an extra key', damage('index', (s) => ({ ...s, extra: 1 }))],
    ['index pointing to another key', damage('index', (s) => ({ ...s, key: 'e'.repeat(64) }))],
    ['index pointing to another generation', damage('index', (s) => ({ ...s, generation: 2 }))],
    ['index naming another thread id', damage('index', (s) => ({ ...s, threadId: 'other' }))],
    ['index deleted', (store, pair) => rawWrite(store, INDEX, pair.threadId, 'delete')]
  ]
  it.each(shapes)(
    '%s: every method throws, writes nothing and never yields a fresh generation 1',
    (_name, apply) => {
      const { authority, store, open, build } = setup()
      const pair = authority.issueThread(target())
      apply(store, pair)
      const before = footprint(store)
      const methods = (subject: ThreadAuthorityStore) => [
        () => subject.issueThread(target()),
        () => subject.readThread(target()),
        () => subject.verifyThread(pair.threadId, pair.generation),
        () => subject.revokeThread(target())
      ]
      for (const call of methods(authority)) expect(call).toThrow(ThreadAuthorityUnavailableError)
      expect(footprint(store)).toEqual(before)
      store.close()
      const reopenedStore = open()
      for (const call of methods(build(reopenedStore)))
        expect(call).toThrow('Thread authority record unavailable.')
      expect(footprint(reopenedStore)).toEqual(before)
    }
  )

  it('a missing identity row with stream evidence is unavailable, never a fresh generation 1', () => {
    const { authority, store } = setup()
    rawStreamEvidence(store, IDENTITY, keyOf())
    const before = footprint(store)
    for (const call of [
      () => authority.issueThread(target()),
      () => authority.readThread(target()),
      () => authority.revokeThread(target())
    ])
      expect(call).toThrow(ThreadAuthorityUnavailableError)
    expect(footprint(store)).toEqual(before)
    expect(store.countResources({ kind: INDEX, includeDeleted: true })).toBe(0)
  })

  it('an index without its identity row, and an old index claiming the current generation, are unavailable', () => {
    const { authority, store } = setup()
    rawWrite(store, INDEX, 'orphan', 'create', {
      v: 1,
      threadId: 'orphan',
      key: keyOf({ threadId: 'thread-9' }),
      generation: 1
    })
    expect(() => authority.verifyThread('orphan', 1)).toThrow(ThreadAuthorityUnavailableError)
    const first = authority.issueThread(target())
    authority.revokeThread(target())
    const second = authority.issueThread(target())
    rawWrite(store, INDEX, first.threadId, 'update', {
      ...rawState(store, INDEX, first.threadId),
      generation: 2
    })
    const before = footprint(store)
    expect(() => authority.verifyThread(first.threadId, 1)).toThrow(ThreadAuthorityUnavailableError)
    expect(authority.verifyThread(second.threadId, 2).ok).toBe(true)
    expect(footprint(store)).toEqual(before)
  })
})

describe('thread identity registry: races, clock and crashes', () => {
  it('two connections: B issues inside the write of A; A throws the conflict and its retry returns the id of B', () => {
    const { open, build } = setup()
    const a = open(),
      b = open()
    const A = build(a),
      B = build(b)
    const commit = a.mutateResourcesBatch.bind(a)
    let inner: { threadId: string; generation: number } | undefined
    const spy = vi.spyOn(a, 'mutateResourcesBatch').mockImplementationOnce((commands) => {
      inner = B.issueThread(target())
      return commit(commands)
    })
    expect(() => A.issueThread(target())).toThrow(ResourceRevisionConflictError)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(inner).toEqual({ threadId: expect.any(String), generation: 1 })
    expect(A.issueThread(target())).toEqual(inner)
    expect(a.countResources({ kind: IDENTITY, includeDeleted: true })).toBe(1)
    expect(a.countResources({ kind: INDEX, includeDeleted: true })).toBe(1)
  })

  it('two connections on a revoked identity: B re-issues inside the re-issue of A; generation advances by exactly 1', () => {
    const { open, build } = setup()
    const a = open(),
      b = open()
    const A = build(a),
      B = build(b)
    const first = A.issueThread(target())
    A.revokeThread(target())
    const commit = a.mutateResourcesBatch.bind(a)
    let inner: { threadId: string; generation: number } | undefined
    vi.spyOn(a, 'mutateResourcesBatch').mockImplementationOnce((commands) => {
      inner = B.issueThread(target())
      return commit(commands)
    })
    expect(() => A.issueThread(target())).toThrow(ResourceRevisionConflictError)
    expect(inner?.generation).toBe(2)
    expect(A.issueThread(target())).toEqual(inner)
    expect(b.getResource(IDENTITY, keyOf())?.state).toMatchObject({
      threadId: inner?.threadId,
      generation: 2,
      status: 'live'
    })
    expect(a.countResources({ kind: INDEX, includeDeleted: true })).toBe(2)
    expect(A.verifyThread(first.threadId, 1)).toEqual({ ok: false, reason: 'stale' })
  })

  it('revokes and re-issues with the clock set back below the updatedAt of the row', () => {
    const { authority, store, clock } = setup()
    clock.now = 5_000_000
    const first = authority.issueThread(target())
    clock.now = 1_000
    expect(authority.revokeThread(target())).toEqual({ status: 'revoked' })
    expect(authority.verifyThread(first.threadId, 1)).toEqual({ ok: false, reason: 'revoked' })
    expect(store.getResource(IDENTITY, keyOf())?.updatedAt).toBe(5_000_000)
    expect(authority.issueThread(target()).generation).toBe(2)
  })

  it('a crash before commit during issue leaves neither row and the retry works', () => {
    const { authority, store } = setup()
    _crashTesting.setHook((stage) => {
      if (stage === 'resource.before-commit') throw new Error('crash before commit')
    })
    expect(() => authority.issueThread(target())).toThrow('crash before commit')
    _crashTesting.setHook(null)
    expect(store.countResources({ includeDeleted: true })).toBe(0)
    expect(store.hasResourceEvidence(IDENTITY, keyOf())).toBe(false)
    const pair = authority.issueThread(target())
    expect(pair.generation).toBe(1)
    expect(authority.verifyThread(pair.threadId, 1).ok).toBe(true)
  })

  it('a crash after commit makes the call throw, but both rows exist after reopen', () => {
    const { authority, store, open, build } = setup()
    _crashTesting.setHook((stage) => {
      if (stage === 'resource.after-commit') throw new Error('crash after commit')
    })
    expect(() => authority.issueThread(target())).toThrow('crash after commit')
    _crashTesting.setHook(null)
    store.close()
    const reopenedStore = open()
    const reopened = build(reopenedStore)
    const view = reopened.readThread(target())
    expect(view).toMatchObject({ generation: 1, status: 'live' })
    expect(reopenedStore.getResource(INDEX, view!.threadId)?.state).toMatchObject({
      key: keyOf(),
      generation: 1
    })
    expect(reopened.issueThread(target())).toEqual({ threadId: view!.threadId, generation: 1 })
  })
})
