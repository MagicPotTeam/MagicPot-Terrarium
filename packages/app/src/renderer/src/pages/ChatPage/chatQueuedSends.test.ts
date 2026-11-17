import { describe, expect, it } from 'vitest'
import {
  collapsedQueuedSendIds,
  isQueuedSendLeaseCurrent,
  isUserQueuedSend,
  leaseQueuedSend,
  nextDrainableSend,
  pauseQueuedSend,
  queuedSendBlockingNewer,
  releaseStopHolds,
  settleQueueOnStop,
  type QueuedSendState
} from './chatQueuedSends'

const composer = (id: number, extra: Partial<QueuedSendState> = {}): QueuedSendState => ({
  id,
  fromComposer: true,
  overrides: {},
  ...extra
})
const edit = (id: number): QueuedSendState => ({ id, overrides: {} })
const channel = (id: number): QueuedSendState => ({
  id,
  queueKey: `team-message:${id}`,
  overrides: { onTeamRequestStarted: () => undefined }
})
const task = (id: number): QueuedSendState => ({
  id,
  overrides: { onTaskCompleted: () => undefined }
})
const autoSend = (id: number): QueuedSendState => ({
  id,
  queueKey: `request-${id}`,
  overrides: { resolveAttachments: async () => [] }
})

describe('queued send rules', () => {
  it('treats composer items, edits and plain sends as user items and team work as internal', () => {
    expect(isUserQueuedSend(composer(1))).toBe(true)
    expect(isUserQueuedSend(edit(2))).toBe(true)
    expect(
      isUserQueuedSend({ id: 3, queueKey: 'lead-summary', overrides: { composerSubmission: true } })
    ).toBe(true)
    expect(isUserQueuedSend(channel(4))).toBe(false)
    expect(isUserQueuedSend(task(5))).toBe(false)
    expect(isUserQueuedSend(autoSend(6))).toBe(false)
    expect(isUserQueuedSend({ id: 7 })).toBe(false)
  })

  it('manual Stop pauses the first user item, holds the others and drops team work', () => {
    const queue = [
      channel(1),
      composer(2, { inFlight: true, leaseId: 9 }),
      edit(3),
      autoSend(4),
      composer(5)
    ]
    const { kept, dropped } = settleQueueOnStop(queue, 'manual', 7)
    expect(dropped.map((item) => item.id)).toEqual([1, 4])
    expect(kept).toEqual([
      {
        id: 2,
        fromComposer: true,
        overrides: {},
        paused: true,
        inFlight: false,
        blocksFollowing: false
      },
      { id: 3, overrides: {}, inFlight: false, heldByStop: 7 },
      { id: 5, fromComposer: true, overrides: {}, inFlight: false, heldByStop: 7 }
    ])
    // Nothing a drain could start: the paused head blocks, the held items are skipped.
    expect(nextDrainableSend(kept)).toBeUndefined()
  })

  it('member stop keeps every user item paused and drops team work', () => {
    const queue = [composer(1, { inFlight: true, leaseId: 3 }), channel(2), edit(3), task(4)]
    const { kept, dropped } = settleQueueOnStop(queue, 'member', 1)
    expect(dropped.map((item) => item.id)).toEqual([2, 4])
    expect(
      kept.map((item) => [item.id, item.paused, item.inFlight, item.leaseId, item.heldByStop])
    ).toEqual([
      [1, true, false, undefined, undefined],
      [3, true, false, undefined, undefined]
    ])
  })

  it('explicit termination drops everything', () => {
    const { kept, dropped } = settleQueueOnStop([composer(1), channel(2)], 'terminate', 1)
    expect(kept).toEqual([])
    expect(dropped.map((item) => item.id)).toEqual([1, 2])
  })

  it('a drain skips held items, never sends a paused one and stops at it', () => {
    expect(nextDrainableSend([composer(1, { heldByStop: 1 }), composer(2)])?.id).toBe(2)
    expect(
      nextDrainableSend([
        composer(1, { heldByStop: 1 }),
        composer(2, { paused: true }),
        composer(3)
      ])
    ).toBeUndefined()
    expect(nextDrainableSend([composer(1, { inFlight: true }), composer(2)])).toBeUndefined()
    expect(nextDrainableSend([composer(1, { heldByStop: 1 })])).toBeUndefined()
    expect(nextDrainableSend(undefined)).toBeUndefined()
  })

  it('a stale lease never becomes current again, even when the same item is leased again', () => {
    let queue = leaseQueuedSend([composer(1), composer(2)], 1, 10)
    expect(isQueuedSendLeaseCurrent(queue, 1, 10)).toBe(true)
    // Stop clears the token; resuming the same item later issues a new one.
    queue = settleQueueOnStop(queue, 'manual', 1).kept
    expect(isQueuedSendLeaseCurrent(queue, 1, 10)).toBe(false)
    queue = queue.map((item) => (item.id === 1 ? { ...item, paused: false } : item))
    queue = leaseQueuedSend(queue, 1, 11)
    expect(isQueuedSendLeaseCurrent(queue, 1, 11)).toBe(true)
    expect(isQueuedSendLeaseCurrent(queue, 1, 10)).toBe(false)
    expect(isQueuedSendLeaseCurrent([pauseQueuedSend(queue[0])], 1, 11)).toBe(false)
  })

  it('releasing stop holds keeps order and returns the same array when nothing is held', () => {
    const plain = [composer(1), composer(2)]
    expect(releaseStopHolds(plain)).toBe(plain)
    const held = settleQueueOnStop([composer(1), composer(2), composer(3)], 'manual', 4).kept
    expect(
      releaseStopHolds(held).map((item) => [item.id, item.paused ?? false, item.heldByStop])
    ).toEqual([
      [1, true, undefined],
      [2, false, undefined],
      [3, false, undefined]
    ])
  })
})

