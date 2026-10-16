import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { LlmProfileRevision } from './llmProfileRevision'
import { getConfig, onConfigCommitted } from '../config/config'
import { cliFromProfile } from '@shared/llm'
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'

vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
vi.mock('../config/config', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  onConfigCommitted: vi.fn()
}))
vi.mock('../extensions/generatedRegistry', () => ({ mainHostExtensionApiV1: { llmProxy: [] } }))
vi.mock('@shared/llm', async (original) => ({
  ...(await original<typeof import('@shared/llm')>()),
  cliFromProfile: vi.fn()
}))
let config: Config
const messages = [{ role: 'user' as const, content: 'Synthetic summary' }]
const chat = vi.fn(async () => 'Advice')
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
  config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [
    {
      id: 'profile',
      model_name: 'gpt-4o',
      api_key: 'private-fixture-key',
      base_url: 'https://fixture.invalid/v1/chat/completions'
    }
  ]
  vi.mocked(getConfig).mockImplementation(() => config)
  vi.mocked(cliFromProfile).mockReturnValue({ chat } as never)
  mainHostExtensionApiV1.llmProxy.length = 0
})

afterEach(() => vi.unstubAllGlobals())

describe('model configuration consent revisions', () => {
  it('uses an opaque keyed token, stable under property order but not instance/profile changes', () => {
    const revisions = new LlmProfileRevision()
    const token = revisions.create(config, 'profile::selected-model')
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(token).not.toContain('private-fixture-key')
    const reordered = structuredClone(config)
    reordered.llm_config.api_profiles[0] = Object.fromEntries(
      Object.entries(config.llm_config.api_profiles[0]).reverse()
    ) as Config['llm_config']['api_profiles'][number]
    expect(revisions.create(reordered, 'profile::selected-model')).toBe(token)
    expect(() => revisions.verify(config, 'profile::selected-model', token)).not.toThrow()
    expect(() => revisions.verify(config, 'profile', token)).toThrow('Model configuration changed')
    expect(() => new LlmProfileRevision().verify(config, 'profile::selected-model', token)).toThrow(
      'Model configuration changed'
    )
    for (const invalid of [undefined, null, '', token.slice(1), 'x'.repeat(64)]) {
      expect(() => revisions.verify(config, 'profile::selected-model', invalid)).toThrow(
        'Model configuration changed'
      )
    }
  })

  it.each(['base_url', 'model_name', 'api_key', 'provider', 'remote'] as const)(
    'rejects changed %s before extension hooks or client creation',
    async (field) => {
      const service = new LLMProxySvcImpl()
      const listed = await service.listProfiles({ includeConfigurationRevision: true })
      const token = listed.profiles[0].configurationRevision
      expect(token).toMatch(/^[a-f0-9]{64}$/)
      const hook = vi.fn()
      mainHostExtensionApiV1.llmProxy.push({ id: 'test', handleChatRequest: hook })
      if (field === 'remote') config.use_remote_llm = true
      else Object.assign(config.llm_config.api_profiles[0], { [field]: 'changed-fixture-value' })
      await expect(
        service.chat({ messages, profileId: 'profile', expectedProfileRevision: token })
      ).rejects.toMatchObject({ code: 'PROFILE_CONFIGURATION_CHANGED' })
      expect(hook).not.toHaveBeenCalled()
      expect(cliFromProfile).not.toHaveBeenCalled()
    }
  )

  it('uses the verified cloned configuration after an asynchronous extension yields', async () => {
    const service = new LLMProxySvcImpl()
    const { profiles } = await service.listProfiles({ includeConfigurationRevision: true })
    const priorUrl = config.llm_config.api_profiles[0].base_url
    mainHostExtensionApiV1.llmProxy.push({
      id: 'yield-test',
      async handleChatRequest() {
        config.llm_config.api_profiles[0].base_url = 'https://changed.invalid'
        return undefined
      }
    })
    await expect(
      service.chat({
        messages,
        profileId: 'profile',
        expectedProfileRevision: profiles[0].configurationRevision
      })
    ).resolves.toMatchObject({ content: 'Advice' })
    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({ base_url: priorUrl }),
      expect.anything()
    )
    expect(chat).toHaveBeenCalledOnce()
  })

  it('does not rotate an explicitly consented profile to a sibling configuration', async () => {
    config.llm_config.api_profiles.push({
      ...config.llm_config.api_profiles[0],
      id: 'sibling',
      api_key: 'different-account'
    })
    const service = new LLMProxySvcImpl()
    const { profiles } = await service.listProfiles({ includeConfigurationRevision: true })
    for (let i = 0; i < 2; i++)
      await service.chat({
        messages,
        profileId: 'profile',
        expectedProfileRevision: profiles[0].configurationRevision
      })
    expect(cliFromProfile).toHaveBeenCalledTimes(2)
    for (const [profile] of vi.mocked(cliFromProfile).mock.calls) {
      expect(profile).toMatchObject({ id: 'profile', api_key: 'private-fixture-key' })
    }
  })

  it('wires the main-only configuration notification without metadata, network or hidden IPC fields', () => {
    const service = new LLMProxySvcImpl()
    const listener = vi.fn()
    const stop = vi.fn()
    vi.mocked(onConfigCommitted).mockReturnValueOnce(stop)
    expect(service.onProfileConfigurationChanged(listener)).toBe(stop)
    expect(onConfigCommitted).toHaveBeenCalledExactlyOnceWith(listener)
    expect(chat).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(cliFromProfile).not.toHaveBeenCalled()
  })

  it('checks current revisions inside main without another discovery or model request', async () => {
    const service = new LLMProxySvcImpl()
    const revision = (await service.listProfiles({ includeConfigurationRevision: true }))
      .profiles[0].configurationRevision!
    expect(service.isProfileRevisionCurrent('profile', revision)).toBe(true)
    expect(service.isProfileRevisionCurrent('other', revision)).toBe(false)
    expect(service.isProfileRevisionCurrent('profile', 'bad')).toBe(false)
    config.llm_config.api_profiles[0].api_key = 'rotated-fixture-key'
    expect(service.isProfileRevisionCurrent('profile', revision)).toBe(false)
    expect(chat).not.toHaveBeenCalled()
  })

  it('keeps existing metadata responses unchanged unless revisions are requested', async () => {
    const service = new LLMProxySvcImpl()
    expect((await service.listProfiles({})).profiles[0]).not.toHaveProperty('configurationRevision')
    const revisions = await service.listProfiles({ includeConfigurationRevision: true })
    expect(revisions.profiles[0].configurationRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(revisions)).not.toContain('private-fixture-key')
    const previous = revisions.profiles[0].configurationRevision
    await expect(
      service.chat({ profileId: 'different-profile', messages, expectedProfileRevision: previous })
    ).rejects.toMatchObject({ code: 'PROFILE_CONFIGURATION_CHANGED' })
    expect(chat).not.toHaveBeenCalled()
  })

  it('issues model-specific revisions after trusted extension normalization without accepting another model', async () => {
    mainHostExtensionApiV1.llmProxy.push({
      id: 'composite-fixture',
      normalizeRequestedProfileId: (value) => value?.split('::')[0],
      transformListedProfiles: async (profiles) =>
        profiles.map((profile) => ({
          ...profile,
          id: `${profile.id}::synthetic-model`,
          base_profile_id: profile.id
        }))
    })
    const service = new LLMProxySvcImpl()
    const { profiles } = await service.listProfiles({ includeConfigurationRevision: true })
    const listed = profiles[0]
    await expect(
      service.chat({
        messages,
        profileId: listed.id,
        expectedProfileRevision: listed.configurationRevision
      })
    ).resolves.toMatchObject({ content: 'Advice' })
    await expect(
      service.chat({
        messages,
        profileId: 'profile::different',
        expectedProfileRevision: listed.configurationRevision
      })
    ).rejects.toMatchObject({ code: 'PROFILE_CONFIGURATION_CHANGED' })
    expect(chat).toHaveBeenCalledOnce()
  })

  it('preserves old requests and omits new consent tokens in unsupported global remote mode', async () => {
    const service = new LLMProxySvcImpl()
    await expect(service.chat({ messages, profileId: 'profile' })).resolves.toMatchObject({
      content: 'Advice'
    })
    config.use_remote_llm = true
    expect(
      (await service.listProfiles({ includeConfigurationRevision: true })).profiles[0]
        .configurationRevision
    ).toBeUndefined()
  })
})
