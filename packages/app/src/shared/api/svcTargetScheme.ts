import type { TargetScheme } from '@shared/targetScheme'
import type { TargetHistoryEntry } from '@shared/targetHistory'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ListTargetSchemesReq = {}
export type ListTargetSchemesResp = {
  schemes: TargetScheme[]
}

export type SaveTargetSchemeReq = {
  scheme: TargetScheme
}
export type SaveTargetSchemeResp = {}

export type DeleteTargetSchemeReq = {
  id: string
}
export type DeleteTargetSchemeResp = {}

export type ListTargetHistoryTargetsReq = {}
export type ListTargetHistoryTargetsResp = {
  targets: TargetHistoryEntry[]
}

export type SaveTargetHistoryTargetReq = {
  target: TargetHistoryEntry
}
export type SaveTargetHistoryTargetResp = {}

export type DeleteTargetHistoryTargetReq = {
  id: string
}
export type DeleteTargetHistoryTargetResp = {}

export type TargetSchemeSvc = {
  listTargetSchemes(req: ListTargetSchemesReq): Promise<ListTargetSchemesResp>
  saveTargetScheme(req: SaveTargetSchemeReq): Promise<SaveTargetSchemeResp>
  deleteTargetScheme(req: DeleteTargetSchemeReq): Promise<DeleteTargetSchemeResp>
  listTargetHistoryTargets(req: ListTargetHistoryTargetsReq): Promise<ListTargetHistoryTargetsResp>
  saveTargetHistoryTarget(req: SaveTargetHistoryTargetReq): Promise<SaveTargetHistoryTargetResp>
  deleteTargetHistoryTarget(
    req: DeleteTargetHistoryTargetReq
  ): Promise<DeleteTargetHistoryTargetResp>
}

export const targetSchemeSvcDef: ServiceDefSheet<TargetSchemeSvc> = {
  listTargetSchemes: { type: 'unary' },
  saveTargetScheme: { type: 'unary' },
  deleteTargetScheme: { type: 'unary' },
  listTargetHistoryTargets: { type: 'unary' },
  saveTargetHistoryTarget: { type: 'unary' },
  deleteTargetHistoryTarget: { type: 'unary' }
}
