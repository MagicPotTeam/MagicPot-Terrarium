import type { AutomationScheme } from '@shared/automationScheme'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ListAutomationSchemesReq = {}
export type ListAutomationSchemesResp = {
  schemes: AutomationScheme[]
}

export type SaveAutomationSchemeReq = {
  scheme: AutomationScheme
}
export type SaveAutomationSchemeResp = {}

export type DeleteAutomationSchemeReq = {
  id: string
}
export type DeleteAutomationSchemeResp = {}

export type AutomationSchemeSvc = {
  listAutomationSchemes(req: ListAutomationSchemesReq): Promise<ListAutomationSchemesResp>
  saveAutomationScheme(req: SaveAutomationSchemeReq): Promise<SaveAutomationSchemeResp>
  deleteAutomationScheme(req: DeleteAutomationSchemeReq): Promise<DeleteAutomationSchemeResp>
}

export const automationSchemeSvcDef: ServiceDefSheet<AutomationSchemeSvc> = {
  listAutomationSchemes: { type: 'unary' },
  saveAutomationScheme: { type: 'unary' },
  deleteAutomationScheme: { type: 'unary' }
}
