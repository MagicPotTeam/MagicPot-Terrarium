import { afterEach, describe, expect, it } from 'vitest'

import {
  clearTaggerRuntimeCache,
  listTaggerProviders,
  resolveTaggerProviderDescriptor,
  resolveTaggerProviderFamily,
  resolveTaggerProviderId,
  resolveTaggerRuntimeDescriptor
} from './taggerProviders'

describe('taggerProviders', () => {
  afterEach(() => {
    clearTaggerRuntimeCache()
  })

  it('lists local tagger providers and resolves their descriptors', () => {
    const providers = listTaggerProviders()

    expect(providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(['wdtagger', 'cl_tagger', 'paddle_ocr'])
    )
    expect(
      resolveTaggerProviderDescriptor({
        model_name: 'SmilingWolf WD14',
        tagger_provider: 'wdtagger'
      })
    ).toMatchObject({
      id: 'wdtagger',
      name: 'WDTagger',
      family: 'tagger'
    })
    expect(
      resolveTaggerProviderDescriptor({
        model_name: 'PaddleOCR document runtime',
        tagger_provider: 'paddle_ocr'
      })
    ).toMatchObject({
      id: 'paddle_ocr',
      name: 'Paddle OCR',
      family: 'ocr'
    })
  })

  it('builds and reuses runtime descriptors for provider-backed tagging skills', () => {
    const profile = {
      id: 'tagger-profile',
      model_name: 'cella110n/cl_tagger',
      base_url: 'http://127.0.0.1:7860',
      tagger_provider: 'cl_tagger' as const,
      tagger_runtime_cache_scope: 'profile' as const
    }
    const skillRuntime = {
      skillId: 'builtin-tagging',
      execution: {
        outputMode: 'structured'
      }
    }

    const first = resolveTaggerRuntimeDescriptor(profile, skillRuntime)
    const second = resolveTaggerRuntimeDescriptor(profile, skillRuntime)

    expect(first).toMatchObject({
      providerId: 'cl_tagger',
      providerName: 'CL_tagger',
      family: 'tagger',
      endpoint: 'http://127.0.0.1:7860',
      outputMode: 'structured'
    })
    expect(second).toBe(first)
  })

  it('infers provider ids and extension families without creating a second provider model', () => {
    expect(resolveTaggerProviderId({ model_name: 'SmilingWolf wd14 moat-tagger' })).toBe('wdtagger')
    expect(resolveTaggerProviderId({ model_name: 'cella110n/cl_tagger' })).toBe('cl_tagger')
    expect(resolveTaggerProviderId({ model_name: 'PaddleOCR VL' })).toBe('paddle_ocr')
    expect(
      resolveTaggerProviderFamily({ model_name: 'PaddleOCR VL', tagger_provider: 'paddle_ocr' })
    ).toBe('ocr')
    expect(resolveTaggerProviderFamily({ model_name: 'GLM OCR', model_use: 'ocr' })).toBe('ocr')
    expect(
      resolveTaggerProviderFamily({ model_name: 'gemini-2.5-flash', model_use: 'multimodal' })
    ).toBe('vlm')
    expect(resolveTaggerProviderFamily({ model_name: 'gpt-5.4', model_use: 'agent' })).toBe('vlm')
  })
})
