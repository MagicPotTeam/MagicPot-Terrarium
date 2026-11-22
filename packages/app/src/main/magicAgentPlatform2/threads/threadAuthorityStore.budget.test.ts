import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore, ResourceRevisionConflictError } from '../persistence/eventStore'
import {
  RUN_GRANT_CHARGE_HISTORY,
  RUN_GRANT_STATE_KIND as STATE,
  ThreadAuthorityStore,
  type RunGrantAmounts,
  type RunGrantAxis,
  type RunGrantRequest,
  type ThreadAuthorityTarget,
  type ThreadPair
} from './threadAuthorityStore'

vi.unmock('node:fs')

const dirs: string[] = []
const stores: MagicAgentEventStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const T0 = 1_000_000
const DAY = 86_400_000
const LIMITS: RunGrantAmounts = { turns: 5, toolCalls: 7, walltimeSeconds: 9 }
const AXES: RunGrantAxis[] = ['turns', 'toolCalls', 'walltimeSeconds']
const target = (threadId = 'thread-1'): ThreadAuthorityTarget => ({
  route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project-1', threadId },
  conversationId: 'conversation-1',
  storageScope: 'profile/agents'
})

/** A temporary SQLite file, an injected clock, one shared id source and an approving verifier. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'thread-authority-budget-'))
  dirs.push(dir)
  const file = join(dir, 'events.sqlite')
  const clock = { now: T0 }
  let serial = 0
  const newId = () => `id-${(serial += 1)}`
  const open = () => {
    const store = new MagicAgentEventStore(file)
    stores.push(store)
    return store
  }
  const build = (store: MagicAgentEventStore) =>
    new ThreadAuthorityStore(store, { now: () => clock.now, newId, verifyApproval: () => true })
  const store = open()
  const authority = build(store)
  const grant = (pair: ThreadPair, over: Partial<RunGrantRequest> = {}): string => {
    const result = authority.issueGrant({
      threadId: pair.threadId,
      generation: pair.generation,
      subject: { kind: 'trigger', deliveryId: 'delivery-1' },
      limits: LIMITS,
      expiresAt: clock.now + DAY,
      approval: { approvedAt: clock.now, proofId: 'proof-1' },
      ...over
    })
    if (!result.ok) throw new Error(`grant refused: ${result.reason}`)
    return result.grant.grantId
  }
  const pair = authority.issueThread(target())
  return { clock, open, build, store, authority, grant, pair, id: grant(pair) }
}
const footprint = (store: MagicAgentEventStore) => [
  store.countEvents(),
  store.countResources({ includeDeleted: true })
]
const stateOf = (store: MagicAgentEventStore, id: string) =>
  store.getResource<{ status: string; reason?: string; used: RunGrantAmounts; charges: string[] }>(
    STATE,
    id
  )!.state
const only = (axis: RunGrantAxis, value: number): Partial<RunGrantAmounts> => ({ [axis]: value })

/** A small deterministic generator (mulberry32) so a failing seed can be replayed. */
function random(seed: number) {
  let a = seed >>> 0
  return (max: number) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) % (max + 1)) as number
  }
}

