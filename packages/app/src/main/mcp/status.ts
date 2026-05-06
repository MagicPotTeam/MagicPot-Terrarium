import { type GetMcpStatusResp } from '@shared/api/svcState'
import { type Config } from '@shared/config/config'
import { getMagicPotMcpPlatformStatus } from './platform/runtime'
import { type McpClientManager } from './clientManager'
import { getMcpClientManager, syncMcpClientManager } from './runtime'

export const getMcpRuntimeStatus = async (
  config: Config,
  clientManager: Pick<McpClientManager, 'listConnections' | 'sync'> = getMcpClientManager()
): Promise<GetMcpStatusResp> => {
  if (clientManager === getMcpClientManager()) {
    await syncMcpClientManager(config)
  } else {
    await clientManager.sync(config)
  }

  const connections = clientManager.listConnections()
  const serverConfig = config.mcp_config?.server
  const authToken = String(
    serverConfig?.auth_token || config.chat_config?.webhook_secret || ''
  ).trim()
  const platformStatus = getMagicPotMcpPlatformStatus()

  return {
    client: {
      connections,
      discoveredToolCount: connections.reduce((sum, connection) => sum + connection.toolCount, 0)
    },
    server: {
      enabled: serverConfig?.enabled ?? true,
      path: String(serverConfig?.path || '/api/mcp').trim() || '/api/mcp',
      exposeResources: serverConfig?.expose_resources ?? true,
      authRequired: Boolean(authToken)
    },
    platform: {
      state: platformStatus.health.state,
      version: platformStatus.health.version,
      transportCount: platformStatus.health.transports.length,
      transports: platformStatus.health.transports,
      auditEntryCount: platformStatus.auditEntryCount,
      counts: platformStatus.health.counts
    }
  }
}
