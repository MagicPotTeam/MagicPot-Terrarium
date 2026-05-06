import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { fetchRemoteQAppCfg, fetchRemoteQAppList, REMOTE_QAPP_PREFIX } from './remoteQApp'

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: []
  },
  local_llm_server_config: {
    ...DEFAULT_CONFIG.local_llm_server_config
  },
  remote_llm_server_config: {
    ...DEFAULT_CONFIG.remote_llm_server_config
  },
  aigc3d_config: {
    ...DEFAULT_CONFIG.aigc3d_config!
  }
})

describe('remoteQApp', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the remote proxy token when fetching quick app lists', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          qApps: [
            {
              key: 'demo',
              name: 'Demo'
            }
          ]
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const config = createConfig()
    config.remote_llm_server_config.access_token = 'proxy-secret'

    const result = await fetchRemoteQAppList('http://127.0.0.1:3721', config)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3721/api/qapps/list',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer proxy-secret'
        }
      })
    )
    expect(result).toEqual([
      expect.objectContaining({
        key: `${REMOTE_QAPP_PREFIX}demo`,
        isRemote: true
      })
    ])
  })

  it('raises a readable unauthorized error when fetching a remote quick app', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'Unauthorized LLM proxy request'
        }),
        {
          status: 401,
          statusText: 'Unauthorized',
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchRemoteQAppCfg('http://127.0.0.1:3721', `${REMOTE_QAPP_PREFIX}demo`)
    ).rejects.toThrow('access token matches the server configuration')
  })
})