describe('run grant budget: hard limits', () => {
  it.each(AXES)(
    '%s: charging to exactly the limit succeeds; one more exhausts, adding nothing',
    (axis) => {
      const { authority, store, pair, id } = setup()
      const others = AXES.filter((name) => name !== axis)
      const first = authority.chargeGrant(id, pair, 'c-1', {
        ...only(others[0], 1),
        ...only(others[1], 1)
      })
      expect(first).toMatchObject({ ok: true, replay: false })
      expect(authority.chargeGrant(id, pair, 'c-2', only(axis, LIMITS[axis] - 1))).toMatchObject({
        ok: true
      })
      const atLimit = authority.chargeGrant(id, pair, 'c-3', only(axis, 1))
      expect(atLimit).toMatchObject({ ok: true, replay: false, remaining: { [axis]: 0 } })
      expect(authority.readGrant(id)).toMatchObject({ status: 'active', usable: true })
      const before = stateOf(store, id).used
      expect(before[axis]).toBe(LIMITS[axis])
      expect(authority.chargeGrant(id, pair, 'c-4', only(axis, 1))).toEqual({
        ok: false,
        reason: 'exhausted',
        axis
      })
      expect(stateOf(store, id)).toMatchObject({ status: 'exhausted', reason: axis, used: before })
      for (const name of others) expect(stateOf(store, id).used[name]).toBe(1)
      const after = footprint(store)
      expect(authority.chargeGrant(id, pair, 'c-5', only(others[0], 1))).toEqual({
        ok: false,
        reason: 'exhausted',
        axis
      })
      expect(footprint(store)).toEqual(after)
      expect(authority.readGrant(id)).toMatchObject({
        status: 'exhausted',
        reason: axis,
        usable: false
      })
    }
  )

  it('a three-axis charge where one axis would overflow adds nothing to any axis', () => {
    const { authority, store, pair, id } = setup()
    authority.chargeGrant(id, pair, 'c-1', { turns: 1, toolCalls: 1, walltimeSeconds: 1 })
    expect(
      authority.chargeGrant(id, pair, 'c-2', { turns: 1, toolCalls: 7, walltimeSeconds: 1 })
    ).toEqual({
      ok: false,
      reason: 'exhausted',
      axis: 'toolCalls'
    })
    expect(stateOf(store, id).used).toEqual({ turns: 1, toolCalls: 1, walltimeSeconds: 1 })
  })

  it.each([
    [{ turns: 6, toolCalls: 8, walltimeSeconds: 10 }, 'turns'],
    [{ turns: 5, toolCalls: 8, walltimeSeconds: 10 }, 'toolCalls'],
    [{ turns: 5, toolCalls: 7, walltimeSeconds: 10 }, 'walltimeSeconds'],
    [{ turns: Number.MAX_SAFE_INTEGER }, 'turns'],
    [{ walltimeSeconds: Number.MAX_SAFE_INTEGER, toolCalls: Number.MAX_SAFE_INTEGER }, 'toolCalls']
  ] as const)(
    'names the first overflowing axis in the order turns, toolCalls, walltimeSeconds (%o)',
    (amounts, axis) => {
      const { authority, store, pair, id } = setup()
      expect(authority.chargeGrant(id, pair, 'c-1', amounts)).toEqual({
        ok: false,
        reason: 'exhausted',
        axis
      })
      expect(stateOf(store, id).used).toEqual({ turns: 0, toolCalls: 0, walltimeSeconds: 0 })
    }
  )

  it.each([1, 2, 3, 4, 5])(
    'seed %i: random charges with a reopen in the middle never exceed a limit and end exhausted',
    (seed) => {
      const { authority, store, open, build, grant, pair } = setup()
      const limits = { turns: 60, toolCalls: 400, walltimeSeconds: 600 }
      const id = grant(pair, { subject: { kind: 'trigger', deliveryId: 'random' }, limits })
      const next = random(seed)
      let subject = authority
      let current = store
      const accepted = { turns: 0, toolCalls: 0, walltimeSeconds: 0 }
      let last: ReturnType<ThreadAuthorityStore['chargeGrant']> | undefined
      let reopened = false
      for (let step = 0; step < 400; step += 1) {
        if (step === 30) {
          current.close()
          current = open()
          subject = build(current)
          reopened = true
        }
        const amounts = { turns: next(2), toolCalls: next(12), walltimeSeconds: next(18) }
        if (amounts.turns + amounts.toolCalls + amounts.walltimeSeconds === 0) amounts.turns = 1
        last = subject.chargeGrant(id, pair, `s${seed}-${step}`, amounts)
        if (last.ok) for (const axis of AXES) accepted[axis] += amounts[axis]
        const used = stateOf(current, id).used
        expect(used).toEqual(accepted)
        for (const axis of AXES) expect(used[axis]).toBeLessThanOrEqual(limits[axis])
        if (!last.ok) break
      }
      expect(reopened).toBe(true)
      expect(last).toMatchObject({ ok: false, reason: 'exhausted' })
      expect(stateOf(current, id).status).toBe('exhausted')
    }
  )
})

