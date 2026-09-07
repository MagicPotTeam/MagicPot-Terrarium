import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { rendererHostExtensionApiV1 } from '@renderer/extensions/generatedRegistry'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import { useChatProfiles } from './useChatProfiles'

const buildProfile = (overrides: Partial<LLMAPIProfile> = {}): LLMAPIProfile => ({
  id: 'profile-1',
  model_name: 'Original Model',
  base_url: 'https://example.test/v1',
  api_key: 'test-token',
  provider: 'openai',
  deployment: 'cloud',
  auth_mode: 'api_key',
  model_use: 'chat',
  ...overrides
})

const buildConfig = (profiles: LLMAPIProfile[], useRemoteLlm = false): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: useRemoteLlm,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: profiles
  }
})

describe('useChatProfiles', () => {
  afterEach(() => {
    delete rendererHostExtensionApiV1.chat
    vi.unstubAllGlobals()
  })

  it('discovers and expands models for a runnable Codex OAuth profile', async () => {
    const profile = buildProfile({
      id: 'codex-oauth',
      model_name: 'Codex OAuth',
      auth_mode: 'codex_oauth',
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      call_type: 'codex'
    })
    const discoverModelNames = vi.fn().mockResolvedValue(['scanned-model-a', 'scanned-model-b'])
    rendererHostExtensionApiV1.chat = { discoverModelNames }

    const config = buildConfig([profile])
    const { result } = renderHook(() => useChatProfiles(config, true))

    await waitFor(() => expect(result.current.availableProfiles).toHaveLength(2))
    expect(discoverModelNames).toHaveBeenCalledOnce()
    expect(discoverModelNames).toHaveBeenCalledWith(profile)
    expect(result.current.availableProfiles).toEqual([
      {
        ...profile,
        id: 'codex-oauth::codex-model::scanned-model-a',
        model_name: 'scanned-model-a'
      },
      {
        ...profile,
        id: 'codex-oauth::codex-model::scanned-model-b',
        model_name: 'scanned-model-b'
      }
    ])
  })

  it('discovers and expands models for a runnable CLIProxyAPI profile', async () => {
    const profile = buildProfile({
      id: 'cliproxyapi',
      model_name: 'CLIProxyAPI',
      call_type: 'cliproxyapi'
    })
    const discoverModelNames = vi.fn().mockResolvedValue(['provider-a-alias', 'provider-b-alias'])
    rendererHostExtensionApiV1.chat = { discoverModelNames }

    const config = buildConfig([profile])
    const { result } = renderHook(() => useChatProfiles(config, true))

    await waitFor(() => expect(result.current.availableProfiles).toHaveLength(2))
    expect(discoverModelNames).toHaveBeenCalledOnce()
    expect(discoverModelNames).toHaveBeenCalledWith(profile)
    expect(result.current.availableProfiles).toEqual([
      {
        ...profile,
        id: 'cliproxyapi::codex-model::provider-a-alias',
        model_name: 'provider-a-alias'
      },
      {
        ...profile,
        id: 'cliproxyapi::codex-model::provider-b-alias',
        model_name: 'provider-b-alias'
      }
    ])
  })

  it('exposes every scanned CLIProxy model as a selectable thread profile in scan order', async () => {
    const profile = buildProfile({
      id: 'dynamic-channel',
      call_type: 'cliproxyapi',
      model_name: ''
    })
    const names = Array.from(
      { length: 32 },
      (_, index) => `test-${(index * 13) % 32}/Alias:${index}+value`
    )
    rendererHostExtensionApiV1.chat = { discoverModelNames: vi.fn().mockResolvedValue(names) }
    const config = buildConfig([profile])
    const { result } = renderHook(() => useChatProfiles(config, true))

    await waitFor(() => expect(result.current.availableProfiles).toHaveLength(names.length))
    expect(result.current.availableProfiles.map((model) => model.model_name)).toEqual(names)
    expect(result.current.availableProfiles.map((model) => model.id)).toEqual(
      names.map((name) => `dynamic-channel::codex-model::${encodeURIComponent(name)}`)
    )
  })

  it('keeps a regular profile when the renderer extension returns undefined', async () => {
    const profile = buildProfile()
    const discoverModelNames = vi.fn().mockResolvedValue(undefined)
    rendererHostExtensionApiV1.chat = { discoverModelNames }

    const config = buildConfig([profile])
    const { result } = renderHook(() => useChatProfiles(config, true))

    await waitFor(() => expect(discoverModelNames).toHaveBeenCalledWith(profile))
    expect(result.current.availableProfiles).toEqual([profile])
  })

  it('retains a discovered model in a mounted pane while activity toggles to another pane', async () => {
    const profile = buildProfile({
      id: 'codex-oauth',
      model_name: 'Codex OAuth',
      auth_mode: 'codex_oauth',
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      call_type: 'codex'
    })
    const discoverModelNames = vi.fn().mockResolvedValue(['retained-model'])
    rendererHostExtensionApiV1.chat = { discoverModelNames }
    const config = buildConfig([profile])

    const usePaneProfiles = (activePane: 'a' | 'b') => {
      const paneA = useChatProfiles(config, true, activePane === 'a')
      const paneB = useChatProfiles(config, true, activePane === 'b')
      return { paneA, paneB }
    }
    const { result, rerender } = renderHook(
      ({ activePane }: { activePane: 'a' | 'b' }) => usePaneProfiles(activePane),
      { initialProps: { activePane: 'a' } as { activePane: 'a' | 'b' } }
    )

    const variantId = 'codex-oauth::codex-model::retained-model'
    await waitFor(() => expect(result.current.paneA.availableProfiles[0]?.id).toBe(variantId))

    await act(async () => {
      rerender({ activePane: 'b' })
    })
    await waitFor(() => expect(result.current.paneB.availableProfiles[0]?.id).toBe(variantId))
    expect(result.current.paneA.availableProfiles[0]?.id).toBe(variantId)

    await act(async () => {
      rerender({ activePane: 'a' })
    })
    expect(result.current.paneA.availableProfiles[0]?.id).toBe(variantId)
  })

  it('removes retained discoveries when their base profile is removed while inactive', async () => {
    const profile = buildProfile({ call_type: 'cliproxyapi' })
    const discoverModelNames = vi.fn().mockResolvedValue(['discovered-model'])
    rendererHostExtensionApiV1.chat = { discoverModelNames }

    const { result, rerender } = renderHook(
      ({ config, enabled }: { config: Config; enabled: boolean }) =>
        useChatProfiles(config, true, enabled),
      { initialProps: { config: buildConfig([profile]), enabled: true } }
    )

    await waitFor(() =>
      expect(result.current.availableProfiles[0]?.id).toBe(
        'profile-1::codex-model::discovered-model'
      )
    )
    act(() => rerender({ config: buildConfig([]), enabled: false }))
    await waitFor(() => expect(result.current.availableProfiles).toEqual([]))
  })

  it.each([
    { mode: 'disabled', enabled: false, isReady: true, useRemoteLlm: false },
    { mode: 'not ready', enabled: true, isReady: false, useRemoteLlm: false },
    { mode: 'remote', enabled: true, isReady: true, useRemoteLlm: true }
  ])('does not discover models when $mode', async ({ enabled, isReady, useRemoteLlm }) => {
    const profile = buildProfile()
    const discoverModelNames = vi.fn().mockResolvedValue(['unexpected-model'])
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ profiles: [] })
    })
    rendererHostExtensionApiV1.chat = { discoverModelNames }
    vi.stubGlobal('fetch', fetchMock)

    const config = buildConfig([profile], useRemoteLlm)
    renderHook(() => useChatProfiles(config, isReady, enabled))

    await act(async () => {
      await Promise.resolve()
    })
    expect(discoverModelNames).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(useRemoteLlm ? 1 : 0)
  })
})
