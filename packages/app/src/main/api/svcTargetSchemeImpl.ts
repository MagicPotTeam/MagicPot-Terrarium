import type {
  DeleteTargetHistoryTargetReq,
  DeleteTargetHistoryTargetResp,
  TargetSchemeSvc,
  DeleteTargetSchemeReq,
  DeleteTargetSchemeResp,
  ListTargetHistoryTargetsReq,
  ListTargetHistoryTargetsResp,
  ListTargetSchemesReq,
  ListTargetSchemesResp,
  SaveTargetHistoryTargetReq,
  SaveTargetHistoryTargetResp,
  SaveTargetSchemeReq,
  SaveTargetSchemeResp
} from '@shared/api/svcTargetScheme'
import { TargetSchemeFSCli } from '../targetScheme/fs'

export class TargetSchemeSvcImpl implements TargetSchemeSvc {
  listTargetSchemes = async (_req: ListTargetSchemesReq): Promise<ListTargetSchemesResp> => {
    const cli = new TargetSchemeFSCli()
    const schemes = await cli.listSchemes()
    return { schemes }
  }

  saveTargetScheme = async (req: SaveTargetSchemeReq): Promise<SaveTargetSchemeResp> => {
    const cli = new TargetSchemeFSCli()
    await cli.saveScheme(req.scheme)
    return {}
  }

  deleteTargetScheme = async (req: DeleteTargetSchemeReq): Promise<DeleteTargetSchemeResp> => {
    const cli = new TargetSchemeFSCli()
    await cli.deleteScheme(req.id)
    return {}
  }

  listTargetHistoryTargets = async (
    _req: ListTargetHistoryTargetsReq
  ): Promise<ListTargetHistoryTargetsResp> => {
    const cli = new TargetSchemeFSCli()
    const targets = await cli.listHistoryTargets()
    return { targets }
  }

  saveTargetHistoryTarget = async (
    req: SaveTargetHistoryTargetReq
  ): Promise<SaveTargetHistoryTargetResp> => {
    const cli = new TargetSchemeFSCli()
    await cli.saveHistoryTarget(req.target)
    return {}
  }

  deleteTargetHistoryTarget = async (
    req: DeleteTargetHistoryTargetReq
  ): Promise<DeleteTargetHistoryTargetResp> => {
    const cli = new TargetSchemeFSCli()
    await cli.deleteHistoryTarget(req.id)
    return {}
  }
}
