import {
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  TextField,
  Typography
} from '@mui/material'
import type {
  DesignInspectionApproval,
  DesignInspectionContextPack,
  DesignInspectionExecutionResult,
  DesignInspectionProposal
} from '@shared/designInspection'
import type { DesignInspectionTraceRecord } from '../designInspectionTraceStorage'
import DesignInspectionTraceList from '../components/DesignInspectionTraceList'
import { summarizeDesignInspectionSelectionProvenance } from '../designInspectionProvenancePresentation'

type DesignInspectionReviewDialogProps = {
  open: boolean
  loading: boolean
  applying: boolean
  error: string | null
  contextPack: DesignInspectionContextPack | null
  proposal: DesignInspectionProposal | null
  approval: DesignInspectionApproval | null
  executionResult: DesignInspectionExecutionResult | null
  notes: string
  selectedActionIds: string[]
  recentTraces: DesignInspectionTraceRecord[]
  activeSessionId?: string | null
  onNotesChange: (value: string) => void
  onSelectedActionIdsChange: (value: string[]) => void
  onLoadTrace?: (trace: DesignInspectionTraceRecord) => void
  onDeleteTrace?: (trace: DesignInspectionTraceRecord) => void
  onClose: () => void
  onApprove: () => void
  onReject: () => void
  onRetry: () => void
}

function getApprovalChipColor(status?: DesignInspectionApproval['status']) {
  switch (status) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'default'
    case 'retry_requested':
      return 'warning'
    default:
      return 'info'
  }
}

function formatApprovalStatus(status?: DesignInspectionApproval['status']): string {
  switch (status) {
    case 'approved':
      return '已批准'
    case 'rejected':
      return '已拒绝'
    case 'retry_requested':
      return '已请求重试'
    default:
      return '待确认'
  }
}

function formatExecutionStatus(status: DesignInspectionExecutionResult['status']): string {
  switch (status) {
    case 'success':
      return '成功'
    case 'partial':
      return '部分完成'
    default:
      return '失败'
  }
}

function getApproveButtonLabel(
  actionCount: number,
  selectedActionCount: number,
  approval?: DesignInspectionApproval | null,
  executionResult?: DesignInspectionExecutionResult | null
): string {
  if (executionResult || approval?.status === 'approved') return '已执行'
  if (approval?.status === 'rejected') return '已拒绝'

  if (actionCount > 0 && selectedActionCount > 0) {
    return `批准 ${selectedActionCount} 项并执行`
  }

  return '确认无需变更'
}

