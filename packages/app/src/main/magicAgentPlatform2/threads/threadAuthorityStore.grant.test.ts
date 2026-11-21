import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _crashTesting } from '../persistence/crashHooks'
import {
  MagicAgentEventStore,
  ResourceRevisionConflictError,
  type ResourceMutationInput
} from '../persistence/eventStore'
import {
  MAX_RUN_GRANT_LIFETIME_MS,
  MAX_RUN_GRANTS_PER_GENERATION,
  RUN_GRANT_KIND as GRANT,
  RUN_GRANT_STATE_KIND as STATE,
  THREAD_IDENTITY_INDEX_KIND as INDEX,
  THREAD_IDENTITY_KIND as IDENTITY,
  ThreadAuthorityStore,
  ThreadAuthorityUnavailableError,
  type RunGrantApprovalRequest,
  type RunGrantRequest,
  type RunGrantSubject,
  type ThreadAuthorityStoreOptions,
  type ThreadAuthorityTarget,
  type ThreadPair
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

const T0 = 1_000_000
const DAY = 86_400_000
const GOAL = '0f8fad5b-d9cb-469f-a165-70867728950e'
const target = (threadId = 'thread-1'): ThreadAuthorityTarget => ({
  route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project-1', threadId },
  conversationId: 'conversation-1',
  storageScope: 'profile/agents'
})
const trigger = (deliveryId = 'delivery-1'): RunGrantSubject => ({ kind: 'trigger', deliveryId })

/** A temporary SQLite file, an injected clock, one shared id source and a recording verifier. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'thread-authority-grant-'))
  dirs.push(dir)
  const file = join(dir, 'events.sqlite')
  const clock = { now: T0 }
  let serial = 0
  const newId = () => `id-${(serial += 1)}`
  const verifier = { calls: [] as RunGrantApprovalRequest[], answer: (): unknown => true }
  const verifyApproval = (request: RunGrantApprovalRequest) => {
    verifier.calls.push(request)
    return verifier.answer()
  }
  const open = () => {
    const store = new MagicAgentEventStore(file)
    stores.push(store)
    return store
  }
  const build = (store: MagicAgentEventStore) =>
    new ThreadAuthorityStore(store, { now: () => clock.now, newId, verifyApproval })
  const store = open()
  const authority = build(store)
  /** Each request carries a new approval proof unless the test passes one. */
  let proofs = 0
  const request = (pair: ThreadPair, over: Partial<RunGrantRequest> = {}): RunGrantRequest => ({
    threadId: pair.threadId,
    generation: pair.generation,
    subject: trigger(),
    limits: { turns: 10, toolCalls: 100, walltimeSeconds: 3600 },
    expiresAt: clock.now + DAY,
    approval: { approvedAt: clock.now - 5, proofId: `proof-${(proofs += 1)}` },
    ...over
  })
  const grant = (pair: ThreadPair, over: Partial<RunGrantRequest> = {}): string => {
    const result = authority.issueGrant(request(pair, over))
    if (!result.ok) throw new Error(`grant refused: ${result.reason}`)
    return result.grant.grantId
  }
  return { clock, open, build, store, authority, verifier, request, grant }
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
  operation: 'update' | 'delete',
  state?: unknown
) {
  const row = store.getResource(kind, id, { includeDeleted: true })!
  const eventId = `raw-${(rawSerial += 1)}`
  store.mutateResource({
    operation,
    kind,
    id,
    expectedRevision: row.revision,
    ...(operation === 'delete' ? {} : { state }),
    createdAt: row.updatedAt,
    idempotencyKey: eventId,
    event: {
      protocolVersion: '2.0.0',
      envelopeKind: 'event',
      id: eventId,
      type: 'raw.changed',
      createdAt: row.updatedAt,
      payload: {},
      streamId: `${kind}:${id}:stream`,
      sequence: row.revision + 1
    }
  })
}
const rawState = (store: MagicAgentEventStore, kind: string, id: string) =>
  structuredClone(store.getResource(kind, id)!.state) as Record<string, unknown>
const storedStatus = (store: MagicAgentEventStore, grantId: string) =>
  store.getResource<{ status: string; reason?: string }>(STATE, grantId)!.state

