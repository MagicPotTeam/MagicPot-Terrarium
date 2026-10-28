import { describe, expect, it } from 'vitest'
import {
  buildCodexModelProfileId,
  buildCodexModelCatalog,
  getSuggestedModelCatalog,
  normalizeCodexModelName,
  parseCodexModelProfileId
} from './modelCatalog'

describe('modelCatalog', () => {
  it('preserves unknown non-empty Codex model names', () => {
    expect(normalizeCodexModelName(' custom-codex-preview ')).toBe('custom-codex-preview')
  })

  it('keeps the public catalog free of Codex runtime fallback values', () => {
    expect(buildCodexModelCatalog()).toEqual([])
    expect(normalizeCodexModelName('')).toBe('')
    expect(buildCodexModelProfileId('codex-profile', '')).toBe('codex-profile')
    expect(parseCodexModelProfileId('codex-profile::codex-model::%20')).toBeNull()
  })

  it('encodes Codex model choices as virtual profile ids', () => {
    const profileId = buildCodexModelProfileId('codex-profile', 'gpt-5.4')

    expect(profileId).toBe('codex-profile::codex-model::gpt-5.4')
    expect(parseCodexModelProfileId(profileId)).toEqual({
      profileId: 'codex-profile',
      modelName: 'gpt-5.4'
    })
    expect(parseCodexModelProfileId('codex-profile::other::gpt-5.4')).toBeNull()
  })

  it('builds an advisory Codex catalog from current, discovered, and observed models', () => {
    const catalog = buildCodexModelCatalog({
      currentModelName: ' custom-codex-preview ',
      discoveredModelNames: ['gpt-5.4', 'gpt-4o-mini', 'gpt-4o', ''],
      observedModelNames: ['custom-codex-observed', 'gpt-5.3-codex', 'gpt-4o-mini']
    })

    expect(catalog.map((option) => option.value)).toEqual([
      'custom-codex-preview',
      'gpt-5.4',
      'gpt-4o-mini',
      'gpt-4o',
      'custom-codex-observed',
      'gpt-5.3-codex'
    ])
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

  it('keeps Codex discovery empty in the public checkout', () => {
    expect(
      getSuggestedModelCatalog({
        authMode: 'codex_oauth',
        deployment: 'cloud',
        modelUse: 'chat',
        provider: 'openai'
      })
    ).toEqual([])
  })
})
