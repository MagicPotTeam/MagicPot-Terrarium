import { createHash } from 'node:crypto'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { FetchImpl } from '@shared/llm'
import { resolveCodexThreadImageCapability } from '@shared/extensions/codexImageProfile'
import { parseCodexModelProfileId } from '@shared/extensions/codexModelCatalog'
import { CodexImageClient, type CodexImageAuth, type CodexImageOptions } from './codexImageClient'

/** Pure MAIN factory: selected profile only, never an arbitrary credential scan.
 * Does no login, discovery, network or disk work during tool discovery.
 */
export function createCodexThreadImageGenerator(
  request: LLMChatReq,
  options: {
    config: Config
    currentConfig(): Config
    fetchImpl?: FetchImpl
  }
) {
  const sourceId = parseCodexModelProfileId(request.profileId)?.profileId ?? request.profileId
  if (
    !sourceId ||
    options.config.use_remote_llm ||
    request.profileScope === 'qapp' ||
    request.comparisonRouting ||
    request.skillRuntime ||
    request.imageRequest ||
    request.videoGenerationOptions ||
    (request.imageGenerationOptions &&
      (request.imageGenerationOptions.enabled !== false ||
        Object.keys(request.imageGenerationOptions).some((key) => key !== 'enabled')))
  )
    return undefined
  const capability = resolveCodexThreadImageCapability(options.config, sourceId)
  if (!capability) return undefined
  const { sourceProfileId, imageProfileId: id, backend, endpoint } = capability
  const sourceMatches = options.config.llm_config.api_profiles.filter((profile) => profile.id === sourceProfileId)
  const matches = options.config.llm_config.api_profiles.filter((profile) => profile.id === id)
  const source = structuredClone(sourceMatches[0])
  const profile = structuredClone(matches[0])
  const auth: CodexImageAuth =
    backend !== 'codex-json-oauth'
      ? { mode: 'api-key', baseUrl: endpoint, apiKey: profile.api_key }
      : { mode: 'oauth' }
  const digest = (value: LLMAPIProfile) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const expected = digest(profile)
  const expectedSource = digest(source)
  const assertCurrent = () => {
    const config = options.currentConfig()
    const sources = config.llm_config.api_profiles.filter((candidate) => candidate.id === sourceProfileId)
    const targets = config.llm_config.api_profiles.filter((candidate) => candidate.id === id)
    if (
      config.use_remote_llm ||
      sources.length !== 1 ||
      targets.length !== 1 ||
      digest(sources[0]) !== expectedSource ||
      digest(targets[0]) !== expected
    )
      throw new Error('Selected image backend changed; start a new Agent thread request.')
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const gifEnabled = backend !== 'openai-images-api-key' && source.codex_image_gif_enabled === true
  const client = new CodexImageClient({
    auth,
    enableGif: gifEnabled,
    multipartEdits: backend === 'openai-images-api-key',
    fetchImpl: (input, init) => {
      init?.signal?.throwIfAborted()
      assertCurrent()
      return fetchImpl(input, init)
    }
  })
  return {
    directStillGeneration: true,
    gifEnabled,
    approval: { backend, endpoint, profileId: id },
    assertCurrent,
    async generate(
      prompt: string,
      params: CodexImageOptions & { transparentBackground: boolean; signal: AbortSignal }
    ) {
      params.signal.throwIfAborted()
      assertCurrent()
      const result = await client.generate(prompt, params)
      params.signal.throwIfAborted()
      assertCurrent()
      return result
    },
    async edit(
      prompt: string,
      images: readonly string[],
      params: CodexImageOptions & { transparentBackground: boolean; signal: AbortSignal }
    ) {
      params.signal.throwIfAborted()
      assertCurrent()
      const result = await client.edit(prompt, images, params)
      params.signal.throwIfAborted()
      assertCurrent()
      return result
    }
  }
}
