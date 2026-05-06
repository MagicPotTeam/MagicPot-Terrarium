import { CustomSkill } from '@shared/config/config'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ListCustomSkillsReq = {}
export type ListCustomSkillsResp = {
  skills: CustomSkill[]
  /** 分类列表（从文件夹结构推算或独立维护） */
  categories: string[]
}

export type SaveCustomSkillReq = {
  skill: CustomSkill
}
export type SaveCustomSkillResp = {}

export type DeleteCustomSkillReq = {
  id: string
}
export type DeleteCustomSkillResp = {}

/**
 * 批量保存（用于从 config.json 迁移时一次性写入）
 */
export type BatchSaveCustomSkillsReq = {
  skills: CustomSkill[]
  categories: string[]
}
export type BatchSaveCustomSkillsResp = {}

export type CustomSkillSvc = {
  listCustomSkills(req: ListCustomSkillsReq): Promise<ListCustomSkillsResp>
  saveCustomSkill(req: SaveCustomSkillReq): Promise<SaveCustomSkillResp>
  deleteCustomSkill(req: DeleteCustomSkillReq): Promise<DeleteCustomSkillResp>
  batchSaveCustomSkills(req: BatchSaveCustomSkillsReq): Promise<BatchSaveCustomSkillsResp>
}

export const customSkillSvcDef: ServiceDefSheet<CustomSkillSvc> = {
  listCustomSkills: { type: 'unary' },
  saveCustomSkill: { type: 'unary' },
  deleteCustomSkill: { type: 'unary' },
  batchSaveCustomSkills: { type: 'unary' }
}
