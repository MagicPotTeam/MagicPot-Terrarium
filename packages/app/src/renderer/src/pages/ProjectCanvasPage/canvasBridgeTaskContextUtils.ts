import type { BridgeTaskContext } from '@shared/api/bridgeTaskContext'
import type {
  DesignInspectionApproval,
  DesignInspectionContextPack,
  DesignInspectionExecutionResult,
  DesignInspectionProposal
} from '@shared/designInspection'

type BuildDesignInspectionBridgeTaskContextOptions = {
  sessionId: string | null
  inspectionTargetItemIds: string[]
  exportItemIds: string[]
  contextPack: DesignInspectionContextPack | null
  proposal: DesignInspectionProposal | null
  approval: DesignInspectionApproval | null
  executionResult: DesignInspectionExecutionResult | null
}

export function buildDesignInspectionBridgeTaskContext({
  sessionId,
  inspectionTargetItemIds,
  exportItemIds,
  contextPack,
  proposal,
  approval,
  executionResult
}: BuildDesignInspectionBridgeTaskContextOptions): BridgeTaskContext | undefined {
  if (!sessionId || !contextPack || !proposal || !approval || exportItemIds.length === 0) {
    return undefined
  }

  const activeInspectionItemIds = new Set(
    inspectionTargetItemIds.length > 0 ? inspectionTargetItemIds : contextPack.selection.itemIds
  )

  if (activeInspectionItemIds.size === 0) return undefined

  if (!exportItemIds.every((itemId) => activeInspectionItemIds.has(itemId))) {
    return undefined
  }

  return {
    sessionId,
    contextPackId: contextPack.id,
    proposalId: proposal.id,
    approvalId: approval.id,
    approvalStatus: approval.status,
    executionResultId: executionResult?.id
  }
}
