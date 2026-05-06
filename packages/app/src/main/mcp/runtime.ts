import { Config } from '@shared/config/config'
import { getConfig } from '../config/config'
import { McpClientManager } from './clientManager'

let mcpClientManagerSingleton: McpClientManager | null = null

export const getMcpClientManager = (): McpClientManager => {
  if (!mcpClientManagerSingleton) {
    mcpClientManagerSingleton = new McpClientManager()
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
