import type { BaseApi } from '@shared/api'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import type { ApiExtensionServices } from '@shared/api/extensionServices'
import type { FetchImpl } from '@shared/llm/clients'

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

export type MainLlmProxyExtensionV1 = {
  id: string
  createCli?: (
    profile: LLMAPIProfile,
    options: MainLlmProxyExtensionContextV1
  ) => import('@shared/llm').LLMCli | undefined
  handleChatRequest?: (
    req: LLMChatReq,
    options: MainLlmProxyExtensionContextV1
  ) => Promise<LLMChatResp | undefined>
  normalizeRequestedProfileId?: (profileId: string | undefined) => string | undefined
}

export type MainHostExtensionApiV1 = {
  llmProxy: MainLlmProxyExtensionV1[]
}

export const mainHostExtensionApiV1: MainHostExtensionApiV1 = {
  llmProxy: []
}

export const createApiExtensionServices = (
  _context: MainApiExtensionContextV1
): ApiExtensionServices => ({})
