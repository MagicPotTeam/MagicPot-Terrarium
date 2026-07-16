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

export default function DataStorageInfo() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [directoryState, setDirectoryState] = useState<UserDataDirectorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadState = useCallback(async () => {
    try {
      const resp = await api().svcState.getUserDataDirectoryState({})
      setDirectoryState(resp.state)
      setError(null)
    } catch (loadError) {
      console.error('[Settings] Failed to load storage root state:', loadError)
      setError(t('environment.data_directory.load_failed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadState()
  }, [loadState])

  const confirmAndApply = useCallback(
    async (nextPath: string | null) => {
      if (!directoryState) return
      const targetPath = nextPath ?? directoryState.defaultStorageRoot
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
      if (dialogResp.response !== 0) return

      setBusy(true)
      setError(null)
      try {
        const resp = await api().svcState.setUserDataDirectory({ path: nextPath })
        try {
          localStorage.removeItem('qapp.downloadDir')
        } catch {
          // The storage-root service remains authoritative when localStorage is unavailable.
        }
        if (!resp.restartRequired) {
          setBusy(false)
          await loadState()
        }
      } catch (updateError) {
        console.error('[Settings] Failed to update storage root:', updateError)
        setBusy(false)
        setError(
          updateError instanceof Error
            ? updateError.message
            : t('environment.data_directory.update_failed')
        )
      }
    },
    [directoryState, loadState, t]
  )

  const handleChooseDirectory = useCallback(async () => {
    if (!directoryState) return
    const dialogResp = await api().svcDialog.showOpenDialog({
      title: t('environment.data_directory.dialog_choose_title'),
      defaultPath: directoryState.storageRoot,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (!dialogResp.canceled && dialogResp.filePaths[0]) {
      await confirmAndApply(dialogResp.filePaths[0])
    }
  }, [confirmAndApply, directoryState, t])

  if (loading) {
    return (
      <Stack direction="row" spacing={1.5} alignItems="center">
        <CircularProgress size={18} />
        <Typography variant="body2" color="text.secondary">
          {t('environment.data_directory.loading')}
        </Typography>
      </Stack>
    )
  }

  if (!directoryState) {
    return <Alert severity="warning">{error || t('environment.data_directory.unavailable')}</Alert>
  }

  const controlsLocked = busy || directoryState.source === 'env'
  const statusLabel =
    directoryState.source === 'env'
      ? t('environment.data_directory.status_env_override')
      : directoryState.isCustom
        ? t('environment.data_directory.status_custom')
        : t('environment.data_directory.status_default')

  const locations = [
    [t('environment.data_directory.current_directory'), directoryState.storageRoot],
    [t('environment.data_directory.data_subdirectory'), directoryState.currentPath],
    [t('environment.data_directory.projects_subdirectory'), directoryState.projectRoot],
    [t('environment.data_directory.autosave_subdirectory'), directoryState.autoSaveRoot]
  ] as const

  return (
    <Stack spacing={2}>
      <Alert severity="info">{t('environment.data_directory.info')}</Alert>
      {directoryState.source === 'env' ? (
        <Alert severity="warning">{t('environment.data_directory.env_override')}</Alert>
      ) : null}
      {directoryState.legacyLayout ? (
        <Alert severity="warning">{t('environment.data_directory.legacy_layout')}</Alert>
      ) : null}
      {error ? <Alert severity="error">{error}</Alert> : null}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t('environment.data_directory.card_title')}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                <Chip size="small" color="primary" label={statusLabel} />
                {busy ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={t('environment.data_directory.status_applying')}
                  />
                ) : null}
              </Stack>
            </Box>

            {locations.map(([label, value]) => (
              <Box key={label}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {label}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ wordBreak: 'break-all' }}
                >
                  {value}
                </Typography>
              </Box>
            ))}

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
                  {directoryState.defaultStorageRoot}
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
                onClick={() => void api().svcShell.openPath(directoryState.storageRoot)}
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
