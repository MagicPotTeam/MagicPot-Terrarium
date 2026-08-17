import { describe, expect, it } from 'vitest'
import { resolveChatPageRequestExecutionImagePolicy } from './imageRequestPolicy'

describe('resolveChatPageRequestExecutionImagePolicy', () => {
  it('replays all image history when the provider does not support session continuation', () => {
    expect(
      resolveChatPageRequestExecutionImagePolicy({
        supportsSessionContinuation: false,
        hasUsableSessionContinuation: false,
        shouldResetContinuation: false
      })
    ).toEqual({
      preliminaryImageHistoryPolicy: 'all',
      imageHistoryPolicy: 'all'
    })
  })

  it('replays all image history before a supported continuation has been established', () => {
    expect(
      resolveChatPageRequestExecutionImagePolicy({
        supportsSessionContinuation: true,
        hasUsableSessionContinuation: false,
        shouldResetContinuation: false
      }).imageHistoryPolicy
    ).toBe('all')
  })

  it('uses latest-user-turn only with an explicit usable continuation', () => {
    expect(
      resolveChatPageRequestExecutionImagePolicy({
        supportsSessionContinuation: true,
        hasUsableSessionContinuation: true,
        shouldResetContinuation: false
      })
    ).toEqual({
      preliminaryImageHistoryPolicy: 'latest-user-turn',
      imageHistoryPolicy: 'latest-user-turn'
    })
  })

  it('replays all image history whenever continuation is reset', () => {
    expect(
      resolveChatPageRequestExecutionImagePolicy({
        supportsSessionContinuation: true,
        hasUsableSessionContinuation: true,
        shouldResetContinuation: true
      }).imageHistoryPolicy
    ).toBe('all')
  })
})
