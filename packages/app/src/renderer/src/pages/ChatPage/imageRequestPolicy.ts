import type { LLMImageHistoryPolicy } from '@shared/llm'

export type ChatPageRequestImageHistoryDecision = {
  imageHistoryPolicy: LLMImageHistoryPolicy
  consumeFullHistoryRecovery: boolean
}

export const resolveChatPageRequestImageHistoryPolicy = (options: {
  fullHistoryRecoveryPending: boolean
}): ChatPageRequestImageHistoryDecision => ({
  imageHistoryPolicy: options.fullHistoryRecoveryPending ? 'all' : 'latest-user-turn',
  consumeFullHistoryRecovery: options.fullHistoryRecoveryPending
})
