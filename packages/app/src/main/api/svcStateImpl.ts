import {
  StateSvc,
  GetConfigReq,
  GetConfigResp,
  SaveConfigReq,
  SaveConfigResp,
  GetBuildEnvReq,
  GetBuildEnvResp,
  GetUserDataDirectoryStateReq,
  GetUserDataDirectoryStateResp,
  SetUserDataDirectoryReq,
  SetUserDataDirectoryResp,
  GetStorageLocationsReq,
  GetStorageLocationsResp,
  WatchConfigReq,
  WatchConfigResp,
  GetMcpStatusReq,
  GetMcpStatusResp,
  GetLlmProxyAccessUsageReq,
  GetLlmProxyAccessUsageResp
} from '@shared/api/svcState'
import { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig, listenConfig, saveConfig } from '../config/config'
import { getStorageLocations } from '../config/storageLocations'
import {
  beginUserDataDirectoryChange,
  getCurrentUserDataDirectoryState
} from '../config/userDataDirectory'
import { getMcpRuntimeStatus } from '../mcp/status'
import { getLlmProxyAccessUsageSnapshot } from '../llmProxy/accessUsage'
import { getLLMProxyServerStatus } from '../llmProxy/server'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export class StateSvcImpl implements StateSvc {
  async getConfig(_req: GetConfigReq): Promise<GetConfigResp> {
    return { config: getConfig() }
  }

  async watchConfig(_req: WatchConfigReq, resp: ServerStreaming<WatchConfigResp>): Promise<void> {
    resp.onData({ config: getConfig() })
    return new Promise((resolve) => {
      listenConfig({
        id: crypto.randomUUID(),
        abortReceiver: resp.abortReceiver,
        onEvent: async (config) => {
          resp.onData({ config })
        },
        onEnd: async () => {
          resolve()
        }
      })
    })
  }

  async saveConfig(req: SaveConfigReq): Promise<SaveConfigResp> {
    await saveConfig(req.config)
    return {}
  }

  async getBuildEnv(_req: GetBuildEnvReq): Promise<GetBuildEnvResp> {
    return { buildEnv: getBuildEnv() }
  }

  async getUserDataDirectoryState(
    _req: GetUserDataDirectoryStateReq
  ): Promise<GetUserDataDirectoryStateResp> {
    return { state: getCurrentUserDataDirectoryState() }
  }

  async setUserDataDirectory(req: SetUserDataDirectoryReq): Promise<SetUserDataDirectoryResp> {
    const currentConfig = getConfig()
    const currentDirectoryState = getCurrentUserDataDirectoryState()
    const configuredProjectRoot = currentConfig.download_dir?.trim()
    const projectsFrom = configuredProjectRoot || currentDirectoryState.projectRoot
    const autoSaveCandidates = [
      path.join(projectsFrom, '.AutoSave'),
      path.join(projectsFrom, 'AutoSave'),
      path.join(currentDirectoryState.storageRoot, '.AutoSave'),
      path.join(currentDirectoryState.storageRoot, 'AutoSave')
    ].filter((candidate) => fs.existsSync(candidate))
    const prepared = await beginUserDataDirectoryChange(
      req.path,
      currentDirectoryState.currentPath,
      {
        projectsFrom,
        autoSaveFromCandidates: autoSaveCandidates
      }
    )
    if (!prepared.changed) return { restartRequired: false }

    try {
      // Publish the storage-root bootstrap as the only switch transaction. On the next launch,
      // the unified Data config is normalized to the sibling Projects directory. Writing the old
      // root's config here would create an unrecoverable split-root window if the process crashed
      // before the bootstrap commit.
      await prepared.commit()
    } catch (error) {
      await prepared.rollback()
      throw error
    }

    setTimeout(() => {
      app.relaunch()
      app.quit()
    }, 500)
    return { restartRequired: true }
  }

  async getStorageLocations(_req: GetStorageLocationsReq): Promise<GetStorageLocationsResp> {
    return { locations: await getStorageLocations() }
  }

  async getLlmProxyAccessUsage(
    _req: GetLlmProxyAccessUsageReq
  ): Promise<GetLlmProxyAccessUsageResp> {
    const serverStatus = getLLMProxyServerStatus()
    return {
      running: serverStatus.running,
      port: serverStatus.port,
      usage: getLlmProxyAccessUsageSnapshot()
    }
  }

  async getMcpStatus(_req: GetMcpStatusReq): Promise<GetMcpStatusResp> {
    return getMcpRuntimeStatus(getConfig())
  }
}
