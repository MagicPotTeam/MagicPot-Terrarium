import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { BaseApi } from '@shared/api'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import type { ApiExtensionServices } from '@shared/api/extensionServices'
import type { Config, LLMAPIProfile } from '@shared/config/config'
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
