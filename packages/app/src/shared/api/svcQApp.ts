import { Workflow } from '@shared/comfy/types'
import { QAppCfg } from '@shared/qApp/cfgTypes'
import type { QAppCategory } from '@shared/qApp/category'
import { QAppManifest } from '@shared/qApp/packageBundle'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ListQAppCfgsReq = {}
export type QAppMenuItem = {
  key: string
  name: string
  category?: QAppCategory
  isBuiltin: boolean
  isDirectory?: boolean
  children?: QAppMenuItem[]
  isHidden?: boolean // <--- 新增：用于前端控制显示/隐藏
  isRemote?: boolean // <--- 远程服务端的快应用（只读，不可删除/重命名）
  icon?: string // <--- 新增：自定义图标 base64，如果没配置则为空
  manifest?: QAppManifest
}
export type ListQAppCfgsResp = {
  qApps: QAppMenuItem[]
}

export type GetQAppCfgReq = {
  key: string
}
export type GetQAppCfgResp = {
  cfg: QAppCfg
  workflow: Workflow
  manifest?: QAppManifest
}

export type SaveQAppCfgReq = {
  key: string
  cfg: QAppCfg
  workflow: Workflow
  manifest?: Partial<QAppManifest>
}
export type SaveQAppCfgResp = {}

export type DeleteQAppCfgReq = {
  key: string
}
export type DeleteQAppCfgResp = {}

// 新增：为了匹配前端 deleteQApp 的调用
export type DeleteQAppReq = {
  key: string
}
export type DeleteQAppResp = {
  success: boolean
}

export type RenameQAppCfgReq = {
  /**
   * 原始 QApp 的 key
   */
  key: string
  /**
   * 新的 QApp 名称
   */
  name: string
}
export type RenameQAppCfgResp = {}

export type QAppSvc = {
  listQAppCfgs(req: ListQAppCfgsReq): Promise<ListQAppCfgsResp>
  getQAppCfg(req: GetQAppCfgReq): Promise<GetQAppCfgResp>
  saveQAppCfg(req: SaveQAppCfgReq): Promise<SaveQAppCfgResp>
  deleteQAppCfg(req: DeleteQAppCfgReq): Promise<DeleteQAppCfgResp>

  // 新增：删除接口
  deleteQApp(req: DeleteQAppReq): Promise<DeleteQAppResp>

  /**
   * 重命名 QApp
   *
   * 可以重命名目录或是 QApp
   * 只会重命名 key 的最后一段
   * @param req
   */
  renameQAppCfg(req: RenameQAppCfgReq): Promise<RenameQAppCfgResp>
}

export const qAppSvcDef: ServiceDefSheet<QAppSvc> = {
  listQAppCfgs: {
    type: 'unary'
  },
  getQAppCfg: {
    type: 'unary'
  },
  saveQAppCfg: {
    type: 'unary'
  },
  deleteQAppCfg: {
    type: 'unary'
  },
  deleteQApp: {
    // <--- 新增注册
    type: 'unary'
  },
  renameQAppCfg: {
    type: 'unary'
  }
}
