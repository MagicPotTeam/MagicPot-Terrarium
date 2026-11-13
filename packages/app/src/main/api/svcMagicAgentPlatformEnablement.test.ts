import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { magicAgentPlatformSvcDef } from '@shared/api/svcMagicAgentPlatform'
import * as configuration from '../config/config'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/magicpot-test-user-data') } }))

let config: Config
const makeService = () =>
  new MagicAgentPlatformSvcImpl({
    adapter: { listTools: () => [], listAgents: () => [] } as never,
    graphRuntime: { list: () => [] } as never,
    packageStore: { list: async () => [], listAgents: async () => [] } as never
  })

const trustedInvocation = () => {
  registerMagicAgentTrustedRouteBinding(
    601,
    { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' },
    {
      trustedUrl: 'file:///app/index.html',
      trustedWebContents: { id: 601, isDestroyed: () => false }
    }
  )
  return {
    methodName: 'svcMagicAgentPlatform.setEnabled',
    senderId: 601,
    senderUrl: 'file:///app/index.html#/agent-studio',
    frameUrl: 'file:///app/index.html#/agent-studio',
    isMainFrame: true
  }
}

beforeEach(() => {
  vi.stubEnv('MAGICPOT_MAGICAGENT_PLATFORM', '')
  vi.stubEnv('VITE_MAGICPOT_MAGICAGENT_PLATFORM', '')
  config = { ...DEFAULT_CONFIG, magic_agent_platform_config: { enabled: false } }
  vi.spyOn(configuration, 'getConfig').mockImplementation(() => config)
  vi.spyOn(configuration, 'saveConfig').mockImplementation(async (patch) => {
    config = {
      ...config,
      magic_agent_platform_config: { enabled: patch.magic_agent_platform_config?.enabled === true }
    }
  })
})

afterEach(() => {
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Agent Studio desktop setting', () => {
  it('persists a trusted desktop opt-in and reads it from subsequent service instances', async () => {
    const invocation = trustedInvocation()
    await expect(makeService().getStatus({}, invocation)).resolves.toMatchObject({
      enabled: false,
      configuredEnabled: false
    })
    await expect(makeService().setEnabled({ enabled: true }, invocation)).resolves.toMatchObject({
      enabled: true,
      configuredEnabled: true
    })
    expect(configuration.saveConfig).toHaveBeenCalledWith({
      magic_agent_platform_config: { enabled: true }
    })
    await expect(makeService().getStatus({}, invocation)).resolves.toMatchObject({ enabled: true })
    await expect(makeService().setEnabled({ enabled: false }, invocation)).resolves.toMatchObject({
      enabled: false,
      configuredEnabled: false
    })
  })

  it('does not let the desktop setting override a launch-time disable', async () => {
    vi.stubEnv('MAGICPOT_MAGICAGENT_PLATFORM', '0')
    await expect(makeService().setEnabled({ enabled: true }, trustedInvocation())).rejects.toThrow(
      /environment override/
    )
    expect(configuration.saveConfig).not.toHaveBeenCalled()
  })

  it('rejects remote, missing, subframe, and unregistered senders without saving', async () => {
    const invocation = trustedInvocation()
    const service = makeService()
    await expect(service.setEnabled({ enabled: true })).rejects.toThrow(/trusted desktop/)
    for (const bad of [
      { ...invocation, isMainFrame: false },
      { ...invocation, senderId: 999 },
      { ...invocation, frameUrl: 'https://untrusted.example/' },
      {
        methodName: 'svcMagicAgentPlatform.setEnabled',
        authenticatedActor: { kind: 'user', id: 'remote' }
      }
    ]) {
      await expect(service.setEnabled({ enabled: true }, bad)).rejects.toThrow()
    }
    expect(configuration.saveConfig).not.toHaveBeenCalled()
  })

  it('validates the IPC request without accepting extra authority fields', () => {
    const validate = magicAgentPlatformSvcDef.setEnabled.request!
    if (typeof validate !== 'function')
      throw new Error('Expected the setEnabled function validator.')
    expect(validate({ enabled: true })).toEqual({ enabled: true })
    expect(() => validate({ enabled: 'true' })).toThrow()
    expect(() => validate({ enabled: true, trusted: true })).toThrow()
  })

  it('keeps the previous setting when persistence fails', async () => {
    vi.mocked(configuration.saveConfig).mockRejectedValueOnce(new Error('Disk write failed'))
    await expect(makeService().setEnabled({ enabled: true }, trustedInvocation())).rejects.toThrow(
      /Disk write failed/
    )
    expect(config.magic_agent_platform_config?.enabled).toBe(false)
  })
})
