import type { LLMImageHistoryPolicy } from '@shared/llm'

export type ChatPageRequestExecutionImagePolicy = {
  preliminaryImageHistoryPolicy: LLMImageHistoryPolicy
  imageHistoryPolicy: LLMImageHistoryPolicy
}

export const resolveChatPageRequestExecutionImagePolicy = (options: {
  shouldResetContinuation: boolean
  isPrimaryDispatch?: boolean
}): ChatPageRequestExecutionImagePolicy => ({
  preliminaryImageHistoryPolicy: 'latest-user-turn',
  imageHistoryPolicy:
    options.shouldResetContinuation && options.isPrimaryDispatch !== false
      ? 'all'
      : 'latest-user-turn'
})
