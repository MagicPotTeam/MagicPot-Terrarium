import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Typography
} from '@mui/material'
import { Folder as FolderIcon, RestartAlt as RestartAltIcon } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import type { UserDataDirectoryState as UserDataDirectorySnapshot } from '@shared/api/svcState'

type LoadState = {
  loading: boolean
  error: string | null
  directoryState: UserDataDirectorySnapshot | null
}

export default function DataStorageInfo() {
  const { t } = useTranslation()
  const [state, setState] = useState<LoadState>({
    loading: true,
    error: null,
    directoryState: null
  })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const loadState = useCallback(async () => {
    try {
      const resp = await api().svcState.getUserDataDirectoryState({})
      setState({
        loading: false,
        error: null,
        directoryState: resp.state
      })
    } catch (error) {
      console.error('[Settings] Failed to load data directory state:', error)
      setState({
        loading: false,
        error: t('environment.data_directory.load_failed'),
        directoryState: null
      })
    }
  }, [t])

  useEffect(() => {
    void loadState()
  }, [loadState])

  const openPath = useCallback((targetPath: string) => {
    void api().svcShell.openPath(targetPath)
  }, [])

  const confirmAndApply = useCallback(
    async (nextPath: string | null) => {
      const directoryState = state.directoryState
      if (!directoryState) {
        return
      }

      const targetPath = nextPath ?? directoryState.defaultPath
      const dialogResp = await api().svcDialog.showMessageBox({
        type: 'question',
        buttons: [
          t('environment.data_directory.dialog_confirm'),
          t('environment.data_directory.dialog_cancel')
        ],
        defaultId: 0,
        cancelId: 1,
        title: t('environment.data_directory.dialog_title'),
        message: t('environment.data_directory.dialog_message'),
        detail: nextPath
          ? t('environment.data_directory.dialog_detail_custom', { targetPath })
          : t('environment.data_directory.dialog_detail_default', { targetPath })
      })

      if (dialogResp.response !== 0) {
        return
      }

      setBusy(true)
      setActionError(null)

      try {
        const resp = await api().svcState.setUserDataDirectory({ path: nextPath })
        if (!resp.restartRequired) {
          setBusy(false)
          await loadState()
        }
      } catch (error) {
        console.error('[Settings] Failed to update data directory:', error)
        setBusy(false)
        setActionError(
          error instanceof Error ? error.message : t('environment.data_directory.update_failed')
        )
      }
    },
    [loadState, state.directoryState, t]
  )

  const handleChooseDirectory = useCallback(async () => {
    const directoryState = state.directoryState
    if (!directoryState) {
      return
    }

    const dialogResp = await api().svcDialog.showOpenDialog({
      title: t('environment.data_directory.dialog_choose_title'),
      defaultPath: directoryState.currentPath,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })

    if (dialogResp.canceled) {
      return
    }

    const selectedPath = dialogResp.filePaths[0]
    if (!selectedPath) {
      return
    }

    await confirmAndApply(selectedPath)
  }, [confirmAndApply, state.directoryState, t])

  if (state.loading) {
    return (
      <Stack direction="row" spacing={1.5} alignItems="center">
        <CircularProgress size={18} />
        <Typography variant="body2" color="text.secondary">
          {t('environment.data_directory.loading')}
        </Typography>
      </Stack>
    )
  }

  const directoryState = state.directoryState
  if (!directoryState) {
    return (
      <Alert severity="warning">{state.error || t('environment.data_directory.unavailable')}</Alert>
    )
  }

  const controlsLocked = busy || directoryState.source === 'env'
  const statusLabel =
    directoryState.source === 'env'
      ? t('environment.data_directory.status_env_override')
      : directoryState.isCustom
        ? t('environment.data_directory.status_custom')
        : t('environment.data_directory.status_default')

  return (
    <Stack spacing={2}>
      <Alert severity="info">{t('environment.data_directory.info')}</Alert>

      {directoryState.source === 'env' ? (
        <Alert severity="warning">{t('environment.data_directory.env_override')}</Alert>
      ) : null}

      {state.error ? <Alert severity="warning">{state.error}</Alert> : null}
      {actionError ? <Alert severity="error">{actionError}</Alert> : null}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t('environment.data_directory.card_title')}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                <Chip
                  size="small"
                  color={directoryState.source === 'env' ? 'warning' : 'primary'}
                  variant="filled"
                  label={statusLabel}
                />
                {busy ? (
                  <Chip
                    size="small"
                    color="default"
                    variant="outlined"
                    label={t('environment.data_directory.status_applying')}
                  />
                ) : null}
              </Stack>
            </Box>

            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {t('environment.data_directory.current_directory')}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                {directoryState.currentPath}
              </Typography>
            </Box>

            {directoryState.isCustom || directoryState.source === 'env' ? (
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {t('environment.data_directory.default_directory')}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ wordBreak: 'break-all' }}
                >
                  {directoryState.defaultPath}
                </Typography>
              </Box>
            ) : null}

            <Typography variant="body2" color="text.secondary">
              {t('environment.data_directory.restart_hint')}
            </Typography>

            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} flexWrap="wrap">
              <Button
                variant="contained"
                startIcon={<FolderIcon />}
                onClick={() => void handleChooseDirectory()}
                disabled={controlsLocked}
              >
                {t('environment.data_directory.choose')}
              </Button>
              <Button
                variant="outlined"
                startIcon={<FolderIcon />}
                onClick={() => openPath(directoryState.currentPath)}
                disabled={busy}
              >
                {t('environment.data_directory.open_current')}
              </Button>
              <Button
                variant="outlined"
                color="inherit"
                startIcon={<RestartAltIcon />}
                onClick={() => void confirmAndApply(null)}
                disabled={controlsLocked || !directoryState.isCustom}
              >
                {t('environment.data_directory.use_default')}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  )
}
