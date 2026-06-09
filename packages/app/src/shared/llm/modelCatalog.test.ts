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

  it('returns video model suggestions for Kling and Volcengine video profiles only', () => {
    const klingCatalog = getSuggestedModelCatalog({
      deployment: 'cloud',
      modelUse: 'video',
      provider: 'kling'
    }).map((option) => option.value)
    const seedanceCatalog = getSuggestedModelCatalog({
      deployment: 'cloud',
      modelUse: 'video',
      provider: 'volcengine'
    }).map((option) => option.value)

    expect(klingCatalog).toContain('kling-v3')
    expect(klingCatalog).toContain('kling-v2-5-turbo')
    expect(seedanceCatalog).toContain('doubao-seedance-1-0-pro-250528')
    expect(seedanceCatalog).toContain('doubao-seedance-1-0-pro-fast-251015')

    expect(
      getSuggestedModelCatalog({
        deployment: 'cloud',
        modelUse: 'chat',
        provider: 'kling'
      })
    ).toEqual([])
    expect(
      getSuggestedModelCatalog({
        deployment: 'cloud',
        modelUse: 'chat',
        provider: 'volcengine'
      })
    ).toEqual([])
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
