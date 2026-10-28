/**
 * Shared LLM module — barrel export
 */

export type {
  ChatAttachment,
  ChatMessage,
  ToolHistoryEntry,
  GeneratePromptParams,
  LLMChatFinishReason,
  LLMChatMetadata,
  LLMChatTokenUsage,
  LLMImageHistoryPolicy,
  LLMChatParams,
  LLMChatResult,
  LLMDeltaEvent,
  LLMStructuredOutput,
  LLMCli,
  LLMCliWithPrompt,
  OpenAIImageGenerationAction,
  OpenAIImageGenerationBackground,
  OpenAIImageGenerationOptions,
  OpenAIImageGenerationOutputFormat,
  OpenAIImageGenerationQuality
} from './types'
export type {
  ModelInvocationContract,
  ModelInvocationError,
  ModelInvocationEvent,
  ModelInvocationIdentity,
  ModelInvocationPermission,
  ModelInvocationRequest,
  ModelInvocationResourceRef,
  ModelInvocationTimeout
} from './modelInvocationContract'
export { normalizeLLMChatResult, parseStructuredLLMChatResult } from './types'
export {
  normalizeLLMStructuredOutput,
  LLM_STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES
} from './structuredOutput'
export {
  MODEL_INVOCATION_DEFAULT_DEADLINE_MS,
  MODEL_INVOCATION_SCHEMA,
  MODEL_INVOCATION_VERSION,
  buildModelInvocationHeaders,
  createModelInvocationContract,
  createModelInvocationRequest,
  isCurrentModelInvocation,
  normalizeModelInvocationContract,
  normalizeModelInvocationError,
  toModelInvocationError
} from './modelInvocationContract'
export type {
  ImageRequestAction,
  ImageHistoryContinuationRefs,
  ImageRequestLimits,
  ImageRequestPermission,
  ImageRequestControl,
  ImageRequestUsage,
  ImageRequestError,
  ImageRequestContract,
  ImageRequestContractInput
} from './imageRequestContract'
export { buildImageRequestContract, validateImageRequestContract } from './imageRequestContract'
export {
  getReasoningEffortLabel,
  normalizeReasoningEffort,
  resolveChatProfileCapabilities,
  type LLMReasoningEffort,
  type ProviderAttachmentTransport,
  type ChatCapabilityProfile,
  type ChatProfileCapabilities
} from './profileCapabilities'
export {
  selectProviderAttachmentTransport,
  type AttachmentTransportAvailability,
  type SelectAttachmentTransportOptions
} from './attachmentTransport'
export {
  OpenAIAPICli,
  GeminiAPICli,
  ClaudeAPICli,
  OpencodeZenAPICli,
  OllamaAPICli,
  convertImageToBase64,
  describeFetchFailure,
  normalizeOpenAIBaseUrl,
  normalizeGeminiModelName,
  normalizeGeminiBaseUrl,
  normalizeClaudeBaseUrl,
  normalizeOllamaBaseUrl,
  UpstreamHttpError
} from './clients'
export type {
  FetchImpl,
  OpenAIClientApiMode,
  OpenAIClientOptions,
  OpenAIImageAttachmentLoader
} from './clients'
export {
  isGeminiUrl,
  isClaudeUrl,
  isKlingUrl,
  isVolcengineUrl,
  isOllamaUrl,
  isOpencodeZenUrl,
  isLocalBaseUrl,
  isOllamaProfile,
  resolveProfileCallType,
  resolveProfileProvider,
  resolveProfileDeployment,
  resolveProfileModelUse,
  isRunnableProfile,
  isCodexFastModeEnabled,
  cliFromProfile
} from './utils'
export { isPrivateOrLocalProviderHost, validateProviderBaseUrl } from './providerEndpointPolicy'
export {
  isOpenAIFileSearchAttachment,
  collectOpenAIFileSearchAttachments,
  buildOpenAIFileSearchTool,
  createOpenAIFileSearchSession
} from './openaiFileSearch'
export { normalizeOpenAIImageGenerationSize } from './openaiResponses'
export { readOpenAIStream } from './openaiStreaming'
export {
  KlingVideoAPICli,
  VolcengineSeedanceAPICli,
  createKlingJwt,
  normalizeKlingBaseUrl,
  normalizeVolcengineBaseUrl
} from './videoClients'
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

export {
  OPENCODE_ZEN_API_BASE_URL,
  OPENCODE_ZEN_DEFAULT_MODEL,
  fetchOpencodeZenModels,
  getOpencodeZenStaticFallbackModels,
  resolveOpencodeZenAlias,
  resolveOpencodeZenModelApi,
  type ModelDefinitionConfig
} from './opencodeZenModels'
