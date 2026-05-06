import {
  DeleteQAppCfgReq,
  DeleteQAppCfgResp,
  DeleteQAppReq,
  DeleteQAppResp,
  GetQAppCfgReq,
  GetQAppCfgResp,
  ListQAppCfgsReq,
  ListQAppCfgsResp,
  QAppSvc,
  SaveQAppCfgReq,
  SaveQAppCfgResp,
  RenameQAppCfgReq,
  RenameQAppCfgResp
} from '@shared/api/svcQApp'
import { QAppFSCli } from '../qApp/fs'

export class QAppSvcImpl implements QAppSvc {
  listQAppCfgs = async (req: ListQAppCfgsReq): Promise<ListQAppCfgsResp> => {
    const qAppFSCli = new QAppFSCli()
    const qAppItems = await qAppFSCli.listQAppKeys()

    return {
      qApps: qAppItems
    }
  }
  getQAppCfg = async (req: GetQAppCfgReq): Promise<GetQAppCfgResp> => {
    const qAppFSCli = new QAppFSCli()
    const { cfg, workflow, manifest } = await qAppFSCli.getQApp(req.key)
    return {
      cfg,
      workflow,
      manifest
    }
  }
  saveQAppCfg = async (req: SaveQAppCfgReq): Promise<SaveQAppCfgResp> => {
    const qAppFSCli = new QAppFSCli()
    await qAppFSCli.saveQApp(req.key, req.cfg, req.workflow, req.manifest)
    return {}
  }
  deleteQAppCfg = async (req: DeleteQAppCfgReq): Promise<DeleteQAppCfgResp> => {
    const qAppFSCli = new QAppFSCli()
    await qAppFSCli.deleteQApp(req.key)
    return {}
  }
  // 新增：实现前端调用的 deleteQApp
  deleteQApp = async (req: DeleteQAppReq): Promise<DeleteQAppResp> => {
    const qAppFSCli = new QAppFSCli()
    await qAppFSCli.deleteQApp(req.key)
    return { success: true }
  }
  renameQAppCfg = async (req: RenameQAppCfgReq): Promise<RenameQAppCfgResp> => {
    const qAppFSCli = new QAppFSCli()
    await qAppFSCli.renameQApp(req.key, req.name)
    return {}
  }
}
