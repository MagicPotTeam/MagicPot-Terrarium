export const MAGIC_AGENT_PLATFORM_ENV = 'MAGICPOT_MAGICAGENT_PLATFORM'

export function isMagicAgentPlatformEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(
    env[MAGIC_AGENT_PLATFORM_ENV] || env['VITE_MAGICPOT_MAGICAGENT_PLATFORM'] || ''
  )
    .trim()
    .toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

export function assertMagicAgentPlatformEnabled(): void {
  if (!isMagicAgentPlatformEnabled()) {
    throw new Error(`${MAGIC_AGENT_PLATFORM_ENV}=1 is required to use the MagicAgent platform API.`)
  }
}