describe('queue strip views', () => {
  it('names the paused head that newer items wait behind, and only then', () => {
    expect(queuedSendBlockingNewer([composer(1, { paused: true }), composer(2)])?.id).toBe(1)
    // Alone, it blocks nothing.
    expect(queuedSendBlockingNewer([composer(1, { paused: true })])).toBeUndefined()
    // Held items (a reload, a Stop) are passed over: the first item a drain looks at counts.
    expect(queuedSendBlockingNewer([composer(1, { paused: true, heldByStop: 3 }), composer(2)])).toBeUndefined()
    expect(
      queuedSendBlockingNewer([composer(1, { paused: true, heldByStop: 3 }), composer(2, { paused: true }), composer(3)])?.id
    ).toBe(2)
    // A restored head whose hold was released by the person's next send blocks the newer one.
    const restored = composer(1, { paused: true, heldByStop: 4 })
    const [released, newer] = releaseStopHolds([restored, composer(2)])
    expect(queuedSendBlockingNewer([released, newer])?.id).toBe(1)
    // Being prepared or simply waiting is not blocking.
    expect(queuedSendBlockingNewer([composer(1, { inFlight: true }), composer(2)])).toBeUndefined()
    expect(queuedSendBlockingNewer([composer(1), composer(2)])).toBeUndefined()
    expect(queuedSendBlockingNewer(undefined)).toBeUndefined()
  })

  it('shows the last three while collapsed, plus the blocking head when it is older', () => {
    const plain = [1, 2, 3, 4, 5].map((id) => composer(id))
    expect([...collapsedQueuedSendIds(plain)]).toEqual([3, 4, 5])
    const blocked = [composer(1, { paused: true }), ...[2, 3, 4, 5].map((id) => composer(id))]
    expect([...collapsedQueuedSendIds(blocked)].sort()).toEqual([1, 3, 4, 5])
    expect([...collapsedQueuedSendIds([composer(1), composer(2)])]).toEqual([1, 2])
  })
})
