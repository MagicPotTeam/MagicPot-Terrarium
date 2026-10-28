import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { requestChatCompletion } from './chatRequestUtils'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('remote chat side-effect uncertainty', () => {
  it('never retries a POST after response loss when execution may already have happened', async () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      use_remote_llm: true,
      llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] },
      remote_llm_server_config: { server_origin: 'https://fixture-proxy.example', access_token: '' }
    }
    window.api = { svcManagedMedia: {} } as unknown as Window['api']
    let effects = 0
    const fetchMock = vi.fn(async () => {
      effects++
      throw new Error('owned response lost after acceptance')
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      requestChatCompletion({
        config,
        profileId: 'remote-only',
        messages: [{ role: 'user', content: 'owned operation' }]
      })
    ).rejects.toThrow('owned response lost')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(effects).toBe(1)
  })
})
