import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { initConfig, saveConfig, getConfig } from '../config/config'
import { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { FigPluginBridgeController } from './bridgeController'
import type { FigPluginRuntimeDescriptor } from './centerStore'
import type { startFigPluginBridgeServer } from './bridgeServer'

const { fixtureRoot } = await vi.hoisted(async () => ({
  fixtureRoot: (await import('node:path'))
    .resolve('.magicpot-trash/bridge-configuration-memfs')
    .replaceAll('\\', '/')
}))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: fixtureRoot } }) }))
vi.mock('../config/portablePaths', () => ({
  resolvePortableStorageRootForUserDataSync: () => undefined
}))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
vi.mock('../extensions/generatedRegistry', () => ({ mainHostExtensionApiV1: { llmProxy: [] } }))
vi.mock('@shared/llm', async (original) => ({
  ...(await original<typeof import('@shared/llm')>()),
  cliFromProfile: vi.fn()
}))

type Runtime = Parameters<typeof startFigPluginBridgeServer>[0]['runtime']
const descriptor = (): FigPluginRuntimeDescriptor => ({
  pluginId: 'synthetic.figma',
  host: 'figma',
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  profileId: 'synthetic-model',
  limits: {
    maxPayloadBytes: 64 * 1024,
    maxResultBytes: 32 * 1024,
    maxConfigBytes: 1024,
    maxCallTimeoutMs: 30_000,
    maxConcurrentCalls: 1
  }
})
const controllers: FigPluginBridgeController[] = []

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in synthetic test')
    })
  )
  await fs.mkdir(fixtureRoot, { recursive: true })
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.llm_config.api_profiles = [
    {
      id: 'synthetic-model',
      model_name: 'gpt-4o',
      model_use: 'chat',
      provider: 'openai',
      base_url: 'https://synthetic.invalid/v1/chat/completions',
      api_key: 'synthetic-no-account'
    }
  ]
  await fs.writeFile(`${fixtureRoot}/config.json`, JSON.stringify(config), 'utf8')
  await initConfig()
})
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  vi.unstubAllGlobals()
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})

// Real config commits + real service HMAC revisions + controller + runtime. Only the
// signed-store descriptor, HTTP listener and provider client are fixtures; no native host.
describe('Bridge configuration commit integration', () => {
  it.each(['api_key', 'base_url', 'remote'] as const)(
    'cancels a running real service conversation on %s commit without polling or provider completion',
    async (field) => {
      const gate = Promise.withResolvers<string>()
      const entered = Promise.withResolvers<void>()
      const provider = vi.fn(() => {
        entered.resolve()
        return gate.promise
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat: provider } as never)
      const model = new LLMProxySvcImpl()
      const chat = vi.spyOn(model, 'chat')
      const cancel = vi.spyOn(model, 'cancelConversation')
      let runtime!: Runtime
      const controller = new FigPluginBridgeController(
        {
          getRuntimeDescriptor: async () => descriptor(),
          onRuntimeInvalidated: () => () => {}
        },
        model,
        {
          startServer: async ({ origin, runtime: value }) => {
            runtime = value
            return { origin, close: async () => {} }
          }
        }
      )
      controllers.push(controller)
      const binding = await controller.resolveBinding(
        { pluginId: 'synthetic.figma', expectedGeneration: 1 },
        'synthetic-project'
      )
      const ticket = await controller.createPairing(binding)
      const session = await runtime.redeem({
        protocol: 1,
        ticketId: ticket.ticketId,
        pairingSecret: ticket.pairingSecret,
        pluginId: ticket.pluginId,
        host: ticket.host,
        artifactSha256: ticket.artifactSha256,
        clientNonce: 'e'.repeat(32)
      })
      const prepared = await runtime.prepare(session.sessionId, session.sessionToken, {
        protocol: 1,
        requestId: 'synthetic-request',
        sequence: 1,
        prompt: 'Describe selection.',
        context: {
          nodes: [{ id: '1:2', type: 'FRAME', name: 'Synthetic', locked: false }],
          selectionRevision: 'synthetic-selection'
        }
      })
      expect(provider).not.toHaveBeenCalled()
      await controller.approve(prepared.callId, controller.desktopState().previews[0].payloadSha256)
      await entered.promise
      const [input, options] = chat.mock.calls[0]
      expect(options?.signal?.aborted).toBe(false)

      // An unrelated config save must not revoke an already approved current revision.
      await saveConfig({ download_dir: `${fixtureRoot}/synthetic-projects` })
      expect(cancel).not.toHaveBeenCalled()
      expect(options?.signal?.aborted).toBe(false)
      const profiles = structuredClone(getConfig().llm_config.api_profiles)
      if (field === 'remote') await saveConfig({ use_remote_llm: true })
      else {
        profiles[0][field] =
          field === 'base_url' ? 'https://changed.invalid' : 'changed-synthetic-key'
        await saveConfig({ llm_config: { api_profiles: profiles } })
      }
      // Config save itself must synchronously notify revocation; no status call/clock advance.
      expect(options?.signal?.aborted).toBe(true)
      expect(cancel).toHaveBeenCalledExactlyOnceWith({ conversationId: input.conversationId })
      expect(controller.desktopState()).toEqual({ sessions: [], previews: [] })
      expect(model.isProfileRevisionCurrent(binding.profileId, binding.profileRevision)).toBe(false)
      expect(provider).toHaveBeenCalledTimes(1)
      gate.resolve('Late obsolete synthetic content')
      await expect(chat.mock.results[0].value).rejects.toMatchObject({ name: 'AbortError' })
      await expect(
        runtime.status(session.sessionId, session.sessionToken, prepared.callId)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(fetch).not.toHaveBeenCalled()
    }
  )
})
