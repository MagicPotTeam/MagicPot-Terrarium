import type { LLMImageHistoryPolicy } from '@shared/llm'

export type ChatPageRequestExecutionImagePolicy = {
  preliminaryImageHistoryPolicy: LLMImageHistoryPolicy
  imageHistoryPolicy: LLMImageHistoryPolicy
}

export const resolveChatPageRequestExecutionImagePolicy = (options: {
  supportsSessionContinuation: boolean
  hasUsableSessionContinuation: boolean
  shouldResetContinuation: boolean
}): ChatPageRequestExecutionImagePolicy => {
  const canUseIncrementalImageHistory =
    options.supportsSessionContinuation &&
    options.hasUsableSessionContinuation &&
    !options.shouldResetContinuation
  const imageHistoryPolicy: LLMImageHistoryPolicy = canUseIncrementalImageHistory
    ? 'latest-user-turn'
    : 'all'

  return {
    preliminaryImageHistoryPolicy: imageHistoryPolicy,
    imageHistoryPolicy
  }
}
