import { app, clipboard, dialog, shell } from 'electron'
import type { BaseApi } from '@shared/api'
import type { ApiExtensionServices } from '@shared/api/extensionServices'
import {
  OpenAIAPICli,
  resolveProfileModelUse,
  validateProviderBaseUrl,
  type LLMCli,
  type LLMChatParams,
  type LLMChatResult
} from '@shared/llm'
import { createCodexThreadImageGenerator } from '../api/codexThreadImageGenerator'
import { createCodexBackendModelDiscoveryProvider } from '../api/codexModelDiscovery'
import { createCodexBetterAuthAdapter } from '../api/codexOAuth'
import { CodexChatGPTCli } from '../api/codexChatClient'
import { CodexAuthSvcImpl } from '../api/svcCodexAuthImpl'
import { CodexModelsSvcImpl, discoverCLIProxyModels } from '../api/svcCodexModelsImpl'
import { parseCodexModelProfileId } from '@shared/extensions/codexModelCatalog'
import type { MainLlmProxyExtensionV1 } from '../extensions/generatedRegistry'
import { getConfig } from '../config/config'
import {
  createCLIProxyGovernorIdentity,
  createGuardedCodexCli,
  normalizeCodexGovernorEndpoint
} from '../api/codexRequestGovernor'

const resolveCLIProxyCodexModel = async (
  profile: { base_url: string; api_key: string },
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<string> => {
  const { models } = await discoverCLIProxyModels(profile, {
    fetchImpl,
    signal
  })
  // Preserve the channel's order; model IDs are opaque, not a capability ranking.
  const selected = models[0]

  if (!selected) {
    throw new Error('CLIProxyAPI/Codex did not return any models.')
  }
  return selected
}

class CLIProxyCodexCli implements LLMCli {
  // Model discovery wraps a Responses client; do not hide its native-tool capability.
  readonly supportsNativeTools = true
  readonly supportsIsolatedReadOnlyTurns = true
  get supportsToolFreeImageReview(): boolean {
    return this.options.modelUse !== 'image' && this.options.modelUse !== 'video'
  }

  constructor(
    private readonly profile: { base_url: string; api_key: string },
    private readonly options: {
      modelUse: ReturnType<typeof resolveProfileModelUse>
      fetchImpl: typeof fetch
    }
  ) {}

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    if (params.disableProviderTools && this.options.modelUse === 'image') {
      throw new Error('Provider image tools are disabled.')
    }
    const modelName = await resolveCLIProxyCodexModel(
      this.profile,
      this.options.fetchImpl,
      params.signal
    )
    return new OpenAIAPICli(this.profile.api_key, this.profile.base_url, modelName, {
      modelUse: this.options.modelUse,
      callType: 'cliproxyapi',
      apiMode: 'responses',
      serviceTier: 'priority',
      forceStreaming: true,
      // CLIProxyAPI/Codex is the Responses-backed Codex transport. Enable web
      // search without creating hosted file-search/vector-store resources;
      // file search remains an explicit capability, as in the OAuth path.
      enableHostedTools: false,
      enableHostedWebSearch: true,
      reasoningProfile: { model_name: modelName, call_type: 'cliproxyapi' },
      fetchImpl: this.options.fetchImpl
    }).chat(params)
  }
}

export const createCodexApiExtensionServices = (_context: { baseApi: BaseApi }) => {
  const codexAuthLifecycle = createCodexBetterAuthAdapter({
    onDeviceCode: async ({ userCode, verificationUri }) => {
      clipboard.writeText(userCode)
      await shell.openExternal(verificationUri)
      void dialog.showMessageBox({
        type: 'info',
        title: 'Codex device login',
        message: `Codex device code: ${userCode}`,
        detail:
          'The code has been copied to your clipboard. Paste it into the browser page to finish signing in.',
        buttons: ['OK']
      })
    },
    openExternal: async (url) => shell.openExternal(url)
  })

  return {
    svcCodexAuth: new CodexAuthSvcImpl(codexAuthLifecycle),
    svcCodexModels: new CodexModelsSvcImpl({
      resolveCLIProxyProfile: (profileId) =>
        getConfig().llm_config.api_profiles.find(
          (profile) => profile.id === profileId && profile.call_type === 'cliproxyapi'
        ),
      discoveryProvider: createCodexBackendModelDiscoveryProvider({
        authLifecycle: codexAuthLifecycle,
        clientVersion: app.getVersion()
      })
    })
  }
}

