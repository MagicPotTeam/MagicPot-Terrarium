import type { BaseApi } from '@shared/api'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import type { ApiExtensionServices } from '@shared/api/extensionServices'
import type { LLMCli } from '@shared/llm'
import type { FetchImpl } from '@shared/llm/clients'
import { tripoMainLlmProxyExtension } from './tripoMainExtension'

export type MainApiExtensionContextV1 = {
  baseApi: BaseApi
}

export type MainLlmProxyExtensionContextV1 = {
  config: Config
  fetchImpl?: FetchImpl
  rawProfileId?: string
  requestedProfileId?: string
  signal?: AbortSignal
}

export type MainLlmProxyExtensionV1 = Readonly<{
  id: string
  createCli?: (
    profile: LLMAPIProfile,
    options: MainLlmProxyExtensionContextV1
  ) => LLMCli | undefined
  handleChatRequest?: (
    req: LLMChatReq,
    options: MainLlmProxyExtensionContextV1
  ) => Promise<LLMChatResp | undefined> | LLMChatResp | undefined
  normalizeRequestedProfileId?: (profileId: string | undefined) => string | undefined
}>

export type MainApiExtensionServicesFactoryV1 = (
  context: MainApiExtensionContextV1
) => Partial<ApiExtensionServices> | undefined

export type MainHostExtensionApiV1 = Readonly<{
  apiServices: MainApiExtensionServicesFactoryV1[]
  llmProxy: MainLlmProxyExtensionV1[]
}>

export const mainHostExtensionApiV1: MainHostExtensionApiV1 = {
  apiServices: [],
  llmProxy: [tripoMainLlmProxyExtension]
}

export const createApiExtensionServices = (
  context: MainApiExtensionContextV1
): ApiExtensionServices => {
  const services = mainHostExtensionApiV1.apiServices.reduce<Partial<ApiExtensionServices>>(
    (currentServices, createServices) => ({
      ...currentServices,
      ...createServices(context)
    }),
    {}
  )
  return services as ApiExtensionServices
}
