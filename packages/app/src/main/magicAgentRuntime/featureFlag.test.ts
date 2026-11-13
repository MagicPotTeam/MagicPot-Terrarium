import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConfig } from '../config/config'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { getMagicAgentPlatformEnablement, isMagicAgentPlatformEnabled } from './featureFlag'

vi.mock('../config/config', () => ({ getConfig: vi.fn() }))

beforeEach(() => {
  vi.mocked(getConfig).mockReturnValue({
    ...DEFAULT_CONFIG,
    magic_agent_platform_config: { enabled: false }
  })
})
afterEach(() => vi.resetAllMocks())

describe('Agent Studio enablement', () => {
  it('keeps a fresh installation disabled until the desktop setting is enabled', () => {
    expect(getMagicAgentPlatformEnablement({})).toEqual({
      enabled: false,
      configuredEnabled: false
    })
    vi.mocked(getConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      magic_agent_platform_config: { enabled: true }
    })
    expect(getMagicAgentPlatformEnablement({})).toEqual({
      enabled: true,
      configuredEnabled: true
    })
  })

  it('preserves an explicit environment disable over a saved desktop opt-in', () => {
    vi.mocked(getConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      magic_agent_platform_config: { enabled: true }
    })
    expect(getMagicAgentPlatformEnablement({ MAGICPOT_MAGICAGENT_PLATFORM: '0' })).toEqual({
      enabled: false,
      configuredEnabled: true,
      environmentOverride: false
    })
  })

  it('supports the existing launch flags and gives the main-process flag precedence', () => {
    expect(isMagicAgentPlatformEnabled({ VITE_MAGICPOT_MAGICAGENT_PLATFORM: 'YES' })).toBe(true)
    expect(
      isMagicAgentPlatformEnabled({
        MAGICPOT_MAGICAGENT_PLATFORM: 'off',
        VITE_MAGICPOT_MAGICAGENT_PLATFORM: '1'
      })
    ).toBe(false)
  })

  it('ignores empty launch flags and fails closed for invalid non-empty values', () => {
    vi.mocked(getConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      magic_agent_platform_config: { enabled: true }
    })
    expect(getMagicAgentPlatformEnablement({ MAGICPOT_MAGICAGENT_PLATFORM: ' ' })).toEqual({
      enabled: true,
      configuredEnabled: true
    })
    expect(isMagicAgentPlatformEnabled({ MAGICPOT_MAGICAGENT_PLATFORM: 'unexpected' })).toBe(false)
  })

  it('can report disabled status before application configuration is initialized', () => {
    vi.mocked(getConfig).mockImplementation(() => {
      throw new Error('Config not initialized')
    })
    expect(isMagicAgentPlatformEnabled({})).toBe(false)
    expect(isMagicAgentPlatformEnabled({ MAGICPOT_MAGICAGENT_PLATFORM: '1' })).toBe(true)
  })
})
