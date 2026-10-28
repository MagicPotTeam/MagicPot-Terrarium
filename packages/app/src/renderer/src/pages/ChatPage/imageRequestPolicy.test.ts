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

  it('replays all historical user images for GPT Image/image-generation requests', () => {
    expect(
      resolveChatPageRequestExecutionImagePolicy({
        supportsSessionContinuation: false,
        hasUsableSessionContinuation: false,
        shouldResetContinuation: false,
        isImageGenerationRequest: true
      })
    ).toEqual({
      preliminaryImageHistoryPolicy: 'all',
      imageHistoryPolicy: 'all'
    })
  })

  it('keeps all image history for image generation when continuation is reset', () => {
    expect(
      resolveChatPageRequestExecutionImagePolicy({
        supportsSessionContinuation: true,
        hasUsableSessionContinuation: true,
        shouldResetContinuation: true,
        isImageGenerationRequest: true
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
