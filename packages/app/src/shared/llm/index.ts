/**
 * Shared LLM module — barrel export
 */

export type {
  ChatAttachment,
  ChatMessage,
  GeneratePromptParams,
  LLMChatFinishReason,
  LLMChatMetadata,
  LLMChatParams,
  LLMChatResult,
  LLMDeltaEvent,
  LLMCli,
  LLMCliWithPrompt,
  OpenAIImageGenerationAction,
  OpenAIImageGenerationBackground,
  OpenAIImageGenerationOptions,
  OpenAIImageGenerationOutputFormat,
  OpenAIImageGenerationQuality
} from './types'
export { normalizeLLMChatResult, parseStructuredLLMChatResult } from './types'
export {
  getReasoningEffortLabel,
  normalizeReasoningEffort,
  resolveChatProfileCapabilities,
  type LLMReasoningEffort,
  type ChatCapabilityProfile,
  type ChatProfileCapabilities
} from './profileCapabilities'
export {
  OpenAIAPICli,
  GeminiAPICli,
  ClaudeAPICli,
  OllamaAPICli,
  convertImageToBase64,
  describeFetchFailure,
  normalizeOpenAIBaseUrl,
  normalizeGeminiModelName,
  normalizeGeminiBaseUrl,
  normalizeClaudeBaseUrl,
  normalizeOllamaBaseUrl
} from './clients'
export type { FetchImpl } from './clients'
export {
  isGeminiUrl,
  isClaudeUrl,
  isOllamaUrl,
  isLocalBaseUrl,
  isOllamaProfile,
  resolveProfileCallType,
  resolveProfileProvider,
  resolveProfileDeployment,
  resolveProfileModelUse,
  isRunnableProfile,
  cliFromProfile
} from './utils'
export {
  isOpenAIFileSearchAttachment,
  collectOpenAIFileSearchAttachments,
  buildOpenAIFileSearchTool,
  createOpenAIFileSearchSession
} from './openaiFileSearch'
export { normalizeOpenAIImageGenerationSize } from './openaiResponses'
export { getSuggestedModelCatalog, type ModelCatalogOption } from './modelCatalog'
export {
  listTaggerProviders,
  getTaggerProviderDescriptor,
  resolveTaggerProviderId,
  resolveTaggerProviderDescriptor,
  resolveTaggerEndpoint,
  resolveTaggerCacheScope,
  buildTaggerRuntimeCacheKey,
  resolveTaggerRuntimeDescriptor,
  clearTaggerRuntimeCache,
  isTaggerSkillRuntime,
  isTaggerProviderEnabledProfile,
  getTaggerProviderDisplayLabel,
  resolveTaggerProviderFamily,
  type TaggerProviderDescriptor,
  type TaggerProviderFamily,
  type TaggerRuntimeDescriptor
} from './taggerProviders'
export {
  parseNormalizedTaggingResponse,
  buildNormalizedTaggingSidecarText,
  type NormalizedTaggingProviderFamily,
  type NormalizedTaggingProviderMetadata,
  type NormalizedTaggingResult
} from './taggingContract'
