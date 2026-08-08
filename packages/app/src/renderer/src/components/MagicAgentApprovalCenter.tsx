import React, { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'
import type { MagicAgentPlatformPendingApproval } from '@shared/api/svcMagicAgentPlatform'
import { api } from '../utils/windowUtils'

const POLL_MS = 1000

export default function MagicAgentApprovalCenter(): React.JSX.Element | null {
  const [approvals, setApprovals] = useState<MagicAgentPlatformPendingApproval[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const result = await api().svcMagicAgentPlatform.listPendingApprovals({})
      setApprovals(result.approvals)
    } catch {
      setApprovals([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const approval = approvals[0]
  if (!approval) return null

  const resolve = async (approved: boolean): Promise<void> => {
    const selected = approval
    setBusy(true)
    setApprovals((current) => current.filter((item) => item.approvalId !== selected.approvalId))
    try {
      await api().svcMagicAgentPlatform.resolvePendingApproval({
        approvalId: selected.approvalId,
        expectedRevision: selected.revision,
        approved
      })
      await refresh()
    } catch {
      setApprovals((current) =>
        current.some((item) => item.approvalId === selected.approvalId)
          ? current
          : [selected, ...current]
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open aria-labelledby="magic-agent-approval-title">
      <DialogTitle id="magic-agent-approval-title">Agent action requires approval</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          {approval.graphContext
            ? `Graph ${approval.graphContext.runId} · node ${approval.graphContext.nodeId} · ${approval.graphContext.toolName}`
            : 'A controlled terminal action is waiting for approval.'}
        </Typography>
        <Box
          component="pre"
          sx={{ mt: 2, maxWidth: 640, overflow: 'auto', whiteSpace: 'pre-wrap' }}
        >
          {JSON.stringify(approval.request, null, 2)}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={() => void resolve(false)}>
          Deny
        </Button>
        <Button disabled={busy} variant="contained" onClick={() => void resolve(true)}>
          Approve
        </Button>
      </DialogActions>
    </Dialog>
  )
}
