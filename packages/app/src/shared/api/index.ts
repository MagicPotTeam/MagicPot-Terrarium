import { ApiDefSheet } from './apiUtils/serviceDefSheet'
import { AdobeBridgeSvc, adobeBridgeSvcDef } from './svcAdobeBridge'
import { ComfySvc, comfySvcDef } from './svcComfy'
import { CanvasThumbnailSvc, canvasThumbnailSvcDef } from './svcCanvasThumbnail'
import { ProjectTraceSvc, projectTraceSvcDef } from './svcProjectTrace'
import { TargetSchemeSvc, targetSchemeSvcDef } from './svcTargetScheme'
import { CustomSkillSvc, customSkillSvcDef } from './svcCustomSkill'
import { DccBridgeSvc, dccBridgeSvcDef } from './svcDccBridge'
import { DialogSvc, dialogSvcDef } from './svcDialog'
import { DuplicateCheckSvc, duplicateCheckSvcDef } from './svcDuplicateCheck'
import { FigmaSvc, figmaSvcDef } from './svcFigma'
import { FsSvc, fsSvcDef } from './svcFs'
import { HyperSvc, hyperSvcDef } from './svcHyper'
import { LogSvc, logSvcDef } from './svcLog'
import { LLMProxySvc, llmProxySvcDef } from './svcLLMProxy'
import { PhotoshopSvc, photoshopSvcDef } from './svcPhotoshop'
import { PysssssSvc, pysssssSvcDef } from './svcPysssss'
import { QAppSvc, qAppSvcDef } from './svcQApp'
import { ShellSvc, shellSvcDef } from './svcShell'
import { StateSvc, stateSvcDef } from './svcState'
import { apiExtensionDef, type ApiExtensionServices } from './extensionServices'

export type BaseApi = {
  svcAdobeBridge: AdobeBridgeSvc
  svcState: StateSvc
  svcHyper: HyperSvc
  svcQApp: QAppSvc
  svcTargetScheme: TargetSchemeSvc
  svcCustomSkill: CustomSkillSvc
  svcComfy: ComfySvc
  svcCanvasThumbnail: CanvasThumbnailSvc
  svcProjectTrace: ProjectTraceSvc
  svcPysssss: PysssssSvc
  svcDialog: DialogSvc
  svcFigma: FigmaSvc
  svcShell: ShellSvc
  svcPhotoshop: PhotoshopSvc
  svcLLMProxy: LLMProxySvc
  svcLog: LogSvc
  svcFs: FsSvc
  svcDccBridge: DccBridgeSvc
  svcDuplicateCheck: DuplicateCheckSvc
}

export type Api = BaseApi & ApiExtensionServices

export const apiDef: ApiDefSheet<Api> = {
  svcAdobeBridge: adobeBridgeSvcDef,
  svcState: stateSvcDef,
  svcHyper: hyperSvcDef,
  svcQApp: qAppSvcDef,
  svcTargetScheme: targetSchemeSvcDef,
  svcCustomSkill: customSkillSvcDef,
  svcComfy: comfySvcDef,
  svcCanvasThumbnail: canvasThumbnailSvcDef,
  svcProjectTrace: projectTraceSvcDef,
  svcPysssss: pysssssSvcDef,
  svcDialog: dialogSvcDef,
  svcFigma: figmaSvcDef,
  svcShell: shellSvcDef,
  svcPhotoshop: photoshopSvcDef,
  svcLLMProxy: llmProxySvcDef,
  svcLog: logSvcDef,
  svcFs: fsSvcDef,
  svcDccBridge: dccBridgeSvcDef,
  svcDuplicateCheck: duplicateCheckSvcDef,
  ...apiExtensionDef
}
