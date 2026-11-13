import { Box, Typography } from '@mui/material'

export type TeamMessageActivityEntry = {
  readonly id: string
  readonly sourceName: string
  readonly recipientName: string
  readonly text: string
  readonly status: 'queued' | 'request_started' | 'response_received' | 'failed' | 'unavailable' | 'unknown'
}

const statusLabels: Record<TeamMessageActivityEntry['status'], string> = {
  queued: '排队中（非送达）',
  request_started: '请求已发起',
  response_received: '已收到响应（不代表送达）',
  failed: '失败',
  unavailable: '状态未确认',
  unknown: '结果未知'
}

export default function AgentTeamMessageActivity({ entries }: { entries: readonly TeamMessageActivityEntry[] }) {
  if (!entries.length) return null
  return <>
    {entries.length > 50 && <Typography component="div" variant="caption" color="text.secondary">此处仅显示最近 50 条团队消息。</Typography>}
    <Box component="ol" role="list" aria-label="团队消息活动" data-testid="team-message-activity" sx={{ minWidth: 0, maxWidth: '100%', m: 0, p: 0, listStyle: 'none' }}>
      {entries.slice(-50).map(entry => <Typography key={entry.id} component="li" variant="caption" color="text.secondary" sx={{ minWidth: 0, maxWidth: '100%', lineHeight: 1.6, py: 0.25, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
        团队消息 · {entry.sourceName} → {entry.recipientName} · {statusLabels[entry.status]} · {entry.text}
        {(entry.status === 'unknown' || entry.status === 'unavailable') && <Box component="span" sx={{ display: 'block' }}>未确认结果，请核对相关会话中的后续记录。</Box>}
      </Typography>)}
    </Box>
  </>
}