describe('run grant budget: replay, restart and the clock', () => {
  it('the same chargeId twice charges once, also after reopen; an id older than the history is charged again', () => {
    const { authority, store, open, build, pair, grant } = setup()
    const id = grant(pair, {
      subject: { kind: 'trigger', deliveryId: 'replay' },
      limits: { turns: 100, toolCalls: 1000, walltimeSeconds: 86_400 }
    })
    expect(authority.chargeGrant(id, pair, 'c-1', { toolCalls: 2 })).toMatchObject({
      ok: true,
      replay: false,
      used: { toolCalls: 2 }
    })
    const before = footprint(store)
    expect(authority.chargeGrant(id, pair, 'c-1', { toolCalls: 2 })).toEqual({
      ok: true,
      replay: true,
      used: { turns: 0, toolCalls: 2, walltimeSeconds: 0 },
      remaining: { turns: 100, toolCalls: 998, walltimeSeconds: 86_400 }
    })
    expect(authority.chargeGrant(id, pair, 'c-1', { turns: 50 })).toMatchObject({
      ok: true,
      replay: true
    })
    expect(footprint(store)).toEqual(before)
    store.close()
    const reopenedStore = open()
    const reopened = build(reopenedStore)
    expect(reopened.chargeGrant(id, pair, 'c-1', { toolCalls: 2 })).toMatchObject({
      ok: true,
      replay: true,
      used: { toolCalls: 2 }
    })
    for (let i = 2; i <= RUN_GRANT_CHARGE_HISTORY + 1; i += 1)
      reopened.chargeGrant(id, pair, `c-${i}`, { toolCalls: 1 })
    expect(stateOf(reopenedStore, id).charges).toHaveLength(RUN_GRANT_CHARGE_HISTORY)
    expect(stateOf(reopenedStore, id).charges).not.toContain('c-1')
    const used = stateOf(reopenedStore, id).used.toolCalls
    expect(reopened.chargeGrant(id, pair, 'c-1', { toolCalls: 2 })).toMatchObject({
      ok: true,
      replay: false,
      used: { toolCalls: used + 2 }
    })
  })

  it('a replayed chargeId never answers ok on a paused grant', () => {
    const { authority, store, pair, id } = setup()
    authority.chargeGrant(id, pair, 'c-1', { turns: 1 })
    authority.revokeGrant(id, 'paused')
    const before = footprint(store)
    expect(authority.chargeGrant(id, pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'revoked',
      revokeReason: 'paused'
    })
    expect(footprint(store)).toEqual(before)
    expect(stateOf(store, id).used.turns).toBe(1)
  })

  it('used, exhausted and expired survive a reopen', () => {
    const { authority, store, open, build, clock, pair, grant, id } = setup()
    const short = grant(pair, {
      subject: { kind: 'trigger', deliveryId: 'short' },
      expiresAt: T0 + 100
    })
    authority.chargeGrant(id, pair, 'c-1', { turns: 2, toolCalls: 3 })
    authority.chargeGrant(id, pair, 'c-2', { turns: 4 })
    clock.now = T0 + 100
    expect(authority.chargeGrant(short, pair, 'c-3', { turns: 1 })).toEqual({
      ok: false,
      reason: 'expired'
    })
    store.close()
    const reopenedStore = open()
    const reopened = build(reopenedStore)
    expect(reopened.readGrant(id)).toMatchObject({
      status: 'exhausted',
      reason: 'turns',
      used: { turns: 2, toolCalls: 3, walltimeSeconds: 0 }
    })
    expect(reopened.chargeGrant(id, pair, 'c-4', { toolCalls: 1 })).toEqual({
      ok: false,
      reason: 'exhausted',
      axis: 'turns'
    })
    expect(stateOf(reopenedStore, short)).toMatchObject({ status: 'expired', endedAt: T0 + 100 })
  })

  it('after a charge observed expiry, a clock set back keeps it expired for charge, read and list', () => {
    const { authority, store, clock, pair, id } = setup()
    clock.now = T0 + DAY
    expect(authority.chargeGrant(id, pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'expired'
    })
    expect(stateOf(store, id)).toMatchObject({ status: 'expired', used: { turns: 0 } })
    clock.now = T0 + 10
    const before = footprint(store)
    expect(authority.chargeGrant(id, pair, 'c-2', { turns: 1 })).toEqual({
      ok: false,
      reason: 'expired'
    })
    expect(authority.readGrant(id)).toMatchObject({
      status: 'expired',
      usable: false,
      endedAt: T0 + DAY
    })
    expect(authority.listGrants(pair.threadId, 1)).toMatchObject({
      ok: true,
      grants: [{ grantId: id, status: 'expired', usable: false }]
    })
    expect(footprint(store)).toEqual(before)
  })

  it('a clock before issuedAt answers clock and changes nothing', () => {
    const { authority, store, clock, pair, id } = setup()
    clock.now = T0 - 1
    const before = footprint(store)
    expect(authority.chargeGrant(id, pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'clock'
    })
    expect(footprint(store)).toEqual(before)
    expect(stateOf(store, id)).toMatchObject({ status: 'active', used: { turns: 0 }, charges: [] })
  })

  it('binding: the pair of another thread or of the previous generation answers binding with no write', () => {
    const { authority, store, grant, pair, id } = setup()
    const other = authority.issueThread(target('thread-2'))
    const otherGrant = grant(other)
    const before = footprint(store)
    expect(authority.chargeGrant(id, other, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'binding'
    })
    expect(authority.chargeGrant(otherGrant, pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'binding'
    })
    expect(authority.chargeGrant(id, { ...pair, generation: 2 }, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'binding'
    })
    expect(footprint(store)).toEqual(before)
    authority.revokeThread(target())
    const next = authority.issueThread(target())
    const fresh = grant(next)
    const reissued = footprint(store)
    expect(authority.chargeGrant(fresh, pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'binding'
    })
    expect(authority.chargeGrant(id, next, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'binding'
    })
    expect(authority.chargeGrant(id, pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'revoked',
      revokeReason: 'thread-revoked'
    })
    expect(footprint(store)).toEqual(reissued)
    expect(authority.chargeGrant(fresh, next, 'c-1', { turns: 1 })).toMatchObject({ ok: true })
  })

  it('a stored-active grant of a revoked thread (a partial cascade) answers thread-revoked with no write', () => {
    const { authority, store, pair, id } = setup()
    const commit = store.mutateResourcesBatch.bind(store)
    vi.spyOn(store, 'mutateResourcesBatch').mockImplementationOnce((commands) =>
      commit(commands.filter((c) => c.kind !== STATE))
    )
    authority.revokeThread(target())
    const before = footprint(store)
    expect(authority.chargeGrant(id, pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'thread-revoked'
    })
    expect(footprint(store)).toEqual(before)
    expect(stateOf(store, id)).toMatchObject({ status: 'active', used: { turns: 0 } })
  })
})

