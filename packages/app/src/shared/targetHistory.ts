export type TargetHistoryStage = {
  profileId: string
  responsibilityType?: string
  mustFollow: string
  forbiddenActions: string
  allowedInputs: string[]
  outputFormats: string[]
}

export type TargetHistoryQuickApp = {
  qAppKey: string
  mustFollow: string
  forbiddenActions: string
}

export type TargetHistoryEntry = {
  id: string
  name: string
  schemeId: string
  controlProfileId: string
  evidenceMode?: 'structured_only' | 'selection_region' | 'selected_sources'
  userIntent: string
  stageProfiles: TargetHistoryStage[]
  quickApps?: TargetHistoryQuickApp[]
  traceReferenceIds?: string[]
  createdAt: string
  updatedAt: string
  lastRunAt: string
}
