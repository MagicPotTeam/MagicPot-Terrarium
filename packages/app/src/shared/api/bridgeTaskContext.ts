export type BridgeTaskApprovalStatus = 'pending' | 'approved' | 'rejected' | 'retry_requested'

export type BridgeTaskContext = {
  sessionId: string
  contextPackId?: string
  proposalId?: string
  approvalId?: string
  approvalStatus?: BridgeTaskApprovalStatus
  executionResultId?: string
}
