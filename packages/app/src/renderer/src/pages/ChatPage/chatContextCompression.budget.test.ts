import { describe, expect, it } from 'vitest'
import { assertChatContextBudget } from './chatContextCompression'

describe('non-converging multimodal context budget', () => {
  it('rejects a still-over-budget plan instead of silently dropping historical images', () => {
    const plan = { contextBudgetTokens: 1000, estimatedCompressedInputTokens: 2000 }
    expect(() => assertChatContextBudget(plan)).toThrow(/Historical images were preserved/)
    expect(plan).toEqual({ contextBudgetTokens: 1000, estimatedCompressedInputTokens: 2000 })
  })
  it('allows exact budget and unknown model budgets', () => {
    expect(() =>
      assertChatContextBudget({ contextBudgetTokens: 1000, estimatedCompressedInputTokens: 1000 })
    ).not.toThrow()
    expect(() =>
      assertChatContextBudget({ contextBudgetTokens: null, estimatedCompressedInputTokens: 2000 })
    ).not.toThrow()
  })
})
