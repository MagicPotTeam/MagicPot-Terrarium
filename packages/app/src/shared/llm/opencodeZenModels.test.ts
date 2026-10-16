import { describe, expect, it } from 'vitest'

import { resolveOpencodeZenAlias, resolveOpencodeZenModelApi } from './opencodeZenModels'

describe('OpenCode Zen model resolvers', () => {
  it.each([
    ['opencode/gpt-5.5', 'gpt-5.5'],
    ['qwen3.6-plus', 'qwen3.6-plus'],
    ['opencode/codex', 'gpt-5.3-codex'],
    ['opencode/custom-model', 'custom-model']
  ] as const)('normalizes %s to %s', (modelId, expected) => {
    expect(resolveOpencodeZenAlias(modelId)).toBe(expected)
  })

  it.each([
    ['opencode/gpt-5.5', 'openai-responses'],
    ['qwen3.6-plus', 'anthropic-messages'],
    ['opencode/codex', 'openai-responses'],
    ['qwen2.5', 'openai-completions'],
    ['opencode/minimax-m2.7', 'openai-completions'],
    ['minimax-m2.5', 'openai-completions'],
    ['custom-model', 'openai-completions'],
    ['opencode/custom-model', 'openai-completions']
  ] as const)('routes %s as %s', (modelId, expected) => {
    expect(resolveOpencodeZenModelApi(modelId)).toBe(expected)
  })
})