describe('run grant budget: races on two connections', () => {
  function race(inner: (B: ThreadAuthorityStore, id: string, pair: ThreadPair) => void) {
    const { open, build, clock } = setup()
    const a = open(),
      b = open()
    const A = build(a),
      B = build(b)
    const pair = A.issueThread(target('race'))
    const result = A.issueGrant({
      threadId: pair.threadId,
      generation: pair.generation,
      subject: { kind: 'trigger', deliveryId: 'race' },
      limits: { turns: 100, toolCalls: 100, walltimeSeconds: 100 },
      expiresAt: clock.now + DAY,
      approval: { approvedAt: clock.now, proofId: 'proof-1' }
    })
    if (!result.ok) throw new Error('grant refused')
    const id = result.grant.grantId
    const commit = a.mutateResourcesBatch.bind(a)
    const spy = vi.spyOn(a, 'mutateResourcesBatch').mockImplementationOnce((commands) => {
      inner(B, id, pair)
      return commit(commands)
    })
    expect(() => A.chargeGrant(id, pair, 'a-1', { toolCalls: 60 })).toThrow(
      ResourceRevisionConflictError
    )
    expect(spy).toHaveBeenCalledTimes(1)
    return { A, a, id, pair }
  }

  it('B charges 60 inside the charge of 60 by A with limit 100: A throws the conflict and used is 60', () => {
    const { A, a, id, pair } = race((B, id, pair) => {
      expect(B.chargeGrant(id, pair, 'b-1', { toolCalls: 60 })).toMatchObject({ ok: true })
    })
    expect(stateOf(a, id)).toMatchObject({
      status: 'active',
      used: { toolCalls: 60 },
      charges: ['b-1']
    })
    expect(A.chargeGrant(id, pair, 'a-1', { toolCalls: 60 })).toEqual({
      ok: false,
      reason: 'exhausted',
      axis: 'toolCalls'
    })
    expect(stateOf(a, id).used.toolCalls).toBe(60)
  })

  it('B pauses the grant inside the charge of A: A throws the conflict, nothing is used', () => {
    const { A, a, id, pair } = race((B, id) => {
      expect(B.revokeGrant(id, 'paused')).toMatchObject({ ok: true, changed: true })
    })
    expect(stateOf(a, id)).toMatchObject({
      status: 'revoked',
      reason: 'paused',
      used: { toolCalls: 0 }
    })
    expect(A.chargeGrant(id, pair, 'a-1', { toolCalls: 60 })).toMatchObject({
      ok: false,
      reason: 'revoked'
    })
  })

  it('B revokes the thread inside the charge of A: A throws the conflict, nothing is used', () => {
    const { A, a, id, pair } = race((B) => {
      expect(B.revokeThread(target('race'))).toEqual({ status: 'revoked' })
    })
    expect(stateOf(a, id)).toMatchObject({
      status: 'revoked',
      reason: 'thread-revoked',
      used: { toolCalls: 0 }
    })
    expect(A.chargeGrant(id, pair, 'a-1', { toolCalls: 60 })).toEqual({
      ok: false,
      reason: 'revoked',
      revokeReason: 'thread-revoked'
    })
  })
})

