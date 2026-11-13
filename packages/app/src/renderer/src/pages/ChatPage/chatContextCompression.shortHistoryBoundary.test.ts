import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { resolveChatContextCompactWindow } from './chatContextCompression'

describe('ordinary chat compact short-history boundary', () => {
  it('preserves short low-turn history automatically while allowing explicit manual compaction', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'original request' },
      ...Array.from({ length: 6 }, (_, index) => ({
        role: 'assistant' as const,
        content: `result ${index + 1}`
      }))
    ]
    const original = structuredClone(messages)

    const automatic = resolveChatContextCompactWindow(messages)
    expect(automatic.reason).toBe('too_short')
    expect(automatic.compactCount).toBe(0)
    expect(automatic.keepRecentCount).toBe(7)
    expect(automatic.compactMessages).toEqual([])
    expect(automatic.liveMessages).toEqual(original)

    const manual = resolveChatContextCompactWindow(messages, { minCompactableMessages: 2 })
    expect(manual.reason).toBe('ready')
    expect(manual.compactCount).toBe(4)
    expect(manual.keepRecentCount).toBe(3)
    expect(manual.compactMessages).toEqual(original.slice(0, 4))
    expect(manual.liveMessages).toEqual(original.slice(4))
    expect([...manual.compactMessages, ...manual.liveMessages]).toEqual(original)
    expect(messages).toEqual(original)
  })
})
