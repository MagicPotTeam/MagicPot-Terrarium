import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'
import type { DesignInspectionTraceRecord } from '../designInspectionTraceStorage'
import DesignInspectionTraceList from '../components/DesignInspectionTraceList'

type DesignInspectionHistoryDialogProps = {
  open: boolean
  traces: DesignInspectionTraceRecord[]
  activeSessionId?: string | null
  busy?: boolean
  onLoadTrace: (trace: DesignInspectionTraceRecord) => void
  onDeleteTrace?: (trace: DesignInspectionTraceRecord) => void
  onClose: () => void
}

export function DesignInspectionHistoryDialog({
  open,
  traces,
  activeSessionId,
  busy = false,
  onLoadTrace,
  onDeleteTrace,
  onClose
}: DesignInspectionHistoryDialogProps) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, fontSize: 18 }}>检查记录</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          将历史检查会话重新载入到审阅流程，无需重新发起新的检查。
        </Typography>
        <DesignInspectionTraceList
          traces={traces}
          activeSessionId={activeSessionId}
          maxItems={20}
          disabled={busy}
          emptyState="暂时还没有记录任何检查会话。"
          loadButtonLabel="加载会话"
          loadedButtonLabel="当前会话"
          onLoadTrace={onLoadTrace}
          onDeleteTrace={onDeleteTrace}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default DesignInspectionHistoryDialog
