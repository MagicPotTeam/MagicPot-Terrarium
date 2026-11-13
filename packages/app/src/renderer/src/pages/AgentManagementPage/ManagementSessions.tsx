import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Button, Paper, Stack, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { readExistingSessionSummaries, type ExistingSessionSummary } from '../ChatPage/chatStorage'
import { readManagementPaneSnapshot, type ManagementPaneOwner } from './managementPaneMetadata'
import { existingConversationOpenStore, useExistingConversationOpenSnapshot } from '../../utils/existingConversationOpenStore'
import type { ExistingConversationTarget } from '../../utils/existingConversationOpen'

type Row = ExistingSessionSummary & ManagementPaneOwner
type State = { status: 'idle' | 'loading' | 'unavailable' } | { status: 'ready'; rows: Row[] }

/** Explicit metadata snapshot, never a ChatPage mount or conversation-Open authority. */
export default function ManagementSessions() {
  const { i18n } = useTranslation()
  const chinese = i18n.language?.toLowerCase().startsWith('zh')
  const text = (en: string, zh: string) => (chinese ? zh : en)
  const id = useId()
  const [state, setState] = useState<State>({ status: 'idle' })
  const openSnapshot = useExistingConversationOpenSnapshot()
  const [openUnavailable, setOpenUnavailable] = useState(false)
  const live = useRef(false)
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      controller.current?.abort()
      controller.current = null
    }
  }, [])

  const sameTarget = (left: ExistingConversationTarget, right: ExistingConversationTarget) =>
    left.projectId === right.projectId && left.paneId === right.paneId && left.storageScope === right.storageScope && left.sessionId === right.sessionId
  const open = (row: Row) => {
    // A displayed snapshot supplies identity only. start installs guards before
    // any await; fresh ownership/persisted validation and navigation are elsewhere.
    const target = Object.freeze({ projectId: row.projectId, paneId: row.paneId, storageScope: row.storageScope, sessionId: row.sessionId })
    const pending = existingConversationOpenStore.getSnapshot().request
    if (pending && sameTarget(pending.handle.target, target)) return
    setOpenUnavailable(!existingConversationOpenStore.start(target))
    // No component cleanup cancels this accepted navigation handoff.
  }

  const read = async () => {
    if (controller.current || !live.current) return
    const current = ++sequence.current
    const pending = new AbortController()
    controller.current = pending
    setState({ status: 'loading' })
    const currentRequest = () =>
      live.current && sequence.current === current && !pending.signal.aborted
    try {
      const metadata = readManagementPaneSnapshot()
      if (metadata.status !== 'ready') {
        if (currentRequest()) setState({ status: 'unavailable' })
        return
      }
      const result = await readExistingSessionSummaries(
        metadata.owners.map((owner) => owner.storageScope),
        pending.signal
      )
      if (!currentRequest()) return
      if (result.status !== 'ready' || !metadata.isCurrent()) {
        setState({ status: 'unavailable' })
        return
      }
      const owners = new Map(metadata.owners.map((owner) => [owner.storageScope, owner]))
      const rows: Row[] = []
      for (const summary of result.sessions) {
        const owner = owners.get(summary.storageScope)
        if (!owner) {
          setState({ status: 'unavailable' })
          return
        }
        // Both are already detached allowlists; do not merge any underlying records.
        rows.push({ ...owner, ...summary })
      }
      setState({ status: 'ready', rows })
    } catch {
      if (currentRequest()) setState({ status: 'unavailable' })
    } finally {
      if (sequence.current === current) controller.current = null
    }
  }

  return (
    <Paper component="section" aria-labelledby={`${id}-sessions`} variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography id={`${id}-sessions`} component="h2" variant="h6">
          {text('Sessions', '会话')}
        </Typography>
        <Button variant="outlined" disabled={state.status === 'loading'} onClick={() => void read()}>
          {text('Read existing conversation summaries', '读取已有会话摘要')}
        </Button>
        {state.status === 'idle' && (
          <Typography>
            {text(
              'Not loaded — use Read existing conversation summaries',
              '尚未读取，请使用“读取已有会话摘要”'
            )}
          </Typography>
        )}
        {state.status === 'loading' && (
          <Typography role="status">
            {text('Reading existing conversation summaries', '正在读取已有会话摘要')}
          </Typography>
        )}
        {state.status === 'unavailable' && (
          <Alert severity="warning">
            {text(
              'Existing conversation summaries unavailable. Storage may be missing, incompatible, changed, unreadable or over the bounded limit; no migration or repair was attempted.',
              '已有会话摘要不可用：存储可能缺失、不兼容、已变化、不可读或超出数量限制；未执行迁移或修复。'
            )}
          </Alert>
        )}
        {openUnavailable && <Alert severity="warning">{text('Open request unavailable', '打开请求不可用')}</Alert>}
        {state.status === 'ready' &&
          (!state.rows.length ? (
            <Typography>
              {text(
                'No existing conversations in the validated enabled panes',
                '已验证的启用面板中没有已有会话'
              )}
            </Typography>
          ) : (
            <Stack component="ul" spacing={1.5} sx={{ pl: 3 }}>
              {state.rows.map((row) => (
                <Stack component="li" key={JSON.stringify([row.storageScope, row.sessionId])}>
                  <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {row.title || text('(Untitled)', '（无标题）')}
                  </Typography>
                  {row.titleTruncated && (
                    <Typography variant="caption">{text('Title truncated', '标题已截断')}</Typography>
                  )}
                  <Typography variant="body2">{row.projectName}</Typography>
                  <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                    {text('Project', '项目')}: {row.projectId} · {text('Pane', '面板')}: {row.paneId}
                  </Typography>
                  <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                    {text('Scope', '作用域')}: {row.storageScope} · ID: {row.sessionId}
                  </Typography>
                  <Button variant="outlined" sx={{ alignSelf: 'flex-start' }} disabled={!!openSnapshot.request && sameTarget(openSnapshot.request.handle.target, row)} onClick={() => open(row)}>
                    {text('Open existing conversation', '打开已有会话')}
                  </Button>
                  <Typography variant="caption">
                    {text('Created at (stored epoch ms)', '创建时间（存储的 epoch 毫秒）')}:{' '}
                    {row.createdAt ?? text('Not recorded', '未记录')}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          ))}
      </Stack>
    </Paper>
  )
}
