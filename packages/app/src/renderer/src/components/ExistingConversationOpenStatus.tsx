import { useState } from 'react'
import { Button, Paper, Stack, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { existingConversationOpenStore as coordinator, useExistingConversationOpenSnapshot } from '../utils/existingConversationOpenStore'
import type { OpenFailure, OpenRequestHandle } from '../utils/existingConversationOpen'

/** Layout-owned feedback survives the management source page. It grants no Open authority. */
export default function ExistingConversationOpenStatus() {
  const snapshot = useExistingConversationOpenSnapshot()
  const [dismissed, setDismissed] = useState<OpenRequestHandle | null>(null)
  const { i18n } = useTranslation()
  const chinese = i18n.language?.toLowerCase().startsWith('zh')
  const text = (en: string, zh: string) => chinese ? zh : en
  const request = snapshot.request
  const result = snapshot.result
  if (!request && (!result || result.handle === dismissed)) return null
  const target = (request?.handle ?? result!.handle).target
  const failure = (reason?: OpenFailure) => {
    switch (reason) {
      case 'cancelled': return text('Open cancelled', '已取消打开')
      case 'expired': return text('Open timed out', '打开请求已超时')
      case 'membership-unavailable': return text('Current ownership or persisted conversation unavailable', '当前归属或已存储会话不可用')
      case 'load-failed': return text('Conversation load unavailable', '会话加载不可用')
      case 'destination-lost': return text('Existing destination tab, pane or presentation changed or unavailable', '已有目标标签页、面板或可见状态已变化或不可用')
      case 'superseded': return text('Replaced by another Open request', '已被另一个打开请求替代')
      default: return text('Open unavailable', '打开不可用')
    }
  }
  return (
    <Paper component="section" role="region" aria-label={text('Existing conversation Open', '打开已有会话状态')} variant="outlined" sx={{ px: 2, py: 1, flexShrink: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography role="status" aria-live="polite">
            {request ? text('Opening existing conversation', '正在打开已有会话') : result!.status === 'succeeded' ? text('Existing conversation opened', '已打开已有会话') : text('Existing conversation could not be opened', '未能打开已有会话')}
          </Typography>
          {!request && result!.status === 'rejected' && <Typography variant="body2">{failure(result!.reason)}</Typography>}
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
            {text('Project', '项目')}: {target.projectId} · {text('Pane', '面板')}: {target.paneId} · ID: {target.sessionId}
          </Typography>
        </Stack>
        {request ? (
          <Button onClick={() => {
            // A stale rendered cancel control cannot cancel a synchronous replacement.
            if (coordinator.getSnapshot().request?.handle === request.handle) coordinator.cancel(request.handle)
          }}>{text('Cancel Open', '取消打开')}</Button>
        ) : (
          <Button onClick={() => setDismissed(result!.handle)}>{text('Dismiss Open result', '关闭打开结果')}</Button>
        )}
      </Stack>
    </Paper>
  )
}