describe('run grant: issue', () => {
  it('stores one batch bound to the live generation; the verifier sees exactly what is stored', () => {
    const { authority, store, open, build, verifier, request } = setup()
    const pair = authority.issueThread(target())
    const input = request(pair)
    const spy = vi.spyOn(store, 'mutateResourcesBatch')
    const result = authority.issueGrant(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const grantId = result.grant.grantId
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].map((c) => [c.operation, c.kind, c.id])).toEqual([
      ['update', IDENTITY, expect.any(String)],
      ['create', GRANT, grantId],
      ['create', STATE, grantId]
    ])
    const storedGrant = store.getResource(GRANT, grantId)!.state
    expect(storedGrant).toEqual({ v: 1, grantId, issuedAt: T0, ...input })
    expect(store.getResource(STATE, grantId)!.state).toEqual({
      v: 1,
      grantId,
      status: 'active',
      used: { turns: 0, toolCalls: 0, walltimeSeconds: 0 },
      charges: []
    })
    expect(store.getResource(IDENTITY, spy.mock.calls[0][0][0].id)!.state).toMatchObject({
      grants: [grantId]
    })
    expect(verifier.calls).toHaveLength(1)
    const shown = verifier.calls[0]
    const {
      v: _v,
      grantId: _id,
      issuedAt: _at,
      ...storedValues
    } = storedGrant as Record<string, unknown>
    expect(shown).toEqual({ target: target(), ...storedValues })
    expect(Object.isFrozen(shown) && Object.isFrozen(shown.limits)).toBe(true)
    expect(Object.isFrozen(shown.subject) && Object.isFrozen(shown.target.route)).toBe(true)
    expect(result.grant).toEqual({
      grantId,
      ...input,
      issuedAt: T0,
      status: 'active',
      used: { turns: 0, toolCalls: 0, walltimeSeconds: 0 },
      remaining: input.limits,
      usable: true
    })
    expect(authority.readGrant(grantId)).toEqual(result.grant)
    expect(authority.listGrants(pair.threadId, pair.generation)).toEqual({
      ok: true,
      grants: [result.grant]
    })
    store.close()
    expect(build(open()).readGrant(grantId)).toEqual(result.grant)
  })

  it('copies the request once: changing it during approval changes nothing stored', () => {
    const { authority, store, verifier, request } = setup()
    const pair = authority.issueThread(target())
    const input = structuredClone(request(pair)) as {
      limits: { turns: number }
      subject: { deliveryId: string }
      expiresAt: number
    } & RunGrantRequest
    verifier.answer = () => {
      input.limits.turns = 100
      input.subject.deliveryId = 'other'
      input.expiresAt += DAY
      return true
    }
    const result = authority.issueGrant(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(store.getResource(GRANT, result.grant.grantId)!.state).toMatchObject({
      limits: { turns: 10 },
      subject: { deliveryId: 'delivery-1' },
      expiresAt: T0 + DAY
    })
    expect(verifier.calls[0]).toMatchObject({
      limits: { turns: 10 },
      subject: { deliveryId: 'delivery-1' }
    })
  })

  it('needs a live thread in the given generation: unknown, stale and revoked write nothing', () => {
    const { authority, store, verifier, request } = setup()
    const first = authority.issueThread(target())
    const before = footprint(store)
    expect(authority.issueGrant(request({ threadId: 'id-404', generation: 1 }))).toEqual({
      ok: false,
      reason: 'thread-unknown'
    })
    expect(authority.issueGrant(request({ ...first, generation: 2 }))).toEqual({
      ok: false,
      reason: 'thread-stale'
    })
    expect(footprint(store)).toEqual(before)
    authority.revokeThread(target())
    const revoked = footprint(store)
    expect(authority.issueGrant(request(first))).toEqual({ ok: false, reason: 'thread-revoked' })
    const second = authority.issueThread(target())
    const reissued = footprint(store)
    expect(authority.issueGrant(request(first))).toEqual({ ok: false, reason: 'thread-stale' })
    expect(footprint(store)).toEqual(reissued)
    expect(reissued[0]).toBe(revoked[0] + 2)
    expect(verifier.calls).toHaveLength(0)
    expect(store.countResources({ kind: GRANT, includeDeleted: true })).toBe(0)
    expect(authority.issueGrant(request(second)).ok).toBe(true)
  })

  it.each([
    ['false', () => false],
    ['1', () => 1],
    ['undefined', () => undefined],
    ['the string true', () => 'true'],
    ['an object', () => ({ ok: true })],
    ['a promise of true', () => Promise.resolve(true)],
    [
      'a throw',
      () => {
        throw new Error('verifier down')
      }
    ]
  ])('a verifier returning %s refuses and writes nothing', (_name, answer) => {
    const { authority, store, verifier, request } = setup()
    const pair = authority.issueThread(target())
    verifier.answer = answer
    const before = footprint(store)
    expect(authority.issueGrant(request(pair))).toEqual({ ok: false, reason: 'approval-refused' })
    expect(verifier.calls).toHaveLength(1)
    expect(footprint(store)).toEqual(before)
    expect(store.countResources({ kind: GRANT, includeDeleted: true })).toBe(0)
  })

  it('a verifier that revokes the thread while approving makes the issue throw the conflict', () => {
    const { authority, store, verifier, request } = setup()
    const pair = authority.issueThread(target())
    verifier.answer = () => {
      expect(authority.revokeThread(target())).toEqual({ status: 'revoked' })
      return true
    }
    expect(() => authority.issueGrant(request(pair))).toThrow(ResourceRevisionConflictError)
    expect(store.countResources({ kind: GRANT, includeDeleted: true })).toBe(0)
    expect(store.countResources({ kind: STATE, includeDeleted: true })).toBe(0)
    expect(authority.verifyThread(pair.threadId, 1)).toEqual({ ok: false, reason: 'revoked' })
    expect(authority.issueGrant(request(pair))).toEqual({ ok: false, reason: 'thread-revoked' })
  })

  it('a store built without a verifier throws in the constructor', () => {
    const { store } = setup()
    for (const options of [
      {},
      { verifyApproval: true },
      { verifyApproval: undefined, now: () => 1 },
      undefined
    ])
      expect(
        () => new ThreadAuthorityStore(store, options as unknown as ThreadAuthorityStoreOptions)
      ).toThrow(TypeError)
  })

  const invalid: [string, (r: RunGrantRequest) => unknown][] = [
    ['turns 0', (r) => ({ ...r, limits: { ...r.limits, turns: 0 } })],
    ['toolCalls 1.5', (r) => ({ ...r, limits: { ...r.limits, toolCalls: 1.5 } })],
    ['turns above 100', (r) => ({ ...r, limits: { ...r.limits, turns: 101 } })],
    ['toolCalls above 1000', (r) => ({ ...r, limits: { ...r.limits, toolCalls: 1001 } })],
    ['walltime above 86400', (r) => ({ ...r, limits: { ...r.limits, walltimeSeconds: 86_401 } })],
    ['negative walltime', (r) => ({ ...r, limits: { ...r.limits, walltimeSeconds: -1 } })],
    ['infinite turns', (r) => ({ ...r, limits: { ...r.limits, turns: Infinity } })],
    ['missing axis', (r) => ({ ...r, limits: { turns: 1, toolCalls: 1 } })],
    ['extra limit key', (r) => ({ ...r, limits: { ...r.limits, tokens: 5 } })],
    ['expiry at now', (r) => ({ ...r, expiresAt: T0 })],
    ['expiry before now', (r) => ({ ...r, expiresAt: T0 - 1 })],
    [
      'expiry beyond the lifetime',
      (r) => ({ ...r, expiresAt: T0 + MAX_RUN_GRANT_LIFETIME_MS + 1 })
    ],
    ['fractional expiry', (r) => ({ ...r, expiresAt: T0 + 0.5 })],
    ['approval in the future', (r) => ({ ...r, approval: { ...r.approval, approvedAt: T0 + 1 } })],
    ['approval without proof', (r) => ({ ...r, approval: { approvedAt: T0 } })],
    ['approval proof not an id', (r) => ({ ...r, approval: { ...r.approval, proofId: 'a b' } })],
    ['approval extra key', (r) => ({ ...r, approval: { ...r.approval, by: 'user' } })],
    ['deliveryId not an id', (r) => ({ ...r, subject: { kind: 'trigger', deliveryId: '' } })],
    ['subject extra key', (r) => ({ ...r, subject: { ...trigger(), prompt: 'go' } })],
    ['unknown subject kind', (r) => ({ ...r, subject: { kind: 'channel', deliveryId: 'd' } })],
    [
      'goalId not a v4 UUID',
      (r) => ({ ...r, subject: { kind: 'goal', goalId: GOAL.toUpperCase(), goalGeneration: 1 } })
    ],
    [
      'goalGeneration 0',
      (r) => ({ ...r, subject: { kind: 'goal', goalId: GOAL, goalGeneration: 0 } })
    ],
    ['threadId not an id', (r) => ({ ...r, threadId: 'id 1' })],
    ['generation 0', (r) => ({ ...r, generation: 0 })],
    ['extra request key', (r) => ({ ...r, status: 'active' })],
    ['missing approval', ({ approval: _a, ...r }) => r]
  ]
  it.each(invalid)('rejects %s before any read and writes nothing', (_name, change) => {
    const { authority, store, verifier, request } = setup()
    const pair = authority.issueThread(target())
    const before = footprint(store)
    const reads = vi.spyOn(store, 'getResource')
    expect(() => authority.issueGrant(change(request(pair)) as RunGrantRequest)).toThrow()
    expect(reads).not.toHaveBeenCalled()
    expect(verifier.calls).toHaveLength(0)
    expect(footprint(store)).toEqual(before)
  })

  it('accepts the boundary values of every limit, expiry and approval time', () => {
    const { authority, request } = setup()
    const pair = authority.issueThread(target())
    for (const [index, over] of [
      { limits: { turns: 1, toolCalls: 1, walltimeSeconds: 1 } },
      { limits: { turns: 100, toolCalls: 1000, walltimeSeconds: 86_400 } },
      { expiresAt: T0 + 1 },
      { expiresAt: T0 + MAX_RUN_GRANT_LIFETIME_MS },
      { approval: { approvedAt: T0, proofId: 'p' } },
      { subject: { kind: 'goal' as const, goalId: GOAL, goalGeneration: 1 } }
    ].entries())
      expect(
        authority.issueGrant(request(pair, { subject: trigger(`d-${index}`), ...over })).ok
      ).toBe(true)
  })
})

