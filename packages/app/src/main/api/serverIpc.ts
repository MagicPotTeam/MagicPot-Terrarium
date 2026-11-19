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
import { FigPluginCenterSvcImpl } from './svcFigPluginCenterImpl'
import { AgentLocalFilesSvcImpl } from './svcAgentLocalFilesImpl'
import { LocalFileReadGrants } from '../agentLocalFiles/readGrants'
import { createDocumentUtilityExtractor } from '../agentLocalFiles/documents/documentUtilityProcess'
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
import { createInstalledCatalogReadDelegate } from '../magicAgentRuntime/installedCatalogReadBinding'
import { createStartupStorageReadDelegate } from '../storageMetadata/startupStorageReadBinding'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'
import { MANAGED_MEDIA_IMPORT_FILE_MAX_BYTES, ManagedMediaSvcImpl } from './svcManagedMediaImpl'
import { authorizeLocalMediaImportSourcePathAsync } from '../localMediaAccess'
import { getLocalMediaAllowedRoots } from '../localMediaAllowedRoots'
import { ReportBundlesSvcImpl } from './svcReportBundlesImpl'
import type { ManagedMediaCleanupScheduler } from '../llmProxy/managedMediaCleanupScheduler'
import { getChatMediaDir } from '../llmProxy/chatMediaDir'
import {
  DEFAULT_IMPORT_SOURCE_GUARD,
  importSourceRootKey,
  runImportSourceOperation
} from '../llmProxy/managedMediaStore'

export const createServer = (
  managedMediaCleanupScheduler?: ManagedMediaCleanupScheduler,
  getMainWindow: () => Electron.BrowserWindow | null = () => null
): Api => {
  const comfyBatch = new ComfyBatchSvcImpl()
  const resumeRecoveredJobs = (
    comfyBatch as ComfyBatchSvcImpl & { resumeRecoveredJobs?: () => Promise<void> }
  ).resumeRecoveredJobs
  if (typeof resumeRecoveredJobs === 'function') {
    void resumeRecoveredJobs.call(comfyBatch).catch((error) => {
      console.error('[serverIpc] Failed to resume recovered ComfyUI batch jobs:', error)
    })
  }

  const baseApi: BaseApi = {
    svcAdobeBridge: new AdobeBridgeSvcImpl(),
    svcState: new StateSvcImpl({ startupStorageRead: createStartupStorageReadDelegate(getMainWindow) }),
    svcHyper: new HyperSvcImpl(),
    svcComfy: new ComfySvcImpl(),
    svcComfyBatch: comfyBatch,
    svcQApp: new QAppSvcImpl(),
    svcTargetScheme: new TargetSchemeSvcImpl(),
    svcProjectTrace: new ProjectTraceSvcImpl(),
    svcCustomSkill: new CustomSkillSvcImpl(),
    svcPysssss: new PysssssSvcImpl(),
    svcCanvasThumbnail: new CanvasThumbnailSvcImpl(),
    svcDialog: new DialogSvcImpl(),
    svcFigma: new FigmaSvcImpl(),
    svcFigPluginCenter: new FigPluginCenterSvcImpl(undefined, getMainWindow),
    svcAgentLocalFiles: new AgentLocalFilesSvcImpl(
      new LocalFileReadGrants(createDocumentUtilityExtractor()),
      getMainWindow
    ),
    svcShell: new ShellSvcImpl(),
    svcPhotoshop: new PhotoshopSvcImpl(),
    svcLLMProxy: new LLMProxySvcImpl(),
    svcLog: new LogSvcImpl(),
    svcFs: new FsSvcImpl(),
    svcDccBridge: new DccBridgeSvcImpl(),
    svcDuplicateCheck: new DuplicateCheckSvcImpl(),
    svcAppUpdate: new AppUpdateSvcImpl(),
    svcMagicAgentPlatform: new MagicAgentPlatformSvcImpl({ installedCatalogRead: createInstalledCatalogReadDelegate(getMainWindow) }),
    svcManagedMedia: new ManagedMediaSvcImpl({
      // Renderer-supplied paths: application roots, persisted grants, and the one-use,
      // in-memory import grant of a file the user just picked or dropped in the chat.
      // Off the event loop (async realpath) and under the import-source deadline: the path
      // may sit on a stalled network mount.
      authorizeImportSourcePath: (sourcePath) =>
        runImportSourceOperation(
          () => authorizeLocalMediaImportSourcePathAsync(sourcePath, getLocalMediaAllowedRoots()),
          {
            key: importSourceRootKey(sourcePath),
            timeoutMs: DEFAULT_IMPORT_SOURCE_GUARD.operationTimeoutMs
          }
        ),
      maxImportFileBytes: MANAGED_MEDIA_IMPORT_FILE_MAX_BYTES,
      importSourceGuard: DEFAULT_IMPORT_SOURCE_GUARD,
      updateReferenceSnapshot: async (snapshot) => {
        const chatMediaRoot = await getChatMediaDir()
        managedMediaCleanupScheduler?.submitSnapshot({
          complete: snapshot.complete,
          chatMediaRoot,
          referencedMediaIds: snapshot.ids,
          referenceCounts: snapshot.referenceCounts
        })
      }
    }),
    svcReportBundles: new ReportBundlesSvcImpl({ getMainWindow })
  }

  return {
    ...baseApi,
    ...createApiExtensionServices({ baseApi, getMainWindow })
  }
}

export function initServerIpc(
  managedMediaCleanupScheduler?: ManagedMediaCleanupScheduler,
  getMainWindow: () => Electron.BrowserWindow | null = () => null
): void {
  const api: Api = createServer(managedMediaCleanupScheduler, getMainWindow)
  registerIpcServer(apiDef, api)
}