export function DesignInspectionReviewDialog({
  open,
  loading,
  applying,
  error,
  contextPack,
  proposal,
  approval,
  executionResult,
  notes,
  selectedActionIds,
  recentTraces,
  activeSessionId,
  onNotesChange,
  onSelectedActionIdsChange,
  onLoadTrace,
  onDeleteTrace,
  onClose,
  onApprove,
  onReject,
  onRetry
}: DesignInspectionReviewDialogProps) {
  const actionCount = proposal?.actions.length || 0
  const selectedActionIdSet = new Set(selectedActionIds)
  const selectedActionCount = proposal
    ? proposal.actions.filter((action) => selectedActionIdSet.has(action.id)).length
    : 0
  const canMutateApproval = !!proposal && approval?.status === 'pending' && !executionResult
  const approveButtonLabel = getApproveButtonLabel(
    actionCount,
    selectedActionCount,
    approval,
    executionResult
  )
  const provenanceOverview = contextPack
    ? summarizeDesignInspectionSelectionProvenance(contextPack.selectionItems)
    : null

  const handleToggleAction = (actionId: string) => {
    if (!proposal) return

    const nextSelectedActionIds = new Set(selectedActionIds)
    if (nextSelectedActionIds.has(actionId)) {
      nextSelectedActionIds.delete(actionId)
    } else {
      nextSelectedActionIds.add(actionId)
    }

    onSelectedActionIdsChange(
      proposal.actions
        .map((action) => action.id)
        .filter((candidateId) => nextSelectedActionIds.has(candidateId))
    )
  }

  return (
    <Dialog open={open} onClose={loading || applying ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, fontSize: 18 }}>设计检查审阅</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {(loading || applying) && <LinearProgress />}
        {approval && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Chip
              size="small"
              color={getApprovalChipColor(approval.status)}
              label={`审批：${formatApprovalStatus(approval.status)}`}
            />
            {executionResult && (
              <Chip
                size="small"
                color={executionResult.status === 'success' ? 'success' : 'warning'}
                label={`执行：${formatExecutionStatus(executionResult.status)}`}
              />
            )}
          </Box>
        )}

        {contextPack && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              任务
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {contextPack.task}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              选区：{contextPack.selection.itemIds.length} 个元素，{contextPack.documents.length}{' '}
              份文档摘要，{contextPack.references.length} 个参考项
            </Typography>
          </Box>
        )}

        {provenanceOverview && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              来源上下文
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
              {provenanceOverview.kindLabels.map((label) => (
                <Chip key={label} size="small" variant="outlined" label={label} />
              ))}
            </Box>
            {provenanceOverview.detailLines.map((line) => (
              <Typography key={line} variant="caption" color="text.secondary">
                {line}
              </Typography>
            ))}
            {provenanceOverview.hiddenDetailCount > 0 && (
              <Typography variant="caption" color="text.secondary">
                还有 {provenanceOverview.hiddenDetailCount} 个来源项已折叠，可在历史记录中继续查看。
              </Typography>
            )}
          </Box>
        )}

        {recentTraces.length > 0 && (
          <DesignInspectionTraceList
            traces={recentTraces}
            activeSessionId={activeSessionId}
            disabled={loading || applying}
            onLoadTrace={onLoadTrace}
            onDeleteTrace={onDeleteTrace}
          />
        )}

        {proposal ? (
          <>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                方案摘要
              </Typography>
              <Typography variant="body2">{proposal.summary}</Typography>
              <Typography variant="body2" color="text.secondary">
                {proposal.rationale}
              </Typography>
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                发现的问题
              </Typography>
              {proposal.issues.length > 0 ? (
                proposal.issues.map((issue) => (
                  <Box
                    key={issue.id}
                    sx={{
                      p: 1.25,
                      borderRadius: 1.5,
                      border: '1px solid',
                      borderColor: 'divider',
                      bgcolor: 'background.default'
                    }}
                  >
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                      {issue.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {issue.summary}
                    </Typography>
                    {issue.evidence.length > 0 && (
                      <Typography variant="caption" color="text.secondary">
                        依据：{issue.evidence.join(' | ')}
                      </Typography>
                    )}
                  </Box>
                ))
              ) : (
                <Typography variant="body2" color="text.secondary">
                  当前选区没有检测到需要处理的结构化问题。
                </Typography>
              )}
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                计划动作
              </Typography>
              {proposal.actions.length > 0 ? (
                <>
                  <Typography variant="caption" color="text.secondary">
                    待审批动作：{selectedActionCount} / {proposal.actions.length}
                  </Typography>
                  {proposal.actions.map((action) => (
                    <Box
                      key={action.id}
                      sx={{
                        p: 1.25,
                        borderRadius: 1.5,
                        border: '1px solid',
                        borderColor: selectedActionIdSet.has(action.id)
                          ? 'primary.main'
                          : 'divider',
                        bgcolor: 'background.default',
                        display: 'flex',
                        gap: 1,
                        alignItems: 'flex-start'
                      }}
                    >
                      <Checkbox
                        checked={selectedActionIdSet.has(action.id)}
                        onChange={() => handleToggleAction(action.id)}
                        disabled={loading || applying || !canMutateApproval}
                        inputProps={{ 'aria-label': `选择动作 ${action.title}` }}
                        sx={{ mt: -0.5, ml: -0.5 }}
                      />
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>
                          {action.title}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {action.description}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          执行器：{action.executor} | 标的：{action.targetItemIds.join(', ')}
                        </Typography>
                      </Box>
                    </Box>
                  ))}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  当前没有可执行修改，你可以直接关闭，或确认无需变更。
                </Typography>
              )}
            </Box>

            <Typography variant="body2" color="text.secondary">
              预期结果：{proposal.expectedResult}
            </Typography>
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {loading ? '正在生成设计检查方案...' : '当前还没有可审阅的方案。'}
          </Typography>
        )}

        <TextField
          label="审阅备注"
          multiline
          minRows={2}
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder="可选，用于补充重试或审批说明。"
          disabled={loading || applying}
        />

        {executionResult && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              执行结果
            </Typography>
            <Typography variant="body2" color="text.secondary">
              已通过 {executionResult.executor} 应用 {executionResult.appliedChanges.length}{' '}
              项变更。
            </Typography>
            {executionResult.appliedChanges.map((change) => (
              <Typography
                key={`${change.itemId}-${change.field}`}
                variant="caption"
                color="text.secondary"
              >
                {change.description}
              </Typography>
            ))}
          </Box>
        )}

        {error && (
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading || applying}>
          关闭
        </Button>
        <Button onClick={onRetry} disabled={loading || applying || !contextPack}>
          重试
        </Button>
        <Button onClick={onReject} disabled={loading || applying || !canMutateApproval}>
          拒绝
        </Button>
        <Button
          onClick={onApprove}
          variant="contained"
          disabled={loading || applying || !canMutateApproval}
        >
          {approveButtonLabel}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default DesignInspectionReviewDialog
