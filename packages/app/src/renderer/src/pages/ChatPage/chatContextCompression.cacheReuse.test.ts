import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import {
  buildChatContextCompressionPlan,
  createContextCompressionSourceHash,
  resolveChatContextCompactWindow,
  type ChatContextCompressionSummary
} from './chatContextCompression'

const createTurnMessages = (turnCount: number): ChatMessage[] =>
  Array.from({ length: turnCount }, (_, index) => [
    { role: 'user' as const, content: `request ${index + 1}` },
    { role: 'assistant' as const, content: `answer ${index + 1}` }
  ]).flat()

describe('chatContextCompression cached summary reuse', () => {
  it('does not mutate a caller-owned cached summary while reusing it', () => {
    const historyMessages = createTurnMessages(10)
    const compactWindow = resolveChatContextCompactWindow(historyMessages)
    const replayImageMessages: ChatMessage[] = [
      {
        role: 'user',
        content: 'Historical image replay from an earlier compact round.',
        attachments: [{ type: 'image', url: 'local-media:///cached-replay.png' }]
      }
    ]
    const cachedSummary = Object.freeze({
      summary: 'cached compact summary',
      coveredMessageCount: compactWindow.compactCount,
      sourceHash: createContextCompressionSourceHash(compactWindow.compactMessages),
      estimatedSourceTokens: 120,
      estimatedSummaryTokens: 999,
      updatedAt: 100,
      compactRound: 2,
      replayImageMessages: Object.freeze(replayImageMessages)
    }) as unknown as ChatContextCompressionSummary
    const cachedSnapshot = structuredClone(cachedSummary)

    const plan = buildChatContextCompressionPlan({
      historyMessages,
      requestMessage: { role: 'user', content: 'continue' },
      profile: { context_budget_tokens: 1_000, context_window_tokens: 2_000 },
      enabled: true,
      cachedSummary,
      imageHistoryPolicy: 'all',
      force: true
    })

    expect(cachedSummary).toEqual(cachedSnapshot)
    expect(plan.compressionSummary).not.toBe(cachedSummary)
    expect(plan.compressionSummary?.replayImageMessages).not.toBe(cachedSummary.replayImageMessages)
    expect(plan.requestReplayImageMessages).not.toBe(cachedSummary.replayImageMessages)
    expect(plan.compressionSummary?.summary).toBe(cachedSummary.summary)
    expect(plan.compressionSummary?.estimatedSummaryTokens).toBeGreaterThan(0)
    expect(plan.requestReplayImageMessages).toEqual(replayImageMessages)
  })
})
