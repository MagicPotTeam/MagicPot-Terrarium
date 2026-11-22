import { describe, expect, it } from 'vitest'
import {
  assertApprovalContinuationAllowed,
  isApprovalContinuationRefusal,
  runWithApprovalContinuationCheck
} from './approvalContinuationGate'

describe('approval continuation check', () => {
  it('runs the check of the enclosing tool start after an approval and tags its refusal', async () => {
    const refused = new Error('Team has ended.')
    await expect(
      runWithApprovalContinuationCheck(
        () => {
          throw refused
        },
        async () => {
          await Promise.resolve()
          assertApprovalContinuationAllowed()
        }
      )
    ).rejects.toBe(refused)
    expect(isApprovalContinuationRefusal(refused)).toBe(true)
    expect(isApprovalContinuationRefusal(new Error('Team has ended.'))).toBe(false)
  })
  it('is a no-op outside any tool start', () => {
    expect(() => assertApprovalContinuationAllowed()).not.toThrow()
  })
  it('does not carry a member check into a later start that has none (work started inside the member run)', async () => {
    const outer = () => {
      throw new Error('outer check')
    }
    let later!: Promise<void>
    await runWithApprovalContinuationCheck(outer, async () => {
      // A timer or background start created inside the member's tool run, later running another start without a check.
      later = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() =>
        runWithApprovalContinuationCheck(undefined, async () => assertApprovalContinuationAllowed())
      )
    })
    await expect(later).resolves.toBeUndefined()
  })
})
