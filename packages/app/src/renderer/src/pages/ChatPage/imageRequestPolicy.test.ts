import { describe, expect, it } from 'vitest'
import { resolveChatPageRequestExecutionImagePolicy } from './imageRequestPolicy'

describe('resolveChatPageRequestExecutionImagePolicy', () => {
  it('keeps normal dispatches on latest-user-turn history', () => {
    expect(resolveChatPageRequestExecutionImagePolicy({ shouldResetContinuation: false })).toEqual({
      preliminaryImageHistoryPolicy: 'latest-user-turn',
      imageHistoryPolicy: 'latest-user-turn'
    })
  })

  it('uses all image history for the primary dispatch that resets continuation', () => {
    expect(resolveChatPageRequestExecutionImagePolicy({ shouldResetContinuation: true })).toEqual({
      preliminaryImageHistoryPolicy: 'latest-user-turn',
      imageHistoryPolicy: 'all'
    })
  })

  it('does not repeat all mode for batched or tool subcalls', () => {
    expect(
      resolveChatPageRequestExecutionImagePolicy({
        shouldResetContinuation: true,
        isPrimaryDispatch: false
      }).imageHistoryPolicy
    ).toBe('latest-user-turn')
  })
})
