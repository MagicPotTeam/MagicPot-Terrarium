import { Box, Button, Chip, Typography } from '@mui/material'
import type { DesignInspectionTraceRecord } from '../designInspectionTraceStorage'
import { summarizeDesignInspectionSelectionProvenance } from '../designInspectionProvenancePresentation'

type DesignInspectionTraceListProps = {
  traces: DesignInspectionTraceRecord[]
  activeSessionId?: string | null
  title?: string
  maxItems?: number
  disabled?: boolean
  emptyState?: string
  loadButtonLabel?: string
  loadedButtonLabel?: string
  deleteButtonLabel?: string
  onLoadTrace?: (trace: DesignInspectionTraceRecord) => void
  onDeleteTrace?: (trace: DesignInspectionTraceRecord) => void
}

function formatApprovalStatus(status: DesignInspectionTraceRecord['approvalStatus']): string {
  switch (status) {
    case 'pending':
      return '\u5f85\u786e\u8ba4'
    case 'approved':
      return '\u5df2\u6279\u51c6'
    case 'rejected':
      return '\u5df2\u62d2\u7edd'
    case 'retry_requested':
      return '\u8bf7\u6c42\u91cd\u8bd5'
    default:
      return '\u5f85\u786e\u8ba4'
  }
}

function formatExecutionStatus(
  status?: DesignInspectionTraceRecord['executionStatus']
): string | null {
  if (!status) return null

  switch (status) {
    case 'success':
      return '\u5df2\u5b8c\u6210'
    case 'partial':
      return '\u90e8\u5206\u5b8c\u6210'
    case 'failed':
      return '\u5931\u8d25'
    default:
      return status
  }
}

function formatTraceTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`
}

function formatTimelineStage(
  trace: DesignInspectionTraceRecord,
  entry: DesignInspectionTraceRecord['timeline'][number]
): string {
  switch (entry.stage) {
    case 'context_pack_built':
      return '上下文'
    case 'proposal_generated':
      return '方案'
    case 'approval_recorded':
      return `审批:${formatApprovalStatus(entry.approvalStatus ?? trace.approvalStatus)}`
    case 'execution_applied':
      return `执行:${formatExecutionStatus(entry.executionStatus ?? trace.executionStatus) ?? '已完成'}`
    default:
      return entry.stage
  }
}

export function DesignInspectionTraceList({
  traces,
  activeSessionId,
  title = '\u6700\u8fd1\u4f1a\u8bdd',
  maxItems = 5,
  disabled = false,
  emptyState,
  loadButtonLabel = '\u52a0\u8f7d',
  loadedButtonLabel = '\u5df2\u52a0\u8f7d',
  deleteButtonLabel = '\u5220\u9664',
  onLoadTrace,
  onDeleteTrace
}: DesignInspectionTraceListProps) {
  const visibleTraces = maxItems > 0 ? traces.slice(0, maxItems) : traces

  if (visibleTraces.length === 0) {
    if (!emptyState) return null

    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {emptyState}
        </Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      {visibleTraces.map((trace) =>
        (() => {
          const provenanceOverview = summarizeDesignInspectionSelectionProvenance(
            trace.contextSnapshot.selectionItems,
            2
          )

          return (
            <Box
              key={trace.sessionId}
              sx={{
                p: 1.25,
                borderRadius: 1.5,
                border: '1px solid',
                borderColor: trace.sessionId === activeSessionId ? 'primary.main' : 'divider',
                bgcolor: 'background.default',
                display: 'flex',
                flexDirection: 'column',
                gap: 0.75
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 1,
                  alignItems: 'flex-start'
                }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {trace.summary}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {'\u66f4\u65b0\u4e8e\uff1a'}
                    {formatTraceTimestamp(trace.updatedAt)} {'|'} {'\u9009\u533a\uff1a'}
                    {trace.selectionItemIds.length} {'|'} {'\u95ee\u9898\uff1a'} {trace.issueCount}{' '}
                    {'|'} {'\u52a8\u4f5c\uff1a'} {trace.actionCount}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {trace.task}
                  </Typography>
                  {trace.timeline.length > 0 && (
                    <>
                      <Typography variant="caption" color="text.secondary">
                        轨迹：
                        {trace.timeline
                          .slice(-4)
                          .map((entry) => formatTimelineStage(trace, entry))
                          .join(' -> ')}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        最新：{trace.timeline[trace.timeline.length - 1]?.message}
                      </Typography>
                    </>
                  )}
                  {provenanceOverview && (
                    <>
                      <Typography variant="caption" color="text.secondary">
                        来源：{provenanceOverview.kindLabels.join(' | ')}
                      </Typography>
                      {provenanceOverview.detailLines.length > 0 && (
                        <Typography variant="caption" color="text.secondary">
                          来源明细：{provenanceOverview.detailLines.join(' | ')}
                        </Typography>
                      )}
                    </>
                  )}
                </Box>
                {(onLoadTrace || onDeleteTrace) && (
                  <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexShrink: 0 }}>
                    {onLoadTrace && (
                      <Button
                        size="small"
                        onClick={() => onLoadTrace(trace)}
                        disabled={disabled || trace.sessionId === activeSessionId}
                      >
                        {trace.sessionId === activeSessionId ? loadedButtonLabel : loadButtonLabel}
                      </Button>
                    )}
                    {onDeleteTrace && (
                      <Button
                        size="small"
                        color="error"
                        onClick={() => onDeleteTrace(trace)}
                        disabled={disabled}
                      >
                        {deleteButtonLabel}
                      </Button>
                    )}
                  </Box>
                )}
              </Box>
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                <Chip
                  size="small"
                  label={`\u5ba1\u6279\uff1a${formatApprovalStatus(trace.approvalStatus)}`}
                />
                {formatExecutionStatus(trace.executionStatus) && (
                  <Chip
                    size="small"
                    label={`\u6267\u884c\uff1a${formatExecutionStatus(trace.executionStatus)}`}
                  />
                )}
                {trace.sessionId === activeSessionId && (
                  <Chip size="small" label={'\u5f53\u524d'} />
                )}
              </Box>
            </Box>
          )
        })()
      )}
    </Box>
  )
}

export default DesignInspectionTraceList
