import { describe, expect, it } from 'vitest'
import { getSuggestedModelCatalog } from './modelCatalog'

describe('modelCatalog', () => {
  it('returns OpenAI model suggestions for cloud OpenAI profiles', () => {
    const catalog = getSuggestedModelCatalog({
      deployment: 'cloud',
      modelUse: 'chat',
      provider: 'openai'
    })

    expect(catalog.map((option) => option.value)).toContain('gpt-5.5')
    expect(catalog.map((option) => option.value)).toContain('gpt-4o-mini')
  })

  it('returns provider-specific model suggestions', () => {
    expect(
      getSuggestedModelCatalog({
        deployment: 'cloud',
        modelUse: 'chat',
        provider: 'claude'
      }).map((option) => option.value)
    ).toContain('claude-opus-4-6')

    expect(
      getSuggestedModelCatalog({
        deployment: 'cloud',
        modelUse: 'chat',
        provider: 'gemini'
      }).map((option) => option.value)
    ).toContain('gemini-3.1-pro-preview')
  })
})
