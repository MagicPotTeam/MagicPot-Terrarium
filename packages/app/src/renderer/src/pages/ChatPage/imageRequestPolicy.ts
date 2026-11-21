import type { LLMImageHistoryPolicy } from '@shared/llm'

export type ChatPageRequestExecutionImagePolicy = {
  preliminaryImageHistoryPolicy: LLMImageHistoryPolicy
  imageHistoryPolicy: LLMImageHistoryPolicy
}

export const resolveChatPageRequestExecutionImagePolicy = (options: {
  supportsSessionContinuation: boolean
  hasUsableSessionContinuation: boolean
  /** True only when this request path actually sends continuation state to the provider. */
  hasRealSessionContinuationTransport?: boolean
  shouldResetContinuation: boolean
  isImageGenerationRequest?: boolean
  /** Ordinary conversation: replay text, not the original image binaries. */
  currentTurnImagesOnly?: boolean
}): ChatPageRequestExecutionImagePolicy => {
  const canUseIncrementalImageHistory =
    options.hasRealSessionContinuationTransport !== false &&
    options.supportsSessionContinuation &&
    options.hasUsableSessionContinuation &&
    !options.shouldResetContinuation
  const imageHistoryPolicy: LLMImageHistoryPolicy = options.currentTurnImagesOnly
    ? 'latest-user-turn'
    : options.isImageGenerationRequest
      ? 'all'
      : canUseIncrementalImageHistory
        ? 'latest-user-turn'
        : 'all'

  return {
    preliminaryImageHistoryPolicy: imageHistoryPolicy,
    imageHistoryPolicy
  }
}