describe('run grant budget: input and size', () => {
  it.each([
    ['a negative amount', { turns: -1 }],
    ['a fractional amount', { toolCalls: 0.5 }],
    ['NaN', { walltimeSeconds: Number.NaN }],
    ['Infinity', { turns: Infinity }],
    ['all zero', { turns: 0, toolCalls: 0, walltimeSeconds: 0 }],
    ['no key', {}],
    ['an unknown key', { turns: 1, tokens: 1 }],
    ['above MAX_SAFE_INTEGER', { turns: Number.MAX_SAFE_INTEGER + 1 }],
    ['a string amount', { turns: '1' }],
    ['an undefined amount', { turns: undefined }],
    ['an array', [1]],
    ['null', null]
  ])('rejects %s before any read and writes nothing', (_name, amounts) => {
    const { authority, store, pair, id } = setup()
    const before = footprint(store)
    const reads = vi.spyOn(store, 'getResource')
    expect(() =>
      authority.chargeGrant(id, pair, 'c-1', amounts as Partial<RunGrantAmounts>)
    ).toThrow()
    expect(reads).not.toHaveBeenCalled()
    expect(footprint(store)).toEqual(before)
  })

  it('rejects a bad grant id, binding or charge id before any read', () => {
    const { authority, store, pair, id } = setup()
    const reads = vi.spyOn(store, 'getResource')
    for (const call of [
      () => authority.chargeGrant('', pair, 'c-1', { turns: 1 }),
      () => authority.chargeGrant(id, { ...pair, generation: 0 }, 'c-1', { turns: 1 }),
      () => authority.chargeGrant(id, { ...pair, extra: 1 } as ThreadPair, 'c-1', { turns: 1 }),
      () => authority.chargeGrant(id, pair, 'c 1', { turns: 1 }),
      () => authority.chargeGrant(id, pair, 'c'.repeat(65), { turns: 1 })
    ])
      expect(call).toThrow(TypeError)
    expect(reads).not.toHaveBeenCalled()
    expect(authority.chargeGrant('id-404', pair, 'c-1', { turns: 1 })).toEqual({
      ok: false,
      reason: 'unknown'
    })
  })

  it('after 1100 accepted charges the stored grant state stays under 2 KB', () => {
    const { authority, store, pair, grant } = setup()
    const id = grant(pair, {
      subject: { kind: 'trigger', deliveryId: 'size' },
      limits: { turns: 100, toolCalls: 1000, walltimeSeconds: 86_400 }
    })
    for (let i = 0; i < 1100; i += 1) {
      const result = authority.chargeGrant(
        id,
        pair,
        `charge-${String(i).padStart(4, '0')}-${'x'.repeat(52)}`,
        {
          walltimeSeconds: 1
        }
      )
      expect(result.ok).toBe(true)
    }
    const state = stateOf(store, id)
    expect(state.used.walltimeSeconds).toBe(1100)
    expect(state.charges).toHaveLength(RUN_GRANT_CHARGE_HISTORY)
    expect(state.charges.every((charge) => charge.length === 64)).toBe(true)
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
    expect(bytes).toBeLessThan(2048)
  }, 120_000)
})