describe('run grant: one active grant per subject', () => {
  it('refuses a second grant while the first is active; accepts after revoke or expiry', () => {
    const { authority, store, clock, verifier, request, grant } = setup()
    const pair = authority.issueThread(target())
    const first = grant(pair)
    const before = footprint(store)
    expect(authority.issueGrant(request(pair))).toEqual({
      ok: false,
      reason: 'subject-has-active-grant'
    })
    expect(footprint(store)).toEqual(before)
    expect(verifier.calls).toHaveLength(1)
    expect(authority.issueGrant(request(pair, { subject: trigger('delivery-2') })).ok).toBe(true)
    authority.revokeGrant(first, 'user')
    const second = grant(pair)
    expect(second).not.toBe(first)
    const short = grant(pair, { subject: trigger('delivery-3'), expiresAt: T0 + 1000 })
    clock.now = T0 + 999
    expect(authority.issueGrant(request(pair, { subject: trigger('delivery-3') }))).toEqual({
      ok: false,
      reason: 'subject-has-active-grant'
    })
    clock.now = T0 + 1000
    expect(authority.readGrant(short)?.status).toBe('expired')
    expect(authority.issueGrant(request(pair, { subject: trigger('delivery-3') })).ok).toBe(true)
  })

  it('records the expiry an issue relied on: a clock set back never revives the earlier grant', () => {
    const { authority, store, clock, request, grant } = setup()
    const pair = authority.issueThread(target())
    const first = grant(pair, { expiresAt: T0 + 1000 })
    const firstRevision = store.getResourceRevision(STATE, first)!
    clock.now = T0 + 2000
    const spy = vi.spyOn(store, 'mutateResourcesBatch')
    const second = grant(pair, { approval: { approvedAt: T0 + 1990, proofId: 'proof-2' } })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].map((c) => [c.operation, c.kind, c.id])).toEqual([
      ['update', IDENTITY, expect.any(String)],
      ['update', STATE, first],
      ['create', GRANT, second],
      ['create', STATE, second]
    ])
    expect(storedStatus(store, first)).toMatchObject({ status: 'expired', endedAt: T0 + 2000 })
    expect(store.getResourceRevision(STATE, first)).toBe(firstRevision + 1)
    spy.mockRestore()
    // Back inside the window of the first grant: it stays expired, and the second is not
    // usable before its issuedAt, so the subject never has two usable grants.
    clock.now = T0 + 500
    const before = footprint(store)
    expect(authority.readGrant(first)).toMatchObject({ status: 'expired', usable: false })
    expect(authority.chargeGrant(first, pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'expired'
    })
    expect(authority.readGrant(second)).toMatchObject({ status: 'active', usable: false })
    expect(
      authority.issueGrant(request(pair, { approval: { approvedAt: 1, proofId: 'p-3' } }))
    ).toEqual({ ok: false, reason: 'subject-has-active-grant' })
    expect(footprint(store)).toEqual(before)
    clock.now = T0 + 2500
    expect(authority.listGrants(pair.threadId, 1)).toMatchObject({
      ok: true,
      grants: [
        { grantId: first, status: 'expired', usable: false },
        { grantId: second, status: 'active', usable: true }
      ]
    })
  })

  it('a charge recording the expiry inside that issue makes the issue throw the conflict; the retry issues', () => {
    const { open, build, clock, request } = setup()
    const a = open(),
      b = open()
    const A = build(a),
      B = build(b)
    const pair = A.issueThread(target())
    const first = A.issueGrant(request(pair, { expiresAt: T0 + 1000 }))
    if (!first.ok) throw new Error('grant refused')
    clock.now = T0 + 2000
    const next = request(pair, { approval: { approvedAt: T0 + 1990, proofId: 'proof-2' } })
    const commit = a.mutateResourcesBatch.bind(a)
    const spy = vi.spyOn(a, 'mutateResourcesBatch').mockImplementationOnce((commands) => {
      expect(B.chargeGrant(first.grant.grantId, pair, 'b-1', { turns: 1 })).toEqual({
        ok: false,
        reason: 'expired'
      })
      return commit(commands)
    })
    expect(() => A.issueGrant(next)).toThrow(ResourceRevisionConflictError)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(a.countResources({ kind: GRANT, includeDeleted: true })).toBe(1)
    const retry = A.issueGrant(next)
    expect(retry.ok).toBe(true)
    expect(storedStatus(a, first.grant.grantId)).toMatchObject({
      status: 'expired',
      endedAt: T0 + 2000
    })
  })

  it('the same goalId with another goalGeneration is another subject', () => {
    const { authority, request } = setup()
    const pair = authority.issueThread(target())
    const goal = (goalGeneration: number) => ({
      kind: 'goal' as const,
      goalId: GOAL,
      goalGeneration
    })
    expect(authority.issueGrant(request(pair, { subject: goal(1) })).ok).toBe(true)
    expect(authority.issueGrant(request(pair, { subject: goal(1) }))).toEqual({
      ok: false,
      reason: 'subject-has-active-grant'
    })
    expect(authority.issueGrant(request(pair, { subject: goal(2) })).ok).toBe(true)
    expect(authority.issueGrant(request(pair, { subject: trigger(GOAL) })).ok).toBe(true)
  })
})

