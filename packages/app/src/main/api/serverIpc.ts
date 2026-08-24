import { Api, BaseApi, apiDef } from '@shared/api'
import { AdobeBridgeSvcImpl } from './svcAdobeBridgeImpl'
import { StateSvcImpl } from './svcStateImpl'
import { ComfySvcImpl } from './svcComfyImpl'
import { ComfyBatchSvcImpl } from './svcComfyBatchImpl'
import { CanvasThumbnailSvcImpl } from './svcCanvasThumbnailImpl'
import { ProjectTraceSvcImpl } from './svcProjectTraceImpl'
import { TargetSchemeSvcImpl } from './svcTargetSchemeImpl'
import { CustomSkillSvcImpl } from './svcCustomSkillImpl'
import { DialogSvcImpl } from './svcDialogImpl'
import { FigmaSvcImpl } from './svcFigmaImpl'
import { ShellSvcImpl } from './svcShellImpl'
import { QAppSvcImpl } from './svcQAppImpl'
import { HyperSvcImpl } from './svcHyperImpl'
import { PysssssSvcImpl } from './svcPysssssImpl'
import { PhotoshopSvcImpl } from './svcPhotoshopImpl'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { LogSvcImpl } from './svcLogImpl'
import { FsSvcImpl } from './svcFsImpl'
import { DccBridgeSvcImpl } from './svcDccBridgeImpl'
import { DuplicateCheckSvcImpl } from './svcDuplicateCheckImpl'
import { registerIpcServer } from '@shared/api/createServer/registerIpcServer'
import { createApiExtensionServices } from './extensionServices'
import { AppUpdateSvcImpl } from './svcAppUpdateImpl'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'
import { ManagedMediaSvcImpl } from './svcManagedMediaImpl'
import type { ManagedMediaCleanupScheduler } from '../llmProxy/managedMediaCleanupScheduler'
import { getChatMediaDir } from '../llmProxy/chatMediaDir'

export const createServer = (managedMediaCleanupScheduler?: ManagedMediaCleanupScheduler): Api => {
  const baseApi: BaseApi = {
    svcAdobeBridge: new AdobeBridgeSvcImpl(),
    svcState: new StateSvcImpl(),
    svcHyper: new HyperSvcImpl(),
    svcComfy: new ComfySvcImpl(),
    svcComfyBatch: new ComfyBatchSvcImpl(),
    svcQApp: new QAppSvcImpl(),
    svcTargetScheme: new TargetSchemeSvcImpl(),
    svcProjectTrace: new ProjectTraceSvcImpl(),
    svcCustomSkill: new CustomSkillSvcImpl(),
    svcPysssss: new PysssssSvcImpl(),
    svcCanvasThumbnail: new CanvasThumbnailSvcImpl(),
    svcDialog: new DialogSvcImpl(),
    svcFigma: new FigmaSvcImpl(),
    svcShell: new ShellSvcImpl(),
    svcPhotoshop: new PhotoshopSvcImpl(),
    svcLLMProxy: new LLMProxySvcImpl(),
    svcLog: new LogSvcImpl(),
    svcFs: new FsSvcImpl(),
    svcDccBridge: new DccBridgeSvcImpl(),
    svcDuplicateCheck: new DuplicateCheckSvcImpl(),
    svcAppUpdate: new AppUpdateSvcImpl(),
    svcMagicAgentPlatform: new MagicAgentPlatformSvcImpl(),
    svcManagedMedia: new ManagedMediaSvcImpl({
      updateReferenceSnapshot: async (snapshot) => {
        const chatMediaRoot = await getChatMediaDir()
        managedMediaCleanupScheduler?.submitSnapshot({
          complete: snapshot.complete,
          chatMediaRoot,
          referencedMediaIds: snapshot.ids
        })
      }
    })
  }

  return {
    ...baseApi,
    ...createApiExtensionServices({ baseApi })
  }
}

export function initServerIpc(managedMediaCleanupScheduler?: ManagedMediaCleanupScheduler): void {
  const api: Api = createServer(managedMediaCleanupScheduler)
  registerIpcServer(apiDef, api)
}
