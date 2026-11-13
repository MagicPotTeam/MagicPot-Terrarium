import { describe, expect, it } from 'vitest'
import {
  createTeamMessageReceipts,
  markTeamMessageReceiptsUnknown,
  mergeTeamMessageReceipts,
  updateTeamMessageReceipt
} from './teamMessageReceipt'

describe('durable team message receipts', () => {
  const input = { id: 'broadcast-1', teamKey: 'scope\\u0000thread\\u0000lead\\u00000', text: 'hello', recipients: ['member-a', 'member-b', 'member-a'], now: 100 }

  it('creates one bounded queued intent per recipient and deduplicates recipients', () => {
    const receipts = createTeamMessageReceipts(input)
    expect(receipts).toHaveLength(2)
    expect(receipts.map(receipt => [receipt.recipientId, receipt.state])).toEqual([
      ['member-a', 'queued'],
      ['member-b', 'queued']
    ])
    expect(receipts.every(receipt => Object.isFrozen(receipt))).toBe(true)
  })

  it('merges persisted and new snapshots by message and recipient', () => {
    const first = createTeamMessageReceipts(input)
    const replacement = createTeamMessageReceipts({ ...input, text: 'edited', recipients: ['member-a'], now: 200 })
    const merged = mergeTeamMessageReceipts(first, replacement)
    expect(merged).toHaveLength(2)
    expect(merged.find(receipt => receipt.recipientId === 'member-a')).toMatchObject({ text: 'edited', updatedAt: 200 })
    expect(merged.find(receipt => receipt.recipientId === 'member-b')).toMatchObject({ text: 'hello', updatedAt: 100 })
  })

  it('turns queued records into unknown after a restart without scheduling retry', () => {
    const receipts = createTeamMessageReceipts(input)
    const recovered = markTeamMessageReceiptsUnknown(receipts, input.teamKey, 300)
    expect(recovered.every(receipt => receipt.state === 'unknown')).toBe(true)
    expect(recovered.every(receipt => receipt.updatedAt === 300)).toBe(true)
    expect(markTeamMessageReceiptsUnknown(recovered, 'other-team', 400)).toEqual(recovered)
  })

  it('updates only an explicit recipient receipt and ignores malformed persisted records', () => {
    const receipts = createTeamMessageReceipts(input)
    const updated = updateTeamMessageReceipt(
      [...receipts, { version: 2 } as never],
      { id: input.id, recipientId: 'member-b', teamKey: input.teamKey, state: 'acknowledged', now: 500 }
    )
    expect(updated).toHaveLength(2)
    expect(updated.find(receipt => receipt.recipientId === 'member-a')?.state).toBe('queued')
    expect(updated.find(receipt => receipt.recipientId === 'member-b')).toMatchObject({ state: 'acknowledged', updatedAt: 500 })
  })

  it('enforces the bounded outbox limit', () => {
    const receipts = Array.from({ length: 3 }, (_, index) => createTeamMessageReceipts({
      ...input,
      id: `broadcast-${index}`,
      recipients: ['member-a'],
      now: index
    })[0])
    expect(mergeTeamMessageReceipts(undefined, receipts, 2).map(receipt => receipt.id)).toEqual(['broadcast-1', 'broadcast-2'])
  })
})

