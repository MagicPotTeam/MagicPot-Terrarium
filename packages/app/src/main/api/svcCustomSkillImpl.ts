import {
  ListCustomSkillsReq,
  ListCustomSkillsResp,
  SaveCustomSkillReq,
  SaveCustomSkillResp,
  DeleteCustomSkillReq,
  DeleteCustomSkillResp,
  BatchSaveCustomSkillsReq,
  BatchSaveCustomSkillsResp,
  CustomSkillSvc
} from '@shared/api/svcCustomSkill'
import { CustomSkillFSCli } from '../customSkill/fs'

export class CustomSkillSvcImpl implements CustomSkillSvc {
  listCustomSkills = async (_req: ListCustomSkillsReq): Promise<ListCustomSkillsResp> => {
    const cli = new CustomSkillFSCli()
    const { skills, categories } = await cli.listSkills()
    return { skills, categories }
  }

  saveCustomSkill = async (req: SaveCustomSkillReq): Promise<SaveCustomSkillResp> => {
    const cli = new CustomSkillFSCli()
    await cli.saveSkill(req.skill)
    return {}
  }

  deleteCustomSkill = async (req: DeleteCustomSkillReq): Promise<DeleteCustomSkillResp> => {
    const cli = new CustomSkillFSCli()
    await cli.deleteSkill(req.id)
    return {}
  }

  batchSaveCustomSkills = async (
    req: BatchSaveCustomSkillsReq
  ): Promise<BatchSaveCustomSkillsResp> => {
    const cli = new CustomSkillFSCli()
    await cli.batchSave(req.skills, req.categories)
    return {}
  }
}
