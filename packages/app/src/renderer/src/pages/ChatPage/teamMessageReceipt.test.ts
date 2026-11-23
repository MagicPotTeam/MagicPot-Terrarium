import { describe, expect, it } from 'vitest'
import { markTeamMessageReceiptsUnknown, type TeamMessageReceipt } from './teamMessageReceipt'

describe('durable team message receipts', () => {
  it('turns queued records into unknown after a restart without scheduling retry', () => {
    const queued: TeamMessageReceipt = {
      version: 1,
      id: 'old-broadcast',
      recipientId: 'member-a',
      teamKey: 'scope\u0000thread\u0000lead\u00000',
      text: 'hello',
      state: 'queued',
      createdAt: 100,
      updatedAt: 100
    }
    const acknowledged = { ...queued, recipientId: 'member-b', state: 'acknowledged' } as const
    const otherTeam = { ...queued, teamKey: 'other-team' }
    const recovered = markTeamMessageReceiptsUnknown(
      [queued, acknowledged, otherTeam, { version: 2 } as never],
      queued.teamKey,
      300
    )
    expect(recovered).toEqual([
      { ...queued, state: 'unknown', updatedAt: 300 },
      acknowledged,
      otherTeam
    ])
    expect(markTeamMessageReceiptsUnknown(recovered, queued.teamKey, 400)).toEqual(recovered)
  })
})
