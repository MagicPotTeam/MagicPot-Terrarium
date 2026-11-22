import { getConfig } from '../config/config'

export const MAGIC_AGENT_PLATFORM_ENV = 'MAGICPOT_MAGICAGENT_PLATFORM'

export type MagicAgentPlatformEnablement = {
  enabled: boolean
  configuredEnabled: boolean
  environmentOverride?: boolean
}

export function getMagicAgentPlatformEnablement(
  env: NodeJS.ProcessEnv = process.env
): MagicAgentPlatformEnablement {
  let configuredEnabled = false
  try {
    configuredEnabled = getConfig().magic_agent_platform_config?.enabled === true
  } catch {
    // Startup and diagnostics may query this before the persisted config is loaded.
  }

  const primary = String(env[MAGIC_AGENT_PLATFORM_ENV] ?? '').trim()
  const fallback = String(env['VITE_MAGICPOT_MAGICAGENT_PLATFORM'] ?? '').trim()
  const value = (primary || fallback).toLowerCase()
  if (value) {
    const environmentOverride =
      value === '1' || value === 'true' || value === 'yes' || value === 'on'
    return { enabled: environmentOverride, configuredEnabled, environmentOverride }
  }
  return { enabled: configuredEnabled, configuredEnabled }
}

export function isMagicAgentPlatformEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getMagicAgentPlatformEnablement(env).enabled
}

export function assertMagicAgentPlatformEnabled(): void {
  if (!isMagicAgentPlatformEnabled()) {
    throw new Error(
      'Enable Agent Studio in the desktop panel, or set MAGICPOT_MAGICAGENT_PLATFORM=1.'
    )
  }
}
