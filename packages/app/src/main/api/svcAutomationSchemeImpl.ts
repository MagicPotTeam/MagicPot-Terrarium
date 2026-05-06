import type {
  AutomationSchemeSvc,
  DeleteAutomationSchemeReq,
  DeleteAutomationSchemeResp,
  ListAutomationSchemesReq,
  ListAutomationSchemesResp,
  SaveAutomationSchemeReq,
  SaveAutomationSchemeResp
} from '@shared/api/svcAutomationScheme'
import { AutomationSchemeFSCli } from '../automationScheme/fs'

export class AutomationSchemeSvcImpl implements AutomationSchemeSvc {
  listAutomationSchemes = async (
    _req: ListAutomationSchemesReq
  ): Promise<ListAutomationSchemesResp> => {
    const cli = new AutomationSchemeFSCli()
    const schemes = await cli.listSchemes()
    return { schemes }
  }

  saveAutomationScheme = async (
    req: SaveAutomationSchemeReq
  ): Promise<SaveAutomationSchemeResp> => {
    const cli = new AutomationSchemeFSCli()
    await cli.saveScheme(req.scheme)
    return {}
  }

  deleteAutomationScheme = async (
    req: DeleteAutomationSchemeReq
  ): Promise<DeleteAutomationSchemeResp> => {
    const cli = new AutomationSchemeFSCli()
    await cli.deleteScheme(req.id)
    return {}
  }
}
