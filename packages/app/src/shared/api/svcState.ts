import { BuildEnv } from '@shared/config/buildEnv'
import { Config, McpExternalServerTransport } from '../config/config'
import type { McpTransportSnapshot } from '@shared/agent/mcpPlatform'
import { ServerStreaming } from './apiUtils/streaming'
import { DeepPartial } from '@shared/utils/utilTypes'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type GetConfigReq = {}
export type GetConfigResp = {
  config: Config
}

export type WatchConfigReq = {}
export type WatchConfigResp = {
  config: Config
}

export type SaveConfigReq = {
  config: DeepPartial<Config>
}
export type SaveConfigResp = {}

export type GetBuildEnvReq = {}
export type GetBuildEnvResp = {
  buildEnv: BuildEnv
}

export type UserDataDirectorySource = 'default' | 'persisted' | 'env'

export type UserDataDirectoryState = {
  /** Internal app data directory. Kept for API compatibility. */
  currentPath: string
  /** Default internal app data directory. Kept for API compatibility. */
  defaultPath: string
  isCustom: boolean
  source: UserDataDirectorySource
  storageRoot: string
  defaultStorageRoot: string
  projectRoot: string
  autoSaveRoot: string
  legacyLayout: boolean
}

export type GetUserDataDirectoryStateReq = {}
export type GetUserDataDirectoryStateResp = {
  state: UserDataDirectoryState
}

export type SetUserDataDirectoryReq = {
  /** Global storage root. The app derives Data, Projects, and AutoSave beneath it. */
  path: string | null
}
export type SetUserDataDirectoryResp = {
  restartRequired: boolean
}

export type StorageLocationKind =
  | 'current-development'
  | 'current-production'
  | 'current-override'
  | 'default-development'
  | 'default-production'
  | 'legacy-app-root'
  | 'standard-installed'

export type StorageLocationSnapshot = {
  id: string
  kind: StorageLocationKind
  isCurrent: boolean
  userDataDir: string
  fileRootDir: string
  configPath: string
  qAppDir: string
  customSkillDir: string
  targetSchemeDir: string
  configExists: boolean
  qAppsExists: boolean
  customSkillsExists: boolean
  targetSchemesExists: boolean
}

export type GetStorageLocationsReq = {}
export type GetStorageLocationsResp = {
  locations: StorageLocationSnapshot[]
}

export type LlmProxyAccessUsageSnapshot = {
  tokenId: string
  label?: string
  resourceScope?: string
  requestCount: number
  statusRequestCount: number
  profileListRequestCount: number
  chatRequestCount: number
  openAiRequestCount: number
  quickAppListRequestCount: number
  quickAppGetRequestCount: number
  mediaDownloadCount: number
  generatedMediaCount: number
  generatedMediaBytes: number
  storedMediaCount: number
  storedMediaBytes: number
  lastSeenAt?: number
  lastRequesterAddress?: string
  lastProfileId?: string
  lastActivity?: string
}

export type GetLlmProxyAccessUsageReq = {}
export type GetLlmProxyAccessUsageResp = {
  running: boolean
  port?: number
  usage: LlmProxyAccessUsageSnapshot[]
}

export type McpClientConnectionStatus = 'connecting' | 'connected' | 'error'

export type McpClientConnectionSnapshot = {
  id: string
  aliasPrefix: string
  status: McpClientConnectionStatus
  toolCount: number
  toolAliases: string[]
  transport: McpExternalServerTransport
  lastError?: string
}

export type GetMcpStatusReq = {}
export type GetMcpStatusResp = {
  client: {
    connections: McpClientConnectionSnapshot[]
    discoveredToolCount: number
  }
  server: {
    enabled: boolean
    path: string
    exposeResources: boolean
    authRequired: boolean
  }
  platform?: {
    state: string
    version: string
    transportCount: number
    transports?: McpTransportSnapshot[]
    auditEntryCount: number
    counts: {
      sources: number
      sessions: number
      tools: number
      resources: number
      prompts: number
    }
  }
}

/**
 * 全局状态服务
 */
export type StateSvc = {
  /**
   * 获取配置
   */
  getConfig(req: GetConfigReq): Promise<GetConfigResp>
  /**
   * 监听配置
   */
  watchConfig(req: WatchConfigReq, resp: ServerStreaming<WatchConfigResp>): Promise<void>
  /**
   * 保存配置
   */
  saveConfig(req: SaveConfigReq): Promise<SaveConfigResp>
  /**
   * 获取构建环境参数
   */
  getBuildEnv(req: GetBuildEnvReq): Promise<GetBuildEnvResp>
  getUserDataDirectoryState(
    req: GetUserDataDirectoryStateReq
  ): Promise<GetUserDataDirectoryStateResp>
  setUserDataDirectory(req: SetUserDataDirectoryReq): Promise<SetUserDataDirectoryResp>
  getStorageLocations(req: GetStorageLocationsReq): Promise<GetStorageLocationsResp>
  getLlmProxyAccessUsage(req: GetLlmProxyAccessUsageReq): Promise<GetLlmProxyAccessUsageResp>
  /**
   * 获取 MCP 客户端连接状态和本地 MCP 服务端概况
   */
  getMcpStatus(req: GetMcpStatusReq): Promise<GetMcpStatusResp>
}

export const stateSvcDef: ServiceDefSheet<StateSvc> = {
  getConfig: {
    type: 'unary'
  },
  watchConfig: {
    type: 'serverStreaming'
  },
  saveConfig: {
    type: 'unary'
  },
  getBuildEnv: {
    type: 'unary'
  },
  getUserDataDirectoryState: {
    type: 'unary'
  },
  setUserDataDirectory: {
    type: 'unary'
  },
  getStorageLocations: {
    type: 'unary'
  },
  getLlmProxyAccessUsage: {
    type: 'unary'
  },
  getMcpStatus: {
    type: 'unary'
  }
}