describe('run grant: revoke, pause, expiry and the thread cascade', () => {
  it('a paused grant is unusable, stays so after reopen, and nothing makes it active again', () => {
    const { authority, store, open, build, clock, request, grant } = setup()
    const pair = authority.issueThread(target())
    const id = grant(pair)
    clock.now += 50
    const paused = authority.revokeGrant(id, 'paused')
    expect(paused).toMatchObject({
      ok: true,
      changed: true,
      grant: { status: 'revoked', reason: 'paused', endedAt: T0 + 50, usable: false }
    })
    const expected = (authority.revokeGrant(id, 'paused') as { grant: unknown }).grant
    const after = footprint(store)
    expect(authority.revokeGrant(id, 'user')).toEqual({ ok: true, changed: false, grant: expected })
    expect(authority.revokeGrant(id, 'subject-ended')).toEqual({
      ok: true,
      changed: false,
      grant: expected
    })
    expect(footprint(store)).toEqual(after)
    store.close()
    const reopenedStore = open()
    const reopened = build(reopenedStore)
    expect(reopened.readGrant(id)).toEqual(expected)
    expect(reopened.issueGrant(request(pair)).ok).toBe(true)
    reopened.issueThread(target())
    for (const now of [T0, T0 + 10, T0 + DAY * 2]) {
      clock.now = now
      expect(reopened.readGrant(id)).toMatchObject({
        status: 'revoked',
        reason: 'paused',
        usable: false
      })
    }
    reopened.revokeThread(target())
    reopened.issueThread(target())
    expect(reopened.readGrant(id)).toMatchObject({
      status: 'revoked',
      reason: 'paused',
      usable: false
    })
    expect(storedStatus(reopenedStore, id)).toMatchObject({ status: 'revoked', reason: 'paused' })
  })

  it('no resume: the approval of a paused, ended, exhausted or lapsed grant never issues another for its subject', () => {
    const { authority, store, open, build, clock, verifier, request } = setup()
    const pair = authority.issueThread(target())
    const ends: [string, (grantId: string) => unknown][] = [
      ['paused', (grantId) => authority.revokeGrant(grantId, 'paused')],
      ['user', (grantId) => authority.revokeGrant(grantId, 'user')],
      ['subject-ended', (grantId) => authority.revokeGrant(grantId, 'subject-ended')],
      ['exhausted', (grantId) => authority.chargeGrant(grantId, pair, 'c-1', { turns: 11 })],
      ['lapsed', () => (clock.now += DAY)]
    ]
    const replays: RunGrantRequest[] = []
    for (const [name, end] of ends) {
      const input = request(pair, { subject: trigger(`d-${name}`) })
      const first = authority.issueGrant(input)
      if (!first.ok) throw new Error('grant refused')
      end(first.grant.grantId)
      expect(authority.readGrant(first.grant.grantId)?.usable).toBe(false)
      const replay = clock.now < input.expiresAt ? input : { ...input, expiresAt: clock.now + DAY }
      replays.push(replay)
      const calls = verifier.calls.length
      const before = footprint(store)
      expect(authority.issueGrant(replay)).toEqual({ ok: false, reason: 'approval-refused' })
      expect(verifier.calls).toHaveLength(calls)
      expect(footprint(store)).toEqual(before)
    }
    store.close()
    const reopened = build(open())
    for (const replay of replays)
      expect(reopened.issueGrant({ ...replay, expiresAt: clock.now + DAY })).toEqual({
        ok: false,
        reason: 'approval-refused'
      })
    // A new approval issues a new grant; the old approval for another subject is for the
    // verifier to judge, and so is any approval in a later generation (it is shown the new pair).
    const subject = replays[0].subject
    expect(reopened.issueGrant(request(pair, { subject })).ok).toBe(true)
    expect(
      reopened.issueGrant(
        request(pair, { subject: trigger('other'), approval: replays[0].approval })
      ).ok
    ).toBe(true)
    reopened.revokeThread(target())
    const next = reopened.issueThread(target())
    verifier.answer = () => false
    expect(reopened.issueGrant({ ...replays[0], ...next, expiresAt: clock.now + DAY })).toEqual({
      ok: false,
      reason: 'approval-refused'
    })
    expect(verifier.calls.at(-1)).toMatchObject({ ...next, approval: replays[0].approval })
  })

  it('expiry is computed by reading: usable at expiresAt - 1, expired at expiresAt, nothing written', () => {
    const { authority, store, clock, grant } = setup()
    const pair = authority.issueThread(target())
    const id = grant(pair, { expiresAt: T0 + 1000 })
    const revision = store.getResourceRevision(STATE, id)
    const before = footprint(store)
    clock.now = T0 + 999
    expect(authority.readGrant(id)).toMatchObject({ status: 'active', usable: true })
    clock.now = T0 + 1000
    expect(authority.readGrant(id)).toMatchObject({ status: 'expired', usable: false })
    expect(authority.listGrants(pair.threadId, 1)).toMatchObject({
      ok: true,
      grants: [{ grantId: id, status: 'expired', usable: false }]
    })
    expect(store.getResourceRevision(STATE, id)).toBe(revision)
    expect(footprint(store)).toEqual(before)
    // An expiry that no charge recorded is computed from the clock alone.
    clock.now = T0 + 999
    expect(authority.readGrant(id)).toMatchObject({ status: 'active', usable: true })
    clock.now = T0 - 1
    expect(authority.readGrant(id)).toMatchObject({ status: 'active', usable: false })
  })

  it('the cascade commits with the clock set back below a grant state newer than the identity', () => {
    const { authority, store, clock, grant } = setup()
    const pair = authority.issueThread(target())
    clock.now = T0 + 5_000
    const id = grant(pair)
    clock.now = T0 + 9_000
    expect(authority.chargeGrant(id, pair, 'c-1', { turns: 1 }).ok).toBe(true)
    const key = store.listResources({ kind: IDENTITY })[0].id
    expect(store.getResource(IDENTITY, key)!.updatedAt).toBe(T0 + 5_000)
    clock.now = T0 + 100
    expect(authority.revokeThread(target())).toEqual({ status: 'revoked' })
    expect(storedStatus(store, id)).toMatchObject({
      status: 'revoked',
      reason: 'thread-revoked',
      endedAt: T0 + 100
    })
    for (const [kind, rowId] of [
      [IDENTITY, key],
      [STATE, id]
    ])
      expect(store.getResource(kind, rowId)!.updatedAt).toBe(T0 + 9_000)
  })

  it('revokes with the clock set back below the updatedAt of the grant state', () => {
    const { authority, store, clock, grant } = setup()
    clock.now = 5_000_000
    const pair = authority.issueThread(target())
    const id = grant(pair)
    clock.now = 1_000
    expect(authority.revokeGrant(id, 'user')).toMatchObject({ ok: true, changed: true })
    expect(storedStatus(store, id)).toMatchObject({ status: 'revoked', reason: 'user' })
  })

  it('revokeThread writes thread-revoked to every stored-active grant in the same batch', () => {
    const { authority, store, clock, request, grant } = setup()
    const pair = authority.issueThread(target())
    const active = grant(pair, { subject: trigger('a') })
    const expired = grant(pair, { subject: trigger('b'), expiresAt: T0 + 100 })
    const paused = grant(pair, { subject: trigger('c') })
    authority.revokeGrant(paused, 'paused')
    clock.now = T0 + 500
    expect(authority.readGrant(expired)?.status).toBe('expired')
    const spy = vi.spyOn(store, 'mutateResourcesBatch')
    expect(authority.revokeThread(target())).toEqual({ status: 'revoked' })
    expect(spy).toHaveBeenCalledTimes(1)
    const commands = spy.mock.calls[0][0] as readonly ResourceMutationInput[]
    expect(commands.map((c) => [c.kind, c.id])).toEqual([
      [IDENTITY, expect.any(String)],
      [STATE, active],
      [STATE, expired]
    ])
    for (const id of [active, expired])
      expect(storedStatus(store, id)).toEqual(
        expect.objectContaining({ status: 'revoked', reason: 'thread-revoked', endedAt: T0 + 500 })
      )
    expect(storedStatus(store, paused)).toMatchObject({ status: 'revoked', reason: 'paused' })
    expect(authority.listGrants(pair.threadId, 1)).toMatchObject({
      ok: true,
      grants: [
        { grantId: active, status: 'revoked', reason: 'thread-revoked', usable: false },
        { grantId: expired, status: 'revoked', reason: 'thread-revoked', usable: false },
        { grantId: paused, status: 'revoked', reason: 'paused', usable: false }
      ]
    })
    const next = authority.issueThread(target())
    expect(authority.listGrants(next.threadId, 2)).toEqual({ ok: true, grants: [] })
    expect(authority.listGrants(pair.threadId, 1)).toEqual({ ok: false, reason: 'thread-stale' })
    expect(authority.issueGrant(request(pair, { subject: trigger('a') }))).toEqual({
      ok: false,
      reason: 'thread-stale'
    })
    for (const id of [active, expired, paused])
      expect(authority.readGrant(id)).toMatchObject({ status: 'revoked', usable: false })
    expect(authority.issueGrant(request(next, { subject: trigger('a') })).ok).toBe(true)
  })

  it('a crash before commit during the cascade changes nothing and the retry completes', () => {
    const { authority, store, grant } = setup()
    const pair = authority.issueThread(target())
    const ids = [grant(pair, { subject: trigger('a') }), grant(pair, { subject: trigger('b') })]
    const revisions = () => [
      store.getResourceRevision(IDENTITY, store.listResources({ kind: IDENTITY })[0].id),
      ...ids.map((id) => store.getResourceRevision(STATE, id))
    ]
    const before = revisions()
    const written = footprint(store)
    _crashTesting.setHook((stage) => {
      if (stage === 'resource.before-commit') throw new Error('crash before commit')
    })
    expect(() => authority.revokeThread(target())).toThrow('crash before commit')
    _crashTesting.setHook(null)
    expect(revisions()).toEqual(before)
    expect(footprint(store)).toEqual(written)
    expect(authority.verifyThread(pair.threadId, 1).ok).toBe(true)
    expect(authority.readGrant(ids[0])?.usable).toBe(true)
    expect(authority.revokeThread(target())).toEqual({ status: 'revoked' })
    for (const id of ids)
      expect(storedStatus(store, id)).toMatchObject({ status: 'revoked', reason: 'thread-revoked' })
  })

  it('refuses the grant after capacity; a new generation accepts grants again', () => {
    const { authority, store, verifier, request, grant } = setup()
    const pair = authority.issueThread(target())
    const ids = Array.from({ length: MAX_RUN_GRANTS_PER_GENERATION }, (_, i) =>
      grant(pair, { subject: trigger(`d-${i}`) })
    )
    const calls = verifier.calls.length
    authority.revokeGrant(ids[0], 'user')
    const before = footprint(store)
    expect(authority.issueGrant(request(pair, { subject: trigger('d-64') }))).toEqual({
      ok: false,
      reason: 'capacity'
    })
    expect(footprint(store)).toEqual(before)
    expect(verifier.calls).toHaveLength(calls)
    const spy = vi.spyOn(store, 'mutateResourcesBatch')
    authority.revokeThread(target())
    expect(spy.mock.calls[0][0]).toHaveLength(MAX_RUN_GRANTS_PER_GENERATION)
    const next = authority.issueThread(target())
    expect(authority.issueGrant(request(next, { subject: trigger('d-64') })).ok).toBe(true)
  })

  it('rejects invalid grant ids, pairs and revoke reasons before any read; unknown writes nothing', () => {
    const { authority, store } = setup()
    const reads = vi.spyOn(store, 'getResource')
    for (const call of [
      () => authority.readGrant(''),
      () => authority.readGrant('a b'),
      () => authority.listGrants('id-1', 0),
      () => authority.revokeGrant('id-1', 'thread-revoked' as 'user'),
      () => authority.revokeGrant('id-1', 'exhausted' as 'user'),
      () => authority.revokeGrant('', 'user')
    ])
      expect(call).toThrow(TypeError)
    expect(reads).not.toHaveBeenCalled()
    expect(authority.readGrant('id-404')).toBeUndefined()
    expect(authority.revokeGrant('id-404', 'user')).toEqual({ ok: false, reason: 'unknown' })
    expect(authority.listGrants('id-404', 1)).toEqual({ ok: false, reason: 'thread-unknown' })
    expect(footprint(store)).toEqual([0, 0])
  })
})

