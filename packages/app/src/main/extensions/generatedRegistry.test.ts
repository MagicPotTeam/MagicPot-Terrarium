import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { BaseApi } from '@shared/api'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import type { ApiExtensionServices } from '@shared/api/extensionServices'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { LLMCli } from '@shared/llm'
import type { FetchImpl } from '@shared/llm/clients'
import {
  createApiExtensionServices,
  mainHostExtensionApiV1,
  type MainApiExtensionContextV1,
  type MainHostExtensionApiV1,
  type MainLlmProxyExtensionV1
} from './generatedRegistry'
import { tripoMainLlmProxyExtension } from './tripoMainExtension'

const createConfigWithQAppProfiles = (apiProfiles: LLMAPIProfile[]): Config => {
  const basePluginConfig = DEFAULT_CONFIG.plugin_config ?? {
    api_profiles: [],
    light_adjustment_prompt: ''
  }

  return {
    ...DEFAULT_CONFIG,
    plugin_config: {
      ...basePluginConfig,
      api_profiles: apiProfiles
    }
  }
}

describe('main extension registry', () => {
  it('registers the Tripo LLM proxy extension by default', () => {
    expect(mainHostExtensionApiV1.llmProxy).toContain(tripoMainLlmProxyExtension)
  })
  afterEach(() => {
    mainHostExtensionApiV1.apiServices.splice(0)
    mainHostExtensionApiV1.llmProxy.splice(
      0,
      mainHostExtensionApiV1.llmProxy.length,
      tripoMainLlmProxyExtension
    )
  })

  it('creates API extension services from registered factories with base API context', () => {
    const baseApi = { svcLog: {} } as BaseApi
    const firstFactory = vi.fn((context: MainApiExtensionContextV1) => {
      expect(context.baseApi).toBe(baseApi)
      return { svcFirstExtension: { marker: 'first' } } as Partial<ApiExtensionServices>
    })
    const secondFactory = vi.fn(() => undefined)
    const thirdFactory = vi.fn(
      () => ({ svcSecondExtension: { marker: 'second' } }) as Partial<ApiExtensionServices>
    )

    mainHostExtensionApiV1.apiServices.push(firstFactory, secondFactory, thirdFactory)

    expect(createApiExtensionServices({ baseApi })).toEqual({
      svcFirstExtension: { marker: 'first' },
      svcSecondExtension: { marker: 'second' }
    })
    expect(firstFactory).toHaveBeenCalledTimes(1)
    expect(secondFactory).toHaveBeenCalledTimes(1)
    expect(thirdFactory).toHaveBeenCalledTimes(1)
  })

  it('lets Tripo handle legacy Hunyuan profile ids when Tripo is the active 3D profile', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { task_id: 'tripo-task-1' } }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              task_id: 'tripo-task-1',
              status: 'success',
              output: { model: 'https://cdn.example.com/tripo.glb' }
            }
          }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    const tripoProfile: LLMAPIProfile = {
      id: 'quick-tripo',
      model_name: 'Tripo3D Pro',
      base_url: 'https://api.tripo3d.ai',
      api_key: 'tripo-key'
    }
    const config = createConfigWithQAppProfiles([tripoProfile])

    const response = await tripoMainLlmProxyExtension.handleChatRequest?.(
      {
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
        messages: [{ role: 'user', content: 'cat' }]
      },
      {
        config,
        fetchImpl: fetchMock as unknown as typeof fetch,
        requestedProfileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob'
      }
    )

    expect(response?.content).toContain('[Generated 3D Model](https://cdn.example.com/tripo.glb)')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const submitBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(submitBody).toEqual(expect.objectContaining({ type: 'text_to_model', prompt: 'cat' }))
  })

  it('does not let Tripo steal legacy Hunyuan profile ids when Hunyuan is the active 3D profile', async () => {
    const fetchMock = vi.fn()
    const hunyuanProfile: LLMAPIProfile = {
      id: 'quick-hunyuan',
      model_name: 'Hunyuan3D Pro',
      base_url: 'https://ai3d.cloud.tencent.com',
      api_key: '',
      tencent_secret_id: 'secret-id',
      tencent_secret_key: 'secret-key'
    }
    const tripoProfile: LLMAPIProfile = {
      id: 'quick-tripo',
      model_name: 'Tripo3D Pro',
      base_url: 'https://api.tripo3d.ai',
      api_key: 'tripo-key'
    }
    const config = createConfigWithQAppProfiles([hunyuanProfile, tripoProfile])

    const response = await tripoMainLlmProxyExtension.handleChatRequest?.(
      {
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
        messages: [{ role: 'user', content: 'cat' }]
      },
      {
        config,
        fetchImpl: fetchMock as unknown as typeof fetch,
        requestedProfileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob'
      }
    )

    expect(response).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the main LLM extension contract typed', () => {
    expectTypeOf<
      MainHostExtensionApiV1['llmProxy'][number]
    >().toEqualTypeOf<MainLlmProxyExtensionV1>()
    expectTypeOf<MainLlmProxyExtensionV1['createCli']>().toEqualTypeOf<
      | ((
          profile: LLMAPIProfile,
          options: {
            config: Config
            fetchImpl?: FetchImpl
            rawProfileId?: string
            requestedProfileId?: string
            signal?: AbortSignal
          }
        ) => LLMCli | undefined)
      | undefined
    >()
    expectTypeOf<MainLlmProxyExtensionV1['handleChatRequest']>().toEqualTypeOf<
      | ((
          req: LLMChatReq,
          options: {
            config: Config
            fetchImpl?: FetchImpl
            rawProfileId?: string
            requestedProfileId?: string
            signal?: AbortSignal
          }
        ) => Promise<LLMChatResp | undefined> | LLMChatResp | undefined)
      | undefined
    >()
  })
})
