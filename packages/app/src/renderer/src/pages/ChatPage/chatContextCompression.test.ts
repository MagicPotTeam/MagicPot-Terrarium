import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import {
  buildChatContextCompressionPlan,
  resolveChatContextCompactWindow,
  type ChatContextCompressionSummary
} from './chatContextCompression'

const createTurnMessages = (turnCount: number): ChatMessage[] =>
  Array.from({ length: turnCount }, (_, index) => [
    { role: 'user' as const, content: `request ${index + 1}` },
    { role: 'assistant' as const, content: `answer ${index + 1}` }
  ]).flat()

describe('chatContextCompression', () => {
  it('keeps the latest user-turn live zone after compaction', () => {
    const messages = createTurnMessages(10)

    const window = resolveChatContextCompactWindow(messages)

    expect(window.compactCount).toBe(4)
    expect(window.compactMessages.map((message) => message.content)).toEqual([
      'request 1',
      'answer 1',
      'request 2',
      'answer 2'
    ])
    expect(window.liveMessages[0]?.content).toBe('request 3')
  })

  it('falls back to a half-sized live zone for tool-heavy or low-user-turn history', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'start' },
      ...Array.from({ length: 9 }, (_, index) => ({
        role: 'assistant' as const,
        content: `tool-heavy assistant result ${index + 1}`
      }))
    ]

    const window = resolveChatContextCompactWindow(messages)

    expect(window.compactCount).toBe(5)
    expect(window.liveMessages).toHaveLength(5)
  })

  it('builds stacked structured summaries and preserves prior compact summary', () => {
    const cachedSummary: ChatContextCompressionSummary = {
      summary: '### Current Goal\nContinue previous work.\n### Key Facts\n- old fact',
      coveredMessageCount: 4,
      sourceHash: 'previous-hash',
      estimatedSourceTokens: 120,
      estimatedSummaryTokens: 20,
      updatedAt: 100,
      compactRound: 2,
      manual: true
    }

    const plan = buildChatContextCompressionPlan({
      historyMessages: createTurnMessages(10),
      requestMessage: { role: 'user', content: 'continue' },
      enabled: true,
      cachedSummary,
      force: true
    })

    expect(plan.shouldCompress).toBe(true)
    expect(plan.requestHistoryMessages[0]?.content).toBe('request 3')
    expect(plan.compressionSummary?.compactRound).toBe(3)
    expect(plan.compressionSummary?.summary).toContain(
      '[Previous context summary (compact round 3)]'
    )
    expect(plan.compressionSummary?.summary).toContain('### Current Goal')
    expect(plan.compressionSummary?.summary).toContain('Prior compacted summary to preserve')
    expect(plan.compressionSummary?.summary).toContain('old fact')
  })
})