describe('run grant: races on two connections', () => {
  it('B revokes the thread inside the write of A: A throws the conflict and leaves no trace of its grant', () => {
    const { open, build, request } = setup()
    const a = open(),
      b = open()
    const A = build(a),
      B = build(b)
    const pair = A.issueThread(target())
    const commit = a.mutateResourcesBatch.bind(a)
    let grantId = ''
    const spy = vi.spyOn(a, 'mutateResourcesBatch').mockImplementationOnce((commands) => {
      grantId = commands.find((c) => c.kind === GRANT)!.id
      expect(B.revokeThread(target())).toEqual({ status: 'revoked' })
      return commit(commands)
    })
    expect(() => A.issueGrant(request(pair))).toThrow(ResourceRevisionConflictError)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(grantId).not.toBe('')
    for (const kind of [GRANT, STATE]) expect(a.hasResourceEvidence(kind, grantId)).toBe(false)
    expect(A.listGrants(pair.threadId, 1)).toEqual({ ok: true, grants: [] })
    expect(A.issueGrant(request(pair))).toEqual({ ok: false, reason: 'thread-revoked' })
  })

  it('A and B issue for the same subject at once: exactly one grant', () => {
    const { open, build, request } = setup()
    const a = open(),
      b = open()
    const A = build(a),
      B = build(b)
    const pair = A.issueThread(target())
    const commit = a.mutateResourcesBatch.bind(a)
    let inner: ReturnType<ThreadAuthorityStore['issueGrant']> | undefined
    vi.spyOn(a, 'mutateResourcesBatch').mockImplementationOnce((commands) => {
      inner = B.issueGrant(request(pair))
      return commit(commands)
    })
    expect(() => A.issueGrant(request(pair))).toThrow(ResourceRevisionConflictError)
    expect(inner?.ok).toBe(true)
    expect(a.countResources({ kind: GRANT, includeDeleted: true })).toBe(1)
    expect(a.countResources({ kind: STATE, includeDeleted: true })).toBe(1)
    expect(A.issueGrant(request(pair))).toEqual({ ok: false, reason: 'subject-has-active-grant' })
  })

  it('B pauses the grant inside the revoke of A: A throws the conflict, the pause stays', () => {
    const { open, build, grant } = setup()
    const a = open(),
      b = open()
    const A = build(a),
      B = build(b)
    const pair = A.issueThread(target())
    const id = grant(pair)
    const commit = a.mutateResourcesBatch.bind(a)
    vi.spyOn(a, 'mutateResourcesBatch').mockImplementationOnce((commands) => {
      B.revokeGrant(id, 'paused')
      return commit(commands)
    })
    expect(() => A.revokeGrant(id, 'user')).toThrow(ResourceRevisionConflictError)
    expect(A.revokeGrant(id, 'user')).toMatchObject({
      ok: true,
      changed: false,
      grant: { status: 'revoked', reason: 'paused' }
    })
  })
})

