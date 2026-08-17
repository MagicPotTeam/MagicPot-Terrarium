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
  it('budgets only latest-user-turn images while preserving historical text and indices', () => {
    const historyMessages: ChatMessage[] = [
      {
        role: 'user',
        content: 'historical text stays',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///historical.png',
            sourceWidth: 16_384,
            sourceHeight: 16_384
          }
        ]
      },
      { role: 'assistant', content: 'historical answer stays' },
      ...createTurnMessages(4)
    ]
    const input = {
      historyMessages,
      requestMessage: { role: 'user' as const, content: 'current request' },
      profile: { context_budget_tokens: 50_000 },
      enabled: true
    }

    const latestPlan = buildChatContextCompressionPlan({
      ...input,
      imageHistoryPolicy: 'latest-user-turn'
    })
    const allPlan = buildChatContextCompressionPlan({ ...input, imageHistoryPolicy: 'all' })

    expect(latestPlan.shouldCompress).toBe(false)
    expect(latestPlan.requestHistoryMessages).toHaveLength(historyMessages.length)
    expect(latestPlan.requestHistoryMessages[0]?.content).toBe('historical text stays')
    expect(latestPlan.requestHistoryMessages[1]?.content).toBe('historical answer stays')
    expect(allPlan.shouldCompress).toBe(true)
    expect(allPlan.compressionSummary?.summary).toContain('historical text stays')
    expect(allPlan.requestReplayImageMessages).toEqual([
      {
        role: 'user',
        content: 'Historical image replay from compacted user message 1.',
        attachments: [
          expect.objectContaining({
            type: 'image',
            url: 'local-media:///historical.png'
          })
        ]
      }
    ])
    expect(latestPlan.requestReplayImageMessages).toEqual([])
  })

  it('replays images preserved by an earlier successful compaction', () => {
    const cachedSummary: ChatContextCompressionSummary = {
      summary: 'older compacted context',
      coveredMessageCount: 2,
      sourceHash: 'older-hash',
      estimatedSourceTokens: 100,
      estimatedSummaryTokens: 10,
      updatedAt: 100,
      replayImageMessages: [
        {
          role: 'user',
          content: 'Historical image replay from compacted user message 1.',
          attachments: [{ type: 'image', url: 'local-media:///already-compacted.png' }]
        }
      ]
    }

    const withoutReplay = buildChatContextCompressionPlan({
      historyMessages: createTurnMessages(2),
      requestMessage: { role: 'user', content: 'continue' },
      enabled: false,
      cachedSummary: { ...cachedSummary, replayImageMessages: undefined },
      imageHistoryPolicy: 'all'
    })
    const plan = buildChatContextCompressionPlan({
      historyMessages: createTurnMessages(2),
      requestMessage: { role: 'user', content: 'continue' },
      enabled: false,
      cachedSummary,
      imageHistoryPolicy: 'all'
    })

    expect(plan.shouldCompress).toBe(false)
    expect(plan.estimatedInputTokens).toBeGreaterThan(withoutReplay.estimatedInputTokens)
    expect(plan.requestReplayImageMessages[0]?.attachments?.[0]?.url).toBe(
      'local-media:///already-compacted.png'
    )
  })
})
