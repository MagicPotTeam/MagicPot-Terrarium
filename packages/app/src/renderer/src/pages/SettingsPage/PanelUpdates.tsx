import React from 'react'
import {
  Box,
  Button,
  FormControl,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import {
  DeleteOutline as DeleteIcon,
  Refresh as RefreshIcon,
  RestartAlt as RestartIcon,
  SystemUpdateAlt as UpdateIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type { AppUpdateStatus, AppUpdateSvc, LauncherManagedState } from '@shared/api/svcAppUpdate'
import type { UpdateChannel, UpdateMode } from '@shared/appUpdate/launcherProtocol'
import {
  PACKAGE_VERSION,
  UPDATE_PROVIDER_CHANNEL,
  UPDATE_PROVIDER_OWNER,
  UPDATE_PROVIDER_REPO
} from '@shared/config/viteEnv'
import SettingSection from './components/SettingSection'
import type { PanelProps } from './PanelProps'

type BridgeState = 'unavailable' | 'loading' | 'available' | 'error'

const DEFAULT_RELEASE_REPO = 'MagicPotTeam/MagicPot-Terrarium'
const FALLBACK_UPDATE_STATUS: AppUpdateStatus = {
  state: 'unsupported',
  currentVersion: PACKAGE_VERSION,
  provider: {
    type: 'github',
    owner: UPDATE_PROVIDER_OWNER,
    repo: UPDATE_PROVIDER_REPO,
    channel: UPDATE_PROVIDER_CHANNEL
  },
  supported: false,
  canCheck: false,
  canDownload: false,
  canInstall: false
}

function getUpdateService(): Partial<AppUpdateSvc> | null {
  try {
    return (api() as unknown as { svcAppUpdate?: Partial<AppUpdateSvc> }).svcAppUpdate ?? null
  } catch {
    return null
  }
}

const isBusy = (status: AppUpdateStatus): boolean =>
  ['checking', 'downloading', 'installing'].includes(status.state)

const DEFAULT_LAUNCHER_CAPABILITIES = {
  checkNow: false,
  installLatest: false,
  rollback: false,
  removeVersion: false
}

const PanelUpdates: React.FC<PanelProps> = () => {
  const { t } = useTranslation()
  const initialService = React.useMemo(getUpdateService, [])
  const [bridgeState, setBridgeState] = React.useState<BridgeState>(
    initialService ? 'loading' : 'unavailable'
  )
  const [updateStatus, setUpdateStatus] = React.useState(FALLBACK_UPDATE_STATUS)
  const [launcherState, setLauncherState] = React.useState<LauncherManagedState | null>(null)
  const [updateMode, setUpdateMode] = React.useState<UpdateMode>('manual')
  const [channel, setChannel] = React.useState<UpdateChannel>('stable')
  const [launcherSaved, setLauncherSaved] = React.useState(false)
  const [launcherSaving, setLauncherSaving] = React.useState(false)
  const [launcherCommandPending, setLauncherCommandPending] = React.useState(false)
  const [launcherError, setLauncherError] = React.useState<string | null>(null)
  const launcherCommandRequestId = React.useRef<string | null>(null)
  const launcherRequestId = React.useRef(0)
  const selections = React.useRef({ updateMode, channel })
  selections.current = { updateMode, channel }

  React.useEffect(() => {
    const service = initialService
    if (!service) return
    let cancelled = false
    const [abortSender, abortReceiver] = newAbortHandler()

    if (typeof service.getStatus === 'function') {
      void service
        .getStatus({})
        .then((status) => !cancelled && setUpdateStatus(status))
        .catch((error: unknown) => {
          if (!cancelled) {
            setUpdateStatus({
              ...FALLBACK_UPDATE_STATUS,
              state: 'error',
              errorMessage: error instanceof Error ? error.message : String(error)
            })
          }
        })
    }

    if (typeof service.getLauncherState === 'function') {
      void service
        .getLauncherState({})
        .then((state) => {
          if (cancelled) return
          setBridgeState('available')
          setLauncherState({
            ...state,
            capabilities: { ...DEFAULT_LAUNCHER_CAPABILITIES, ...state.capabilities }
          })
          if (state.updateMode) setUpdateMode(state.updateMode)
          if (state.channel) setChannel(state.channel)
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setBridgeState('error')
          setLauncherError(
            t('about.update.launcher.load_error', {
              error: error instanceof Error ? error.message : String(error)
            })
          )
        })
    } else {
      setBridgeState('available')
    }

    if (typeof service.watchStatus === 'function') {
      void service
        .watchStatus(
          {},
          { abortReceiver, onData: (status) => !cancelled && setUpdateStatus(status) }
        )
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
      abortSender.abort()
    }
  }, [initialService, t])

  const runUpdateAction = React.useCallback(
    (action: 'checkForUpdates' | 'downloadUpdate' | 'installUpdate') => {
      const method = initialService?.[action]
      if (typeof method !== 'function') return
      void method({})
        .then(setUpdateStatus)
        .catch((error: unknown) =>
          setUpdateStatus((current) => ({
            ...current,
            state: 'error',
            errorMessage: error instanceof Error ? error.message : String(error)
          }))
        )
    },
    [initialService]
  )

  const runLauncherCommand = React.useCallback(
    (action: 'checkLauncherNow' | 'requestLauncherUpdate' | 'requestLauncherRollback') => {
      const method = initialService?.[action]
      if (typeof method !== 'function' || launcherCommandPending) return
      setLauncherCommandPending(true)
      setLauncherError(null)
      void method({})
        .then((receipt) => {
          if (!receipt.accepted) throw new Error(receipt.error || 'Launcher command was rejected')
          launcherCommandRequestId.current = receipt.requestId ?? null
          setLauncherError(
            t('about.update.launcher.command_queued', { requestId: receipt.requestId })
          )
          if (receipt.requestId && typeof initialService?.getLauncherCommandResult === 'function') {
            void initialService
              .getLauncherCommandResult({ requestId: receipt.requestId })
              .then((result) => {
                if (!result || launcherCommandRequestId.current !== result.requestId) return
                setLauncherError(
                  result.status === 'completed'
                    ? null
                    : t('about.update.launcher.command_error', {
                        error: result.error || result.status
                      })
                )
              })
          }
        })
        .catch((error: unknown) =>
          setLauncherError(
            t('about.update.launcher.command_error', {
              error: error instanceof Error ? error.message : String(error)
            })
          )
        )
        .finally(() => setLauncherCommandPending(false))
    },
    [initialService, launcherCommandPending, t]
  )

  const removeLauncherVersion = React.useCallback(
    (buildId: string, version: string) => {
      if (
        typeof initialService?.requestLauncherVersionRemoval !== 'function' ||
        launcherCommandPending ||
        !window.confirm(
          `Remove installed version v${version}? The removal will run on the next Launcher start.`
        )
      )
        return
      setLauncherCommandPending(true)
      setLauncherError(null)
      void initialService
        .requestLauncherVersionRemoval({ buildId })
        .then((receipt) => {
          if (!receipt.accepted) throw new Error(receipt.error || 'Launcher command was rejected')
          launcherCommandRequestId.current = receipt.requestId ?? null
          setLauncherError('Removal queued for the next Launcher start.')
        })
        .catch((error: unknown) =>
          setLauncherError(
            t('about.update.launcher.command_error', {
              error: error instanceof Error ? error.message : String(error)
            })
          )
        )
        .finally(() => setLauncherCommandPending(false))
    },
    [initialService, launcherCommandPending, t]
  )

  const saveLauncherSettings = React.useCallback(() => {
    if (typeof initialService?.saveLauncherSettings !== 'function' || launcherSaving) return
    const submitted = { updateMode, channel }
    const requestId = ++launcherRequestId.current
    setLauncherSaved(false)
    setLauncherSaving(true)
    setLauncherError(null)
    void initialService
      .saveLauncherSettings(submitted)
      .then((state) => {
        if (requestId !== launcherRequestId.current) return
        setLauncherState({
          ...state,
          capabilities: state.capabilities ?? DEFAULT_LAUNCHER_CAPABILITIES
        })
        if (
          selections.current.updateMode === submitted.updateMode &&
          selections.current.channel === submitted.channel
        ) {
          setLauncherSaved(true)
        }
      })
      .catch((error: unknown) => {
        if (requestId === launcherRequestId.current) {
          setLauncherError(
            t('about.update.launcher.save_error', {
              error: error instanceof Error ? error.message : String(error)
            })
          )
        }
      })
      .finally(() => requestId === launcherRequestId.current && setLauncherSaving(false))
  }, [channel, initialService, launcherSaving, t, updateMode])

  const progressPercent =
    typeof updateStatus.progress?.percent === 'number'
      ? Math.max(0, Math.min(100, Math.round(updateStatus.progress.percent)))
      : null
  const launcherManaged = bridgeState === 'available' && launcherState?.managed === true
  const launcherWritable =
    launcherManaged &&
    launcherState.settingsWritable &&
    typeof initialService?.saveLauncherSettings === 'function'
  const standaloneUpdater = updateStatus.state !== 'managed-by-launcher' && updateStatus.supported
  const busy = isBusy(updateStatus)
  const canLauncherCheck =
    launcherManaged &&
    launcherState.capabilities.checkNow &&
    typeof initialService?.checkLauncherNow === 'function' &&
    !launcherCommandPending
  const canLauncherUpdate =
    launcherManaged &&
    launcherState.capabilities.installLatest &&
    typeof initialService?.requestLauncherUpdate === 'function' &&
    !launcherCommandPending
  const canLauncherRollback =
    launcherManaged &&
    launcherState.capabilities.rollback &&
    typeof initialService?.requestLauncherRollback === 'function' &&
    !launcherCommandPending
  const canCheck = canLauncherCheck || (standaloneUpdater && updateStatus.canCheck && !busy)
  const updateAction = updateStatus.canInstall
    ? 'installUpdate'
    : updateStatus.canDownload
      ? 'downloadUpdate'
      : null
  const canUpdate = canLauncherUpdate || (standaloneUpdater && updateAction !== null && !busy)
  const currentVersion = updateStatus.currentVersion || PACKAGE_VERSION

  const launcherReason =
    bridgeState === 'unavailable'
      ? t('about.update.launcher.bridge_unavailable')
      : bridgeState === 'error'
        ? launcherError || t('about.update.launcher.bridge_error')
        : bridgeState === 'loading'
          ? t('about.update.launcher.loading')
          : !launcherState
            ? t('about.update.launcher.api_unavailable')
            : !launcherState.managed
              ? t('about.update.launcher.unmanaged')
              : !launcherState.settingsWritable
                ? t('about.update.launcher.not_writable')
                : typeof initialService?.saveLauncherSettings !== 'function'
                  ? t('about.update.launcher.save_unavailable')
                  : ''

  const standaloneReason = standaloneUpdater
    ? t('about.update.actions_follow_status')
    : updateStatus.state === 'managed-by-launcher'
      ? t('about.update.actions_launcher_managed')
      : bridgeState === 'unavailable'
        ? t('about.update.actions_bridge_unavailable')
        : t('about.update.actions_packaged_only')

  const detail = updateStatus.errorMessage
    ? updateStatus.errorMessage
    : updateStatus.state === 'available'
      ? t('about.update.detail_available', {
          version: updateStatus.latestVersion || t('about.update.version_unknown')
        })
      : updateStatus.state === 'downloaded'
        ? t('about.update.detail_downloaded', {
            version: updateStatus.latestVersion || t('about.update.version_unknown')
          })
        : updateStatus.state === 'downloading' && progressPercent !== null
          ? t('about.update.detail_downloading', { percent: String(progressPercent) })
          : t(
              `about.update.detail_${
                updateStatus.state === 'not-available'
                  ? 'not_available'
                  : updateStatus.state === 'managed-by-launcher'
                    ? 'managed_by_launcher'
                    : updateStatus.state === 'unsupported'
                      ? 'unsupported'
                      : 'idle'
              }`
            )

  const radioLabel = (title: string, description: string) => (
    <Box sx={{ py: 0.25, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {description}
      </Typography>
    </Box>
  )

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, pb: 6, minWidth: 0 }}>
      <Box
        sx={{
          width: '100%',
          maxWidth: 560,
          minWidth: 0,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          '& .MuiTypography-root': { minWidth: 0, overflowWrap: 'anywhere' },
          '& .MuiFormControl-root, & .MuiInputBase-root': { minWidth: 0 },
          '& .MuiFormControlLabel-root': { minWidth: 0, maxWidth: '100%' },
          '& .MuiFormControlLabel-label': { minWidth: 0 },
          '& .MuiButton-root': { maxWidth: '100%', whiteSpace: 'normal' },
          '& .MuiButton-startIcon': { flexShrink: 0 }
        }}
      >
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>
          {t('about.update.page_title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('about.update.page_description')}
        </Typography>

        <Box sx={{ pt: 1 }}>
          <SettingSection title={t('about.update.active_install')} surface={false}>
            <Stack spacing={1.5}>
              <Box sx={{ minWidth: 0 }}>
                <Stack
                  direction="row"
                  alignItems="baseline"
                  spacing={1.25}
                  sx={{ flexWrap: 'wrap', minWidth: 0 }}
                >
                  <Typography variant="h6" sx={{ fontWeight: 650, minWidth: 0 }}>
                    v{currentVersion || t('about.update.version_unknown')}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t(`about.update.state.${updateStatus.state.replaceAll('-', '_')}`)}
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {detail}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 0.5 }}
                >
                  {t('about.update.launcher_status')}:{' '}
                  {launcherManaged && launcherState?.launchStatus
                    ? `${t(`about.update.launcher.status_${launcherState.launchStatus}`)}${launcherState.launchVersion ? ` (${launcherState.launchVersion})` : ''}`
                    : launcherManaged
                      ? t('about.update.launcher.managed')
                      : launcherReason}
                </Typography>
              </Box>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Tooltip title={canCheck ? t('about.update.action_check') : standaloneReason}>
                  <Box component="span" sx={{ display: 'inline-flex', maxWidth: '100%' }}>
                    <Button
                      variant="text"
                      size="small"
                      startIcon={<RefreshIcon />}
                      disabled={!canCheck}
                      onClick={() =>
                        launcherManaged
                          ? runLauncherCommand('checkLauncherNow')
                          : runUpdateAction('checkForUpdates')
                      }
                    >
                      {t('about.update.action_check_now')}
                    </Button>
                  </Box>
                </Tooltip>
                <Tooltip title={canUpdate ? t('about.update.action_update') : standaloneReason}>
                  <Box component="span" sx={{ display: 'inline-flex', maxWidth: '100%' }}>
                    <Button
                      variant="text"
                      size="small"
                      startIcon={updateStatus.canInstall ? <RestartIcon /> : <UpdateIcon />}
                      disabled={!canUpdate}
                      onClick={() =>
                        launcherManaged
                          ? runLauncherCommand('requestLauncherUpdate')
                          : updateAction && runUpdateAction(updateAction)
                      }
                    >
                      {t('about.update.action_update')}
                    </Button>
                  </Box>
                </Tooltip>
                <Tooltip
                  title={
                    canLauncherRollback
                      ? t('about.update.action_rollback')
                      : t('about.update.rollback_unavailable')
                  }
                >
                  <Box component="span" sx={{ display: 'inline-flex', maxWidth: '100%' }}>
                    <Button
                      size="small"
                      disabled={!canLauncherRollback}
                      startIcon={<RestartIcon />}
                      onClick={() => runLauncherCommand('requestLauncherRollback')}
                    >
                      {t('about.update.action_rollback')}
                    </Button>
                  </Box>
                </Tooltip>
              </Stack>
              {updateStatus.state === 'downloading' ? (
                <LinearProgress
                  variant={progressPercent === null ? 'indeterminate' : 'determinate'}
                  value={progressPercent ?? 0}
                />
              ) : null}
              <Typography variant="caption" color="text.secondary">
                {launcherManaged
                  ? t('about.update.launcher.commands_next_launch')
                  : `${standaloneReason} ${t('about.update.rollback_unavailable')}`}
              </Typography>
              {launcherState?.lastLauncherCommandResult ? (
                <Typography
                  variant="caption"
                  color={
                    launcherState.lastLauncherCommandResult.status === 'completed'
                      ? 'success.main'
                      : 'error.main'
                  }
                >
                  {t('about.update.launcher.last_command_result', {
                    command: launcherState.lastLauncherCommandResult.command,
                    status: launcherState.lastLauncherCommandResult.status,
                    requestId: launcherState.lastLauncherCommandResult.requestId,
                    error: launcherState.lastLauncherCommandResult.error ?? ''
                  })}
                </Typography>
              ) : null}
            </Stack>
          </SettingSection>
        </Box>

        <SettingSection title={t('about.update.channel_title')} surface={false}>
          <Stack spacing={1.25}>
            <FormControl disabled={!launcherWritable || launcherSaving}>
              <RadioGroup
                aria-label={t('about.update.channel_title')}
                data-testid="channel-radio-group"
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as UpdateChannel)
                  setLauncherSaved(false)
                }}
                sx={{ flexDirection: 'column', gap: 0.5 }}
              >
                {(['stable', 'beta', 'nightly'] as const).map((value) => (
                  <FormControlLabel
                    key={value}
                    value={value}
                    control={<Radio size="small" />}
                    label={radioLabel(
                      t(`about.update.launcher.channel_${value}`),
                      t(`about.update.channel_${value}_description`)
                    )}
                    sx={{ alignItems: 'flex-start', m: 0 }}
                  />
                ))}
              </RadioGroup>
            </FormControl>
            <Typography variant="caption" color={launcherError ? 'error' : 'text.secondary'}>
              {launcherWritable ? t('about.update.channel_description') : launcherReason}
            </Typography>
          </Stack>
        </SettingSection>

        <SettingSection title={t('about.update.release_feed_title')} surface={false}>
          <RadioGroup
            aria-label={t('about.update.release_feed_title')}
            value="github"
            sx={{ flexDirection: 'column', gap: 1.5 }}
          >
            <Box sx={{ minWidth: 0 }}>
              <FormControlLabel
                value="github"
                control={<Radio size="small" />}
                label={radioLabel('GitHub Releases', t('about.update.release_feed_read_only'))}
                sx={{ alignItems: 'flex-start', m: 0 }}
              />
              <Box sx={{ mt: 1, pl: { xs: 0, sm: 4.5 }, minWidth: 0 }}>
                <Typography
                  component="label"
                  htmlFor="update-release-repository"
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  {t('about.update.repository')}
                </Typography>
                <TextField
                  id="update-release-repository"
                  fullWidth
                  size="small"
                  value={DEFAULT_RELEASE_REPO}
                  InputProps={{ readOnly: true }}
                  inputProps={{ 'aria-label': t('about.update.repository') }}
                />
              </Box>
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <FormControlLabel
                value="custom"
                disabled
                control={<Radio size="small" />}
                label={radioLabel(
                  t('about.update.custom_mirror'),
                  t('about.update.custom_mirror_unavailable')
                )}
                sx={{ alignItems: 'flex-start', m: 0 }}
              />
              <Box sx={{ mt: 1, pl: { xs: 0, sm: 4.5 }, minWidth: 0 }}>
                <Typography
                  component="label"
                  htmlFor="update-custom-mirror"
                  variant="caption"
                  color="text.disabled"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  {t('about.update.custom_mirror_url')}
                </Typography>
                <TextField
                  id="update-custom-mirror"
                  fullWidth
                  size="small"
                  disabled
                  placeholder="https://..."
                  inputProps={{ 'aria-label': t('about.update.custom_mirror_url') }}
                />
              </Box>
            </Box>
          </RadioGroup>
        </SettingSection>

        <SettingSection title={t('about.update.pinned_version_title')} surface={false}>
          <Stack spacing={1}>
            <FormControl fullWidth size="small" disabled>
              <Select value="none" aria-label={t('about.update.pinned_version_title')}>
                <MenuItem value="none">{t('about.update.no_pin')}</MenuItem>
              </Select>
            </FormControl>
            <Typography variant="caption" color="text.secondary">
              {t('about.update.pinned_version_unavailable')}
            </Typography>
          </Stack>
        </SettingSection>

        <SettingSection title={t('about.update.mode_title')} surface={false}>
          <Stack spacing={1.25}>
            <FormControl disabled={!launcherWritable || launcherSaving}>
              <RadioGroup
                aria-label={t('about.update.mode_title')}
                data-testid="update-mode-radio-group"
                value={updateMode}
                onChange={(event) => {
                  setUpdateMode(event.target.value as UpdateMode)
                  setLauncherSaved(false)
                }}
                sx={{ flexDirection: 'column', gap: 0.5 }}
              >
                <FormControlLabel
                  value="manual"
                  control={<Radio size="small" />}
                  label={radioLabel(
                    t('about.update.launcher.mode_manual'),
                    t('about.update.mode_manual_description')
                  )}
                  sx={{ alignItems: 'flex-start', m: 0 }}
                />
                <FormControlLabel
                  value="notify-on-launch"
                  control={<Radio size="small" />}
                  label={radioLabel(
                    t('about.update.launcher.mode_notify_short'),
                    t('about.update.mode_notify_description')
                  )}
                  sx={{ alignItems: 'flex-start', m: 0 }}
                />
                <FormControlLabel
                  value="auto-on-launch"
                  control={<Radio size="small" />}
                  label={radioLabel(
                    t('about.update.launcher.mode_auto_short'),
                    t('about.update.mode_auto_description')
                  )}
                  sx={{ alignItems: 'flex-start', m: 0 }}
                />
              </RadioGroup>
            </FormControl>
            <Stack
              direction="row"
              spacing={2}
              alignItems="center"
              sx={{ flexWrap: 'wrap', minWidth: 0 }}
            >
              <Button
                variant="contained"
                size="small"
                disabled={!launcherWritable || launcherSaving}
                onClick={saveLauncherSettings}
              >
                {t('about.update.launcher.save')}
              </Button>
              <Typography
                variant="caption"
                color={launcherError ? 'error' : 'text.secondary'}
                sx={{ flex: '1 1 240px', minWidth: 0 }}
              >
                {launcherError ??
                  (launcherSaved
                    ? t('about.update.launcher.next_launch')
                    : launcherWritable
                      ? t('about.update.mode_description')
                      : launcherReason)}
              </Typography>
            </Stack>
          </Stack>
        </SettingSection>

        <SettingSection title={t('about.update.installed_versions_title')} surface={false}>
          {launcherState?.installedVersions?.length ? (
            <Stack spacing={1}>
              {launcherState.installedVersions.map((installed) => {
                const canRemove =
                  launcherState.capabilities.removeVersion &&
                  installed.removable &&
                  !installed.active &&
                  !installed.rollback &&
                  installed.health !== 'unknown' &&
                  typeof initialService?.requestLauncherVersionRemoval === 'function' &&
                  !launcherCommandPending
                const declaredSize =
                  installed.totalBytes === null
                    ? 'declared size unknown'
                    : `${(installed.totalBytes / (1024 * 1024)).toFixed(1)} MiB declared`
                return (
                  <Box
                    key={installed.buildId}
                    sx={{ display: 'flex', gap: 1, alignItems: 'center' }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        v{installed.version}
                        {installed.active ? ` · ${t('about.update.active')}` : ''}
                        {installed.rollback ? ' · rollback' : ''}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {installed.health} · {declaredSize}
                      </Typography>
                    </Box>
                    <Tooltip
                      title={
                        canRemove
                          ? 'Queue removal'
                          : installed.removalBlockedReason || 'Removal unavailable'
                      }
                    >
                      <Box component="span">
                        <Button
                          size="small"
                          startIcon={<DeleteIcon />}
                          disabled={!canRemove}
                          onClick={() =>
                            removeLauncherVersion(installed.buildId, installed.version)
                          }
                        >
                          Remove
                        </Button>
                      </Box>
                    </Tooltip>
                  </Box>
                )
              })}
              <Typography variant="caption" color="text.secondary">
                Removal commands run on the next Launcher start. Sizes are manifest declarations,
                not live disk usage.
              </Typography>
              {launcherState.inventoryIssues?.length ? (
                <Typography variant="caption" color="warning.main">
                  {launcherState.inventoryIssues.join('; ')}
                </Typography>
              ) : null}
            </Stack>
          ) : currentVersion ? (
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                v{currentVersion} · {t('about.update.active')}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.25 }}
              >
                {t('about.update.only_active_known')}
              </Typography>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t('about.update.installed_versions_unavailable')}
            </Typography>
          )}
        </SettingSection>
      </Box>
    </Box>
  )
}

export default PanelUpdates