describe('run grant: unavailable rows fail closed', () => {
  type Damage = (store: MagicAgentEventStore, grantId: string) => void
  const change =
    (kind: string, edit: (state: Record<string, unknown>) => Record<string, unknown>): Damage =>
    (store, grantId) =>
      rawWrite(store, kind, grantId, 'update', edit(rawState(store, kind, grantId)))
  const shapes: [string, Damage][] = [
    ['grant with v: 2', change(GRANT, (s) => ({ ...s, v: 2 }))],
    ['grant with an extra key', change(GRANT, (s) => ({ ...s, prompt: 'go' }))],
    ['grant naming another grant id', change(GRANT, (s) => ({ ...s, grantId: 'id-999' }))],
    ['grant bound to another generation', change(GRANT, (s) => ({ ...s, generation: 2 }))],
    [
      'grant with a limit above its ceiling',
      change(GRANT, (s) => ({ ...s, limits: { turns: 101, toolCalls: 1, walltimeSeconds: 1 } }))
    ],
    [
      'grant expiring beyond its lifetime',
      change(GRANT, (s) => ({
        ...s,
        expiresAt: (s.issuedAt as number) + MAX_RUN_GRANT_LIFETIME_MS + 1
      }))
    ],
    ['grant deleted', (store, id) => rawWrite(store, GRANT, id, 'delete')],
    ['state with v: 2', change(STATE, (s) => ({ ...s, v: 2 }))],
    ['state with an extra key', change(STATE, (s) => ({ ...s, note: 1 }))],
    ['state naming another grant id', change(STATE, (s) => ({ ...s, grantId: 'id-999' }))],
    ['state with an unknown status', change(STATE, (s) => ({ ...s, status: 'resumed' }))],
    [
      'state used above a limit',
      change(STATE, (s) => ({ ...s, used: { turns: 11, toolCalls: 0, walltimeSeconds: 0 } }))
    ],
    [
      'state revoked without a reason',
      change(STATE, (s) => ({ ...s, status: 'revoked', endedAt: 1 }))
    ],
    ['state deleted', (store, id) => rawWrite(store, STATE, id, 'delete')],
    [
      'identity of the thread with v: 2',
      (store) => {
        const key = store.listResources({ kind: IDENTITY })[0].id
        rawWrite(store, IDENTITY, key, 'update', { ...rawState(store, IDENTITY, key), v: 2 })
      }
    ],
    [
      'index of the thread deleted',
      (store, id) => {
        const threadId = rawState(store, GRANT, id).threadId as string
        rawWrite(store, INDEX, threadId, 'delete')
      }
    ]
  ]
  const methods = (
    authority: ThreadAuthorityStore,
    pair: ThreadPair,
    grantId: string,
    request: (p: ThreadPair, o?: Partial<RunGrantRequest>) => RunGrantRequest
  ) => [
    () => authority.issueGrant(request(pair, { subject: trigger('other') })),
    () => authority.readGrant(grantId),
    () => authority.listGrants(pair.threadId, pair.generation),
    () => authority.revokeGrant(grantId, 'user'),
    () => authority.revokeThread(target()),
    () => authority.chargeGrant(grantId, pair, 'c-1', { turns: 1 })
  ]
  it.each(shapes)(
    '%s: issue, read, list, revoke and the cascade throw and write nothing',
    (_name, damage) => {
      const { authority, store, request, grant, verifier } = setup()
      const pair = authority.issueThread(target())
      const id = grant(pair)
      damage(store, id)
      const before = footprint(store)
      const calls = verifier.calls.length
      for (const call of methods(authority, pair, id, request))
        expect(call).toThrow(ThreadAuthorityUnavailableError)
      expect(footprint(store)).toEqual(before)
      expect(verifier.calls).toHaveLength(calls)
    }
  )

  it.each([
    ['a grant without its state', STATE],
    ['a state without its grant', GRANT]
  ])('%s (a partial batch) is unavailable everywhere', (_name, dropped) => {
    const { authority, store, request } = setup()
    const pair = authority.issueThread(target())
    const commit = store.mutateResourcesBatch.bind(store)
    vi.spyOn(store, 'mutateResourcesBatch').mockImplementationOnce((commands) =>
      commit(commands.filter((c) => c.kind !== dropped))
    )
    const result = authority.issueGrant(request(pair))
    if (!result.ok) throw new Error('expected the partial write to pass through')
    const before = footprint(store)
    for (const call of methods(authority, pair, result.grant.grantId, request))
      expect(call).toThrow(ThreadAuthorityUnavailableError)
    expect(footprint(store)).toEqual(before)
  })

  it('a stored-active grant of a revoked thread (a partial cascade) reads as thread-revoked', () => {
    const { authority, store, request, grant } = setup()
    const pair = authority.issueThread(target())
    const id = grant(pair)
    const commit = store.mutateResourcesBatch.bind(store)
    vi.spyOn(store, 'mutateResourcesBatch').mockImplementationOnce((commands) =>
      commit(commands.filter((c) => c.kind !== STATE))
    )
    authority.revokeThread(target())
    expect(storedStatus(store, id)).toMatchObject({ status: 'active' })
    expect(authority.readGrant(id)).toMatchObject({
      status: 'revoked',
      reason: 'thread-revoked',
      usable: false
    })
    expect(authority.listGrants(pair.threadId, 1)).toMatchObject({
      ok: true,
      grants: [{ grantId: id, status: 'revoked', reason: 'thread-revoked', usable: false }]
    })
    const next = authority.issueThread(target())
    expect(authority.readGrant(id)).toMatchObject({ status: 'revoked', usable: false })
    expect(authority.issueGrant(request(next)).ok).toBe(true)
  })

  it('a grant its identity does not list (a partial batch) cannot be read, revoked or charged', () => {
    const { authority, store, request } = setup()
    const pair = authority.issueThread(target())
    const commit = store.mutateResourcesBatch.bind(store)
    vi.spyOn(store, 'mutateResourcesBatch').mockImplementationOnce((commands) =>
      commit(commands.filter((c) => c.kind !== IDENTITY))
    )
    const result = authority.issueGrant(request(pair))
    if (!result.ok) throw new Error('expected the partial write to pass through')
    const before = footprint(store)
    expect(() => authority.readGrant(result.grant.grantId)).toThrow(ThreadAuthorityUnavailableError)
    expect(() => authority.revokeGrant(result.grant.grantId, 'user')).toThrow(
      ThreadAuthorityUnavailableError
    )
    expect(() => authority.chargeGrant(result.grant.grantId, pair, 'c-1', { turns: 1 })).toThrow(
      ThreadAuthorityUnavailableError
    )
    expect(footprint(store)).toEqual(before)
  })
})
