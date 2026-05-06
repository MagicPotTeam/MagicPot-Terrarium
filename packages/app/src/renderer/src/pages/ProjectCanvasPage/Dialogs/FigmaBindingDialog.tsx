import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import type { CanvasFigmaBinding } from '@shared/figma'
import { useTranslation } from 'react-i18next'

type FigmaBindingDialogProps = {
  open: boolean
  variant?: 'dialog' | 'inline'
  accessTokenConfigured: boolean
  busyAction: 'resolve' | 'bind' | 'sync' | 'check' | null
  error: string | null
  fileKeyOrUrl: string
  binding: CanvasFigmaBinding | null
  globalAutoCheckEnabled: boolean
  globalAutoCheckIntervalMinutes: number
  onFileKeyOrUrlChange: (value: string) => void
  onPageNodeIdChange: (value: string) => void
  onAutoCheckUpdatesChange: (value: boolean) => void
  onResolve: () => void
  onBind: () => void
  onSync: () => void
  onCheck: () => void
  onUnbind: () => void
  onClose: () => void
}

export default function FigmaBindingDialog({
  open,
  variant = 'dialog',
  accessTokenConfigured,
  busyAction,
  error,
  fileKeyOrUrl,
  binding,
  globalAutoCheckEnabled,
  globalAutoCheckIntervalMinutes,
  onFileKeyOrUrlChange,
  onPageNodeIdChange,
  onAutoCheckUpdatesChange,
  onResolve,
  onBind,
  onSync,
  onCheck,
  onUnbind,
  onClose
}: FigmaBindingDialogProps) {
  const { i18n } = useTranslation()
  const isChineseUi = (i18n.resolvedLanguage || i18n.language || '').toLowerCase().startsWith('zh')
  const text = (zh: string, en: string) => (isChineseUi ? zh : en)
  const hasResolvedBinding = Boolean(binding?.fileKey)
  const selectedPageNodeId = binding?.pageNodeId || binding?.pages[0]?.nodeId || ''
  const title = text('\u7ed1\u5b9a Figma \u6587\u4ef6', 'Bind Figma File')

  const content = (
    <>
      {busyAction && <LinearProgress />}

      <Alert severity={accessTokenConfigured ? 'info' : 'warning'} variant="outlined">
        <AlertTitle>
          {accessTokenConfigured
            ? text('Figma API \u5df2\u914d\u7f6e', 'Figma API Is Ready')
            : text('\u7f3a\u5c11 Figma API Token', 'Missing Figma API Token')}
        </AlertTitle>
        <Typography variant="body2">
          {accessTokenConfigured
            ? text(
                '\u8f93\u5165 Figma \u6587\u4ef6\u94fe\u63a5\u6216 File Key\uff0c\u9009\u62e9\u9875\u9762\u540e\u5373\u53ef\u7ed1\u5b9a\u5230\u5f53\u524d\u753b\u5e03\uff0c\u540e\u7eed\u7531 MagicPot \u4e3b\u52a8\u62c9\u53d6\u540c\u6b65\u3002',
                'Enter a Figma file link or File Key, choose a page, and bind it to this canvas so MagicPot can pull updates.'
              )
            : text(
                '\u8bf7\u5148\u5230\u8bbe\u7f6e > \u73af\u5883\u90e8\u7f72\u91cc\u914d\u7f6e Figma Personal Access Token\u3002',
                'Set your Figma Personal Access Token in Settings > Environment before binding a file.'
              )}
        </Typography>
      </Alert>

      <TextField
        fullWidth
        label={text('Figma \u6587\u4ef6\u94fe\u63a5\u6216 File Key', 'Figma File Link or File Key')}
        value={fileKeyOrUrl}
        onChange={(event) => onFileKeyOrUrlChange(event.target.value)}
        placeholder={text(
          '\u4f8b\u5982\uff1ahttps://www.figma.com/design/... \u6216\u76f4\u63a5\u7c98\u8d34 File Key',
          'For example: https://www.figma.com/design/... or a raw File Key'
        )}
        disabled={Boolean(busyAction)}
      />

      {hasResolvedBinding && binding && (
        <Stack spacing={1.25}>
          <Alert severity={binding.updateAvailable ? 'warning' : 'success'} variant="outlined">
            <AlertTitle>
              {binding.fileName || text('\u5df2\u89e3\u6790\u6587\u4ef6', 'Resolved File')}
            </AlertTitle>
            <Typography variant="body2">{`${text('\u6587\u4ef6 Key', 'File Key')}: ${binding.fileKey}`}</Typography>
            {binding.pageName && (
              <Typography variant="body2">{`${text('\u5f53\u524d\u9875\u9762', 'Current Page')}: ${binding.pageName}`}</Typography>
            )}
            {binding.lastSyncedAt && (
              <Typography variant="body2">
                {`${text('\u4e0a\u6b21\u540c\u6b65', 'Last Synced')}: ${new Date(binding.lastSyncedAt).toLocaleString()}`}
              </Typography>
            )}
            {binding.lastCheckedAt && (
              <Typography variant="body2">
                {`${text('\u4e0a\u6b21\u68c0\u67e5', 'Last Checked')}: ${new Date(binding.lastCheckedAt).toLocaleString()}`}
              </Typography>
            )}
          </Alert>

          <TextField
            select
            fullWidth
            label={text('\u7ed1\u5b9a\u9875\u9762', 'Bound Page')}
            value={selectedPageNodeId}
            onChange={(event) => onPageNodeIdChange(event.target.value)}
            disabled={Boolean(busyAction) || binding.pages.length === 0}
          >
            {binding.pages.map((page) => (
              <MenuItem key={page.nodeId} value={page.nodeId}>
                {`${page.name} (${text('\u9876\u5c42\u56fe\u5c42', 'Top-level Layers')}: ${page.childCount})`}
              </MenuItem>
            ))}
          </TextField>

          <FormControlLabel
            control={
              <Switch
                checked={binding.autoCheckUpdates ?? true}
                onChange={(event) => onAutoCheckUpdatesChange(event.target.checked)}
                disabled={Boolean(busyAction)}
              />
            }
            label={text(
              '\u5141\u8bb8\u5f53\u524d\u753b\u5e03\u81ea\u52a8\u68c0\u67e5\u8fd9\u4e2a Figma \u6587\u4ef6\u662f\u5426\u6709\u66f4\u65b0',
              'Allow this canvas to auto-check this Figma file for updates'
            )}
          />

          {binding.autoCheckUpdates && !globalAutoCheckEnabled && (
            <Alert severity="warning" variant="outlined">
              {text(
                '\u5f53\u524d\u753b\u5e03\u5df2\u5f00\u542f\u81ea\u52a8\u68c0\u67e5\uff0c\u4f46\u5168\u5c40\u81ea\u52a8\u68c0\u67e5\u5f00\u5173\u5904\u4e8e\u5173\u95ed\u72b6\u6001\u3002\u8bf7\u5148\u5230\u73af\u5883\u90e8\u7f72\u91cc\u5f00\u542f\u3002',
                'This canvas allows auto-checking, but the global auto-check switch is turned off in Environment settings.'
              )}
            </Alert>
          )}

          {binding.autoCheckUpdates && globalAutoCheckEnabled && (
            <Typography variant="caption" color="text.secondary">
              {text(
                `MagicPot \u4f1a\u6309\u5168\u5c40\u95f4\u9694\u6bcf ${globalAutoCheckIntervalMinutes} \u5206\u949f\u68c0\u67e5\u4e00\u6b21\u8fd9\u4e2a\u7ed1\u5b9a\u6587\u4ef6\u662f\u5426\u6709\u65b0\u7248\u672c\u3002`,
                `MagicPot checks this bound file every ${globalAutoCheckIntervalMinutes} minute(s) using the global interval.`
              )}
            </Typography>
          )}
        </Stack>
      )}

      {error && <Alert severity="error">{error}</Alert>}
    </>
  )

  const actions = (
    <>
      <Button
        onClick={onUnbind}
        color="error"
        disabled={!hasResolvedBinding || Boolean(busyAction)}
      >
        {text('\u89e3\u9664\u7ed1\u5b9a', 'Unbind')}
      </Button>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {variant === 'dialog' && (
          <Button onClick={onClose} disabled={Boolean(busyAction)}>
            {text('\u5173\u95ed', 'Close')}
          </Button>
        )}
        <Button
          onClick={onResolve}
          disabled={!accessTokenConfigured || !fileKeyOrUrl.trim() || Boolean(busyAction)}
        >
          {text('\u89e3\u6790\u6587\u4ef6', 'Resolve')}
        </Button>
        <Button
          onClick={onCheck}
          disabled={!accessTokenConfigured || !hasResolvedBinding || Boolean(busyAction)}
        >
          {text('\u68c0\u67e5\u66f4\u65b0', 'Check Updates')}
        </Button>
        <Button onClick={onBind} disabled={!hasResolvedBinding || Boolean(busyAction)}>
          {text('\u4fdd\u5b58\u7ed1\u5b9a', 'Save Binding')}
        </Button>
        <Button
          variant="contained"
          onClick={onSync}
          disabled={!accessTokenConfigured || !hasResolvedBinding || Boolean(busyAction)}
        >
          {text('\u540c\u6b65\u5230\u753b\u5e03', 'Sync to Canvas')}
        </Button>
      </Stack>
    </>
  )

  if (variant === 'inline') {
    return (
      <Paper variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
        <Box sx={{ px: 2.5, py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
        </Box>
        <Stack spacing={2} sx={{ p: 2.5 }}>
          {content}
        </Stack>
        <Box
          sx={{
            px: 2.5,
            py: 2,
            borderTop: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            justifyContent: 'space-between',
            gap: 1.5
          }}
        >
          {actions}
        </Box>
      </Paper>
    )
  }

  return (
    <Dialog open={open} onClose={busyAction ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {content}
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 3, py: 2 }}>
        {actions}
      </DialogActions>
    </Dialog>
  )
}
