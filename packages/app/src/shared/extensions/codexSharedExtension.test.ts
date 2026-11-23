import { describe, expect, it } from 'vitest'
import {
  selectProviderAttachmentTransport,
  type ChatCapabilityProfile,
  type ChatProfileCapabilities
} from '@shared/llm'
import { codexLlmProfileExtension } from './codexSharedExtension'
import {
  buildCodexModelCatalog,
  buildCodexModelProfileId,
  normalizeCodexModelName,
  parseCodexModelProfileId
} from './codexModelCatalog'

describe('dynamic Codex model catalog', () => {
  it('only lists discovered or saved models, with no bundled fallback IDs', () => {
    expect(buildCodexModelCatalog()).toEqual([])
    expect(
      buildCodexModelCatalog({
        currentModelName: 'saved-deployment',
        discoveredModelNames: ['team/Custom:v2', 'opaque-alias', 'team/Custom:v2'],
        observedModelNames: ['previous-deployment']
      }).map((option) => option.value)
    ).toEqual(['saved-deployment', 'team/Custom:v2', 'opaque-alias', 'previous-deployment'])
  })

  it('round-trips arbitrary model IDs without changing their case or characters', () => {
    const modelName = 'team/Custom Model:v2+test'
    expect(parseCodexModelProfileId(buildCodexModelProfileId('profile', modelName))).toEqual({
      profileId: 'profile',
      modelName
    })
    expect(normalizeCodexModelName(` ${modelName} `)).toBe(modelName)
  })

  it('does not replace an empty model with a hardcoded model ID', () => {
    expect(normalizeCodexModelName('   ')).toBe('')
    expect(buildCodexModelProfileId('profile', '')).toBe('profile')
    expect(parseCodexModelProfileId('profile::codex-model::%20')).toBeNull()
  })
})

const EMPTY_CAPABILITIES: ChatProfileCapabilities = {
  reasoningEfforts: [],
  supportsAutoContextCompression: false,
  supportsSessionContinuation: false,
  attachmentTransports: []
}

const resolveCapabilities = (profile: ChatCapabilityProfile): ChatProfileCapabilities => ({
  ...EMPTY_CAPABILITIES,
  ...codexLlmProfileExtension.resolveCapabilities?.(profile, EMPTY_CAPABILITIES)
})

describe('codexLlmProfileExtension', () => {
  it.each(Array.from({ length: 16 }, (_, index) => `team-${index}/Alias:模型-${index}`))(
    'keeps OAuth and CLIProxyAPI capabilities aligned for %s',
    (modelName) => {
      const oauthCapabilities = resolveCapabilities({
        model_name: modelName,
        auth_mode: 'codex_oauth'
      })
      const proxyCapabilities = resolveCapabilities({
        model_name: modelName,
        call_type: 'cliproxyapi'
      })

      expect(oauthCapabilities).toEqual(proxyCapabilities)
      expect(oauthCapabilities.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      expect(oauthCapabilities.defaultReasoningEffort).toBeUndefined()
      expect(oauthCapabilities.reasoningEfforts).not.toContain('ultra')
      expect(oauthCapabilities.supportsSessionContinuation).toBe(false)
    }
  )

  it('keeps model-less CLIProxyAPI profiles runnable for main-process model discovery', () => {
    const profile = {
      model_name: '',
      base_url: 'https://proxy.example.test/v1',
      api_key: 'cpa-test',
      call_type: 'cliproxyapi'
    }

    expect(codexLlmProfileExtension.isRunnableProfile?.(profile)).toBe(true)
    expect(codexLlmProfileExtension.resolveProfileCallType?.(profile)).toBe('cliproxyapi')
  })

  it('offers controls for unknown models without inventing context limits or a default effort', () => {
    expect(
      resolveCapabilities({
        model_name: 'custom-unknown-model',
        call_type: 'cliproxyapi'
      })
    ).toEqual({
      ...EMPTY_CAPABILITIES,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: undefined,
      attachmentTransports: ['request-data-url']
    })
  })

  it.each([
    [{ model_name: 'gpt-5.6-sol', auth_mode: 'codex_oauth' }],
    [{ model_name: 'gpt-5.6-sol', call_type: 'cliproxyapi' }]
  ])('preserves base capabilities and selects request-data-url for Codex profile %#', (profile) => {
    const baseCapabilities: ChatProfileCapabilities = {
      reasoningEfforts: ['low'],
      supportsAutoContextCompression: false,
      supportsSessionContinuation: false,
      attachmentTransports: ['file-id']
    }
    const capabilities = {
      ...baseCapabilities,
      ...codexLlmProfileExtension.resolveCapabilities?.(profile, baseCapabilities)
    }

    expect(capabilities.attachmentTransports).toEqual(['file-id', 'request-data-url'])
    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { 'request-data-url': true },
        requested: 'request-data-url'
      })
    ).toBe('request-data-url')
  })
})
