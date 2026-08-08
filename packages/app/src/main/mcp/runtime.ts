import { Config } from '@shared/config/config'
import { getConfig } from '../config/config'
import { McpClientManager } from './clientManager'
import { appendMagicPotMcpAudit, authorizeMagicPotMcpToolInvocation } from './platform/runtime'

let mcpClientManagerSingleton: McpClientManager | null = null

export const getMcpClientManager = (): McpClientManager => {
  if (!mcpClientManagerSingleton) {
    mcpClientManagerSingleton = new McpClientManager({
      authorize: ({ alias, serverId }) =>
        authorizeMagicPotMcpToolInvocation({
          actor: 'magicpot:mcp-client',
          action: 'tool.invoke',
          target: alias,
          metadata: { serverId }
        }),
      audit: ({ alias, serverId, decision, reason }) =>
        appendMagicPotMcpAudit({
          actor: 'magicpot:mcp-client',
          action: 'tool.invoke',
          target: alias,
          decision,
          reason,
          metadata: { serverId }
        })
    })
  }
  return mcpClientManagerSingleton
}

export const syncMcpClientManager = async (config: Config = getConfig()): Promise<void> => {
  await getMcpClientManager().sync(config)
}

export const stopMcpClientManager = async (): Promise<void> => {
  if (!mcpClientManagerSingleton) return
  await mcpClientManagerSingleton.stop()
}
