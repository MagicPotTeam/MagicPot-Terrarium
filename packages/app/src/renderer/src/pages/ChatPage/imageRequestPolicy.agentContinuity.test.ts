import { describe, expect, it } from 'vitest'
import { resolveChatPageRequestExecutionImagePolicy } from './imageRequestPolicy'

describe('Agent external continuation image-history policy', () => {
  it('rebuilds all thread images when the external-agent adapter has no real continuation transport', () => {
    // The selected profile may advertise continuation capability, but the external-agent
    // adapter does not put sessionUrl on its wire payload. This fixture represents that
    // mismatch: the UI must not choose latest-user-turn for the request projection.
    const policy = resolveChatPageRequestExecutionImagePolicy({
      supportsSessionContinuation: true,
      hasUsableSessionContinuation: true,
      hasRealSessionContinuationTransport: false,
      shouldResetContinuation: false,
      isImageGenerationRequest: false
    })

    expect(policy).toMatchObject({
      preliminaryImageHistoryPolicy: 'all',
      imageHistoryPolicy: 'all'
    })
  })

  it('keeps incremental history only when a real continuation is usable', () => {
    expect(
      resolveChatPageRequestExecutionImagePolicy({
        supportsSessionContinuation: true,
        hasUsableSessionContinuation: true,
        hasRealSessionContinuationTransport: true,
        shouldResetContinuation: false,
        isImageGenerationRequest: false
      }).imageHistoryPolicy
    ).toBe('latest-user-turn')

    expect(
      resolveChatPageRequestExecutionImagePolicy({
        supportsSessionContinuation: true,
        hasUsableSessionContinuation: false,
        hasRealSessionContinuationTransport: true,
        shouldResetContinuation: false,
        isImageGenerationRequest: false
      }).imageHistoryPolicy
    ).toBe('all')
  })
})