export const codexMainLlmProxyExtension: MainLlmProxyExtensionV1 = {
  id: 'codex',
  createThreadImageGenerator(request, context) {
    return createCodexThreadImageGenerator(request, {
      config: context.config,
      currentConfig: getConfig,
      fetchImpl: context.fetchImpl
    })
  },
  createCli(profile, context) {
    if (profile.call_type === 'cliproxyapi') {
      // Extension routes run before the shared built-in profile factory, so
      // enforce the provider transport policy at this private boundary too.
      // LAN/loopback HTTP remains supported; public HTTP and URL credentials
      // are rejected before discovery or model requests can carry the key.
      validateProviderBaseUrl(profile.base_url)
      const fetchImpl = context.fetchImpl ?? globalThis.fetch.bind(globalThis)
      const modelSelection = parseCodexModelProfileId(context.rawProfileId)
      const selectedModelName =
        (modelSelection?.profileId === profile.id ? modelSelection.modelName : undefined) ||
        profile.model_name?.trim()
      const cli = selectedModelName
        ? new OpenAIAPICli(profile.api_key, profile.base_url, selectedModelName, {
            modelUse: resolveProfileModelUse(profile),
            callType: 'cliproxyapi',
            apiMode: 'responses',
            serviceTier: 'priority',
            forceStreaming: true,
            // Keep explicit model selection on the same web-search-only path
            // as automatic CLIProxy model discovery and Codex OAuth.
            enableHostedTools: false,
            enableHostedWebSearch: true,
            reasoningProfile: {
              model_name: selectedModelName,
              call_type: 'cliproxyapi'
            },
            fetchImpl
          })
        : new CLIProxyCodexCli(profile, {
            modelUse: resolveProfileModelUse(profile),
            fetchImpl
          })

      // Decorate both explicit and auto-discovered model paths at their common boundary.
      return createGuardedCodexCli(cli, {
        identity: createCLIProxyGovernorIdentity(profile.api_key),
        endpoint: normalizeCodexGovernorEndpoint(profile.base_url),
        modelName: selectedModelName
      })
    }

    if (profile.auth_mode !== 'codex_oauth') {
      return undefined
    }

    const modelSelection = parseCodexModelProfileId(context.rawProfileId)
    const selectedModelName =
      (modelSelection?.profileId === profile.id ? modelSelection.modelName : undefined) ||
      profile.model_name?.trim()
    const modelUse = resolveProfileModelUse(profile)
    const createSelectedCli = (modelName: string) =>
      new CodexChatGPTCli(modelName, {
        modelUse,
        serviceTier: profile.codex_fast_mode !== false ? 'priority' : undefined,
        fetchImpl: context.fetchImpl
      })
    if (selectedModelName) return createSelectedCli(selectedModelName)

    const modelService = new CodexModelsSvcImpl({
      discoveryProvider: createCodexBackendModelDiscoveryProvider({
        clientVersion: app.getVersion(),
        fetchFn: context.fetchImpl
      })
    })
    return {
      supportsNativeTools: true,
      supportsToolFreeImageReview: modelUse !== 'image' && modelUse !== 'video',
      async chat(params) {
        if (params.readOnlyImageReview) throw new Error('Select a model before starting image review.')
        if (params.disableProviderTools && modelUse === 'image') {
          throw new Error('Provider image tools are disabled.')
        }
        params.signal?.throwIfAborted()
        const catalog = await modelService.list({})
        params.signal?.throwIfAborted()
        const modelName = catalog.models[0]?.value
        if (!modelName)
          throw new Error(
            'Codex did not return any models. Refresh the model list and select a model.'
          )
        return createSelectedCli(modelName).chat(params)
      }
    }
  },
  normalizeRequestedProfileId(profileId) {
    return parseCodexModelProfileId(profileId)?.profileId
  }
}
